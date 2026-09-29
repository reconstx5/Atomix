// What the player does about intros and credits, including when it doesn't know
// the video's length yet, plus reading times typed as m:ss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { introRange, inIntro, introLeft, upNextAt, parseClock, HIDE_BEFORE_END, focusIsFree, creditsStep, reportedPosition } from '../public/js/markers.js';

test('the intro to offer skipping, kept inside the video', () => {
  assert.deepEqual(introRange({ intro: { start: 42, end: 92 } }, 1500), { start: 42, end: 92 });
  assert.deepEqual(introRange({ intro: { start: 42, end: 92 } }, 0), { start: 42, end: 92 }, 'length not known yet: as given');
  assert.deepEqual(introRange({ intro: { start: 1400, end: 1600 } }, 1500), { start: 1400, end: 1500 }, 'cut at the end of the file');
  assert.equal(introRange({ intro: { start: -3, end: 30 } }, 1500).start, 0);
  assert.equal(introRange({ intro: { start: 10, end: 11.5 } }, 1500), null, 'too short to bother');
  assert.equal(introRange({ intro: { start: 1499, end: 1600 } }, 1500), null, 'starts at the very end');
  assert.equal(introRange({ intro: null }, 1500), null);
  assert.equal(introRange(undefined, 1500), null);
});

test('when Skip intro shows, and how much intro is left', () => {
  const r = { start: 40, end: 100 };
  assert.equal(HIDE_BEFORE_END, 2);
  assert.deepEqual([39.9, 40, 97.9, 98, 120].map((t) => inIntro(r, t)), [false, true, true, false, false]);
  assert.equal(inIntro(null, 50), false);
  assert.equal(introLeft(r, 70), 0.5);
  assert.equal(introLeft(r, 10), 1);
  assert.equal(introLeft(null, 10), 0);
});

test('Up next starts when the credits do', () => {
  assert.equal(upNextAt({ credits: { start: 1300, end: 1390 } }, 1400), 1300);
  assert.equal(upNextAt({ credits: { start: 1300, end: 1390 } }, 0), 1300, 'length not known yet');
  assert.equal(upNextAt({ credits: { start: 1399.5, end: 1400 } }, 1400), null, 'right at the end: the same as no credits');
  assert.equal(upNextAt({ credits: { start: 0, end: 30 } }, 1400), null);
  assert.equal(upNextAt({ credits: null }, 1400), null);
  assert.equal(upNextAt(undefined, 1400), null);
});

test('times typed as m:ss', () => {
  assert.deepEqual(['0:42', '1:32', '92', '1:02:03', ' 1:32.5 ', '1,5'].map(parseClock), [42, 92, 92, 3723, 92.5, 1.5]);
  assert.deepEqual(['', 'abc', '1:75', '-5', '1:2:3:4', null].map(parseClock), [null, null, null, null, null, null]);
});

test('Skip intro takes focus only when nothing else has it', () => {
  const root = { tagName: 'DIV' };
  assert.equal(focusIsFree(null, root), true);
  assert.equal(focusIsFree({ tagName: 'BODY' }, root), true);
  assert.equal(focusIsFree(root, root), true, 'the player itself (where focus goes when the controls hide)');
  assert.equal(focusIsFree({ tagName: 'VIDEO' }, root), true);
  assert.equal(focusIsFree({ tagName: 'INPUT' }, root), false, 'the seek bar');
  assert.equal(focusIsFree({ tagName: 'BUTTON' }, root), false, 'a control, the notice or Up next');
});

test('Up next starts when the credits start, not a second early, once, and again after seeking back', () => {
  let s = creditsStep({ at: 80, now: 79.5, armed: true });
  assert.deepEqual(s, { armed: true, start: false }, 'not yet');
  s = creditsStep({ at: 80, now: 80, armed: s.armed });
  assert.deepEqual(s, { armed: false, start: true });
  s = creditsStep({ at: 80, now: 85, armed: s.armed });
  assert.deepEqual(s, { armed: false, start: false }, 'only once');
  s = creditsStep({ at: 80, now: 30, armed: s.armed });
  assert.deepEqual(s, { armed: true, start: false }, 'seeking back re-arms it');
  assert.deepEqual(creditsStep({ at: null, now: 90, armed: true }), { armed: true, start: false });
});

test('once the credits have started, the episode counts as watched', () => {
  const markers = { intro: null, credits: { start: 1250, end: 1420 } };
  // Anime with an "Ending" chapter at 88% of the episode: leaving from Up next must still mark it watched.
  assert.equal(reportedPosition({ position: 1260, duration: 1420, ended: false, markers }), 1420);
  assert.equal(reportedPosition({ position: 1250, duration: 1420, ended: false, markers }), 1420);
  assert.equal(reportedPosition({ position: 1249, duration: 1420, ended: false, markers }), 1249, 'not yet');
  assert.equal(reportedPosition({ position: 700, duration: 1420, ended: true, markers: null }), 1420, 'played to the end');
  assert.equal(reportedPosition({ position: 700, duration: 1420, ended: false, markers: null }), 700);
  assert.equal(reportedPosition({ position: 1300, duration: 0, ended: false, markers }), 1300, 'length unknown: as it is');
});
