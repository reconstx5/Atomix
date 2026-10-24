// Stats from play history: hours watched and listened per range, the top lists (counted plays), the day × hour grid
// in the viewer's own time, each profile its own; the household table for admins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir, startAtomix, client, hasFfmpeg } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { profileStats, householdStats } from '../src/stats.js';

const DAY = 86400_000;
// Monday 2026-10-12 21:00 in NZ time (UTC+13) is Monday 08:00 UTC.
const NOW = Date.UTC(2026, 9, 14, 12, 0); // Wednesday
const MON_9PM_NZ = Date.UTC(2026, 9, 12, 8, 0);
const NZ = -780; // getTimezoneOffset() in Auckland in October

function setup() {
  const db = openDatabase(path.join(tempDir(), 'stats.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'admin', 1)");
  db.run("INSERT INTO profiles (id, user_id, name, avatar, is_primary, kids, created_at) VALUES (1, 1, 'Dallas', 'blue', 1, 0, 1), (2, 1, 'Mia', 'teal', 0, 1, 2)");
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'All', 'movies', '[]', '{}', 1)");
  const add = (id, kind, title, extra = {}) => db.run('INSERT INTO items (id, library_id, kind, title, parent_id, show_id, added_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, 1, 1)', id, kind, title, extra.parent ?? null, extra.show ?? null);
  add(1, 'movie', 'Alien');
  add(2, 'movie', 'Cartoon');
  add(10, 'show', 'Bluey');
  add(11, 'season', 'Season 1', { parent: 10, show: 10 });
  add(12, 'episode', 'Ep 1', { parent: 11, show: 10 });
  add(13, 'episode', 'Ep 2', { parent: 11, show: 10 });
  add(20, 'artist', 'The Band');
  add(21, 'album', 'First Record', { parent: 20, show: 20 });
  add(22, 'track', 'Opening', { parent: 21, show: 20 });
  add(23, 'track', 'Closer', { parent: 21, show: 20 });
  const play = (profile, item, at, seconds, counted = 1) => db.run("INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (?, ?, ?, ?, ?, ?, 'browser')", profile, item, at, at, seconds, counted);
  play(1, 1, MON_9PM_NZ, 7200); // 2 h film, Monday 9 PM NZ
  play(1, 12, NOW - 1 * DAY, 420);
  play(1, 13, NOW - 1 * DAY, 420);
  play(1, 12, NOW - 2 * DAY, 420);
  play(1, 2, NOW - 8 * DAY, 3600); // a month ago-ish: month, not week
  play(1, 22, NOW - 1 * DAY, 180);
  play(1, 22, NOW - 1 * DAY, 180);
  play(1, 23, NOW - 1 * DAY, 180);
  play(1, 23, NOW - 3 * DAY, 30, 0); // skipped: not counted, but its time counts
  play(1, 1, NOW - 40 * DAY, 3600); // year only
  play(2, 2, NOW - 1 * DAY, 1800); // Mia's
  return db;
}

test('hours per range, watched and listened', () => {
  const db = setup();
  const week = profileStats(db, 1, { range: 'week', tzOffset: NZ, now: NOW });
  assert.equal(week.watchedHours, Math.round(((7200 + 420 * 3) / 3600) * 10) / 10);
  assert.equal(week.listenedHours, Math.round(((180 * 3 + 30) / 3600) * 10) / 10);
  assert.equal(profileStats(db, 1, { range: 'month', tzOffset: NZ, now: NOW }).watchedHours, Math.round(((7200 + 1260 + 3600) / 3600) * 10) / 10);
  assert.equal(profileStats(db, 1, { range: 'year', tzOffset: NZ, now: NOW }).watchedHours, Math.round(((7200 + 1260 + 3600 + 3600) / 3600) * 10) / 10);
});

test('the top lists count counted plays', () => {
  const db = setup();
  const s = profileStats(db, 1, { range: 'year', tzOffset: NZ, now: NOW });
  assert.deepEqual(s.topFilms, [{ id: 1, title: 'Alien', plays: 2 }, { id: 2, title: 'Cartoon', plays: 1 }]);
  assert.deepEqual(s.topShows, [{ id: 10, title: 'Bluey', plays: 3 }]);
  assert.deepEqual(s.topArtists, [{ id: 20, title: 'The Band', plays: 3 }]);
  assert.deepEqual(s.topSongs, [{ id: 22, title: 'Opening', plays: 2 }, { id: 23, title: 'Closer', plays: 1 }], 'the skipped play is not counted');
});

test('the grid is in the viewer’s own time, Monday first', () => {
  const db = setup();
  const s = profileStats(db, 1, { range: 'week', tzOffset: NZ, now: NOW });
  assert.equal(s.grid.length, 7);
  assert.ok(s.grid.every((d) => d.length === 24));
  assert.equal(s.grid[0][21], 2);
  const utc = profileStats(db, 1, { range: 'week', tzOffset: 0, now: NOW });
  assert.equal(utc.grid[0][8], 2, 'the same play at 08:00 in UTC');
});

test("each profile sees its own", () => {
  const db = setup();
  const mia = profileStats(db, 2, { range: 'week', tzOffset: NZ, now: NOW });
  assert.equal(mia.watchedHours, 0.5);
  assert.deepEqual(mia.topFilms, [{ id: 2, title: 'Cartoon', plays: 1 }]);
  assert.deepEqual(mia.topSongs, []);
});

test('the household table', () => {
  const db = setup();
  const h = householdStats(db, { now: NOW });
  assert.deepEqual(h.map((r) => r.name), ['Dallas', 'Mia']);
  assert.equal(h[1].kids, true);
  assert.equal(h[1].week, 0.5);
  assert.equal(h[0].year, Math.round(((7200 + 1260 + 3600 + 3600 + 570) / 3600) * 10) / 10);
});

test('routes: own stats for anyone, household for admins only', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const nf = await startAtomix();
  try {
    const admin = client(nf.base);
    await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
    const me = (await admin.get('/api/me/stats?range=month&tz=-780')).data;
    assert.equal(me.range, 'month');
    assert.equal(me.watchedHours, 0);
    assert.equal(me.grid.length, 7);
    assert.equal((await admin.get('/api/me/stats?range=decade')).status, 400);
    const house = (await admin.get('/api/admin/stats')).data;
    assert.deepEqual(house.map((r) => r.name), ['dallas']);
    const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data;
    const kid = client(nf.base);
    await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
    await kid.post(`/api/profiles/${mia.id}/select`, {});
    assert.equal((await kid.get('/api/admin/stats')).status, 403);
    assert.equal((await kid.get('/api/me/stats')).status, 200);
  } finally {
    await nf.app.stop();
  }
});

// ---- v0.21 tidy-up ----
test('plays across a daylight-saving change land in their own local hour (the zone, not one offset)', () => {
  const db = setup();
  db.run('DELETE FROM plays');
  // 20:00 in Auckland in January (NZDT, +13) and in July (NZST, +12).
  const jan = Date.UTC(2026, 0, 14, 7, 0); // Wed 14 Jan 20:00 NZDT
  const jul = Date.UTC(2026, 6, 15, 8, 0); // Wed 15 Jul 20:00 NZST
  for (const at of [jan, jul]) db.run("INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (1, 1, ?, ?, 3600, 1, 'browser')", at, at);
  const s = profileStats(db, 1, { range: 'year', tz: 'Pacific/Auckland', tzOffset: -720, now: Date.UTC(2026, 7, 1) });
  assert.equal(s.grid[2][20], 2, 'both Wednesday 8 PM');
  assert.equal(s.grid[2][19], 0);
});
