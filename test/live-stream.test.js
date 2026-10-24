// Live TV playback (src/live/stream.js + playback's live input): the stream limit, zapping, reconnects, catch-up,
// radio and the provider address kept out of logs. A fake provider serves an MPEG-TS file made by ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, fakeServer } from './helpers.js';
import { buildFfmpegArgs } from '../src/stream/playback.js';
import { redactArgs } from '../src/stream/ffheaders.js';
import { fakePool } from './helpers-live.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const CAPS = { video: ['h264'], audio: ['aac', 'mp3', 'opus'], containers: ['mp4', 'webm'] };
let nf, admin, other, upstream, ts, aac, ids, failAfter = Infinity, served = 0, requests = [];

before(async () => {
  if (!hasFfmpeg) return;
  const dir = tempDir();
  ts = path.join(dir, 'live.ts');
  makeVideo(ts, { seconds: 4 });
  aac = path.join(dir, 'radio.aac');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:a', 'aac', aac]);
  upstream = await fakeServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith('/live/') || req.url.startsWith('/timeshift/')) {
      served++;
      if (served > failAfter) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return fs.createReadStream(ts).pipe(res);
    }
    if (req.url.startsWith('/radio/')) {
      res.writeHead(200, { 'content-type': 'audio/aac' });
      return fs.createReadStream(aac).pipe(res);
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = upstream.url;
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS, ATOMIX_LIVE_TUNERS: 'off' }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  other = client(nf.base);
  await other.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  const list = (await admin.get('/api/live/channels')).data;
  ids = Object.fromEntries(list.map((c) => [c.name, c.id]));
});
after(async () => {
  await nf?.app.stop();
  await upstream?.close();
});

const play = (c, id, body = {}) => c.post(`/api/live/channels/${id}/play`, { caps: CAPS, ...body });
const stopAll = async () => {
  for (const s of [...nf.app.core.playback.sessions.keys()]) nf.app.core.playback.stop(s, 'test');
};

test('startLive remuxes an H.264/AAC stream (mode remux) and the stream URL is Atomix\'s own', { skip }, async () => {
  const r = await play(admin, ids.One);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mode, 'remux');
  assert.equal(r.data.live, true);
  assert.equal(r.data.duration, null);
  assert.match(r.data.url, /^\/api\/(stream|hls)\//);
  assert.equal(r.data.channel.name, 'One');
  assert.ok(r.data.programme?.title?.startsWith('One '));
  assert.ok(!JSON.stringify(r.data).includes('secretpw'));
  const s = nf.app.core.playback.sessions.get(r.data.sessionId);
  assert.equal(s.live.kind, 'live');
  assert.equal(s.live.sourceKey, KEY);
  await stopAll();
});

test('live ffmpeg input: reconnects, a read timeout, the user agent apart from other headers, no -ss/-t/-readrate', () => {
  const plan = { mode: 'remux', target: 'mp4', file: 'http://p.example/live/u/pw/1.ts', headers: { 'User-Agent': 'Box/1', 'X-Token': 'abc' }, live: { kind: 'live' }, start: 30, media: { video: { codec: 'h264', height: 720 }, audio: [{ index: 1, codec: 'aac' }] }, audio: { index: 1, codec: 'aac' }, audioCopy: true, tools: { ffmpeg: { major: 6 } } };
  const args = buildFfmpegArgs(plan, {}, { type: 'hls', dir: '/tmp/x' });
  const joined = args.join(' ');
  for (const f of ['-reconnect 1', '-reconnect_streamed 1', '-reconnect_on_network_error 1', '-rw_timeout 15000000', '-user_agent Box/1']) assert.ok(joined.includes(f), f);
  assert.ok(!joined.includes('-ss '), 'no seek');
  assert.ok(!joined.includes('-readrate'), 'no read rate');
  assert.ok(!/\s-t\s/.test(joined));
  const headers = args[args.indexOf('-headers') + 1];
  assert.equal(headers, 'X-Token: abc\r\n');
  assert.ok(joined.includes('-hls_list_size 6'));
  assert.ok(joined.includes('delete_segments'));
  assert.ok(!joined.includes('-hls_playlist_type'), 'a live playlist has no type');
  assert.ok(args.indexOf('-i') > args.indexOf('-rw_timeout'), 'input options before -i');
});

