// Rules for the Orbit layout that need no page (public/js/orbit-rules.js): what the remote's
// keys do with the floating menu, what Back does on Home, and how artwork is cropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey, menuStep, homeBack, sameLine, leftOnPage, coverRect, FRAME_QUERY } from '../public/js/orbit-rules.js';

test('Left enters the menu when nothing is to the left on the same line', () => {
  assert.equal(menuKey({ key: 'left', inMenu: false, leftTarget: 'none' }), 'enter');
  assert.equal(menuKey({ key: 'left', inMenu: false, leftTarget: 'menu' }), 'enter', 'landing on a menu entry counts as reaching the edge');
  assert.equal(menuKey({ key: 'left', inMenu: false, leftTarget: 'page' }), null, 'a card to the left: normal navigation');
  for (const key of ['up', 'down', 'right', 'back']) assert.equal(menuKey({ key, inMenu: false, leftTarget: 'none' }), null, key);
});

test('inside the menu: Up and Down move, Right and Back leave, Left stays put', () => {
  assert.equal(menuKey({ key: 'up', inMenu: true }), 'move');
  assert.equal(menuKey({ key: 'down', inMenu: true }), 'move');
  assert.equal(menuKey({ key: 'right', inMenu: true }), 'leave');
  assert.equal(menuKey({ key: 'back', inMenu: true }), 'leave');
  assert.equal(menuKey({ key: 'left', inMenu: true }), 'stay');
});

test('Up and Down in the menu stop at the ends', () => {
  assert.equal(menuStep(5, 0, 'up'), 0);
  assert.equal(menuStep(5, 0, 'down'), 1);
  assert.equal(menuStep(5, 4, 'down'), 4);
  assert.equal(menuStep(5, -1, 'down'), 0, 'from nowhere, Down starts at the top');
  assert.equal(menuStep(5, -1, 'up'), 0);
  assert.equal(menuStep(0, 0, 'down'), -1, 'an empty menu has nowhere to go');
});

test('Back on Orbit Home goes to the top first, then opens the menu', () => {
  assert.equal(homeBack({ hasMenu: true, onHome: true, atTop: false }), 'top');
  assert.equal(homeBack({ hasMenu: true, onHome: true, atTop: true }), 'menu');
  assert.equal(homeBack({ hasMenu: true, onHome: false, atTop: true }), 'back', 'other pages go back as before');
  assert.equal(homeBack({ hasMenu: false, onHome: true, atTop: false }), 'back', 'layouts without the floating menu: as before');
});

test('"on the same line" means the boxes overlap from top to bottom', () => {
  assert.equal(sameLine({ top: 0, bottom: 100 }, { top: 50, bottom: 150 }), true);
  assert.equal(sameLine({ top: 0, bottom: 100 }, { top: 100, bottom: 200 }), false, 'touching is not overlapping');
  assert.equal(sameLine({ top: 300, bottom: 400 }, { top: 0, bottom: 90 }), false);
});

test('the environment crops artwork like object-fit: cover', () => {
  assert.deepEqual(coverRect(1920, 1080, 64, 36), { sx: 0, sy: 0, sw: 1920, sh: 1080 }, 'same shape: all of it');
  // A poster (2:3) into a 16:9 box: the full width, a band a quarter of the way down (like the page's artwork).
  assert.deepEqual(coverRect(600, 900, 64, 36), { sx: 0, sy: (900 - 337.5) * 0.25, sw: 600, sh: 337.5 });
  // A very wide banner: the full height, centred.
  assert.deepEqual(coverRect(4000, 1000, 64, 36), { sx: (4000 - (1000 * 64) / 36) * 0.5, sy: 0, sw: (1000 * 64) / 36, sh: 1000 });
  assert.equal(coverRect(0, 900, 64, 36), null, 'an image that has not loaded');
});

test('the window frame needs a wide, landscape screen (the same query as public/css/orbit.css)', () => {
  assert.equal(FRAME_QUERY, '(min-width: 1000px) and (orientation: landscape)');
});

test('Left stays on the page for a control on the same line or wholly to the left; otherwise the menu opens', () => {
  const at = { top: 560, bottom: 600, left: 700, right: 1300 }; // a switch in Settings
  assert.equal(leftOnPage(at, { top: 570, bottom: 610, left: 300, right: 500 }), true, 'same line');
  assert.equal(leftOnPage(at, { top: 250, bottom: 314, left: 264, right: 564 }), true, 'a section tab further up the left column');
  assert.equal(leftOnPage(at, { top: 700, bottom: 900, left: 264, right: 1344 }), false, 'a wide row below that starts further left is not "to the left"');
  assert.equal(leftOnPage(at, null), false, 'nothing at all');
});
