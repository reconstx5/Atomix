// The DASH player's pure decisions (public/js/dash/player.js): which segment comes next as the live manifest moves,
// what to remove from the buffer, where to start, which period to play. The engine itself (MediaSource, fetches)
// runs in the browser and is checked by live-ui.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSegment, trimRanges, liveStart, periodToPlay, mseType, sentenceOf, initKey, hasSegments, sbQueue, stallNudge, DashPlayer, aheadFor, playableLevels, LOWER_QUALITY } from '../public/js/dash/player.js';
import { segmentsAt, liveEdge } from '../public/js/dash/timeline.js';

const seg = (n, d = 2) => ({ number: n, time: (n - 1) * d, start: (n - 1) * d, end: n * d, url: `s${n}` });

test('nextSegment follows the presentation time, whatever the manifest renumbers or drops', () => {
  const list = [4, 5, 6, 7].map((n) => seg(n));
  assert.equal(nextSegment(list, 0).number, 4, 'from before the window: its first');
  assert.equal(nextSegment(list, 10).number, 6, 'after 5 (which ends at 10): 6');
  assert.equal(nextSegment(list, 9).number, 5, 'a cursor inside a segment: that segment');
  assert.equal(nextSegment([8, 9].map((n) => seg(n)), 10).number, 8, '6–7 aged out: jump to what exists');
  const renumbered = [{ ...seg(6), number: 1 }, { ...seg(7), number: 2 }];
  assert.equal(nextSegment(renumbered, 12).number, 2, 'a $Time$ timeline renumbered on refresh: matched by time');
  assert.equal(nextSegment(list, 14), null, 'nothing newer yet');
  assert.equal(nextSegment([], 0), null);
});

test('trimRanges: what lies more than keepBehind seconds behind the playhead', () => {
  assert.deepEqual(trimRanges([[0, 100]], 80, 30), [[0, 50]]);
  assert.deepEqual(trimRanges([[0, 20]], 15, 30), []);
  assert.deepEqual(trimRanges([[0, 10], [40, 100]], 90, 30), [[0, 10], [40, 60]]);
});

test('liveStart: the live edge for a live stream, the first segment for a static one; a skewed page clock changes nothing once corrected', () => {
  const rep = { id: 'v', bandwidth: 1, baseUrl: 'https://o.example/', template: { media: 's$Number$.m4s', timescale: 1, duration: 2, startNumber: 1 } };
  const live = { type: 'dynamic', availabilityStartTime: 0, timeShiftBufferDepth: 30, suggestedPresentationDelay: null };
  const server = 1000 * 1000;
  const offset = 120_000; // the server is 2 minutes ahead of the page
  const pageNow = server - offset;
  const segs = segmentsAt(rep, { start: 0, duration: null }, live, pageNow + offset).segments;
  assert.equal(liveStart(live, segs), liveEdge(live, segs));
  assert.ok(Math.abs(liveStart(live, segs) - (1000 - 6)) < 0.001, String(liveStart(live, segs)));
  const stat = { type: 'static', mediaPresentationDuration: 10 };
  assert.equal(liveStart(stat, segmentsAt(rep, { start: 0, duration: 10 }, stat, 0).segments), 0);
  assert.equal(liveStart(live, []), 0);
});

test('periodToPlay: the first period with video (else the first with audio)', () => {
  const audioOnly = { id: 'a', adaptationSets: [{ type: 'audio', representations: [{}] }] };
  const withVideo = { id: 'v', adaptationSets: [{ type: 'video', representations: [{}] }] };
  assert.equal(periodToPlay({ periods: [audioOnly, withVideo] }).id, 'v');
  assert.equal(periodToPlay({ periods: [audioOnly] }).id, 'a');
  assert.equal(periodToPlay({ periods: [] }), null);
});

test('mseType: the SourceBuffer type, with the codec names browsers match in lowercase (Opus, fLaC)', () => {
  assert.equal(mseType({ mimeType: 'audio/mp4', codecs: 'Opus' }), 'audio/mp4; codecs="opus"');
  assert.equal(mseType({ mimeType: 'audio/mp4', codecs: 'fLaC' }), 'audio/mp4; codecs="flac"');
  assert.equal(mseType({ mimeType: 'video/mp4', codecs: 'avc1.4D401F' }), 'video/mp4; codecs="avc1.4D401F"', 'others untouched');
  assert.equal(mseType({ mimeType: 'video/mp4', codecs: 'vp09.00.10.08,Opus' }), 'video/mp4; codecs="vp09.00.10.08,opus"');
});

