// Prints the --n-1..12 / --a-1..12 ramps for a built-in theme (visual refresh, Plan A task 2), as the two blocks a
// theme.css carries: hex in :root (every browser) and the same colours in oklch() inside @supports (browsers that
// know oklch). The anchors are today's colours, kept exactly; the steps between them are interpolated in OKLCH.
//   node devtools/ramp.mjs midnight        one theme's CSS
//   node devtools/ramp.mjs --table         a table of every theme's steps (for reports)
// Anchors per theme: which step is which old token. Plan C retunes by editing these.
import { parseColor, apcaContrast } from '../src/themes/apca.js';
import { composite } from '../src/themes/tokens.js';
import { toOklch, oklchToHex } from '../public/js/tint.js';
import { pathToFileURL } from 'node:url';

const THEMES = {
  // n: {step: hex} anchors; the rest interpolated. accent: a-9. light: Daylight's ramp runs dark-on-light.
  midnight: { n: { 1: '#101219', 2: '#151923', 3: '#1b1f2c', 4: '#212636', 5: '#272d3f', 6: '#2f364c', 11: '#a3abba', 12: '#eef1f6' }, accent: '#ff6b3d' },
  obsidian: { n: { 1: '#000000', 2: '#070708', 3: '#111114', 4: '#1c1c22', 11: '#a1a1ad', 12: '#dedde2' }, accent: '#a78bfa' },
  harbour: { n: { 1: '#0a1624', 2: '#0e1c2e', 3: '#132338', 4: '#1b3150', 11: '#9fb4cc', 12: '#eaf3ff' }, accent: '#2fb8f0' },
  arctic: { n: { 1: '#17191c', 2: '#1c1f23', 3: '#22262b', 4: '#2c3137', 11: '#a3aab3', 12: '#eef1f4' }, accent: '#7cc7e8' },
  'arctic-side': { accent: '#e8e8e8' }, // its neutrals come from Arctic (@import)
  // Orbit: n-3 is its glass colour as an opaque swatch (theme.json's preview surface), n-4 its 14% white glass on
  // the page, n-11 its 66% white text on the page, n-12 oklch(94% 0.005 285): a soft off-white, so the pure-white focus ring
  // is the brightest thing on screen; the old names keep their glass/alpha values in theme.css.
  orbit: { n: { 1: '#05050c', 2: '#0b0b16', 3: '#1c1c2a', 4: '#28282e', 11: '#aaaaac', 12: '#ebebee' }, accent: '#8fe9ff' },
  daylight: { n: { 1: '#f4f5f8', 2: '#eceef3', 3: '#ffffff', 4: '#e6e9f0', 11: '#4d5669', 12: '#121826' }, accent: '#2457e6', light: true },
};

// The OKLCH maths (sRGB <-> OKLab) is public/js/tint.js's, the one copy; toHex keeps this file's old name.
const toHex = oklchToHex;
const mixHue = (h1, c1, h2, c2, t) => {
  if (c1 < 0.005) return h2;
  if (c2 < 0.005) return h1;
  let d = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + d * t + 360) % 360;
};
export function oklchText(hex) {
  const { L, C, H } = toOklch(hex);
  return `oklch(${(L * 100).toFixed(2)}% ${C.toFixed(4)} ${C < 1e-4 ? 0 : H.toFixed(2)})`;
}

