// The recording scheduler (src/live/scheduler.js) on a fake clock: start and end with padding, sharing a watched
// channel's tuner, taking a viewer's slot, never a recording's, cancel, restart → part 2, the disk floor, a removed
// source, the clash warning — and one real end-to-end recording into the Recordings library.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, hasFfmpeg, startAtomix, client } from './helpers.js';
import { fakePool, endlessProvider } from './helpers-live.js';
import { openDatabase } from '../src/db.js';
import { LiveStore } from '../src/live/store.js';
import { LiveStreams } from '../src/live/stream.js';
import { Recordings } from '../src/live/recordings.js';
import { Scheduler } from '../src/live/scheduler.js';

const SRC = 'src/a';
const T = Date.UTC(2026, 9, 10, 8, 0, 0);
const MIN = 60_000;
const GB = 1024 ** 3;
const TCAPS = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'], hls: false };
const quiet = { warn() {}, info() {}, debug() {}, error() {} };

function setup({ max = 1, free = 100 * GB, t0 = T - 10 * MIN, finishLeftover = null, db: givenDb = null, dir: givenDir = null } = {}) {
  let t = t0;
  const now = () => t;
  const dir = givenDir || tempDir();
  const db = givenDb || openDatabase(path.join(tempDir(), 'sched.db'));
  if (!givenDb) {
    db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('dallas', 'dallas', 'x', 'admin', 0)");
    db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'Dallas', 'blue', 1, 0)");
  }
  const store = new LiveStore(db);
  if (!givenDb) {
    store.replaceChannels(SRC, ['one', 'two', 'three'].map((k) => ({ key: k, name: k.toUpperCase(), number: null, group: ['News'], radio: false, guideId: k })));
  }
  const recordings = new Recordings(db, { now });
  const pool = fakePool();
  let removed = false;
  const calls = { stream: 0 };
  const source = { key: SRC, maxStreams: () => max, stream: async (key) => (calls.stream++, { url: `http://provider.example/${key}.ts`, headers: {} }) };
  const plugins = { getLiveSource: (k) => (k === SRC && !removed ? source : null) };
  const playback = { sessions: new Map(), stop(id) { this.sessions.delete(id); }, ended: new Map() };
  const streams = new LiveStreams({ store, plugins, playback, config: {}, log: quiet, now, tuners: pool });
  streams.probeOrExplain = async () => ({ video: { codec: 'h264' }, audio: [{ codec: 'aac' }] });
  const made = [];
  const makeRecorder = (opts) => {
    const r = {
      opts,
      started: false,
      finished: null,
      aborted: false,
      start() {
        this.started = true;
        return this;
      },
      attach(tuner) {
        this.opts.tuner = tuner;
      },
      async finish(out) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, 'mkv');
        this.finished = out;
        return { file: out, gapSeconds: 0 };
      },
      abort() {
        this.aborted = true;
      },
    };
    made.push(r);
    return r;
  };
  const values = { recordingsDir: dir, recordPre: 1, recordPost: 3 };
  const settings = { get: (k) => values[k], all: () => ({ ...values }) };
  const scanner = { scans: [], enqueue: async (id) => scanner.scans.push(id), removePaths: (lib, paths) => paths.forEach((p) => db.run('DELETE FROM items WHERE library_id = ? AND path = ?', lib, p)) };
  const sched = new Scheduler({ store, recordings, streams, tuners: pool, plugins, settings, config: { ffmpegPath: 'ffmpeg', recordingsDir: dir }, scanner, db, log: quiet, now, makeRecorder, freeBytes: () => free, ...(finishLeftover ? { finishLeftover } : {}) });
  const chan = (key) => store.channels({ sources: [SRC] }).find((c) => c.key === key);
  const prog = (key, startMin, lenMin, title = 'Show', extra = {}) => ({ id: 1000 + startMin, channelId: chan(key).id, start: T + startMin * MIN, end: T + (startMin + lenMin) * MIN, title, subtitle: null, description: 'About it', episode: null, repeat: false, ...extra });
  const profile = { id: 1, name: 'Dallas', kids: false };
  const at = async (ms) => {
    t = ms;
    await sched.tick();
  };
  return { db, store, recordings, pool, streams, sched, made, calls, settings: values, scanner, dir, chan, prog, profile, at, now, setFree: (v) => (free = v), removeSource: () => (removed = true) };
}

