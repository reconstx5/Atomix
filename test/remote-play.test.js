// Playing a connected server's titles through Atomix: the Range proxy, ffmpeg from a URL, images with the token,
// progress pushed back, and the server failing or going away mid-play.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { fakeJellyfin, jfMovie } from './helpers-jellyfin.js';

let jf, nf, admin;
const ids = {};
const now = Date.now();
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  const dir = tempDir();
  const mp4 = path.join(dir, 'clip.mp4');
  makeVideo(mp4, { seconds: 4 });
  // The stream the fake serves is an MKV with one embedded subtitle track, so extraction through the proxy can be tested.
  fs.writeFileSync(path.join(dir, 'sub.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello from afar\n');
  const file = path.join(dir, 'clip.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp4, '-i', path.join(dir, 'sub.srt'), '-c', 'copy', '-c:s', 'srt', file]);
  jf = await fakeJellyfin({ streamFile: file, movies: [
    jfMovie('m1', 'Remote Film', { MediaSources: [{ Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 320, Height: 180, Index: 0 }, { Type: 'Audio', Codec: 'aac', Channels: 1, Index: 1 }, { Type: 'Subtitle', Codec: 'subrip', Language: 'eng', Index: 2 }] }] }),
    jfMovie('m2', 'Stub Film', { MediaSources: [] }),
  ] });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const db = nf.app.core.db;
  ids.server = Number(db.run("INSERT INTO servers (kind, name, url, username, secret, remote_user_id, created_at) VALUES ('jellyfin', 'Fake Jellyfin', ?, 'dallas', 'tok1', 'u1', ?)", jf.url, now).lastInsertRowid);
  ids.movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('Movies (Fake Jellyfin)', 'movies', '[]', '{}', ?, ?, 'lib-m')", now, ids.server).lastInsertRowid);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const items = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items;
  ids.film = items.find((i) => i.title === 'Remote Film').id;
  ids.stub = items.find((i) => i.title === 'Stub Film').id;
  ids.size = fs.statSync(file).size;
});
after(async () => { await nf?.app.stop(); jf?.close(); });

test('the file route proxies a remote stream with Range', { skip }, async () => {
  const res = await admin.raw(`/api/items/${ids.film}/file`, { headers: { range: 'bytes=0-99' } });
  assert.equal(res.status, 206);
  assert.match(res.headers.get('content-range'), new RegExp(`^bytes 0-99/${ids.size}$`));
  assert.equal((await res.arrayBuffer()).byteLength, 100);
  const whole = await admin.raw(`/api/items/${ids.film}/file`);
  assert.equal(whole.status, 200);
  assert.equal((await whole.arrayBuffer()).byteLength, ids.size);
});

test('a start on a remote film works, remuxed (an MKV stream) or converted', { skip }, async () => {
  const remux = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true } })).data;
  assert.equal(remux.mode, 'remux', 'MKV never plays as-is in a browser; ffmpeg reads the server\'s stream');
  const conv = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  assert.equal(conv.mode, 'transcode');
  await admin.post(`/api/playback/${remux.sessionId}/stop`, {});
  const first = await admin.raw(conv.url);
  assert.equal(first.status, 200, 'ffmpeg read the remote URL');
  const buf = Buffer.from(await first.arrayBuffer());
  assert.ok(buf.length > 0);
  await admin.post(`/api/playback/${conv.sessionId}/stop`, {});
});

test('a title the server has no file for answers a clear error at play, not a doomed conversion', { skip }, async () => {
  const res = await admin.post(`/api/items/${ids.stub}/playback`, { caps: { mp4: true, h264: true, aac: true } });
  assert.equal(res.status, 404);
  assert.match(res.data.error, /Fake Jellyfin/);
});

test('embedded subtitles of a remote title are listed with labels and extracted through the stream', { skip }, async () => {
  const page = (await admin.get(`/api/items/${ids.film}`)).data;
  assert.deepEqual(page.subtitles.map((s) => [s.id, s.label, s.url]), [['e0', 'English', `/api/items/${ids.film}/subtitles/e0.vtt`]]);
  const vtt = await admin.raw(`/api/items/${ids.film}/subtitles/e0.vtt`);
  assert.equal(vtt.status, 200);
  assert.match(await vtt.text(), /WEBVTT[\s\S]*Hello from afar/);
});

test('the ffmpeg command line is logged without the sign-in header', { skip }, async () => {
  const { redactArgs } = await import('../src/stream/ffheaders.js');
  const line = redactArgs(['-headers', 'Authorization: MediaBrowser Token="tok1"\r\n', '-reconnect', '1', '-i', 'http://x/Videos/1/stream']).join(' ');
  assert.ok(!line.includes('tok1'), line);
  assert.match(line, /-headers \[redacted\]/);
});

