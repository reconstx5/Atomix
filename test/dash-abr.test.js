// Choosing a quality level (public/js/dash/abr.js): start sensibly, go up only with buffer to spare, come down at
// once when the buffer runs low, and never above what the screen can show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRepresentation } from '../public/js/dash/abr.js';

const r = (id, bandwidth, height) => ({ id, bandwidth, height });
const LEVELS = [r('360', 800_000, 360), r('540', 1_800_000, 540), r('720', 3_000_000, 720), r('1080', 6_000_000, 1080)];
const pick = (o) => pickRepresentation(LEVELS, { throughputBps: null, bufferedSec: 0, maxHeight: Infinity, current: null, ...o }).id;

test('first pick (no measurement yet): the lowest level above 1 Mb/s, or the lowest', () => {
  assert.equal(pick({}), '540');
  assert.equal(pickRepresentation([r('a', 300_000, 240), r('b', 600_000, 360)], { throughputBps: null }).id, 'a');
});

test('with a measurement and no current level: the highest that fits 70 % of the throughput', () => {
  assert.equal(pick({ throughputBps: 5_000_000 }), '720', '0.7 × 5 Mb/s = 3.5 Mb/s');
  assert.equal(pick({ throughputBps: 10_000_000 }), '1080');
  assert.equal(pick({ throughputBps: 500_000 }), '360', 'nothing fits: the lowest');
});

test('going up waits for 10 s of buffer', () => {
  const current = LEVELS[1];
  assert.equal(pick({ throughputBps: 10_000_000, bufferedSec: 6, current }), '540');
  assert.equal(pick({ throughputBps: 10_000_000, bufferedSec: 10, current }), '1080');
});

test('coming down happens at once when the buffer is under 4 s; with buffer to spare it waits', () => {
  const current = LEVELS[3];
  assert.equal(pick({ throughputBps: 2_000_000, bufferedSec: 3, current }), '360');
  assert.equal(pick({ throughputBps: 2_000_000, bufferedSec: 8, current }), '1080');
});

test('never above the screen: the cap rounds up to the next level, and a smaller screen moves a current level down', () => {
  assert.equal(pick({ throughputBps: 50_000_000, maxHeight: 600 }), '720', '600 px rounds up to the 720 level');
  assert.equal(pick({ throughputBps: 50_000_000, maxHeight: 720 }), '720');
  assert.equal(pick({ throughputBps: 50_000_000, maxHeight: 4000 }), '1080', 'a 4K screen: the top level');
  assert.equal(pick({ throughputBps: 50_000_000, bufferedSec: 20, maxHeight: 400, current: LEVELS[3] }), '540');
});

test('levels without a height (audio) are never capped', () => {
  const audio = [r('64k', 64_000, null), r('128k', 128_000, null)];
  assert.equal(pickRepresentation(audio, { throughputBps: 10_000_000, bufferedSec: 0, maxHeight: 360 }).id, '128k');
});
