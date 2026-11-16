// Skipping more (v0.28): recaps and credits, not just intros. Chapters named "Recap"/"Previously on…", the ending
// theme a season shares (the same audio matching as intros, at the other end), and TheIntroDB's shared timestamps
// for what the files can't tell. The player offers "Skip recap" like "Skip intro"; credits bring Up next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeEpisode, fakeServer } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ExtrasStore } from '../src/extras/store.js';
import { markersFromChapters, runIntroJob, endWindow } from '../src/extras/intros.js';
import { segmentsFromIntroDb, introDbUrl } from '../src/extras/community.js';
import { skipSegment } from '../public/js/markers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const ch = (start, end, title) => ({ start_time: String(start), end_time: String(end), tags: { title } });

test('a recap chapter is found by its name', () => {
  assert.deepEqual(markersFromChapters([ch(0, 45, 'Previously on'), ch(45, 80, 'Opening'), ch(80, 600, 'Part 1'), ch(600, 640, 'Credits')]), { intro: { start: 45, end: 80 }, credits: { start: 600, end: 640 }, recap: { start: 0, end: 45 } });
  assert.equal(markersFromChapters([ch(0, 30, 'Recap')]).recap.end, 30);
});

test('the ending searched for the shared credits theme: the last quarter, at most 5 minutes', () => {
  assert.deepEqual(endWindow(100), { start: 75, length: 25 });
  assert.deepEqual(endWindow(3000), { start: 2700, length: 300 });
});

test('TheIntroDB answers in milliseconds, with nulls for "from the start" and "to the end"', () => {
  const got = segmentsFromIntroDb({ type: 'tv', intro: [{ start_ms: 60000, end_ms: 95000 }], recap: [{ start_ms: null, end_ms: 42000 }], credits: [{ start_ms: 2500000, end_ms: null }] }, 2600);
  assert.deepEqual(got, { intro: { start: 60, end: 95 }, recap: { start: 0, end: 42 }, credits: { start: 2500, end: 2600 } });
  assert.deepEqual(segmentsFromIntroDb({ type: 'tv', recap: [{ start_ms: null, end_ms: 0 }] }, 2600), { intro: null, recap: null, credits: null }, 'end 0 means there is none');
  assert.deepEqual(segmentsFromIntroDb(null, 100), { intro: null, recap: null, credits: null });
});

test('the address asked: the show by TMDB id, season and episode, and the file\'s length to pick its version', () => {
  const u = new URL(introDbUrl('https://api.theintrodb.org/v4', { tmdbId: 1399, season: 2, episode: 3, duration: 3240.5 }));
  assert.equal(u.pathname, '/v4/media');
  assert.deepEqual(Object.fromEntries(u.searchParams), { tmdb_id: '1399', season: '2', episode: '3', duration_ms: '3240500' });
});

test('the player skips the segment it is in: a recap first, then the intro', () => {
  const markers = { recap: { start: 0, end: 40 }, intro: { start: 40, end: 70 } };
  assert.deepEqual(skipSegment(markers, 10, 600), { kind: 'recap', start: 0, end: 40 });
  assert.deepEqual(skipSegment(markers, 50, 600), { kind: 'intro', start: 40, end: 70 });
  assert.equal(skipSegment(markers, 69, 600), null, 'not in the last 2 seconds');
  assert.equal(skipSegment(markers, 100, 600), null);
  assert.equal(skipSegment({}, 5, 600), null);
});

function seasonDb(files, { tmdbId = null } = {}) {
  const db = openDatabase(path.join(tempDir(), 't.db'));
  const t = Date.now();
  const lib = Number(db.run("INSERT INTO libraries (name, type, paths, created_at) VALUES ('TV', 'tv', '[]', ?)", t).lastInsertRowid);
  const add = (f) => {
    const cols = Object.keys(f);
    return Number(db.run(`INSERT INTO items (${cols.join(', ')}, library_id, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`, ...Object.values(f), lib, t, t).lastInsertRowid);
  };
  const show = add({ kind: 'show', title: 'End Show', path: '/tv/End Show', ...(tmdbId ? { tmdb_id: tmdbId } : {}) });
  const season = add({ kind: 'season', title: 'Season 1', parent_id: show, show_id: show, season: 1 });
  const media = JSON.stringify({ video: { width: 160, height: 90 }, audio: [{ index: 0 }] });
  const ids = {};
  Object.entries(files).forEach(([key, file], i) => {
    ids[key] = add({ kind: 'episode', title: key, parent_id: season, show_id: show, season: 1, episode: i + 1, path: file, size: 1, mtime: 1, duration: 100, media });
  });
  return { db, store: new ExtrasStore(db), season, ids };
}

test('a season sharing its ending theme gets credits from the audio', { skip }, async () => {
  const dir = tempDir();
  const files = { e1: path.join(dir, 'End Show - S01E01.mp4'), e2: path.join(dir, 'End Show - S01E02.mp4') };
  makeEpisode(files.e1, { themeAt: 78, seed: 1 });
  makeEpisode(files.e2, { themeAt: 76, seed: 2 });
  const { store, season, ids } = seasonDb(files);
  await runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal, community: null });
  const c1 = store.markers(ids.e1).credits;
  const c2 = store.markers(ids.e2).credits;
  assert.equal(c1?.source, 'audio', JSON.stringify(c1));
  // Within 1.5 s: Up next comes up as the ending theme starts.
  assert.ok(Math.abs(c1.start - 78) <= 1.5, `e1 credits at ${c1.start}`);
  assert.ok(Math.abs(c2.start - 76) <= 1.5, `e2 credits at ${c2.start}`);
});

test('TheIntroDB fills what the files can\'t: a recap; and is never asked when it is off', { skip }, async () => {
  const asked = [];
  const intro = await fakeServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tvdb_id: 1, type: 'tv', recap: [{ start_ms: null, end_ms: 12000 }], credits: [{ start_ms: 90000, end_ms: null }] }));
  });
  try {
    const dir = tempDir();
    const files = { e1: path.join(dir, 'Show - S01E01.mp4') };
    makeEpisode(files.e1, { seconds: 100, seed: 3 });
    const { store, season, ids } = seasonDb(files, { tmdbId: 4242 });
    await runIntroJob({ seasonId: season, store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal, community: null });
    assert.equal(asked.length, 0, 'off: nothing is sent');
    assert.equal(store.markers(ids.e1).recap, undefined);

    const again = seasonDb(files, { tmdbId: 4242 });
    await runIntroJob({ seasonId: again.season, store: again.store, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', signal: new AbortController().signal, community: { base: `${intro.url}/v4` } });
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^\/v4\/media\?tmdb_id=4242&season=1&episode=1&duration_ms=100000$/);
    const m = again.store.markers(again.ids.e1);
    assert.deepEqual({ ...m.recap }, { start: 0, end: 12, source: 'community' });
    assert.deepEqual({ ...m.credits }, { start: 90, end: 100, source: 'community' });
  } finally {
    await intro.close();
  }
});

test('the markers table takes recaps and shared timestamps', () => {
  const { store, ids } = seasonDb({ e1: '/x.mp4' });
  assert.equal(store.setMarker(ids.e1, 'recap', { start: 0, end: 30, source: 'community' }) !== false, true);
  assert.equal(store.markers(ids.e1).recap.source, 'community');
  store.setMarker(ids.e1, 'recap', { start: 0, end: 25, source: 'chapter' });
  assert.equal(store.markers(ids.e1).recap.end, 25, 'the file\'s own chapters win over shared timestamps');
  assert.equal(store.setMarker(ids.e1, 'recap', { start: 0, end: 50, source: 'community' }), false);
});
