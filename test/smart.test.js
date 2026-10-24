// Smart playlists: rule checking (with sentences naming the rule) and evaluation — every field type, all/any, the
// sorts, the limits, episodes following their show and songs their album, and text matched literally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { validateRules, smartRows } from '../src/library/smart.js';

const DAY = 86400_000;
const NOW = Date.now();
const viewer = { userId: 1, profileId: 1, kids: false, maxAge: null, allowUnrated: true, libraryIds: null };

function setup() {
  const db = openDatabase(path.join(tempDir(), 'smart.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', 1)");
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, 1)");
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'V', 'movies', '[]', '{}', 1), (2, 'M', 'music', '[]', '{}', 1)");
  const add = (o) =>
    db.run(
      'INSERT INTO items (id, library_id, kind, parent_id, show_id, title, sort_title, artist, year, season, episode, genres, duration, min_age, added_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      o.id, o.lib || 1, o.kind, o.parent ?? null, o.show ?? null, o.title, o.title, o.artist ?? null, o.year ?? null, o.season ?? null, o.episode ?? null,
      JSON.stringify(o.genres || []), o.duration ?? null, o.age ?? null, o.added ?? NOW - 100 * DAY, 1,
    );
  // Films
  add({ id: 1, kind: 'movie', title: 'Alien', year: 1979, genres: ['Horror', 'Sci-Fi'], duration: 7020, age: 16, added: NOW - 2 * DAY });
  add({ id: 2, kind: 'movie', title: 'Aliens', year: 1986, genres: ['Action', 'Sci-Fi'], duration: 8220, age: 16 });
  add({ id: 3, kind: 'movie', title: 'Cartoon', year: 2020, genres: ['Animation', '50%_Off "x"'], duration: 5400, age: 0 });
  // A show with two episodes (genre, stars and age come from the show)
  add({ id: 10, kind: 'show', title: 'Bluey', year: 2018, genres: ['Kids'], age: 0 });
  add({ id: 11, kind: 'season', parent: 10, show: 10, title: 'Season 1', season: 1 });
  add({ id: 12, kind: 'episode', parent: 11, show: 10, title: 'Magic Xylophone', season: 1, episode: 1, duration: 420 });
  add({ id: 13, kind: 'episode', parent: 11, show: 10, title: 'Hospital', season: 1, episode: 2, duration: 420 });
  // Music: 2 artists, 2 albums, 4 songs (year and genre from the album)
  add({ id: 20, lib: 2, kind: 'artist', title: 'The Band' });
  add({ id: 21, lib: 2, kind: 'artist', title: 'Other Folk' });
  add({ id: 30, lib: 2, kind: 'album', parent: 20, show: 20, title: 'First Record', year: 1985, genres: ['Rock'] });
  add({ id: 31, lib: 2, kind: 'album', parent: 21, show: 21, title: 'Quiet Songs', year: 2001, genres: ['Folk'] });
  add({ id: 40, lib: 2, kind: 'track', parent: 30, show: 20, title: 'Opening', artist: 'The Band', season: 1, episode: 1, duration: 180, added: NOW - 1 * DAY });
  add({ id: 41, lib: 2, kind: 'track', parent: 30, show: 20, title: 'Closer', artist: 'The Band feat. Guest', season: 1, episode: 2, duration: 240 });
  add({ id: 42, lib: 2, kind: 'track', parent: 31, show: 21, title: 'Hush', artist: 'Other Folk', season: 1, episode: 1, duration: 150, genres: ['Ambient'] });
  add({ id: 43, lib: 2, kind: 'track', parent: 31, show: 21, title: 'Lull', artist: 'Other Folk', season: 1, episode: 2, duration: 600 });
  const rate = (item, stars, fav = 0) => db.run('INSERT INTO user_ratings (profile_id, item_id, stars, favourite, updated_at) VALUES (1, ?, ?, ?, 1)', item, stars, fav);
  rate(1, 5, 1);
  rate(2, 3);
  rate(10, 4, 1);
  rate(40, 5);
  rate(42, 2, 1);
  const play = (item, at, counted = 1) => db.run("INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (1, ?, ?, ?, 0, ?, 'browser')", item, at, at, counted);
  play(40, NOW - 1 * DAY);
  play(40, NOW - 2 * DAY);
  play(40, NOW - 3 * DAY);
  play(41, NOW - 40 * DAY);
  play(1, NOW - 5 * DAY);
  play(2, NOW - 60 * DAY, 0); // started, never counted
  const library = new Library(db);
  const run = (media, input, opts = {}) => smartRows(db, library, { media, rules: JSON.stringify(validateRules(media, input)) }, opts.viewer || viewer, { seed: opts.seed ?? 1 });
  const titles = (media, input, opts) => run(media, input, opts).map((r) => r.title);
  return { db, library, run, titles };
}

