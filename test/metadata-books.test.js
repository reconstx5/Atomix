// Books and audiobooks ask metadata providers too (v0.23), filling only what the file left empty; ids an earlier
// provider passes on are seen by later ones in the same refresh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, startAtomix, client, waitForScan } from './helpers.js';
import { makeEpub } from './helpers-books.js';
import { openDatabase } from '../src/db.js';
import { MetadataManager } from '../src/library/metadata.js';

const now = Date.now();
let db, metadata;
let seq = 0;
function addItem(f) {
  const fields = { library_id: 1, kind: 'book', title: `B${++seq}`, path: `/b/${seq}.epub`, size: 1, mtime: 1, genres: '[]', ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const row = (id) => db.get('SELECT * FROM items WHERE id = ?', id);

before(() => {
  db = openDatabase(path.join(tempDir(), 'mb.db'));
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Books', 'books', '[]', '{}', ?)", now);
  const settings = { get: () => null, all: () => ({}) };
  metadata = new MetadataManager({ db, config: { tmdbBase: 'http://127.0.0.1:9/3', initialTmdbKey: '' }, settings, images: { store: async (x) => x || null }, hooks: null });
});

test('a book asks providers that list books, and only its empty fields fill', async () => {
  metadata.register({ id: 'books', priority: 60, kinds: ['book', 'audiobook'], fetch: () => ({ title: 'Other', overview: 'From the plugin', genres: ['Sea'], year: 1951, poster: '/tmp/cover.png' }) });
  const bare = addItem({ title: 'Long Voyage', author: 'Ann Author' });
  const full = addItem({ title: 'Own Words', author: 'Bea', overview: 'Its own blurb', year: 2001, genres: '["Drama"]' });
  await metadata.refresh(row(bare));
  await metadata.refresh(row(full));
  const b = row(bare);
  assert.equal(b.title, 'Long Voyage', 'the book keeps its own title');
  assert.equal(b.author, 'Ann Author');
  assert.equal(b.overview, 'From the plugin');
  assert.equal(b.year, 1951);
  assert.deepEqual(JSON.parse(b.genres), ['Sea']);
  assert.equal(b.poster, '/tmp/cover.png');
  const f = row(full);
  assert.equal(f.title, 'Own Words');
  assert.equal(f.overview, 'Its own blurb', 'its own description stays');
  assert.equal(f.year, 2001);
  assert.deepEqual(JSON.parse(f.genres), ['Drama']);
});

test('an audiobook asks providers too', async () => {
  const id = addItem({ kind: 'audiobook', title: 'Spoken', path: null });
  await metadata.refresh(row(id));
  assert.equal(row(id).overview, 'From the plugin');
  assert.equal(row(id).title, 'Spoken');
});

test("providers that don't list books aren't asked for them", async () => {
  let calls = 0;
  metadata.register({ id: 'films-only', priority: 70, kinds: ['movie'], fetch: () => (calls++, null) });
  await metadata.refresh(row(addItem({ title: 'Third' })));
  assert.equal(calls, 0);
});

test('a later provider sees the ids an earlier one passed', async () => {
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Music', 'music', '[]', '{}', ?)", now);
  let seen;
  metadata.register({ id: 'mb', priority: 20, kinds: ['album', 'artist'], fetch: () => ({ musicbrainzId: 'mb-1', musicbrainzArtistId: 'mba-1' }) });
  metadata.register({ id: 'reads-mb', priority: 30, kinds: ['album'], fetch: (item, ctx) => ((seen = [ctx.merged.musicbrainzId, ctx.merged.musicbrainzArtistId]), null) });
  const id = addItem({ library_id: 2, kind: 'album', title: 'Record', path: null });
  await metadata.refresh(row(id));
  assert.deepEqual(seen, ['mb-1', 'mba-1']);
  assert.ok(!('musicbrainz_id' in row(id)), 'not stored');
});

// The scan's metadata pass reaches books.
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'book-plugins');
let nf;
after(async () => {
  await nf?.app.stop();
});
test('a scanned book is filled by a books plugin', async () => {
  const root = tempDir();
  await makeEpub(path.join(root, 'Sea Story.epub'), { title: 'Sea Story', author: 'Ann Author' });
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  const admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Books', type: 'books', paths: [root] })).data.id;
  await waitForScan(admin);
  const book = nf.app.core.db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'book'", lib);
  assert.equal(book.title, 'Sea Story');
  assert.equal(book.overview, 'About Sea Story');
  assert.equal(book.year, 1951);
  // F2: the file is rewritten (Calibre) with no description: the next scan fills it again.
  await new Promise((r) => setTimeout(r, 1100));
  await makeEpub(path.join(root, 'Sea Story.epub'), { title: 'Sea Story', author: 'Ann Author', chapters: ['One', 'Two'] });
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const again = nf.app.core.db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'book'", lib);
  assert.equal(again.overview, 'About Sea Story', 'filled again after the file changed');
});

// ---- v0.23 review fixes ----
test('a provider seen for the first time is offered the titles it lists, once (F1)', async () => {
  const store = new Map();
  const settings = { get: (k) => store.get(k) ?? null, set: (o) => Object.entries(o).forEach(([k, v]) => store.set(k, v)), all: () => ({}) };
  const db2 = openDatabase(path.join(tempDir(), 'f1.db'));
  db2.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Books', 'books', '[]', '{}', 0)");
  const id = Number(db2.run("INSERT INTO items (library_id, kind, title, path, genres, metadata_at, added_at, updated_at) VALUES (1, 'book', 'Old Book', '/b/o.epub', '[]', 123, 0, 0)").lastInsertRowid);
  const m = new MetadataManager({ db: db2, config: { tmdbBase: 'http://127.0.0.1:9/3', initialTmdbKey: '' }, settings, images: { store: async (x) => x || null }, hooks: null });
  m.started = true; // turned on while Atomix runs
  m.register({ id: 'open-books', priority: 60, kinds: ['book'], fetch: () => null }, 'open-library');
  assert.equal(db2.get('SELECT metadata_at FROM items WHERE id = ?', id).metadata_at, null, 'offered at the next scan');
  db2.run('UPDATE items SET metadata_at = 456 WHERE id = ?', id);
  m.removeByOwner('open-library');
  m.register({ id: 'open-books', priority: 60, kinds: ['book'], fetch: () => null }, 'open-library');
  assert.equal(db2.get('SELECT metadata_at FROM items WHERE id = ?', id).metadata_at, 456, 'not again on a restart');
});

test('a title with no scores stores none (SQL NULL), and plugins can find and refresh them (F3)', async () => {
  const id = addItem({ kind: 'movie', title: 'No Scores', path: '/m/ns.mp4' });
  await metadata.refresh(row(id));
  assert.equal(row(id).scores, null);
});

test('on the first start after upgrading, the plugins already there are remembered without a refetch (F1)', async () => {
  const store = new Map();
  const settings = { get: (k) => store.get(k) ?? null, set: (o) => Object.entries(o).forEach(([k, v]) => store.set(k, v)), all: () => ({}) };
  const db3 = openDatabase(path.join(tempDir(), 'f1b.db'));
  db3.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('M', 'movies', '[]', '{}', 0)");
  const id = Number(db3.run("INSERT INTO items (library_id, kind, title, path, genres, metadata_at, added_at, updated_at) VALUES (1, 'movie', 'Film', '/m/f.mp4', '[]', 123, 0, 0)").lastInsertRowid);
  const m = new MetadataManager({ db: db3, config: { tmdbBase: 'http://127.0.0.1:9/3', initialTmdbKey: '' }, settings, images: { store: async (x) => x || null }, hooks: null });
  m.register({ id: 'nfo', priority: 10, kinds: ['movie'], fetch: () => null }, 'nfo-metadata');
  m.register({ id: 'other', priority: 60, kinds: ['movie'], fetch: () => null }, 'other');
  assert.equal(db3.get('SELECT metadata_at FROM items WHERE id = ?', id).metadata_at, 123, 'no refetch of the whole library on upgrade');
  m.started = true; // the plugins that were there have loaded
  m.register({ id: 'fanart', priority: 60, kinds: ['movie'], fetch: () => null }, 'fanart-tv');
  assert.equal(db3.get('SELECT metadata_at FROM items WHERE id = ?', id).metadata_at, null, 'a plugin turned on later is offered the films');
  assert.deepEqual(store.get('metadataProvidersSeen').sort(), ['fanart', 'nfo', 'other']);
});

test('the providers seen are kept in the real settings (F1)', async () => {
  const { Settings } = await import('../src/settings.js');
  const db4 = openDatabase(path.join(tempDir(), 'f1c.db'));
  const settings = new Settings(db4);
  settings.set({ metadataProvidersSeen: ['a', 'b'] });
  assert.deepEqual(settings.get('metadataProvidersSeen'), ['a', 'b']);
});
