// The router's first focus for a page that marks one element data-focus-now (a deep link such as the guide's
// ?channel=): public/js/focus-now-rules.js. Behind the splash the page is inert and can't take the focus, so the
// router keeps the mark and asks again once the splash lets go of the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusNowStep, focusMoved } from '../public/js/focus-now-rules.js';

const ready = { current: true, connected: true, inert: false, moved: false };

test('a marked element that can take the focus gets it now', () => {
  assert.equal(focusNowStep(ready), 'focus');
});

test('inside something inert (the page behind the splash) it waits to be asked again', () => {
  assert.equal(focusNowStep({ ...ready, inert: true }), 'wait');
});

test('a person who has moved the focus keeps it: the mark is not used', () => {
  assert.equal(focusNowStep({ ...ready, moved: true }), 'keep');
  assert.equal(focusNowStep({ ...ready, inert: true, moved: true }), 'keep');
});

test('a mark from an older page, or one no longer on the page, is dropped', () => {
  assert.equal(focusNowStep({ ...ready, current: false }), 'drop', 'a newer page change took over');
  assert.equal(focusNowStep({ ...ready, connected: false }), 'drop', 'the page redrew without it');
  assert.equal(focusNowStep({ ...ready, current: false, moved: true }), 'drop', 'not this page: the newer one decides');
});

test('focus has moved only when it is on something other than where it was, the body or the page itself', () => {
  const body = { n: 'body' };
  const main = { n: 'main' };
  const before = { n: 'old card' };
  const other = { n: 'a button' };
  assert.equal(focusMoved({ active: before, before, body, main }), false, 'where it was');
  assert.equal(focusMoved({ active: body, before, body, main }), false, 'the old page went away: focus fell to the body');
  assert.equal(focusMoved({ active: null, before, body, main }), false);
  assert.equal(focusMoved({ active: main, before, body, main }), false, 'the page itself');
  assert.equal(focusMoved({ active: other, before, body, main }), true);
});