const one = (field, op, value, sort = 'title') => ({ match: 'all', rules: [{ field, op, value }], sort, limit: {} });
const sorted = (a) => [...a].sort();

test('text rules', () => {
  const s = setup();
  assert.deepEqual(s.titles('video', one('genre', 'is', 'sci-fi')), ['Alien', 'Aliens']);
  assert.deepEqual(sorted(s.titles('video', one('genre', 'isNot', 'Sci-Fi'))), ['Cartoon', 'Hospital', 'Magic Xylophone']);
  assert.deepEqual(s.titles('video', one('genre', 'contains', 'anim')), ['Cartoon']);
  assert.deepEqual(s.titles('music', one('albumArtist', 'is', 'the band')), ['Closer', 'Opening']);
  assert.deepEqual(s.titles('music', one('artist', 'contains', 'feat')), ['Closer']);
  assert.deepEqual(s.titles('music', one('album', 'is', 'Quiet Songs')), ['Hush', 'Lull']);
});

test('number rules', () => {
  const s = setup();
  assert.deepEqual(s.titles('video', one('year', 'between', [1980, 1990])), ['Aliens']);
  assert.deepEqual(s.titles('video', one('stars', 'gte', 4)), ['Alien', 'Hospital', 'Magic Xylophone']);
  assert.deepEqual(sorted(s.titles('music', one('playCount', 'is', 0))), ['Hush', 'Lull']);
  assert.deepEqual(s.titles('music', one('length', 'lte', 3.5)), ['Hush', 'Opening']);
  assert.deepEqual(s.titles('music', one('stars', 'notSet')), ['Closer', 'Lull']);
  assert.deepEqual(s.titles('video', one('ageRating', 'lte', 0)), ['Cartoon', 'Hospital', 'Magic Xylophone']);
  assert.deepEqual(s.titles('video', one('playCount', 'gte', 1)), ['Alien']);
});

test('date rules', () => {
  const s = setup();
  assert.deepEqual(s.titles('video', one('added', 'inLast', 7)), ['Alien']);
  assert.deepEqual(s.titles('music', one('lastPlayed', 'notInLast', 30)), ['Closer', 'Hush', 'Lull']);
  assert.deepEqual(s.titles('music', one('lastPlayed', 'notSet')), ['Hush', 'Lull']);
  assert.deepEqual(s.titles('video', one('lastPlayed', 'inLast', 90)), ['Alien', 'Aliens'], 'any play, counted or not');
});

test('favourite and kind rules', () => {
  const s = setup();
  assert.deepEqual(s.titles('video', one('favourite', 'is', true)), ['Alien', 'Hospital', 'Magic Xylophone']);
  assert.deepEqual(s.titles('music', one('favourite', 'is', false)), ['Closer', 'Lull', 'Opening']);
  assert.deepEqual(s.titles('video', one('kind', 'is', 'episode')), ['Hospital', 'Magic Xylophone']);
});

test('episodes follow their show', () => {
  const s = setup();
  assert.deepEqual(s.titles('video', one('genre', 'is', 'Kids')), ['Hospital', 'Magic Xylophone']);
  assert.deepEqual(s.titles('video', one('stars', 'is', 4)), ['Hospital', 'Magic Xylophone']);
});