test('a due recording starts at start − pre and ends at end + post', async () => {
  const s = setup();
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  assert.equal(recording.status, 'scheduled');
  await s.at(T - 61_000);
  assert.equal(s.recordings.get(recording.id).status, 'scheduled');
  await s.at(T - 60_000);
  assert.equal(s.recordings.get(recording.id).status, 'recording');
  const tuner = s.pool.get(`${SRC}\u0000one`);
  assert.ok(tuner.holders.has(`rec:${recording.id}`));
  assert.equal(tuner.holders.get(`rec:${recording.id}`).kind, 'recording');
  assert.equal(s.made[0].opts.from, T - 60_000);
  assert.equal(s.made[0].opts.to, T + 33 * MIN);
  await s.at(T + 33 * MIN - 1000);
  assert.equal(s.recordings.get(recording.id).status, 'recording');
  await s.at(T + 33 * MIN);
  await s.sched.settled();
  const done = s.recordings.get(recording.id);
  assert.equal(done.status, 'done');
  assert.ok(done.path.endsWith('.mkv') && fs.existsSync(done.path));
  assert.ok(fs.existsSync(done.path.replace(/\.mkv$/, '.nfo')), 'the .nfo beside it');
  assert.ok(!tuner.holders.has(`rec:${recording.id}`), 'the hold is released');
  assert.equal(s.scanner.scans.length, 1, 'the Recordings library was scanned');
  const lib = s.db.get("SELECT * FROM libraries WHERE name = 'Recordings'");
  assert.equal(lib.type, 'tv');
  assert.deepEqual(JSON.parse(lib.paths), [s.dir]);
});

test('a channel someone is watching: the recording shares its tuner', async () => {
  const s = setup({ max: 1 });
  const v = await s.streams.startLive({ user: { id: 1 }, profile: s.profile, channel: s.chan('one'), caps: TCAPS });
  assert.equal(v.delivery, 'dash');
  const streamCalls = s.calls.stream;
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  assert.equal(s.recordings.get(recording.id).status, 'recording');
  assert.equal(s.pool.tuners.size, 1, 'no second tuner');
  assert.equal(s.calls.stream, streamCalls, 'the provider wasn\'t asked again');
  assert.ok(s.streams.viewers.has(v.session.id), 'the viewer keeps watching');
  assert.equal(s.made[0].opts.tuner, s.pool.get(`${SRC}\u0000one`));
});

test('no free slot: the newest viewers on other channels are stopped with "Stopped to record <title>"', async () => {
  const s = setup({ max: 1 });
  const a = await s.streams.startLive({ user: { id: 1 }, profile: s.profile, channel: s.chan('two'), caps: TCAPS });
  const b = await s.streams.startLive({ user: { id: 2 }, profile: { id: 20, name: 'G' }, channel: s.chan('two'), caps: TCAPS });
  s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30, 'The News'), channel: s.chan('one') });
  await s.at(T - MIN);
  assert.equal(s.recordings.list({ status: 'recording' }).length, 1);
  assert.deepEqual(s.streams.viewerPing(a.session.id, { id: 1 }, s.profile), { ok: false, error: 'Stopped to record The News' });
  assert.deepEqual(s.streams.viewerPing(b.session.id, { id: 2 }, { id: 20 }), { ok: false, error: 'Stopped to record The News' });
  assert.equal(s.pool.get(`${SRC}\u0000two`), undefined, 'the other channel\'s tuner closed');
});

test('only recordings hold the slots: it fails "Couldn\'t record: every stream is recording"', async () => {
  const s = setup({ max: 1 });
  const first = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 60), channel: s.chan('one') }).recording;
  const second = s.sched.schedule({ profile: s.profile, programme: s.prog('two', 10, 30), channel: s.chan('two') }).recording;
  await s.at(T - MIN);
  await s.at(T + 9 * MIN);
  assert.equal(s.recordings.get(first.id).status, 'recording', 'a recording is never stopped for another');
  const r = s.recordings.get(second.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, "Couldn't record: every stream is recording");
});

test('a recording in its late minutes gives way to the next one', async () => {
  const s = setup({ max: 1 });
  const first = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') }).recording;
  const second = s.sched.schedule({ profile: s.profile, programme: s.prog('two', 30, 30), channel: s.chan('two') }).recording;
  await s.at(T - MIN);
  await s.at(T + 29 * MIN);
  assert.equal(s.recordings.get(first.id).status, 'recording', 'its programme is still on');
  assert.equal(s.recordings.get(second.id).status, 'scheduled', 'the next one waits for it (no early minute)');
  await s.at(T + 30 * MIN);
  await s.sched.settled();
  assert.equal(s.recordings.get(first.id).status, 'done', 'ended at its programme\'s end, without its late minutes');
  assert.equal(s.recordings.get(first.id).error, null);
  assert.equal(s.recordings.get(second.id).status, 'recording');
});

