// Audio fingerprints for finding a TV show's intro: the theme tune is the longest
// stretch of sound that episodes of a season share. Pure functions, no I/O.
//
// Method (after Haitsma & Kalker, "A Highly Robust Audio Fingerprinting System",
// 2002): 8 kHz mono audio is cut into 128 ms frames every 64 ms. Each frame gives a
// 32-bit code: for each pair of neighbouring frequency bands (33 bands, 300–2000
// Hz), did their energy difference go up or down since the previous frame? Two
// recordings of the same tune differ in only a few bits, even after different lossy
// encoding or a volume change.

export const SAMPLE_RATE = 8000;
const FRAME = 1024;
const HOP = 512;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 2000;
export const HOP_SECONDS = HOP / SAMPLE_RATE;

const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
// FFT bin where each band starts (log-spaced), plus the end of the last band.
const EDGES = Array.from({ length: BANDS + 1 }, (_, m) => Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (m / BANDS)) / (SAMPLE_RATE / FRAME)));

/** In-place radix-2 FFT; `re` and `im` have the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** 16-bit PCM at SAMPLE_RATE → one 32-bit code per 64 ms. */
export function fingerprint(samples) {
  const frames = samples.length >= FRAME ? Math.floor((samples.length - FRAME) / HOP) + 1 : 0;
  const out = new Uint32Array(Math.max(0, frames - 1));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = (samples[base + i] / 32768) * HANN[i];
      im[i] = 0;
    }
    fft(re, im);
    const energy = new Float64Array(BANDS);
    for (let m = 0; m < BANDS; m++) {
      let sum = 0;
      const to = Math.max(EDGES[m + 1], EDGES[m] + 1);
      for (let k = EDGES[m]; k < to; k++) sum += re[k] * re[k] + im[k] * im[k];
      energy[m] = sum;
    }
    if (prev) {
      let code = 0;
      for (let m = 0; m < 32; m++) if (energy[m] - energy[m + 1] - (prev[m] - prev[m + 1]) > 0) code |= 1 << m;
      out[f - 1] = code >>> 0;
    }
    prev = energy;
  }
  return out;
}

export function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The longest stretch where `a` and `b` sound the same, as seconds into each:
 * { aStart, aEnd, bStart, bEnd }, or null when no stretch between minSeconds and
 * maxSeconds matches. Tries every alignment (about 0.5 s for two 10-minute clips).
 */
export function findSharedSegment(a, b, { maxBitErrors = 11, smoothFrames = 16, gapFrames = 16, minSeconds = 15, maxSeconds = 150 } = {}) {
  const minFrames = Math.ceil(minSeconds / HOP_SECONDS);
  const limit = maxBitErrors * smoothFrames;
  const errs = new Uint8Array(Math.max(a.length, b.length));
  let best = null; // frames in `a`; the same moment in `b` is frame + shift
  for (let shift = -(a.length - 1); shift < b.length; shift++) {
    const from = Math.max(0, -shift);
    const n = Math.min(a.length, b.length - shift) - from;
    if (n < minFrames || (best && n <= best.len)) continue; // this alignment can't beat what we have
    for (let k = 0; k < n; k++) errs[k] = popcount(a[from + k] ^ b[from + k + shift]);
    let sum = 0;
    let runStart = -1;
    let lastGood = -1;
    for (let k = 0; k < n; k++) {
      sum += errs[k];
      if (k >= smoothFrames) sum -= errs[k - smoothFrames];
      if (k < smoothFrames - 1 || sum > limit) continue;
      const windowStart = k - smoothFrames + 1;
      if (runStart < 0 || windowStart - lastGood > gapFrames) runStart = windowStart;
      lastGood = k;
      const len = lastGood - runStart + 1;
      if (!best || len > best.len) best = { len, shift, start: from + runStart, end: from + lastGood + 1 };
    }
  }
  if (!best) return null;
  // The smoothing window reaches past the real edges; drop edge frames that don't match on their own.
  const err = (i) => popcount(a[i] ^ b[i + best.shift]);
  for (let s = 0; s < smoothFrames && best.end - best.start > 1 && err(best.start) > maxBitErrors; s++) best.start++;
  for (let s = 0; s < smoothFrames && best.end - best.start > 1 && err(best.end - 1) > maxBitErrors; s++) best.end--;
  const seconds = (best.end - best.start) * HOP_SECONDS;
  if (seconds < minSeconds || seconds > maxSeconds) return null;
  // Matching (nearly) all the way through: two copies of the same recording, not a shared intro.
  if (best.end - best.start >= 0.9 * Math.min(a.length, b.length)) return null;
  const t = (frame) => Math.round(frame * HOP_SECONDS * 100) / 100;
  return { aStart: t(best.start), aEnd: t(best.end), bStart: t(best.start + best.shift), bEnd: t(best.end + best.shift) };
}