test('the provider URL is redacted in the debug log', () => {
  const args = ['-hide_banner', '-headers', 'X-Token: abc\r\n', '-i', 'http://p.example:8080/live/u/secretpw/1.ts', '-c', 'copy'];
  const out = redactArgs(args).join(' ');
  assert.ok(!out.includes('secretpw'));
  assert.ok(out.includes('http://p.example:8080/…'));
  assert.ok(!out.includes('X-Token'));
});

test('ffmpeg errors are logged with addresses redacted', { skip }, async () => {
  const { setLogLevel } = await import('../src/log.js');
  const lines = [];
  const warn = console.warn;
  const logf = console.log;
  console.warn = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  setLogLevel('debug');
  try {
    failAfter = served + 1; // the probe works, every stream request after it fails
    const r = await play(admin, ids.One);
    await admin.raw(r.data.url).then((res) => res.arrayBuffer()).catch(() => {});
    await new Promise((res) => setTimeout(res, 300));
  } finally {
    failAfter = Infinity;
    console.warn = warn;
    console.log = logf;
    setLogLevel('error');
    await stopAll();
  }
  assert.ok(lines.some((l) => /\[playback\] ffmpeg /.test(l) || /ffmpeg /.test(l)), lines.join('\n'));
  assert.ok(lines.every((l) => !l.includes('/live/u/secretpw/')), lines.filter((l) => l.includes('secretpw')).join('\n'));
});

test('a 1-stream source refuses a second viewer with the exact sentence and holders', { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const a = await play(admin, ids.One);
    assert.equal(a.status, 200);
    const b = await play(other, ids.Two);
    assert.equal(b.status, 409);
    assert.equal(b.data.error, 'Your provider allows 1 stream at a time — stop the other one first');
    assert.deepEqual(b.data.details.holders, [{ profile: 'Someone else in your household', channel: null }]);
    // The same profile starting another channel (a reloaded tab, a crashed player, another screen) takes the slot
    // over: on a 1-stream provider the last one wins for that profile.
    const c = await play(admin, ids.Two);
    assert.equal(c.status, 200, 'the same profile replaces its own stream');
    assert.equal(nf.app.core.playback.sessions.has(a.data.sessionId), false, 'the old one stopped');
    const kidId = (await admin.post('/api/profiles', { name: 'Kiddo', kids: false, avatar: 'teal' })).data.id;
    const second = client(nf.base);
    await second.post('/api/auth/login', { username: 'dallas', password: 'password123' });
    await second.post(`/api/profiles/${kidId}/select`, {});
    const sib = await play(second, ids.One);
    assert.equal(sib.status, 409, 'another profile on the same account is refused');
    assert.deepEqual(sib.data.details.holders, [{ profile: 'dallas', channel: 'Two' }]);
    process.env.LIVE_TEST_MAX = '2';
    const d = await play(other, ids.Two);
    assert.equal(d.status, 200);
    process.env.LIVE_TEST_MAX = '2';
    const e = await play(second, ids.Three);
    assert.equal(e.data.error, 'Your provider allows 2 streams at a time — stop the other one first');
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopAll();
  }
});

test('two simultaneous starts on a 1-stream source: exactly one succeeds', { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const [a, b] = await Promise.all([play(admin, ids.One), play(other, ids.Two)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopAll();
  }
});

test('zapping with replaces stops the old session before stream() is asked for the new URL', { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const a = await play(admin, ids.One);
    const order = [];
    const pb = nf.app.core.playback;
    const src = nf.app.core.plugins.getLiveSource(KEY);
    const stop = pb.stop.bind(pb);
    const stream = src.stream;
    pb.stop = (id, reason) => {
      order.push(`stop:${id === a.data.sessionId ? 'old' : 'other'}`);
      return stop(id, reason);
    };
    src.stream = async (...args) => {
      order.push('stream');
      return stream(...args);
    };
    try {
      const b = await play(admin, ids.Two, { replaces: a.data.sessionId });
      assert.equal(b.status, 200, JSON.stringify(b.data));
    } finally {
      pb.stop = stop;
      src.stream = stream;
    }
    assert.deepEqual(order.slice(0, 2), ['stop:old', 'stream']);
    assert.equal(nf.app.core.playback.sessions.has(a.data.sessionId), false);
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopAll();
  }
});