test('cancelling while recording keeps what was recorded and releases the hold', async () => {
  const s = setup();
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T + 5 * MIN);
  await s.sched.cancel(recording.id);
  await s.sched.settled();
  const r = s.recordings.get(recording.id);
  assert.equal(r.status, 'done');
  assert.equal(r.error, 'Stopped early');
  assert.ok(fs.existsSync(r.path));
  assert.equal(s.pool.get(`${SRC}\u0000one`)?.holders.size ?? 0, 0);
  const later = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 60, 30), channel: s.chan('one') }).recording;
  await s.sched.cancel(later.id);
  assert.equal(s.recordings.get(later.id).status, 'cancelled');
});

test('restarted mid-recording: recover() resumes it as part 2', async () => {
  const first = setup();
  const { recording } = first.sched.schedule({ profile: first.profile, programme: first.prog('one', 0, 30, 'Show', { episode: 'S1 E2', subtitle: 'Pilot' }), channel: first.chan('one') });
  await first.at(T + 5 * MIN);
  const work = first.made[0].opts.workDir;
  fs.mkdirSync(path.join(work, 'part-1'), { recursive: true });
  fs.writeFileSync(path.join(work, 'part-1', 'init.mp4'), 'x');
  // Atomix stops without finishing (a crash or a restart); a new Atomix starts over the same database.
  const joined = [];
  const again = setup({ db: first.db, dir: first.dir, t0: T + 6 * MIN, finishLeftover: async (dir, out) => (joined.push([dir, out]), fs.mkdirSync(path.dirname(out), { recursive: true }), fs.writeFileSync(out, 'part1'), { file: out, gapSeconds: 0 }) });
  await again.sched.recover();
  await again.sched.settled();
  const p1 = again.recordings.get(recording.id);
  assert.equal(p1.status, 'done');
  assert.equal(path.basename(p1.path), 'Show - S01E02 - Pilot.mkv');
  assert.equal(joined[0][0], work);
  const p2 = again.recordings.list().find((r) => r.part === 2);
  assert.ok(p2, 'a part 2');
  await again.sched.tick();
  assert.equal(again.recordings.get(p2.id).status, 'recording');
  await again.at(T + 33 * MIN);
  await again.sched.settled();
  assert.equal(path.basename(again.recordings.get(p2.id).path), 'Show - S01E02 - Pilot (part 2).mkv');
});

test('recover(): a recording whose time passed while Atomix was off is finished from what it got; a missed one fails', async () => {
  const first = setup();
  const a = first.sched.schedule({ profile: first.profile, programme: first.prog('one', 0, 30), channel: first.chan('one') }).recording;
  const b = first.sched.schedule({ profile: first.profile, programme: first.prog('two', 60, 30), channel: first.chan('two') }).recording;
  await first.at(T + 5 * MIN);
  fs.mkdirSync(path.join(first.made[0].opts.workDir, 'part-1'), { recursive: true });
  const again = setup({ db: first.db, dir: first.dir, t0: T + 200 * MIN, finishLeftover: async (dir, out) => (fs.mkdirSync(path.dirname(out), { recursive: true }), fs.writeFileSync(out, 'x'), { file: out, gapSeconds: 0 }) });
  await again.sched.recover();
  await again.sched.settled();
  assert.equal(again.recordings.get(a.id).status, 'done');
  assert.equal(again.recordings.list().filter((r) => r.part === 2).length, 0);
  assert.equal(again.recordings.get(b.id).status, 'failed');
  assert.equal(again.recordings.get(b.id).error, "Atomix wasn't running at the time");
});

test('under 5 GB free: a due recording fails "The recordings folder is full"; a running one stops and is kept', async () => {
  const s = setup({ free: 4 * GB });
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  assert.deepEqual([s.recordings.get(recording.id).status, s.recordings.get(recording.id).error], ['failed', 'The recordings folder is full']);
  s.setFree(50 * GB);
  const next = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 60, 30), channel: s.chan('one') }).recording;
  await s.at(T + 59 * MIN);
  assert.equal(s.recordings.get(next.id).status, 'recording');
  s.setFree(4 * GB);
  await s.at(T + 70 * MIN);
  await s.sched.settled();
  assert.deepEqual([s.recordings.get(next.id).status, s.recordings.get(next.id).error], ['done', 'The recordings folder is full']);
});

test('a removed source fails its scheduled recordings "This channel no longer exists."', async () => {
  const s = setup();
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  s.removeSource();
  await s.at(T - MIN);
  assert.deepEqual([s.recordings.get(recording.id).status, s.recordings.get(recording.id).error], ['failed', 'This channel no longer exists.']);
});

