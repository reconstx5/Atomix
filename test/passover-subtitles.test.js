// v0.15.0: embedded-subtitle extraction is validated, de-duplicated and capped, and runs as a background job.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf, admin, dir, film, spawnLog;

before(async () => {
  if (!hasFfmpeg) return;
  dir = tempDir();
  const plain = path.join(dir, 'plain.mp4');
  makeVideo(plain, { seconds: 3 });
  fs.writeFileSync(path.join(dir, 'subs.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nThere\n');
  fs.writeFileSync(path.join(dir, 'subs2.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHallo\n');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', plain, '-i', path.join(dir, 'subs.srt'), '-i', path.join(dir, 'subs2.srt'), '-map', '0', '-map', '1', '-map', '2', '-c', 'copy', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=ger', path.join(dir, 'Film (2020).mkv')]);
  fs.rmSync(plain);
  fs.rmSync(path.join(dir, 'subs.srt'));
  fs.rmSync(path.join(dir, 'subs2.srt'));
  // ffmpeg behind a counting shim
  spawnLog = path.join(dir, 'spawns.log');
  const shim = path.join(dir, 'ffmpeg-shim.sh');
  fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${spawnLog}"\nexec ffmpeg "$@"\n`);
  fs.chmodSync(shim, 0o755);
  nf = await startAtomix({ ATOMIX_FFMPEG: shim });
  await nf.app.core.tasks.stop(); // the background runner would extract the subtitles before the tests look
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.put('/api/admin/settings', { previewsEnabled: false, introDetection: false });
  await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [dir] });
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const lib = (await admin.get('/api/libraries')).data.find((l) => l.name === 'Films');
  film = (await admin.get(`/api/libraries/${lib.id}/items`)).data.items[0];
  assert.ok(film, 'the film scanned');
});

after(async () => { await nf?.app.stop(); });

const spawns = () => (fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').split('\n').filter((l) => /webvtt/.test(l)) : []);

test('e<N>.vtt 404s for an index the probe does not list', { skip }, async () => {
  const r = await admin.get(`/api/items/${film.id}/subtitles/e99.vtt`);
  assert.equal(r.status, 404);
  assert.equal(spawns().length, 0, 'no ffmpeg ran for it');
});

test('two concurrent requests for the same embedded track run one ffmpeg', { skip }, async () => {
  const subs = (await admin.get(`/api/items/${film.id}/subtitles`)).data.filter((s) => s.source === 'embedded' && s.kind === 'text');
  assert.equal(subs.length, 2);
  const before = spawns().length;
  const [a, b] = await Promise.all([admin.raw(subs[0].url), admin.raw(subs[0].url)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.match(await a.text(), /Hello/);
  assert.equal(spawns().length - before, 1);
});

test('extraction over the transcode cap answers 503 with the busy sentence', { skip }, async () => {
  const subs = (await admin.get(`/api/items/${film.id}/subtitles`)).data.filter((s) => s.source === 'embedded' && s.kind === 'text');
  await admin.put('/api/admin/settings', { maxTranscodes: 1 });
  const pb = nf.app.core.playback;
  pb.sessions.set('fake', { id: 'fake', proc: { killed: false }, mode: 'remux' });
  try {
    const r = await admin.raw(subs[1].url);
    assert.equal(r.status, 503);
    assert.match(await r.text(), /Busy converting other songs or videos; try again in a moment\./);
  } finally {
    pb.sessions.delete('fake');
    await admin.put('/api/admin/settings', { maxTranscodes: 3 });
  }
});

test('the subtitles job extracts every text track and marks the title; the runner picks it after lyrics', { skip }, async () => {
  const runner = nf.app.core.tasks;
  const store = runner.store;
  assert.equal(store.pendingCounts().subtitles, 1, 'one title waiting');
  nf.app.core.settings.set({ cardClips: false }); // a clip would come first otherwise (test/clips.test.js)
  const task = runner.next();
  assert.equal(task?.job, 'subtitles');
  assert.equal(task.itemId, film.id);
  await runner.jobs.subtitles(task.item, { signal: null });
  assert.equal(store.pendingCounts().subtitles, 0);
  const media = JSON.parse(nf.app.core.db.get('SELECT media FROM items WHERE id = ?', film.id).media);
  assert.equal(media.subtitlesExtracted, true);
  const cached = fs.readdirSync(path.join(nf.app.core.config.cacheDir, 'subs')).filter((f) => f.startsWith(`${film.id}-`));
  assert.equal(cached.length, 2);
  const q = runner.status().queued;
  assert.deepEqual(Object.keys(q).sort(), ['clips', 'intros', 'loudness', 'lyrics', 'previews', 'subtitles', 'thumbs']);
  assert.equal(q.subtitles, 0);
});

test('the runner does not idle while subtitles are pending even with previews and intros off', { skip }, async () => {
  const runner = nf.app.core.tasks;
  nf.app.core.db.run("UPDATE items SET media = json_remove(media, '$.subtitlesExtracted') WHERE id = ?", film.id);
  assert.equal(runner.store.pendingCounts().subtitles, 1);
  assert.equal(runner.shouldIdle(), false);
  nf.app.core.db.run("UPDATE items SET media = json_set(media, '$.subtitlesExtracted', json('true')) WHERE id = ?", film.id);
  assert.equal(runner.shouldIdle(), true);
});

test('capacity counts every live ffmpeg, and a user may hold four streams', { skip }, async () => {
  const pb = nf.app.core.playback;
  await admin.put('/api/admin/settings', { maxTranscodes: 1 });
  pb.sessions.set('fake', { id: 'fake', proc: { killed: false }, mode: 'remux', userId: 999 });
  try {
    assert.throws(() => pb.checkCapacity({ mode: 'remux' }), /already converting/);
    assert.doesNotThrow(() => pb.checkCapacity({ mode: 'direct' }));
  } finally {
    pb.sessions.delete('fake');
    await admin.put('/api/admin/settings', { maxTranscodes: 3 });
  }
  const opened = [];
  for (let i = 0; i < 4; i++) {
    const r = await admin.post(`/api/items/${film.id}/playback`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    opened.push(r.data.id);
  }
  const fifth = await admin.post(`/api/items/${film.id}/playback`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } });
  assert.equal(fifth.status, 429);
  assert.equal(fifth.data.error, 'Too many streams open on this account.');
  for (const id of opened) await admin.del(`/api/playback/${id}`);
});
