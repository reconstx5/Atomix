// Search matching (v0.24): accents, case, punctuation and a leading "the" are ignored, in the full results, the
// music apps and the suggestions; a renamed title is found by its new name; a v0.23 database gets keys on its first search.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startAtomix, client, tempDir, hasFfmpeg, makeAudio, waitForScan } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';
import { searchKey, searchWords, queryKeys, rankTitle, keyMatch } from '../src/library/searchkey.js';
import { openDatabase } from '../src/db.js';

test('accents, case and punctuation are ignored', () => {
  assert.equal(searchKey('Amélie'), 'amelie');
  assert.equal(searchKey('Spider-Man: No Way Home'), 'spidermannowayhome');
  assert.equal(searchWords("Schindler's List"), 'schindlers list');
  assert.deepEqual(queryKeys('The Beatles'), ['thebeatles', 'beatles']);
});

test('a query of only punctuation matches nothing', () => {
  assert.deepEqual(queryKeys('!!'), []);
  assert.deepEqual(queryKeys('  – '), []);
  assert.deepEqual(keyMatch('i.search_key', '!!'), { sql: '0', params: [] });
});

test('ranking: prefix, then a word starting with it, then contains', () => {
  assert.equal(rankTitle('The Matrix', 'matrix'), 0);
  assert.equal(rankTitle('The Matrix', 'the ma'), 0);
  assert.equal(rankTitle('Spider-Man', 'man'), 1);
  assert.equal(rankTitle('Batman', 'man'), 2);
  assert.equal(rankTitle('Up', 'down'), 3);
});

let nf, admin, kid, db, movies;
before(async () => {
  nf = await startAtomix();
  db = nf.app.core.db;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', 1)").lastInsertRowid);
  const music = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Music', 'music', '[]', '{}', 1)").lastInsertRowid);
  const add = (lib, kind, title, age = 0) => Number(db.run('INSERT INTO items (library_id, kind, title, sort_title, path, genres, min_age, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)', lib, kind, title, title, `/x/${kind}/${title}`, '[]', age).lastInsertRowid);
  add(movies, 'movie', 'Amélie');
  add(movies, 'movie', 'Spider-Man');
  add(movies, 'movie', 'Grown-up Thriller', 15);
  add(music, 'artist', 'The Beatles');
  add(music, 'artist', 'Beatles');
});
after(async () => {
  await nf?.app.stop();
});

const titles = async (c, q, group = 'movies') => (await c.get(`/api/search?q=${encodeURIComponent(q)}`)).data[group].map((x) => x.title);

test('"amelie" and "AMELIE" find Amélie; "spiderman" and "spider man" find Spider-Man', async () => {
  assert.deepEqual(await titles(admin, 'amelie'), ['Amélie']);
  assert.deepEqual(await titles(admin, 'AMELIE'), ['Amélie']);
  assert.deepEqual(await titles(admin, 'spiderman'), ['Spider-Man']);
  assert.deepEqual(await titles(admin, 'spider man'), ['Spider-Man']);
});

test('"the beatles" finds the artist Beatles; "beatles" finds The Beatles', async () => {
  assert.ok((await titles(admin, 'the beatles', 'artists')).includes('Beatles'));
  assert.ok((await titles(admin, 'beatles', 'artists')).includes('The Beatles'));
});

test('a renamed title is found by its new name only', async () => {
  const id = db.get("SELECT id FROM items WHERE title = 'Amélie'").id;
  await titles(admin, 'amelie'); // its key exists now
  db.run("UPDATE items SET title = 'Le Fabuleux Destin' WHERE id = ?", id);
  try {
    assert.deepEqual(await titles(admin, 'fabuleux'), ['Le Fabuleux Destin']);
    assert.deepEqual(await titles(admin, 'amelie'), []);
  } finally {
    db.run("UPDATE items SET title = 'Amélie' WHERE id = ?", id);
  }
});

test("the Kids profile's search keeps its rules", async () => {
  assert.deepEqual(await titles(admin, 'thriller'), ['Grown-up Thriller']);
  assert.deepEqual(await titles(kid, 'thriller'), []);
});

test('a query of only punctuation finds nothing (and no error)', async () => {
  const r = await admin.get('/api/search?q=!!');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.movies, []);
});