test('sentenceOf: only the spec\'s sentences reach the person; a browser\'s own error text becomes "couldn\'t be read"', () => {
  assert.equal(sentenceOf(new Error("The provider refused this channel's licence")), "The provider refused this channel's licence");
  assert.equal(sentenceOf(new Error("This browser can't play this channel's protection.")), "This browser can't play this channel's protection.");
  assert.equal(sentenceOf(new DOMException("Failed to execute 'addSourceBuffer' on 'MediaSource'", 'NotSupportedError')), "This channel's stream couldn't be read");
  assert.equal(sentenceOf(null), "This channel's stream couldn't be read");
});

test('initKey: a representation id reused by the next period still means a new init segment and offset', () => {
  const rep = { id: 'v1', template: { initialization: 'https://a/$RepresentationID$/init.mp4', presentationTimeOffset: 0, timescale: 1 } };
  const p1 = { id: 'p1', start: 0 };
  const p2 = { id: 'p2', start: 3600 };
  assert.notEqual(initKey(p1, rep), initKey(p2, rep));
  assert.equal(initKey(p1, rep), initKey({ ...p1 }, { ...rep }));
  assert.notEqual(initKey(p1, rep), initKey(p1, { ...rep, template: { ...rep.template, presentationTimeOffset: 90000 } }));
});

test('hasSegments: a representation the player can address (a SegmentTemplate with media)', () => {
  assert.equal(hasSegments({ template: { media: 's$Number$.m4s' } }), true);
  assert.equal(hasSegments({ template: null }), false);
  assert.equal(hasSegments({}), false);
});

// ---- The engine's own parts, with small fakes (no MediaSource in Node) ----
function fakeSb() {
  const sb = new EventTarget();
  sb.updating = false;
  sb.ops = [];
  sb.overlaps = 0;
  const add = sb.addEventListener.bind(sb);
  const rm = sb.removeEventListener.bind(sb);
  const attached = new Set();
  sb.addEventListener = (n, fn, o) => {
    attached.add(fn);
    add(n, fn, o);
    o?.signal?.addEventListener('abort', () => attached.delete(fn), { once: true });
  };
  sb.removeEventListener = (n, fn, o) => { attached.delete(fn); rm(n, fn, o); };
  Object.defineProperty(sb, 'live', { get: () => attached.size });
  const op = (name) => () => {
    if (sb.updating) sb.overlaps++;
    sb.updating = true;
    sb.ops.push(name);
    setTimeout(() => { sb.updating = false; sb.dispatchEvent(new Event('updateend')); }, 5);
  };
  sb.appendBuffer = op('append');
  sb.remove = op('remove');
  sb.changeType = (t) => { if (sb.updating) sb.overlaps++; sb.ops.push(`type ${t}`); };
  return sb;
}

test('sbQueue runs append, remove and changeType one at a time and leaves no listeners behind', async () => {
  const sb = fakeSb();
  const q = sbQueue(sb);
  await Promise.all([
    q.run((b) => b.appendBuffer(new Uint8Array(1))),
    q.run((b) => b.remove(0, 1)),
    q.run((b) => b.changeType('video/mp4'), { sync: true }),
    q.run((b) => b.appendBuffer(new Uint8Array(1))),
  ]);
  assert.deepEqual(sb.ops, ['append', 'remove', 'type video/mp4', 'append']);
  assert.equal(sb.overlaps, 0);
  assert.equal(sb.live, 0, 'no listeners left');
});

test('a static stall nudges forward 0.1 s; a dynamic stall jumps to the live point', () => {
  const segs = [1, 2, 3].map((n) => seg(n));
  assert.equal(stallNudge({ type: 'static' }, 12, segs), 12.1);
  const live = { type: 'dynamic', availabilityStartTime: 0, suggestedPresentationDelay: 0 };
  assert.equal(stallNudge(live, 1, segs), liveStart(live, segs));
});