test('schedule() warns about overlaps beyond the limit', () => {
  const s = setup({ max: 1 });
  assert.equal(s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') }).clash, null);
  assert.equal(s.sched.schedule({ profile: s.profile, programme: s.prog('two', 30, 30), channel: s.chan('two') }).clash, null, 'back to back is fine');
  const r = s.sched.schedule({ profile: s.profile, programme: s.prog('three', 10, 30), channel: s.chan('three') });
  assert.equal(r.clash, 'Your provider allows 1 stream at a time — this overlaps 2 other recordings');
  const same = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  assert.equal(same.recording.id, s.recordings.list()[0].id, 'the same airing twice is one recording');
});

// ---- review fixes ----
test('cancel while the recording is still starting: it doesn\'t start after all (no orphan hold)', async () => {
  const s = setup();
  let open;
  const real = s.streams.tuneForRecording.bind(s.streams);
  s.streams.tuneForRecording = (...a) => new Promise((res) => (open = () => res(real(...a))));
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  const ticking = s.at(T - MIN);
  await new Promise((r) => setTimeout(r, 10));
  await s.sched.cancel(recording.id);
  open();
  await ticking;
  await s.sched.settled();
  assert.equal(s.recordings.get(recording.id).status, 'cancelled');
  assert.equal(s.sched.active.size, 0);
  assert.equal(s.pool.get(`${SRC}\u0000one`)?.holders.size ?? 0, 0, 'no hold left');
  assert.ok(s.made.every((r) => r.aborted || !r.started), 'its recorder was thrown away');
});

test('a recording whose row went (its profile was deleted) is ended at the next tick; a tuner that gave up meanwhile doesn\'t stop the clock', async () => {
  const s = setup({ max: 2 });
  const a = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') }).recording;
  const b = s.sched.schedule({ profile: s.profile, programme: s.prog('two', 0, 30), channel: s.chan('two') }).recording;
  await s.at(T - MIN);
  s.db.run('DELETE FROM live_recordings WHERE id = ?', a.id);
  s.pool.end(`${SRC}\u0000one`, 'This channel stopped sending video.');
  const later = s.sched.schedule({ profile: s.profile, programme: s.prog('three', 5, 30), channel: s.chan('three') }).recording;
  await s.at(T + 4 * MIN);
  assert.ok(!s.sched.active.has(a.id));
  assert.ok(s.made[0].aborted, 'its recorder was thrown away');
  assert.equal(s.recordings.get(later.id).status, 'recording', 'later recordings still start');
  assert.equal(s.recordings.get(b.id).status, 'recording');
});

test('Stop doesn\'t wait for the library scan', async () => {
  const s = setup();
  s.scanner.enqueue = () => new Promise(() => {}); // a long scan of another library is running
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T + MIN);
  const res = await Promise.race([s.sched.cancel(recording.id).then(() => 'returned'), new Promise((r) => setTimeout(() => r('hung'), 1000))]);
  assert.equal(res, 'returned');
  assert.equal(s.recordings.get(recording.id).status, 'done');
});

test('two recordings with the same file name finishing together get different files', async () => {
  const s = setup({ max: 2 });
  const a = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30, 'News'), channel: s.chan('one') }).recording;
  const b = s.sched.schedule({ profile: s.profile, programme: s.prog('two', 0, 30, 'News'), channel: s.chan('two') }).recording;
  await s.at(T - MIN);
  s.made.forEach((r) => {
    const finish = r.finish.bind(r);
    r.finish = async (out) => (await new Promise((x) => setTimeout(x, 20)), finish(out));
  });
  await s.at(T + 33 * MIN);
  await s.sched.settled();
  const [pa, pb] = [s.recordings.get(a.id).path, s.recordings.get(b.id).path];
  assert.ok(pa && pb && pa !== pb, `${pa} vs ${pb}`);
});

// ---- series rules (Task 4) ----
async function guide(s, entries) {
  // entries: [key, startMin, lenMin, title, extra]
  await s.store.replaceProgrammes(SRC, entries.map(([key, startMin, lenMin, title, extra = {}]) => ({ guideId: key, start: T + startMin * MIN, end: T + (startMin + lenMin) * MIN, title, ...extra })), { from: T - 60 * MIN, to: T + 8 * 24 * 60 * MIN });
}
const rule = (s, o = {}) => s.recordings.addRule({ profileId: 1, source: SRC, channelKey: 'one', title: 'Show', newOnly: true, keep: 0, ...o });

test('a series rule schedules its programmes after a guide refresh, once', async () => {
  const s = setup({ t0: T });
  rule(s);
  await guide(s, [['one', 60, 30, 'Show'], ['one', 24 * 60, 30, ' show '], ['one', 8 * 24 * 60, 30, 'Show'], ['one', 120, 30, 'Other'], ['two', 180, 30, 'Show']]);
  s.sched.afterRefresh(SRC);
  const got = s.recordings.list({ status: 'scheduled' });
  assert.deepEqual(got.map((r) => [r.channelKey, (r.start - T) / MIN]), [['one', 60], ['one', 24 * 60]], 'this channel, the next 7 days, title matched loosely');
  assert.ok(got.every((r) => r.ruleId));
  s.sched.afterRefresh(SRC);
  assert.equal(s.recordings.list({ status: 'scheduled' }).length, 2, 'not twice');
});