test("the music apps' search3 ignores accents", { skip: !hasFfmpeg }, async () => {
  const media = tempDir();
  makeAudio(path.join(media, 'Beyoncé', 'Renaissance', '01 Cozy.mp3'), { tags: { title: 'Cozy', artist: 'Beyoncé', album: 'Renaissance', track: '1/1' } });
  await admin.post('/api/libraries', { name: 'Songs', type: 'music', paths: [media] });
  await waitForScan(admin);
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data.secret;
  const r = await rest(nf.base, 'search3', { ...tokenAuth('dallas', secret), query: 'beyonce' });
  assert.equal(r.body.status, 'ok', JSON.stringify(r.body));
  assert.deepEqual(r.body.searchResult3.album.map((a) => a.name), ['Renaissance']);
  assert.ok(r.body.searchResult3.artist.some((a) => a.name === 'Beyoncé'));
});

test('a database from v0.23 gets keys on its first search', async () => {
  const dataDir = path.join(tempDir(), 'data');
  const { default: fs } = await import('node:fs');
  fs.mkdirSync(dataDir, { recursive: true });
  const old = openDatabase(path.join(dataDir, 'atomix.db'), { upTo: 28 });
  const lib = Number(old.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('M', 'movies', '[]', '{}', 1)").lastInsertRowid);
  old.run("INSERT INTO items (library_id, kind, title, sort_title, path, genres, min_age, added_at, updated_at) VALUES (?, 'movie', 'Amélie', 'Amélie', '/a', '[]', 0, 1, 1)", lib);
  old.close();
  const other = await startAtomix({ ATOMIX_DATA_DIR: dataDir });
  try {
    const c = client(other.base);
    await c.post('/api/setup', { username: 'dallas', password: 'password123' });
    const me = (await c.get('/api/profiles')).data[0].id;
    await c.post(`/api/profiles/${me}/select`, {});
    assert.deepEqual((await c.get('/api/search?q=amelie')).data.movies.map((x) => x.title), ['Amélie']);
  } finally {
    await other.app.stop();
  }
});

test('migration 29 fills the keys of existing titles, and an unchanged title keeps its key (review fix I3)', async () => {
  const { default: fs } = await import('node:fs');
  const file = path.join(tempDir(), 'k.db');
  const old = openDatabase(file, { upTo: 28 });
  const lib = Number(old.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('M', 'movies', '[]', '{}', 1)").lastInsertRowid);
  old.run("INSERT INTO items (library_id, kind, title, sort_title, path, genres, min_age, added_at, updated_at) VALUES (?, 'movie', 'Amélie', 'Amélie', '/a', '[]', 0, 1, 1)", lib);
  old.close();
  const db2 = openDatabase(file);
  try {
    assert.equal(db2.get("SELECT search_key FROM items WHERE title = 'Amélie'").search_key, 'amelie|');
    db2.run("UPDATE items SET title = 'Amélie' WHERE title = 'Amélie'");
    assert.equal(db2.get("SELECT search_key FROM items WHERE title = 'Amélie'").search_key, 'amelie|', 'a refresh that rewrites the same title keeps the key');
  } finally {
    db2.close();
    fs.rmSync(file, { force: true });
  }
});

test("the music apps' search uses the stored keys, not a key per row and column (review fix I2)", { skip: !hasFfmpeg }, async () => {
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Count' })).data.secret;
  await rest(nf.base, 'search3', { ...tokenAuth('dallas', secret), query: 'beyonce' }); // keys filled
  const { searchKey: key } = await import('../src/library/searchkey.js');
  let calls = 0;
  db.raw.function('atomix_key', { deterministic: true }, (s) => (calls++, s == null ? null : key(String(s))));
  try {
    await rest(nf.base, 'search3', { ...tokenAuth('dallas', secret), query: 'beyonce' });
    const songs = db.get("SELECT count(*) AS n FROM items WHERE kind = 'track'").n;
    assert.ok(calls <= songs, `${calls} calls for ${songs} songs`);
  } finally {
    db.raw.function('atomix_key', { deterministic: true }, (s) => (s == null ? null : key(String(s))));
  }
});
