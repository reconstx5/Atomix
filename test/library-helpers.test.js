// Library helpers for plugin Home rows (v0.23): titles by keyword, stalled shows, part-seen film series and what a
// profile played on a day — every one filtered for the viewer (Kids rules included).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';

const DAY = 86_400_000;
const now = Date.now();
let db, library;
let seq = 0;
const grown = { userId: 1, profileId: 1, kids: false, maxAge: null, allowUnrated: true, libraryIds: null };
const kid = { userId: 1, profileId: 2, kids: true, maxAge: 10, allowUnrated: false, libraryIds: null };
function add(f) {
  const fields = { library_id: 1, kind: 'movie', title: `T${++seq}`, path: `/m/${seq}`, size: 1, mtime: 1, genres: '[]', keywords: '[]', min_age: 0, ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const watch = (profile, item, at, watched = 1) => db.run('INSERT OR REPLACE INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 100, 100, ?, ?)', profile, item, watched, at);
function show(title, minAge, eps) {
  const s = add({ kind: 'show', title, path: null, min_age: minAge });
  const ids = eps.map(([season, episode]) => add({ kind: 'episode', title: `${title} ${season}x${episode}`, show_id: s, season, episode, min_age: null }));
  return { s, ids };
}

before(() => {
  db = openDatabase(path.join(tempDir(), 'lh.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('d', 'd', 'x', 'admin', 0)");
  db.run("INSERT INTO profiles (id, user_id, name, avatar, is_primary, created_at) VALUES (1, 1, 'D', 'blue', 1, 0), (2, 1, 'Mia', 'teal', 0, 0)");
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('M', 'movies', '[]', '{}', 0)");
  library = new Library(db);
});

test('keyword finds titles by their TMDB keywords', () => {
  const yes = add({ title: 'Snowed In', keywords: '["christmas","snow"]' });
  add({ title: 'Eve', keywords: '["christmas eve"]' });
  assert.deepEqual(library.list({ viewer: grown, keyword: 'Christmas', kind: 'movie' }).map((r) => r.id), [yes]);
});

test('startedShows lists stalled shows with their next episode', () => {
  const a = show('Stalled', 0, [[1, 1], [1, 2]]);
  watch(1, a.ids[0], now - 20 * DAY);
  const b = show('Recent', 0, [[1, 1], [1, 2]]);
  watch(1, b.ids[0], now - 3 * DAY);
  const c = show('Done', 0, [[1, 1]]);
  watch(1, c.ids[0], now - 30 * DAY);
  const got = library.startedShows(grown, { idleDays: 14 });
  assert.deepEqual(got.map((r) => r.show.id), [a.s]);
  assert.equal(got[0].next.id, a.ids[1]);
  assert.equal(got[0].left, 1);
  assert.ok(library.startedShows(grown, { idleDays: 0 }).some((r) => r.show.id === b.s), 'idleDays 0: the recent one too');
});

test('startedShows leaves out a show whose regular episodes are all watched, whatever specials remain (review fix F2)', () => {
  const { ids } = show('Done Show', 0, [[1, 1], [1, 2], [0, 1]]);
  watch(1, ids[0], now - 30 * DAY);
  watch(1, ids[1], now - 29 * DAY);
  assert.ok(!library.startedShows(grown).some((x) => x.next.id === ids[2]), 'only a special is left: not started-and-left');
  const { ids: b } = show('Half Show', 0, [[1, 1], [1, 2], [0, 1]]);
  watch(1, b[0], now - 30 * DAY);
  const half = library.startedShows(grown).find((x) => x.next.id === b[1]);
  assert.equal(half?.left, 1, 'specials are not counted as left');
  assert.equal(half?.next.show_title, 'Half Show', 'the next episode carries its show (review fix F1)');
});

test('startedShows never offers a Kids profile a show outside its rules', () => {
  const r = show('Grown Show', 16, [[1, 1], [1, 2]]);
  watch(2, r.ids[0], now - 20 * DAY);
  assert.ok(!library.startedShows(kid, { idleDays: 14 }).some((x) => x.show.id === r.s));
});

test('partlySeenSeries offers the next unseen part', () => {
  const p1 = add({ title: 'Part One' });
  const p2 = add({ title: 'Part Two', min_age: 16 });
  const p3 = add({ title: 'Part Three' });
  const c = Number(db.run("INSERT INTO collections (name, manual, hidden, parts, created_at, updated_at) VALUES ('Trilogy', 0, 0, '[]', 0, 0)").lastInsertRowid);
  [p1, p2, p3].forEach((id, i) => db.run('INSERT INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)', c, id, i));
  watch(1, p1, now - DAY);
  watch(2, p1, now - DAY);
  const g = library.partlySeenSeries(grown).find((x) => x.collection.id === c);
  assert.equal(g.next.id, p2);
  assert.equal(g.seen, 1);
  assert.equal(g.total, 3);
  const k = library.partlySeenSeries(kid).find((x) => x.collection.id === c);
  assert.equal(k.next.id, p3, 'the R16 part is skipped');
  assert.equal(k.total, 2);
});

test('releasedOn finds films released on that day in earlier years', () => {
  const a = add({ title: 'Back Then', air_date: '1985-10-19' });
  const b = add({ title: 'Later', air_date: '2001-10-19' });
  add({ title: 'Next Day', air_date: '1985-10-20' });
  add({ title: 'Only Year', air_date: '1985' });
  add({ title: 'No Date', air_date: null });
  add({ title: 'This Year', air_date: `${new Date().getFullYear()}-10-19` });
  assert.deepEqual(library.list({ viewer: grown, kind: 'movie', releasedOn: '10-19', sort: 'title' }).map((r) => r.id), [a, b]);
});

test('partlySeenSeries says which part is next', () => {
  const parts = [1, 2, 3, 4].map((n) => add({ title: `Quad ${n}` }));
  const c = Number(db.run("INSERT INTO collections (name, manual, hidden, parts, created_at, updated_at) VALUES ('Quad', 0, 0, '[]', 0, 0)").lastInsertRowid);
  parts.forEach((id, i) => db.run('INSERT INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)', c, id, i));
  watch(1, parts[0], now - 5 * DAY);
  watch(1, parts[1], now - 4 * DAY);
  const g = library.partlySeenSeries(grown).find((x) => x.collection.id === c);
  assert.equal(g.next.id, parts[2]);
  assert.equal(g.part, 3);
  assert.equal(g.total, 4);
});

test('playedOn gives what this profile played that day', () => {
  const at = (iso) => Date.parse(iso);
  const x = add({ title: 'Morning' });
  const y = add({ title: 'Evening' });
  const z = add({ title: 'Next day' });
  const play = (profile, item, t) => db.run('INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted) VALUES (?, ?, ?, ?, 600, 1)', profile, item, t, t);
  play(1, x, at('2025-10-18T20:30:00Z')); // 19 Oct 09:30 in Auckland
  play(1, y, at('2025-10-19T08:00:00Z')); // 19 Oct 21:00
  play(1, z, at('2025-10-19T12:00:00Z')); // 20 Oct 01:00
  play(2, z, at('2025-10-19T01:00:00Z'));
  const got = library.playedOn(grown, '2025-10-19', { tz: 'Pacific/Auckland' }).map((r) => r.id);
  assert.deepEqual(got, [y, x]);
});

test('api.library has the helpers', async () => {
  const { fileURLToPath } = await import('node:url');
  const { startAtomix, client } = await import('./helpers.js');
  const nf = await startAtomix({ ATOMIX_PLUGINS_DIR: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'helper-plugins') }, { skipLiveRefresh: true });
  try {
    const admin = client(nf.base);
    await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
    const me = (await admin.get('/api/profiles')).data[0].id;
    await admin.post(`/api/profiles/${me}/select`, {});
    const r = await admin.get('/api/plugins/helpers/all');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { keyword: 0, started: 0, series: 0, played: 0 });
    // F3: titles with no scores can be found and refreshed by a plugin.
    const db = nf.app.core.db;
    db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('M', 'movies', '[]', '{}', 0)");
    const lib = db.get('SELECT id FROM libraries ORDER BY id DESC LIMIT 1').id;
    db.run("INSERT INTO items (library_id, kind, title, path, genres, added_at, updated_at) VALUES (?, 'movie', 'Bare', '/x/bare.mp4', '[]', 0, 0)", lib);
    db.run("INSERT INTO items (library_id, kind, title, path, genres, scores, added_at, updated_at) VALUES (?, 'movie', 'Scored', '/x/s.mp4', '[]', '[{\"source\":\"rt\",\"value\":\"90%\"}]', 0, 0)", lib);
    const m = await admin.post('/api/plugins/helpers/missing', {});
    assert.equal(m.status, 200, JSON.stringify(m.data));
    assert.deepEqual(m.data, { missing: 1, refreshed: true });
  } finally {
    await nf.app.stop();
  }
});

test("Next Up never offers a profile an episode it can't see, and moves on to the next one it can", () => {
  const { s, ids } = show('Gappy', 0, [[1, 1], [1, 2], [1, 3]]);
  db.run('UPDATE items SET min_age = 16 WHERE id = ?', ids[1]);
  watch(1, ids[0], now - DAY);
  watch(2, ids[0], now - DAY);
  assert.equal(library.canSee(kid, library.get(ids[1])), false);
  assert.equal(library.nextUpFor(kid, s)?.id, ids[2], "Mia's next episode skips the one above her age");
  assert.equal(library.nextUp(kid, 50).find((r) => r.show_id === s)?.id, ids[2], 'and so does her Next Up row');
  assert.equal(library.nextUpFor(grown, s)?.id, ids[1], "Dallas's next episode is still 1x2");
  db.run('UPDATE items SET min_age = 16 WHERE id = ?', ids[2]);
  assert.equal(library.nextUpFor(kid, s), null, 'no episode she can see left: no next episode');
  assert.ok(!library.nextUp(kid, 50).some((r) => r.show_id === s));
});

test("a show's first episode is the first one the profile can see (the title page before anything is watched)", () => {
  const { s, ids } = show('Opener', 0, [[0, 1], [1, 1], [1, 2]]);
  db.run('UPDATE items SET min_age = 16 WHERE id = ?', ids[1]);
  assert.equal(library.firstEpisodeFor(grown, s)?.id, ids[1], 'specials come after season 1');
  assert.equal(library.firstEpisodeFor(kid, s)?.id, ids[2], "Mia's first episode skips the one above her age");
  db.run('UPDATE items SET min_age = 16 WHERE id IN (?, ?)', ids[0], ids[2]);
  assert.equal(library.firstEpisodeFor(kid, s), null, 'none she can see: no first episode');
});
