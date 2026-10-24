// Atomix's own home certificate (v0.27): a home CA made once, and a server certificate it signs for this computer's
// names and home-network addresses. Each phone installs the CA once (Android: a CA certificate; iPhone: a profile,
// then "trust"); the server certificate is remade from the same CA when the addresses change or it nears its end,
// so phones never install anything again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCertificate, serialNumber, subjectOf, toPem } from './x509.js';

const DAY = 86_400_000;
const CA_DAYS = 3650; // 10 years
const SERVER_DAYS = 825; // Apple's limit for a server certificate from a private CA
const RENEW_DAYS = 30;

/** This computer's home-network IPv4 addresses (not loopback, not link-local 169.254/16, no IPv6). */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || /^127\./.test(a.address) || /^169\.254\./.test(a.address)) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** Home networks first, as a phone most likely reaches the PC: 192.168/16, 10/8, 172.16/12, then the rest (VPNs, …). */
export function preferAddresses(list) {
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

// What the home CA may vouch for (its name constraints): .local names, localhost, this computer's name and the names
// given in ATOMIX_HTTPS_NAMES; the private address ranges, Tailscale's 100.64/10 and loopback, and given addresses.
const PRIVATE_RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
];
const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const ipNum = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const inRange = (ip, [base, bits]) => bits === 0 || Math.floor(ipNum(ip) / 2 ** (32 - bits)) === Math.floor(ipNum(base) / 2 ** (32 - bits));
const dnsAllowed = (name, permitted) => permitted.some((p) => name === p || name.endsWith(`.${p}`));

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const writeSecret = (file, text) => {
  fs.writeFileSync(file, text, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: the folder's permissions apply */
  }
};
const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/**
 * The CA and the server certificate in `dir` (made or remade as needed).
 * @returns {{ key: string, cert: string, caPem: string, caDer: Buffer, notAfter: Date, changed: boolean }}
 * `cert` is the server certificate followed by the CA (the chain a TLS server sends).
 */
export function ensureOwnCertificates({ dir, serverName = 'Atomix', hostname = os.hostname(), addresses = lanAddresses(), extraNames = [], now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = { caKey: path.join(dir, 'own-ca.key'), caCert: path.join(dir, 'own-ca.crt'), caMeta: path.join(dir, 'own-ca.json'), key: path.join(dir, 'own.key'), cert: path.join(dir, 'own.crt'), meta: path.join(dir, 'own.json') };
  const extraDns = extraNames.filter((n) => n && !isIp(n));
  const extraIp = extraNames.filter(isIp);

  // The CA: made once, kept (phones trust this one). One made without name constraints (an early v0.27 build) is replaced.
  let caKeyPem = read(files.caKey);
  let caPem = read(files.caCert);
  let caMeta = null;
  try {
    caMeta = JSON.parse(read(files.caMeta) || 'null');
  } catch {
    caMeta = null;
  }
  if (!caKeyPem || !caPem || !caMeta?.permitted) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const start = new Date(now.getTime() - DAY);
    const permitted = { dns: [...new Set(['local', 'localhost', ...(hostname && !hostname.includes('.') ? [hostname] : []), ...extraDns])], ip: [...PRIVATE_RANGES, ...extraIp.map((ip) => [ip, 32])] };
    const cn = `Atomix home CA (${serverName})`;
    caPem = makeCertificate({ subjectCN: cn, issuerCN: cn, publicKey: pair.publicKey, signingKey: pair.privateKey, serial: serialNumber(), notBefore: start, notAfter: new Date(start.getTime() + CA_DAYS * DAY), ca: true, permitted }).pem;
    caKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeSecret(files.caKey, caKeyPem);
    fs.writeFileSync(files.caCert, caPem);
    caMeta = { permitted };
    fs.writeFileSync(files.caMeta, JSON.stringify(caMeta));
    for (const f of [files.key, files.cert, files.meta]) fs.rmSync(f, { force: true }); // a new CA: a new server certificate too
  }
  const ca = new crypto.X509Certificate(caPem);
  const caKey = crypto.createPrivateKey(caKeyPem);

  // Only what the CA may vouch for goes in (a renamed computer keeps its .local name; a public address is left out).
  const { permitted } = caMeta;
  const san = {
    dns: [...new Set([hostname, `${hostname}.local`, 'localhost', ...extraDns].filter((n) => n && dnsAllowed(n, permitted.dns)))],
    ip: [...new Set([...addresses, '127.0.0.1', ...extraIp])].filter((ip) => permitted.ip.some((r) => inRange(ip, r))),
  };
  let keyPem = read(files.key);
  let leafPem = read(files.cert);
  let meta = null;
  try {
    meta = JSON.parse(read(files.meta) || 'null');
  } catch {
    meta = null;
  }
  let fresh = false;
  if (keyPem && leafPem && meta && sameList(meta.san?.dns, san.dns) && sameList(meta.san?.ip, san.ip)) {
    try {
      const leaf = new crypto.X509Certificate(leafPem);
      fresh = Date.parse(leaf.validTo) - now.getTime() > RENEW_DAYS * DAY && leaf.checkIssued(ca);
    } catch {
      fresh = false;
    }
  }
  let changed = false;
  if (!fresh) {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const start = new Date(now.getTime() - 3600_000);
    leafPem = makeCertificate({ subjectCN: hostname || 'localhost', issuerName: subjectOf(ca.raw), publicKey: pair.publicKey, signingKey: caKey, issuerKey: ca.publicKey, serial: serialNumber(), notBefore: start, notAfter: new Date(start.getTime() + SERVER_DAYS * DAY), san }).pem;
    keyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeSecret(files.key, keyPem);
    fs.writeFileSync(files.cert, leafPem);
    fs.writeFileSync(files.meta, JSON.stringify({ san }));
    changed = true;
  }
  return { key: keyPem, cert: leafPem + caPem, caPem, caDer: ca.raw, notAfter: new Date(new crypto.X509Certificate(leafPem).validTo), changed };
}

/** A stable UUID (8-4-4-4-12) from a seed. */
function uuidFrom(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An Apple configuration profile carrying the home CA (Safari offers to install it; then Settings → trust it). */
export function mobileconfig(caDer, { serverName = 'Atomix' } = {}) {
  const b64 = caDer.toString('base64').match(/.{1,52}/g).join('\n\t\t\t');
  const inner = uuidFrom(Buffer.concat([caDer, Buffer.from('root')]));
  const outer = uuidFrom(Buffer.concat([caDer, Buffer.from('profile')]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>atomix-home-ca.cer</string>
			<key>PayloadContent</key>
			<data>
			${b64}
			</data>
			<key>PayloadDisplayName</key>
			<string>${xml(`Atomix home CA (${serverName})`)}</string>
			<key>PayloadIdentifier</key>
			<string>tv.atomix.home-ca.${inner}</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${inner}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>${xml(`Lets this device trust ${serverName}'s secure address at home.`)}</string>
	<key>PayloadDisplayName</key>
	<string>Atomix home certificate</string>
	<key>PayloadIdentifier</key>
	<string>tv.atomix.home-profile.${outer}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${outer}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

export { toPem };
