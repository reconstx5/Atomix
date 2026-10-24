// v0.27 Plan A Task 1: Atomix's own home certificate (src/tls/x509.js, src/tls/own.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { ensureOwnCertificates, lanAddresses, mobileconfig } from '../src/tls/own.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atomix-tls-'));
const DAY = 86_400_000;
const leafOf = (cert) => new X509Certificate(cert.split(/(?=-----BEGIN CERTIFICATE-----)/)[0]);

test('the certificates load and carry what phones require', () => {
  const out = ensureOwnCertificates({ dir: dir(), serverName: 'Atomix', hostname: 'den-pc', addresses: ['192.168.1.20'] });
  const ca = new X509Certificate(out.caPem);
  const leaf = leafOf(out.cert);
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  for (const want of ['DNS:den-pc', 'DNS:den-pc.local', 'DNS:localhost', 'IP Address:192.168.1.20', 'IP Address:127.0.0.1']) assert.ok(leaf.subjectAltName.includes(want), `${want} in ${leaf.subjectAltName}`);
  assert.equal(Math.round((Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY), 825);
  assert.ok(leaf.checkIssued(ca));
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1'), String(leaf.keyUsage));
  assert.match(ca.subject, /Atomix home CA \(Atomix\)/);
  assert.ok(Date.parse(ca.validTo) - Date.parse(ca.validFrom) > 3650 * DAY - 2 * DAY);
});

test('a TLS client trusting only the CA connects', async () => {
  const out = ensureOwnCertificates({ dir: dir(), serverName: 'Atomix', hostname: 'den-pc', addresses: ['192.168.1.20'] });
  const server = tls.createServer({ key: out.key, cert: out.cert }, (s) => s.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const authorized = await new Promise((resolve, reject) => {
      const s = tls.connect({ port: server.address().port, host: '127.0.0.1', ca: out.caPem, servername: 'localhost' }, () => {
        resolve(s.authorized);
        s.end();
      });
      s.on('error', reject);
    });
    assert.equal(authorized, true);
  } finally {
    server.close();
  }
});

test('a changed address remakes the server certificate from the same CA', () => {
  const d = dir();
  const first = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'den-pc', addresses: ['192.168.1.20'] });
  assert.equal(first.changed, true);
  const second = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'den-pc', addresses: ['10.0.0.5'] });
  assert.equal(second.changed, true);
  assert.equal(second.caPem, first.caPem);
  assert.ok(leafOf(second.cert).subjectAltName.includes('IP Address:10.0.0.5'));
  const third = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'den-pc', addresses: ['10.0.0.5'] });
  assert.equal(third.changed, false);
  assert.equal(third.cert, second.cert);
});

test('a server certificate near its end is remade', () => {
  const d = dir();
  const first = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'den-pc', addresses: ['192.168.1.20'] });
  const later = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'den-pc', addresses: ['192.168.1.20'], now: new Date(Date.now() + 800 * DAY) });
  assert.equal(later.changed, true);
  assert.ok(Date.parse(leafOf(later.cert).validTo) > Date.parse(leafOf(first.cert).validTo));
  assert.equal(later.caPem, first.caPem);
});

test('the iPhone profile carries the CA', () => {
  const out = ensureOwnCertificates({ dir: dir(), serverName: 'Atomix', hostname: 'den-pc', addresses: [] });
  const a = mobileconfig(out.caDer, { serverName: 'Atomix' });
  assert.match(a, /com\.apple\.security\.root/);
  assert.ok(a.replace(/\s+/g, '').includes(out.caDer.toString('base64')));
  assert.equal(mobileconfig(out.caDer, { serverName: 'Atomix' }), a);
});

test('lanAddresses skips loopback, link-local and IPv6', () => {
  const got = lanAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    wifi: [{ address: '169.254.3.4', family: 'IPv4', internal: false }],
    tun: [{ address: '10.8.0.2', family: 4, internal: false }],
  });
  assert.deepEqual(got, ['192.168.1.20', '10.8.0.2']);
});

// ---- v0.27 Plan A final review fixes ----
import { preferAddresses } from '../src/tls/own.js';
import { makeCertificate, serialNumber } from '../src/tls/x509.js';
import crypto from 'node:crypto';