test('tracks follow their album', () => {
  const s = setup();
  assert.deepEqual(s.titles('music', one('year', 'is', 1985)), ['Closer', 'Opening']);
  assert.deepEqual(s.titles('music', one('genre', 'is', 'Folk')), ['Lull'], "a song's own genre wins");
  assert.deepEqual(s.titles('music', one('genre', 'is', 'Ambient')), ['Hush']);
});

test('match any and match all', () => {
  const s = setup();
  const rules = [{ field: 'genre', op: 'is', value: 'Horror' }, { field: 'genre', op: 'is', value: 'Action' }];
  assert.deepEqual(s.titles('video', { match: 'any', rules, sort: 'title', limit: {} }), ['Alien', 'Aliens']);
  assert.deepEqual(s.titles('video', { match: 'all', rules, sort: 'title', limit: {} }), []);
  assert.equal(s.titles('video', { match: 'all', rules: [], sort: 'title', limit: {} }).length, 5, 'no rules: everything');
});

test('sorts', () => {
  const s = setup();
  const by = (media, sort) => s.titles(media, { match: 'all', rules: [], sort, limit: {} });
  assert.deepEqual(by('music', 'mostPlayed').slice(0, 2), ['Opening', 'Closer']);
  assert.deepEqual(by('music', 'lastPlayed'), ['Opening', 'Closer', 'Hush', 'Lull']);
  assert.deepEqual(by('music', 'stars'), ['Opening', 'Hush', 'Closer', 'Lull']);
  assert.deepEqual(by('music', 'title'), ['Closer', 'Hush', 'Lull', 'Opening']);
  assert.deepEqual(by('video', 'year'), ['Cartoon', 'Hospital', 'Magic Xylophone', 'Aliens', 'Alien']);
  assert.deepEqual(by('music', 'added')[0], 'Opening');
});

test('random order holds between opening and playing', () => {
  const s = setup();
  for (let i = 100; i < 120; i++) s.db.run("INSERT INTO items (id, library_id, kind, parent_id, show_id, title, sort_title, duration, added_at, updated_at) VALUES (?, 2, 'track', 30, 20, ?, ?, 100, 1, 1)", i, `T${i}`, `T${i}`);
  const all = { match: 'all', rules: [], sort: 'random', limit: {} };
  const a = s.titles('music', all, { seed: 12345 });
  assert.deepEqual(s.titles('music', all, { seed: 12345 }), a);
  assert.notDeepEqual(s.titles('music', all, { seed: 999 }), a);
  assert.equal(a.length, 24);
});

test('limits', () => {
  const s = setup();
  const lim = (limit, sort = 'title') => s.titles('music', { match: 'all', rules: [], sort, limit });
  assert.deepEqual(lim({ items: 2 }), ['Closer', 'Hush']);
  assert.deepEqual(lim({ minutes: 5 }), ['Closer'], '4 min then 2.5 min would go over');
  assert.deepEqual(lim({ minutes: 7 }), ['Closer', 'Hush']);
  // The first song is always taken, even when it's longer than the limit.
  assert.deepEqual(s.titles('music', { match: 'all', rules: [], sort: 'mostPlayed', limit: { minutes: 1 } }), ['Opening']);
  assert.deepEqual(s.titles('music', { match: 'all', rules: [{ field: 'album', op: 'is', value: 'Quiet Songs' }], sort: 'title', limit: { minutes: 5 } }).length, 1);
  const lull = s.titles('music', { match: 'all', rules: [{ field: 'length', op: 'gte', value: 9 }], sort: 'title', limit: { minutes: 5 } });
  assert.deepEqual(lull, ['Lull']);
});

test('contains matches text literally', () => {
  const s = setup();
  assert.deepEqual(s.titles('video', one('genre', 'contains', '%_O')), ['Cartoon']);
  assert.deepEqual(s.titles('video', one('genre', 'contains', '_')), ['Cartoon']);
  assert.deepEqual(s.titles('video', one('genre', 'contains', '"x"')), ['Cartoon']);
  assert.deepEqual(s.titles('video', one('genre', 'is', "x'; DROP TABLE items; --")), []);
  assert.equal(s.titles('video', one('genre', 'contains', 'a'.repeat(200))).length, 0);
  assert.throws(() => validateRules('video', one('genre', 'contains', 'a'.repeat(201))), { message: 'Rule 1: give some text (200 characters at most).' });
});

