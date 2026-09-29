// The fingerprint maths runs in a worker thread, so the server keeps answering
// while a season is checked (each fingerprint or comparison is up to a second of CPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, SAMPLE_RATE } from '../src/extras/fingerprint.js';
import { createMatcher } from '../src/extras/matcher.js';

function noiseClip(seconds, seed) {
  let s = seed >>> 0;
  return Int16Array.from({ length: seconds * SAMPLE_RATE }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return Math.round((s / 2 ** 32 - 0.5) * 20000);
  });
}

test('fingerprints and comparisons run off the main thread, with the same results', async () => {
  const samples = noiseClip(600, 7);
  const expected = fingerprint(samples);
  const matcher = createMatcher();
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    const fp = await matcher.fingerprint(samples.slice());
    assert.deepEqual(fp, expected);
    assert.equal(await matcher.compare(fp, expected), null, 'a duplicate is not an intro');
  } finally {
    clearInterval(timer);
    await matcher.close();
  }
  assert.ok(worst < 200, `the event loop stalled for ${Math.round(worst)} ms`);
});

test('closing the matcher stops work in progress', async () => {
  const matcher = createMatcher();
  const stopped = assert.rejects(matcher.fingerprint(noiseClip(600, 8)), /Stopped/);
  await matcher.close();
  await stopped;
});
