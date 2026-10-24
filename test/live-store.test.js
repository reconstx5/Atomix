// Live TV storage (src/live/store.js): channels kept by (source, key), programmes per window, favourites, Kids groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { LiveStore } from '../src/live/store.js';

const SRC = 'iptv-simple/playlist';
const T = Date.UTC(2026, 9, 10, 6, 0, 0); // 19:00 NZDT
const MIN = 60_000;

function fresh() {
  const db = openDatabase(path.join(tempDir(), 'live.db'));
  const now = Date.now();
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'admin', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, kids, created_at) VALUES (1, 'Kid', 'teal', 0, 1, ?)", now);
  return { db, store: new LiveStore(db) };
}
const ch = (key, name, extra = {}) => ({ key, name, number: null, group: ['News'], radio: false, guideId: key, ...extra });
const prog = (guideId, startMin, lenMin, title) => ({ guideId, start: T + startMin * MIN, end: T + (startMin + lenMin) * MIN, title });
const idOf = (store, key) => store.channels({ sources: [SRC] }).find((c) => c.key === key)?.id;

test('replaceChannels keeps ids and favourites across a reorder and a rename', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A'), ch('b', 'B'), ch('c', 'C')]);
  const idB = idOf(store, 'b');
  store.toggleFavourite(1, idB, true);
  const out = store.replaceChannels(SRC, [ch('c', 'C'), ch('b', 'B2'), ch('a', 'A')]);
  assert.deepEqual(out, { added: 0, updated: 3, removed: 0 });
  assert.equal(idOf(store, 'b'), idB);
  assert.deepEqual(store.favourites(1), [idB]);
  const list = store.channels({ sources: [SRC] });
  assert.deepEqual(list.map((c) => c.key), ['c', 'b', 'a']);
  assert.equal(list[1].name, 'B2');
  assert.deepEqual(list[1].groups, ['News']);
});

test('a channel missing from a refresh is hidden, not deleted', async () => {
  const { db, store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A'), ch('b', 'B')]);
  const idB = idOf(store, 'b');
  store.toggleFavourite(1, idB, true);
  const out = store.replaceChannels(SRC, [ch('a', 'A')]);
  assert.equal(out.removed, 0);
  assert.deepEqual(store.channels({ sources: [SRC] }).map((c) => c.key), ['a'], 'not listed');
  assert.deepEqual(store.channels({ sources: [SRC], favouritesOf: 1 }), [], 'not among favourites shown');
  assert.equal(store.channel(idB).hidden, true, 'a hidden channel (not playable)');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM live_favourites').n, 1, 'the favourite is kept');
});

test('a channel back within 7 days keeps its id and favourite', async () => {
  const { store } = fresh();
  const t = Date.now();
  store.replaceChannels(SRC, [ch('a', 'A'), ch('b', 'B')], { now: t });
  const idB = idOf(store, 'b');
  store.toggleFavourite(1, idB, true);
  store.replaceChannels(SRC, [ch('a', 'A')], { now: t + 3600_000 });
  store.replaceChannels(SRC, [ch('a', 'A'), ch('b', 'B')], { now: t + 6 * 86400_000 });
  assert.equal(idOf(store, 'b'), idB);
  assert.deepEqual(store.favourites(1), [idB]);
  assert.equal(store.channel(idB).hidden, false);
});

test('a channel missing for more than 7 days is deleted (its programmes and favourites go with it)', async () => {
  const { db, store } = fresh();
  const t = Date.now();
  store.replaceChannels(SRC, [ch('a', 'A'), ch('b', 'B')], { now: t });
  const idB = idOf(store, 'b');
  store.toggleFavourite(1, idB, true);
  await store.replaceProgrammes(SRC, [prog('b', 0, 30, 'News')], { from: T - 60 * MIN, to: T + 600 * MIN });
  store.replaceChannels(SRC, [ch('a', 'A')], { now: t });
  const out = store.replaceChannels(SRC, [ch('a', 'A')], { now: t + 7 * 86400_000 + 1 });
  assert.equal(out.removed, 1);
  assert.equal(store.channel(idB), null);
  assert.deepEqual(store.favourites(1), []);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM live_programmes').n, 0);
});

test('replaceProgrammes names the channels without guide apart for TV and radio', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A'), ch('b', 'B'), ch('r', 'R', { radio: true })]);
  const res = await store.replaceProgrammes(SRC, [prog('a', 0, 30, 'News')], { from: T - 60 * MIN, to: T + 600 * MIN });
  assert.deepEqual(res.unmatched, { tv: ['B'], radio: ['R'] });
});

