// Play history: when a play is counted (half a song or 4 minutes of listening; a film when watched), one row per
// playing (a resume within 6 hours keeps its row), and only listened time counts — seeking ahead doesn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Plays } from '../src/library/plays.js';

function setup() {
  const db = openDatabase(path.join(tempDir(), 'plays.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', 1)");
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, 1)");
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'All', 'movies', '[]', '{}', 1)");
  const add = (id, kind, duration) => {
    db.run('INSERT INTO items (id, library_id, kind, title, duration, added_at, updated_at) VALUES (?, 1, ?, ?, ?, 1, 1)', id, kind, `${kind}${id}`, duration);
    return db.get('SELECT * FROM items WHERE id = ?', id);
  };
  const clock = { t: 1_000_000_000_000 };
  const plays = new Plays({ db, now: () => clock.t });
  const started = [];
  const counted = [];
  plays.onStarted((e) => started.push(e));
  plays.onCounted((e) => counted.push(e));
  return { db, add, clock, plays, started, counted };
}

/** Report `positions` with the wall clock moving as fast as the position (a normal listen). */
function listen(s, item, positions, extra = {}) {
  let last = positions[0];
  let out;
  for (const p of positions) {
    s.clock.t += (p - last) * 1000;
    last = p;
    out = s.plays.report({ profileId: 1, item, position: p, duration: item.duration, client: 'browser', ...extra });
  }
  return out;
}

test('a song is counted after half its length', () => {
  const s = setup();
  const song = s.add(1, 'track', 300);
  assert.equal(listen(s, song, [0, 60, 120]).counted, false);
  const at150 = listen(s, song, [120, 150]);
  assert.equal(at150.counted, true);
  assert.equal(at150.justCounted, true);
  assert.equal(listen(s, song, [150, 200]).justCounted, false);
  assert.equal(s.counted.length, 1);
  assert.equal(s.counted[0].item.id, 1);
  assert.equal(s.counted[0].client, 'browser');
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM plays').n, 1);
});

test('a long song is counted after 4 minutes', () => {
  const s = setup();
  const song = s.add(1, 'track', 900);
  assert.equal(listen(s, song, [0, 120, 230]).counted, false);
  assert.equal(listen(s, song, [230, 240]).counted, true);
});

test("seeking ahead doesn't count a song", () => {
  const s = setup();
  const song = s.add(1, 'track', 300);
  s.plays.report({ profileId: 1, item: song, position: 0, duration: 300, client: 'browser' });
  s.clock.t += 2000;
  const r = s.plays.report({ profileId: 1, item: song, position: 290, duration: 300, client: 'browser' });
  assert.equal(r.counted, false);
  assert.ok(s.db.get('SELECT seconds FROM plays').seconds <= 7);
});

test('a film is counted when watched', () => {
  const s = setup();
  const film = s.add(1, 'movie', 6000);
  assert.equal(listen(s, film, [0, 60]).counted, false);
  assert.equal(s.plays.report({ profileId: 1, item: film, position: 5900, duration: 6000, watched: true, client: 'cast' }).counted, true);
  assert.equal(s.plays.report({ profileId: 1, item: film, position: 5950, duration: 6000, watched: true, client: 'cast' }).justCounted, false);
  assert.equal(s.counted.length, 1);
  assert.equal(s.db.get('SELECT client FROM plays').client, 'browser');
});

test('a resume within 6 hours keeps its play', () => {
  const s = setup();
  const film = s.add(1, 'movie', 6000);
  const a = s.plays.report({ profileId: 1, item: film, position: 10, client: 'browser' });
  s.clock.t += 5 * 3600_000;
  const b = s.plays.report({ profileId: 1, item: film, position: 20, client: 'browser' });
  assert.equal(b.playId, a.playId);
  s.clock.t += 7 * 3600_000;
  const c = s.plays.report({ profileId: 1, item: film, position: 30, client: 'browser' });
  assert.notEqual(c.playId, a.playId);
  assert.equal(s.started.length, 2);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM plays').n, 2);
});

test('shows, albums and live ids write nothing', () => {
  const s = setup();
  for (const [id, kind] of [[1, 'show'], [2, 'album'], [3, 'artist']]) {
    assert.deepEqual(s.plays.report({ profileId: 1, item: s.add(id, kind, null), position: 10, client: 'browser' }), { playId: null, counted: false, justCounted: false });
  }
  assert.deepEqual(s.plays.report({ profileId: 1, item: { id: 'live:4', kind: 'channel' }, position: 10, client: 'browser' }), { playId: null, counted: false, justCounted: false });
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM plays').n, 0);
});

test("pausing, then seeking to the end, doesn't count a song", () => {
  const s = setup();
  const song = s.add(1, 'track', 300);
  s.plays.report({ profileId: 1, item: song, position: 0, duration: 300, client: 'browser' });
  s.clock.t += 10_000;
  s.plays.report({ profileId: 1, item: song, position: 10, duration: 300, paused: true, client: 'browser' });
  s.clock.t += 300_000; // away for 5 minutes, then a jump to the end on resume
  const r = s.plays.report({ profileId: 1, item: song, position: 290, duration: 300, client: 'browser' });
  assert.equal(r.counted, false);
  assert.ok(s.db.get('SELECT seconds FROM plays').seconds <= 15);
  // Listening on from there still counts normally.
  assert.equal(listen(s, song, [290, 300]).counted, false);
});

test('a song played twice in a row counts twice', () => {
  const s = setup();
  const song = s.add(1, 'track', 200);
  assert.equal(listen(s, song, [0, 50, 100, 150, 200]).counted, true);
  s.clock.t += 2000;
  const again = s.plays.report({ profileId: 1, item: song, position: 0, duration: 200, client: 'browser' });
  assert.equal(again.counted, false, 'a new play');
  listen(s, song, [0, 50, 100, 150]);
  assert.equal(s.counted.length, 2);
  assert.equal(s.started.length, 2);
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM plays WHERE counted = 1').n, 2);
  // Scrubbing back a little in a counted song is not a replay.
  const before = s.db.get('SELECT COUNT(*) AS n FROM plays').n;
  s.plays.report({ profileId: 1, item: song, position: 60, duration: 200, client: 'browser' });
  assert.equal(s.db.get('SELECT COUNT(*) AS n FROM plays').n, before);
});

// ---- v0.21 tidy-up ----
test('the recent map is pruned from its oldest end (a report never walks the whole map)', () => {
  const s = setup();
  const song = s.add(500, 'track', 200);
  let steps = 0;
  class Counting extends Map {
    [Symbol.iterator]() {
      const it = super[Symbol.iterator]();
      return { next: () => (steps++, it.next()), [Symbol.iterator]() { return this; } };
    }
  }
  s.plays.last = new Counting();
  for (let i = 0; i < 2500; i++) s.plays.last.set(`1:${10_000 + i}`, { position: 0, at: s.clock.t, playId: 0, paused: false });
  steps = 0;
  s.plays.report({ profileId: 1, item: song, position: 1, duration: 200, client: 'browser' });
  assert.ok(steps <= 2, `walked ${steps} entries`);
  s.clock.t += 7 * 3600_000; // everything older than 6 hours goes, oldest first
  s.plays.report({ profileId: 1, item: song, position: 2, duration: 200, client: 'browser' });
  assert.equal(s.plays.last.size, 1);
});