test('an ffmpeg exit restarts the session up to 3 times, then ends it with "This channel stopped sending video."', { skip }, async () => {
  failAfter = served + 1; // the probe works, every stream request after it fails
  try {
    const r = await play(admin, ids.One);
    assert.equal(r.status, 200);
    const sid = r.data.sessionId;
    const pings = [];
    for (let i = 0; i < 4; i++) {
      await admin.raw(r.data.url).then((res) => res.arrayBuffer()).catch(() => {});
      await new Promise((res) => setTimeout(res, 200));
      pings.push((await admin.post(`/api/playback/${sid}/ping`, {})).data);
    }
    assert.equal(pings[0].notice, 'Lost the channel — trying again');
    assert.equal(pings.at(-1).ok, false);
    assert.equal(pings.at(-1).error, 'This channel stopped sending video.');
    assert.equal(nf.app.core.playback.sessions.has(sid), false);
  } finally {
    failAfter = Infinity;
    await stopAll();
  }
});

test('a dead channel answers 502 "This channel isn\'t answering right now (the provider closed the connection)"', { skip }, async () => {
  const r = await play(admin, ids.Three);
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "This channel isn't answering right now (the provider closed the connection)");
  assert.equal(nf.app.core.live.streams.openOn(KEY).length, 0, 'the reservation is released');
});

