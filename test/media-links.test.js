// Media links (v0.28): Safari on iPhone (and Apple's media player behind it) may fetch a video without the sign-in
// cookie. A player that asks for it gets its playback address with a private link of its own, the same kind a TV
// gets when casting: that one title or that one stream, ended when the playback stops.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

let nf, admin, base;
const ids = {};
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Phone Film (2020)', 'Phone Film (2020).mp4'), { seconds: 4 });
  makeVideo(path.join(media, 'Movies', 'Other Film (2021)', 'Other Film (2021).mp4'), { seconds: 4 });
  makeVideo(path.join(media, 'Movies', 'Old Film (2019)', 'Old Film (2019).mkv'), { seconds: 4, acodec: 'ac3' });
  nf = await startAtomix();
  base = nf.base;
  admin = client(base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await waitForScan(admin);
  const items = (await admin.get('/api/libraries/1/items')).data.items;
  for (const i of items) ids[i.title] = i.id;
});
after(async () => nf?.app.stop());

const bare = (p, init) => fetch(base + p, init);
const iphone = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'], hls: true, mse: false };

test('a player that asks gets a media link: its file plays with no cookie, other titles do not', { skip }, async () => {
  const res = await admin.post(`/api/items/${ids['Phone Film']}/playback`, { caps: iphone, mediaLink: true });
  assert.equal(res.status, 200);
  assert.equal(res.data.mode, 'direct');
  const u = new URL(res.data.url, base);
  assert.ok(u.searchParams.get('cast'), `the address carries a link: ${res.data.url}`);
  const ok = await bare(`${u.pathname}${u.search}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(ok.status, 206, 'played without a cookie');
  await ok.arrayBuffer();
  const other = await bare(`/api/items/${ids['Other Film']}/file${u.search}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(other.status, 401, 'the link is for its own title only');
  await other.arrayBuffer();
  await admin.post(`/api/playback/${res.data.sessionId}/stop`, {});
  const after = await bare(`${u.pathname}${u.search}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(after.status, 401, 'stopping the playback ends the link');
  await after.arrayBuffer();
});

test('a converted stream (HLS on iPhone) carries the link on its playlist and every piece', { skip }, async () => {
  const res = await admin.post(`/api/items/${ids['Old Film']}/playback`, { caps: iphone, mediaLink: true });
  assert.equal(res.status, 200);
  assert.notEqual(res.data.mode, 'direct');
  const u = new URL(res.data.url, base);
  assert.ok(u.searchParams.get('cast'), `the address carries a link: ${res.data.url}`);
  const list = await bare(`${u.pathname}${u.search}`);
  assert.equal(list.status, 200, 'the playlist, without a cookie');
  const text = await list.text();
  const entries = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.ok(entries.length && entries.every((l) => l.includes('cast=')), text);
  await admin.post(`/api/playback/${res.data.sessionId}/stop`, {});
});

test('without asking, nothing changes: the address has no link', { skip }, async () => {
  const res = await admin.post(`/api/items/${ids['Phone Film']}/playback`, { caps: iphone });
  assert.equal(res.status, 200);
  assert.ok(!new URL(res.data.url, base).searchParams.has('cast'), res.data.url);
  await admin.post(`/api/playback/${res.data.sessionId}/stop`, {});
});

test('v0.28: a converted HLS stream starts converting when the playback is made, not when the phone first asks', { skip }, async () => {
  const res = await admin.post(`/api/items/${ids['Old Film']}/playback`, { caps: iphone });
  assert.equal(res.data.delivery, 'hls');
  const session = nf.app.core.playback.sessions.get(res.data.sessionId);
  assert.ok(session.dir && session.proc, 'ffmpeg is already running');
  await admin.post(`/api/playback/${res.data.sessionId}/stop`, {});
});

test('v0.28 (iPhone diagnosis): the first piece of a converted stream is kept in data/logs/hls-sample with its command', { skip }, async () => {
  const fs = await import('node:fs');
  const res = await admin.post(`/api/items/${ids['Old Film']}/playback`, { caps: iphone });
  const seg = await admin.get(`/api/hls/${res.data.sessionId}/seg00000.m4s`);
  assert.equal(seg.status, 200);
  const dir = path.join(nf.dataDir, 'logs', 'hls-sample');
  for (const f of ['init.mp4', 'seg00000.m4s', 'command.txt']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'command.txt'), 'utf8'), /-f hls/);
  await admin.post(`/api/playback/${res.data.sessionId}/stop`, {});
});

test("v0.28 (iPhone): init.mp4 is served from the copy taken once it was complete, even while ffmpeg rewrites it", { skip }, async () => {
  const fs = await import('node:fs');
  const res = await admin.post(`/api/items/${ids['Old Film']}/playback`, { caps: iphone });
  const sid = res.data.sessionId;
  assert.equal((await admin.get(`/api/hls/${sid}/index.m3u8`)).status, 200);
  const get = async () => {
    const r = await admin.raw(`/api/hls/${sid}/init.mp4`);
    return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
  };
  const a = await get();
  assert.equal(a.status, 200);
  assert.match(a.type, /video\/mp4/);
  assert.ok(a.body.includes(Buffer.from('moov')), 'a whole header');
  // ffmpeg 9 on Windows replaces init.mp4 while it works: the file can be missing or half-written for a moment.
  const session = nf.app.core.playback.sessions.get(sid);
  fs.writeFileSync(path.join(session.dir, 'init.mp4'), Buffer.alloc(10));
  const b = await get();
  assert.equal(b.status, 200);
  assert.equal(Buffer.compare(a.body, b.body), 0, 'the same, complete header');
  await admin.post(`/api/playback/${sid}/stop`, {});
});
