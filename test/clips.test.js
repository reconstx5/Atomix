// Card motion v2: a 5-second silent preview clip per film/episode, made in the background, served with Range.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { clipArgs, clipStart } from '../src/extras/clips.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

test('clipArgs: 5 s, 640 px, H.264 Main, yuv420p, no audio, faststart', () => {
  const a = clipArgs({ file: '/m/f.mkv', start: 7, duration: 5, width: 640, out: '/o/clip.mp4' });
  const s = a.join(' ');
  assert.ok(s.includes('-ss 7 -i /m/f.mkv -t 5 -an -vf scale=640:-2,format=yuv420p -c:v libx264 -profile:v main -movflags +faststart'), s);
  assert.equal(a.at(-1), '/o/clip.mp4');
  const hdr = clipArgs({ file: '/m/f.mkv', start: 7, hdrFilter: 'zscale' }).join(' ');
  assert.match(hdr, /scale=640:-2,zscale=t=linear/);
  assert.match(hdr, /format=yuv420p -c:v libx264/);
});

test('clipStart: 35 % in, after an intro or recap when that is later, trailers 15 %', () => {
  const none = { intro: null, recap: null, credits: null };
  assert.equal(clipStart({ duration: 100 }, none, false), 35);
  assert.equal(clipStart({ duration: 100 }, { ...none, intro: { start: 30, end: 50 } }, false), 51, 'just after the intro');
  assert.equal(clipStart({ duration: 100 }, { ...none, recap: { start: 0, end: 60 } }, false), 61, 'or the recap');
  assert.equal(clipStart({ duration: 100 }, { ...none, intro: { start: 0, end: 20 } }, false), 35, 'an earlier marker changes nothing');
  assert.equal(clipStart({ duration: 100 }, { ...none, intro: { start: 80, end: 98 } }, false), 35, 'too close to the end');
  assert.equal(clipStart({ duration: 100 }, { ...none, intro: { start: 0, end: 60 } }, true), 15, 'a trailer ignores markers');
  assert.equal(clipStart({ duration: 4 }, none, false), 0, 'a very short file starts at the beginning');
});

let nf, admin, kid, core;
const media = tempDir();
const m = path.join(media, 'Movies');
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  makeVideo(path.join(m, 'Plain (2020)', 'Plain (2020).mp4'), { seconds: 20 });
  makeVideo(path.join(m, 'Trailered (2021)', 'Trailered (2021).mp4'), { seconds: 20 });
  makeVideo(path.join(m, 'Trailered (2021)', 'Trailered (2021)-trailer.mp4'), { seconds: 20 });
  makeVideo(path.join(m, 'Adult (2019)', 'Adult (2019).mp4'), { seconds: 20 });
  fs.writeFileSync(path.join(m, 'Adult (2019)', 'Adult (2019).nfo'), '<movie><title>Adult</title><mpaa>R18</mpaa></movie>');
  nf = await startAtomix();
  core = nf.app.core;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  await waitForScan(admin);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => nf?.app.stop());

const row = (title) => core.db.get('SELECT * FROM items WHERE kind = ? AND title = ?', 'movie', title);
const probeClip = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());

test('a remote title is never picked, and nothing is picked with the switch off', { skip }, () => {
  const plain = row('Plain');
  core.db.run("UPDATE items SET path = 'remote:1/x' WHERE id = ?", plain.id);
  assert.notEqual(core.extras.nextClipItem()?.id, plain.id);
  core.db.run('UPDATE items SET path = ? WHERE id = ?', plain.path, plain.id);
  assert.ok(core.extras.nextClipItem(), 'local films are waiting');
  core.settings.set({ cardClips: false });
  assert.notEqual(core.tasks.next()?.job, 'clip', 'switched off');
  core.settings.set({ cardClips: true });
  const t = core.tasks.next();
  assert.ok(['previews', 'clip'].includes(t.job));
  assert.ok(core.extras.pendingCounts().clips >= 3);
});

