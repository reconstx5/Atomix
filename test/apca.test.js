// APCA contrast, WCAG ratio, colour parsing and the theme-token reader (src/themes/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apcaContrast, wcagRatio, parseColor } from '../src/themes/apca.js';
import { readThemeTokens, composite } from '../src/themes/tokens.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} got ${a}, want ${b} ±${tol}`);
const c = (s) => parseColor(s);

test('APCA-W3 0.1.9 reference pairs (signed Lc, text on background)', () => {
  near(apcaContrast(c('#888'), c('#fff')), 63.1, 0.5, '#888 on #fff');
  near(apcaContrast(c('#fff'), c('#888')), -68.5, 0.5, '#fff on #888');
  near(apcaContrast(c('#000'), c('#fff')), 106.0, 0.5, '#000 on #fff');
  near(apcaContrast(c('#fff'), c('#000')), -107.9, 0.5, '#fff on #000');
});

test('APCA: identical colours and tiny differences give 0', () => {
  assert.equal(apcaContrast(c('#777'), c('#777')), 0);
  assert.equal(apcaContrast(c('#808080'), c('#818181')), 0); // loClip branch
  assert.equal(apcaContrast(c('#000'), c('#111')), 0); // loClip, near-black
  assert.equal(apcaContrast(c('#000000'), c('#010101')), 0); // deltaYmin branch (dY < 0.0005)
});

test('WCAG 2 ratio', () => {
  near(wcagRatio(c('#777'), c('#fff')), 4.48, 0.01);
  near(wcagRatio(c('#000'), c('#fff')), 21, 0.001);
  near(wcagRatio(c('#fff'), c('#000')), 21, 0.001, 'order-independent');
  near(wcagRatio(c('#fff'), c('#fff')), 1, 0.001);
});