test('an image route fetches the poster with the token and caches it', { skip }, async () => {
  jf.calls.length = 0;
  const res = await admin.raw(`/api/items/${ids.film}/image/poster`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);
  const call = jf.calls.find((c) => c.path.includes('/Images/Primary'));
  assert.ok(call && /Token="tok1"/.test(call.headers.authorization), 'fetched with the token');
  jf.calls.length = 0;
  await admin.raw(`/api/items/${ids.film}/image/poster`);
  assert.ok(!jf.calls.some((c) => c.path.includes('/Images/Primary')), 'cached');
});

test('progress is pushed to the server, at most once per 10 s plus the final one', { skip }, async () => {
  jf.calls.length = 0;
  for (const p of [40, 41, 42]) await admin.post(`/api/items/${ids.film}/progress`, { position: p, duration: 100 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(jf.calls.filter((c) => c.path === '/Sessions/Playing/Progress').length, 1, 'rate-limited');
  await admin.post(`/api/items/${ids.film}/progress`, { position: 95, duration: 100 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(jf.calls.filter((c) => c.path.startsWith('/Users/u1/PlayedItems/')).length, 1, 'watched goes straight through');
});

test('a start sends /Sessions/Playing, leaving sends /Sessions/Playing/Stopped once with the last position, in order', { skip }, async () => {
  const core = nf.app.core;
  core.remote.reporter.everyMs = 0;
  jf.calls.length = 0;
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true } })).data;
  await admin.post(`/api/items/${ids.film}/progress`, { position: 2, duration: 4, sessionId: s.sessionId });
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
  core.playback.reap(); // a second way to end the same session: must not report again
  core.playback.stop(s.sessionId, 'idle');
  await core.remote.reporter.idle();
  const paths = jf.calls.map((c) => c.path).filter((p) => p.startsWith('/Sessions/'));
  assert.deepEqual(paths, ['/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped']);
  assert.equal(jf.calls.find((c) => c.path === '/Sessions/Playing/Stopped').body.PositionTicks, 2 * 10000000);
  core.remote.reporter.everyMs = 10000;
});

test('a server that answers 401 at play marks it unauthorized and the start answers 502', { skip }, async () => {
  jf.state.token = 'rotated';
  const res = await admin.raw(`/api/items/${ids.film}/file`);
  assert.equal(res.status, 502);
  assert.equal(nf.app.core.db.get('SELECT status FROM servers WHERE id = ?', ids.server).status, 'unauthorized');
  jf.state.token = 'tok1';
  nf.app.core.db.run("UPDATE servers SET status = 'ok' WHERE id = ?", ids.server);
});

test('a 403 for one title is that title\'s problem, not a lost sign-in', { skip }, async () => {
  jf.state.forbidStream = true;
  const res = await admin.raw(`/api/items/${ids.film}/file`);
  assert.equal(res.status, 502);
  assert.equal(nf.app.core.db.get('SELECT status FROM servers WHERE id = ?', ids.server).status, 'ok', 'still signed in');
  jf.state.forbidStream = false;
});

test('a hung server does not delay the progress POST', { skip }, async () => {
  jf.state.hang = true;
  nf.app.core.remote.reporter.everyMs = 0;
  const t = Date.now();
  const r = await admin.post(`/api/items/${ids.film}/progress`, { position: 3, duration: 4 });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t < 500, `answered in ${Date.now() - t} ms`);
  jf.state.hang = false;
  for (const release of jf.state.hung.splice(0)) release();
  await nf.app.core.remote.reporter.idle();
  nf.app.core.remote.reporter.everyMs = 10000;
});

