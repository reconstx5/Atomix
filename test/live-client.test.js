// The browser's Live TV helpers that need no page (public/js/live.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programmeTimes, programmeProgress, programmeState, neighbour, setZapOrder, channelLabel, zapQueue, sessionPath } from '../public/js/live.js';

const at = (h, m) => new Date(2026, 9, 10, h, m, 0, 0).getTime(); // local time, like the page
const p = { start: at(19, 0), end: at(19, 30), title: '1 News' };

test('programmeTimes says "7:00 – 7:30 PM", or both halves when it crosses noon or midnight', () => {
  assert.equal(programmeTimes(p), '7:00 – 7:30 PM');
  assert.equal(programmeTimes({ start: at(11, 30), end: at(12, 30) }), '11:30 AM – 12:30 PM');
  assert.equal(programmeTimes({ start: at(23, 30), end: at(23, 59) + 60_000 }), '11:30 PM – 12:00 AM');
});

test('programmeProgress is 0..1 and clamps outside the programme', () => {
  assert.equal(programmeProgress(p, at(19, 15)), 0.5);
  assert.equal(programmeProgress(p, at(18, 0)), 0);
  assert.equal(programmeProgress(p, at(20, 0)), 1);
  assert.equal(programmeProgress(null, at(19, 15)), 0);
});

test('programmeState: now, upcoming, aired, and catch-up within the channel\'s days', () => {
  const tv = { catchup: false };
  const cu = { catchup: true, catchupDays: 2 };
  assert.equal(programmeState(p, at(19, 10), tv), 'now');
  assert.equal(programmeState(p, at(18, 10), tv), 'upcoming');
  assert.equal(programmeState(p, at(19, 30), tv), 'aired', 'the end is not "now"');
  assert.equal(programmeState(p, at(21, 0), cu), 'catchup');
  assert.equal(programmeState(p, at(21, 0) + 3 * 86400_000, cu), 'aired', 'older than its catch-up days');
});

test('neighbour steps through the zap order and wraps at both ends', () => {
  setZapOrder([11, 12, 13]);
  assert.equal(neighbour(12, 1), 13);
  assert.equal(neighbour(13, 1), 11);
  assert.equal(neighbour(11, -1), 13);
  assert.equal(neighbour(99, 1), 11, 'a channel not in the order starts at the first');
});

test('channelLabel is "7 TVNZ 1", or the name when there is no number', () => {
  assert.equal(channelLabel({ number: 7, name: 'TVNZ 1' }), '7 TVNZ 1');
  assert.equal(channelLabel({ number: null, name: 'Radio' }), 'Radio');
});

test('zapQueue: quick presses coalesce to the last one; a result that a newer request overtook is dropped', async () => {
  const started = [];
  const q = zapQueue(async (id) => {
    started.push(id);
    await new Promise((r) => setTimeout(r, 30));
    return id;
  }, { settleMs: 40 });
  const results = await Promise.all([q.request(1), q.request(2), q.request(3), q.request(4), q.request(5)]);
  assert.deepEqual(started, [5], 'only the last press starts');
  assert.deepEqual(results, [null, null, null, null, 5]);
  const a = q.request(6);
  await new Promise((r) => setTimeout(r, 50)); // 6 has started
  const b = q.request(7);
  assert.equal(await a, null, 'overtaken while starting');
  assert.equal(await b, 7);
  assert.deepEqual(started, [5, 6, 7]);
});

test('zapQueue: a failing last request rejects its own promise', async () => {
  const q = zapQueue(async () => {
    throw new Error('Your provider allows 1 stream at a time — stop the other one first');
  }, { settleMs: 5 });
  await assert.rejects(q.request(1), /provider allows/);
});

test('zapQueue: a press after an earlier start began waits for it (the stale one stops first), so starts never overlap', async () => {
  const log = [];
  let open = 0;
  let maxOpen = 0;
  const q = zapQueue(async (id) => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    log.push(`start ${id}`);
    await new Promise((r) => setTimeout(r, 80));
    open--;
    return id;
  }, { settleMs: 20, onStale: async (id) => { log.push(`stop ${id}`); } });
  const a = q.request(1);
  await new Promise((r) => setTimeout(r, 50)); // 1 is starting
  const b = q.request(2);
  assert.equal(await a, null);
  assert.equal(await b, 2);
  assert.equal(maxOpen, 1, 'two starts never ran at once');
  assert.deepEqual(log, ['start 1', 'stop 1', 'start 2']);
});

test('sessionPath: an encrypted session is pinged and stopped at its own address', () => {
  assert.equal(sessionPath({ sessionId: 'a', delivery: 'drm' }), '/api/live/drm/a');
  assert.equal(sessionPath({ sessionId: 'b', delivery: 'hls' }), '/api/playback/b');
  assert.equal(sessionPath({ sessionId: 'c' }), '/api/playback/c');
});

test('zapQueue.cancel drops a pending zap and stops one in flight', async () => {
  const started = [];
  const stale = [];
  const q = zapQueue(async (id) => {
    started.push(id);
    await new Promise((r) => setTimeout(r, 30));
    return id;
  }, { settleMs: 20, onStale: (out) => stale.push(out) });
  const pending = q.request(1);
  q.cancel();
  assert.equal(await pending, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(started, [], 'the pending zap never started');
  const running = q.request(2);
  await new Promise((r) => setTimeout(r, 30)); // 2 has started
  q.cancel();
  assert.equal(await running, null);
  assert.deepEqual(stale, [2], 'the one in flight is stopped when it lands');
});

test('takeOver: the next programme becomes "now" only once it has started', async () => {
  const { takeOver } = await import('../public/js/live.js');
  const next = { start: at(19, 35), end: at(20, 0), title: 'Later' };
  assert.equal(takeOver(next, at(19, 31)), null, 'a gap after the last programme: nothing is on yet');
  assert.equal(takeOver(next, at(19, 35)), next);
  assert.equal(takeOver(next, at(20, 0)), null, 'already over');
  assert.equal(takeOver(null, at(19, 40)), null);
});

test("sessionPath: a tuner viewer's ping and stop go to the tuner routes", () => {
  assert.equal(sessionPath({ delivery: 'dash', sessionId: 'abc' }), '/api/live/tuner/abc');
  assert.equal(sessionPath({ delivery: 'drm', sessionId: 'x' }), '/api/live/drm/x');
  assert.equal(sessionPath({ delivery: 'hls', sessionId: 'y' }), '/api/playback/y');
});