test('parseColor: hex forms', () => {
  assert.deepEqual(c('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(c('#3a7bff'), { r: 0x3a, g: 0x7b, b: 0xff, a: 1 });
  assert.deepEqual(c('#0008'), { r: 0, g: 0, b: 0, a: 0x88 / 255 });
  near(c('#ffffff80').a, 128 / 255, 1e-9);
  assert.equal(c('nonsense'), null);
  assert.equal(c('#12'), null);
});

test('parseColor: rgb()/rgba() comma, space, percent alpha', () => {
  assert.deepEqual(c('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(c('rgba(255,255,255,.12)'), { r: 255, g: 255, b: 255, a: 0.12 });
  assert.deepEqual(c('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(c('rgb(10 20 30 / .25)'), { r: 10, g: 20, b: 30, a: 0.25 });
  assert.deepEqual(c('rgb(100% 0% 0%)'), { r: 255, g: 0, b: 0, a: 1 });
});

test('parseColor: oklch()', () => {
  const w = c('oklch(100% 0 0)');
  assert.deepEqual([w.r, w.g, w.b], [255, 255, 255]);
  const k = c('oklch(0% 0 0)');
  assert.deepEqual([k.r, k.g, k.b], [0, 0, 0]);
  const red = c('oklch(62.8% 0.2577 29.23)'); // sRGB red
  near(red.r, 255, 1.5); near(red.g, 0, 1.5); near(red.b, 0, 1.5);
  // Expected ~#e9ebee; cross-checked in review via an independent OKLab->XYZ->sRGB path (233.15, 235.18, 238.46).
  const p = c('oklch(94% 0.005 260)'); // near-white, faintly blue
  near(p.r, 233, 1); near(p.g, 235, 1); near(p.b, 238.5, 1); // ~#e9ebee; matrices checked against white and sRGB red above
  assert.ok(p.b >= p.r);
  assert.equal(c('oklch(0.94 0.005 260)').r, p.r, 'unitless lightness = fraction');
  near(c('oklch(50% 0.1 200 / 40%)').a, 0.4, 1e-9);
  const out = c('oklch(70% 0.4 150)'); // out of gamut: clipped, still 0..255
  for (const k2 of ['r', 'g', 'b']) assert.ok(out[k2] >= 0 && out[k2] <= 255);
});

test('composite blends alpha over a background', () => {
  const r = composite(c('rgba(255,255,255,.12)'), c('#000'));
  near(r.r, 30.6, 0.01); assert.equal(r.a, 1);
  assert.deepEqual(composite(c('#123456'), c('#fff')), { r: 0x12, g: 0x34, b: 0x56, a: 1 });
});

test('readThemeTokens: plain values and var() chains', () => {
  const css = `:root { --b: #111; --a: var(--b); --z: var(--a); }`;
  const m = readThemeTokens(css);
  assert.equal(m.get('--b'), '#111');
  assert.equal(m.get('--a'), '#111');
  assert.equal(m.get('--z'), '#111');
});

test('readThemeTokens: fallbacks, including nested var() fallback', () => {
  const m = readThemeTokens(`:root { --a: var(--x, #123); --n: var(--y, var(--a)); --p: var(--q, rgba(1,2,3,.5)); }`);
  assert.equal(m.get('--a'), '#123');
  assert.equal(m.get('--n'), '#123');
  assert.equal(m.get('--p'), 'rgba(1,2,3,.5)');
});

test('readThemeTokens: cycles do not hang and resolve to null', () => {
  const m = readThemeTokens(`:root { --a: var(--b); --b: var(--a); --ok: #fff; }`);
  assert.equal(m.get('--a'), null);
  assert.equal(m.get('--b'), null);
  assert.equal(m.get('--ok'), '#fff');
});

test('readThemeTokens: base map supplies tokens from another file', () => {
  const base = readThemeTokens(`:root { --n-1: #0a0a0a; }`);
  const m = readThemeTokens(`:root { --app-bg: var(--n-1); }`, { base });
  assert.equal(m.get('--app-bg'), '#0a0a0a');
  assert.equal(m.get('--n-1'), '#0a0a0a', 'base entries are carried');
  const mine = readThemeTokens(`:root { --n-1: #fff; --app-bg: var(--n-1); }`, { base });
  assert.equal(mine.get('--app-bg'), '#fff', 'own declaration beats base');
});

test('readThemeTokens: last understood declaration wins (hex fallback then oklch)', () => {
  const m = readThemeTokens(`:root { --a: #101010; --a: oklch(20% 0.01 260); --b: #222; --b: nonsense(1); }`);
  assert.equal(m.get('--a'), 'oklch(20% 0.01 260)');
  assert.equal(m.get('--b'), '#222', 'unparseable later value is skipped, as a browser would');
});

test('readThemeTokens: :root-level only; media queries ignored unless asked', () => {
  const css = `
    /* comment :root { --x: red; } */
    :root { --a: #111; }
    .card { --a: #999; --c: #999; }
    @media (min-width: 1600px) { :root { --a: #222; --t: #333; } }
    html:root, :root[data-theme="dark"] { --d: #444; }
    :root { --a: #555; }`;
  const m = readThemeTokens(css);
  assert.equal(m.get('--a'), '#555');
  assert.equal(m.has('--c'), false);
  assert.equal(m.has('--t'), false);
  assert.equal(m.has('--x'), false);
  assert.equal(m.get('--d'), '#444');
  const tv = readThemeTokens(css, { media: '(min-width: 1600px)' });
  assert.equal(tv.get('--t'), '#333');
  assert.equal(tv.get('--a'), '#555', 'declarations apply in source order; the later plain :root wins');
  const tv2 = readThemeTokens(`:root { --a: #111; } @media (min-width: 1600px) { :root { --a: #222; } }`, { media: '(min-width:1600px)' });
  assert.equal(tv2.get('--a'), '#222', 'a matching media block later in the file overrides (whitespace-insensitive)');
});

test('readThemeTokens: resolves rgba(255,255,255,.12) composited on #000 via parseColor+composite', () => {
  const m = readThemeTokens(`:root { --glass: rgba(255,255,255,.12); --g2: var(--glass); }`);
  const px = composite(parseColor(m.get('--g2')), parseColor('#000'));
  near(px.r, 30.6, 0.01);
});

// --- fix round 1 ---
test('statement at-rules before :root do not swallow it', () => {
  const m = readThemeTokens(`@charset "utf-8";\n@import url("a;b.css");\n@import 'x.css' layer(a);\n:root { --a: #111 }`);
  assert.equal(m.get('--a'), '#111');
});

test('base: theme overrides of primitives reach base-derived tokens', () => {
  const baseCss = `:root { --n-1: #0a0a0a; --surface: var(--n-1); }`;
  const viaText = readThemeTokens(`:root { --n-1: #fff; }`, { base: baseCss });
  assert.equal(viaText.get('--surface'), '#fff');
  const viaMap = readThemeTokens(`:root { --n-1: #fff; }`, { base: readThemeTokens(baseCss) });
  assert.equal(viaMap.get('--surface'), '#fff');
  assert.equal(readThemeTokens(`:root { --x: 1 }`, { base: readThemeTokens(baseCss) }).get('--surface'), '#0a0a0a');
});

test('context: html[data-layout] rules apply only when the context satisfies them', () => {
  const css = `:root { --x: #111 } html[data-layout="orbit"] { --x: #222 }`;
  assert.equal(readThemeTokens(css).get('--x'), '#111');
  assert.equal(readThemeTokens(css, { context: { attrs: { 'data-layout': 'orbit' } } }).get('--x'), '#222');
  assert.equal(readThemeTokens(css, { context: { attrs: { 'data-layout': 'other' } } }).get('--x'), '#111');
});

test('context: specificity beats source order, then source order breaks ties', () => {
  const dark = { context: { attrs: { 'data-theme': 'dark' } } };
  const a = `:root[data-theme="dark"] { --bg: #000 } :root { --bg: #fff }`;
  assert.equal(readThemeTokens(a, dark).get('--bg'), '#000', 'attr rule wins though earlier');
  assert.equal(readThemeTokens(a).get('--bg'), '#fff');
  const b = `:root:not([data-theme="light"]) { --v: #aaa } :root[data-theme="dark"] { --v: #bbb }`;
  assert.equal(readThemeTokens(b, dark).get('--v'), '#bbb', 'equal specificity: later wins');
  assert.equal(readThemeTokens(b).get('--v'), '#aaa', ':not() holds with no attribute');
  assert.equal(readThemeTokens(b, { context: { attrs: { 'data-theme': 'light' } } }).has('--v'), false);
  const c2 = `:root[data-theme="dark"] { --v: #bbb } :root:not([data-theme="light"]) { --v: #aaa }`;
  assert.equal(readThemeTokens(c2, dark).get('--v'), '#aaa');
  assert.equal(readThemeTokens(`html { --h: #111 } :root { --h: #222 }`).get('--h'), '#222', ':root above html');
  assert.equal(readThemeTokens(`.dark { --k: 1 } :root.dark { --k: #333 }`, { context: { classes: ['dark'] } }).get('--k'), '#333');
});

test('unevaluable root-ish rules are reported in .skipped, never silently dropped', () => {
  const m = readThemeTokens(`:root { --a: #111 } :root:hover { --b: #222 } html > body:root { --c: 1 } @container (min-width: 1px) { :root { --d: 1 } } .card { --e: 1 }`);
  assert.equal(m.get('--a'), '#111');
  assert.equal(m.has('--b'), false);
  assert.ok(m.skipped.includes(':root:hover'));
  assert.ok(m.skipped.includes('html > body:root'));
  assert.ok(m.skipped.some((s) => s.startsWith('@container')));
  assert.ok(!m.skipped.some((s) => s.includes('.card')));
  assert.deepEqual([...readThemeTokens(`:root { --a: 1 }`).skipped], []);
});

test('@layer contents apply, unlayered beats layered; @supports contents apply', () => {
  const m = readThemeTokens(`@layer base, theme; @layer base { :root[data-theme="x"] { --a: #111; --b: #111 } } :root { --a: #222 } @layer theme { :root { --b: #333 } }`,
    { context: { attrs: { 'data-theme': 'x' } } });
  assert.equal(m.get('--a'), '#222', 'unlayered beats layered despite lower specificity');
  assert.equal(m.get('--b'), '#333', 'later layer beats earlier layer despite lower specificity');
  assert.equal(readThemeTokens(`@supports (color: oklch(0 0 0)) { :root { --s: #444 } }`).get('--s'), '#444');
  assert.equal(readThemeTokens(`@supports (color: oklch(0 0 0)) { :root { --s: #444 } }`, { context: { supports: 'legacy' } }).has('--s'), false);
});

test('media option and context.media', () => {
  const css = `@media (prefers-color-scheme: dark) { :root { --m: #111 } } :root { --m: #fff }`;
  assert.equal(readThemeTokens(css).get('--m'), '#fff');
  assert.equal(readThemeTokens(css, { context: { media: ['(prefers-color-scheme:dark)'] } }).get('--m'), '#fff', 'later plain :root wins by order');
  assert.equal(readThemeTokens(`:root { --m: #fff } @media (prefers-color-scheme: dark) { :root { --m: #111 } }`, { context: { media: ['(prefers-color-scheme: dark)'] } }).get('--m'), '#111');
});

test('values: trailing tokens and relative colour syntax are kept; !important honoured; cycles with fallbacks are null', () => {
  const m = readThemeTokens(`:root { --s: #000; --s: rgba(0,0,0,.5) 0 4px 8px; --r: rgb(from #fff r g b); --i: #111 !important; --i: #222;
    --ca: var(--cb, #111); --cb: var(--ca, #222); }`);
  assert.equal(m.get('--s'), 'rgba(0,0,0,.5) 0 4px 8px');
  assert.equal(m.get('--r'), 'rgb(from #fff r g b)');
  assert.equal(m.get('--i'), '#111');
  assert.equal(m.get('--ca'), null);
  assert.equal(m.get('--cb'), null);
});

test('unterminated comment does not leak its contents', () => {
  assert.equal(readThemeTokens(`:root { --a: #111 } /* :root { --a: #222 }`).get('--a'), '#111');
});

test('@supports: modern/legacy contexts, not, and/or skipped', () => {
  const css = `:root { --g: .5 } @supports not (backdrop-filter: blur(1px)) { :root { --g: .92 } }`;
  assert.equal(readThemeTokens(css).get('--g'), '.5');
  assert.equal(readThemeTokens(css, { context: { supports: 'legacy' } }).get('--g'), '.92');
  assert.equal(readThemeTokens(`@supports selector(:has(a)) { :root { --h: 1 } }`).get('--h'), '1');
  const x = `:root { --g: .5 } @supports (a: b) and (c: d) { :root { --g: .1 } } @supports not ((a: b) or (c: d)) { :root { --g: .2 } }`;
  for (const supports of ['modern', 'legacy']) {
    const m = readThemeTokens(x, { context: { supports } });
    assert.equal(m.get('--g'), '.5');
    assert.equal(m.skipped.length, 2);
  }
});

test('unmatched @media declaring root tokens is reported in .skipped', () => {
  const m = readThemeTokens(`@media (min-width: 1600px) { :root { --t: 1 } } @media print { .x { color: red } }`);
  assert.deepEqual([...m.skipped], ['@media (min-width: 1600px)']);
});
