// Suggestions as you type, people, genre and library tiles, and the genre and person pages' titles (v0.24). Kids
// profiles get only what their rules allow, people included.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client } from './helpers.js';

let nf, admin, kid, guest, db, movies, tv;
const add = (lib, kind, title, { year = 2001, age = 0, genres = [], people = [] } = {}) =>
  Number(db.run('INSERT INTO items (library_id, kind, title, sort_title, year, path, genres, people, min_age, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)', lib, kind, title, title, year, `/x/${title}`, JSON.stringify(genres), JSON.stringify(people), age).lastInsertRowid);

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
  const lib = (name, type) => Number(db.run('INSERT INTO libraries (name, type, paths, options, created_at) VALUES (?, ?, ?, ?, 1)', name, type, '[]', '{}').lastInsertRowid);
  movies = lib('Movies', 'movies');
  tv = lib('TV Shows', 'tv');
  lib('Grown-up Films', 'movies');
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1', libraryAccess: [movies] });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  const gp = (await guest.get('/api/profiles')).data[0].id;
  await guest.post(`/api/profiles/${gp}/select`, {});
  add(movies, 'movie', 'Batman', { genres: ['Action'] });
  add(movies, 'movie', 'Man on Fire', { genres: ['Action', 'Drama'] });
  add(movies, 'movie', 'Iron Man', { genres: ['Action'] });
  add(movies, 'movie', 'The Royal Tenenbaums', { year: 2001, genres: ['Drama', 'Comedy'], people: [{ name: 'Wes Anderson', role: 'director' }, { name: 'Gene Hackman', role: 'cast', character: 'Royal' }] });
  add(movies, 'movie', 'Fantastic Mr. Fox', { year: 2009, genres: ['Animation'], people: [{ name: 'Wes Anderson', role: 'director' }, { name: 'George Clooney', role: 'cast', character: 'Mr. Fox' }] });
  add(movies, 'movie', 'Grim Night', { age: 15, genres: ['Slasher'], people: [{ name: 'Rex Grimm', role: 'cast' }] });
  add(tv, 'show', 'Drama Club', { year: 2010, genres: ['Drama'] });
});
after(async () => {
  await nf?.app.stop();
});

const suggest = async (c, q) => (await c.get(`/api/search/suggest?q=${encodeURIComponent(q)}`)).data;

test('suggestions start from the first letter and rank prefix, word, contains', async () => {
  assert.deepEqual((await suggest(admin, 'man')).filter((s) => s.kind === 'movie').map((s) => s.title), ['Man on Fire', 'Iron Man', 'Batman']);
  assert.ok((await suggest(admin, 'b')).some((s) => s.title === 'Batman'), 'one letter is enough');
});

test('at most 8 suggestions, each with kind, title and subtitle', async () => {
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(add(movies, 'movie', `Zed ${i}`, { year: 1999 }));
  try {
    const list = await suggest(admin, 'zed');
    assert.equal(list.length, 8);
    for (const s of list) {
      assert.equal(s.kind, 'movie');
      assert.ok(s.id && s.title);
      assert.match(s.subtitle, /^Film · \d{4}$/);
    }
  } finally {
    for (const id of ids) db.run('DELETE FROM items WHERE id = ?', id);
  }
});

test('a query of only punctuation suggests nothing', async () => {
  assert.deepEqual(await suggest(admin, '!!'), []);
  assert.deepEqual(await suggest(admin, ''), []);
});

test('people are suggested with their role and title count', async () => {
  const wes = (await suggest(admin, 'wes')).find((s) => s.kind === 'person');
  assert.deepEqual(wes, { kind: 'person', title: 'Wes Anderson', subtitle: 'Director · 2 titles' });
  assert.deepEqual((await suggest(admin, 'clooney')).find((s) => s.kind === 'person')?.subtitle, 'Actor · 1 title');
});

