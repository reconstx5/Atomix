// v0.15.0 server hardening: redirects never carry a connected server's token to another site, the first-run
// setup code holds behind a same-host reverse proxy, the rate limit reads the proxy's own hop, slow bodies time out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fakeServer, tempDir, startAtomix, client } from './helpers.js';
import { RemoteProvider } from '../src/remote/provider.js';
import { chooseConnection } from '../src/remote/plextv.js';
import { readBody } from '../src/http/router.js';

const stops = [];
after(async () => { for (const s of stops) await s(); });

test('a connected server that redirects to another origin never sees the token there', async () => {
  const seenByB = [];
  const b = await fakeServer((req, res) => { seenByB.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const a = await fakeServer((req, res) => { res.writeHead(302, { location: `${b.url}/x` }); res.end(); });
  stops.push(() => a.close(), () => b.close());
  const p = new RemoteProvider({ kind: 'test' });
  await assert.rejects(p.request({ name: 'Elsewhere' }, `${a.url}/api/x`, { headers: { 'X-Emby-Authorization': 'secret' } }), (e) => e.status === 502 && /Elsewhere/.test(e.message));
  assert.equal(seenByB.length, 0, 'the other site never got the request');
});

test('a same-origin redirect is followed with the headers', async () => {
  const seen = [];
  const a = await fakeServer((req, res) => {
    if (req.url === '/api/x') { res.writeHead(302, { location: '/api/y' }); return res.end(); }
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  stops.push(() => a.close());
  const p = new RemoteProvider({ kind: 'test' });
  const out = await p.request({ name: 'Same' }, `${a.url}/api/x`, { headers: { 'X-Emby-Authorization': 'secret' } });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen[0]['x-emby-authorization'], 'secret');
});

test('a plex.tv connection that redirects is not followed', async () => {
  const seen = [];
  const b = await fakeServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ MediaContainer: { machineIdentifier: 'srv' } })); });
  const a = await fakeServer((req, res) => { res.writeHead(302, { location: `${b.url}/identity` }); res.end(); });
  stops.push(() => a.close(), () => b.close());
  const chosen = await chooseConnection({ clientIdentifier: 'srv', accessToken: 'tok', connections: [{ uri: a.url }] }, { timeoutMs: 1000 });
  assert.equal(chosen, null);
  assert.equal(seen.length, 0);
});

test('with trustProxy the client IP is the last forwarded hop', async () => {
  const nf = await startAtomix({}, { trustProxy: true });
  stops.push(() => nf.app.stop());
  const ip = nf.app.core.auth.clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.2' }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(ip, '10.0.0.2');
});

test('first-run setup from loopback behind a proxy header needs the code', async () => {
  const nf = await startAtomix({}, { trustProxy: false });
  stops.push(() => nf.app.stop());
  const c = client(nf.base);
  let r = await c.get('/api/status', { 'x-forwarded-proto': 'https' });
  assert.equal(r.data.setupCodeRequired, true, 'a proxy header means another device');
  r = await c.post('/api/setup', { username: 'admin', password: 'password123' }, { 'x-real-ip': '203.0.113.9' });
  assert.equal(r.status, 403);
  r = await c.get('/api/status');
  assert.equal(r.data.setupCodeRequired, false, 'plain loopback still does not');
  r = await c.post('/api/setup', { username: 'admin', password: 'password123' });
  assert.equal(r.status, 200);
});

test('a slow body is rejected with 408 after the timeout', async () => {
  const srv = http.createServer(async (req, res) => {
    try {
      await readBody(req, 1e6, { timeoutMs: 100 });
      res.writeHead(200); res.end('ok');
    } catch (err) { res.writeHead(err.status || 500); res.end(err.message); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  stops.push(() => new Promise((r) => srv.close(r)));
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/', headers: { 'content-length': '10' } }, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.write('abc'); // and never finishes
  });
  assert.equal(status, 408);
});

test('a chunked body over the cap is answered 413, not reset', async () => {
  const srv = http.createServer(async (req, res) => {
    try {
      await readBody(req, 1000);
      res.writeHead(200); res.end('ok');
    } catch (err) { res.writeHead(err.status || 500, { connection: 'close' }); res.end(err.message); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  stops.push(() => new Promise((r) => srv.close(r)));
  const got = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: '/' }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
    for (let i = 0; i < 64; i++) req.write(Buffer.alloc(32 * 1024, 1)); // 2 MB, chunked (no content-length)
    req.end();
  });
  assert.deepEqual(got, { status: 413, text: 'Request body too large' });
});

const statusWithHost = (base, host) =>
  new Promise((resolve, reject) => {
    const u = new URL('/api/status', base);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });

test('the setup code is skipped only for a loopback request addressed to this machine, with trustProxy off', async () => {
  const nf = await startAtomix({}, { trustProxy: false });
  stops.push(() => nf.app.stop());
  assert.equal((await statusWithHost(nf.base, 'atomix.example')).setupCodeRequired, true, 'a proxy on this machine forwarding a public name (no forwarding headers)');
  assert.equal((await statusWithHost(nf.base, `localhost:${new URL(nf.base).port}`)).setupCodeRequired, false);
  assert.equal((await statusWithHost(nf.base, `[::1]:${new URL(nf.base).port}`)).setupCodeRequired, false);
  const proxied = await startAtomix({}, { trustProxy: true });
  stops.push(() => proxied.app.stop());
  assert.equal((await statusWithHost(proxied.base, `127.0.0.1:${new URL(proxied.base).port}`)).setupCodeRequired, true, 'behind a proxy, everyone is "another device"');
});

test('trustProxy: 2 takes the second address from the right of X-Forwarded-For (a CDN in front of the proxy)', async () => {
  const nf = await startAtomix({}, { trustProxy: 2 });
  stops.push(() => nf.app.stop());
  const ip = (fwd) => nf.app.core.auth.clientIp({ headers: { 'x-forwarded-for': fwd }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(ip('6.6.6.6, 1.2.3.4, 10.0.0.1'), '1.2.3.4');
  assert.equal(ip('9.9.9.9, 6.6.6.6, 1.2.3.4, 10.0.0.1'), '1.2.3.4', 'a longer chain a client wrote doesn\'t move it');
  assert.equal(ip('10.0.0.1'), '10.0.0.1', 'a shorter chain: its first entry');
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({ env: { ATOMIX_TRUST_PROXY: '2' }, root: tempDir() }).trustProxy, 2);
  assert.equal(loadConfig({ env: { ATOMIX_TRUST_PROXY: 'true' }, root: tempDir() }).trustProxy, true);
});

test('through the app, an endless chunked body over the cap gets 413 and the connection closes', async () => {
  const { app, base } = await startAtomix();
  stops.push(() => app.stop());
  const port = new URL(base).port;
  const got = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      // The answer arrives and the server then closes the connection (no endless drain).
      res.socket.once('close', () => resolve({ status: res.statusCode, connection: res.headers.connection }));
    });
    req.on('error', () => {});
    const chunk = Buffer.alloc(64 * 1024, 32);
    const pump = () => { if (!req.destroyed) req.write(chunk, () => setImmediate(pump)); };
    pump();
    setTimeout(() => reject(new Error('no answer')), 8000).unref();
    stops.push(() => req.destroy());
  });
  assert.equal(got.status, 413);
  assert.equal(got.connection, 'close');
});