const stubLocation = () => (globalThis.location ??= new URL('http://atomix.test/'));

test('get() refuses after destroy and refuses another origin', async () => {
  stubLocation();
  let calls = 0;
  const p = new DashPlayer({}, { manifest: '/m.mpd', fetch: async () => (calls++, { ok: true, text: async () => 'x' }) });
  await assert.rejects(p.get('http://evil.example/x'), /couldn't be read/);
  assert.equal(calls, 0);
  assert.equal(await p.get('/x'), 'x');
  p.destroyed = true;
  await assert.rejects(p.get('/x'));
  assert.equal(calls, 1);
});

test('only video segments feed the throughput estimate', async () => {
  stubLocation();
  const p = new DashPlayer({}, { manifest: '/m.mpd', fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1000) }) });
  await p.fetchSegment('/a', { kind: 'audio' });
  assert.equal(p.throughput, null);
  await p.fetchSegment('/v', { kind: 'video' });
  assert.ok(p.throughput > 0);
});

const rep = (id, bandwidth, height) => ({ id, bandwidth, height, width: height * 2, mimeType: 'video/mp4', codecs: 'avc1.4d401f', template: { media: 's$Number$.m4s' } });
const mpdOf = (type, reps) => ({ type, minimumUpdatePeriod: 0, periods: [{ id: 'p', start: 0, adaptationSets: [{ type: 'video', id: 'v', representations: reps, contentProtection: [] }] }] });
function refreshing(manifests) {
  stubLocation();
  globalThis.MediaSource ??= { isTypeSupported: () => true };
  const levels = [];
  const p = new DashPlayer({}, { manifest: '/m.mpd', onLevels: (l) => levels.push(l) });
  p.refreshMinMs = 5;
  let reads = 0;
  p.loadManifest = async () => manifests[Math.min(reads++, manifests.length - 1)];
  p.updateSeekableFor = () => {};
  p.mpd = mpdOf('dynamic', [rep('hd', 3, 720)]);
  p.period = p.mpd.periods[0];
  p.tracks = [{ kind: 'video', as: p.period.adaptationSets[0], rep: rep('hd', 3, 720) }];
  return { p, levels, reads: () => reads };
}

test('refresh stops once the manifest is static and calls onEnded at the end', async () => {
  const { p, reads } = refreshing([mpdOf('dynamic', [rep('hd', 3, 720)]), mpdOf('static', [rep('hd', 3, 720)])]);
  await p.refreshLoop();
  const n = reads();
  assert.equal(n, 2, 'stopped after the static one');
  let ended = 0;
  p.onEnded = () => ended++;
  p.ms = { readyState: 'open', endOfStream() {} };
  p.tracks[0].done = false;
  p.finish(p.tracks[0]);
  p.finish(p.tracks[0]);
  assert.equal(ended, 1);
});

test('a refresh that changes the video levels calls onLevels again', async () => {
  const { p, levels } = refreshing([mpdOf('dynamic', [rep('hd', 3, 720)]), mpdOf('dynamic', [rep('hd', 3, 720), rep('fhd', 6, 1080)]), mpdOf('static', [rep('hd', 3, 720), rep('fhd', 6, 1080)])]);
  p.lastLevels = 'hd:3:720';
  await p.refreshLoop();
  assert.equal(levels.length, 1, 'once for the change, not for the unchanged reads');
  assert.deepEqual(levels[0].map((l) => l.id), ['fhd', 'hd']);
});

test('once every track has finished, the trim timer leaves the buffer alone (a remove would reopen an ended MediaSource)', async () => {
  stubLocation();
  const p = new DashPlayer({ currentTime: 100 }, { manifest: '/m.mpd' });
  const sb = fakeSb();
  sb.buffered = { length: 1, start: () => 0, end: () => 100 };
  p.tracks = [{ kind: 'video', sb, q: sbQueue(sb), done: false }];
  p.ms = { readyState: 'open', endOfStream() {} };
  p.finish(p.tracks[0]);
  await p.trim(p.tracks[0]);
  assert.deepEqual(sb.ops, [], 'nothing removed after the end');
});

