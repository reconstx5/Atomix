// The proxy that passes a connected server's stream (and artwork) through Atomix: HEAD, identity encoding, 416,
// a server that never answers, and redirects (followed with the sign-in only on the server itself).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { fakeJellyfin, jfMovie } from './helpers-jellyfin.js';

let jf, other, nf, admin;
const ids = {};
const skip = !hasFfmpeg && 'ffmpeg not installed';
const otherHits = [];
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

before(async () => {
  if (!hasFfmpeg) return;
  const file = path.join(tempDir(), 'clip.mp4');
  makeVideo(file, { seconds: 2 });
  jf = await fakeJellyfin({ streamFile: file, movies: [jfMovie('m1', 'Remote Film')] });
  other = await fakeServer((req, res) => {
    otherHits.push({ path: req.url, headers: req.headers });
    if (req.url.startsWith('/img')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(jf.state.png);
    }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end('elsewhere');
  });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const db = nf.app.core.db;
  const now = Date.now();
  ids.server = Number(db.run("INSERT INTO servers (kind, name, url, username, secret, remote_user_id, created_at) VALUES ('jellyfin', 'Fake Jellyfin', ?, 'dallas', 'tok1', 'u1', ?)", jf.url, now).lastInsertRowid);
  ids.movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('Movies (Fake Jellyfin)', 'movies', '[]', '{}', ?, ?, 'lib-m')", now, ids.server).lastInsertRowid);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  ids.film = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items[0].id;
  ids.size = fs.statSync(file).size;
});
after(async () => { await nf?.app.stop(); jf?.close(); other?.close(); });
const streamCalls = () => jf.calls.filter((c) => c.path === '/Videos/m1/stream');

test('HEAD goes upstream as HEAD and returns the length with no body', { skip }, async () => {
  const n = streamCalls().length;
  const res = await admin.raw(`/api/items/${ids.film}/file`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get('content-length')), ids.size);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
  const call = streamCalls().slice(n);
  assert.deepEqual(call.map((c) => c.method), ['HEAD']);
});

test('the upstream request asks for identity encoding', { skip }, async () => {
  // (fetch adds identity by itself when there is a Range header; a whole-file request is the one to check.)
  const n = streamCalls().length;
  await (await admin.raw(`/api/items/${ids.film}/file`)).arrayBuffer();
  assert.equal(streamCalls()[n].headers['accept-encoding'], 'identity', JSON.stringify(streamCalls()[n].headers));
});

test('a 416 upstream is a 416 with its content-range', { skip }, async () => {
  const res = await admin.raw(`/api/items/${ids.film}/file`, { headers: { range: `bytes=${ids.size + 100}-` } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${ids.size}`);
});

test('no headers within the timeout is a 504 and the upstream request is aborted', { skip, timeout: 10000 }, async () => {
  nf.app.core.remote.proxyHeaderTimeoutMs = 300;
  jf.state.streamSlow = true;
  try {
    const t = Date.now();
    const res = await admin.raw(`/api/items/${ids.film}/file`);
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error, "Fake Jellyfin didn't answer in time");
    assert.ok(Date.now() - t < 3000);
    assert.ok(await until(() => jf.state.slowClosed >= 1), 'the upstream request was let go');
  } finally {
    jf.state.streamSlow = false;
    nf.app.core.remote.proxyHeaderTimeoutMs = undefined;
  }
});

test('a same-origin redirect is followed with the sign-in; a stream redirect to another origin is a 502; an image redirect to another origin is fetched without the sign-in', { skip }, async () => {
  jf.state.streamRedirect = `${jf.url}/Videos/m1/stream?static=true&real=1`;
  try {
    const n = streamCalls().length;
    const res = await admin.raw(`/api/items/${ids.film}/file`, { headers: { range: 'bytes=0-9' } });
    assert.equal(res.status, 206);
    assert.equal((await res.arrayBuffer()).byteLength, 10);
    const followed = streamCalls().slice(n);
    assert.equal(followed.length, 2);
    assert.ok(followed[1].query.real, 'followed to the new address');
    assert.ok(/tok1/.test(followed[1].headers['x-emby-authorization'] || followed[1].headers.authorization || ''), 'with the sign-in, on the same server');
    jf.state.streamRedirect = `${other.url}/video.mp4`;
    const away = await admin.raw(`/api/items/${ids.film}/file`);
    assert.equal(away.status, 502);
    assert.equal(otherHits.length, 0, 'never fetched from the other site');
  } finally {
    jf.state.streamRedirect = null;
  }
  jf.state.imageRedirect = `${other.url}/img/poster.png`;
  try {
    const images = nf.app.core.images;
    const got = await images.download(`${jf.url}/Items/m1/Images/Primary?tag=redirect-test`, { 'X-Emby-Token': 'tok1', authorization: 'MediaBrowser Token="tok1"' });
    assert.match(String(got), /^cache:/);
    const hit = otherHits.find((h) => h.path.startsWith('/img'));
    assert.ok(hit, 'fetched from the CDN');
    assert.equal(hit.headers['x-emby-token'], undefined, 'without the sign-in');
    assert.equal(hit.headers.authorization, undefined);
  } finally {
    jf.state.imageRedirect = null;
  }
});