test("a Kids profile is never shown a person whose titles it can't see", async () => {
  assert.ok((await suggest(admin, 'rex')).some((s) => s.title === 'Rex Grimm'));
  assert.ok(!(await suggest(kid, 'rex')).some((s) => s.title === 'Rex Grimm'));
  assert.ok(!(await suggest(kid, 'grim')).some((s) => s.title === 'Grim Night'));
  assert.deepEqual((await kid.get('/api/people/Rex%20Grimm/items')).data.items, []);
});

test('genre tiles: this viewer\'s genres, most common first, at most 12', async () => {
  const b = (await admin.get('/api/search/browse')).data;
  assert.deepEqual(b.genres.slice(0, 2), [{ name: 'Action', count: 3 }, { name: 'Drama', count: 3 }]);
  assert.ok(b.genres.some((g) => g.name === 'Slasher'));
  assert.ok(!(await kid.get('/api/search/browse')).data.genres.some((g) => g.name === 'Slasher'));
  const ids = [];
  for (let i = 0; i < 14; i++) ids.push(add(movies, 'movie', `G ${i}`, { genres: [`Genre ${String(i).padStart(2, '0')}`] }));
  try {
    assert.equal((await admin.get('/api/search/browse')).data.genres.length, 12);
  } finally {
    for (const id of ids) db.run('DELETE FROM items WHERE id = ?', id);
  }
});

test("library tiles are the viewer's libraries", async () => {
  const names = (await admin.get('/api/search/browse')).data.libraries.map((l) => l.name);
  assert.ok(names.includes('Grown-up Films') && names.includes('TV Shows'));
  assert.deepEqual((await guest.get('/api/search/browse')).data.libraries.map((l) => l.name), ['Movies']);
});

test('a genre page lists films and shows with that genre', async () => {
  const r = (await admin.get('/api/genres/Drama/items')).data;
  assert.equal(r.name, 'Drama');
  assert.deepEqual(r.items.map((i) => i.title), ['Drama Club', 'Man on Fire', 'The Royal Tenenbaums']);
  assert.deepEqual(new Set(r.items.map((i) => i.kind)), new Set(['show', 'movie']));
});

test('a person page lists their titles with role and character', async () => {
  const r = (await admin.get('/api/people/George%20Clooney/items')).data;
  assert.equal(r.name, 'George Clooney');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'Fantastic Mr. Fox');
  assert.equal(r.items[0].role, 'Actor');
  assert.equal(r.items[0].character, 'Mr. Fox');
  const wes = (await admin.get('/api/people/Wes%20Anderson/items')).data.items;
  assert.deepEqual(wes.map((i) => [i.title, i.role, i.character]), [['Fantastic Mr. Fox', 'Director', undefined], ['The Royal Tenenbaums', 'Director', undefined]]);
});

test('a badly encoded name is refused', async () => {
  assert.equal((await admin.get('/api/people/%E0%A4%A/items')).status, 400);
});

test('a big library still suggests the titles that start with the letter (review fix I1)', async () => {
  const ids = [];
  db.exec('BEGIN');
  for (let i = 0; i < 260; i++) ids.push(add(movies, 'movie', `Aas ${String(i).padStart(3, '0')}`));
  db.exec('COMMIT');
  const star = add(movies, 'movie', 'Star Wars', { year: 1977 });
  try {
    const list = await suggest(admin, 's');
    assert.equal(list[0]?.title, 'Star Wars', JSON.stringify(list.map((s) => s.title)));
  } finally {
    for (const id of [...ids, star]) db.run('DELETE FROM items WHERE id = ?', id);
  }
});

test('people are found however many films there are (review fix M1)', async () => {
  const ids = [];
  db.exec('BEGIN');
  for (let i = 0; i < 600; i++) ids.push(add(movies, 'movie', `Crowd ${i}`, { people: [{ name: `Extra ${i}`, role: 'director' }] }));
  db.exec('COMMIT');
  const diane = add(movies, 'movie', 'Annie Hall', { year: 1977, people: [{ name: 'Diane Keaton', role: 'cast' }] });
  try {
    assert.ok((await suggest(admin, 'di')).some((s) => s.title === 'Diane Keaton'));
  } finally {
    for (const id of [...ids, diane]) db.run('DELETE FROM items WHERE id = ?', id);
  }
});
