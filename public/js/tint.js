// The "ambient light" a title's artwork casts on the interface, like a TV that
// glows the colour of what's playing onto the wall behind it. Pure functions,
// no DOM, so the maths is tested in Node (test/tint.test.js).

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const rgbOf = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(c) {
  const [r, g, b] = rgbOf(c).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return hex(f(0), f(8), f(4));
}

/**
 * The dominant vivid colour in RGBA pixel data, normalised into a light that is
 * visible on a dark background and keeps dark text on top of it readable.
 * Returns null when the picture has no real colour (grey, black, washed out).
 * @param {Uint8ClampedArray|number[]} data RGBA bytes (e.g. from getImageData)
 */
export function ambientColour(data) {
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, x: 0, y: 0, s: 0 }));
  let counted = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    counted++;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const l = (max + min) / 2;
    if (d < 0.06 || l < 0.05 || l > 0.97) continue;
    const s = d / (1 - Math.abs(2 * l - 1));
    if (s < 0.2) continue;
    const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    const hue = (h + 360) % 360;
    // Vivid mid-tones count most; dim or pale pixels hardly at all.
    const w = s * s * (1 - Math.abs(l - 0.5) * 1.4) ** 2;
    const bucket = buckets[Math.floor(hue / 30) % 12];
    bucket.w += w;
    bucket.x += w * Math.cos((hue * Math.PI) / 180);
    bucket.y += w * Math.sin((hue * Math.PI) / 180);
    bucket.s += w * s;
  }
  if (!counted) return null;
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  // Too little colour overall: stay neutral rather than invent a tint.
  if (best.w < counted * 0.004) return null;
  const hue = ((Math.atan2(best.y, best.x) * 180) / Math.PI + 360) % 360;
  const sat = Math.min(0.78, Math.max(0.38, best.s / best.w));
  // Walk the lightness until the colour sits in a comfortable luminance band.
  let l = 0.66;
  let c = hslToHex(hue, sat, l);
  for (let i = 0; i < 20 && luminance(c) < 0.3; i++) c = hslToHex(hue, sat, (l += 0.015));
  for (let i = 0; i < 20 && luminance(c) > 0.62; i++) c = hslToHex(hue, sat, (l -= 0.015));
  return c;
}

// ---- A chosen accent (visual refresh A6) ----
// The colour a profile picks is moved into a band that works on its theme, in OKLCH (Björn Ottosson's OKLab; the same
// maths as devtools/ramp.mjs and src/themes/apca.js, which test/accent-clamp.test.js checks this copy against):
// dark themes L 70–80 %, light ones L 45–55 %, chroma 0.10–0.15, hue kept. The ink on it is black or white by APCA.

const linS = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** "#rrggbb" or "#rgb" → "#rrggbb" (lower case), else null. */
function normHex(c) {
  const s = String(c ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((x) => x + x).join('');
  return null;
}

/** #rrggbb → { L (0–1), C, H (degrees) }. */
export function toOklch(c) {
  const [R, G, B] = rgbOf(c).map(linS);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, b);
  const H = C < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { L, C, H };
}
function oklchRaw(L, C, H) { // unclipped sRGB (gamma-free, 0–1 when in gamut)
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (L, C, H) => oklchRaw(L, C, H).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
/** OKLCH → #rrggbb. Out of sRGB, chroma is lowered (lightness and hue kept) until it fits. */
export function oklchToHex(L, C, H) {
  if (!inGamut(L, C, H)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (inGamut(L, mid, H)) lo = mid; else hi = mid; }
    C = lo;
  }
  const enc = (v) => { v = Math.min(1, Math.max(0, v)); return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; };
  return hex(...oklchRaw(L, C, H).map(enc));
}

