// v0.27 Plan A Task 3: the HTTPS address beside the HTTP one (src/tls/server.js, wired in src/app.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import https from 'node:https';
import crypto, { X509Certificate } from 'node:crypto';
import { startAtomix, client, tempDir } from './helpers.js';
import { fakeTailscale } from './helpers-tls.js';
import { makeCertificate, serialNumber } from '../src/tls/x509.js';

const DAY = 86_400_000;
const toPem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

/** A request on the HTTPS address. */
function secure(port, pathname, { method = 'GET', ca, servername, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: pathname, method, ca, servername, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      const cert = res.socket?.getPeerCertificate?.() || null; // while the connection is still there
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), cert }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));
const refused = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(false)));
    s.on('error', () => resolve(true));
  });

async function adminOf(nf) {
  const c = client(nf.base);
  const r = await c.post('/api/setup', { username: 'admin', password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}
async function caOf(nf) {
  const res = await fetch(`${nf.base}/tls/atomix-home-ca.crt`);
  return toPem(Buffer.from(await res.arrayBuffer()));
}

test('off by default: no HTTPS listener, secureUrl null', async () => {
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0' }, { skipLiveRefresh: true });
  try {
    assert.equal(nf.app.core.https.state().listening, false);
    assert.equal((await client(nf.base).get('/api/status')).data.secureUrl, null);
  } finally {
    await nf.app.stop();
  }
});

test('own mode serves the same app on HTTPS, with a Secure cookie and the HTTPS origin allowed', async () => {
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0' }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    assert.equal((await admin.put('/api/admin/settings', { httpsMode: 'own' })).status, 200);
    const st = nf.app.core.https.state();
    assert.equal(st.listening, true);
    const ca = await caOf(nf);
    const status = await secure(st.port, '/api/status', { ca });
    assert.equal(status.status, 200);
    assert.match(json(status).secureUrl, /^https:\/\/.+:\d+$/);
    const page = await secure(st.port, '/', { ca });
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /<html/i);
    // Sign in over HTTPS: the cookie is Secure; a POST from the HTTPS origin passes the CSRF check.
    const login = await secure(st.port, '/api/auth/login', { method: 'POST', ca, body: { username: 'admin', password: 'password123' }, headers: { origin: `https://127.0.0.1:${st.port}`, host: `127.0.0.1:${st.port}` } });
    assert.equal(login.status, 200, login.body.toString());
    assert.match(String(login.headers['set-cookie']), /;\s*Secure/i);
  } finally {
    await nf.app.stop();
  }
});

test('the phone downloads are served only in own mode', async () => {
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0' }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    assert.equal((await fetch(`${nf.base}/tls/atomix-home-ca.crt`)).status, 404);
    await admin.put('/api/admin/settings', { httpsMode: 'own' });
    const crt = await fetch(`${nf.base}/tls/atomix-home-ca.crt`);
    assert.equal(crt.status, 200);
    assert.equal(crt.headers.get('content-type'), 'application/x-x509-ca-cert');
    assert.equal(new X509Certificate(Buffer.from(await crt.arrayBuffer())).ca, true);
    const profile = await fetch(`${nf.base}/tls/atomix-home-ca.mobileconfig`);
    assert.equal(profile.status, 200);
    assert.match(profile.headers.get('content-type'), /application\/x-apple-aspen-config/);
    assert.match(await profile.text(), /com\.apple\.security\.root/);
    await admin.put('/api/admin/settings', { httpsMode: 'off' });
    assert.equal((await fetch(`${nf.base}/tls/atomix-home-ca.crt`)).status, 404);
    assert.equal((await fetch(`${nf.base}/tls/atomix-home-ca.mobileconfig`)).status, 404);
  } finally {
    await nf.app.stop();
  }
});

