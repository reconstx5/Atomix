// The tuner's buffer (src/live/timeshift.js): the fMP4 tags, ffmpeg's arguments, reading its HLS playlists, and the
// dynamic DASH manifest Atomix builds over the last 30 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codecTags, tunerArgs, parsePlaylist, parseCodecs, buildManifest } from '../src/live/timeshift.js';

test('codecTags: the fMP4 tags, null for a codec fMP4 can\'t carry', () => {
  assert.deepEqual(codecTags({ video: { codec: 'h264' }, audio: [{ codec: 'aac' }] }), { v: 'avc1', a: 'mp4a' });
  assert.deepEqual(codecTags({ video: { codec: 'hevc' }, audio: [{ codec: 'ac3' }] }), { v: 'hvc1', a: 'ac-3' });
  assert.equal(codecTags({ video: { codec: 'mpeg2video' }, audio: [{ codec: 'mp2' }] }), null);
  assert.deepEqual(codecTags({ video: null, audio: [{ codec: 'mp3' }] }), { v: null, a: 'mp4a' });
  assert.deepEqual(codecTags({ video: { codec: 'h264' }, audio: [] }), { v: 'avc1', a: null });
});

test('tunerArgs copies with the tags, the AAC filter, a run folder and the 30-min window', () => {
  const args = tunerArgs({ url: 'http://provider.example/live/1.ts', headers: {}, media: { video: { codec: 'h264' }, audio: [{ codec: 'aac' }] }, dir: '/data/timeshift/t1', run: 2, inputArgs: ['-user_agent', 'X'] });
  const j = args.join(' ');
  for (const part of ['-c copy', '-tag:v avc1', '-tag:a mp4a', '-bsf:a aac_adtstoasc', '-hls_list_size 1800', '-hls_time 4', '-hls_init_time 1', '-hls_segment_type fmp4', '/data/timeshift/t1/run-2/seg-2-%06d.m4s', 'init-2.mp4', '/data/timeshift/t1/run-2/index.m3u8']) assert.ok(j.includes(part), part);
  assert.match(j, /omit_endlist/);
  assert.equal(args.indexOf('http://provider.example/live/1.ts'), args.indexOf('-i') + 1, 'the provider URL only as the input');
  assert.ok(args.indexOf('-user_agent') < args.indexOf('-i'));
  const radio = tunerArgs({ url: 'http://p/r.mp3', headers: {}, media: { video: null, audio: [{ codec: 'mp3' }] }, dir: '/d', run: 1, inputArgs: [] });
  assert.ok(!radio.includes('-tag:v') && !radio.join(' ').includes('0:v'));
  assert.ok(!radio.includes('-bsf:a'), 'mp3 needs no ADTS filter');
});

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-1.mp4"
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-11T00:14:31.411+1300
seg-1-000002.m4s
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-11T00:14:33.411+1300
seg-1-000003.m4s
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-11T00:14:35.411+1300
seg-1-000004.m4s
#EXTINF:1.500000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-11T00:14:37.411+1300
seg-1-000005.m4s
`;

test('parsePlaylist reads init, sequence numbers, durations and program dates', () => {
  const p = parsePlaylist(PLAYLIST);
  assert.equal(p.init, 'init-1.mp4');
  assert.deepEqual(p.segments.map((s) => s.seq), [2, 3, 4, 5]);
  assert.deepEqual(p.segments.map((s) => s.duration), [2, 2, 2, 1.5]);
  assert.equal(p.segments[0].uri, 'seg-1-000002.m4s');
  assert.equal(p.segments[0].pdt, Date.parse('2026-10-11T00:14:31.411+13:00'));
  assert.equal(parseCodecs('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=78910,RESOLUTION=160x90,CODECS="avc1.64000a,mp4a.40.2"\nindex.m3u8\n'), 'avc1.64000a,mp4a.40.2');
  assert.equal(parseCodecs('#EXTM3U\n'), null);
});

test('buildManifest: a dynamic manifest, a period per run, only pieces in the window, no provider address', () => {
  const origin = Date.parse('2026-10-11T08:00:00Z');
  const now = origin + 40 * 60_000; // 40 minutes in: the first 10 minutes are out of the window
  const run1 = { run: 1, start: origin, codecs: 'avc1.64000a,mp4a.40.2', audioOnly: false, pieces: [] };
  for (let i = 0; i < 300; i++) run1.pieces.push({ seq: i, t: i * 4000, d: 4000 }); // 0–20 min
  const run2 = { run: 2, start: origin + 21 * 60_000, codecs: 'avc1.64000a,mp4a.40.2', audioOnly: false, pieces: [] };
  for (let i = 0; i < 270; i++) run2.pieces.push({ seq: i, t: i * 4000, d: 4000 }); // 21–39 min
  const mpd = buildManifest({ runs: [run1, run2], origin, now, piecePath: 'p/', timeUrl: '/api/live/tuner/abc/time' });
  assert.match(mpd, /type="dynamic"/);
  assert.match(mpd, /timeShiftBufferDepth="PT1800S"/);
  assert.match(mpd, /minimumUpdatePeriod="PT4S"/);
  assert.match(mpd, new RegExp(`availabilityStartTime="${new Date(origin).toISOString()}"`));
  assert.match(mpd, /<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="\/api\/live\/tuner\/abc\/time"\/>/);
  const periods = [...mpd.matchAll(/<Period id="(r\d+)" start="PT([\d.]+)S"/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(periods, [['r1', 0], ['r2', 1260]]);
  // Run 1's pieces before 10 minutes in (now − 30 min) are left out: the first kept piece is 150 (600 s / 4).
  assert.match(mpd, /media="p\/seg-1-\$Number%06d\$\.m4s" startNumber="150"/);
  assert.match(mpd, /initialization="p\/init-1\.mp4"/);
  assert.match(mpd, /<S t="600000" d="4000"/);
  assert.match(mpd, /codecs="avc1\.64000a,mp4a\.40\.2"/);
  assert.ok(!/https?:\/\//.test(mpd.replace(/xmlns(:\w+)?="[^"]+"/g, '')), 'no address but Atomix\'s own paths');
  const audio = buildManifest({ runs: [{ ...run2, audioOnly: true, codecs: 'mp4a.40.2' }], origin, now, piecePath: 'p/', timeUrl: '/t' });
  assert.match(audio, /mimeType="audio\/mp4"/);
  assert.match(audio, /contentType="audio"/);
  const empty = buildManifest({ runs: [{ ...run1, pieces: run1.pieces.slice(0, 10) }], origin, now, piecePath: 'p/', timeUrl: '/t' });
  assert.ok(!/<Period/.test(empty), 'a run wholly out of the window is left out');
});

test("the manifest reads in the browser player's own parser: pieces, init and URLs under the session", async () => {
  const { parseMpd } = await import('../public/js/dash/mpd.js');
  const { segmentsAt } = await import('../public/js/dash/timeline.js');
  const now = Date.now();
  const origin = now - 600_000;
  const run = { run: 1, start: origin, codecs: 'avc1.64000a,mp4a.40.2', audioOnly: false, pieces: Array.from({ length: 150 }, (_, i) => ({ seq: i, t: i * 4000, d: 4000 })) };
  const mpd = parseMpd(buildManifest({ runs: [run], origin, now, piecePath: 'p/', timeUrl: '/t' }), 'http://atomix.test/api/live/tuner/x/manifest.mpd');
  const rep = mpd.periods[0].adaptationSets[0].representations[0];
  const s = segmentsAt(rep, mpd.periods[0], mpd, now);
  assert.equal(mpd.type, 'dynamic');
  assert.equal(s.init, 'http://atomix.test/api/live/tuner/x/p/init-1.mp4');
  assert.equal(s.segments.length, 150);
  assert.equal(s.segments[0].url, 'http://atomix.test/api/live/tuner/x/p/seg-1-000000.m4s');
});

test("fallbackCodecs: an MSE codecs string when ffmpeg's master playlist gives none (VP9, Opus)", async () => {
  const { fallbackCodecs } = await import('../src/live/timeshift.js');
  assert.equal(fallbackCodecs({ video: { codec: 'vp9' }, audio: [{ codec: 'opus' }] }), 'vp09.00.40.08,opus');
  assert.equal(fallbackCodecs({ video: { codec: 'h264' }, audio: [{ codec: 'aac' }] }), 'avc1.640028,mp4a.40.2');
  assert.equal(fallbackCodecs({ video: null, audio: [{ codec: 'mp3' }] }), 'mp4a.40.34');
});

test('piecesBack: how many of the newest pieces cover `behind` seconds (pieces may be 1 s or 4 s)', async () => {
  const { piecesBack } = await import('../src/live/timeshift.js');
  const ones = Array.from({ length: 100 }, (_, i) => ({ seq: i, t: i * 1000, d: 1000 }));
  const fours = Array.from({ length: 100 }, (_, i) => ({ seq: i, t: i * 4000, d: 4000 }));
  assert.equal(piecesBack(ones, 60), 60);
  assert.equal(piecesBack(fours, 60), 15);
  assert.equal(piecesBack(fours, 0), 2, 'live: two pieces back');
  assert.equal(piecesBack(ones, 500), 100, 'no further than the run');
});
