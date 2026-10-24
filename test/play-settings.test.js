// Audio and subtitle delay per profile and title: clamped, rounded to 0.1 s, remembered; a delayed file that would
// play as-is is copied (not converted) with the shift, and keeps it from any start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { PlaySettings } from '../src/library/playsettings.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

test('clamped, rounded, per profile; both zero forgets', () => {
  const db = openDatabase(path.join(tempDir(), 'ps.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', 1)");
  db.run("INSERT INTO profiles (id, user_id, name, avatar, is_primary, created_at) VALUES (1, 1, 'A', 'blue', 1, 1), (2, 1, 'B', 'blue', 0, 1)");
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'M', 'movies', '[]', '{}', 1)");
  db.run("INSERT INTO items (id, library_id, kind, title, added_at, updated_at) VALUES (1, 1, 'movie', 'F', 1, 1)");
  const ps = new PlaySettings({ db });
  assert.deepEqual(ps.get(1, 1), { audioDelay: 0, subtitleDelay: 0 });
  assert.deepEqual(ps.set(1, 1, { audioDelay: 7.04 }), { audioDelay: 5, subtitleDelay: 0 });
  assert.deepEqual(ps.set(1, 1, { audioDelay: -0.26, subtitleDelay: -12 }), { audioDelay: -0.3, subtitleDelay: -10 });
  assert.deepEqual(ps.set(1, 1, { subtitleDelay: 1.25 }), { audioDelay: -0.3, subtitleDelay: 1.3 }, 'a field left out keeps its value');
  assert.deepEqual(ps.get(2, 1), { audioDelay: 0, subtitleDelay: 0 }, 'per profile');
  ps.set(1, 1, { audioDelay: 0, subtitleDelay: 0 });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM play_settings').n, 0);
  assert.deepEqual(ps.set(1, 1, { audioDelay: 'x' }), { audioDelay: 0, subtitleDelay: 0 });
});

let nf;
let admin;
const ids = {};
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Plain (2020)', 'Plain (2020).mp4'), { seconds: 6 });
  fs.writeFileSync(path.join(media, 'Movies', 'Plain (2020)', 'Plain (2020).nfo'), '<movie><title>Plain</title><mpaa>R16</mpaa></movie>');
  makeAudio(path.join(media, 'Music', 'A', 'B', '01 Song.mp3'), { tags: { title: 'Song', artist: 'A', album: 'B' } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  const mus = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  ids.film = (await admin.get(`/api/libraries/${lib}/items`)).data.items[0].id;
  ids.song = (await admin.get(`/api/libraries/${mus}/items?view=tracks`)).data.items[0].id;
});
after(async () => {
  await nf?.app.stop();
});

const caps = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'], hls: false };

test('routes', { skip }, async () => {
  assert.deepEqual((await admin.get(`/api/items/${ids.film}/play-settings`)).data, { audioDelay: 0, subtitleDelay: 0 });
  assert.deepEqual((await admin.put(`/api/items/${ids.film}/play-settings`, { subtitleDelay: 0.5 })).data, { audioDelay: 0, subtitleDelay: 0.5 });
  const t = await admin.put(`/api/items/${ids.song}/play-settings`, { audioDelay: 1 });
  assert.equal(t.status, 400);
  assert.equal(t.data.error, 'Delays are for films and episodes.');
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  assert.equal((await kid.get(`/api/items/${ids.film}/play-settings`)).status, 404);
});

test('a delayed file is copied, not converted, and keeps its delay from any start', { skip }, async () => {
  const plain = (await admin.post(`/api/items/${ids.film}/playback`, { caps })).data;
  assert.equal(plain.mode, 'direct', 'without a delay it plays as-is');
  await admin.post(`/api/playback/${plain.sessionId}/stop`, {});
  const d = (await admin.post(`/api/items/${ids.film}/playback`, { caps, audioDelay: 0.4 })).data;
  assert.equal(d.mode, 'remux');
  assert.equal(d.audioDelay, 0.4);
  assert.equal(d.subtitleDelay, 0.5);
  assert.ok(d.reasons.includes('Audio delay'));
  const s = nf.app.core.playback.sessions.get(d.sessionId);
  const { buildFfmpegArgs } = await import('../src/stream/playback.js');
  const args = buildFfmpegArgs(s, nf.app.core.settings.all(), { type: 'progressive' }).join(' ');
  assert.match(args, /-c:v copy/);
  assert.match(args, /-itsoffset 0\.4/);
  await admin.post(`/api/playback/${d.sessionId}/stop`, {});
  // A seek starts a new session with no delay given: the saved one is used.
  const again = (await admin.post(`/api/items/${ids.film}/playback`, { caps, start: 3 })).data;
  assert.equal(again.audioDelay, 0.4);
  assert.equal(again.mode, 'remux');
  await admin.post(`/api/playback/${again.sessionId}/stop`, {});
  assert.deepEqual((await admin.get(`/api/items/${ids.film}/play-settings`)).data, { audioDelay: 0.4, subtitleDelay: 0.5 });
});