// ---- v0.19: the tuner's buffer — a clear (unencrypted) player that seeks within the window ----
const winSegs = (from, to) => Array.from({ length: (to - from) / 4 }, (_, i) => ({ number: i, start: from + i * 4, end: from + i * 4 + 4, url: `s${i}` }));
function windowed({ segs, onNotice } = {}) {
  stubLocation();
  const p = new DashPlayer({ currentTime: 0, paused: false }, { manifest: '/m.mpd', onNotice });
  p.mpd = { type: 'dynamic', suggestedPresentationDelay: 8, periods: [] };
  p.currentSegments = () => segs;
  const sb = fakeSb();
  sb.buffered = { length: 0, start: () => 0, end: () => 0 };
  p.tracks = [{ kind: 'video', sb, q: sbQueue(sb), cursor: 0, gen: 0 }];
  return p;
}

test('a clear player opens without a key system', async () => {
  stubLocation();
  let asked = 0;
  Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', { configurable: true, value: async () => (asked++, null) });
  const p = new DashPlayer({}, { manifest: '/m.mpd' });
  await p.openKeys({ video: { representations: [], contentProtection: [] }, audio: null });
  assert.equal(asked, 0);
  assert.equal(typeof p.keys.close, 'function');
  await p.keys.close();
});

test('seek moves the cursors into the window and clamps outside it', () => {
  const p = windowed({ segs: winSegs(0, 1800) });
  const live = p.window().live;
  assert.equal(p.window().start, 0);
  assert.ok(live > 1700 && live < 1800, String(live));
  p.seek(600);
  assert.equal(p.tracks[0].cursor, 600);
  assert.equal(p.tracks[0].gen, 1);
  assert.equal(p.video.currentTime, 600);
  p.seek(-50);
  assert.equal(p.video.currentTime, 0);
  p.seek(5000);
  assert.equal(p.video.currentTime, live);
});

test("paused past the window's start resumes at the oldest point with the notice", () => {
  const notices = [];
  const p = windowed({ segs: winSegs(400, 2200), onNotice: (s) => notices.push(s) });
  p.video.currentTime = 100; // the playhead fell out of the window while paused
  p.checkWindow(p.currentSegments());
  assert.equal(p.video.currentTime, 401);
  assert.deepEqual(notices, ['You were paused too long — playing from the earliest point kept']);
  p.checkWindow(p.currentSegments());
  assert.equal(notices.length, 1, 'once');
});

test('paused too long is said once per pause, however often the window moves past it', () => {
  const notices = [];
  const p = windowed({ segs: winSegs(400, 2200), onNotice: (s) => notices.push(s) });
  p.video.paused = true;
  for (const start of [400, 420, 440]) {
    p.video.currentTime = start - 300; // the window kept moving while paused
    p.checkWindow(winSegs(start, start + 1800));
  }
  assert.equal(notices.length, 1);
  p.video.paused = false; // played again: a later pause can say it again
  p.video.currentTime = 600;
  p.checkWindow(winSegs(500, 2300));
  p.video.paused = true;
  p.video.currentTime = 0;
  p.checkWindow(winSegs(500, 2300));
  assert.equal(notices.length, 2, 'a new pause can say it again');
});

test('a live manifest that gains a period (the provider dropped, the tuner reconnected) moves the tracks on to it', () => {
  stubLocation();
  globalThis.MediaSource ??= { isTypeSupported: () => true };
  const repA = rep('v-1', 3, 720);
  const repB = rep('v-2', 3, 720);
  const p1 = { id: 'r1', start: 0, adaptationSets: [{ type: 'video', id: '1', representations: [repA], contentProtection: [] }] };
  const p2 = { id: 'r2', start: 62, adaptationSets: [{ type: 'video', id: '2', representations: [repB], contentProtection: [] }] };
  const p = new DashPlayer({ currentTime: 58 }, { manifest: '/m.mpd' });
  p.mpd = { type: 'dynamic', periods: [p1, p2] };
  p.period = p1;
  p.tracks = [{ kind: 'video', as: p1.adaptationSets[0], rep: repA, cursor: 60, gen: 0, initFor: 'old' }];
  assert.equal(p.advancePeriod(), true);
  assert.equal(p.period, p2);
  assert.equal(p.tracks[0].rep.id, 'v-2');
  assert.equal(p.tracks[0].cursor, 62);
  assert.equal(p.tracks[0].initFor, null, 'the new period\'s init piece is fetched');
  assert.equal(p.advancePeriod(), false, 'no later period');
});