test('replaceProgrammes replaces only the window and maps one guide id to two channels', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A', { guideId: 'g1' }), ch('a-hd', 'A HD', { guideId: 'g1' }), ch('b', 'B', { guideId: 'g2' })]);
  await store.replaceProgrammes(SRC, [prog('g1', -120, 30, 'Old'), prog('g1', 0, 30, 'Keep?')], { from: T - 180 * MIN, to: T + 600 * MIN });
  const res = await store.replaceProgrammes(SRC, [prog('g1', 0, 30, 'Fresh'), prog('g1', 30, 30, 'Later')], { from: T - 30 * MIN, to: T + 600 * MIN });
  assert.equal(res.stored, 4); // two programmes × two channels
  assert.deepEqual(res.unmatched, { tv: ['B'], radio: [] });
  const g = store.guide([idOf(store, 'a'), idOf(store, 'a-hd')], T - 180 * MIN, T + 600 * MIN);
  assert.deepEqual(g.get(idOf(store, 'a')).map((p) => p.title), ['Old', 'Fresh', 'Later'], 'outside the new window stays');
  assert.deepEqual(g.get(idOf(store, 'a-hd')).map((p) => p.title), ['Old', 'Fresh', 'Later']);
});

test('nowNext: end is exclusive', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A')]);
  await store.replaceProgrammes(SRC, [prog('a', 0, 30, 'First'), prog('a', 30, 30, 'Second')], { from: T - 60 * MIN, to: T + 600 * MIN });
  const id = idOf(store, 'a');
  const at1915 = store.nowNext([id], T + 15 * MIN).get(id);
  assert.equal(at1915.now.title, 'First');
  assert.equal(at1915.next.title, 'Second');
  const at1930 = store.nowNext([id], T + 30 * MIN).get(id);
  assert.equal(at1930.now.title, 'Second');
  assert.equal(at1930.next, null);
  assert.deepEqual(store.nowNext([id], T + 90 * MIN).get(id), { now: null, next: null });
});

test('guide returns programmes overlapping the window, ordered', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A')]);
  await store.replaceProgrammes(SRC, [prog('a', 60, 30, 'C'), prog('a', 0, 30, 'A'), prog('a', 30, 30, 'B'), prog('a', 120, 30, 'D')], { from: T - 60 * MIN, to: T + 600 * MIN });
  const id = idOf(store, 'a');
  assert.deepEqual(store.guide([id], T + 15 * MIN, T + 75 * MIN).get(id).map((p) => p.title), ['A', 'B', 'C']);
  const p = store.guide([id], T, T + 30 * MIN).get(id)[0];
  assert.equal(p.channelId, id);
  assert.deepEqual(p.categories, []);
  assert.equal(store.programme(p.id).title, 'A');
});

test('channels honours a Kids group allow-list (a channel in any allowed group shows) and favourites order', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A', { group: ['News'] }), ch('b', 'B', { group: ['Kids', 'Movies'] }), ch('c', 'C', { group: ['Movies'] }), ch('d', 'D', { group: [] })]);
  store.setKidsGroups(2, [{ source: SRC, grp: 'Kids' }]);
  assert.deepEqual(store.kidsGroups(2), [{ source: SRC, grp: 'Kids' }]);
  const allowed = new Set(store.kidsGroups(2).map((r) => `${r.source}\u0000${r.grp}`));
  assert.deepEqual(store.channels({ sources: [SRC], groups: allowed }).map((c) => c.key), ['b']);
  assert.deepEqual(store.groups({ sources: [SRC], groups: allowed }), ['Kids']);
  assert.deepEqual(store.groups({ sources: [SRC] }), ['News', 'Kids', 'Movies']);
  assert.deepEqual(store.channels({ sources: [SRC], group: 'Movies' }).map((c) => c.key), ['b', 'c']);
  const [a, , c] = ['a', 'b', 'c'].map((k) => idOf(store, k));
  store.setFavourites(1, [c, a]);
  assert.deepEqual(store.channels({ sources: [SRC], favouritesOf: 1 }).map((x) => x.key), ['c', 'a']);
  assert.deepEqual(store.channels({ sources: ['other/src'] }), []);
});

