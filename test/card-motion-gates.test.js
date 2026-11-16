// Card motion v2 (v0.28): when a rested card may play its short silent clip (public/js/card-motion-rules.js).
// Off when motion isn't full, on data-saver or a 2g connection, on Kids profiles, with the profile's
// "Play previews on cards" off, or while the page is hidden. Everything else (and every unknown) is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewAllowed, previewMode, FLIP_FRAMES, FLIP_FRAME_MS } from '../public/js/card-motion-rules.js';

const ok = { motion: 'full', saveData: false, effectiveType: '4g', kids: false, pref: true, hidden: false };

test('full motion, a fast connection, a grown-up profile with the pref on: the clip plays', () => {
  assert.equal(previewAllowed(ok), true);
});

test('the defaults: an unset pref and an unknown connection still play', () => {
  assert.equal(previewAllowed({ motion: 'full' }), true);
  assert.equal(previewAllowed({ ...ok, pref: undefined, effectiveType: undefined, saveData: undefined }), true);
  assert.equal(previewAllowed({ ...ok, pref: null }), true);
  assert.equal(previewAllowed({ ...ok, effectiveType: '3g' }), true);
});

test('motion other than full: no clip', () => {
  assert.equal(previewAllowed({ ...ok, motion: 'reduce' }), false);
  assert.equal(previewAllowed({ ...ok, motion: 'none' }), false);
  assert.equal(previewAllowed({ ...ok, motion: undefined }), false);
});

test('data saver or a 2g connection: no clip', () => {
  assert.equal(previewAllowed({ ...ok, saveData: true }), false);
  assert.equal(previewAllowed({ ...ok, effectiveType: '2g' }), false);
  assert.equal(previewAllowed({ ...ok, effectiveType: 'slow-2g' }), false);
});

test('a Kids profile: no clip', () => {
  assert.equal(previewAllowed({ ...ok, kids: true }), false);
});

test('the profile turned "Play previews on cards" off: no clip', () => {
  assert.equal(previewAllowed({ ...ok, pref: false }), false);
});

test('a hidden page: no clip', () => {
  assert.equal(previewAllowed({ ...ok, hidden: true }), false);
});

test('called with nothing: no clip (motion unknown)', () => {
  assert.equal(previewAllowed(), false);
});

// Final review: previewMode decides everything a rested card does. Pref off, data saver or a 2g connection: nothing
// at all (no clip, no flip, no sheet or manifest request). A Kids profile: the still-frame flip only.
test('previewMode: a clip when everything allows it (unset pref, unknown connection count as on)', () => {
  assert.equal(previewMode(ok), 'clip');
  assert.equal(previewMode({ motion: 'full' }), 'clip');
});

test('previewMode: pref off, data saver or a 2g connection: no card preview at all', () => {
  assert.equal(previewMode({ ...ok, pref: false }), 'none');
  assert.equal(previewMode({ ...ok, saveData: true }), 'none');
  assert.equal(previewMode({ ...ok, effectiveType: '2g' }), 'none');
  assert.equal(previewMode({ ...ok, effectiveType: 'slow-2g' }), 'none');
  assert.equal(previewMode({ ...ok, kids: true, pref: false }), 'none', 'a Kids profile with the pref off: nothing either');
});

test('previewMode: a Kids profile gets the still-frame flip only', () => {
  assert.equal(previewMode({ ...ok, kids: true }), 'flip');
});

test('previewMode: motion not full, or a hidden page: nothing', () => {
  assert.equal(previewMode({ ...ok, motion: 'reduce' }), 'none');
  assert.equal(previewMode({ ...ok, motion: 'none' }), 'none');
  assert.equal(previewMode({ ...ok, hidden: true }), 'none');
  assert.equal(previewMode(), 'none');
});

test('the still-frame flip stays within 5 s (WCAG 2.2.2)', () => {
  assert.ok(FLIP_FRAMES * FLIP_FRAME_MS <= 5000, `${FLIP_FRAMES} × ${FLIP_FRAME_MS}`);
});
