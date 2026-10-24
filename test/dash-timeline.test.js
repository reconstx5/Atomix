// The DASH player's live timeline (public/js/dash/timeline.js): which segments exist right now, their addresses,
// and where the live edge is — for number templates and SegmentTimelines, with a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseMpd } from '../public/js/dash/mpd.js';
import { fillTemplate, segmentsAt, liveEdge, clockOffset } from '../public/js/dash/timeline.js';

const fx = (name) => fs.readFileSync(new URL(`./fixtures/dash/${name}`, import.meta.url), 'utf8');

test('fillTemplate substitutes identifiers, widths and $$', () => {
  assert.equal(fillTemplate('$RepresentationID$/seg-$Number%05d$.m4s', { RepresentationID: 'v720', Number: 42 }), 'v720/seg-00042.m4s');
  assert.equal(fillTemplate('b$Bandwidth$_t$Time$_$$.m4s', { Bandwidth: 3000000, Time: 90000 }), 'b3000000_t90000_$.m4s');
  assert.equal(fillTemplate('n$Number%3d$', { Number: 7 }), 'n007');
  assert.equal(fillTemplate('$Unknown$x', {}), '$Unknown$x', 'unknown identifiers stay as written');
});

test('number template, live: the window is the last timeShiftBufferDepth of complete segments', () => {
  const mpd = parseMpd(fx('live-number.mpd'), 'https://cdn.example/live/channel.mpd');
  const period = mpd.periods[0];
  const rep = period.adaptationSets[0].representations[0];
  // An hour after availabilityStartTime, plus half a segment: the newest complete segment is index 1799.
  const now = mpd.availabilityStartTime + 3600_000 + 1000;
  const { init, segments } = segmentsAt(rep, period, mpd, now);
  assert.equal(init, 'https://cdn.example/live/v720/init.mp4');
  const newest = 100 + Math.floor(3601 / 2) - 1; // startNumber + complete segments − 1
  assert.equal(segments.at(-1).number, newest);
  assert.equal(segments.at(-1).url, `https://cdn.example/live/v720/seg-0${newest}.m4s`);
  assert.equal(segments.length, 30, '60 s window of 2 s segments');
  assert.deepEqual([segments.at(-1).start, segments.at(-1).end], [(newest - 100) * 2, (newest - 100) * 2 + 2]);
  assert.ok(segments.every((s, i) => i === 0 || s.number === segments[i - 1].number + 1));
  assert.ok(segments.at(-1).end <= 3601, 'only complete segments');
  assert.ok(segments[0].end >= 3601 - 60 && segments[0].start < 3601 - 60, 'the oldest is the one whose end is still in the window');
});

test('the live edge sits max(3 segments, suggestedPresentationDelay) behind the newest segment\'s end', () => {
  const mpd = parseMpd(fx('live-number.mpd'), 'https://cdn.example/live/channel.mpd');
  const p = mpd.periods[0];
  const { segments } = segmentsAt(p.adaptationSets[0].representations[0], p, mpd, mpd.availabilityStartTime + 3600_000);
  assert.equal(liveEdge(mpd, segments), segments.at(-1).end - 6, 'suggestedPresentationDelay 6 s = 3 × 2 s');
  assert.equal(liveEdge({ ...mpd, suggestedPresentationDelay: 20 }, segments), segments.at(-1).end - 20);
  assert.equal(liveEdge({ ...mpd, suggestedPresentationDelay: null }, segments), segments.at(-1).end - 6);
});

test('timeline: explicit t, a short segment, r=-1 repeating to now, $Time$ addresses and the presentation time offset', () => {
  const mpd = parseMpd(fx('live-timeline.mpd'), 'https://cdn.example/x.mpd');
  const p = mpd.periods[0];
  const rep = p.adaptationSets[0].representations[0];
  // AST is 1970; times are in 90 kHz units: the first S starts at 10 s (900000), segments of 2 s ×3, one of 1 s,
  // then a jump to 20 s and 2 s segments for ever. "Now" = 31.5 s after AST.
  const { segments } = segmentsAt(rep, p, { ...mpd, timeShiftBufferDepth: 3600 }, 31_500);
  // Availability counts from the presentation time ((t − PTO) / timescale): complete when start + duration ≤ 31.5 s.
  assert.deepEqual(segments.map((s) => s.time), [900000, 1080000, 1260000, 1440000, ...Array.from({ length: 10 }, (_, k) => 1800000 + k * 180000)]);
  assert.equal(segments[0].start, 0, 'presentationTimeOffset 900000 = 10 s → the first segment starts at 0');
  assert.equal(segments[3].end - segments[3].start, 1);
  assert.equal(segments[4].start, 10, 'the gap from 17 s to 20 s is kept');
  assert.equal(segments.at(-1).end, 30, 'the segment from 28 s ends at 30 s ≤ 31.5 s; the one from 30 s is not complete');
  assert.equal(segments[0].url, 'https://cdn.example/v/900000.m4s');
  assert.equal(segments[2].number, 3, 'numbers count from startNumber in timeline order');
  const windowed = segmentsAt(rep, p, { ...mpd, timeShiftBufferDepth: 28 }, 31_500).segments; // kept while its end is within 28 s: the 0–2 s one is gone
  assert.equal(windowed[0].time, 1080000);
});