// APCA-W3 0.1.9 (as src/themes/apca.js): signed Lc of text on bg, both #rrggbb.
const apcaY = (c) => { const [r, g, b] = rgbOf(c); return 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4; };
export function apcaLc(text, bg) {
  let t = apcaY(normHex(text)), k = apcaY(normHex(bg));
  t = t > 0.022 ? t : t + (0.022 - t) ** 1.414;
  k = k > 0.022 ? k : k + (0.022 - k) ** 1.414;
  if (Math.abs(k - t) < 0.0005) return 0;
  if (k > t) { const s = (k ** 0.56 - t ** 0.57) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
  const s = (k ** 0.65 - t ** 0.62) * 1.14;
  return s > -0.1 ? 0 : (s + 0.027) * 100;
}

/** The ink to write on an accent: '#000' or '#fff', whichever has the larger APCA |Lc| on it. */
export function onAccent(c) {
  const a = normHex(c);
  if (!a) return '#fff';
  return Math.abs(apcaLc('#000000', a)) >= Math.abs(apcaLc('#ffffff', a)) ? '#000' : '#fff';
}

const BANDS = { dark: [0.70, 0.80], light: [0.45, 0.55] };
const C_MIN = 0.10, C_MAX = 0.15, GREY = 0.02;
// The ink must reach Lc 60; the clamp aims a little higher so near-black inks (Orbit's #0b0b16, #111) still pass.
const INK_LC = 62;

/**
 * A chosen colour moved into the band its theme needs (scheme 'dark' or 'light', theme.json's colorScheme): L 70–80 %
 * on dark themes, 45–55 % on light ones; chroma 0.10–0.15 with the hue kept. A grey (C < 0.02) has no hue to keep and
 * stays grey (C 0). Inside the band the lightness moves on (up on dark, down on light) only as far as the ink needs to
 * reach APCA Lc 62. Returns #rrggbb, or null for anything that isn't a hex colour.
 */
export function clampAccent(c, scheme = 'dark') {
  const src = normHex(c);
  if (!src) return null;
  const light = scheme === 'light';
  const [lo, hi] = BANDS[light ? 'light' : 'dark'];
  const { L, C, H } = toOklch(src);
  const grey = C < GREY;
  const chroma = grey ? 0 : Math.min(C_MAX, Math.max(C_MIN, C));
  let l = Math.min(hi, Math.max(lo, L));
  let out = oklchToHex(l, chroma, H);
  const ink = light ? '#ffffff' : '#000000';
  for (let i = 0; i < 40 && Math.abs(apcaLc(ink, out)) < INK_LC; i++) {
    l = light ? Math.max(lo, l - 0.0025) : Math.min(hi, l + 0.0025);
    out = oklchToHex(l, chroma, H);
    if (l === lo || l === hi) break;
  }
  return out;
}

/**
 * The --a-1..12 ramp from a chosen colour, as { 1: hex, ... 12: hex }: a-9 is the clamped accent, a-10 its hover
 * (lighter on dark, darker on light), the rest follow devtools/ramp.mjs (1–2 backgrounds, 3–8 tints, 11–12 text).
 */
export function accentRamp(c, scheme = 'dark') {
  const a9 = clampAccent(c, scheme);
  if (!a9) return null;
  const A = toOklch(a9);
  const at = (L, cf) => oklchToHex(Math.min(0.995, Math.max(0, L)), A.C * cf, A.H);
  const out = {};
  if (scheme !== 'light') {
    const L1 = 0.19, L8 = A.L - 0.14; // a-1 just over a dark page (~16 %)
    for (let n = 1; n <= 8; n++) { const t = (n - 1) / 7; out[n] = at(L1 + (L8 - L1) * t, 0.15 + 0.6 * t); }
    out[9] = a9;
    out[10] = at(A.L + 0.05, 1);
    const L11 = Math.max(A.L + 0.08, 0.86);
    out[11] = at(L11, 0.8);
    out[12] = at(Math.max(0.95, L11 + 0.04), 0.3);
  } else {
    const L1 = 0.99, L8 = A.L + 0.24;
    for (let n = 1; n <= 8; n++) { const t = (n - 1) / 7; out[n] = at(L1 + (L8 - L1) * t, 0.05 + 0.6 * t); }
    out[9] = a9;
    out[10] = at(A.L - 0.05, 1);
    out[11] = at(Math.min(A.L - 0.08, 0.42), 0.9);
    out[12] = at(0.28, 0.5);
  }
  return out;
}

/** The curated colours Settings offers (Settings → Appearance), hues spread around the wheel. Stored as chosen. */
export const ACCENT_SWATCHES = [
  { name: 'Red', hex: '#e5484d' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Amber', hex: '#ffb224' },
  { name: 'Yellow', hex: '#f5d90a' },
  { name: 'Green', hex: '#30a46c' },
  { name: 'Teal', hex: '#12a594' },
  { name: 'Sky', hex: '#3cb8e8' },
  { name: 'Blue', hex: '#3a7bff' },
  { name: 'Violet', hex: '#8e4ec6' },
  { name: 'Pink', hex: '#d6409f' },
];