test('startCatchup builds a finite session with the programme\'s length minus from', { skip }, async () => {
  const now = Date.now();
  const g = (await admin.get(`/api/live/guide?from=${now - 3 * 3600_000}&to=${now}&channels=${ids.One}`)).data;
  const aired = g.programmes[ids.One].find((p) => p.end <= now);
  requests = [];
  const r = await admin.post(`/api/live/programmes/${aired.id}/play`, { caps: CAPS, from: 600 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.live, false);
  assert.equal(r.data.duration, (aired.end - aired.start) / 1000);
  assert.equal(r.data.start, 600);
  assert.ok(requests.some((u) => u === `/timeshift/u/secretpw/${Math.floor(aired.start / 1000) + 600}/1.ts`), requests.join(','));
  const s = nf.app.core.playback.sessions.get(r.data.sessionId);
  assert.equal(s.live.kind, 'catchup');
  const two = (await admin.get(`/api/live/guide?from=${now - 3 * 3600_000}&to=${now}&channels=${ids.Two}`)).data.programmes[ids.Two].find((p) => p.end <= now);
  const no = await admin.post(`/api/live/programmes/${two.id}/play`, { caps: CAPS });
  assert.equal(no.status, 400);
  assert.equal(no.data.error, "This programme can't be played from the archive");
  await stopAll();
});

test('audioOnly sessions copy AAC and drop video', { skip }, async () => {
  const r = await play(admin, ids['Radio Waves'], { audioOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = nf.app.core.playback.sessions.get(r.data.sessionId);
  assert.equal(s.audioOnly, true);
  assert.equal(r.data.mode, 'remux', 'copied, not converted');
  const args = buildFfmpegArgs(s, {}, { type: 'progressive' });
  const j = args.join(' ');
  assert.ok(j.includes('-vn'));
  assert.ok(j.includes('-c:a copy'), j);
  await stopAll();
});

test('live sessions count toward the per-account limit of 4', { skip }, async () => {
  const opened = [];
  try {
    for (let i = 0; i < 4; i++) opened.push(await play(admin, ids.One));
    assert.ok(opened.every((o) => o.status === 200));
    const fifth = await play(admin, ids.One);
    assert.equal(fifth.status, 429);
    assert.equal(fifth.data.error, 'Too many streams open on this account.');
  } finally {
    await stopAll();
  }
});

test('progress for a live: id writes nothing', { skip }, async () => {
  const r = await play(admin, ids.One);
  const p = await admin.post(`/api/items/live:${ids.One}/progress`, { position: 30, duration: 0, sessionId: r.data.sessionId });
  assert.equal(p.status, 200);
  assert.deepEqual(p.data, { ok: true });
  const c = await admin.post(`/api/items/catchup:1/progress`, { position: 30 });
  assert.equal(c.status, 200);
  assert.equal(nf.app.core.db.get('SELECT COUNT(*) AS n FROM progress').n, 0);
  await stopAll();
});

test('AAC copied from MPEG-TS into MP4 gets aac_adtstoasc (video remux and radio)', () => {
  const media = { video: { codec: 'h264', height: 360 }, audio: [{ index: 1, codec: 'aac' }] };
  const video = buildFfmpegArgs({ mode: 'remux', target: 'mp4', file: 'http://p/1.ts', live: { kind: 'live' }, media, audio: media.audio[0], audioCopy: true, tools: {} }, {}, { type: 'progressive' }).join(' ');
  assert.ok(video.includes('-c:a copy -bsf:a aac_adtstoasc'), video);
  const radio = buildFfmpegArgs({ mode: 'remux', target: 'mp4', file: 'http://p/r.aac', live: { kind: 'live' }, audioOnly: true, media: { audio: [{ index: 0, codec: 'aac' }] }, audio: { index: 0, codec: 'aac' }, audioCopy: true }, {}, { type: 'progressive' }).join(' ');
  assert.ok(radio.includes('-c:a copy -bsf:a aac_adtstoasc'), radio);
  const mp3 = buildFfmpegArgs({ mode: 'remux', target: 'mp4', file: 'http://p/r.mp3', live: { kind: 'live' }, audioOnly: true, media: { audio: [{ index: 0, codec: 'mp3' }] }, audio: { index: 0, codec: 'mp3' }, audioCopy: true }, {}, { type: 'progressive' }).join(' ');
  assert.ok(!mp3.includes('aac_adtstoasc'));
});

test('a copied live stream keeps flowing (not just its header)', { skip }, async () => {
  const r = await play(admin, ids.One);
  const res = await admin.raw(r.data.url);
  const reader = res.body.getReader();
  let bytes = 0;
  const t = Date.now();
  while (Date.now() - t < 3000) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  await reader.cancel().catch(() => {});
  assert.ok(bytes > 50_000, `${bytes} bytes`);
  await stopAll();
});

test('a channel address that is a local file (or file:, or anything not http/https) is refused', { skip }, async () => {
  try {
    for (const url of [ts, `file://${ts}`, `/api/items/1/file`, 'concat:a|b']) {
      process.env.LIVE_TEST_ONE_URL = url;
      const r = await play(admin, ids.One);
      assert.equal(r.status, 502, `${url}: ${r.status}`);
      assert.equal(r.data.error, "This channel isn't answering right now (the provider closed the connection)");
    }
  } finally {
    delete process.env.LIVE_TEST_ONE_URL;
    await stopAll();
  }
});

test('live inputs are limited to network protocols (an HLS playlist can\'t point ffmpeg at a local file)', () => {
  const args = buildFfmpegArgs({ mode: 'remux', target: 'mp4', file: 'http://p/1.m3u8', live: { kind: 'live' }, media: { video: { codec: 'h264' }, audio: [] }, tools: {} }, {}, { type: 'progressive' });
  const i = args.indexOf('-protocol_whitelist');
  assert.ok(i > -1 && i < args.indexOf('-i'));
  assert.equal(args[i + 1], 'http,https,tcp,tls,crypto');
  const cu = buildFfmpegArgs({ mode: 'remux', target: 'mp4', file: 'http://p/a.ts', live: { kind: 'catchup' }, media: { video: { codec: 'h264' }, audio: [] }, tools: {} }, {}, { type: 'progressive' });
  assert.ok(cu.includes('-protocol_whitelist'), 'catch-up too');
});

// The stream limit, the probe cache and the conversion cap without a provider: a LiveStreams with fakes around it.
import { LiveStreams } from '../src/live/stream.js';
import { EventEmitter } from 'node:events';
function fakeStreams({ max = 1, now, stream = null } = {}) {
  const sessions = new Map();
  let probes = 0;
  let creates = 0;
  let failCreateOnce = false;
  const source = { key: 'src/a', maxStreams: () => max, stream: stream || (async (key) => ({ url: `http://provider.example/${key}.ts`, headers: {} })) };
  const hooks = new EventEmitter();
  const playback = {
    sessions,
    hooks,
    stop: (id) => {
      const session = sessions.get(id);
      sessions.delete(id);
      if (session) hooks.emit('playback:stop', { session });
    },
    create: async ({ user, profile, live }) => {
      creates++;
      if (failCreateOnce) {
        failCreateOnce = false;
        throw new Error('the stream changed');
      }
      const s = { id: `s${creates}`, userId: user.id, profileId: profile?.id ?? null, username: profile?.name || 'x', live, createdAt: creates };
      sessions.set(s.id, s);
      return { session: s, url: `/api/stream/${s.id}` };
    },
  };
  const ls = new LiveStreams({ store: null, plugins: { getLiveSource: () => source }, playback, config: {}, log: { debug() {}, warn() {} }, now });
  ls.probeOrExplain = async () => (probes++, { video: { codec: 'h264' }, audio: [{ codec: 'aac' }] });
  return { ls, sessions, counts: () => ({ probes, creates }), failNext: () => (failCreateOnce = true) };
}
const userA = { id: 1 };
const userB = { id: 2 };
const profA = { id: 10, name: 'Dallas', kids: false };
const profKid = { id: 11, name: 'Mia', kids: true };
const chan = (key) => ({ id: key, key, name: key.toUpperCase(), source: 'src/a', radio: false });

test('replaces naming another account\'s session still counts it', async () => {
  const { ls } = fakeStreams();
  const theirs = await ls.startLive({ user: userB, profile: { id: 20 }, channel: chan('one'), caps: {} });
  await assert.rejects(ls.startLive({ user: userA, profile: profA, channel: chan('two'), caps: {}, replaces: theirs.session.id }), (e) => e.status === 409);
});

test('a 409 names holders only to the same profile or an admin\'s grown-up profile', async () => {
  const { ls } = fakeStreams();
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  const err = await ls.startLive({ user: userA, profile: profKid, channel: chan('two'), caps: {} }).catch((e) => e);
  assert.equal(err.status, 409);
  assert.equal(err.message, 'Your provider allows 1 stream at a time — another profile on your account is using it');
  assert.ok(!JSON.stringify(err.details || {}).includes('Dallas'), 'the Kids profile isn\'t told whose');
  const asAdmin = await ls.startLive({ user: userA, profile: { id: 12, name: 'Other', kids: false }, isAdmin: true, channel: chan('two'), caps: {} }).catch((e) => e);
  assert.ok(JSON.stringify(asAdmin.details || {}).includes('Dallas'), 'an admin on a grown-up profile is');
});

test('a stream refused by another account\'s streams doesn\'t first stop the caller\'s own', async () => {
  const { ls, sessions } = fakeStreams({ max: 1 });
  const mine = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  // Someone else's stream is also open (the limit was lowered, or it started elsewhere): stopping mine can't help.
  sessions.set('theirs', { id: 'theirs', userId: 2, profileId: 20, username: 'G', live: { sourceKey: 'src/a' }, createdAt: 0 });
  await assert.rejects(ls.startLive({ user: userA, profile: profA, channel: chan('two'), caps: {} }), (e) => e.status === 409);
  assert.ok(sessions.has(mine.session.id), 'my own stream (perhaps a TV\'s) is still playing');
});

test('a channel\'s probe is reused for 10 minutes', async () => {
  let t = 1_000_000;
  const { ls, sessions, counts } = fakeStreams({ max: 5, now: () => t });
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  sessions.clear();
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  assert.equal(counts().probes, 1, 'one provider connection for the second start');
  t += 10 * 60_000 + 1;
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  assert.equal(counts().probes, 2);
});

test('a start that fails with a reused probe retries once with a fresh one', async () => {
  const { ls, counts, failNext } = fakeStreams({ max: 5 });
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  failNext();
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  assert.deepEqual(counts(), { probes: 2, creates: 3 });
});

test('a live stream that drops forgets the channel\'s probe (the next start checks the stream again)', async () => {
  const { ls, sessions, counts } = fakeStreams({ max: 5 });
  const first = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  const { PlaybackManager } = await import('../src/stream/playback.js');
  const pm = Object.create(PlaybackManager.prototype);
  Object.assign(pm, { sessions: new Map([[first.session.id, first.session]]), ended: new Map(), hooks: { emit() {} }, onLiveDropped: ls.playback.onLiveDropped });
  pm.liveDropped(first.session, null);
  sessions.clear();
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} });
  assert.equal(counts().probes, 2, 'a fresh check after the drop');
});

