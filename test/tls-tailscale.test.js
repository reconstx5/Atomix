// v0.27 Plan A Task 2: asking Tailscale for this computer's certificate (src/tls/tailscale.js), with a fake CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { findTailscale, tailscaleCertificate, needsRenewal, runFile, TailscaleError } from '../src/tls/tailscale.js';
import { makeCertificate, serialNumber } from '../src/tls/x509.js';
import { fakeTailscale } from './helpers-tls.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atomix-ts-'));
const DAY = 86_400_000;

test('finds tailscale from the env, PATH, then the usual folders', () => {
  const none = () => false;
  assert.equal(findTailscale({ env: { ATOMIX_TAILSCALE: '/opt/ts' }, platform: 'linux', exists: () => true, which: () => '/usr/bin/tailscale' }), '/opt/ts');
  assert.equal(findTailscale({ env: {}, platform: 'linux', exists: none, which: () => '/usr/bin/tailscale' }), '/usr/bin/tailscale');
  assert.equal(findTailscale({ env: {}, platform: 'win32', exists: (p) => p === 'C:\\Program Files\\Tailscale\\tailscale.exe', which: () => null }), 'C:\\Program Files\\Tailscale\\tailscale.exe');
  assert.equal(findTailscale({ env: {}, platform: 'darwin', exists: (p) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale', which: () => null }), '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(findTailscale({ env: {}, platform: 'linux', exists: none, which: () => null }), null);
});

test("asks for a certificate for this computer's Tailscale name", async () => {
  const d = tmp();
  const bin = fakeTailscale(d);
  const log = path.join(d, 'log');
  process.env.FAKE_TS_MODE = 'ok';
  process.env.FAKE_TS_LOG = log;
  const out = await tailscaleCertificate({ bin, dir: path.join(d, 'certs') });
  assert.equal(out.name, 'den-pc.tail1234.ts.net');
  assert.ok(fs.existsSync(out.certFile) && fs.existsSync(out.keyFile));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls[0], ['status', '--json']);
  assert.deepEqual(calls[1], ['cert', '--cert-file', out.certFile, '--key-file', out.keyFile, 'den-pc.tail1234.ts.net']);
});

test('each failure has its sentence', async () => {
  const d = tmp();
  const bin = fakeTailscale(d);
  delete process.env.FAKE_TS_LOG;
  const fails = async (mode, opts = {}) => {
    process.env.FAKE_TS_MODE = mode;
    try {
      await tailscaleCertificate({ bin, dir: path.join(d, 'certs'), ...opts });
    } catch (err) {
      return err;
    }
    return null;
  };
  const missing = await fails('ok', { bin: null });
  assert.ok(missing instanceof TailscaleError);
  assert.equal(missing.message, "Tailscale isn't installed on this computer");
  assert.equal((await fails('login')).message, "Tailscale isn't signed in");
  assert.equal((await fails('nocerts')).message, "Turn on HTTPS certificates in Tailscale's admin page (DNS → HTTPS Certificates)");
  const denied = await fails('denied');
  assert.match(denied.message, /^Run this once as administrator: /);
  assert.ok(denied.command.includes(bin) && denied.command.includes('cert'), denied.command);
  assert.equal((await fails('broken')).message, '500 Internal Server Error: acme failed');
});

test('a hung tailscale gives up with a sentence', async () => {
  const d = tmp();
  const bin = fakeTailscale(d);
  process.env.FAKE_TS_MODE = 'hang';
  const t0 = Date.now();
  await assert.rejects(runFile(bin, ['status', '--json'], { timeout: 300 }), /Tailscale didn't answer/);
  assert.ok(Date.now() - t0 < 5000);
});

test('needsRenewal: under 30 days left, or unreadable', () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cert = (days) => makeCertificate({ subjectCN: 'x', issuerCN: 'x', publicKey: pair.publicKey, signingKey: pair.privateKey, serial: serialNumber(), notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + days * DAY), ca: false }).pem;
  assert.equal(needsRenewal(cert(10)), true);
  assert.equal(needsRenewal(cert(60)), false);
  assert.equal(needsRenewal(null), true);
  assert.equal(needsRenewal('not a certificate'), true);
});

// ---- v0.27 Plan A final review fixes ----
test("Tailscale's own refusal text reads as needing an administrator", async () => {
  const d = tmp();
  const bin = fakeTailscale(d);
  process.env.FAKE_TS_MODE = 'denied2';
  const err = await tailscaleCertificate({ bin, dir: path.join(d, 'certs') }).catch((e) => e);
  assert.match(err.message, /^Run this once as administrator: /);
});

test('on Windows the command is one PowerShell runs', async () => {
  const d = tmp();
  const bin = fakeTailscale(d);
  process.env.FAKE_TS_MODE = 'denied';
  const err = await tailscaleCertificate({ bin, dir: path.join(d, 'certs'), platform: 'win32' }).catch((e) => e);
  assert.ok(err.command.startsWith('& '), err.command);
  assert.match(err.message, /^Run this once as administrator \(Terminal \(Admin\)\): & /);
});

test('the certificate itself gets two minutes; the status check 20 s', async () => {
  const calls = [];
  const run = async (bin, args, opts = {}) => {
    calls.push({ cmd: args[0], timeout: opts.timeout ?? 20_000 });
    if (args[0] === 'status') return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'den-pc.t.ts.net.' }, CertDomains: ['den-pc.t.ts.net'] }), stderr: '' };
    return { stdout: '', stderr: '' };
  };
  await tailscaleCertificate({ bin: '/x/tailscale', dir: tmp(), run });
  assert.deepEqual(calls, [{ cmd: 'status', timeout: 20_000 }, { cmd: 'cert', timeout: 120_000 }]);
});
