import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, pageLabel, pairNames } from '../devtools/gallery-rules.mjs';

test('parseName splits theme, size and page (themes may contain a hyphen)', () => {
  assert.deepEqual(parseName('arctic-side-tv-_item_1.png'), { theme: 'arctic-side', size: 'tv', page: '_item_1', name: 'arctic-side-tv-_item_1' });
  assert.deepEqual(parseName('midnight-phone-_.png'), { theme: 'midnight', size: 'phone', page: '_', name: 'midnight-phone-_' });
  assert.equal(parseName('fixtures.json'), null);
  assert.equal(parseName('orbit-desk-_.html'), null);
});

test('pageLabel gives a plain name for each page', () => {
  assert.equal(pageLabel('_'), 'Home');
  assert.equal(pageLabel('_library_1'), 'Library');
  assert.equal(pageLabel('_item_1'), 'Title page');
  assert.equal(pageLabel('_live'), 'Live TV');
  assert.equal(pageLabel('_settings'), 'Settings');
  assert.equal(pageLabel('_odd'), '_odd');
});

test('pairNames lists every before picture and reports the ones the after folder lacks', () => {
  const r = pairNames(['a-desk-_.png', 'a-tv-_.png', 'fixtures.json'], ['a-desk-_.png']);
  assert.deepEqual(r.pairs.map((p) => p.name), ['a-desk-_', 'a-tv-_']);
  assert.deepEqual(r.missing, ['a-tv-_']);
});
