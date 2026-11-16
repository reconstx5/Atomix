// Visual refresh Plan A, task 6: a chosen accent works in every theme. public/js/tint.js clamps it in OKLCH (dark
// themes L 70–80 %, C 0.10–0.15; Daylight L 45–55 %; hue kept; a grey stays grey), builds the --a-1..12 ramp from it
// and picks the ink on it (black or white) by APCA, which must reach Lc 60. The client's colour maths is checked here
// against src/themes/apca.js (devtools/ramp.mjs now imports tint.js's OKLCH), so the server-side checks and the page agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAccent, accentRamp, onAccent, toOklch, oklchToHex, apcaLc, ACCENT_SWATCHES } from '../public/js/tint.js';
import { apcaContrast, wcagRatio, parseColor } from '../src/themes/apca.js';

const HEX = /^#[0-9a-f]{6}$/;
const lc = (text, bg) => apcaContrast(parseColor(text), parseColor(bg));
// OKLCH read back from a hex is a little off the target (8-bit rounding): this much is allowed.
const TOL = 0.004;
const hueDist = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// 4096 inputs: every channel at 16 levels (0, 17, ... 255).
const SWEEP = [];
for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) {
  SWEEP.push('#' + [r, g, b].map((v) => (v * 17).toString(16).padStart(2, '0')).join(''));
}

test('#ffff00 on a dark theme: L 70–80 %, C at most 0.15, hue kept (about 110)', () => {
  const out = clampAccent('#ffff00', 'dark');
  assert.match(out, HEX);
  const { L, C, H } = toOklch(out);
  assert.ok(L >= 0.70 - TOL && L <= 0.80 + TOL, `L ${L}`);
  assert.ok(C <= 0.15 + TOL && C >= 0.10 - TOL, `C ${C}`);
  assert.ok(hueDist(H, 110) <= 5, `hue ${H}`);
});

test('#101010 on a dark theme is lifted to L 70–80 % and stays grey', () => {
  const { L, C } = toOklch(clampAccent('#101010', 'dark'));
  assert.ok(L >= 0.70 - TOL && L <= 0.80 + TOL, `L ${L}`);
  assert.ok(C < 0.02, `a grey has no hue to keep: C ${C}`);
});

test('Daylight (light) clamps to L 45–55 %', () => {
  for (const c of ['#ffff00', '#101010', '#3a7bff', '#ffffff', '#ff6b3d', '#8fe9ff']) {
    const { L, C } = toOklch(clampAccent(c, 'light'));
    assert.ok(L >= 0.45 - TOL && L <= 0.55 + TOL, `${c}: L ${L}`);
    assert.ok(C <= 0.15 + TOL, `${c}: C ${C}`);
  }
});