test('any-channel rules match every channel of the source (not radio or encrypted ones)', async () => {
  const s = setup({ t0: T });
  s.store.replaceChannels(SRC, [...['one', 'two', 'three'].map((k) => ({ key: k, name: k.toUpperCase(), number: null, group: ['News'], radio: false, guideId: k })), { key: 'fm', name: 'FM', number: null, group: [], radio: true, guideId: 'fm' }, { key: 'enc', name: 'Enc', number: null, group: [], radio: false, guideId: 'enc', drm: 'widevine' }]);
  rule(s, { channelKey: null });
  await guide(s, [['one', 60, 30, 'Show'], ['two', 180, 30, 'Show'], ['fm', 60, 30, 'Show'], ['enc', 60, 30, 'Show']]);
  s.sched.afterRefresh(SRC);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => r.channelKey).sort(), ['one', 'two']);
});

test('new episodes only skips repeats', async () => {
  const s = setup({ t0: T });
  rule(s, { newOnly: true });
  const other = rule(s, { title: 'Quiz', newOnly: false });
  await guide(s, [['one', 60, 30, 'Show', { repeat: true }], ['one', 120, 30, 'Show'], ['one', 180, 30, 'Quiz', { repeat: true }]]);
  s.sched.afterRefresh(SRC);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => [(r.start - T) / MIN, r.title]), [[120, 'Show'], [180, 'Quiz']]);
  assert.equal(s.recordings.list().find((r) => r.title === 'Quiz').ruleId, other);
});

test('two rules matching one programme schedule it once; a refreshed programme with a new id isn\'t scheduled again', async () => {
  const s = setup({ t0: T });
  rule(s, { channelKey: 'one' });
  rule(s, { channelKey: null });
  await guide(s, [['one', 60, 30, 'Show', { episode: 'S1 E1' }]]);
  s.sched.afterRefresh(SRC);
  assert.equal(s.recordings.list().length, 1);
  await guide(s, [['one', 60, 30, 'Show', { episode: 'S1 E1' }]]); // new programme ids
  s.sched.afterRefresh(SRC);
  assert.equal(s.recordings.list().length, 1);
  // The same episode shown again later in the week isn't recorded twice by the rule.
  await guide(s, [['one', 60, 30, 'Show', { episode: 'S1 E1' }], ['one', 3 * 24 * 60, 30, 'Show', { episode: 'S1 E1' }]]);
  s.sched.afterRefresh(SRC);
  assert.equal(s.recordings.list().length, 1);
  // A cancelled airing stays cancelled.
  s.recordings.update(s.recordings.list()[0].id, { status: 'cancelled' });
  s.sched.afterRefresh(SRC);
  assert.equal(s.recordings.list().length, 1);
});

