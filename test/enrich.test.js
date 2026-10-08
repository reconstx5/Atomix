// TMDB keywords, people (director/creator + top cast) and the film series a movie belongs to; and the
// catch-up pass for titles matched before v0.9.0.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir, fakeServer } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Collections } from '../src/collections.js';
import { MetadataManager } from '../src/library/metadata.js';

let db, library, collections, metadata, tmdb;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
function addItem(f) {
  const fields = { library_id: 1, kind: 'movie', title: `T${++seq}`, path: `/m/${seq}`, size: 1, mtime: 1, duration: 100, media: VIDEO, genres: '[]', ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const row = (id) => db.get('SELECT * FROM items WHERE id = ?', id);

before(async () => {
  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/3/search/movie') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      if (q.includes('alien')) return send({ results: [{ id: 348, title: 'Alien', release_date: '1979-05-25' }] });
      if (q.includes('quiet')) return send({ results: [{ id: 900, title: 'Quiet Film', release_date: '2001-01-01' }] });
      return send({ results: [] });
    }
    if (u.pathname === '/3/movie/348') {
      return send({
        id: 348, title: 'Alien', release_date: '1979-05-25', genres: [{ name: 'Horror' }], overview: 'In space.',
        belongs_to_collection: { id: 8091, name: 'Alien Collection', poster_path: null, backdrop_path: null },
        keywords: { keywords: [{ name: 'Space' }, { name: 'Android' }] },
        credits: { cast: [{ name: 'Tom Skerritt', order: 1 }, { name: 'Sigourney Weaver', order: 0 }], crew: [{ name: 'Ridley Scott', job: 'Director' }, { name: 'Someone', job: 'Editor' }] },
        videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', key: 'abc123', name: 'Official' }] },
      });
    }
    if (u.pathname === '/3/movie/900') return send({ id: 900, title: 'Quiet Film', release_date: '2001-01-01', genres: [] }); // no keywords, no credits
    if (u.pathname === '/3/collection/8091') {
      return send({ id: 8091, name: 'Alien Collection', overview: 'Xenomorphs.', parts: [{ id: 679, title: 'Aliens', release_date: '1986-07-18' }, { id: 348, title: 'Alien', release_date: '1979-05-25' }] });
    }
    if (u.pathname === '/3/search/tv') return send({ results: [{ id: 33, name: 'Demo Show', first_air_date: '2022-01-01' }] });
    if (u.pathname === '/3/tv/33') {
      return send({ id: 33, name: 'Demo Show', first_air_date: '2022-01-01', overview: 'A show.', genres: [{ name: 'Drama' }], keywords: { results: [{ name: 'Coast' }] }, aggregate_credits: { cast: [{ name: 'Theo', order: 0 }] }, created_by: [{ name: 'A. Writer' }] });
    }
    send({}, 404);
  });
  db = openDatabase(path.join(tempDir(), 'e.db'));
  library = new Library(db);
  collections = new Collections({ db, library });
  const settings = { get: (k) => ({ tmdbApiKey: '0123456789abcdef0123456789abcdef', metadataLanguage: 'en-US' })[k], all: () => ({}) };
  metadata = new MetadataManager({ db, config: { tmdbBase: `${tmdb.url}/3`, initialTmdbKey: '' }, settings, images: { store: async (x) => x || null }, hooks: null });
  metadata.setCollections(collections);
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now);
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('TV', 'tv', '[]', '{}', ?)", now);
});
after(() => tmdb?.close());

test('a matched movie stores keywords, people and its TMDB collection; a show stores keywords and its creator', async () => {
  const alien = row(addItem({ title: 'Alien', year: 1979 }));
  await metadata.refresh(alien);
  const r = row(alien.id);
  assert.deepEqual(JSON.parse(r.keywords), ['space', 'android']);
  assert.deepEqual(JSON.parse(r.people), [{ name: 'Ridley Scott', role: 'director' }, { name: 'Sigourney Weaver', role: 'cast' }, { name: 'Tom Skerritt', role: 'cast' }]);
  const c = db.get('SELECT * FROM collections WHERE tmdb_id = 8091');
  assert.equal(c.name, 'Alien Collection');
  assert.deepEqual(JSON.parse(c.parts).map((p) => p.title), ['Alien', 'Aliens'], 'parts in release order');
  assert.equal(db.get('SELECT position FROM collection_items WHERE item_id = ?', alien.id).position, 0);
  assert.deepEqual(JSON.parse(r.trailer), { site: 'youtube', key: 'abc123', name: 'Official' });
  const show = row(addItem({ kind: 'show', title: 'Demo Show', library_id: 2 }));
  await metadata.refresh(show);
  assert.deepEqual(JSON.parse(row(show.id).keywords), ['coast']);
  assert.deepEqual(JSON.parse(row(show.id).people), [{ name: 'A. Writer', role: 'creator' }, { name: 'Theo', role: 'cast' }]);
});

test('enrichMissing fills titles matched before v0.9.0, marks ones with nothing so they are not asked again, and skips unmatched titles', async () => {
  const old = addItem({ title: 'Alien', year: 1979, tmdb_id: 348, metadata_at: 1 });
  const quiet = addItem({ title: 'Quiet Film', year: 2001, tmdb_id: 900, metadata_at: 1 });
  const noMatch = addItem({ title: 'Home Video', year: 2021 });
  const r = await metadata.enrichMissing();
  assert.equal(r.done, 2);
  assert.deepEqual(JSON.parse(row(old).keywords), ['space', 'android']);
  assert.equal(JSON.parse(row(quiet).keywords).length, 0);
  assert.deepEqual(JSON.parse(row(quiet).trailer), { site: 'none' }, 'no trailer on TMDB is remembered');
  assert.equal(row(noMatch).keywords, '[]');
  assert.equal((await metadata.enrichMissing()).done, 0, 'nothing left, Quiet Film included');
});
