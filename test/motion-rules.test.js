// Atomix's motion ("Capture", v0.28): the rules that need no page (public/js/motion-rules.js) —
// how much moves on this device, how the remote scrolls, and which kind of screen change to play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionTier, scrollBehavior, historyStep, pickTransition, SETTLE_POINTS } from '../public/js/motion-rules.js';

test('motion tier: full by default, reduced by the system or the profile, none on old browsers', () => {
  assert.equal(motionTier({ systemReduce: false, profileReduce: false, modern: true }), 'full');
  assert.equal(motionTier({ systemReduce: true, profileReduce: false, modern: true }), 'reduce');
  assert.equal(motionTier({ systemReduce: false, profileReduce: true, modern: true }), 'reduce');
  assert.equal(motionTier({ systemReduce: false, profileReduce: false, modern: false }), 'none', 'old TV browsers get the instant ring only');
  assert.equal(motionTier({ systemReduce: true, profileReduce: true, modern: false }), 'none');
});

test('the remote scrolls smoothly for one press, instantly while a key is held or motion is reduced', () => {
  assert.equal(scrollBehavior({ tier: 'full', repeat: false }), 'smooth');
  assert.equal(scrollBehavior({ tier: 'full', repeat: true }), 'auto', 'a held key never queues smooth scrolls');
  assert.equal(scrollBehavior({ tier: 'reduce', repeat: false }), 'auto');
  assert.equal(scrollBehavior({ tier: 'none', repeat: false }), 'auto');
});

test('history step: going to the page before is Back, anything else is forward', () => {
  const visited = ['#/', '#/library/1'];
  assert.deepEqual(historyStep(visited, '#/'), { visited: ['#/'], dir: 'back' });
  assert.deepEqual(historyStep(visited, '#/item/7'), { visited: ['#/', '#/library/1', '#/item/7'], dir: 'forward' });
  assert.deepEqual(historyStep(visited, '#/library/1'), { visited, dir: 'none' }, 'the same address again is no move');
  assert.deepEqual(historyStep(['#/'], '#/'), { visited: ['#/'], dir: 'none' });
  assert.deepEqual(visited, ['#/', '#/library/1'], 'the list given is not changed');
});

test('which screen change plays', () => {
  const base = { tier: 'full', supported: true, dir: 'forward', fromPage: true, toPage: true, opened: false };
  assert.equal(pickTransition(base), 'section', 'a new section: a flat fade');
  assert.equal(pickTransition({ ...base, opened: true }), 'open', 'a card was opened: its poster leads the way in');
  assert.equal(pickTransition({ ...base, dir: 'back' }), 'back');
  assert.equal(pickTransition({ ...base, dir: 'back', opened: true }), 'back', 'Back wins over a stale card press');
  assert.equal(pickTransition({ ...base, dir: 'none' }), 'none', 'a refresh or redirect: no change shown');
  assert.equal(pickTransition({ ...base, toPage: false }), 'none', 'playback starts at once');
  assert.equal(pickTransition({ ...base, fromPage: false }), 'none', 'leaving the player or sign-in: no change shown');
  assert.equal(pickTransition({ ...base, supported: false, opened: true }), 'none', 'browsers without view transitions keep the page fade');
  assert.equal(pickTransition({ ...base, tier: 'none', opened: true }), 'none');
  assert.equal(pickTransition({ ...base, tier: 'reduce', opened: true }), 'section', 'reduced motion: a crossfade, nothing travels');
  assert.equal(pickTransition({ ...base, tier: 'reduce', dir: 'back' }), 'section');
});

test('the settle curve leaves at speed, overshoots its move by under a tenth, and ends at rest', () => {
  const pts = SETTLE_POINTS;
  assert.ok(pts.length >= 40, 'enough points to read as a spring');
  assert.equal(pts[0], 0);
  assert.equal(pts[pts.length - 1], 1);
  const peak = Math.max(...pts);
  assert.ok(peak > 1.05 && peak < 1.1, `peak ${peak}`);
  assert.ok(pts[1] > 0.1, 'fast at the start, so it answers the key press at once');
  assert.ok(Math.abs(pts[pts.length - 2] - 1) < 0.002, 'settled before the end: no jump on the last frame');
});
