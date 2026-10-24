// Recent searches (v0.24): each profile's 10 latest, newest first, a repeat moved to the top; kept on the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client } from './helpers.js';

let nf, admin, kid, miaId;
before(async () => {
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  miaId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${miaId}/select`, {});
});
after(async () => {
  await nf?.app.stop();
});

const queries = async (c) => (await c.get('/api/search/recent')).data.map((x) => x.query);

test('remembers searches newest first, at most 10', async () => {
  await admin.del('/api/search/recent');
  for (let i = 1; i <= 12; i++) await admin.post('/api/search/recent', { query: `q${i}` });
  const list = await queries(admin);
  assert.equal(list.length, 10);
  assert.equal(list[0], 'q12');
  assert.equal(list.at(-1), 'q3');
});

test('a repeat moves to the top instead of appearing twice', async () => {
  await admin.del('/api/search/recent');
  for (const q of ['Alien', 'Heat', ' alien ']) await admin.post('/api/search/recent', { query: q });
  assert.deepEqual(await queries(admin), ['alien', 'Heat']);
});

test('a long query is kept to 200 characters', async () => {
  await admin.del('/api/search/recent');
  await admin.post('/api/search/recent', { query: 'x'.repeat(500) });
  assert.equal((await queries(admin))[0].length, 200);
});

test('an empty query is refused', async () => {
  const r = await admin.post('/api/search/recent', { query: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Type something to search for.');
});

test('each profile has its own list; Kids too', async () => {
  await admin.del('/api/search/recent');
  await admin.post('/api/search/recent', { query: 'grown-up thing' });
  await kid.post('/api/search/recent', { query: 'cartoons' });
  assert.deepEqual(await queries(kid), ['cartoons']);
  assert.deepEqual(await queries(admin), ['grown-up thing']);
});

test("remove one, clear all, and another profile's id is not found", async () => {
  await admin.del('/api/search/recent');
  await admin.post('/api/search/recent', { query: 'one' });
  const after2 = (await admin.post('/api/search/recent', { query: 'two' })).data;
  assert.deepEqual(after2.map((x) => x.query), ['two', 'one']);
  const id = after2[1].id;
  assert.equal((await kid.del(`/api/search/recent/${id}`)).status, 404);
  assert.deepEqual((await admin.del(`/api/search/recent/${id}`)).data.map((x) => x.query), ['two']);
  assert.deepEqual((await admin.del('/api/search/recent')).data, []);
  assert.deepEqual(await queries(admin), []);
});

test('deleting a profile deletes its searches', async () => {
  await kid.post('/api/search/recent', { query: 'bluey' });
  assert.ok(nf.app.core.db.get('SELECT count(*) AS n FROM search_history WHERE profile_id = ?', miaId).n > 0);
  const r = await admin.del(`/api/profiles/${miaId}`);
  assert.ok(r.status < 300, JSON.stringify(r.data));
  assert.equal(nf.app.core.db.get('SELECT count(*) AS n FROM search_history WHERE profile_id = ?', miaId).n, 0);
});
