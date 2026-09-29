// Intro finding: chapter names, who is compared with whom, and a real season with
// a shared theme tune (AAC vs a quieter, muffled MP3), a chapter-marked episode and
// a clip too short to check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeEpisode } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ExtrasStore } from '../src/extras/store.js';
import { markersFromChapters, partnersFor, searchWindow, runIntroJob } from '../src/extras/intros.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

function seasonDb(files, durations = {}) {
  const db = openDatabase(path.join(tempDir(), 't.db'));
  const t = Date.now();
  const lib = Number(db.run("INSERT INTO libraries (name, type, paths, created_at) VALUES ('TV', 'tv', '[]', ?)", t).lastInsertRowid);
  const add = (f) => {
    const cols = Object.keys(f);
    return Number(db.run(`INSERT INTO items (${cols.join(', ')}, library_id, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`, ...Object.values(f), lib, t, t).lastInsertRowid);
  };
  const show = add({ kind: 'show', title: 'Theme Show', path: '/tv/Theme Show' });
  const season = add({ kind: 'season', title: 'Season 1', parent_id: show, show_id: show, season: 1 });
  const media = JSON.stringify({ video: { width: 160, height: 90 }, audio: [{ index: 0 }] });
  const ids = {};
  Object.entries(files).forEach(([key, file], i) => {
    ids[key] = add({ kind: 'episode', title: key, parent_id: season, show_id: show, season: 1, episode: i + 1, path: file, size: 1, mtime: 1, duration: durations[key] ?? 100, media });
  });
  return { db, store: new ExtrasStore(db), season, ids };
}

test('intro and credits chapters are recognised by name', () => {
  const ch = (start, end, title) => ({ start_time: String(start), end_time: String(end), tags: title == null ? {} : { title } });
  assert.deepEqual(markersFromChapters([ch(0, 5, 'Recap'), ch(5, 20, ' OPENING '), ch(20, 50, 'Chapter 2'), ch(50, 60, 'End Credits')]), { intro: { start: 5, end: 20 }, credits: { start: 50, end: 60 } });
  assert.deepEqual(markersFromChapters([ch(0, 30, 'Intro Song'), ch(30, 30, 'Intro'), ch(40, 60, null)]), { intro: null, credits: null }, 'near misses and empty chapters are ignored');
  assert.deepEqual(markersFromChapters(undefined), { intro: null, credits: null });
});

test('each episode is compared with the next, the one after, the previous, then another season', () => {
  const eps = [1, 2, 3, 4, 5].map((id) => ({ id }));
  assert.deepEqual(partnersFor(eps[2], eps, { id: 99 }).map((e) => e.id), [4, 5, 2, 99]);
  assert.deepEqual(partnersFor(eps[4], eps, { id: 99 }).map((e) => e.id), [4, 99]);
  assert.deepEqual(partnersFor(eps[0], [eps[0]], null), []);
});

test('only the start of an episode is searched', () => {
  assert.equal(searchWindow(100), 40);
  assert.equal(searchWindow(3600), 600);
});

test('a real season: shared theme, chapters, and a clip too short to check', { skip }, async () => {
  const dir = tempDir();
  const files = {
    e1: path.join(dir, "Theme Show - S01E01 - Kia ora, Whānau.mp4"),
    e2: path.join(dir, 'Theme Show - S01E02.mkv'),
    e3: path.join(dir, 'Theme Show - S01E03.mkv'),
    e4: path.join(dir, 'Theme Show - S01E04.mp4'),
  };
  makeEpisode(files.e1, { themeAt: 6, seed: 1 });
  makeEpisode(files.e2, { themeAt: 17, seed: 3, audioCodec: 'mp3', gain: 0.5, lowpass: 3000 });
  makeEpisode(files.e3, { seed: 5, chapters: [[0, 5, 'Recap'], [5, 20, 'Opening'], [20, 80, 'Part 1'], [80, 100, 'End Credits']] });
  makeEpisode(files.e4, { seconds: 30, seed: 7 });
  const { db, store, season, ids } = seasonDb(files, { e4: 30 });

  await runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal });

  const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 0.5, `${what}: ${actual} is not within 0.5 s of ${expected}`);
  const m1 = store.markers(ids.e1).intro;
  const m2 = store.markers(ids.e2).intro;
  assert.equal(m1.source, 'audio');
  near(m1.start, 6, 'E01 start');
  near(m1.end, 26, 'E01 end');
  near(m2.start, 17, 'E02 start');
  near(m2.end, 37, 'E02 end');
  assert.deepEqual(store.markers(ids.e3), { intro: { start: 5, end: 20, source: 'chapter' }, credits: { start: 80, end: 100, source: 'chapter' } });
  assert.equal(store.markers(ids.e4).intro, null);
  assert.deepEqual(['e1', 'e2', 'e3', 'e4'].map((k) => store.job(ids[k], 'intros').status), ['done', 'done', 'done', 'none']);
  db.close();
});

test('a stopped job records nothing', async () => {
  const { db, store, season, ids } = seasonDb({ e1: '/nowhere/e1.mp4' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.job(ids.e1, 'intros'), null);
  db.close();
});

test('an unreadable episode is marked failed, not "no intro"', { skip }, async () => {
  const { db, store, season, ids } = seasonDb({ e1: path.join(tempDir(), 'missing.mp4') });
  await runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal });
  const job = store.job(ids.e1, 'intros');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /ffmpeg exited/);
  db.close();
});

test('a replaced file loses its old automatic markers, but keeps hand-set ones', { skip }, async () => {
  const file = path.join(tempDir(), 'Theme Show - S01E01.mkv');
  makeEpisode(file, { seed: 21, chapters: [[0, 5, 'Recap'], [5, 20, 'Opening'], [20, 80, 'Part 1'], [80, 100, 'End Credits']] });
  const { db, store, season, ids } = seasonDb({ e1: file });
  const run = () => runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal });
  await run();
  assert.equal(store.markers(ids.e1).credits.source, 'chapter');

  // An in-place upgrade (e.g. Sonarr): same file name, different file, no chapters.
  makeEpisode(file, { seed: 22 });
  db.run('UPDATE items SET size = 2, mtime = 2 WHERE id = ?', ids.e1);
  await run();
  assert.deepEqual(store.markers(ids.e1), { intro: null, credits: null }, 'no Skip button or early Up next from the old file');

  // Times an admin set by hand are theirs to change.
  store.setMarker(ids.e1, 'intro', { start: 1, end: 30, source: 'manual' });
  db.run('UPDATE items SET size = 3, mtime = 3 WHERE id = ?', ids.e1);
  await run();
  assert.deepEqual(store.markers(ids.e1).intro, { start: 1, end: 30, source: 'manual' });
  db.close();
});
