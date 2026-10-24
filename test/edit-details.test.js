// Edit details (admins): edited fields are saved and locked, so a refresh and Fix match leave them as they are;
// Unlock hands a field back to TMDB at the next refresh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { EDITABLE } from '../src/library/editing.js';
import { certToAge } from '../src/library/ratings.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let tmdb;
let slow = 0;
let admin;
const ids = {};
const answer = {
  101: { id: 101, title: 'Online Title', original_title: 'Online Title', release_date: '2001-02-03', overview: 'TMDB plot', tagline: 'TMDB tagline', genres: [{ name: 'Drama' }] },
  202: { id: 202, title: 'Second Match', original_title: 'Second Match', release_date: '1999-09-09', overview: 'Second plot', tagline: 'Second tagline', genres: [{ name: 'Comedy' }] },
};

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Edited (2001)', 'Edited (2001).mp4'), { seconds: 2 });
  for (const [s, e] of [[1, 1], [1, 2], [2, 1]]) makeVideo(path.join(media, 'TV', 'Edit Show', `Season 0${s}`, `Edit.Show.S0${s}E0${e}.mp4`), { seconds: 2 });
  makeAudio(path.join(media, 'Music', 'Band', 'Record', '01 Song.mp3'), { tags: { title: 'Song', artist: 'Band', album: 'Record' } });
  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/3/search/movie') return send({ results: [{ id: 101, title: 'Online Title', release_date: '2001-02-03' }] });
    const m = u.pathname.match(/^\/3\/movie\/(\d+)$/);
    if (m && answer[m[1]]) return slow ? setTimeout(() => send(answer[m[1]]), slow) : send(answer[m[1]]);
    return send({ results: [] });
  });
  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, ATOMIX_TMDB_IMAGE_BASE: `${tmdb.url}/t/p`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] })).data.id;
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  ids.film = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items[0].id;
  ids.show = (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items[0].id;
  const db = nf.app.core.db;
  for (const r of db.all("SELECT id, season, episode FROM items WHERE kind = 'episode'")) ids[`s${r.season}e${r.episode}`] = r.id;
  for (const r of db.all("SELECT id, season FROM items WHERE kind = 'season'")) ids[`season${r.season}`] = r.id;
  ids.album = db.get("SELECT id FROM items WHERE kind = 'album'").id;
  ids.artist = db.get("SELECT id FROM items WHERE kind = 'artist'").id;
});
after(async () => {
  await nf?.app.stop();
  await tmdb?.close();
});

const edit = (id, body) => admin.patch(`/api/items/${id}/details`, body);
const row = (id) => nf.app.core.db.get('SELECT * FROM items WHERE id = ?', id);

test('the editable fields per kind', () => {
  assert.deepEqual(EDITABLE.movie, ['title', 'sortTitle', 'originalTitle', 'year', 'releaseDate', 'overview', 'tagline', 'genres', 'studio', 'certification']);
  assert.deepEqual(EDITABLE.show, EDITABLE.movie);
  assert.deepEqual(EDITABLE.episode, ['title', 'season', 'episode', 'airDate', 'overview']);
  assert.deepEqual(EDITABLE.album, ['title', 'albumArtist', 'year', 'genres']);
  assert.deepEqual(EDITABLE.artist, ['title', 'overview']);
});