test('switching modes keeps one listener with the right certificate', async () => {
  // A Tailscale certificate: made by a test CA for the fake's name.
  const d = tempDir();
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const tsCa = makeCertificate({ subjectCN: 'Test TS CA', issuerCN: 'Test TS CA', publicKey: pair.publicKey, signingKey: pair.privateKey, serial: serialNumber(), notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + 90 * DAY), ca: true });
  const leafKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const leaf = makeCertificate({ subjectCN: 'den-pc.tail1234.ts.net', issuerCN: 'Test TS CA', publicKey: leafKeys.publicKey, signingKey: pair.privateKey, issuerKey: pair.publicKey, serial: serialNumber(), notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + 80 * DAY), san: { dns: ['den-pc.tail1234.ts.net'], ip: ['127.0.0.1'] } });
  fs.writeFileSync(path.join(d, 'leaf.crt'), leaf.pem);
  fs.writeFileSync(path.join(d, 'leaf.key'), leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const bin = fakeTailscale(d);
  process.env.FAKE_TS_MODE = 'ok';
  process.env.FAKE_TS_CERT = path.join(d, 'leaf.crt');
  process.env.FAKE_TS_KEY = path.join(d, 'leaf.key');
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0', ATOMIX_TAILSCALE: bin }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    await admin.put('/api/admin/settings', { httpsMode: 'own' });
    const own = nf.app.core.https.state();
    const ownCa = await caOf(nf);
    assert.equal((await secure(own.port, '/api/status', { ca: ownCa })).status, 200);

    await admin.put('/api/admin/settings', { httpsMode: 'tailscale' });
    const ts = nf.app.core.https.state();
    assert.equal(ts.listening, true, ts.sentence);
    assert.equal(ts.secureUrl, `https://den-pc.tail1234.ts.net:${ts.port}`);
    const r = await secure(ts.port, '/api/status', { ca: tsCa.pem, servername: 'den-pc.tail1234.ts.net' });
    assert.equal(r.status, 200);
    assert.match(r.cert.subject.CN, /den-pc\.tail1234\.ts\.net/);
    assert.equal((await admin.get('/api/admin/https')).data.name, 'den-pc.tail1234.ts.net');

    await admin.put('/api/admin/settings', { httpsMode: 'off' });
    assert.equal(nf.app.core.https.state().listening, false);
    assert.equal(await refused(ts.port), true);

    await admin.put('/api/admin/settings', { httpsMode: 'own' });
    const again = nf.app.core.https.state();
    assert.equal(again.listening, true);
    assert.equal((await secure(again.port, '/api/status', { ca: ownCa })).status, 200);
  } finally {
    await nf.app.stop();
  }
});

test('a busy HTTPS port is a sentence, not a crash', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const port = blocker.address().port;
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: String(port) }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    await admin.put('/api/admin/settings', { httpsMode: 'own' });
    const st = nf.app.core.https.state();
    assert.equal(st.listening, false);
    assert.equal(st.sentence, `Port ${port} is in use; pick another port`);
    assert.equal((await admin.get('/api/status')).status, 200);
    assert.equal((await admin.get('/api/admin/https')).data.sentence, st.sentence);
  } finally {
    await nf.app.stop();
    blocker.close();
  }
});

test('a Tailscale failure shows its sentence and command', async () => {
  const d = tempDir();
  const bin = fakeTailscale(d);
  process.env.FAKE_TS_MODE = 'denied';
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0', ATOMIX_TAILSCALE: bin }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    await admin.put('/api/admin/settings', { httpsMode: 'tailscale' });
    const r = await admin.get('/api/admin/https');
    assert.equal(r.data.listening, false);
    assert.match(r.data.sentence, /^Run this once as administrator: /);
    assert.ok(r.data.command && r.data.command.includes('cert'));
  } finally {
    await nf.app.stop();
    process.env.FAKE_TS_MODE = 'ok';
  }
});

test("the HTTPS port can't be the HTTP port", async () => {
  const nf = await startAtomix({}, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    const port = Number(new URL(nf.base).port);
    const r = await admin.put('/api/admin/settings', { httpsPort: port });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "Pick a port that isn't the one Atomix already uses");
  } finally {
    await nf.app.stop();
  }
});

