// The audio fingerprint that finds a TV intro: two recordings of the same tune
// must match even when one is quieter and muffled; noise and duplicates must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, fingerprint, popcount, findSharedSegment, SAMPLE_RATE, HOP_SECONDS } from '../src/extras/fingerprint.js';

const SR = SAMPLE_RATE;
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
/** A made-up theme tune: two melodies over 20 s. */
function theme(seconds = 20) {
  const out = new Float64Array(seconds * SR);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f1 = [262, 330, 392, 349, 294][Math.floor(t * 2) % 5];
    const f2 = [523, 659, 587, 784][Math.floor(t * 3) % 4];
    out[i] = 0.35 * Math.sin(2 * Math.PI * f1 * t) + 0.2 * Math.sin(2 * Math.PI * f2 * t);
  }
  return out;
}
const noise = (seconds, seed, amp = 0.3) => {
  const r = rng(seed);
  return Float64Array.from({ length: seconds * SR }, () => (r() * 2 - 1) * amp);
};
/** Join parts into 16-bit PCM, optionally quieter and through a simple low-pass filter. */
function clip(parts, { gain = 1, lowpass = 0 } = {}) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  const alpha = lowpass ? 1 - Math.exp((-2 * Math.PI * lowpass) / SR) : 1;
  let k = 0;
  let y = 0;
  for (const p of parts) {
    for (const v of p) {
      y += alpha * (v * gain - y);
      out[k++] = Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
    }
  }
  return out;
}

test('fft finds a pure tone', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 8 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  const mag = [...re].map((r, i) => Math.hypot(r, im[i]));
  const peaks = mag.map((m, i) => [m, i]).filter(([m]) => m > 1).map(([, i]) => i);
  assert.deepEqual(peaks, [8, 56]);
});

test('popcount counts bits', () => {
  assert.deepEqual([0, 1, 0xff, 0xffffffff, 0x80000001].map(popcount), [0, 1, 8, 32, 2]);
});

test('fingerprint: one 32-bit code per 64 ms', () => {
  assert.equal(HOP_SECONDS, 0.064);
  const fp = fingerprint(clip([noise(10, 1)]));
  assert.ok(fp instanceof Uint32Array);
  assert.equal(fp.length, Math.floor((10 * SR - 1024) / 512)); // frames − 1 (the first has nothing to compare with)
  assert.equal(fingerprint(new Int16Array(500)).length, 0, 'too short for one frame');
});

test('finds the shared tune in a quieter, muffled copy', () => {
  const tune = theme();
  const a = fingerprint(clip([noise(12, 1), tune, noise(28, 2)]));
  const b = fingerprint(clip([noise(47, 3), tune, noise(23, 4)], { gain: 0.5, lowpass: 3000 }));
  const m = findSharedSegment(a, b);
  assert.ok(m, 'found a match');
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 0.3, `${actual} vs ${expected}`);
  near(m.aStart, 12);
  near(m.aEnd, 32);
  near(m.bStart, 47);
  near(m.bEnd, 67);
});

test('different sounds, or too little in common, give no intro', () => {
  const a = fingerprint(clip([noise(12, 1), theme(), noise(28, 2)]));
  assert.equal(findSharedSegment(a, fingerprint(clip([noise(70, 5)]))), null, 'nothing shared');
  const short = fingerprint(clip([noise(12, 6), theme(10), noise(30, 7)]));
  assert.equal(findSharedSegment(short, a), null, '10 s is too short to be an intro');
});

test('duplicate episodes are not one long "intro"', () => {
  const same = clip([noise(40, 8), theme(), noise(140, 9)]);
  assert.equal(findSharedSegment(fingerprint(same), fingerprint(same)), null, '200 s in common is longer than any intro');
});

test('short duplicated episodes are not one long "intro" either', () => {
  // A 5-minute kids' episode is searched for its first 2 minutes (40%), which is under the
  // 150 s limit, so a duplicate would otherwise pass as a 2-minute intro.
  const same = clip([noise(20, 12), theme(), noise(80, 13)]);
  assert.equal(findSharedSegment(fingerprint(same), fingerprint(same)), null);
});