test("a connected server's title gets no audio delay (its second input couldn't sign in)", { skip }, async () => {
  const { PlaybackManager } = await import('../src/stream/playback.js');
  const dir = tempDir();
  const config = { transcodeDir: path.join(dir, 'tc'), ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
  const settings = { all: () => ({ transcodingEnabled: true, hwAccel: 'none' }), get: () => null };
  const pm = new PlaybackManager({ db: null, config, settings, hooks: { emit() {} }, tools: () => ({ ffmpeg: { available: true, major: 7 }, filters: {} }) });
  const media = { container: 'mov,mp4,m4a,3gp,3g2,mj2', duration: 10, video: { codec: 'h264', width: 160, height: 90, bitDepth: 8, hdr: false, fps: 24 }, audio: [{ index: 0, codec: 'aac', channels: 2, default: true }], subtitles: [] };
  const item = { id: 1, kind: 'movie', title: 'x', path: 'remote:1:abc', media: JSON.stringify(media) };
  const source = { remote: true, file: 'http://127.0.0.1:9/x.mp4', headers: { 'X-Emby-Token': 'secret' } };
  const { session } = await pm.create({ user: { id: 1, username: 'd' }, profile: null, item, source, caps, start: 0, audioDelay: 0.4 });
  assert.equal(session.audioDelay, 0);
  assert.ok(!(session.reasons || []).includes('Audio delay'));
  for (const s of [...pm.sessions.values()]) pm.stop?.(s.id);
});

// ---- v0.21 tidy-up ----
test('the HLS read-ahead follows the speed (2× → 2.5)', async () => {
  const { buildFfmpegArgs } = await import('../src/stream/playback.js');
  const plan = (speed) => ({ file: '/m/a.mkv', mode: 'transcode', target: 'mp4', start: 0, tools: { ffmpeg: { major: 7 } }, speed, media: { video: { codec: 'h264', width: 640, height: 360 }, audio: [{ codec: 'aac', channels: 2 }] }, audioIndex: 0, quality: '720' });
  const rate = (speed) => buildFfmpegArgs(plan(speed), { hwAccel: 'none' }, { type: 'hls', dir: '/tmp/x' }).join(' ').match(/-readrate (\S+)/)?.[1];
  assert.equal(rate(undefined), '1.5');
  assert.equal(rate(1), '1.5');
  assert.equal(rate(2), '2.5');
  assert.equal(rate(1.5), '2');
});

test('a play-settings save with no profile chosen is 428 "Choose who is watching first."', { skip }, async () => {
  const two = (await admin.post('/api/profiles', { name: 'Second', avatar: 'blue' })).data;
  const fresh = client(nf.base);
  await fresh.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  const r = await fresh.put(`/api/items/${ids.film}/play-settings`, { audioDelay: 0.2 });
  assert.deepEqual([r.status, r.data.error], [428, 'Choose who is watching first.']);
  await admin.del(`/api/profiles/${two.id}`);
});

test("a deleted profile's play settings go with it (v0.22)", { skip }, async () => {
  const b = (await admin.post('/api/profiles', { name: 'Bea', avatar: 'teal' })).data;
  nf.app.core.playSettings.set(b.id, ids.film, { audioDelay: 0.4 });
  const count = () => nf.app.core.db.get('SELECT COUNT(*) AS n FROM play_settings WHERE profile_id = ?', b.id).n;
  assert.equal(count(), 1);
  const r = await admin.del(`/api/profiles/${b.id}`);
  assert.ok(r.status < 300, JSON.stringify(r.data));
  assert.equal(count(), 0);
});
