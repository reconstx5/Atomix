import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glassMode, contrastMode, textScale, orderLibraries, movePinned, oledMode } from '../public/js/appearance-rules.js';

const desk = { tv: false, backdropFilter: true, reducedTransparency: false };

test('glass: an old Reduce effects choice reads as Solid', () => assert.equal(glassMode({ reduceEffects: true }, desk), 'solid'));
test('glass: TV-size screens default to Solid', () => assert.equal(glassMode({}, { ...desk, tv: true }), 'solid'));
test('glass: no backdrop-filter means Solid', () => assert.equal(glassMode({}, { ...desk, backdropFilter: false }), 'solid'));
test('glass: reduced transparency forces Solid over a choice', () => assert.equal(glassMode({ glass: 'clear' }, { ...desk, reducedTransparency: true }), 'solid'));
test('glass: desktop default is Tinted', () => assert.equal(glassMode({}, desk), 'tinted'));
test('glass: an explicit choice beats the TV default', () => assert.equal(glassMode({ glass: 'clear' }, { ...desk, tv: true }), 'clear'));
test('glass: an unknown value falls back to the default', () => assert.equal(glassMode({ glass: 'foggy' }, desk), 'tinted'));
test('glass: an explicit choice beats an old reduceEffects', () => assert.equal(glassMode({ glass: 'tinted', reduceEffects: true }, desk), 'tinted'));

test('contrast: unset follows the system', () => {
  assert.equal(contrastMode({}, { prefersMore: true }), 'more');
  assert.equal(contrastMode({}, { prefersMore: false }), 'normal');
});
test('contrast: the profile overrides the system', () => {
  assert.equal(contrastMode({ contrast: 'normal' }, { prefersMore: true }), 'normal');
  assert.equal(contrastMode({ contrast: 'more' }, { prefersMore: false }), 'more');
});

test('text scale: only the three sizes', () => {
  assert.equal(textScale({ textScale: 1.3 }), 1.3);
  assert.equal(textScale({ textScale: 1.15 }), 1.15);
  assert.equal(textScale({ textScale: 2 }), 1);
  assert.equal(textScale({}), 1);
});

const libs = [1, 2, 3, 4].map((id) => ({ id, name: `L${id}` }));
test('pinned: in pref order, unknown ids ignored, the rest after', () => {
  const r = orderLibraries(libs, [3, 1, 99]);
  assert.deepEqual(r.pinned.map((l) => l.id), [3, 1]);
  assert.deepEqual(r.rest.map((l) => l.id), [2, 4]);
});
test('pinned: no pref keeps every library in the menu', () => {
  for (const p of [undefined, null, []]) {
    const r = orderLibraries(libs, p);
    assert.deepEqual(r.pinned.map((l) => l.id), [1, 2, 3, 4]);
    assert.deepEqual(r.rest, []);
  }
});
test('pinned: pins that all point at gone libraries keep every library', () => {
  const r = orderLibraries(libs, [77]);
  assert.deepEqual(r.pinned.map((l) => l.id), [1, 2, 3, 4]);
});
test('movePinned: up, down, pin, unpin and the edges', () => {
  assert.deepEqual(movePinned([1, 2, 3], 2, -1), [2, 1, 3]);
  assert.deepEqual(movePinned([1, 2, 3], 2, 1), [1, 3, 2]);
  assert.deepEqual(movePinned([1, 2, 3], 1, -1), [1, 2, 3]);
  assert.deepEqual(movePinned([1, 2, 3], 3, 1), [1, 2, 3]);
  assert.deepEqual(movePinned([1, 2], 4, 'pin'), [1, 2, 4]);
  assert.deepEqual(movePinned([1, 2], 2, 'pin'), [1, 2]);
  assert.deepEqual(movePinned([1, 2], 1, 'unpin'), [2]);
  assert.deepEqual(movePinned(undefined, 5, 'pin'), [5]);
});

test('glass: More contrast makes panels Solid', () => assert.equal(glassMode({ glass: 'clear' }, { ...desk, contrastMore: true }), 'solid'));

// Card motion's sheen and preview clips stop only when the profile chose Solid (or the old Reduce effects), not when
// a TV-size screen or a browser without blur gets Solid by default.
import { effectsReduced } from '../public/js/appearance-rules.js';
test('effects: reduced only by the profile\'s own choice', () => {
  assert.equal(effectsReduced({ glass: 'solid' }), true);
  assert.equal(effectsReduced({ reduceEffects: true }), true);
  assert.equal(effectsReduced({ glass: 'tinted', reduceEffects: true }), false);
  assert.equal(effectsReduced({}), false);
});

test('oled: a theme that is True black by default is on', () => assert.equal(oledMode({}, { colorScheme: 'dark', oled: true }), true));
test('oled: the profile can turn it off', () => assert.equal(oledMode({ oled: false }, { colorScheme: 'dark', oled: true }), false));
test('oled: never on a light theme', () => assert.equal(oledMode({ oled: true }, { colorScheme: 'light' }), false));
test('oled: off by default, on when the profile asks', () => {
  assert.equal(oledMode({}, { colorScheme: 'dark' }), false);
  assert.equal(oledMode({ oled: true }, { colorScheme: 'dark' }), true);
  assert.equal(oledMode(), false);
});