test('copied live radio doesn\'t count toward the conversion cap', async () => {
  const { PlaybackManager } = await import('../src/stream/playback.js');
  const pm = Object.create(PlaybackManager.prototype);
  pm.sessions = new Map([['r', { id: 'r', proc: { killed: false }, live: { kind: 'live' }, audioOnly: true, audioCopy: true }]]);
  pm.extractions = 0;
  pm.settings = { get: (k) => (k === 'maxTranscodes' ? 1 : null) };
  pm.checkCapacity({ mode: 'transcode' }); // doesn't throw: the radio copy isn't a conversion
  pm.sessions.set('t', { id: 't', proc: { killed: false }, mode: 'transcode' });
  assert.throws(() => pm.checkCapacity({ mode: 'transcode' }), (e) => e.status === 503);
});

// ---- v0.19: tuners (one provider connection per channel) — a fake pool around the same fakes ----
function tunedStreams(opts = {}) {
  const f = fakeStreams(opts);
  const pool = fakePool(opts);
  f.ls.tuners = pool;
  f.creates = [];
  const create = f.ls.playback.create;
  f.ls.playback.create = async (args) => (f.creates.push(args), create(args));
  f.ls.playback.sessionsOf = (userId) => [...[...f.sessions.values()].filter((s) => s.userId === userId), ...f.ls.playback.externalLists.flatMap((fn) => fn(userId))];
  return { ...f, pool };
}
const TCAPS = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'], hls: false };

