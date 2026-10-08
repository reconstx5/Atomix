// Cast links: the private link a TV uses to fetch one title's media from Atomix, without a sign-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

let nf, admin, other, base;
const ids = {};
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Cast Film (2020)', 'Cast Film (2020).mp4'), { seconds: 4 });
  fs.writeFileSync(path.join(media, 'Movies', 'Cast Film (2020)', 'Cast Film (2020).en.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello TV\n');
  makeVideo(path.join(media, 'Movies', 'Other Film (2021)', 'Other Film (2021).mkv'), { seconds: 4, acodec: 'ac3' });
  nf = await startAtomix();
  base = nf.base;
  admin = client(base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await waitForScan(admin);
  const items = (await admin.get('/api/libraries/1/items')).data.items;
  ids.film = items.find((i) => i.title === 'Cast Film').id;
  ids.other = items.find((i) => i.title === 'Other Film').id;
  nf.app.core.db.run("UPDATE items SET poster = ? WHERE id = ?", 'file:' + path.join(media, 'poster.png'), ids.film);
  fs.writeFileSync(path.join(media, 'poster.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'));
  await admin.post('/api/users', { username: 'sam', password: 'sampass123', role: 'user' });
  other = client(base);
  await other.post('/api/auth/login', { username: 'sam', password: 'sampass123' });
});
after(async () => nf?.app.stop());

const links = () => nf.app.core.cast.links;
const userId = () => nf.app.core.db.get("SELECT id FROM users WHERE username = 'dallas'").id;
const bare = (p, init) => fetch(base + p, init);

test('a cast link plays its own file with no cookie, and nothing else', { skip }, async () => {
  const t = links().issue({ itemId: ids.film, userId: userId(), profileId: null, castId: 'c1' });
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  const ok = await bare(`/api/items/${ids.film}/file?cast=${t}`);
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
  const part = await bare(`/api/items/${ids.film}/file?cast=${t}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  await part.arrayBuffer();
  assert.equal((await bare(`/api/items/${ids.other}/file?cast=${t}`)).status, 401, 'another title');
  assert.equal((await bare(`/api/items/${ids.film}?cast=${t}`)).status, 401, 'not a media route');
  assert.equal((await bare(`/api/items/${ids.film}/file?cast=nope`)).status, 401);
});

test('a cast link serves its film\'s subtitles and artwork with CORS; a cookie request has no CORS header', { skip }, async () => {
  const t = links().issue({ itemId: ids.film, userId: userId(), profileId: null, castId: 'c2' });
  const subs = (await admin.get(`/api/items/${ids.film}`)).data.subtitles;
  const sub = subs.find((s) => s.url);
  const v = await bare(`${sub.url}?cast=${t}`);
  assert.equal(v.status, 200);
  assert.equal(v.headers.get('access-control-allow-origin'), '*');
  assert.match(await v.text(), /Hello TV/);
  const img = await bare(`/api/items/${ids.film}/image/poster?cast=${t}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('access-control-allow-origin'), '*');
  const plain = await admin.raw(sub.url);
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
});

test('a converted session\'s stream accepts its own link only', { skip }, async () => {
  const s = (await admin.post(`/api/items/${ids.other}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  const t = links().issue({ sessionId: s.sessionId, itemId: ids.other, userId: userId(), profileId: null, castId: 'c3' });
  const r = await bare(`${s.url}?cast=${t}`);
  assert.equal(r.status, 200);
  await r.body?.cancel();
  const s2 = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  assert.equal((await bare(`${s2.url}?cast=${t}`)).status, 401, 'another session');
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
  await admin.post(`/api/playback/${s2.sessionId}/stop`, {});
});

test('revokeSession and revokeCast end a link; an expired link is refused', { skip }, async () => {
  const a = links().issue({ itemId: ids.film, sessionId: 'sx', userId: userId(), profileId: null, castId: 'c4' });
  links().revokeSession('sx');
  assert.equal((await bare(`/api/items/${ids.film}/file?cast=${a}`)).status, 401);
  const b = links().issue({ itemId: ids.film, userId: userId(), profileId: null, castId: 'c5' });
  links().revokeCast('c5');
  assert.equal((await bare(`/api/items/${ids.film}/file?cast=${b}`)).status, 401);
  const c = links().issue({ itemId: ids.film, userId: userId(), profileId: null, castId: 'c6', ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await bare(`/api/items/${ids.film}/file?cast=${c}`)).status, 401);
});

test('POST /api/playback/:sid/cast-link gives a link for the caller\'s own session; another user\'s session is a 404', { skip }, async () => {
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true } })).data;
  const r = await admin.post(`/api/playback/${s.sessionId}/cast-link`, {});
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^[A-Za-z0-9_-]{43}$/);
  const f = await bare(`${s.url}?cast=${r.data.token}`);
  assert.equal(f.status, 200);
  await f.arrayBuffer();
  assert.equal((await other.post(`/api/playback/${s.sessionId}/cast-link`, {})).status, 404);
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
  assert.equal((await bare(`${s.url}?cast=${r.data.token}`)).status, 401, 'the link ends with the session');
});

test('an HLS playlist fetched with a cast link carries the link on every segment (AirPlay of a converted title)', { skip }, async () => {
  const s = (await admin.post(`/api/items/${ids.other}/playback`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'], hls: true } })).data;
  assert.equal(s.delivery, 'hls');
  const { token } = (await admin.post(`/api/playback/${s.sessionId}/cast-link`, {})).data;
  const res = await bare(`${s.url}?cast=${token}`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const uris = [...text.matchAll(/^(?!#)(\S+)$/gm)].map((m) => m[1]).concat([...text.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(uris.length >= 2, text);
  for (const u of uris) assert.ok(u.includes(`cast=${token}`), u);
  const seg = await bare(new URL(uris.at(-1), `http://x/api/hls/${s.sessionId}/`).pathname + new URL(uris.at(-1), 'http://x/api/hls/a/').search);
  assert.equal(seg.status, 200);
  await seg.arrayBuffer();
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
});

test('a link whose profile was deleted is refused', { skip }, async () => {
  const jo = (await admin.post('/api/profiles', { name: 'Jo' })).data.id;
  const t = links().issue({ itemId: ids.film, userId: userId(), profileId: jo, castId: 'c9' });
  assert.equal((await bare(`/api/items/${ids.film}/file?cast=${t}`, { method: 'HEAD' })).status, 200);
  assert.equal((await admin.del(`/api/profiles/${jo}`)).status, 200);
  const r = await bare(`/api/items/${ids.film}/file?cast=${t}`);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'This cast link has ended.');
});
