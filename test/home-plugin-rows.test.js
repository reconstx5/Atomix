// v0.23 Plan C Task 1: a plugin's Home row can give its cards a note and itself a title for the viewer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client } from './helpers.js';

let nf, admin;
before(async () => {
  process.env.ROWY_LONG = '';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'row-plugins') }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const db = nf.app.core.db;
  const lib = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('M', 'movies', '[]', '{}', 0)").lastInsertRowid);
  for (const t of ['Alpha', 'Beta', 'Gamma']) db.run("INSERT INTO items (library_id, kind, title, sort_title, path, genres, min_age, added_at, updated_at) VALUES (?, 'movie', ?, ?, ?, '[]', 0, 1, 1)", lib, t, t, `/m/${t}`);
});
after(async () => {
  await nf?.app.stop();
});

const home = async () => (await admin.get('/api/home')).data;
const rowsOf = (data) => data.rows || data;

test('a plugin row card keeps its note, and a row can have its own title for the viewer', async () => {
  const rows = rowsOf(await home());
  const noted = rows.find((r) => r.key === 'plugin:rowy/noted');
  assert.equal(noted.items[0].note, 'Only here');
  assert.equal(noted.items[1].note, undefined);
  const titled = rows.find((r) => r.key === 'plugin:rowy/titled');
  assert.equal(titled.title, 'Row for grown-ups');
  assert.equal(titled.items.length, 1);
});

test("Arrange home lists the plugin's rows by key", async () => {
  const r = await admin.get('/api/home/layout');
  const keys = JSON.stringify(r.data);
  assert.ok(keys.includes('plugin:rowy/noted') && keys.includes('plugin:rowy/titled'), keys.slice(0, 300));
});

test('a note is trimmed to 80 characters', async () => {
  process.env.ROWY_LONG = '1';
  const noted = rowsOf(await home()).find((r) => r.key === 'plugin:rowy/noted');
  assert.equal(noted.items[1].note, 'x'.repeat(80));
  process.env.ROWY_LONG = '';
});