test('two viewers on one channel count as one stream', async () => {
  const { ls } = tunedStreams({ max: 1 });
  const a = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  const b = await ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: chan('one'), caps: TCAPS });
  assert.equal(a.delivery, 'dash');
  assert.equal(b.delivery, 'dash');
  assert.equal(ls.openOn('src/a').length, 1);
});

test('a viewer on another channel still needs its own slot', async () => {
  const { ls } = tunedStreams({ max: 1 });
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  await assert.rejects(ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: chan('two'), caps: TCAPS }), (e) => e.status === 409);
});

test('zapping releases the old hold before the new tuner reserves (1-stream provider)', async () => {
  const { ls, pool } = tunedStreams({ max: 1 });
  const first = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  const second = await ls.startLive({ user: userA, profile: profA, channel: chan('two'), caps: TCAPS, replaces: first.session.id });
  assert.equal(second.delivery, 'dash');
  assert.equal(pool.get('src/a\u0000one'), undefined, 'the idle tuner of the old channel was closed for the new one');
  assert.ok(!ls.viewers.has(first.session.id));
});

test("a viewer whose browser can't play the codecs gets a conversion from the buffer", async () => {
  const { ls, creates } = tunedStreams({ max: 2 });
  ls.probeOrExplain = async () => ({ video: { codec: 'hevc' }, audio: [{ codec: 'aac' }] });
  const r = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  assert.notEqual(r.delivery, 'dash');
  assert.equal(creates.at(-1).source.file, '/data/timeshift/t1/run-1/index.m3u8');
  assert.equal(creates.at(-1).live.kind, 'buffer');
  assert.equal(ls.openOn('src/a').length, 1, 'the conversion rides on the tuner: still one stream');
});

test('radio plays from the tuner through a conversion (the music player can\'t play DASH)', async () => {
  const { ls, creates, pool } = tunedStreams({ max: 1 });
  ls.probeOrExplain = async () => ({ video: null, audio: [{ codec: 'mp3' }] });
  const radio = { ...chan('rnz'), radio: true };
  const a = await ls.startLive({ user: userA, profile: profA, channel: radio, caps: TCAPS });
  await ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: radio, caps: TCAPS });
  assert.notEqual(a.delivery, 'dash');
  assert.equal(creates.at(-1).audioOnly, true);
  assert.equal(creates.at(-1).live.kind, 'buffer');
  assert.equal(pool.tuners.size, 1);
  assert.equal(ls.openOn('src/a').length, 1);
});