test('edits save and lock', { skip }, async () => {
  const r = await edit(ids.film, { changes: { title: 'My Cut', overview: 'My plot', genres: 'Thriller, Noir', studio: 'Back Room' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.title, 'My Cut');
  assert.deepEqual(r.data.genres, ['Thriller', 'Noir']);
  assert.deepEqual(r.data.lockedFields.sort(), ['genres', 'overview', 'studio', 'title']);
  assert.deepEqual(JSON.parse(row(ids.film).locked_fields).sort(), ['genres', 'overview', 'studio', 'title']);
  assert.equal(row(ids.film).studio, 'Back Room');
  const d = (await admin.get(`/api/items/${ids.film}/details`)).data;
  assert.equal(d.values.studio, 'Back Room');
  assert.equal(d.values.sortTitle, 'my cut', 'a new title re-sorts it');
  assert.deepEqual(d.fields, EDITABLE.movie);
  assert.equal((await admin.get(`/api/items/${ids.film}`)).data.item.lockedFields.length, 4);
});

test('a refresh keeps locked fields and updates the rest', { skip }, async () => {
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  const it = row(ids.film);
  assert.equal(it.title, 'My Cut');
  assert.equal(it.sort_title, 'my cut');
  assert.equal(it.overview, 'My plot');
  assert.deepEqual(JSON.parse(it.genres), ['Thriller', 'Noir']);
  assert.equal(it.studio, 'Back Room');
  assert.equal(it.tagline, 'TMDB tagline', 'unlocked fields follow TMDB');
  assert.equal(it.year, 2001);
});

test('Fix match keeps locked fields', { skip }, async () => {
  const r = await admin.post(`/api/items/${ids.film}/identify`, { tmdbId: 202 });
  assert.equal(r.status, 200);
  const it = row(ids.film);
  assert.equal(it.tmdb_id, 202);
  assert.equal(it.title, 'My Cut');
  assert.equal(it.overview, 'My plot');
  assert.equal(it.tagline, 'Second tagline');
  assert.equal(it.year, 1999);
});

test('unlock → the next refresh replaces the value', { skip }, async () => {
  const r = await edit(ids.film, { unlock: ['overview'] });
  assert.equal(r.status, 200);
  assert.ok(!r.data.lockedFields.includes('overview'));
  assert.equal(row(ids.film).overview, 'My plot', 'unlocking alone changes nothing yet');
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  assert.equal(row(ids.film).overview, 'Second plot');
  assert.equal(row(ids.film).title, 'My Cut');
});

test('an age rating edit sets min_age, and Kids follow it', { skip }, async () => {
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, allowUnrated: false })).data;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  await edit(ids.film, { changes: { certification: 'G' } });
  assert.equal(row(ids.film).min_age, certToAge('G', 'NZ'));
  assert.equal((await kid.get(`/api/items/${ids.film}`)).status, 200, 'a G film is for Mia');
  await edit(ids.film, { changes: { certification: 'R16' } });
  assert.equal(row(ids.film).min_age, 16);
  assert.equal((await kid.get(`/api/items/${ids.film}`)).status, 404, 'an R16 film is not');
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  assert.equal(row(ids.film).min_age, 16, 'the locked rating survives a refresh');
  // Kids and non-admins can't edit.
  assert.equal((await kid.patch(`/api/items/${ids.film}/details`, { changes: { title: 'x' } })).status, 403);
  await admin.post('/api/users', { username: 'viewer', password: 'viewerpass123', role: 'user' });
  const user = client(nf.base);
  await user.post('/api/auth/login', { username: 'viewer', password: 'viewerpass123' });
  assert.equal((await user.patch(`/api/items/${ids.film}/details`, { changes: { title: 'x' } })).status, 403);
  assert.equal(row(ids.film).title, 'My Cut');
});

test('validation sentences name the field; nothing is saved', { skip }, async () => {
  const cases = [
    [{ year: 1700 }, 'Year must be between 1870 and 2100.'],
    [{ releaseDate: '31/05/2024' }, 'Dates are written 2024-05-31.'],
    [{ releaseDate: '2024-02-31' }, 'Dates are written 2024-05-31.'],
    [{ title: '  ' }, "Title can't be empty."],
    [{ overview: 'x'.repeat(2001) }, 'Plot can be 2000 characters at most.'],
    [{ genres: Array.from({ length: 21 }, (_, i) => `G${i}`) }, 'Up to 20 genres, each up to 40 characters.'],
    [{ genres: ['x'.repeat(41)] }, 'Up to 20 genres, each up to 40 characters.'],
    [{ season: 3 }, "Season can't be edited for this title."],
    [{ certification: 'Adults only' }, "Age rating isn't one Atomix knows. Use one like G, PG, M or R16, or an age such as 16."],
  ];
  for (const [changes, sentence] of cases) {
    const r = await edit(ids.film, { changes: { tagline: 'Should not save', ...changes } });
    assert.equal(r.status, 400, JSON.stringify(changes));
    assert.equal(r.data.error, sentence);
  }
  assert.equal((await edit(ids.s1e1, { changes: { episode: 10000 } })).data.error, 'Season and episode numbers are 0 to 9999.');
  assert.notEqual(row(ids.film).tagline, 'Should not save');
});

