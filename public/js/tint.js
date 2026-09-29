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