test('an unbuffered channel falls back to the provider and says so', async () => {
  const f = fakeStreams({ max: 2 });
  f.ls.tuners = fakePool({ unbuffered: true });
  const r = await f.ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  assert.notEqual(r.delivery, 'dash');
  assert.match(String(r.session.reasons || []), /Rewind isn't available on this channel/);
});

test('viewer sessions count toward the account\'s 4', async () => {
  const { ls } = tunedStreams({ max: 10 });
  for (const c of ['a', 'b', 'c', 'd']) await ls.startLive({ user: userA, profile: profA, channel: chan(c), caps: TCAPS });
  await assert.rejects(ls.startLive({ user: userA, profile: profA, channel: chan('e'), caps: TCAPS }), (e) => e.status === 429 && e.message === 'Too many streams open on this account.');
});

test('a viewer of someone else is a 404; stop releases the hold', async () => {
  const { ls, pool } = tunedStreams({ max: 2 });
  const r = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  assert.throws(() => ls.viewerGet(r.session.id, userB, { id: 20 }), (e) => e.status === 404);
  assert.throws(() => ls.viewerGet(r.session.id, userA, profKid), (e) => e.status === 404);
  assert.equal(ls.viewerGet(r.session.id, userA, profA).id, r.session.id);
  ls.viewerStop(r.session.id, 'user');
  assert.equal(pool.get('src/a\u0000one').holders.size, 0);
  assert.equal(ls.viewerPing(r.session.id, userA, profA).ok, false);
});

test('joining a tuned channel asks the provider nothing (no stream() call, no probe), even after the probe cache aged', async () => {
  let t = 1_000_000;
  const { ls, counts } = tunedStreams({ max: 1, now: () => t });
  let streamCalls = 0;
  const src = ls.plugins.getLiveSource();
  const orig = src.stream;
  src.stream = async (k) => (streamCalls++, orig(k));
  await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  t += 11 * 60_000;
  await ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: chan('one'), caps: TCAPS });
  assert.equal(streamCalls, 1);
  assert.equal(counts().probes, 1);
});

test('zapping to a fresh channel closes the old idle tuner before the new channel is probed (1-stream provider)', async () => {
  const { ls, pool } = tunedStreams({ max: 1 });
  const first = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  let oldOpenAtProbe = null;
  const probe = ls.probeOrExplain;
  ls.probeOrExplain = async (...a) => ((oldOpenAtProbe = Boolean(pool.get('src/a\u0000one'))), probe(...a));
  await ls.startLive({ user: userA, profile: profA, channel: chan('two'), caps: TCAPS, replaces: first.session.id });
  assert.equal(oldOpenAtProbe, false);
});

test("a granted slot closes the source's idle tuners (they still hold a provider connection), not the one asked for", () => {
  const { ls, pool } = tunedStreams({ max: 1 });
  pool.tuners.set('src/a\u0000idle', { id: 'x', key: 'src/a\u0000idle', holders: new Map() });
  pool.tuners.set('src/a\u0000target', { id: 'y', key: 'src/a\u0000target', holders: new Map() });
  const release = ls.reserve(ls.plugins.getLiveSource(), { user: userA, profile: profA, spareKey: 'src/a\u0000target' });
  release();
  assert.equal(pool.get('src/a\u0000idle'), undefined);
  assert.ok(pool.get('src/a\u0000target'));
});

test('"listen only" on a TV channel tunes the full channel and converts the sound; a later viewer still gets the picture', async () => {
  const { ls, pool, creates } = tunedStreams({ max: 2 });
  const specs = [];
  const acq = pool.acquire.bind(pool);
  pool.acquire = (spec, h) => (specs.push(spec), acq(spec, h));
  const a = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS, audioOnly: true });
  assert.notEqual(a.delivery, 'dash');
  assert.ok(specs[0].media.video, 'the tuner keeps the picture');
  assert.equal(creates.at(-1).audioOnly, true);
  const b = await ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: chan('one'), caps: TCAPS });
  assert.equal(b.delivery, 'dash');
});

test('a browser without MediaSource (iPhone Safari) gets a conversion from the buffer, not the DASH buffer', async () => {
  const { ls, creates } = tunedStreams({ max: 2 });
  const r = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: { ...TCAPS, hls: true, mse: false } });
  assert.notEqual(r.delivery, 'dash');
  assert.equal(creates.length, 1, 'a conversion was made');
  assert.equal(creates[0].live.kind, 'buffer', 'reading the tuner (one provider connection, rewind still works)');
  assert.equal(ls.viewers.size, 0);
});