test("a rewound viewer reaching the end of an old period's pieces jumps the gap to the next period", () => {
  stubLocation();
  globalThis.MediaSource ??= { isTypeSupported: () => true };
  const repA = rep('v-1', 3, 720);
  const repB = rep('v-2', 3, 720);
  const p1 = { id: 'r1', start: 0, adaptationSets: [{ type: 'video', id: '1', representations: [repA], contentProtection: [] }] };
  const p2 = { id: 'r2', start: 66, adaptationSets: [{ type: 'video', id: '2', representations: [repB], contentProtection: [] }] };
  const p = new DashPlayer({ currentTime: 59.9 }, { manifest: '/m.mpd' });
  p.mpd = { type: 'dynamic', periods: [p1, p2] };
  p.period = p1;
  const sb = fakeSb();
  sb.buffered = { length: 2, start: (i) => [0, 66][i], end: (i) => [60, 80][i] };
  p.tracks = [{ kind: 'video', sb, q: sbQueue(sb), as: p1.adaptationSets[0], rep: repA, cursor: 60, gen: 0 }];
  p.advancePeriod();
  p.video.currentTime = 60; // at the old period's end: 6 s of nothing, then the next period
  assert.equal(p.crossGap(), true);
  assert.equal(p.video.currentTime, 66.05);
  assert.equal(p.crossGap(), false, 'once');
});

// v0.27 Plan B: phones.
test('aheadFor: 10 s on mobile data, else 30', () => {
  assert.equal(aheadFor({ saveData: true }), 10);
  assert.equal(aheadFor({ type: 'cellular' }), 10);
  assert.equal(aheadFor({ type: 'wifi', effectiveType: '4g' }), 30);
  assert.equal(aheadFor(undefined), 30); // Safari has no navigator.connection
});

const KHD = '11111111111111111111111111111111';
const KSD = '22222222222222222222222222222222';
const keyed = (id, bw, h, kid) => ({ ...rep(id, bw, h), contentProtection: [{ system: 'cenc', kid }] });

test('playableLevels ignores unknown keys and refuses when nothing is left', () => {
  const reps = [keyed('hd', 6, 1080, KHD), keyed('sd', 2, 540, KSD)];
  assert.deepEqual(playableLevels(reps, [KHD]).map((r) => r.id), ['sd']);
  assert.deepEqual(playableLevels(reps, ['ffffffffffffffffffffffffffffffff']).map((r) => r.id), ['hd', 'sd']);
  assert.deepEqual(playableLevels(reps, [KHD, KSD]), []);
  // A representation without its own key id uses its set's.
  assert.deepEqual(playableLevels([rep('a', 1, 360)], [KHD], [{ system: 'cenc', kid: KHD }]), []);
});

test('restrict() drops the refused levels once, says LOWER_QUALITY once, and fails with WONT_PLAY when none is left', () => {
  stubLocation();
  const notices = [];
  const levels = [];
  const errors = [];
  const p = new DashPlayer({ getAttribute: () => null }, { manifest: '/m.mpd', onNotice: (n) => notices.push(n), onLevels: (l) => levels.push(l.map((x) => x.id)), onError: (e) => errors.push(e) });
  const reps = [keyed('hd', 6, 1080, KHD), keyed('sd', 2, 540, KSD)];
  p.tracks = [{ kind: 'video', as: { type: 'video', representations: reps, contentProtection: [] }, rep: reps[0] }];
  p.setLevel('hd');
  p.restrict(['ffffffffffffffffffffffffffffffff']);
  assert.deepEqual(notices, [], 'a key no level uses changes nothing');
  p.restrict([KHD]);
  assert.equal(p.tracks[0].rep.id, 'sd');
  assert.equal(p.level, 'auto', 'the refused fixed level is let go');
  assert.deepEqual(notices, [LOWER_QUALITY]);
  assert.deepEqual(levels, [['sd']]);
  p.restrict([KHD]);
  assert.equal(notices.length, 1, 'said once');
  p.restrict([KSD]);
  assert.deepEqual(errors, ["This channel's protection won't play in this browser"]);
});
