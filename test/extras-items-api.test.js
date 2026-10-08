// Extras through the API: the film page lists them, nothing else shows them, kids follow the owner's rating.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';

let nf, admin, kid;
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
  // A show with an extras folder at its root and a suffix file beside an episode.
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E02.mp4'));
  makeVideo(path.join(t, 'Show', 'Behind The Scenes', 'Set Tour.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01-interview.mp4'));
  // A flat TV layout: no owner, no extra.
  makeVideo(path.join(t, 'Loose.S01E01.mp4'));
  makeVideo(path.join(t, 'Loose.S01E01-trailer.mp4'));
  const mu = path.join(media, 'Music', 'The Band', 'First Record');
  makeAudio(path.join(mu, '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/2', lyrics: 'Tagged words\nSecond row' } });
  makeAudio(path.join(mu, '02 Closer.mp3'), { tags: { title: 'Closer', artist: 'The Band', album: 'First Record', track: '2/2' } });
  nf = await startAtomix({ ATOMIX_LRCLIB_BASE: 'http://127.0.0.1:1/api' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => nf?.app.stop());


const film = async (title) => (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items.find((i) => i.title === title);

test('a film page lists its extras in kind order with captions; an extra knows its parent', { skip }, async () => {
  const solo = await film('Solo');
  const page = (await admin.get(`/api/items/${solo.id}`)).data;
  assert.deepEqual(page.extras.map((e) => [e.extraKind, e.caption, e.title]), [
    ['trailer', 'Trailer', 'Solo (2020)'], ['featurette', 'Featurette', 'Making Of'], ['deleted', 'Deleted scene', 'Alt Ending'], ['other', 'Extra', 'Bloopers'],
  ]);
  const ex = (await admin.get(`/api/items/${page.extras[1].id}`)).data;
  assert.equal(ex.item.kind, 'extra');
  assert.equal(ex.item.caption, 'Featurette');
  assert.deepEqual(ex.parent, { id: solo.id, title: 'Solo', kind: 'movie' });
});

test('extras never show in the library grid, Home, search, picks, playlists or collections', { skip }, async () => {
  const grid = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items;
  assert.ok(grid.every((i) => i.kind !== 'extra'));
  const home = (await admin.get('/api/home')).data;
  assert.ok(home.rows.every((r) => r.items.every((i) => i.kind !== 'extra')));
  const search = (await admin.get('/api/search?q=Making')).data;
  assert.ok(!JSON.stringify(search).includes('Making Of'));
  const solo = await film('Solo');
  const extraId = (await admin.get(`/api/items/${solo.id}`)).data.extras[0].id;
  const list = (await admin.post('/api/lists', { kind: 'video', name: 'X' })).data;
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: extraId })).status, 400);
  const col = (await admin.post('/api/collections', { name: 'C', itemIds: [extraId, solo.id] })).data;
  assert.deepEqual((await admin.get(`/api/collections/${col.id}?all=1`)).data.items.map((i) => i.id), [solo.id]);
});

test("a kid can't reach a hidden film's extras, by page or by playback; an extra has no Up next", { skip }, async () => {
  const solo = await film('Solo');
  const extraId = (await admin.get(`/api/items/${solo.id}`)).data.extras[0].id;
  assert.equal((await kid.get(`/api/items/${extraId}`)).status, 404);
  assert.equal((await kid.post(`/api/items/${extraId}/playback`, {})).status, 404);
  const play = (await admin.post(`/api/items/${extraId}/playback`, {})).data;
  assert.equal(play.next, null, 'no Up next after an extra');
  assert.ok(play.sessionId);
  assert.equal((await admin.post(`/api/items/${extraId}/progress`, { position: 2, duration: 4, sessionId: play.sessionId })).status, 200);
});

