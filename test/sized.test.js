// v0.24 Plan A Task 3: Orbit asks for artwork at the size it shows (public/js/sized.js, pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sized from '../public/js/sized.js';
import * as thumbs from '../src/library/thumbs.js';

const { sizedAttrs, isArtworkUrl } = sized;

test('the ladders match the server', () => {
  assert.deepEqual(sized.LADDERS, thumbs.LADDERS);
});

test('only Orbit and only Atomix artwork get sizes', () => {
  assert.deepEqual(sizedAttrs('/api/items/4/image/poster?v=9', 'poster', { orbit: false }), { src: '/api/items/4/image/poster?v=9' });
  assert.deepEqual(sizedAttrs('https://x/y.png', 'poster', { orbit: true }), { src: 'https://x/y.png' });
  assert.deepEqual(sizedAttrs(null, 'poster', { orbit: true }), { src: null });
  assert.equal(isArtworkUrl('/api/items/12/image/logo?v=1'), true);
  assert.equal(isArtworkUrl('/api/collections/3/image/backdrop'), true);
  assert.equal(isArtworkUrl('/api/live/channels/3/logo'), false);
});

test('a lazy poster lists every size and lets the browser pick', () => {
  const a = sizedAttrs('/api/items/4/image/poster?v=9', 'poster', { orbit: true });
  assert.equal(a.src, '/api/items/4/image/poster?v=9&w=300');
  assert.equal(a.srcset, '/api/items/4/image/poster?v=9&w=200 200w, /api/items/4/image/poster?v=9&w=300 300w, /api/items/4/image/poster?v=9&w=450 450w, /api/items/4/image/poster?v=9&w=600 600w');
  // Without sizes=auto (Firefox, older Safari) the browser reads the rest, which mirrors Orbit's card widths
  // (review fix F4): 116 px on phones and portrait screens, else 196 × --px (clamped like --px).
  assert.equal(a.sizes, 'auto, (max-width: 999px) 116px, (orientation: portrait) 116px, clamp(141px, 10.21vw, 392px)');
  assert.equal(sizedAttrs('/api/items/4/image/backdrop?v=9', 'backdrop', { orbit: true }).sizes, 'auto, (max-width: 999px) 240px, (orientation: portrait) 240px, clamp(242px, 17.5vw, 672px)');
  assert.equal(sizedAttrs('/api/items/4/image/poster?v=9', 'square', { orbit: true }).sizes, 'auto, (max-width: 999px) 132px, (orientation: portrait) 132px, clamp(158px, 11.46vw, 440px)');
  assert.equal(sizedAttrs('/api/items/4/image/logo?v=9', 'logo', { orbit: true }).sizes, 'auto, 500px');
});

test('an eager poster gets a plain size; a backdrop of known width gets one copy', () => {
  assert.equal(sizedAttrs('/api/items/4/image/poster?v=9', 'poster', { orbit: true, eager: true, card: true }).sizes, '(max-width: 999px) 116px, (orientation: portrait) 116px, clamp(141px, 10.21vw, 392px)');
  // A big header cover asked for at once (an album, an audiobook, Now Playing) gets the largest copy (review fix F3).
  assert.deepEqual(sizedAttrs('/api/items/4/image/poster?v=9', 'square', { orbit: true, eager: true }), { src: '/api/items/4/image/poster?v=9&w=600' });
  assert.deepEqual(sizedAttrs('/api/items/4/image/backdrop?v=9', 'backdrop', { orbit: true, width: 800 }), { src: '/api/items/4/image/backdrop?v=9&w=960' });
  assert.deepEqual(sizedAttrs('/api/items/4/image/backdrop?v=9', 'backdrop', { orbit: true, width: 4000 }), { src: '/api/items/4/image/backdrop?v=9&w=1920' });
});

test('an address without a query gets ?w=', () => {
  assert.equal(sizedAttrs('/api/collections/2/image/poster', 'poster', { orbit: true }).src, '/api/collections/2/image/poster?w=300');
});