// ---- v0.27 Plan A final review fixes ----
test('the HTTPS address keeps its own session cookie, so the plain address can still sign in', async () => {
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0' }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    await admin.put('/api/admin/settings', { httpsMode: 'own' });
    const st = nf.app.core.https.state();
    const ca = await caOf(nf);
    const login = await secure(st.port, '/api/auth/login', { method: 'POST', ca, body: { username: 'admin', password: 'password123' }, headers: { origin: `https://127.0.0.1:${st.port}` } });
    const set = String(login.headers['set-cookie']);
    assert.match(set, /^__Secure-atomix_session=/, set);
    const cookie = set.split(';')[0];
    const me = await secure(st.port, '/api/status', { ca, headers: { cookie } });
    assert.equal(json(me).user?.username, 'admin');
    // The plain address signs in with its own name (a Secure cookie of the same name would block it in browsers).
    const plain = await client(nf.base).post('/api/auth/login', { username: 'admin', password: 'password123' });
    assert.match(String(plain.headers.get('set-cookie')), /^atomix_session=/);
    // Signing out on HTTPS clears its cookie.
    const out = await secure(st.port, '/api/auth/logout', { method: 'POST', ca, headers: { cookie, origin: `https://127.0.0.1:${st.port}` } });
    assert.match(String(out.headers['set-cookie']), /__Secure-atomix_session=;/);
  } finally {
    await nf.app.stop();
  }
});

test("start-up doesn't wait for Tailscale", async () => {
  const d = tempDir();
  const bin = fakeTailscale(d);
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0', ATOMIX_TAILSCALE: bin }, { skipLiveRefresh: true });
  const admin = await adminOf(nf);
  process.env.FAKE_TS_MODE = 'login';
  await admin.put('/api/admin/settings', { httpsMode: 'tailscale' }); // remembered; Tailscale isn't signed in
  await nf.app.stop();
  process.env.FAKE_TS_MODE = 'hang'; // the next start finds a Tailscale that never answers
  const { createApp } = await import('../src/app.js');
  const again = await createApp({ port: 0, host: '127.0.0.1', skipStartupScan: true, logLevel: 'error', skipLiveRefresh: true });
  const t0 = Date.now();
  await again.start();
  const took = Date.now() - t0;
  await again.stop();
  process.env.FAKE_TS_MODE = 'ok';
  assert.ok(took < 5000, `start took ${took} ms`);
});

test('the HTTPS port can be changed in Settings unless the environment fixes it', async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '0.0.0.0', r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));
  delete process.env.ATOMIX_HTTPS_PORT;
  const nf = await startAtomix({}, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    assert.equal((await admin.get('/api/admin/https')).data.portFixed, false);
    await admin.put('/api/admin/settings', { httpsMode: 'own', httpsPort: free });
    const st = (await admin.get('/api/admin/https')).data;
    assert.equal(st.listening, true, st.sentence);
    assert.equal(st.port, free);
  } finally {
    await nf.app.stop();
  }
});

test('names given in ATOMIX_HTTPS_NAMES join the home certificate', async () => {
  const nf = await startAtomix({ ATOMIX_HTTPS_PORT: '0', ATOMIX_HTTPS_NAMES: 'atomix.home, 192.168.50.9' }, { skipLiveRefresh: true });
  try {
    const admin = await adminOf(nf);
    await admin.put('/api/admin/settings', { httpsMode: 'own' });
    const r = await secure(nf.app.core.https.state().port, '/api/status', { ca: await caOf(nf), servername: 'atomix.home' });
    assert.equal(r.status, 200);
    assert.match(r.cert.subjectaltname, /DNS:atomix\.home/);
    assert.match(r.cert.subjectaltname, /IP Address:192\.168\.50\.9/);
  } finally {
    await nf.app.stop();
    delete process.env.ATOMIX_HTTPS_NAMES;
  }
});

test('v0.28: a port Atomix may not use says so, not "in use"', async () => {
  const { portSentence } = await import('../src/tls/server.js');
  assert.equal(portSentence({ code: 'EADDRINUSE' }, 8443), 'Port 8443 is in use; pick another port');
  assert.equal(portSentence({ code: 'EACCES' }, 443), "Atomix isn't allowed to use port 443; pick another port (above 1024 usually works)");
  assert.equal(portSentence({ code: 'EOTHER', message: 'Something else' }, 1), 'Something else');
});
