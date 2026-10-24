// Tailscale's certificate for this computer (v0.27): `tailscale cert` gives a real (Let's Encrypt) certificate for
// <computer>.<tailnet>.ts.net once HTTPS certificates are on in Tailscale's admin page. Phones with the Tailscale
// app then reach Atomix's secure address with nothing else installed, at home or away.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export class TailscaleError extends Error {
  constructor(message, { command = null } = {}) {
    super(message);
    this.command = command;
  }
}

export const NOT_INSTALLED = "Tailscale isn't installed on this computer";
export const NOT_SIGNED_IN = "Tailscale isn't signed in";
export const NO_CERTS = "Turn on HTTPS certificates in Tailscale's admin page (DNS → HTTPS Certificates)";
export const NO_ANSWER = "Tailscale didn't answer";
const ADMIN = /access is denied|access denied|permission denied|administrator|must be run as root|operation not permitted/i;

/** `tailscale` on the PATH (with .exe on Windows), or null. */
function onPath(env = process.env, platform = process.platform, exists = fs.existsSync) {
  const names = platform === 'win32' ? ['tailscale.exe', 'tailscale'] : ['tailscale'];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

/** Where Tailscale's command is: ATOMIX_TAILSCALE, the PATH, then its usual install folder. */
export function findTailscale({ env = process.env, platform = process.platform, exists = fs.existsSync, which = () => onPath(env, platform, exists) } = {}) {
  if (env.ATOMIX_TAILSCALE) return env.ATOMIX_TAILSCALE;
  const found = which('tailscale');
  if (found) return found;
  const usual = { win32: 'C:\\Program Files\\Tailscale\\tailscale.exe', darwin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' }[platform];
  return usual && exists(usual) ? usual : null;
}

/** Run Tailscale's command; it gets 20 s (a stopped daemon can hang). */
export function runFile(bin, args, { timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      if (err.code === 'ENOENT') return reject(new TailscaleError(NOT_INSTALLED));
      if (err.killed || err.signal) return reject(new TailscaleError(NO_ANSWER));
      err.stderr = String(stderr || '');
      reject(err);
    });
  });
}

const quote = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);

/**
 * Ask this computer's Tailscale for its certificate, written to <dir>/ts.crt and ts.key.
 * @returns {Promise<{ name: string, certFile: string, keyFile: string }>}  Rejects with a TailscaleError sentence.
 */
export async function tailscaleCertificate({ bin, dir, run = runFile, platform = process.platform }) {
  if (!bin) throw new TailscaleError(NOT_INSTALLED);
  let status;
  try {
    status = JSON.parse((await run(bin, ['status', '--json'])).stdout);
  } catch (err) {
    if (err instanceof TailscaleError) throw err;
    throw new TailscaleError(NOT_SIGNED_IN);
  }
  if (status.BackendState !== 'Running') throw new TailscaleError(NOT_SIGNED_IN);
  const name = String(status.Self?.DNSName || '').replace(/\.$/, '');
  if (!name || !Array.isArray(status.CertDomains) || !status.CertDomains.includes(name)) throw new TailscaleError(NO_CERTS);
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'ts.crt');
  const keyFile = path.join(dir, 'ts.key');
  const args = ['cert', '--cert-file', certFile, '--key-file', keyFile, name];
  try {
    await run(bin, args, { timeout: 120_000 }); // a first certificate (ACME) can take a minute
  } catch (err) {
    if (err instanceof TailscaleError) throw err;
    const text = `${err.stderr || ''}\n${err.message || ''}`;
    // On Windows, for PowerShell (Terminal (Admin)): a quoted path alone is just a string there; `& ` runs it.
    const win = platform === 'win32';
    const command = `${win ? '& ' : ''}${[bin, ...args].map(quote).join(' ')}`;
    if (ADMIN.test(text)) throw new TailscaleError(`Run this once as administrator${win ? ' (Terminal (Admin))' : ''}: ${command}`, { command });
    const first = String(err.stderr || err.message || '').split('\n').map((l) => l.trim()).find(Boolean) || 'Tailscale refused to make a certificate';
    throw new TailscaleError(first, { command });
  }
  return { name, certFile, keyFile };
}

/** True when a certificate is unreadable or has under 30 days left. */
export function needsRenewal(certPem, now = new Date()) {
  if (!certPem) return true;
  try {
    const cert = new crypto.X509Certificate(certPem);
    return Date.parse(cert.validTo) - now.getTime() < 30 * 86_400_000;
  } catch {
    return true;
  }
}
