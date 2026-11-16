// Arctic's backdrop that follows the focused card once the remote rests (Plan C, task 6): the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFollow, followUrl } from '../public/js/focus-backdrop-rules.js';

const item = { id: 1, backdrop: '/b.jpg', poster: '/p.jpg' };

test('follows only when the theme asks, no arrow is held, motion is not none, and the item has a backdrop', () => {
  assert.equal(shouldFollow({ flag: true, held: false, motion: 'full', item }), true);
  assert.equal(shouldFollow({ flag: true, held: false, motion: 'reduce', item }), true);
});
test('does nothing without the flag', () => assert.equal(shouldFollow({ flag: false, held: false, motion: 'full', item }), false));
test('does nothing while an arrow is held', () => assert.equal(shouldFollow({ flag: true, held: true, motion: 'full', item }), false));
test('does nothing with motion none', () => assert.equal(shouldFollow({ flag: true, held: false, motion: 'none', item }), false));
test('does nothing for an item with no backdrop or no item', () => {
  assert.equal(shouldFollow({ flag: true, held: false, motion: 'full', item: { id: 2, poster: '/p.jpg' } }), false);
  assert.equal(shouldFollow({ flag: true, held: false, motion: 'full', item: null }), false);
});
test('an episode uses its show backdrop', () => {
  assert.equal(followUrl({ showBackdrop: '/s.jpg' }), '/s.jpg');
  assert.equal(shouldFollow({ flag: true, held: false, motion: 'full', item: { showBackdrop: '/s.jpg' } }), true);
});