test('three progress reports queued behind a hung server send only the latest when it answers; the stop goes right after', { skip }, async () => {
  const core = nf.app.core;
  await core.remote.reporter.idle();
  core.remote.reporter.everyMs = 0;
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  await core.remote.reporter.idle();
  const at = jf.calls.length;
  jf.state.hang = true;
  await admin.post(`/api/items/${ids.film}/progress`, { position: 1, duration: 4, sessionId: s.sessionId });
  for (let i = 0; i < 50 && !jf.state.hung.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(jf.state.hung.length, 1, 'the first report is stuck at the server');
  for (const position of [2, 2.5, 3]) await admin.post(`/api/items/${ids.film}/progress`, { position, duration: 4, sessionId: s.sessionId });
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
  jf.state.hang = false;
  for (const release of jf.state.hung.splice(0)) release();
  await core.remote.reporter.idle();
  const sent = jf.calls.slice(at).filter((c) => c.path.startsWith('/Sessions/Playing'));
  assert.deepEqual(sent.map((c) => [c.path, c.body?.PositionTicks]), [
    ['/Sessions/Playing/Progress', jf.ticks(1)],
    ['/Sessions/Playing/Progress', jf.ticks(3)],
    ['/Sessions/Playing/Stopped', sent.at(-1).body?.PositionTicks],
  ]);
  core.remote.reporter.everyMs = 10000;
});

test('two sessions on the same remote title each get their own 10 s window and pending report', { skip }, async () => {
  const core = nf.app.core;
  await core.remote.reporter.idle();
  core.remote.reporter.everyMs = 10000;
  const a = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  const b = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  await core.remote.reporter.idle();
  const at = jf.calls.length;
  await admin.post(`/api/items/${ids.film}/progress`, { position: 1, duration: 4, sessionId: a.sessionId });
  await admin.post(`/api/items/${ids.film}/progress`, { position: 2, duration: 4, sessionId: b.sessionId });
  await core.remote.reporter.idle();
  const sent = jf.calls.slice(at).filter((c) => c.path === '/Sessions/Playing/Progress').map((c) => c.body.PositionTicks);
  assert.deepEqual(sent, [jf.ticks(1), jf.ticks(2)], 'both viewers reported, not one throttled by the other');
  await admin.post(`/api/playback/${a.sessionId}/stop`, {});
  await admin.post(`/api/playback/${b.sessionId}/stop`, {});
  await core.remote.reporter.idle();
});

test('a pending watched report is not replaced by a later plain one', { skip }, async () => {
  const core = nf.app.core;
  await core.remote.reporter.idle();
  core.remote.reporter.everyMs = 0;
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  await core.remote.reporter.idle();
  const at = jf.calls.length;
  jf.state.hang = true;
  await admin.post(`/api/items/${ids.film}/progress`, { position: 0.2, duration: 4, sessionId: s.sessionId });
  for (let i = 0; i < 50 && !jf.state.hung.length; i++) await new Promise((r) => setTimeout(r, 20));
  await admin.post(`/api/items/${ids.film}/progress`, { position: 3.9, duration: 4, sessionId: s.sessionId }); // watched, queued
  await admin.post(`/api/items/${ids.film}/progress`, { position: 0.5, duration: 4, sessionId: s.sessionId }); // a rewind: must not replace the watched one
  jf.state.hang = false;
  for (const release of jf.state.hung.splice(0)) release();
  await core.remote.reporter.idle();
  const sent = jf.calls.slice(at).filter((c) => c.path.startsWith('/Sessions/Playing/Progress') || c.path.includes('/PlayedItems/'));
  assert.ok(sent.some((c) => c.path.includes('/PlayedItems/')), 'the watched report went');
  assert.ok(!sent.some((c) => c.body?.PositionTicks === jf.ticks(0.5)), 'the rewind did not replace it');
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
  await core.remote.reporter.idle();
  core.remote.reporter.everyMs = 10000;
});

test('removing the server mid-play stops its live sessions, deletes its cached artwork, and ends cleanly', { skip }, async () => {
  const core = nf.app.core;
  const poster = core.db.get('SELECT poster FROM items WHERE id = ?', ids.film).poster;
  assert.equal((await admin.raw(`/api/items/${ids.film}/image/poster`)).status, 200);
  assert.ok(core.images.cachedFor(poster), 'cached first');
  const s = (await admin.post(`/api/items/${ids.film}/playback`, { caps: { mp4: true, h264: true, aac: true }, forceTranscode: true })).data;
  await admin.raw(s.url);
  assert.ok(core.playback.sessions.has(s.sessionId));
  await core.remote.reporter.idle();
  const stopsBefore = jf.calls.filter((c) => c.path === '/Sessions/Playing/Stopped').length;
  const stops = [];
  core.hooks.on('playback:stop', ({ session, reason }) => stops.push([session.id, reason]));
  assert.equal((await admin.del(`/api/servers/${ids.server}`)).status, 200);
  assert.ok(!core.playback.sessions.has(s.sessionId), 'the session is gone at once');
  assert.deepEqual(stops.find(([id]) => id === s.sessionId), [s.sessionId, 'server removed']);
  assert.equal(jf.calls.filter((c) => c.path === '/Sessions/Playing/Stopped').length, stopsBefore + 1, 'the server was told it stopped, before it was removed');
  assert.equal(core.images.cachedFor(poster), null, 'its artwork is gone from the cache');
  const hb = await admin.post(`/api/items/${ids.film}/progress`, { position: 1, duration: 4, sessionId: s.sessionId });
  assert.equal(hb.status, 404);
  assert.equal((await admin.raw(`/api/items/${ids.film}/file`)).status, 404);
  assert.equal((await admin.get('/api/status')).status, 200, 'the server is still up');
});
