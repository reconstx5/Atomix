// v0.27 Plan A final review fixes: HttpsManager on its own (src/tls/server.js), with a fake Tailscale and settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { HttpsManager } from '../src/tls/server.js';
import { makeCertificate, serialNumber } from '../src/tls/x509.js';
import { fakeTailscale } from './helpers-tls.js';

const DAY = 86_400_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atomix-https-'));
const settingsOf = (values) => ({ get: (k) => values[k] });
const log = { warn() {}, info() {} };
const handler = (req, res) => res.end('ok');

/** A Tailscale-like certificate for den-pc.tail1234.ts.net ending in `days`, written as <dir>/certs/ts.crt and ts.key. */
function tsCert(dataDir, days) {
  const ca = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const start = new Date(Date.now() - 90 * DAY + days * DAY);
  const pem = makeCertificate({ subjectCN: 'den-pc.tail1234.ts.net', issuerCN: 'TS CA', publicKey: leaf.publicKey, signingKey: ca.privateKey, issuerKey: ca.publicKey, serial: serialNumber(), notBefore: start, notAfter: new Date(Date.now() + days * DAY), san: { dns: ['den-pc.tail1234.ts.net'], ip: ['127.0.0.1'] } }).pem;
  fs.mkdirSync(path.join(dataDir, 'certs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'certs', 'ts.crt'), pem);
  fs.writeFileSync(path.join(dataDir, 'certs', 'ts.key'), leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
function manager(dataDir, values, extra = {}) {
  const bin = fakeTailscale(tmp());
  return new HttpsManager({ handler, settings: settingsOf({ httpsPort: 8443, ...values }), config: { httpsPort: 0, host: '127.0.0.1', dataDir }, log, dataDir, tailscale: { find: () => bin }, ...extra });
}
const peerSan = (port) =>
  new Promise((resolve, reject) => {
    const s = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => {
      resolve(s.getPeerX509Certificate().subjectAltName);
      s.end();
    });
    s.on('error', reject);
  });

test('a certificate an administrator made is used without asking Tailscale again', async () => {
  const d = tmp();
  tsCert(d, 80);
  process.env.FAKE_TS_MODE = 'denied'; // `tailscale cert` would be refused; `status` answers
  const m = manager(d, { httpsMode: 'tailscale' });
  try {
    const st = await m.apply();
    assert.equal(st.listening, true, st.sentence);
    assert.equal(st.sentence, null);
    assert.equal(st.name, 'den-pc.tail1234.ts.net');
  } finally {
    await m.close();
    process.env.FAKE_TS_MODE = 'ok';
  }
});

test('a refused renewal keeps the address up until the certificate ends', async () => {
  const d = tmp();
  tsCert(d, 80);
  const m = manager(d, { httpsMode: 'tailscale' });
  try {
    process.env.FAKE_TS_MODE = 'ok';
    assert.equal((await m.apply()).listening, true);
    // 70 days on: under 30 days left, and the renewal is refused.
    tsCert(d, 10);
    process.env.FAKE_TS_MODE = 'denied';
    const st = await m.apply();
    assert.equal(st.listening, true, 'still serving the certificate it has');
    assert.match(st.sentence, /^The certificate ends on .+: Run this once as administrator/);
    // Ended: nothing left to serve.
    tsCert(d, -1);
    const ended = await m.apply();
    assert.equal(ended.listening, false);
  } finally {
    await m.close();
    process.env.FAKE_TS_MODE = 'ok';
  }
});

test('a changed home address remakes the certificate within a minute', async () => {
  const d = tmp();
  let addrs = ['192.168.1.20'];
  const m = manager(d, { httpsMode: 'own' }, { addresses: () => addrs });
  try {
    const st = await m.apply();
    assert.ok((await peerSan(st.port)).includes('IP Address:192.168.1.20'));
    assert.equal(await m.checkAddresses(), false, 'nothing changed');
    addrs = ['192.168.1.77'];
    assert.equal(await m.checkAddresses(), true);
    assert.ok((await peerSan(m.state().port)).includes('IP Address:192.168.1.77'));
    assert.equal(m.state().secureUrl, `https://192.168.1.77:${m.state().port}`);
  } finally {
    await m.close();
  }
});

test('the secure address follows the name a phone used, else the home network first', async () => {
  const d = tmp();
  const m = manager(d, { httpsMode: 'own' }, { addresses: () => ['172.20.0.1', '192.168.1.20'] });
  try {
    const st = await m.apply();
    assert.equal(st.secureUrl, `https://192.168.1.20:${st.port}`, 'the home network, not the virtual adapter');
    assert.equal(m.secureUrlFor('172.20.0.1:8787'), `https://172.20.0.1:${st.port}`, 'the address the phone already reached');
    assert.equal(m.secureUrlFor('localhost:8787'), `https://192.168.1.20:${st.port}`, 'localhost is no use to a phone');
    assert.equal(m.secureUrlFor('evil.example:8787'), `https://192.168.1.20:${st.port}`, 'only names the certificate carries');
  } finally {
    await m.close();
  }
});

test('the port is fixed when the environment names it', () => {
  const d = tmp();
  const fixed = manager(d, { httpsMode: 'off' });
  assert.equal(fixed.state().portFixed, true);
  const free = new HttpsManager({ handler, settings: settingsOf({ httpsMode: 'off', httpsPort: 9443 }), config: { httpsPort: null, host: '127.0.0.1', dataDir: d }, log, dataDir: d });
  assert.equal(free.state().portFixed, false);
  assert.equal(free.state().port, 9443);
});

test('the state says when the secure address is still starting', async () => {
  const d = tmp();
  let release;
  const gate = new Promise((r) => (release = r));
  const m = manager(d, { httpsMode: 'tailscale' }, { tailscale: { find: () => 'x', certificate: () => gate.then(() => { throw new Error('nope'); }) } });
  try {
    assert.equal(m.state().busy, false);
    const done = m.apply();
    assert.equal(m.state().busy, true, 'while Tailscale is asked');
    release();
    await done;
    assert.equal(m.state().busy, false);
  } finally {
    await m.close();
  }
});
