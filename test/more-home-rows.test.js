// v0.23 Plan C Task 2: the More Home rows plugin — Finish what you started, Seasonal picks and On this day — on a
// database built by hand, with the day fixed by ATOMIX_TODAY.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client } from './helpers.js';
import { seasonFor } from '../plugins/more-home-rows/index.js';

const DAY = 86_400_000;
const now = Date.now();
let nf, admin, kid, db, movies, tv, me, mia;
let seq = 0;

function add(f) {
  const fields = { library_id: movies, kind: 'movie', title: `T${++seq}`, sort_title: `t${seq}`, path: `/m/${seq}`, genres: '[]', keywords: '[]', min_age: 0, rating: 5, ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const watch = (profile, item, at, watched = 1, position = 100) => db.run('INSERT OR REPLACE INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, 100, ?, ?)', profile, item, position, watched, at);
function show(title, n, minAge = 0) {
  const s = add({ library_id: tv, kind: 'show', title, path: `/tv/${title}`, min_age: minAge });
  const eps = Array.from({ length: n }, (_, i) => add({ library_id: tv, kind: 'episode', title: `${title} ${i + 1}`, show_id: s, parent_id: s, season: 1, episode: i + 1, path: `/tv/${title}/${i + 1}`, min_age: null }));
  return { s, eps };
}
const rowsFor = async (c) => {
  const d = (await c.get('/api/home')).data;
  return d.rows || d;
};
const row = (rows, id) => rows.find((r) => r.key === `plugin:more-home-rows/${id}`);

before(async () => {
  nf = await startAtomix({}, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  db = nf.app.core.db;
  movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Films', 'movies', '[]', '{}', 0)").lastInsertRowid);
  tv = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('TV', 'tv', '[]', '{}', 0)").lastInsertRowid);
  me = db.get('SELECT id FROM profiles ORDER BY id LIMIT 1').id;
  const m = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', allowUnrated: true })).data;
  mia = m.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia}/select`, {});
});
after(async () => {
  await nf?.app.stop();
});

test('seasonFor', () => {
  assert.deepEqual(seasonFor({ m: 12, d: 5 }, 'southern'), ['christmas', 'summer']);
  assert.deepEqual(seasonFor({ m: 12, d: 5 }, 'northern'), ['christmas']);
  assert.deepEqual(seasonFor({ m: 10, d: 31 }, 'southern'), ['halloween']);
  assert.deepEqual(seasonFor({ m: 2, d: 14 }, 'southern'), ['valentines', 'summer']);
  assert.deepEqual(seasonFor({ m: 2, d: 14 }, 'northern'), ['valentines']);
  assert.deepEqual(seasonFor({ m: 2, d: 15 }, 'northern'), []);
  assert.deepEqual(seasonFor({ m: 1, d: 10 }, 'southern'), ['summer']);
  assert.deepEqual(seasonFor({ m: 7, d: 1 }, 'northern'), ['summer']);
  assert.deepEqual(seasonFor({ m: 7, d: 1 }, 'southern'), []);
});

const ids = {};
test('Finish what you started: a show left for 14 days, with its next episode and how many are left', async () => {
  process.env.ATOMIX_TODAY = '2026-04-03';
  // 20 shows watched lately fill Continue watching's next-up cards, so the older one is only here.
  for (let i = 0; i < 20; i++) {
    const s = show(`Recent ${i}`, 2);
    watch(me, s.eps[0], now - 3 * DAY + i);
  }
  const old = show('Long Ago', 5);
  ids.old = old;
  watch(me, old.eps[0], now - 30 * DAY);
  const r = row(await rowsFor(admin), 'finish');
  assert.equal(r.title, 'Finish what you started');
  const card = r.items.find((c) => c.id === old.eps[1]);
  assert.ok(card, 'the next episode is the card');
  assert.equal(card.note, '4 episodes left');
  assert.equal(card.showTitle, 'Long Ago', 'the card names its show (review fix F1)');
  assert.ok(!r.items.some((c) => /^Recent /.test(c.showTitle || '')), 'recently watched shows are not here');
});

test('…and a film series with some parts seen, with the next part', async () => {
  const parts = [1, 2, 3, 4].map((n) => add({ title: `Saga ${n}` }));
  const c = Number(db.run("INSERT INTO collections (name, manual, hidden, parts, created_at, updated_at) VALUES ('Saga', 0, 0, '[]', 0, 0)").lastInsertRowid);
  parts.forEach((id, i) => db.run('INSERT INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)', c, id, i));
  watch(me, parts[0], now - 40 * DAY);
  watch(me, parts[1], now - 39 * DAY);
  ids.saga = parts;
  const r = row(await rowsFor(admin), 'finish');
  const card = r.items.find((x) => x.id === parts[2]);
  assert.equal(card?.note, 'Part 3 of 4');
});

test('titles already in Continue watching are left out', async () => {
  // Part 3 started: it's in Continue watching now, so it leaves this row.
  watch(me, ids.saga[2], now - DAY, 0, 50);
  const rows = await rowsFor(admin);
  const cont = rows.find((r) => r.key === 'continue');
  assert.ok(cont.items.some((c) => c.id === ids.saga[2]));
  assert.ok(!row(rows, 'finish').items.some((c) => c.id === ids.saga[2]));
  // A recently watched show's next episode is in Continue watching, not here.
  assert.ok(!row(rows, 'finish').items.some((c) => c.showId && cont.items.some((k) => k.showId === c.showId)));
});

test('Seasonal picks follows the season and its title', async () => {
  process.env.ATOMIX_TODAY = '2026-10-19';
  add({ title: 'Pumpkin Night', keywords: '["halloween"]' });
  add({ title: 'Haunt', genres: '["Horror"]' });
  add({ title: 'Fright', genres: '["Horror"]' });
  const r0 = row(await rowsFor(admin), 'seasonal');
  assert.equal(r0, undefined, '3 matches: no row');
  add({ title: 'Scream Again', genres: '["Horror"]', keywords: '["halloween"]' });
  const r = row(await rowsFor(admin), 'seasonal');
  assert.equal(r.title, 'Halloween frights');
  assert.equal(r.items.length, 4);
});

test('a season with fewer than 4 matches gives way, or hides the row', async () => {
  process.env.ATOMIX_TODAY = '2026-12-05';
  add({ title: 'Snow 1', keywords: '["christmas"]' });
  add({ title: 'Snow 2', keywords: '["santa claus"]' });
  const summer = ['summer', 'beach', 'summer camp', 'summer vacation'].map((k, i) => add({ title: `Sun ${i}`, keywords: JSON.stringify([k]) }));
  const r = row(await rowsFor(admin), 'seasonal');
  assert.equal(r?.title, 'Summer films');
  db.run('DELETE FROM items WHERE id = ?', summer[0]);
  assert.equal(row(await rowsFor(admin), 'seasonal'), undefined);
  await admin.put('/api/admin/plugins/more-home-rows/config', { hemisphere: 'northern' });
  assert.equal(row(await rowsFor(admin), 'seasonal'), undefined, 'northern December: Christmas only, and 2 is too few');
  await admin.put('/api/admin/plugins/more-home-rows/config', { hemisphere: 'southern' });
});

test('On this day: what this profile watched a year ago, then films released on this day', async () => {
  process.env.ATOMIX_TODAY = '2026-10-19';
  const back = add({ title: 'Back Then', air_date: '1985-10-19' });
  const seen = add({ title: 'Seen Last Year' });
  const t = new Date(2025, 9, 19, 20, 0).getTime();
  db.run('INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted) VALUES (?, ?, ?, ?, 600, 1)', me, seen, t, t);
  const r = row(await rowsFor(admin), 'on-this-day');
  assert.equal(r.title, 'On this day');
  assert.equal(r.items[0].id, seen);
  assert.equal(r.items[0].note, 'You watched this a year ago');
  // An episode watched a year ago names its show too (review fix F1).
  const ep = ids.old.eps[0];
  db.run('INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted) VALUES (?, ?, ?, ?, 600, 1)', me, ep, t + 60_000, t + 60_000);
  const withEp = row(await rowsFor(admin), 'on-this-day');
  assert.equal(withEp.items.find((c) => c.id === ep)?.showTitle, 'Long Ago');
  const b = r.items.find((c) => c.id === back);
  assert.equal(b.note, 'Released 19 Oct 1985');
});

test('On this day: only full dates match; 29 February is its own day', async () => {
  const leap = add({ title: 'Leap', air_date: '2000-02-29' });
  add({ title: 'Year Only', air_date: '2000' });
  process.env.ATOMIX_TODAY = '2028-02-29';
  const r = row(await rowsFor(admin), 'on-this-day');
  assert.deepEqual(r.items.map((c) => c.id), [leap]);
  assert.equal(r.items[0].note, 'Released 29 Feb 2000');
  process.env.ATOMIX_TODAY = '2027-02-28';
  const r2 = row(await rowsFor(admin), 'on-this-day');
  assert.ok(!r2?.items.some((c) => c.id === leap));
});

test('a Kids profile sees only its own titles in all three rows', async () => {
  process.env.ATOMIX_TODAY = '2026-10-19';
  const adult = show('Grown Up', 3, 16);
  watch(mia, adult.eps[0], now - 30 * DAY);
  const scary = add({ title: 'Too Scary', genres: '["Horror"]', keywords: '["halloween"]', min_age: 16, air_date: '1990-10-19' });
  const fine = add({ title: 'Kind Ghost', air_date: '1995-10-19' });
  const rows = await rowsFor(kid);
  const cards = ['finish', 'seasonal', 'on-this-day'].flatMap((id) => row(rows, id)?.items || []);
  assert.ok(!cards.some((c) => c.id === scary || adult.eps.includes(c.id) || c.id === adult.s), JSON.stringify(cards.map((c) => c.title)));
  assert.ok(row(rows, 'on-this-day').items.some((c) => c.id === fine), 'what the Kids profile may see is there');
});

test('each row is in Arrange home and hidden when empty', async () => {
  const layout = JSON.stringify((await admin.get('/api/home/layout')).data);
  for (const id of ['finish', 'seasonal', 'on-this-day']) assert.ok(layout.includes(`plugin:more-home-rows/${id}`), id);
  process.env.ATOMIX_TODAY = '2026-04-03';
  const rows = await rowsFor(kid);
  assert.ok(!rows.some((r) => String(r.key).startsWith('plugin:more-home-rows/')), rows.map((r) => r.key).join());
});
