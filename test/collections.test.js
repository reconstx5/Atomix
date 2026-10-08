// Collections: film series from TMDB and hand-made ones; a rename survives a refresh; hidden; kids filtering.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Collections } from '../src/collections.js';

let db, library, collections;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
function addItem(f) {
  const fields = { library_id: 1, kind: 'movie', title: `T${++seq}`, path: `/m/${seq}`, size: 1, mtime: 1, duration: 100, media: VIDEO, genres: '[]', ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const adult = { userId: 1, profileId: 1, kids: false, maxAge: null, allowUnrated: true, libraryIds: null };
const kid = { userId: 1, profileId: 2, kids: true, maxAge: 10, allowUnrated: false, libraryIds: null };
const ids = {};
const series = {
  tmdbId: 8091,
  name: 'Alien Collection',
  overview: 'Xenomorphs.',
  poster: null,
  backdrop: null,
  parts: [{ tmdbId: 348, title: 'Alien', year: 1979 }, { tmdbId: 679, title: 'Aliens', year: 1986 }, { tmdbId: 8077, title: 'Alien³', year: 1992 }],
};

before(() => {
  db = openDatabase(path.join(tempDir(), 'c.db'));
  library = new Library(db);
  collections = new Collections({ db, library });
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now);
  ids.alien = addItem({ title: 'Alien', year: 1979, tmdb_id: 348, min_age: 16 });
  ids.aliens = addItem({ title: 'Aliens', year: 1986, tmdb_id: 679, min_age: 16 });
  ids.cartoon = addItem({ title: 'Cartoon', year: 2020, min_age: 0 });
  ids.show = addItem({ library_id: 1, kind: 'show', title: 'Kids Show', min_age: 0 });
});

test('a TMDB collection is created once and films take their release-order position', () => {
  collections.upsertTmdb(series, library.get(ids.aliens));
  collections.upsertTmdb(series, library.get(ids.alien));
  const c = collections.forItem(ids.alien, adult);
  assert.equal(c.name, 'Alien Collection');
  assert.deepEqual(c.items.map((i) => i.title), ['Alien', 'Aliens']);
  assert.equal(c.owned, 2);
  assert.equal(c.total, 3);
  assert.deepEqual(c.missing, [{ title: 'Alien³', year: 1992 }]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM collections').n, 1);
  ids.alienCollection = c.id;
});

test("a rename survives a later refresh; hidden keeps it out of lists but not off a film's page", () => {
  collections.update(ids.alienCollection, { name: 'Alien films' });
  collections.upsertTmdb(series, library.get(ids.aliens));
  assert.equal(collections.get(ids.alienCollection, adult).name, 'Alien films');
  collections.update(ids.alienCollection, { hidden: true });
  assert.ok(!collections.list(adult).some((c) => c.id === ids.alienCollection));
  assert.equal(collections.forItem(ids.alien, adult).name, 'Alien films');
  collections.update(ids.alienCollection, { hidden: false });
});

test('a kid sees only the safe part of a collection, and none of it when nothing is safe', () => {
  assert.equal(collections.get(ids.alienCollection, kid), null);
  assert.ok(!collections.list(kid).some((c) => c.id === ids.alienCollection));
});

test("a kid never learns the names of the films they can't see: missing lists only what nobody owns", () => {
  const teen = { userId: 1, profileId: 3, kids: true, maxAge: 16, allowUnrated: false, libraryIds: null };
  db.run('UPDATE items SET min_age = 18 WHERE id = ?', ids.aliens);
  const c = collections.get(ids.alienCollection, teen);
  assert.deepEqual(c.items.map((i) => i.title), ['Alien']);
  assert.deepEqual(c.missing, [{ title: 'Alien³', year: 1992 }], 'the hidden film is neither listed nor counted as missing');
  assert.equal(c.owned, 1);
  assert.equal(c.total, 3);
  db.run('UPDATE items SET min_age = 16 WHERE id = ?', ids.aliens);
});

test('an admin listing with all=1 sees an empty hand-made collection and every member, whatever the profile can see', () => {
  const empty = collections.create({ name: 'Nothing yet', itemIds: [] });
  assert.ok(collections.list(kid, { includeHidden: true, everything: true }).some((c) => c.id === empty.id));
  assert.ok(!collections.list(kid).some((c) => c.id === empty.id));
  const full = collections.get(ids.alienCollection, kid, { everything: true });
  assert.deepEqual(full.items.map((i) => i.title), ['Alien', 'Aliens']);
  collections.remove(empty.id);
});

test("hand-made collections mix films and shows, keep their order, and can be removed; TMDB ones can't", () => {
  const c = collections.create({ name: 'Family night', itemIds: [ids.show, ids.cartoon] });
  assert.equal(c.manual, true);
  assert.deepEqual(collections.get(c.id, adult).items.map((i) => i.title), ['Kids Show', 'Cartoon']);
  collections.update(c.id, { itemIds: [ids.cartoon, ids.show], artworkFrom: ids.cartoon });
  assert.deepEqual(collections.get(c.id, kid).items.map((i) => i.title), ['Cartoon', 'Kids Show']);
  assert.equal(collections.get(c.id, adult).total, 2, "a hand-made collection's total is what it holds");
  assert.equal(collections.forItem(ids.cartoon, adult).id, c.id);
  assert.throws(() => collections.remove(ids.alienCollection), /TMDB/);
  collections.remove(c.id);
  assert.equal(collections.get(c.id, adult), null);
});

test("TMDB's parts and artwork update a non-manual collection; the name stays", () => {
  const more = { ...series, poster: 'cache:new-poster.jpg', overview: 'Four of them.', parts: [...series.parts, { tmdbId: 9999, title: 'Alien: Romulus', year: 2024 }] };
  collections.upsertTmdb(more, library.get(ids.alien));
  const c = collections.get(ids.alienCollection, adult);
  assert.equal(c.name, 'Alien films', 'the rename stuck');
  assert.equal(c.total, 4);
  assert.equal(c.missing.length, 2);
  const row = db.get('SELECT poster, overview FROM collections WHERE id = ?', ids.alienCollection);
  assert.equal(row.poster, 'cache:new-poster.jpg');
  assert.equal(row.overview, 'Xenomorphs.', 'our overview is kept when we have one');
  // A film TMDB no longer lists in the series is detached when its refresh says so (detach(), as a re-match does).
  collections.detach(ids.aliens);
  assert.equal(collections.forItem(ids.aliens, adult), null);
  assert.equal(collections.get(ids.alienCollection, adult).owned, 1);
  collections.upsertTmdb(more, library.get(ids.aliens)); // back in, for the tests that follow
});

test("a TMDB answer with no parts (a hiccup on the /collection call) keeps the collection's stored list", () => {
  const before = collections.get(ids.alienCollection, adult);
  collections.upsertTmdb({ ...series, parts: [] }, library.get(ids.alien));
  const after = collections.get(ids.alienCollection, adult);
  assert.equal(after.total, before.total, 'the parts list survives an empty answer');
  assert.equal(after.missing.length, before.missing.length);
  const pos = db.get('SELECT position FROM collection_items WHERE collection_id = ? AND item_id = ?', ids.alienCollection, ids.alien);
  assert.ok(pos.position >= 0);
});

test('detach takes a film out of its TMDB collection (unmatching), and a deleted film disappears', () => {
  collections.detach(ids.aliens);
  assert.deepEqual(collections.get(ids.alienCollection, adult).items.map((i) => i.title), ['Alien']);
  db.run('DELETE FROM items WHERE id = ?', ids.alien);
  assert.equal(collections.get(ids.alienCollection, adult), null, 'no visible members: nothing to show');
});