test('the job writes a silent clip under 5.5 s and at most 640 px wide; the manifest says so', { skip }, async () => {
  const plain = row('Plain');
  await core.tasks.jobs.previews(plain, {});
  await core.tasks.jobs.clip(plain, {});
  const file = path.join(core.config.previewsDir, String(plain.id), 'clip.mp4');
  const info = probeClip(file);
  assert.ok(Number(info.format.duration) <= 5.5 && Number(info.format.duration) > 3, info.format.duration);
  assert.deepEqual(info.streams.map((s) => s.codec_type), ['video'], 'no audio');
  assert.ok(info.streams[0].width <= 640);
  assert.equal(info.streams[0].codec_name, 'h264');
  assert.equal((await admin.get(`/api/items/${plain.id}/previews`)).data.clip, true);
  assert.notEqual(core.extras.nextClipItem()?.id, plain.id, 'made once');
});

test('the clip is served as video/mp4 with Range, cached a day', { skip }, async () => {
  const plain = row('Plain');
  const full = await admin.raw(`/api/items/${plain.id}/clip`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.match(full.headers.get('cache-control'), /private, max-age=86400/);
  await full.arrayBuffer();
  const part = await admin.raw(`/api/items/${plain.id}/clip`, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  await part.arrayBuffer();
});

test('no clip yet: manifest false, route 404 with a plain sentence', { skip }, async () => {
  const adult = row('Adult');
  await core.tasks.jobs.previews(adult, {});
  assert.equal((await admin.get(`/api/items/${adult.id}/previews`)).data.clip, false);
  const r = await admin.get(`/api/items/${adult.id}/clip`);
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'No preview clip for this title.');
});

test('a Kids profile gets the same answer as for the film itself', { skip }, async () => {
  const adult = row('Adult');
  await core.tasks.jobs.clip(adult, {});
  assert.equal((await admin.get(`/api/items/${adult.id}/clip`)).status, 200);
  assert.equal((await kid.get(`/api/items/${adult.id}`)).status, 404);
  assert.equal((await kid.get(`/api/items/${adult.id}/clip`)).status, 404);
});

test('a local trailer is used instead of the film', { skip }, async () => {
  const film = row('Trailered');
  const trailer = core.db.get("SELECT * FROM items WHERE kind = 'extra' AND extra_kind = 'trailer' AND parent_id = ?", film.id);
  assert.ok(trailer);
  await core.tasks.jobs.clip(film, {});
  const j = core.db.get("SELECT data FROM media_jobs WHERE item_id = ? AND job = 'clip'", film.id);
  assert.equal(JSON.parse(j.data).source, 'trailer');
  assert.equal(JSON.parse(j.data).start, 3, '15 % of 20 s');
});

test('a changed file (mtime) is redone', { skip }, async () => {
  const plain = row('Plain');
  assert.notEqual(core.extras.nextClipItem()?.id, plain.id);
  core.db.run('UPDATE items SET mtime = mtime + 1000 WHERE id = ?', plain.id);
  assert.equal(core.extras.nextClipItem([plain.id])?.id, plain.id);
  assert.equal((await admin.get(`/api/items/${plain.id}/previews`)).status, 404, 'previews are stale too');
});

test('an HDR film with no tone-map filter gets no clip (marked none, not retried)', { skip }, async () => {
  const film = row('Adult');
  core.db.run('UPDATE items SET mtime = mtime + 5 WHERE id = ?', film.id);
  const fresh = core.db.get('SELECT * FROM items WHERE id = ?', film.id);
  const media2 = JSON.parse(fresh.media);
  media2.video.hdr = true;
  core.db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media2), film.id);
  const jobs = (await import('../src/extras/jobs.js')).makeJobs({ store: core.extras, config: core.config, tools: () => ({ filters: {} }), settings: core.settings });
  await jobs.clip(core.db.get('SELECT * FROM items WHERE id = ?', film.id), {});
  assert.equal(core.db.get("SELECT status FROM media_jobs WHERE item_id = ? AND job = 'clip'", film.id).status, 'none');
  assert.notEqual(core.extras.nextClipItem([film.id])?.id, film.id);
});

test('the profile pref cardPreviews round-trips', { skip }, async () => {
  const r = await admin.patch('/api/me', { prefs: { cardPreviews: false } });
  assert.equal(r.data.profile.prefs.cardPreviews, false);
  assert.equal((await admin.get('/api/me')).data.profile.prefs.cardPreviews, false);
  const back = await admin.patch('/api/me', { prefs: { cardPreviews: null } });
  assert.equal(back.data.profile.prefs.cardPreviews, undefined, 'unset means on');
});
