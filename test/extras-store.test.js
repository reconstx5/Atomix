// The background jobs' bookkeeping: which titles still need previews or an intro
// check, and the intro/credits markers with their "who wins" rules.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ExtrasStore } from '../src/extras/store.js';

let db;
let store;
const now = Date.now();
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
let seq = 0;

function addLibrary(type, options = '{}') {
  return Number(db.run('INSERT INTO libraries (name, type, paths, options, created_at) VALUES (?, ?, ?, ?, ?)', type, type, '[]', options, now).lastInsertRowid);
}
function addItem(fields) {
  const f = { title: 'x', path: `/media/${++seq}`, size: 100, mtime: 1, duration: 600, media: VIDEO, ...fields };
  const cols = Object.keys(f);
  const sql = `INSERT INTO items (${cols.join(', ')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`;
  return Number(db.run(sql, ...Object.values(f), now, now).lastInsertRowid);
}
const row = (id) => db.get('SELECT * FROM items WHERE id = ?', id);

before(() => {
  db = openDatabase(path.join(tempDir(), 'test.db'));
  store = new ExtrasStore(db);
});

test('migration 6 upgrades a version 5 database', () => {
  const file = path.join(tempDir(), 'old.db');
  const old = openDatabase(file, { upTo: 5 });
  old.run('INSERT INTO libraries (name, type, paths, created_at) VALUES (?, ?, ?, ?)', 'Films', 'movies', '[]', now);
  old.close();
  const upgraded = openDatabase(file);
  assert.equal(upgraded.get('PRAGMA user_version').user_version, 6);
  assert.equal(upgraded.get('SELECT options FROM libraries').options, '{}');
  const tables = upgraded.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  assert.ok(tables.includes('media_jobs') && tables.includes('markers'));
  upgraded.close();
});

test('previews are wanted for new or changed videos only', () => {
  const movies = addLibrary('movies');
  const skipped = addLibrary('movies', '{"previews":false}');
  const music = addLibrary('music');
  const film = addItem({ library_id: movies, kind: 'movie', title: 'Film' });
  addItem({ library_id: movies, kind: 'movie', title: 'Sound only', media: JSON.stringify({ video: null, audio: [{ index: 0 }] }) });
  addItem({ library_id: movies, kind: 'movie', title: 'Not probed yet', duration: null, media: null });
  addItem({ library_id: skipped, kind: 'movie', title: 'Opted out' });
  addItem({ library_id: music, kind: 'track', title: 'Song' });

  assert.equal(store.nextPreviewItem().id, film);
  assert.ok(store.saveJob(row(film), 'previews', { status: 'done', data: { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 60, sheets: 1 } }));
  assert.equal(store.nextPreviewItem(), null, 'audio-only, unprobed, opted-out and music never qualify');
  assert.deepEqual(store.pendingCounts().previews, 0);

  const manifest = store.previewManifest(row(film));
  assert.equal(manifest.sheets, 1);
  assert.match(manifest.url, new RegExp(`^/api/items/${film}/previews/\\{n\\}\\?v=\\d+$`));
  assert.deepEqual(store.previewIds(), new Set([film]));

  db.run('UPDATE items SET size = 200 WHERE id = ?', film); // the file was replaced
  assert.equal(store.previewManifest(row(film)), null, 'old previews are not shown for a new file');
  assert.equal(store.nextPreviewItem().id, film, 'and it is queued again');
  store.saveJob(row(film), 'previews', { status: 'done', data: { sheets: 1 } });
});

test('new titles can be picked before the backlog', () => {
  const lib = addLibrary('movies');
  const older = addItem({ library_id: lib, kind: 'movie' });
  const newer = addItem({ library_id: lib, kind: 'movie' });
  assert.equal(store.nextPreviewItem([newer]).id, newer);
  assert.equal(store.nextPreviewItem().id, older, 'the backlog goes oldest first');
  store.saveJob(row(older), 'previews', { status: 'done', data: { sheets: 1 } });
  store.saveJob(row(newer), 'previews', { status: 'done', data: { sheets: 1 } });
});

test('failed jobs wait for a changed file or a retry', () => {
  const lib = addLibrary('movies');
  const bad = addItem({ library_id: lib, kind: 'movie', title: 'Broken' });
  store.saveJob(row(bad), 'previews', { status: 'failed', error: 'moov atom not found' });
  assert.equal(store.nextPreviewItem(), null);
  assert.deepEqual(store.failed().map((f) => [f.itemId, f.job, f.error, f.title]), [[bad, 'previews', 'moov atom not found', 'Broken']]);
  assert.equal(store.retryFailed(), 1);
  assert.equal(store.nextPreviewItem().id, bad);
  store.saveJob(row(bad), 'previews', { status: 'done', data: { sheets: 1 } });
});