test('prune drops programmes outside the window', async () => {
  const { db, store } = fresh();
  store.replaceChannels(SRC, [ch('a', 'A')]);
  await store.replaceProgrammes(SRC, [prog('a', -3000, 30, 'Ancient'), prog('a', 0, 30, 'Now'), prog('a', 20000, 30, 'Far')], { from: T - 4000 * MIN, to: T + 30000 * MIN });
  store.prune(T - 1440 * MIN, T + 10080 * MIN);
  assert.deepEqual(db.all('SELECT title FROM live_programmes').map((r) => r.title), ['Now']);
});

test('recordRefresh keeps last_ok when a later refresh fails', async () => {
  const { store } = fresh();
  store.recordRefresh(SRC, { ok: true, channels: 3, programmes: 10, unmatched: 1 });
  const first = store.sourceStatus(SRC);
  assert.equal(first.channels, 3);
  assert.ok(first.lastOk > 0);
  store.recordRefresh(SRC, { ok: false, error: 'The playlist took too long to answer' });
  const second = store.sourceStatus(SRC);
  assert.equal(second.lastOk, first.lastOk);
  assert.equal(second.channels, 3);
  assert.equal(second.error, 'The playlist took too long to answer');
  store.recordRefresh(SRC, { ok: true, channels: 4, programmes: 9, unmatched: 0 });
  assert.equal(store.sourceStatus(SRC).error, null);
});

test('a big guide (1 000 channels × 7 days) stays responsive: nowNext under 300 ms, replaceProgrammes never blocks over 300 ms', async () => {
  const { store } = fresh();
  const N = 1000;
  store.replaceChannels(SRC, Array.from({ length: N }, (_, i) => ch(`k${i}`, `Ch ${i}`)));
  const progs = [];
  for (let i = 0; i < N; i++) for (let j = -48; j < 7 * 48; j++) progs.push(prog(`k${i}`, j * 30, 30, `P${j}`));
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  await store.replaceProgrammes(SRC, progs, { from: T - 2 * 1440 * MIN, to: T + 8 * 1440 * MIN });
  await new Promise((r) => setTimeout(r, 30)); // let the timer see the last gap
  clearInterval(timer);
  assert.ok(maxGap < 300, `event loop blocked for ${maxGap.toFixed(0)} ms`);
  const ids = store.channels({ sources: [SRC] }).map((c) => c.id);
  const t = performance.now();
  const nn = store.nowNext(ids, T + 15 * MIN);
  const ms = performance.now() - t;
  assert.equal(nn.get(ids[7]).now.title, 'P0');
  assert.equal(nn.get(ids[7]).next.title, 'P1');
  assert.ok(ms < 300, `nowNext ${ms.toFixed(0)} ms`);
});

test('replaceChannels keeps a channel\'s encryption system (widevine/clearkey) and drops anything else', async () => {
  const { store } = fresh();
  store.replaceChannels(SRC, [ch('wv', 'WV', { drm: 'widevine' }), ch('ck', 'CK', { drm: 'clearkey' }), ch('pr', 'PR', { drm: 'playready' }), ch('pl', 'Plain')]);
  const by = Object.fromEntries(store.channels({ sources: [SRC] }).map((c) => [c.key, c.drm]));
  assert.deepEqual(by, { wv: 'widevine', ck: 'clearkey', pr: null, pl: null });
  store.replaceChannels(SRC, [ch('wv', 'WV')]);
  assert.equal(store.channel(idOf(store, 'wv')).drm, null, 'a refresh that drops the encryption clears it');
});
