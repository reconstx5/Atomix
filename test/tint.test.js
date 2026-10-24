// The ambient colour a title's artwork casts on the interface (public/js/tint.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientColour, luminance, contrast } from '../public/js/tint.js';

// Build RGBA pixel data from [[r,g,b,count], ...]
const pixels = (...runs) => {
  const out = [];
  for (const [r, g, b, n] of runs) for (let i = 0; i < n; i++) out.push(r, g, b, 255);
  return new Uint8ClampedArray(out);
};
const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const GRAPHITE = '#17191c';
const INK = '#0e1013';

test('grey or black artwork casts no colour', () => {
  assert.equal(ambientColour(pixels([128, 128, 128, 200], [10, 10, 10, 200], [240, 240, 240, 100])), null);
  assert.equal(ambientColour(new Uint8ClampedArray(0)), null);
});

test('a red poster gives a red light that reads on the dark background', () => {
  const c = ambientColour(pixels([200, 30, 40, 400], [20, 20, 20, 100]));
  assert.match(c, /^#[0-9a-f]{6}$/);
  const h = hue(c);
  assert.ok(h < 15 || h > 345, `red-ish hue, got ${h}`);
  assert.ok(contrast(c, GRAPHITE) >= 4.5, 'visible on the page background');
  assert.ok(contrast(c, INK) >= 4.5, 'dark text on it is readable');
});

test('a small vivid area beats a big dull one', () => {
  const c = ambientColour(pixels([90, 100, 95, 900], [20, 180, 220, 120]));
  const h = hue(c);
  assert.ok(h > 175 && h < 205, `cyan from the vivid patch, got ${h}`);
});

test('deep navy is lifted so it still glows', () => {
  const c = ambientColour(pixels([10, 20, 90, 500]));
  assert.ok(hue(c) > 220 && hue(c) < 245);
  assert.ok(luminance(c) >= 0.3, `bright enough (${luminance(c).toFixed(2)})`);
  assert.ok(contrast(c, INK) >= 6);
});

test('pale yellow is kept from washing out', () => {
  const c = ambientColour(pixels([250, 240, 170, 500]));
  assert.ok(luminance(c) <= 0.75, `not glaring (${luminance(c).toFixed(2)})`);
  assert.ok(contrast(c, INK) >= 7);
});

test('contrast helper matches WCAG', () => {
  assert.equal(Math.round(contrast('#ffffff', '#000000')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
});

test('readableAccent lifts a dark chosen colour to readable text on the dark pages, keeping its hue', async () => {
  const { readableAccent, luminance } = await import('../public/js/tint.js');
  const lifted = readableAccent('#101040');
  assert.ok(luminance(lifted) >= 0.3, `${lifted} ${luminance(lifted)}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(lifted.slice(i, i + 2), 16));
  assert.ok(b > r && b > g, 'still blue');
  assert.equal(readableAccent('#8fe9ff'), '#8fe9ff', 'a light colour is left alone');
  assert.equal(readableAccent('nonsense'), 'nonsense');
});

// v0.15.0 fix pass (C1): the ink on a chosen accent is whichever of dark/white contrasts more with the colour that is
// actually painted — the lifted one — never a fixed luminance threshold that lands at 2.9:1.
test('accentInk picks the ink with the higher contrast against the lifted accent', async () => {
  const { accentInk, readableAccent } = await import('../public/js/tint.js');
  for (const dark of ['#101040', '#400010', '#104010', '#301030']) {
    const lifted = readableAccent(dark);
    const ink = accentInk(lifted);
    assert.ok(contrast(lifted, ink) >= 4.5, `${dark} → ${lifted} with ${ink} is ${contrast(lifted, ink).toFixed(2)}:1`);
  }
  assert.equal(accentInk('#ffffff'), '#111111');
  assert.equal(accentInk('#000000'), '#ffffff');
});
