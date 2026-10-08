// Picks: "Because you watched" and "More like this", scored from the library itself.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Collections } from '../src/collections.js';
import { Picks } from '../src/picks.js';

let db, library, collections, picks;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
const J = JSON.stringify;
function movie(title, { year = 2000, genres = [], keywords = [], director = null, cast = [], min_age = null, rating = 6 } = {}) {
  const people = [...(director ? [{ name: director, role: 'director' }] : []), ...cast.map((name) => ({ name, role: 'cast' }))];
  return Number(
    db.run(
      "INSERT INTO items (library_id, kind, title, year, genres, keywords, people, min_age, rating, path, size, mtime, duration, media, added_at, updated_at) VALUES (1, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 100, ?, ?, ?)",
      title, year, J(genres), J(keywords), J(people), min_age, rating, `/m/${++seq}`, VIDEO, now, now,
    ).lastInsertRowid,
  );
}
const adult = { userId: 1, profileId: 1, kids: false, maxAge: null, allowUnrated: true, libraryIds: null };
const kid = { userId: 1, profileId: 2, kids: true, maxAge: 10, allowUnrated: false, libraryIds: null };
const ids = {};

before(() => {
  db = openDatabase(path.join(tempDir(), 'p.db'));
  library = new Library(db);
  collections = new Collections({ db, library });
  picks = new Picks({ db, library, collections, ttlMs: 10 * 60 * 1000 });
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('d', 'd', 'x', 'admin', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'dallas', 'blue', 1, ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, kids, max_age, created_at) VALUES (1, 'Mia', 'green', 0, 1, 10, ?)", now);
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now);
  ids.alien = movie('Alien', { year: 1979, genres: ['Horror', 'Sci-Fi'], keywords: ['space', 'android', 'monster'], director: 'Ridley Scott', cast: ['Sigourney Weaver', 'Tom Skerritt'], min_age: 16 });
  ids.aliens = movie('Aliens', { year: 1986, genres: ['Action', 'Sci-Fi'], keywords: ['space', 'android', 'marines'], director: 'James Cameron', cast: ['Sigourney Weaver'], min_age: 16, rating: 8 }); // collection 5 + kw 6 + cast 2 + genre 1 = 14
  ids.bladerunner = movie('Blade Runner', { year: 1982, genres: ['Sci-Fi'], keywords: ['android', 'dystopia'], director: 'Ridley Scott', min_age: 16 }); // kw 3 + director 3 + genre 1 = 7 (1979 and 1982 are different decades)
  ids.thing = movie('The Thing', { year: 1982, genres: ['Horror', 'Sci-Fi'], keywords: ['monster', 'isolation'], min_age: 16 }); // kw 3 + genres 2 = 5
  ids.cartoon = movie('Cartoon', { year: 2020, genres: ['Animation'], keywords: ['space'], min_age: 0 }); // kw 3 = 3 (kept)
  ids.romcom = movie('Romcom', { year: 2019, genres: ['Comedy'], keywords: ['wedding'], min_age: 8 }); // 0 (dropped)
  ids.gladiator = movie('Gladiator', { year: 2000, genres: ['Action'], director: 'Ridley Scott', min_age: 13 }); // director 3 = 3
  ids.collection = collections.create({ name: 'Alien films', itemIds: [ids.alien, ids.aliens] }).id;
});

test('similar: scored and ordered as the spec says, the seed excluded, below 3 dropped', () => {
  const s = picks.similar(ids.alien, adult);
  assert.deepEqual(s.map((i) => [i.title, i.score]), [['Aliens', 14], ['Blade Runner', 7], ['The Thing', 5], ['Cartoon', 3], ['Gladiator', 3]]);
});

test('unwatched first, then by score; a kid only gets kid-safe picks', () => {
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (1, ?, 0, 100, 1, ?)', ids.aliens, now);
  picks.clear();
  const s = picks.similar(ids.alien, adult);
  assert.deepEqual(s.map((i) => i.title), ['Blade Runner', 'The Thing', 'Cartoon', 'Gladiator', 'Aliens']);
  assert.deepEqual(picks.similar(ids.cartoon, kid).map((i) => i.title), [], 'nothing safe shares enough with Cartoon');
});

test('becauseYouWatched: two seeds from what was watched last, most recent first', () => {
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (1, ?, 30, 100, 0, ?)', ids.alien, now + 1000);
  picks.clear();
  const rows = picks.becauseYouWatched(adult);
  assert.deepEqual(rows.map((r) => r.seed.title), ['Alien', 'Aliens']);
  assert.equal(rows[0].items[0].title, 'Blade Runner');
});

test('the cache holds until cleared', () => {
  const a = picks.similar(ids.alien, adult);
  movie('Prometheus', { year: 2012, genres: ['Sci-Fi'], keywords: ['space', 'android'], director: 'Ridley Scott', min_age: 16 });
  assert.equal(picks.similar(ids.alien, adult).length, a.length, 'cached');
  picks.clear();
  assert.ok(picks.similar(ids.alien, adult).some((i) => i.title === 'Prometheus'));
});

test("a profile's changed rules bypass the cache at once, and progress is always fresh", () => {
  picks.clear();
  const before = picks.similar(ids.alien, adult).map((i) => i.title);
  assert.ok(before.includes('Blade Runner'));
  // The same profile, now limited to 12: hidden titles leave the picks without a clear (the cache key is the rules).
  const limited = { ...adult, maxAge: 12, allowUnrated: false };
  assert.ok(!picks.similar(ids.alien, limited).some((i) => i.title === 'Blade Runner'));
  // Watching something between two cached reads shows in the cached items' progress.
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (1, ?, 50, 100, 0, ?)', ids.bladerunner, now + 2000);
  const br = picks.similar(ids.alien, adult).find((i) => i.title === 'Blade Runner');
  assert.equal(br.progress?.position, 50, 'progress comes fresh on every read');
});

test('scoring reads the collection map once, not once per candidate', () => {
  picks.clear();
  let gets = 0;
  const orig = db.get.bind(db);
  db.get = (...a) => { gets++; return orig(...a); };
  picks.similar(ids.alien, adult);
  db.get = orig;
  assert.ok(gets <= 2, `db.get called ${gets} times for one seed`);
});