test('static: every segment of the period', () => {
  const mpd = parseMpd(fx('vod.mpd'), 'http://127.0.0.1:9919/drm/vod/manifest.mpd');
  const p = mpd.periods[0];
  const { init, segments } = segmentsAt(p.adaptationSets[0].representations[0], p, mpd, Date.now());
  assert.equal(init, 'http://127.0.0.1:9919/drm/vod/seg_1_.mp4');
  assert.deepEqual(segments.map((s) => s.number), [1, 2, 3, 4, 5]);
  assert.equal(segments[4].url, 'http://127.0.0.1:9919/drm/vod/seg_1_5.m4s');
  assert.deepEqual([segments[4].start, segments[4].end], [8, 10]);
});

test('before availabilityStartTime there is nothing yet', () => {
  const mpd = parseMpd(fx('live-number.mpd'), 'https://cdn.example/live/channel.mpd');
  const p = mpd.periods[0];
  assert.deepEqual(segmentsAt(p.adaptationSets[0].representations[0], p, mpd, mpd.availabilityStartTime - 5000).segments, []);
});

test('clockOffset: how far the server\'s clock is ahead of ours', () => {
  assert.equal(clockOffset('2026-10-10T06:00:05Z', Date.UTC(2026, 9, 10, 6, 0, 0)), 5000);
  assert.equal(clockOffset('2026-10-10T05:59:58.500Z', Date.UTC(2026, 9, 10, 6, 0, 0)), -1500);
  assert.equal(clockOffset('nonsense', 0), 0);
});

test('a huge or open-ended timeline is walked arithmetically and capped (never one step per segment)', () => {
  const rep = { id: 'v', bandwidth: 1, baseUrl: 'https://o.example/', template: { media: 's$Number$.m4s', timescale: 1, timeline: [{ t: 0, d: 1, r: 50_000_000 }] } };
  const live = { type: 'dynamic', availabilityStartTime: 0, timeShiftBufferDepth: 30 };
  const t0 = performance.now();
  const { segments } = segmentsAt(rep, { start: 0, duration: null }, live, 40_000_000 * 1000);
  assert.ok(performance.now() - t0 < 500, 'fast');
  assert.ok(segments.length >= 29 && segments.length <= 31, String(segments.length));
  assert.equal(segments.at(-1).number, 40_000_000, 'numbers still count from the first S');
  const open = { ...rep, template: { ...rep.template, timeline: [{ t: 0, d: 1, r: -1 }] } };
  const t1 = performance.now();
  const s2 = segmentsAt(open, { start: 0, duration: null }, { type: 'static' }, 0).segments;
  assert.ok(performance.now() - t1 < 1000, 'a static r=-1 with no end is bounded');
  assert.ok(s2.length <= 100_000);
  const num = { ...rep, template: { media: 's$Number$.m4s', timescale: 1, duration: 2 } };
  assert.ok(segmentsAt(num, { start: 0, duration: null }, { type: 'static' }, 0).segments.length <= 100_000, 'a number template with no end too');
});

test('timeShiftBufferDepth of zero (or less) means the default window, not an empty one', () => {
  const rep = { id: 'v', bandwidth: 1, baseUrl: 'https://o.example/', template: { media: 's$Number$.m4s', timescale: 1, duration: 2, startNumber: 1 } };
  const { segments } = segmentsAt(rep, { start: 0, duration: null }, { type: 'dynamic', availabilityStartTime: 0, timeShiftBufferDepth: 0 }, 1000 * 1000);
  assert.ok(segments.length >= 29, String(segments.length));
});
