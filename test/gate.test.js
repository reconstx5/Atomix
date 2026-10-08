// The gate decides what a page load shows (public/js/gate.js): the splash and the picker on a
// fresh open, nothing on a reload, the picker again after the idle time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateDecision } from '../public/js/gate.js';

const MIN = 60_000;
const now = 1_700_000_000_000;

test('a fresh open (no note) plays the splash, then the picker when the account needs one', () => {
  assert.equal(gateDecision({ note: null, now, idleMinutes: 30, needsPicker: true }), 'splash+picker');
  assert.equal(gateDecision({ note: null, now, idleMinutes: 30, needsPicker: false }), 'splash');
});

test('a fresh note (a reload) shows nothing extra', () => {
  const note = { profileId: 1, lastActive: now - 29 * MIN };
  assert.equal(gateDecision({ note, now, idleMinutes: 30, needsPicker: true }), 'nothing');
});

test('a stale note brings the picker back, without the splash', () => {
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 30 * MIN }, now, idleMinutes: 30, needsPicker: true }), 'picker', 'exactly the limit counts as stale');
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 5 * 60 * MIN }, now, idleMinutes: 30, needsPicker: true }), 'picker');
});

test('with nothing to pick, a stale note shows nothing', () => {
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 60 * MIN }, now, idleMinutes: 30, needsPicker: false }), 'nothing');
});

test('an idle time of 0 means never', () => {
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 9999 * MIN }, now, idleMinutes: 0, needsPicker: true }), 'nothing');
});

test('a note without a usable time is treated as a fresh open', () => {
  assert.equal(gateDecision({ note: { profileId: 1 }, now, idleMinutes: 30, needsPicker: true }), 'splash+picker');
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: 'yesterday' }, now, idleMinutes: 30, needsPicker: true }), 'splash+picker');
});

test("a note for a different profile than the server's is a stale open: the picker, not the page", () => {
  // The tab's note says profile 2, but the session (or a reload after the idle picker) serves profile 1.
  const note = { profileId: 2, lastActive: now - MIN };
  assert.equal(gateDecision({ note, now, idleMinutes: 30, needsPicker: true, profileId: 1 }), 'picker');
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - MIN }, now, idleMinutes: 30, needsPicker: true, profileId: 1 }), 'nothing');
  assert.equal(gateDecision({ note, now, idleMinutes: 30, needsPicker: true }), 'nothing', 'no profile given: the note stands');
});

test('the return address is only for the profile that was on', async () => {
  const { rememberReturn, takeReturn } = await import('../public/js/gate.js');
  rememberReturn('#/item/4', 1);
  assert.equal(takeReturn(2), null, 'another profile starts at Home');
  rememberReturn('#/item/4', 1);
  assert.equal(takeReturn(1), '#/item/4');
  assert.equal(takeReturn(1), null, 'taken once');
});

test('with sessionStorage blocked, the note helpers never throw and the note still reads back from memory', async () => {
  const { readNote, writeNote, touchNote, clearNote } = await import('../public/js/gate.js');
  // A browser with storage blocked: touching sessionStorage throws a SecurityError.
  globalThis.window = {
    get sessionStorage() {
      throw new Error('SecurityError: storage is blocked');
    },
  };
  try {
    assert.doesNotThrow(() => writeNote(7, now));
    assert.deepEqual(readNote(), { profileId: 7, lastActive: now }, 'the in-memory copy stands in for storage');
    assert.doesNotThrow(() => touchNote(now + MIN, { force: true }));
    assert.equal(readNote().lastActive, now + MIN);
    assert.doesNotThrow(() => clearNote());
    assert.equal(readNote(), null);
  } finally {
    delete globalThis.window;
  }
});