/** Whether a TLS client trusting only `caPem` accepts `key`/`cert` for `servername`. */
async function trusted({ key, cert, caPem, servername }) {
  const server = tls.createServer({ key, cert }, (s) => s.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await new Promise((resolve) => {
      const s = tls.connect({ port: server.address().port, host: '127.0.0.1', ca: caPem, servername, rejectUnauthorized: false }, () => {
        resolve({ ok: s.authorized, why: s.authorizationError ? String(s.authorizationError) : null });
        s.end();
      });
      s.on('error', (e) => resolve({ ok: false, why: e.message }));
    });
  } finally {
    server.close();
  }
}

test('a server name with a comma keeps the chain', async () => {
  const d = dir();
  const out = ensureOwnCertificates({ dir: d, serverName: 'Hansen, Lounge', hostname: 'den-pc', addresses: ['192.168.1.20'] });
  assert.ok(leafOf(out.cert).checkIssued(new X509Certificate(out.caPem)));
  assert.deepEqual(await trusted({ key: out.key, cert: out.cert, caPem: out.caPem, servername: 'den-pc' }), { ok: true, why: null });
  assert.equal(ensureOwnCertificates({ dir: d, serverName: 'Hansen, Lounge', hostname: 'den-pc', addresses: ['192.168.1.20'] }).changed, false);
});

test('the home CA only vouches for home names and addresses', async () => {
  const d = dir();
  const out = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'den-pc', addresses: ['192.168.1.20'] });
  // A certificate for someone else's site, signed with the home CA's key, is refused by a client that trusts the CA.
  const caKey = crypto.createPrivateKey(fs.readFileSync(path.join(d, 'own-ca.key')));
  const ca = new X509Certificate(out.caPem);
  const rogue = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signed = (name) => makeCertificate({ subjectCN: name, issuerCN: 'Atomix home CA (Atomix)', publicKey: rogue.publicKey, signingKey: caKey, issuerKey: ca.publicKey, serial: serialNumber(), notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() + 30 * 86_400_000), san: { dns: [name], ip: [] } }).pem;
  const rogueKey = rogue.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const r = await trusted({ key: rogueKey, cert: signed('bank.example') + out.caPem, caPem: out.caPem, servername: 'bank.example' });
  assert.equal(r.ok, false, 'a certificate for bank.example is refused');
  // The same certificate for a home name passes: the name is what's refused (Node calls openssl's "permitted subtree
  // violation" UNSPECIFIED).
  assert.equal((await trusted({ key: rogueKey, cert: signed('tv.local') + out.caPem, caPem: out.caPem, servername: 'tv.local' })).ok, true);
  // A new computer name later stays inside: the plain name is left out of the certificate, its .local name kept.
  const later = ensureOwnCertificates({ dir: d, serverName: 'Atomix', hostname: 'new-pc', addresses: ['192.168.1.20'] });
  assert.ok(!leafOf(later.cert).subjectAltName.includes('DNS:new-pc,') && leafOf(later.cert).subjectAltName.includes('DNS:new-pc.local'), leafOf(later.cert).subjectAltName);
  assert.equal((await trusted({ key: later.key, cert: later.cert, caPem: later.caPem, servername: 'new-pc.local' })).ok, true);
});

test('extra names and addresses (ATOMIX_HTTPS_NAMES) join the certificate', () => {
  const out = ensureOwnCertificates({ dir: dir(), serverName: 'Atomix', hostname: 'den-pc', addresses: ['172.17.0.2'], extraNames: ['atomix.home', '192.168.50.9'] });
  const san = leafOf(out.cert).subjectAltName;
  assert.ok(san.includes('DNS:atomix.home') && san.includes('IP Address:192.168.50.9'), san);
});

test('home-network addresses come first: 192.168, then 10, then 172.16–31, then the rest', () => {
  assert.deepEqual(preferAddresses(['172.20.0.1', '100.101.1.2', '10.0.0.5', '192.168.1.20', '203.0.113.4']), ['192.168.1.20', '10.0.0.5', '172.20.0.1', '100.101.1.2', '203.0.113.4']);
});