test("lyrics: from the song's tags, 204 when there are none, 404 for a kid who can't see the library", { skip }, async () => {
  const tracks = (await admin.get(`/api/libraries/${ids.music}/items?view=tracks`)).data.items;
  const opening = tracks.find((t) => t.title === 'Opening');
  const closer = tracks.find((t) => t.title === 'Closer');
  const r = (await admin.get(`/api/items/${opening.id}/lyrics`)).data;
  assert.deepEqual([r.source, r.synced, r.lines.map((l) => l.text)], ['tags', false, ['Tagged words', 'Second row']]);
  assert.equal((await admin.get(`/api/items/${closer.id}/lyrics`)).status, 204, 'LRCLIB unreachable in this test: no lyrics');
  const me = (await kid.get('/api/me')).data.profile;
  await admin.patch(`/api/profiles/${me.id}`, { libraries: [ids.movies] });
  assert.equal((await kid.get(`/api/items/${opening.id}/lyrics`)).status, 404);
});

test("watching a show's extra does not knock the show out of Next up", { skip }, async () => {
  const show = (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items.find((i) => i.title === 'Show');
  const page = (await admin.get(`/api/items/${show.id}`)).data;
  const eps = (await admin.get(`/api/items/${page.seasons[0].id}/children`)).data;
  await admin.post(`/api/items/${eps[0].id}/progress`, { position: 4, duration: 4 });
  const extra = page.extras[0];
  await admin.post(`/api/items/${extra.id}/progress`, { position: 4, duration: 4 });
  const home = (await admin.get('/api/home')).data;
  const cont = home.rows.find((r) => r.id === 'continue' || /continue/i.test(r.title));
  assert.ok(cont && cont.items.some((i) => i.id === eps[1].id), `S01E02 should be next up in Continue watching: ${JSON.stringify(cont?.items.map((i) => i.title))}`);
});

test('songs probed before 0.10 get their embedded lyrics once', { skip }, async () => {
  const core = nf.app.core;
  const tracks = (await admin.get(`/api/libraries/${ids.music}/items?view=tracks`)).data.items;
  const opening = tracks.find((t) => t.title === 'Opening');
  // The pre-0.10 shape: a probe with tags but no lyrics key at all.
  const media = JSON.parse(core.db.get('SELECT media FROM items WHERE id = ?', opening.id).media);
  delete media.tags.lyrics;
  delete media.tags.lyricsChecked;
  core.db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), opening.id);
  core.db.run('DELETE FROM lyrics WHERE item_id = ?', opening.id);
  assert.equal(core.extras.pendingCounts().lyrics, 1);
  // Intros and previews go first; with those switched off the song is next.
  core.settings.set({ introDetection: false, previewsEnabled: false });
  const task = core.tasks.next();
  core.settings.set({ introDetection: true, previewsEnabled: true });
  assert.equal(task?.job, 'lyrics', JSON.stringify(task));
  assert.equal(task.itemId, opening.id);
  await core.tasks.runTask(task);
  const after = JSON.parse(core.db.get('SELECT media FROM items WHERE id = ?', opening.id).media);
  assert.equal(after.tags.lyrics, 'Tagged words\nSecond row');
  assert.equal(after.tags.lyricsChecked, true);
  assert.equal(core.extras.pendingCounts().lyrics, 0);
  core.settings.set({ introDetection: false, previewsEnabled: false });
  assert.equal(core.tasks.next(), null, 'read once');
  core.settings.set({ introDetection: true, previewsEnabled: true });
});

test("a re-tagged song's stored \"no lyrics\" is retried", { skip }, async () => {
  const core = nf.app.core;
  const tracks = (await admin.get(`/api/libraries/${ids.music}/items?view=tracks`)).data.items;
  const closer = tracks.find((t) => t.title === 'Closer');
  core.db.run("INSERT INTO lyrics (item_id, source, synced, text, fetched_at) VALUES (?, 'none', 0, NULL, ?) ON CONFLICT(item_id) DO UPDATE SET source = 'none', text = NULL", closer.id, Date.now());
  const file = core.db.get('SELECT path FROM items WHERE id = ?', closer.id).path;
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  await admin.post(`/api/libraries/${ids.music}/scan`, {});
  await waitForScan(admin);
  assert.equal(core.db.get('SELECT COUNT(*) AS n FROM lyrics WHERE item_id = ?', closer.id).n, 0, 'the stored "none" is gone');
});