test('onAccent is black or white, and reaches APCA Lc 60 on every clamped accent (4096 inputs × both schemes)', () => {
  const bad = [];
  for (const scheme of ['dark', 'light']) {
    for (const c of SWEEP) {
      const a = clampAccent(c, scheme);
      const ink = onAccent(a);
      assert.ok(ink === '#000' || ink === '#fff', ink);
      const v = Math.abs(lc(ink, a));
      if (v < 60) bad.push(`${scheme} ${c} → ${a} ink ${ink} Lc ${v.toFixed(1)}`);
      const { L, C, H } = toOklch(a);
      const [lo, hi] = scheme === 'dark' ? [0.70, 0.80] : [0.45, 0.55];
      if (L < lo - TOL || L > hi + TOL) bad.push(`${scheme} ${c} → ${a} L ${L.toFixed(3)}`);
      if (C > 0.15 + TOL) bad.push(`${scheme} ${c} → ${a} C ${C.toFixed(3)}`);
      const src = toOklch(c);
      if (src.C >= 0.02 && C > 0.03 && hueDist(src.H, H) > 6) bad.push(`${scheme} ${c} → ${a} hue ${src.H.toFixed(0)} → ${H.toFixed(0)}`);
      if (src.C < 0.02 && C > 0.02) bad.push(`${scheme} ${c} → ${a} grey became coloured`);
    }
  }
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} failures`);
});

test('the ink also reads on the hover step (a-10)', () => {
  for (const scheme of ['dark', 'light']) {
    for (const c of SWEEP.filter((_, i) => i % 7 === 0)) {
      const r = accentRamp(c, scheme);
      const v = Math.abs(lc(onAccent(r[9]), r[10]));
      assert.ok(v >= 60, `${scheme} ${c}: a-10 ${r[10]} Lc ${v.toFixed(1)}`);
    }
  }
});

test('a clamped accent is visible as a non-text colour (WCAG ≥ 3:1) on every built-in page colour', () => {
  const pages = { dark: ['#0c0e13', '#000000', '#0a1624', '#17191c', '#05050c'], light: ['#f4f5f8', '#ffffff'] };
  for (const scheme of ['dark', 'light']) {
    for (const c of SWEEP.filter((_, i) => i % 5 === 0)) {
      const a = clampAccent(c, scheme);
      for (const bg of pages[scheme]) assert.ok(wcagRatio(parseColor(a), parseColor(bg)) >= 3, `${scheme} ${c} → ${a} on ${bg}`);
    }
  }
});

test('accentRamp: 12 valid hex steps, a-9 the clamped accent, a-10 lighter on dark and darker on light', () => {
  for (const scheme of ['dark', 'light']) {
    for (const c of ['#ffff00', '#101010', '#3a7bff', '#ff6b3d', '#ffffff']) {
      const r = accentRamp(c, scheme);
      const steps = Array.from({ length: 12 }, (_, i) => r[i + 1]);
      for (const s of steps) assert.match(s, HEX, `${scheme} ${c}: ${steps}`);
      assert.equal(r[9], clampAccent(c, scheme));
      const L = steps.map((s) => toOklch(s).L);
      if (scheme === 'dark') {
        assert.ok(L[9] > L[8], `${c}: a-10 lighter`);
        for (let i = 1; i < 8; i++) assert.ok(L[i] > L[i - 1], `${c}: a-1..8 rise (${L.map((x) => x.toFixed(2))})`);
        assert.ok(L[11] > L[10] && L[10] >= L[9] - TOL, `${c}: a-11, a-12 light text steps`);
      } else {
        assert.ok(L[9] < L[8], `${c}: a-10 darker`);
        for (let i = 1; i < 8; i++) assert.ok(L[i] < L[i - 1], `${c}: a-1..8 fall`);
        assert.ok(L[11] < L[8], `${c}: a-12 dark text`);
      }
    }
  }
});

test('bad input: anything not #rrggbb (or #rgb) gives null', () => {
  assert.equal(clampAccent('nonsense', 'dark'), null);
  assert.equal(clampAccent('', 'dark'), null);
  assert.match(clampAccent('#fa0', 'dark'), HEX);
  assert.equal(accentRamp('red', 'dark'), null);
});

test('the client OKLCH maths agrees with src/themes/apca.js', () => {
  for (const c of SWEEP.filter((_, i) => i % 13 === 0)) {
    const a = toOklch(c);
    // Back to hex through tint.js, and through apca.js's oklch() parser: the same colour.
    const back = oklchToHex(a.L, a.C, a.H);
    assert.equal(back, c, 'round trip');
    const p = parseColor(`oklch(${a.L * 100}% ${a.C} ${a.H})`);
    const q = parseColor(back);
    for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(p[k] - q[k]) <= 0.6, `${c} ${k} ${p[k]} vs ${q[k]}`);
    // APCA: the page's copy and the checker's give the same Lc.
    for (const ink of ['#000000', '#ffffff']) assert.ok(Math.abs(apcaLc(ink, c) - lc(ink, c)) < 1e-9, `${ink} on ${c}`);
  }
});

test('ten curated swatches, named, with hues spread around the wheel', () => {
  assert.equal(ACCENT_SWATCHES.length, 10);
  const names = new Set(ACCENT_SWATCHES.map((s) => s.name));
  assert.equal(names.size, 10);
  const hues = ACCENT_SWATCHES.map((s) => toOklch(clampAccent(s.hex, 'dark')).H).sort((a, b) => a - b);
  for (let i = 0; i < hues.length; i++) {
    const gap = (hues[(i + 1) % hues.length] - hues[i] + 360) % 360;
    assert.ok(gap >= 18 && gap <= 70, `gap after ${hues[i].toFixed(0)}: ${gap.toFixed(0)} (${hues.map((h) => h.toFixed(0))})`);
  }
});