test('intro checks go a season at a time, and a new episode reopens "none"', () => {
  const tv = addLibrary('tv');
  const show = addItem({ library_id: tv, kind: 'show', title: 'Demo Show', duration: null, media: null });
  const s1 = addItem({ library_id: tv, kind: 'season', title: 'Season 1', parent_id: show, show_id: show, season: 1, duration: null, media: null });
  const s2 = addItem({ library_id: tv, kind: 'season', title: 'Season 2', parent_id: show, show_id: show, season: 2, duration: null, media: null });
  const e1 = addItem({ library_id: tv, kind: 'episode', title: 'Pilot', parent_id: s1, show_id: show, season: 1, episode: 1 });
  const e2 = addItem({ library_id: tv, kind: 'episode', title: 'Two', parent_id: s1, show_id: show, season: 1, episode: 2 });
  const e3 = addItem({ library_id: tv, kind: 'episode', title: 'Three', parent_id: s2, show_id: show, season: 2, episode: 1 });

  assert.equal(store.nextIntroSeason(), s1);
  assert.deepEqual(store.pendingIntroEpisodes(s1).map((e) => e.id), [e1, e2]);
  assert.deepEqual(store.seasonEpisodes(s1).map((e) => e.id), [e1, e2]);
  assert.equal(store.otherSeasonEpisode(s1).id, e3);
  assert.equal(store.seasonLabel(s1), 'Demo Show season 1');
  assert.equal(store.itemLabel(row(e2)), 'Demo Show S01E02');
  assert.equal(store.nextIntroSeason([e3]), s2, 'new episodes first');

  store.saveJob(row(e1), 'intros', { status: 'none' });
  store.saveJob(row(e2), 'intros', { status: 'done' });
  store.saveJob(row(e3), 'intros', { status: 'done' });
  assert.equal(store.nextIntroSeason(), null);
  assert.equal(store.pendingCounts().intros, 0);
  store.resetSeasonNone(s1);
  assert.deepEqual(store.pendingIntroEpisodes(s1).map((e) => e.id), [e1]);
  store.clearIntroJobs(s1);
  assert.deepEqual(store.pendingIntroEpisodes(s1).map((e) => e.id), [e1, e2]);
});

test('markers: set by hand beats chapters beats audio, and "no intro" sticks', () => {
  const tv = addLibrary('tv');
  const ep = addItem({ library_id: tv, kind: 'episode', title: 'Ep' });
  assert.equal(store.setMarker(ep, 'intro', { start: 10.123, end: 40, source: 'audio' }), true);
  assert.deepEqual(store.markers(ep).intro, { start: 10.12, end: 40, source: 'audio' });
  assert.equal(store.setMarker(ep, 'intro', { start: 5, end: 20, source: 'chapter' }), true);
  assert.equal(store.setMarker(ep, 'intro', { start: 11, end: 41, source: 'audio' }), false);
  assert.equal(store.setMarker(ep, 'intro', { start: null, end: null, source: 'manual' }), true);
  assert.equal(store.setMarker(ep, 'intro', { start: 5, end: 20, source: 'chapter' }), false);
  assert.deepEqual(store.markers(ep).intro, { none: true, source: 'manual' });
  assert.deepEqual(store.playbackMarkers(ep), { intro: null, credits: null });

  store.setMarker(ep, 'credits', { start: 1300, end: 1390, source: 'chapter' });
  assert.deepEqual(store.playbackMarkers(ep).credits, { start: 1300, end: 1390 });

  store.deleteMarker(ep, 'intro', { sources: ['audio'] });
  assert.equal(store.markers(ep).intro.none, true, 'only audio markers were asked to go');
  store.deleteMarker(ep, 'intro');
  assert.equal(store.markers(ep).intro, null);
});

test('results for a title that was removed mid-job are ignored', () => {
  const lib = addLibrary('movies');
  const id = addItem({ library_id: lib, kind: 'movie' });
  const item = row(id);
  db.run('DELETE FROM items WHERE id = ?', id);
  assert.equal(store.saveJob(item, 'previews', { status: 'done', data: { sheets: 1 } }), false);
  assert.equal(store.setMarker(id, 'intro', { start: 1, end: 20, source: 'audio' }), false);
});
