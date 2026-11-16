import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrefs } from '../src/api/account.js';

test('glass: only the three choices are stored', () => {
  assert.equal(cleanPrefs({ glass: 'foggy' }, {}).glass, undefined);
  assert.equal(cleanPrefs({ glass: 'solid' }, {}).glass, 'solid');
});
test('pinnedLibraries: unique positive whole ids only', () => {
  assert.deepEqual(cleanPrefs({ pinnedLibraries: [2, '2', -1, 'x', 3, 1.5] }, {}).pinnedLibraries, [2, 3]);
  assert.equal(cleanPrefs({ pinnedLibraries: 'nope' }, {}).pinnedLibraries, undefined);
  assert.equal(cleanPrefs({ pinnedLibraries: null }, { pinnedLibraries: [1] }).pinnedLibraries, undefined);
  assert.equal(cleanPrefs({ pinnedLibraries: Array.from({ length: 80 }, (_, i) => i + 1) }, {}).pinnedLibraries.length, 50);
});
test('pinnedLibraries: an empty list is kept (nothing pinned is a choice)', () => {
  assert.deepEqual(cleanPrefs({ pinnedLibraries: [] }, {}).pinnedLibraries, []);
});
test('text scale, contrast and OLED', () => {
  assert.equal(cleanPrefs({ textScale: 1.15 }, {}).textScale, 1.15);
  assert.equal(cleanPrefs({ textScale: 3 }, {}).textScale, undefined);
  assert.equal(cleanPrefs({ contrast: 'more' }, {}).contrast, 'more');
  assert.equal(cleanPrefs({ contrast: 'max' }, {}).contrast, undefined);
  assert.equal(cleanPrefs({ oled: true }, {}).oled, true);
});
