// Colour maths for theme checks: APCA-W3 0.1.9 (SAPC-APCA, sRGB), WCAG 2 contrast,
// and a small CSS colour parser. Pure functions, no dependencies, no DOM.
//
// Colours are {r, g, b, a}: r/g/b are 0..255 (may be fractional for oklch results),
// a is 0..1. Neither contrast function looks at alpha; composite() first (tokens.js).

// --- APCA-W3 0.1.9 published constants ---
const mainTRC = 2.4;
const sRco = 0.2126729, sGco = 0.7151522, sBco = 0.0721750;
const normBG = 0.56, normTXT = 0.57, revTXT = 0.62, revBG = 0.65;
const blkThrs = 0.022, blkClmp = 1.414;
const scaleBoW = 1.14, scaleWoB = 1.14;
const loBoWoffset = 0.027, loWoBoffset = 0.027;
const deltaYmin = 0.0005, loClip = 0.1;

const apcaY = ({ r, g, b }) =>
  sRco * Math.pow(r / 255, mainTRC) + sGco * Math.pow(g / 255, mainTRC) + sBco * Math.pow(b / 255, mainTRC);

// Signed Lc: positive = dark text on light background, negative = light text on dark.
// Usually read by magnitude; the sign says which polarity the pair is.
export function apcaContrast(text, bg) {
  let Ytxt = apcaY(text);
  let Ybg = apcaY(bg);
  if (Number.isNaN(Ytxt) || Number.isNaN(Ybg)) return 0;
  Ytxt = Ytxt > blkThrs ? Ytxt : Ytxt + Math.pow(blkThrs - Ytxt, blkClmp);
  Ybg = Ybg > blkThrs ? Ybg : Ybg + Math.pow(blkThrs - Ybg, blkClmp);
  if (Math.abs(Ybg - Ytxt) < deltaYmin) return 0;
  if (Ybg > Ytxt) {
    const sapc = (Math.pow(Ybg, normBG) - Math.pow(Ytxt, normTXT)) * scaleBoW;
    return sapc < loClip ? 0 : (sapc - loBoWoffset) * 100;
  }
  const sapc = (Math.pow(Ybg, revBG) - Math.pow(Ytxt, revTXT)) * scaleWoB;
  return sapc > -loClip ? 0 : (sapc + loWoBoffset) * 100;
}

// --- WCAG 2 ---
const lin = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const wcagL = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function wcagRatio(a, b) {
  const la = wcagL(a), lb = wcagL(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// --- parsing ---
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Splits "a, b, c" or "a b c / d" into channel strings plus an optional alpha string.
function splitArgs(inner) {
  const slash = inner.split('/');
  if (slash.length > 2) return null;
  const parts = slash[0].trim().split(/[\s,]+/).filter(Boolean);
  let alpha = slash.length === 2 ? slash[1].trim() : null;
  if (alpha === null && parts.length === 4) alpha = parts.pop(); // legacy comma form: rgba(r,g,b,a)
  if (alpha === '') return null;
  return { parts, alpha };
}
function parseAlpha(s) {
  if (s == null) return 1;
  const n = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}
function parseNum(s, pctScale) {
  if (s === 'none') return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return s.endsWith('%') ? (n / 100) * pctScale : n;
}
function parseHue(s) {
  if (s === 'none') return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (/turn$/.test(s)) return n * 360;
  if (/grad$/.test(s)) return n * 0.9;
  if (/rad$/.test(s)) return (n * 180) / Math.PI;
  return n;
}

// OKLab -> sRGB (Bjorn Ottosson's matrices). Out-of-gamut results are clipped per
// channel (simple clipping, no chroma reduction), which is fine for contrast checks
// of in-gamut theme colours but is not CSS Color 4's gamut mapping.
function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const enc = (v) => {
    v = clamp(v, 0, 1);
    const e = 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    return Math.round(e * 1e6) / 1e6; // strip float noise so white is exactly 255
  };
  return { r: enc(lr), g: enc(lg), b: enc(lb) };
}

// Returns {r,g,b,a} or null when the string isn't a colour this module understands.
// Supports #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba() (comma or space syntax,
// number or % channels, number or % alpha) and oklch(L C H [/ alpha]).
// Named colours, hsl(), color-mix() etc. are not supported (null).
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^(rgba?|oklch)\(([^()]*)\)$/.exec(s);
  if (!m) return null;
  const args = splitArgs(m[2]);
  if (!args || args.parts.length !== 3) return null;
  const a = parseAlpha(args.alpha);
  if (a === null) return null;
  if (m[1] === 'oklch') {
    const L = parseNum(args.parts[0], 1), C = parseNum(args.parts[1], 0.4), H = parseHue(args.parts[2]);
    if (L === null || C === null || H === null) return null;
    return { ...oklchToRgb(clamp(L, 0, 1), Math.max(0, C), H), a };
  }
  const ch = args.parts.map((p) => parseNum(p, 255));
  if (ch.includes(null)) return null;
  const [r, g, b] = ch.map((v) => clamp(Math.round(v), 0, 255));
  return { r, g, b, a };
}
