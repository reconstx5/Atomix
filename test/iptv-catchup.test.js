// IPTV Simple: catch-up URLs for each archive style (plugins/iptv-simple/catchup.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchupUrl, fillTemplate, catchupWindowDays } from '../plugins/iptv-simple/catchup.js';

const start = Date.UTC(2026, 9, 10, 6, 0, 0); // 19:00 NZDT → 1791612000
const end = start + 30 * 60_000; // 1791613800
const now = start + 2 * 3600_000; // 1791619200
const ch = (url, catchup) => ({ url, catchup });

test('default: "http://h/c.ts?s={utc}&e={utcend}&d={duration}"', () => {
  const url = catchupUrl(ch('http://h/live.ts', { mode: 'default', source: 'http://h/c.ts?s={utc}&e={utcend}&d={duration}' }), { start, end, now });
  assert.equal(url, 'http://h/c.ts?s=1791612000&e=1791613800&d=1800');
});

test('tokens {Y}{m}{d}{H}{M}{S}, {lutc}, {duration:60}, {offset:60}, ${start}, ${end}, ${timestamp}, {utc:Y-m-d H:M:S}', () => {
  const t = { start, end, now };
  assert.equal(fillTemplate('{Y}/{m}/{d}/{H}{M}{S}', t), '2026/10/10/060000');
  assert.equal(fillTemplate('{start}-{end}-{lutc}-{now}-{timestamp}', t), '1791612000-1791613800-1791619200-1791619200-1791619200');
  assert.equal(fillTemplate('{duration:60}', t), '30');
  assert.equal(fillTemplate('{offset:60}', t), '120');
  assert.equal(fillTemplate('${start}_${end}_${timestamp}_${duration}', t), '1791612000_1791613800_1791619200_1800');
  assert.equal(fillTemplate('{utc:Y-m-d H:M:S}', t), '2026-10-10 06:00:00');
  assert.equal(fillTemplate('${start:Y-m-d}|{utcend:H-M}', t), '2026-10-10|06-30');
});

test('append: liveUrl + "?utc={utc}&lutc={lutc}"', () => {
  const url = catchupUrl(ch('http://h/ch/1.m3u8', { mode: 'append', source: '?utc={utc}&lutc={lutc}' }), { start, end, now });
  assert.equal(url, 'http://h/ch/1.m3u8?utc=1791612000&lutc=1791619200');
});

test('shift: adds ?utc=…&lutc=…, or &… when the URL has a query', () => {
  assert.equal(catchupUrl(ch('http://h/1.ts', { mode: 'shift' }), { start, end, now }), 'http://h/1.ts?utc=1791612000&lutc=1791619200');
  assert.equal(catchupUrl(ch('http://h/1.ts?token=a', { mode: 'timeshift' }), { start, end, now }), 'http://h/1.ts?token=a&utc=1791612000&lutc=1791619200');
});

test('flussonic HLS: http://h/ch1/index.m3u8 → http://h/ch1/index-1791612000-1800.m3u8; TS: mpegts → archive-1791612000-1800.ts', () => {
  assert.equal(catchupUrl(ch('http://h/ch1/index.m3u8', { mode: 'flussonic' }), { start, end, now }), 'http://h/ch1/index-1791612000-1800.m3u8');
  assert.equal(catchupUrl(ch('http://h/ch1/video.m3u8?token=t', { mode: 'flussonic-hls' }), { start, end, now }), 'http://h/ch1/video-1791612000-1800.m3u8?token=t');
  assert.equal(catchupUrl(ch('http://h/ch1/mpegts', { mode: 'flussonic' }), { start, end, now }), 'http://h/ch1/archive-1791612000-1800.ts');
  assert.equal(catchupUrl(ch('http://h/ch1/mpegts?token=t', { mode: 'flussonic-ts' }), { start, end, now }), 'http://h/ch1/archive-1791612000-1800.ts?token=t');
  assert.equal(catchupUrl(ch('http://h/ch1/index.m3u8', { mode: 'fs' }), { start, end, now }), 'http://h/ch1/index-1791612000-1800.m3u8');
});

test('xtream: http://h:8080/live/u/p/42.ts → http://h:8080/timeshift/u/p/30/2026-10-10:06-00/42.ts (UTC date, minutes rounded up)', () => {
  assert.equal(catchupUrl(ch('http://h:8080/live/u/p/42.ts', { mode: 'xc' }), { start, end, now }), 'http://h:8080/timeshift/u/p/30/2026-10-10:06-00/42.ts');
  assert.equal(catchupUrl(ch('http://h:8080/u/p/42', { mode: 'xtream' }), { start, end: end + 10_000, now }), 'http://h:8080/timeshift/u/p/31/2026-10-10:06-00/42.ts');
});

test('from shifts start and shortens duration; correction +1 h', () => {
  assert.equal(catchupUrl(ch('http://h/live.ts', { mode: 'default', source: 'http://h/c?s={utc}&d={duration}' }), { start, end, now, from: 600 }), 'http://h/c?s=1791612600&d=1200');
  assert.equal(catchupUrl(ch('http://h/live.ts', { mode: 'default', source: 'http://h/c?s={utc}&e={utcend}', correction: 1 }), { start, end, now }), 'http://h/c?s=1791615600&e=1791617400');
});

test('the header default mode and template apply when the channel has none; no catch-up throws', () => {
  assert.equal(catchupUrl(ch('http://h/1.ts', undefined), { start, end, now, defaults: { mode: 'shift' } }), 'http://h/1.ts?utc=1791612000&lutc=1791619200');
  assert.equal(catchupUrl(ch('http://h/1.ts', { days: 3 }), { start, end, now, defaults: { mode: 'append', source: '&s={utc}' } }), 'http://h/1.ts&s=1791612000');
  assert.throws(() => catchupUrl(ch('http://h/1.ts', undefined), { start, end, now }), /This channel has no catch-up/);
  assert.throws(() => catchupUrl(ch('http://h/1.ts', { mode: 'vod' }), { start, end, now }), /This channel has no catch-up/);
});

test('catchupWindowDays: channel, else header, else setting', () => {
  assert.equal(catchupWindowDays({ catchup: { mode: 'xc', days: 2 } }, { catchupDays: 5 }, 7), 2);
  assert.equal(catchupWindowDays({ catchup: { mode: 'xc' } }, { catchupDays: 5 }, 7), 5);
  assert.equal(catchupWindowDays({ catchup: { mode: 'xc' } }, {}, 7), 7);
  assert.equal(catchupWindowDays({}, { catchup: 'shift' }, 4), 4);
  assert.equal(catchupWindowDays({}, {}, 7), 0, 'no catch-up anywhere');
});
