// Recordings storage (src/live/recordings.js): scheduled, running and finished recordings, series rules, and the
// lookups the scheduler uses (due, ending, overlapping, exists). Also the repeat flag the guide stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { LiveStore } from '../src/live/store.js';
import { Recordings, episodeNumbers } from '../src/live/recordings.js';

const SRC = 'iptv-simple/playlist';
const T = Date.UTC(2026, 9, 10, 6, 0, 0);
const MIN = 60_000;

function fresh() {
  const db = openDatabase(path.join(tempDir(), 'rec.db'));
  const now = Date.now();
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'admin', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, ?)", now);
  return { db, rec: new Recordings(db) };
}
const row = (extra = {}) => ({ profileId: 1, source: SRC, channelKey: 'one', channelId: null, channelName: 'One', title: 'Show', episodeTitle: null, season: null, episode: null, plot: null, start: T, end: T + 30 * MIN, pre: 1, post: 3, ...extra });

test('episodeNumbers reads "S2 E5" and "S2E5"', () => {
  assert.deepEqual(episodeNumbers('S2 E5'), { season: 2, episode: 5 });
  assert.deepEqual(episodeNumbers('s12e80'), { season: 12, episode: 80 });
  assert.deepEqual(episodeNumbers('E7'), { season: null, episode: 7 });
  assert.equal(episodeNumbers('S2'), null);
  assert.equal(episodeNumbers(null), null);
  assert.equal(episodeNumbers('Part one'), null);
});

test('add, get, update and list by status', () => {
  const { rec } = fresh();
  const id = rec.add(row());
  const r = rec.get(id);
  assert.equal(r.status, 'scheduled');
  assert.equal(r.part, 1);
  assert.equal(r.channelName, 'One');
  rec.update(id, { status: 'done', gapSeconds: 12, path: '/x.mkv' });
  assert.deepEqual([rec.get(id).status, rec.get(id).gapSeconds, rec.get(id).path], ['done', 12, '/x.mkv']);
  assert.equal(rec.list({ status: 'done' }).length, 1);
  assert.equal(rec.list({ status: 'scheduled' }).length, 0);
  assert.equal(rec.get(999), null);
});

test('due and ending honour the padding', () => {
  const { rec } = fresh();
  const id = rec.add(row());
  assert.deepEqual(rec.due(T - 61_000).map((r) => r.id), []);
  assert.deepEqual(rec.due(T - 60_000).map((r) => r.id), [id]);
  rec.update(id, { status: 'recording' });
  assert.deepEqual(rec.due(T), []);
  assert.deepEqual(rec.ending(T + 30 * MIN + 179_000), []);
  assert.deepEqual(rec.ending(T + 30 * MIN + 180_000).map((r) => r.id), [id]);
});

test('overlapping counts other scheduled and running recordings of the source by programme times (padding gives way)', () => {
  const { rec } = fresh();
  const a = rec.add(row());
  rec.add(row({ start: T + 20 * MIN, end: T + 60 * MIN }));
  rec.add(row({ start: T + 30 * MIN, end: T + 60 * MIN })); // back to back with a: no overlap
  rec.add(row({ start: T + 10 * MIN, end: T + 60 * MIN, status: 'cancelled' }));
  rec.add(row({ source: 'other', start: T, end: T + 30 * MIN }));
  assert.equal(rec.overlapping(SRC, T, T + 30 * MIN, a).length, 1);
  assert.equal(rec.overlapping(SRC, T, T + 30 * MIN, null).length, 2);
});

test('exists finds a programme already recorded or scheduled by episode, by title + episode title, or by channel + start', () => {
  const { rec } = fresh();
  const ruleId = rec.addRule({ profileId: 1, source: SRC, channelKey: null, title: 'Show', newOnly: true, keep: 0 });
  rec.add(row({ ruleId, season: 1, episode: 2, status: 'done' }));
  rec.add(row({ ruleId, title: 'Quiz', episodeTitle: 'Finals', start: T + 60 * MIN, end: T + 90 * MIN }));
  rec.add(row({ title: 'Movie', start: T + 120 * MIN, end: T + 200 * MIN }));
  rec.add(row({ ruleId, season: 4, episode: 4, status: 'failed', start: T - 900 * MIN, end: T - 870 * MIN }));
  const q = (o) => rec.exists({ ruleId, source: SRC, channelKey: 'two', start: T + 999 * MIN, season: null, episode: null, title: 'Show', episodeTitle: null, ...o });
  assert.ok(q({ season: 1, episode: 2 }), 'same rule, same episode, another airing');
  assert.ok(!q({ season: 1, episode: 3 }));
  assert.ok(q({ ruleId: 777, season: 1, episode: 2 }), 'another rule for the same show');
  assert.ok(!q({ ruleId: 777, season: 1, episode: 2, title: 'Another show' }), 'another show\'s S1E2');
  assert.ok(q({ title: ' quiz ', episodeTitle: 'FINALS' }), 'title + episode title, case and spaces ignored');
  assert.ok(q({ channelKey: 'one', start: T + 120 * MIN, title: 'Anything' }), 'the same airing');
  assert.ok(!q({ season: 4, episode: 4 }), 'a failed one may be retried at another airing');
});

test('series rules: add, list, update, delete', () => {
  const { rec } = fresh();
  const id = rec.addRule({ profileId: 1, source: SRC, channelKey: 'one', title: 'Show', newOnly: true, keep: 5 });
  assert.deepEqual(rec.rules().map((r) => [r.title, r.channelKey, r.newOnly, r.keep]), [['Show', 'one', true, 5]]);
  rec.updateRule(id, { keep: 10, newOnly: false, channelKey: null });
  assert.deepEqual([rec.rule(id).keep, rec.rule(id).newOnly, rec.rule(id).channelKey], [10, false, null]);
  rec.deleteRule(id);
  assert.equal(rec.rules().length, 0);
});

test('the guide stores and returns the repeat flag', async () => {
  const { db } = fresh();
  const store = new LiveStore(db);
  store.replaceChannels(SRC, [{ key: 'a', name: 'A', number: null, group: [], radio: false, guideId: 'a' }]);
  await store.replaceProgrammes(SRC, [
    { guideId: 'a', start: T, end: T + 30 * MIN, title: 'Old', repeat: true },
    { guideId: 'a', start: T + 30 * MIN, end: T + 60 * MIN, title: 'New' },
  ], { from: T - MIN, to: T + 120 * MIN });
  const id = store.channels({ sources: [SRC] })[0].id;
  const progs = store.guide([id], T - MIN, T + 120 * MIN).get(id);
  assert.deepEqual(progs.map((p) => [p.title, p.repeat]), [['Old', true], ['New', false]]);
});
