// Scrubbing with a TV remote: presses move a marker, the video jumps on OK or
// after a second's pause, and holding the button speeds it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scrubber, COMMIT_AFTER_MS } from '../public/js/scrub.js';

test('presses move a marker; the video only jumps on OK or after a pause', () => {
  const s = new Scrubber({ duration: () => 600 });
  assert.equal(s.press(1, { from: 100, now: 0 }), 110);
  assert.equal(s.press(1, { from: 999, now: 400 }), 120, 'later presses start from the marker, not the video');
  assert.equal(s.press(-1, { from: 999, now: 800 }), 110);
  assert.equal(COMMIT_AFTER_MS, 1000);
  assert.equal(s.due(800 + COMMIT_AFTER_MS - 1), false);
  assert.equal(s.due(800 + COMMIT_AFTER_MS), true);
  assert.equal(s.commit(), 110);
  assert.equal(s.active, false);
  assert.equal(s.commit(), null, 'nothing left to jump to');
});

test('holding the button: 10 s steps, 30 s after 1.5 s, 60 s after 4 s', () => {
  const s = new Scrubber({ duration: () => 7200 });
  const steps = [];
  let last = 1000;
  for (let now = 0; now <= 5000; now += 100) {
    const t = s.press(1, { from: 1000, now, repeat: now > 0 });
    steps.push(t - last);
    last = t;
  }
  assert.deepEqual([steps[0], steps[14], steps[15], steps[39], steps[40]], [10, 10, 30, 30, 60]);
});

test('quick separate presses (remotes that do not repeat keys) count as holding', () => {
  const s = new Scrubber({ duration: () => 7200 });
  let t = 0;
  for (let now = 0; now <= 1600; now += 200) t = s.press(1, { from: 0, now });
  assert.equal(t, 8 * 10 + 30);
});

test('turning round, or pausing, starts slow again', () => {
  const s = new Scrubber({ duration: () => 7200 });
  for (let now = 0; now <= 2000; now += 100) s.press(1, { from: 0, now, repeat: now > 0 });
  const before = s.target;
  assert.equal(s.press(-1, { from: 0, now: 2100, repeat: true }), before - 10);
  s.commit();
  s.press(1, { from: 500, now: 10000 });
  assert.equal(s.press(1, { from: 500, now: 10600 }), 520);
});

test('stays inside the video, and Back cancels', () => {
  const s = new Scrubber({ duration: () => 100 });
  assert.equal(s.press(-1, { from: 5, now: 0 }), 0);
  for (let i = 1; i <= 20; i++) s.press(1, { from: 5, now: i * 1000 });
  assert.equal(s.target, 99, 'never past the last second');
  assert.equal(s.cancel(), true);
  assert.equal(s.active, false);
  assert.equal(s.cancel(), false);
  const unknown = new Scrubber({ duration: () => 0 });
  assert.equal(unknown.press(1, { from: 50, now: 0 }), 60, 'length not known yet: no upper limit');
});

test('press reports the step it used', () => {
  const s = new Scrubber({ duration: () => 7200 });
  s.press(1, { from: 1000, now: 0 });
  assert.equal(s.lastStep, 10);
  s.press(1, { from: 1000, now: 1600, repeat: true });
  assert.equal(s.lastStep, 30);
  s.press(1, { from: 1000, now: 4100, repeat: true });
  assert.equal(s.lastStep, 60);
  s.cancel();
  assert.equal(s.lastStep, 0, 'nothing held');
});