test("episodes: season/episode edits move it in the season's list", { skip }, async () => {
  let r = await edit(ids.s1e1, { changes: { episode: 5, title: 'Renumbered' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let eps = (await admin.get(`/api/items/${ids.season1}`)).data.episodes.map((e) => e.id);
  assert.deepEqual(eps, [ids.s1e2, ids.s1e1], 'now after episode 2');
  r = await edit(ids.s1e2, { changes: { season: 2, episode: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(row(ids.s1e2).parent_id, ids.season2);
  eps = (await admin.get(`/api/items/${ids.season2}`)).data.episodes.map((e) => e.id);
  assert.deepEqual(eps, [ids.s2e1, ids.s1e2]);
  assert.equal((await edit(ids.s1e1, { changes: { season: 7 } })).data.error, 'This show has no season 7.');
  assert.deepEqual(JSON.parse(row(ids.s1e1).locked_fields).sort(), ['episode', 'title']);
});

test('albums and artists', { skip }, async () => {
  let r = await edit(ids.album, { changes: { title: 'The Record', albumArtist: 'The Band', year: 1984, genres: ['Rock'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(row(ids.album).artist, 'The Band');
  r = await edit(ids.artist, { changes: { title: 'The Band', overview: 'From somewhere.' } });
  assert.equal(r.status, 200);
  assert.equal(row(ids.artist).overview, 'From somewhere.');
  assert.equal((await edit(ids.artist, { changes: { tagline: 'x' } })).data.error, "Tagline can't be edited for this title.");
});

test('an edit made while a refresh is running is kept', { skip }, async () => {
  await edit(ids.film, { unlock: ['tagline'] });
  slow = 1200;
  const refreshing = admin.post(`/api/items/${ids.film}/refresh`, {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await edit(ids.film, { changes: { tagline: 'Mine, mid-refresh' } })).status, 200);
  await refreshing;
  slow = 0;
  assert.equal(row(ids.film).tagline, 'Mine, mid-refresh');
  assert.ok(JSON.parse(row(ids.film).locked_fields).includes('tagline'));
});

// ---- v0.21 tidy-up ----
test('clearing Sort title unlocks it; a plot that only differs in line endings or spaces is no change', { skip }, async () => {
  await edit(ids.film, { changes: { sortTitle: 'zzz first' } });
  assert.ok(JSON.parse(row(ids.film).locked_fields).includes('sortTitle'));
  await edit(ids.film, { changes: { sortTitle: '' } });
  assert.ok(!JSON.parse(row(ids.film).locked_fields).includes('sortTitle'), 'cleared: the sort title is worked out again, unlocked');
  const plot = row(ids.film).overview || 'A film about something.\nIt goes on.';
  await edit(ids.film, { changes: { overview: plot }, unlock: ['overview'] });
  await edit(ids.film, { unlock: ['overview'] });
  await edit(ids.film, { changes: { overview: `  ${plot.replace(/\n/g, '\r\n').replace(/ /g, '  ')}  ` } });
  assert.ok(!JSON.parse(row(ids.film).locked_fields).includes('overview'), 'the same plot: not locked');
});

test('moving an episode: a duplicate number is refused; a season left empty goes', { skip }, async () => {
  const s1 = (await admin.get(`/api/items/${ids.season1}`)).data.episodes.map((e) => e.id);
  const target = (await admin.get(`/api/items/${ids.season2}`)).data.episodes;
  const taken = target[0];
  let r = await edit(s1[0], { changes: { season: 2, episode: taken.episode } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, `Season 2 already has episode ${taken.episode}.`);
  // The last episodes of season 1 move out: season 1 goes.
  let n = 40;
  for (const id of s1) {
    r = await edit(id, { changes: { season: 2, episode: n++ } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.equal(nf.app.core.db.get('SELECT id FROM items WHERE id = ?', ids.season1), undefined, 'the empty season is gone');
  const show = (await admin.get(`/api/items/${row(ids.season2).show_id}`)).data;
  assert.ok(!(show.seasons || []).some((x) => x.id === ids.season1));
});