function neutralRamp(anchors) {
  const steps = Object.keys(anchors).map(Number).sort((a, b) => a - b);
  const out = {};
  for (let n = 1; n <= 12; n++) {
    if (anchors[n]) { out[n] = anchors[n]; continue; }
    const lo = steps.filter((s) => s < n).pop(), hi = steps.find((s) => s > n);
    const A = toOklch(anchors[lo]), B = toOklch(anchors[hi]), t = (n - lo) / (hi - lo);
    out[n] = toHex(A.L + (B.L - A.L) * t, A.C + (B.C - A.C) * t, mixHue(A.H, A.C, B.H, B.C, t));
  }
  return out;
}
function accentRamp(accent, bgHex, light) {
  const A = toOklch(accent), bg = toOklch(bgHex), out = {};
  const at = (L, cf) => toHex(Math.min(0.99, Math.max(0, L)), A.C * cf, A.H);
  if (!light) {
    const L1 = bg.L + 0.03, L8 = A.L - 0.14;
    for (let n = 1; n <= 8; n++) { const t = (n - 1) / 7; out[n] = at(L1 + (L8 - L1) * t, 0.15 + 0.6 * t); }
    out[9] = accent;
    const L11 = Math.min(0.99, Math.max(A.L + 0.06, 0.82));
    out[10] = at(Math.min(0.985, A.L + 0.06), 1);
    out[11] = at(L11, 0.8);
    out[12] = at(Math.min(0.995, Math.max(0.95, L11 + 0.02)), 0.3);
  } else {
    const L1 = 0.99, L8 = A.L + 0.24;
    for (let n = 1; n <= 8; n++) { const t = (n - 1) / 7; out[n] = at(L1 + (L8 - L1) * t, 0.05 + 0.6 * t); }
    out[9] = accent;
    out[10] = at(A.L - 0.05, 1);
    out[11] = at(Math.min(A.L - 0.08, 0.45), 0.9);
    out[12] = at(0.28, 0.5);
  }
  return out;
}
// Orbit's glass over its environment (theme.css: the artwork under a 50% veil of --bg, black to white art): Solid
// rgba(24,24,36,.94) and Tinted rgba(28,28,42,.55) on the darkest and lightest point. --text-low must read on these too.
const orbitGlass = () => {
  const veil = { r: 5, g: 5, b: 12, a: 0.5 };
  const envs = [composite(veil, { r: 0, g: 0, b: 0, a: 1 }), composite(veil, { r: 255, g: 255, b: 255, a: 1 })];
  return [{ r: 24, g: 24, b: 36, a: 0.94 }, { r: 28, g: 28, b: 42, a: 0.55 }].flatMap((g) => envs.map((e) => composite(g, e)));
};
THEMES.orbit.extraBg = orbitGlass;

// --text-low (n-11) must reach APCA Lc 60 on the page and every surface (n-1..n-5, plus extraBg). Where today's
// --text-dim doesn't, n-11 is moved towards n-12 in OKLCH, 1 % at a time, just far enough (--text-dim and --text-low
// both read n-11). Returns the move so reports can show it.
const LC_LOW = 60.5; // a little over 60 so the oklch() rounding can't tip it under
function neutralWithReadableLow(anchors, extra = []) {
  let n = neutralRamp(anchors);
  const from = anchors[11];
  const worst = (r) => Math.min(...[1, 2, 3, 4, 5].map((i) => parseColor(r[i])).concat(extra).map((bg) => Math.abs(apcaContrast(parseColor(r[11]), bg))));
  if (worst(n) >= LC_LOW) return { n, moved: null };
  const A = toOklch(from), B = toOklch(anchors[12]);
  for (let t = 0.01; t <= 1; t += 0.01) {
    const hex = toHex(A.L + (B.L - A.L) * t, A.C + (B.C - A.C) * t, mixHue(A.H, A.C, B.H, B.C, t));
    n = neutralRamp({ ...anchors, 11: hex });
    if (worst(n) >= LC_LOW) return { n, moved: { from, to: hex, t: Math.round(t * 100) / 100, lc: Math.round(worst(n) * 10) / 10 } };
  }
  throw new Error('no readable --text-low');
}
export function ramps(name) {
  const t = THEMES[name];
  const { n, moved } = t.n ? neutralWithReadableLow(t.n, t.extraBg ? t.extraBg() : []) : { n: null, moved: null };
  const bg = (t.n || THEMES.arctic.n)[1];
  return { n, a: accentRamp(t.accent, bg, t.light), moved };
}
export const themeNames = Object.keys(THEMES);

function css(name) {
  const { n, a } = ramps(name);
  const list = [...(n ? Object.entries(n).map(([k, v]) => [`--n-${k}`, v]) : []), ...Object.entries(a).map(([k, v]) => [`--a-${k}`, v])];
  const hex = list.map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const ok = list.map(([k, v]) => `    ${k}: ${oklchText(v)};`).join('\n');
  return `:root {\n${hex}\n}\n@supports (color: oklch(0% 0 0)) {\n  :root {\n${ok}\n  }\n}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg === '--table') {
    for (const name of themeNames) {
      const { n, a } = ramps(name);
      console.log(`\n${name}\n| step | n | a |\n|---|---|---|`);
      for (let i = 1; i <= 12; i++) console.log(`| ${i} | ${n ? n[i] : '(arctic)'} | ${a[i]} |`);
      const { moved } = ramps(name);
      if (moved) console.log(`n-11 moved ${moved.from} -> ${moved.to} (${moved.t * 100}% towards n-12), worst Lc ${moved.lc}`);
    }
  } else if (THEMES[arg]) console.log(css(arg));
  else { console.error(`usage: node devtools/ramp.mjs <${themeNames.join('|')}> | --table`); process.exit(2); }
}