test('keep 5 deletes the oldest finished recordings of the rule', async () => {
  const s = setup({ t0: T });
  const id = rule(s, { keep: 5 });
  const lib = s.db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Recordings', 'tv', ?, '{}', 0)", JSON.stringify([s.dir])).lastInsertRowid;
  const files = [];
  for (let i = 0; i < 6; i++) {
    const file = path.join(s.dir, 'Show', `Show - S01E0${i + 1}.mkv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(file.replace(/\.mkv$/, '.nfo'), 'x');
    const item = s.db.run("INSERT INTO items (library_id, kind, title, path, added_at, updated_at) VALUES (?, 'episode', ?, ?, 0, 0)", lib, `E${i + 1}`, file).lastInsertRowid;
    s.recordings.add({ profileId: 1, source: SRC, channelKey: 'one', title: 'Show', season: 1, episode: i + 1, start: T - (10 - i) * 24 * 60 * MIN, end: T - (10 - i) * 24 * 60 * MIN + 30 * MIN, status: i < 5 ? 'done' : 'scheduled', path: i < 5 ? file : null, itemId: i < 5 ? Number(item) : null, ruleId: id });
    files.push(file);
  }
  // The sixth finishes.
  const sixth = s.recordings.list({ status: 'scheduled' })[0];
  s.recordings.update(sixth.id, { status: 'done', path: files[5] });
  await s.sched.afterFinish(s.recordings.get(sixth.id));
  assert.equal(s.recordings.list({ status: 'done' }).length, 5);
  assert.ok(!fs.existsSync(files[0]) && !fs.existsSync(files[0].replace(/\.mkv$/, '.nfo')), 'the oldest file and .nfo are gone');
  assert.ok(fs.existsSync(files[1]));
  assert.equal(s.db.get("SELECT COUNT(*) AS n FROM items WHERE kind = 'episode'").n, 5, 'its item too');
});

// ---- end to end, real ffmpeg ----
const skip = !hasFfmpeg && 'ffmpeg not installed';
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
let nf;
let provider;
before(async () => {
  if (!hasFfmpeg) return;
  provider = await endlessProvider();
  process.env.LIVE_TEST_BASE = provider.url;
  process.env.LIVE_TEST_ONE_URL = `${provider.url}/live/1.ts`;
});
after(async () => {
  delete process.env.LIVE_TEST_ONE_URL;
  await nf?.app.stop();
  await provider?.close();
});

test('end to end (real ffmpeg): a 15-s recording lands in the Recordings library as an episode', { skip, timeout: 120_000 }, async () => {
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  const admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/live/sources/live-test%2Fcanned/refresh', {});
  const core = nf.app.core;
  core.settings.set({ recordPre: 0, recordPost: 0 });
  const channel = core.live.store.channels({ sources: ['live-test/canned'] }).find((c) => c.key === 'one');
  const start = Date.now() + 2000;
  const programme = { id: null, channelId: channel.id, start, end: start + 15_000, title: 'Test Show', subtitle: 'First', description: 'A test.', episode: 'S1 E1', repeat: false };
  const profile = core.db.get('SELECT * FROM profiles LIMIT 1');
  const { recording } = core.live.scheduler.schedule({ profile: { id: profile.id, name: profile.name }, programme, channel });
  const end = Date.now() + 60_000;
  while (Date.now() < end && core.live.recordings.get(recording.id).status !== 'done' && core.live.recordings.get(recording.id).status !== 'failed') {
    await core.live.scheduler.tick();
    await new Promise((r) => setTimeout(r, 1000));
  }
  await core.live.scheduler.settled();
  const r = core.live.recordings.get(recording.id);
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.ok(fs.existsSync(r.path));
  assert.ok(fs.existsSync(r.path.replace(/\.mkv$/, '.nfo')));
  const lib = core.db.get("SELECT * FROM libraries WHERE name = 'Recordings'");
  assert.ok(lib);
  const items = core.db.all("SELECT * FROM items WHERE library_id = ? AND kind = 'episode'", lib.id);
  assert.equal(items.length, 1);
  assert.equal(r.itemId, items[0].id);
  assert.equal(core.live.tuners.get('live-test/canned\u0000one')?.holders.size ?? 0, 0);
});

// ---- v0.21 tidy-up ----
test('retune takes a slot each try and lets it go again', async () => {
  const s = setup({ max: 1 });
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 60), channel: s.chan('one') });
  await s.at(T - MIN);
  let slots = 0;
  let released = 0;
  const take = s.streams.takeSlotFor.bind(s.streams);
  s.streams.takeSlotFor = (...a) => {
    slots++;
    const slot = take(...a);
    return slot.ok ? { ...slot, release: () => (released++, slot.release()) } : slot;
  };
  s.pool.end(`${SRC}\u0000one`, 'This channel stopped sending video.');
  s.streams.tuneForRecording = async () => {
    throw new Error("This channel isn't answering right now");
  };
  for (const m of [1, 2, 3, 4, 5]) await s.at(T + m * MIN);
  assert.ok(slots >= 3, `tried ${slots} times`);
  assert.equal(released, slots, 'each let go');
  assert.equal(s.recordings.get(recording.id).status, 'recording', 'it keeps trying until its end');
});

test('a viewer start in progress makes a recording wait, not fail', async () => {
  const s = setup({ max: 1 });
  const release = s.streams.hold(SRC); // a viewer's start, between its slot check and its stream
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T + MIN); // already on: no waiting for a recording to end
  assert.equal(s.recordings.get(recording.id).status, 'scheduled', 'tried again next tick');
  release();
  await s.at(T + MIN + 15_000);
  assert.equal(s.recordings.get(recording.id).status, 'recording');
});

test('stop waits for joins in flight (at most its limit)', async () => {
  const s = setup();
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  const slow = (ms) => (s.made.at(-1).finish = async (out) => { await new Promise((r) => setTimeout(r, ms)); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, 'mkv'); return { file: out, gapSeconds: 0 }; });
  slow(600);
  await s.at(T + 33 * MIN);
  const t0 = Date.now();
  await s.sched.stop();
  assert.ok(Date.now() - t0 >= 500, 'waited for the join');
  assert.equal(s.recordings.get(recording.id).status, 'done');
  const s2 = setup();
  s2.sched.schedule({ profile: s2.profile, programme: s2.prog('one', 0, 30), channel: s2.chan('one') });
  await s2.at(T - MIN);
  s2.made.at(-1).finish = () => new Promise(() => {});
  await s2.at(T + 33 * MIN);
  const t1 = Date.now();
  await s2.sched.stop({ waitMs: 300 });
  assert.ok(Date.now() - t1 < 1000, 'not forever');
});

test('the work folder stays with its recording when the recordings folder changes', async () => {
  const used = [];
  const s = setup({ finishLeftover: async (work, out) => (used.push(work), fs.mkdirSync(path.dirname(out), { recursive: true }), fs.writeFileSync(out, 'mkv'), { file: out, gapSeconds: 0 }) });
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  const first = s.recordings.get(recording.id).workDir;
  assert.equal(first, path.join(s.dir, '.work', String(recording.id)));
  s.settings.recordingsDir = tempDir(); // the folder changed (or Atomix restarted with another one)
  s.sched.active.clear();
  await s.sched.finishRec(s.recordings.get(recording.id));
  await s.sched.settled();
  assert.deepEqual(used, [first]);
});

test('a rule edit cancels airings that no longer match', async () => {
  const s = setup({ t0: T });
  const id = rule(s, { channelKey: 'one', newOnly: false });
  await guide(s, [['one', 60, 30, 'Show'], ['one', 120, 30, 'Show', { repeat: true }], ['two', 180, 30, 'Show']]);
  s.sched.afterRefresh(SRC);
  assert.equal(s.recordings.list({ status: 'scheduled' }).length, 2);
  s.recordings.updateRule(id, { newOnly: true });
  s.sched.ruleChanged(id);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => (r.start - T) / MIN), [60], 'the repeat is cancelled');
  s.recordings.updateRule(id, { channelKey: 'two' });
  s.sched.ruleChanged(id);
  s.sched.afterRefresh(SRC);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => r.channelKey), ['two'], 'the old channel\'s airings are cancelled');
});

test('clashes are counted once per tuner (two recordings on one channel are one stream)', () => {
  const s = setup({ max: 1 });
  s.sched.schedule({ profile: s.profile, programme: s.prog('two', 0, 30, 'A'), channel: s.chan('two') });
  s.sched.schedule({ profile: s.profile, programme: s.prog('two', 10, 30, 'B'), channel: s.chan('two') });
  const { clash } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30, 'C'), channel: s.chan('one') });
  assert.equal(clash, 'Your provider allows 1 stream at a time — this overlaps 1 other recording');
});

test('a failed join can be tried again; Remove takes its work folder too', async () => {
  let fails = true;
  const s = setup({ finishLeftover: async (work, out) => {
    if (fails) throw new Error('join failed');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'mkv');
    return { file: out, gapSeconds: 0 };
  } });
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  const work = s.recordings.get(recording.id).workDir;
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'piece'), 'x');
  s.sched.active.clear();
  await s.sched.finishRec(s.recordings.get(recording.id));
  await s.sched.settled();
  assert.equal(s.recordings.get(recording.id).status, 'failed');
  assert.equal(s.sched.canRetry(s.recordings.get(recording.id)), true);
  fails = false;
  await s.sched.retryJoin(recording.id);
  await s.sched.settled();
  assert.equal(s.recordings.get(recording.id).status, 'done');
  // Another that fails and is removed: its work folder goes with it.
  fails = true;
  const other = s.sched.schedule({ profile: s.profile, programme: s.prog('two', 0, 30), channel: s.chan('two') }).recording;
  s.recordings.update(other.id, { status: 'failed', workDir: path.join(s.dir, '.work', String(other.id)) });
  fs.mkdirSync(s.recordings.get(other.id).workDir, { recursive: true });
  s.sched.removeRecording(s.recordings.get(other.id));
  assert.ok(!fs.existsSync(path.join(s.dir, '.work', String(other.id))));
});

// ---- v0.21 Plan C review fixes ----
test('moving a rule to another channel records the episodes there (the dropped airings don\'t block them)', async () => {
  const s = setup({ t0: T });
  const id = rule(s, { channelKey: 'one', newOnly: false });
  await guide(s, [['one', 60, 30, 'Show', { episode: '0.4.0/1' }], ['two', 90, 30, 'Show', { episode: '0.4.0/1' }]]);
  s.sched.afterRefresh(SRC);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => r.channelKey), ['one']);
  s.recordings.updateRule(id, { channelKey: 'two' });
  s.sched.ruleChanged(id);
  s.sched.afterRefresh(SRC);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => r.channelKey), ['two']);
  s.recordings.updateRule(id, { channelKey: 'one' });
  s.sched.ruleChanged(id);
  s.sched.afterRefresh(SRC);
  assert.deepEqual(s.recordings.list({ status: 'scheduled' }).map((r) => r.channelKey), ['one'], 'and back again');
});

test('a provider out for a minute doesn\'t end a long recording (retune keeps trying until its end)', async () => {
  const s = setup({ max: 1 });
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 120), channel: s.chan('one') });
  await s.at(T - MIN);
  s.pool.end(`${SRC}\u0000one`, 'This channel stopped sending video.');
  const real = s.streams.tuneForRecording.bind(s.streams);
  let down = true;
  s.streams.tuneForRecording = async (...a) => {
    if (down) throw new Error("This channel isn't answering right now");
    return real(...a);
  };
  for (let m = 1; m <= 8; m++) await s.at(T + m * MIN);
  assert.equal(s.recordings.get(recording.id).status, 'recording', 'still recording after 8 minutes of outage');
  down = false;
  await s.at(T + 20 * MIN);
  assert.equal(s.recordings.get(recording.id).status, 'recording');
  assert.ok(s.made[0].opts.tuner && !s.made[0].opts.tuner.closed, 'a fresh tuner attached');
});

test('a retune that gets nowhere by the programme\'s end saves what it got, with the reason', async () => {
  const s = setup({ max: 1 });
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 10), channel: s.chan('one') });
  await s.at(T - MIN);
  s.pool.end(`${SRC}\u0000one`, 'This channel stopped sending video.');
  s.streams.tuneForRecording = async () => {
    throw new Error("This channel isn't answering right now");
  };
  for (let m = 1; m <= 14; m++) await s.at(T + m * MIN);
  await s.sched.settled();
  assert.equal(s.recordings.get(recording.id).status, 'done');
  assert.equal(s.recordings.get(recording.id).error, "This channel isn't answering right now");
});

test('a recording\'s tuner asks for a fresh, network-only address on restart', async () => {
  const s = setup({ max: 1 });
  let n = 0;
  const src = s.sched.plugins.getLiveSource(SRC);
  src.stream = async (key) => (++n === 1 ? { url: `http://provider.example/${key}.ts`, headers: {} } : { url: '/etc/passwd', headers: {} });
  s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  const spec = s.pool.specs.at(-1);
  assert.equal(typeof spec.resolve, 'function', 'the recording\'s tuner can re-ask the source');
  assert.equal(await spec.resolve(), null, 'a local path is never handed to ffmpeg');
});

test('the server waits longer for its shutdown than the recordings wait for their joins', async () => {
  const { STOP_GRACE_MS } = await import('../src/app.js');
  const { JOIN_WAIT_MS } = await import('../src/live/scheduler.js');
  assert.ok(STOP_GRACE_MS >= JOIN_WAIT_MS + 3000, `${STOP_GRACE_MS} vs ${JOIN_WAIT_MS}`);
});

test('a tick in flight at shutdown starts no recorder (v0.22)', async () => {
  const s = setup();
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  let release;
  const real = s.streams.tuneForRecording.bind(s.streams);
  s.streams.tuneForRecording = async (...a) => {
    await new Promise((r) => (release = r));
    return real(...a);
  };
  const ticking = s.at(T - MIN);
  while (!release) await new Promise((r) => setImmediate(r));
  const stopped = s.sched.stop({ waitMs: 2000 });
  release();
  await stopped;
  await ticking;
  assert.equal(s.made.length, 0, 'no recorder made after stop');
  const tuner = s.pool.get(`${SRC}\u0000one`);
  assert.ok(!tuner || !tuner.holders.has(`rec:${recording.id}`), 'the tuner hold let go');
  assert.equal(s.sched.active.size, 0);
});

test('a retune that answers after shutdown lets its tuner go (v0.22)', async () => {
  const s = setup();
  const { recording } = s.sched.schedule({ profile: s.profile, programme: s.prog('one', 0, 30), channel: s.chan('one') });
  await s.at(T - MIN);
  const a = s.sched.active.get(recording.id);
  a.tuner.closed = true; // the provider kept dropping: the next tick retunes
  let release;
  const real = s.streams.tuneForRecording.bind(s.streams);
  s.streams.tuneForRecording = async (...args) => {
    await new Promise((r) => (release = r));
    return real(...args);
  };
  const ticking = s.at(T + MIN);
  while (!release) await new Promise((r) => setImmediate(r));
  const stopped = s.sched.stop({ waitMs: 2000 });
  release();
  await stopped;
  await ticking;
  const tuner = s.pool.get(`${SRC}\u0000one`);
  assert.ok(!tuner || !tuner.holders.has(a.holderId), 'no hold kept after stop');
});