test('a Kids viewer gets only what their rules allow', () => {
  const s = setup();
  const kid = { userId: 1, profileId: 1, kids: true, maxAge: 10, allowUnrated: false, libraryIds: null };
  assert.deepEqual(s.titles('video', { match: 'all', rules: [], sort: 'title', limit: {} }, { viewer: kid }), ['Cartoon', 'Hospital', 'Magic Xylophone']);
  assert.deepEqual(s.titles('video', { match: 'all', rules: [], sort: 'title', limit: {} }, { viewer: { ...viewer, libraryIds: [2] } }), []);
});

test('rule errors name the rule', () => {
  const bad = (media, input, message) => assert.throws(() => validateRules(media, input), { message }, message);
  const r = (...rules) => ({ match: 'all', rules, sort: 'title', limit: {} });
  bad('music', r({ field: 'genre', op: 'is', value: 'Rock' }, { field: 'mood', op: 'is', value: 'x' }), 'Rule 2: Atomix doesn\'t know "mood".');
  bad('video', r({ field: 'album', op: 'is', value: 'x' }), 'Rule 1: Atomix doesn\'t know "album".');
  bad('music', r({ field: 'kind', op: 'is', value: 'movie' }), 'Rule 1: Atomix doesn\'t know "kind".');
  bad('video', r({ field: 'genre', op: 'gte', value: 3 }), 'Rule 1: "gte" doesn\'t work with genre.');
  bad('video', r({ field: 'playCount', op: 'set' }), 'Rule 1: "set" doesn\'t work with play count.');
  bad('video', r({ field: 'year', op: 'gte', value: 'soon' }), 'Rule 1: give a number.');
  bad('video', r({ field: 'year', op: 'between', value: [1990] }), 'Rule 1: give two numbers, lowest first.');
  bad('video', r({ field: 'year', op: 'between', value: [1990, 1980] }), 'Rule 1: give two numbers, lowest first.');
  bad('video', r({ field: 'added', op: 'inLast', value: 0 }), 'Rule 1: give a number of days.');
  bad('video', r({ field: 'added', op: 'inLast', value: 2.5 }), 'Rule 1: give a number of days.');
  bad('video', r({ field: 'genre', op: 'is', value: '  ' }), 'Rule 1: give some text (200 characters at most).');
  bad('video', r({ field: 'favourite', op: 'is', value: 'maybe' }), 'Rule 1: choose yes or no.');
  bad('video', r({ field: 'kind', op: 'is', value: 'show' }), 'Rule 1: choose Film or Episode.');
  bad('video', { match: 'all', rules: [], sort: 'loudest', limit: {} }, 'Choose how to sort.');
  bad('video', { match: 'all', rules: Array.from({ length: 21 }, () => ({ field: 'year', op: 'is', value: 1 })), sort: 'title', limit: {} }, 'A smart playlist has at most 20 rules.');
  bad('video', { match: 'all', rules: [], sort: 'title', limit: { items: 0 } }, 'Give a limit of 1 to 1000 items or 1 to 10000 minutes.');
  bad('video', { match: 'all', rules: [], sort: 'title', limit: { minutes: 10001 } }, 'Give a limit of 1 to 1000 items or 1 to 10000 minutes.');
  bad('video', { match: 'all', rules: 'x', sort: 'title', limit: {} }, 'Add some rules, or none for everything.');
  // A good set comes back cleaned up (numbers as numbers, trimmed text, a match).
  assert.deepEqual(validateRules('video', { rules: [{ field: 'year', op: 'gte', value: '1990' }, { field: 'genre', op: 'is', value: ' Drama ' }], sort: 'random' }), {
    match: 'all',
    rules: [{ field: 'year', op: 'gte', value: 1990 }, { field: 'genre', op: 'is', value: 'Drama' }],
    sort: 'random',
    limit: {},
  });
});
