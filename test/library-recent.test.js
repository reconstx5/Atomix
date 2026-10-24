// The recent route (v0.25): a library's titles the viewer is part-way through, newest first — films by their own id,
// shows by the show's. Kids profiles get only what their rules allow. Items also carry their sort title.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client } from './helpers.js';

let nf, admin, kid, db, movies, tv, music, A, B, C, S, me, mia;
const add = (lib, kind, title, { age = 0, showId = null, parentId = null, season = null, episode = null } = {}) =>
  Number(db.run('INSERT INTO items (library_id, kind, title, sort_title, year, path, min_age, show_id, parent_id, season, episode, duration, added_at, updated_at) VALUES (?, ?, ?, ?, 2001, ?, ?, ?, ?, ?, ?, 3600, 1, 1)', lib, kind, title, title.toLowerCase(), `/x/${title}`, age, showId, parentId, season, episode).lastInsertRowid);
const prog = (profile, item, position, watched, at) => db.run('INSERT OR REPLACE INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, 3600, ?, ?)', profile, item, position, watched ? 1 : 0, at);

before(async () => {
  nf = await startAtomix();
  db = nf.app.core.db;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia}/select`, {});
  const lib = (name, type) => Number(db.run('INSERT INTO libraries (name, type, paths, options, created_at) VALUES (?, ?, ?, ?, 1)', name, type, '[]', '{}').lastInsertRowid);
  movies = lib('Movies', 'movies');
  tv = lib('TV Shows', 'tv');
  music = lib('Music', 'music');
  A = add(movies, 'movie', 'Alpha');
  B = add(movies, 'movie', 'Bravo');
  C = add(movies, 'movie', 'Charlie', { age: 15 });
  S = add(tv, 'show', 'Sierra');
  const s1 = add(tv, 'season', 'Season 1', { showId: S, parentId: S, season: 1 });
  const e1 = add(tv, 'episode', 'One', { showId: S, parentId: s1, season: 1, episode: 1 });
  add(tv, 'episode', 'Two', { showId: S, parentId: s1, season: 1, episode: 2 });
  prog(me, A, 600, false, 100);
  prog(me, e1, 3600, true, 300);
  prog(me, B, 900, false, 200);
  prog(mia, C, 600, false, 400);
  prog(mia, A, 700, false, 50);
});
after(async () => {
  await nf?.app.stop();
});

test('recent: newest first, one per title, shows by their show', async () => {
  assert.deepEqual((await admin.get(`/api/libraries/${movies}/recent`)).data.map((r) => r.id), [B, A]);
  assert.deepEqual((await admin.get(`/api/libraries/${tv}/recent`)).data.map((r) => r.id), [S]);
  const show = (await admin.get(`/api/libraries/${tv}/recent`)).data[0];
  assert.equal(show.episode?.title, 'Two', 'a show carries the episode to play: here the next one after the last watched');
  assert.deepEqual((await admin.get(`/api/libraries/${music}/recent`)).data, []);
});
test('a show with an episode part-watched carries that episode, with its progress', async () => {
  const two = db.get("SELECT id FROM items WHERE title = 'Two'").id;
  prog(me, two, 900, false, 500);
  const show = (await admin.get(`/api/libraries/${tv}/recent`)).data[0];
  db.run('DELETE FROM progress WHERE profile_id = ? AND item_id = ?', me, two);
  assert.equal(show.id, S);
  assert.equal(show.episode?.id, two);
  assert.equal(show.episode?.progress?.position, 900);
});
test("a Kids profile's recent list holds only what it may see", async () => {
  assert.deepEqual((await kid.get(`/api/libraries/${movies}/recent`)).data.map((r) => r.id), [A]);
});
test('items carry their sort title', async () => {
  const items = (await admin.get(`/api/libraries/${movies}/items`)).data.items;
  assert.equal(items.find((i) => i.id === A).sortTitle, 'alpha');
});