test('parseCaps keeps whether the browser has MediaSource', async () => {
  const { parseCaps } = await import('../src/api/playback.js');
  assert.equal(parseCaps({ mse: false }).mse, false);
  assert.equal(parseCaps({ mse: true }).mse, true);
  assert.equal(parseCaps({}).mse, true, 'a client that doesn\'t say is taken to have it (as before)');
});

// ---- v0.21 tidy-up ----
test('listeners go with their viewer (a tuner held for hours by a recording collects none)', async () => {
  const { ls, pool } = tunedStreams({ max: 3 });
  const recording = await pool.acquire({ key: 'src/a\u0000one', url: 'u', headers: {}, media: { video: { codec: 'h264' }, audio: [{ codec: 'aac' }] }, label: 'ONE' }, { id: 'rec1', kind: 'recording' });
  const base = { ended: recording.listenerCount('ended'), run: recording.listenerCount('run') };
  const a = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS });
  const b = await ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: chan('one'), caps: TCAPS });
  assert.equal(a.delivery, 'dash');
  assert.equal(b.delivery, 'dash');
  const c = await ls.startLive({ user: userB, profile: { id: 20, name: 'G' }, channel: chan('one'), caps: { ...TCAPS, video: ['vp9'] } });
  assert.notEqual(c.delivery, 'dash', 'a conversion from the buffer');
  assert.ok(recording.listenerCount('ended') > base.ended);
  ls.viewerStop(a.session.id, 'user');
  ls.viewerStop(b.session.id, 'user');
  ls.playback.stop(c.session.id, 'user');
  assert.equal(recording.listenerCount('ended'), base.ended);
  assert.equal(recording.listenerCount('run'), base.run);
});

test('the account cap holds for parallel starts of tuner viewers', async () => {
  const f = fakeStreams({ max: 10 });
  const pool = fakePool({ slowAcquire: 30 });
  f.ls.tuners = pool;
  f.ls.playback.sessionsOf = (userId) => [...[...f.sessions.values()].filter((s) => s.userId === userId), ...f.ls.playback.externalLists.flatMap((fn) => fn(userId))];
  const results = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((c) => f.ls.startLive({ user: userA, profile: profA, channel: chan(c), caps: TCAPS })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
  const refused = results.find((r) => r.status === 'rejected');
  assert.equal(refused.reason.status, 429);
  assert.equal(refused.reason.message, 'Too many streams open on this account.');
  assert.equal([...pool.tuners.values()].reduce((n, t) => n + t.holders.size, 0), 4, 'the refused one let go of its tuner');
});

test('a refused channel says so at once', async () => {
  const f = fakeStreams({ max: 2 });
  f.ls.tuners = fakePool({ refused: true });
  await assert.rejects(f.ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: TCAPS }), (e) => e.status === 502 && e.message === 'The provider refused this channel');
});

// v0.22 Plan E: a provider that never answers its address request doesn't hang a start or a tuner's restart.
const never = () => new Promise(() => {});
test('a viewer\'s start whose source never answers ends with the 502 sentence', async () => {
  const { ls } = fakeStreams({ max: 5, stream: never });
  ls.resolveTimeoutMs = 50;
  const t0 = Date.now();
  const err = await ls.startLive({ user: userA, profile: profA, channel: chan('one'), caps: {} }).catch((e) => e);
  assert.equal(err.status, 502);
  assert.equal(err.message, "This channel isn't answering right now (the provider closed the connection)");
  assert.ok(Date.now() - t0 < 2000);
});

test('a restart whose source never answers keeps the old address', async () => {
  const { ls } = fakeStreams({ max: 5, stream: never });
  ls.resolveTimeoutMs = 50;
  const resolve = ls.resolverFor({ key: 'src/a', stream: never }, chan('one'));
  await assert.rejects(resolve(), /answer/);
});

test('after a drop the conversion starts in the new run, not in the old one (v0.22)', async () => {
  const { piecesAfterRun } = await import('../src/live/stream.js');
  const runs = (...n) => ({ runs: n.map((k) => ({ pieces: Array.from({ length: k }, () => ({})) })) });
  assert.equal(piecesAfterRun(runs(3, 1)), 1, 'one piece in the new run: -1, never the old run');
  assert.equal(piecesAfterRun(runs(3, 2)), 2);
  assert.equal(piecesAfterRun(runs(3, 5)), 2, 'its live point, as before');
  assert.equal(piecesAfterRun(runs(3, 0)), 1);
});
