// The Home arrangement as a pure function: order, hidden rows, and rows new to a saved arrangement (v0.22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLayout, validateLayout } from '../src/home/layout.js';

const rows = (...keys) => keys.map((key) => ({ key }));
const keys = (rs) => rs.map((r) => r.key);

test('applyLayout orders and hides', () => {
  const out = applyLayout(rows('continue', 'watchlist', 'recent-1'), { order: [{ key: 'watchlist' }, { key: 'continue', hidden: true }, { key: 'recent-1' }], pins: [] });
  assert.deepEqual(keys(out), ['watchlist', 'recent-1']);
});

test('a row new to a layout goes to its default place', () => {
  const out = applyLayout(rows('continue', 'recent-7', 'picks'), { order: [{ key: 'continue' }, { key: 'picks' }], pins: [] });
  assert.deepEqual(keys(out), ['continue', 'recent-7', 'picks']);
});

test('a new row whose earlier neighbours were moved follows the nearest one the layout places', () => {
  // Default build order: continue, watchlist, lists, recent-1, recent-2. The person put lists first and recent-1 before continue.
  const out = applyLayout(rows('continue', 'watchlist', 'lists', 'recent-1', 'recent-2'), { order: [{ key: 'lists' }, { key: 'recent-1' }, { key: 'continue' }, { key: 'watchlist' }], pins: [] });
  assert.deepEqual(keys(out), ['lists', 'recent-1', 'recent-2', 'continue', 'watchlist']);
});

test('a new row with nothing placed before it goes first', () => {
  const out = applyLayout(rows('continue', 'watchlist'), { order: [{ key: 'watchlist' }], pins: [] });
  assert.deepEqual(keys(out), ['continue', 'watchlist']);
});

test('no layout keeps the built order; keys the layout names but nobody built are skipped', () => {
  assert.deepEqual(keys(applyLayout(rows('a', 'b'), null)), ['a', 'b']);
  assert.deepEqual(keys(applyLayout(rows('a'), { order: [{ key: 'pin-1234abcd' }, { key: 'a' }], pins: [] })), ['a']);
});

test('a bad layout is refused', () => {
  assert.throws(() => validateLayout({ order: Array.from({ length: 81 }, (_, i) => ({ key: `k${i}` })), pins: [] }), (e) => e.status === 400);
  assert.throws(() => validateLayout({ order: [{ key: 'x'.repeat(81) }], pins: [] }), (e) => e.status === 400);
  assert.throws(() => validateLayout({ order: 'nope' }), (e) => e.status === 400);
  assert.throws(() => validateLayout({ order: [{ key: 'a' }, { key: 'a' }], pins: [] }), (e) => e.status === 400, 'a key twice');
  assert.deepEqual(validateLayout({ order: [{ key: 'a', hidden: true }, { key: 'b' }] }), { order: [{ key: 'a', hidden: true }, { key: 'b', hidden: false }], pins: [] });
});
