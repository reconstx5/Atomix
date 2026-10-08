// Extras: Kodi-style folders and suffixes become `extra` items under their film or show; orphans are dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

let nf, admin;
const media = tempDir();
const ids = {};
const m = path.join(media, 'Movies');
const t = path.join(media, 'TV');
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  // One film per folder, with every kind of extra.
  makeVideo(path.join(m, 'Solo (2020)', 'Solo (2020).mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Solo (2020)-trailer.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Featurettes', 'Making Of.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Deleted Scenes', 'Alt Ending.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Extras', 'Bloopers.mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Featurettes', 'Nested', 'Deep.mp4')); // not an extra, not a film
  fs.writeFileSync(path.join(m, 'Solo (2020)', 'Solo (2020).nfo'), '<movie><title>Solo</title><mpaa>R16</mpaa></movie>');
  // Two films in one folder: suffix files match by stem prefix; the folder's Extras belong to nobody.
  makeVideo(path.join(m, 'Pair', 'Alpha (2001).mp4'));
  makeVideo(path.join(m, 'Pair', 'Beta (2002).mp4'));
  makeVideo(path.join(m, 'Pair', 'Alpha (2001)-featurette.mp4'));
  makeVideo(path.join(m, 'Pair', 'Extras', 'Whose.mp4'));
  // Overlapping stems: the trailer belongs to the film whose name it carries, not the shorter prefix.
  makeVideo(path.join(m, 'Toys', 'Toy Story.mp4'));
  makeVideo(path.join(m, 'Toys', 'Toy Story 2.mp4'));
  makeVideo(path.join(m, 'Toys', 'Toy Story 2-trailer.mp4'));
  makeVideo(path.join(m, 'Toys', 'Toy Story-featurette.mp4'));
  // A show with an extras folder at its root and a suffix file beside an episode.
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01.mp4'));
  makeVideo(path.join(t, 'Show', 'Behind The Scenes', 'Set Tour.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01-interview.mp4'));
  // A flat TV layout: no owner, no extra.
  makeVideo(path.join(t, 'Loose.S01E01.mp4'));
  makeVideo(path.join(t, 'Loose.S01E01-trailer.mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  await waitForScan(admin);
});
after(async () => nf?.app.stop());

const rows = (sql, ...p) => nf.app.core.db.all(sql, ...p).map((r) => ({ ...r }));

test('a film in its own folder owns every extra beside it, titled without the suffix', { skip }, () => {
  const solo = rows("SELECT * FROM items WHERE kind = 'movie' AND title = 'Solo'")[0];
  const extras = rows("SELECT extra_kind, title, min_age FROM items WHERE kind = 'extra' AND parent_id = ? ORDER BY extra_kind, title", solo.id);
  assert.deepEqual(extras, [
    { extra_kind: 'deleted', title: 'Alt Ending', min_age: 16 },
    { extra_kind: 'featurette', title: 'Making Of', min_age: 16 },
    { extra_kind: 'other', title: 'Bloopers', min_age: 16 },
    { extra_kind: 'trailer', title: 'Solo (2020)', min_age: 16 },
  ]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE title = 'Deep'")[0].n, 0, 'a file nested under an extras folder is neither a film nor an extra');
});

test('several films in one folder: suffix files match by stem, folder extras belong to nobody', { skip }, () => {
  const alpha = rows("SELECT id FROM items WHERE kind = 'movie' AND title LIKE 'Alpha%'")[0];
  assert.deepEqual(rows("SELECT title FROM items WHERE kind = 'extra' AND parent_id = ?", alpha.id), [{ title: 'Alpha (2001)' }]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE title = 'Whose'")[0].n, 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'movie'")[0].n, 5, 'Solo, Alpha, Beta, Toy Story ×2 — no extra became a film');
  const ts2 = rows("SELECT id FROM items WHERE kind = 'movie' AND title = 'Toy Story 2'")[0];
  const ts1 = rows("SELECT id FROM items WHERE kind = 'movie' AND title = 'Toy Story'")[0];
  assert.deepEqual(rows("SELECT extra_kind FROM items WHERE kind = 'extra' AND parent_id = ?", ts2.id), [{ extra_kind: 'trailer' }], 'the longer name wins');
  assert.deepEqual(rows("SELECT extra_kind FROM items WHERE kind = 'extra' AND parent_id = ?", ts1.id), [{ extra_kind: 'featurette' }]);
});

test("a show's extras belong to the show (show_id set); a flat TV layout gives no owner", { skip }, () => {
  const show = rows("SELECT id FROM items WHERE kind = 'show' AND title = 'Show'")[0];
  const ex = rows("SELECT extra_kind, title, show_id FROM items WHERE kind = 'extra' AND parent_id = ? ORDER BY title", show.id);
  assert.deepEqual(ex, [{ extra_kind: 'behindthescenes', title: 'Set Tour', show_id: show.id }, { extra_kind: 'interview', title: 'Show S01E01', show_id: show.id }]);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND title LIKE 'Loose%'")[0].n, 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'episode'")[0].n, 2);
});

test('extras are probed, and a removed extra disappears on the next scan', { skip }, async () => {
  const making = rows("SELECT * FROM items WHERE kind = 'extra' AND title = 'Making Of'")[0];
  assert.ok(making.duration > 0 && making.media, 'probed');
  fs.rmSync(path.join(m, 'Solo (2020)', 'Featurettes', 'Making Of.mp4'));
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND title = 'Making Of'")[0].n, 0);
  // A new extra is not "new content": the scan does not count or announce it.
  makeVideo(path.join(m, 'Solo (2020)', 'Featurettes', 'Later.mp4'));
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  const st = await waitForScan(admin);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND title = 'Later'")[0].n, 1);
  assert.equal(st.added, 0, 'extras are not announced as new titles');
});

test('a show left with only extras leaves the library and returns with an episode', { skip }, async () => {
  const ep = path.join(t, 'Show', 'Season 01', 'Show.S01E01.mp4');
  const keep = fs.readFileSync(ep);
  fs.rmSync(ep);
  fs.rmSync(path.join(t, 'Show', 'Season 01', 'Show.S01E01-interview.mp4'), { force: true });
  await admin.post(`/api/libraries/${ids.tv}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'show' AND title = 'Show'")[0].n, 0, 'the show is gone');
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND title = 'Set Tour'")[0].n, 0, 'and its extra with it');
  fs.writeFileSync(ep, keep);
  await admin.post(`/api/libraries/${ids.tv}/scan`, {});
  await waitForScan(admin);
  const show = rows("SELECT id FROM items WHERE kind = 'show' AND title = 'Show'")[0];
  assert.ok(show, 'the show is back');
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE kind = 'extra' AND parent_id = ?", show.id)[0].n, 1);
});
