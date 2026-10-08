// Playing a Plex title through Atomix: the proxy, ffmpeg from the Plex URL, embedded subtitles, a title with no
// file, images (never the token to another host), and the timeline/scrobble reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { fakePlex, plexMovie } from './helpers-plex.js';

let px, cdn, nf, admin;
const ids = {};
const skip = !hasFfmpeg && 'ffmpeg not installed';
const cdnCalls = [];

before(async () => {
  if (!hasFfmpeg) return;
  const dir = tempDir();
  const mp4 = path.join(dir, 'clip.mp4');
  makeVideo(mp4, { seconds: 4 });
  fs.writeFileSync(path.join(dir, 'sub.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello from Plex\n');
  const file = path.join(dir, 'clip.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-i', path.join(dir, 'sub.srt'), '-c', 'copy', '-c:s', 'srt', file]);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  cdn = await fakeServer((req, res) => { cdnCalls.push(req.headers); res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  const part = '/library/parts/11/1/file.mkv';
  const media = [{ container: 'mkv', videoCodec: 'h264', width: 160, height: 90, audioCodec: 'aac', audioChannels: 1, Part: [{ key: part }] }];
  px = await fakePlex({
    streamFile: file,
    sections: [{ key: '1', title: 'Movies', type: 'movie' }],
    items: { 1: { 1: [plexMovie('11', 'Plex Film', { duration: 4000, Media: media }), plexMovie('12', 'No File', { Media: undefined, thumb: `${cdn.url}/agent/poster.png` })] } },
    details: { 11: plexMovie('11', 'Plex Film', { duration: 4000, Media: [{ ...media[0], Part: [{ key: part, Stream: [{ streamType: 1, codec: 'h264', width: 160, height: 90 }, { streamType: 2, codec: 'aac', channels: 1, languageCode: 'eng' }, { streamType: 3, codec: 'srt', languageCode: 'eng', displayTitle: 'English' }] }] }] }) },
  });
  nf = await startAtomix();
  nf.app.core.remote.sync.paceMs = 0;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const db = nf.app.core.db;
  ids.server = Number(db.run("INSERT INTO servers (kind, name, url, username, secret, remote_user_id, created_at) VALUES ('plex', 'Dev Plex', ?, 'dallas', 'srv1', 'mach1', ?)", px.url, Date.now()).lastInsertRowid);
  ids.movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('Movies', 'movies', '[]', '{}', ?, ?, '1')", Date.now(), ids.server).lastInsertRowid);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const items = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items;
  ids.film = items.find((i) => i.title === 'Plex Film').id;
  ids.none = items.find((i) => i.title === 'No File').id;
});
after(async () => { await nf?.app.stop(); await px?.close(); await cdn?.close(); });

test('playing a Plex title through the proxy and through ffmpeg; timeline playing → stopped and scrobble at the end', { skip }, async () => {
  const core = nf.app.core;
  core.remote.reporter.everyMs = 0;
  const part = await admin.raw(`/api/items/${ids.film}/file`, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal(px.calls.find((c) => c.path.startsWith('/library/parts/')).headers['x-plex-token'], 'srv1');
  px.calls.length = 0;
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  const first = await admin.raw(s.url);
  assert.equal(first.status, 200, 'ffmpeg read the Plex URL');
  await admin.post(`/api/items/${ids.film}/progress`, { position: 3.9, duration: 4, sessionId: s.sessionId });
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
  await core.remote.reporter.idle();
  const seen = px.calls.filter((c) => c.path.startsWith('/:/')).map((c) => (c.path === '/:/timeline' ? c.query.state : 'scrobble'));
  assert.deepEqual(seen, ['playing', 'scrobble', 'stopped']);
  core.remote.reporter.everyMs = 10000;
});

test('embedded subtitles extract through the Plex stream; a title with no Media answers "<server> has no playable file"', { skip }, async () => {
  const page = (await admin.get(`/api/items/${ids.film}`)).data;
  assert.deepEqual(page.subtitles.map((x) => [x.id, x.label]), [['e0', 'English']]);
  const vtt = await admin.raw(`/api/items/${ids.film}/subtitles/e0.vtt`);
  assert.equal(vtt.status, 200);
  assert.match(await vtt.text(), /Hello from Plex/);
  const none = await admin.post(`/api/items/${ids.none}/playback`, { caps: { mp4: true, h264: true, aac: true } });
  assert.equal(none.status, 404);
  assert.equal(none.data.error, 'Dev Plex has no playable file for this title.');
});

test('an agent poster on another host is fetched through Atomix without the Plex token', { skip }, async () => {
  const r = await admin.raw(`/api/items/${ids.none}/image/poster`);
  assert.equal(r.status, 200);
  assert.ok(cdnCalls.length >= 1);
  assert.ok(cdnCalls.every((h) => !h['x-plex-token']), 'the token never went to the other host');
  const own = await admin.raw(`/api/items/${ids.film}/image/poster`);
  assert.equal(own.status, 200);
  assert.equal(px.calls.filter((c) => /\/thumb\//.test(c.path)).at(-1).headers['x-plex-token'], 'srv1');
});

test('shutting down tells Plex the stream stopped', { skip }, async () => {
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true } })).data;
  await nf.app.core.remote.reporter.idle();
  px.calls.length = 0;
  assert.ok(s.sessionId);
  await nf.app.stop();
  nf = null;
  assert.deepEqual(px.calls.filter((c) => c.path === '/:/timeline').map((c) => c.query.state), ['stopped']);
});
