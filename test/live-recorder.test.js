// The recorder (src/live/recorder.js): file names, the .nfo, and copying a tuner's pieces for a time window into one
// .mkv without converting. Real ffmpeg against the endless provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir, hasFfmpeg } from './helpers.js';
import { endlessProvider } from './helpers-live.js';
import { TunerPool } from '../src/live/tuner.js';
import { safeName, recordingPath, nfoFor, Recorder, DirectRecorder, finishLeftover } from '../src/live/recorder.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const MEDIA = { video: { codec: 'h264' }, audio: [{ codec: 'aac' }] };
let provider;
let pool;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', file]).toString());

before(async () => {
  if (!hasFfmpeg) return;
  provider = await endlessProvider();
  pool = new TunerPool({ config: { ffmpegPath: 'ffmpeg', timeshiftDir: tempDir() }, log: { warn() {}, info() {}, debug() {} } });
});
after(async () => {
  pool?.close();
  await provider?.close();
});

test('safeName and recordingPath: Windows-safe names, episode or date forms, part 2', () => {
  assert.equal(safeName('What? <Now>: Live|'), 'What Now Live');
  assert.equal(safeName('  A/B\\C*"D"...  '), 'ABCD');
  assert.equal(safeName('???'), 'Untitled');
  assert.equal(safeName('CON'), 'CON_');
  // v0.21: never a hidden folder, never a trailing dot or space after the cut either
  assert.equal(safeName('.hack//Sign'), 'hackSign');
  assert.equal(safeName('...'), 'Untitled');
  const cut = safeName(`${'a'.repeat(118)}. b`);
  assert.ok(!/^[. ]|[. ]$/.test(cut), cut);
  const dir = path.join('/r');
  assert.equal(recordingPath({ recordingsDir: dir, title: 'Show', season: 1, episode: 2, episodeTitle: 'Pilot: Part 1', start: 0 }), path.join(dir, 'Show', 'Show - S01E02 - Pilot Part 1.mkv'));
  assert.equal(recordingPath({ recordingsDir: dir, title: 'Show', season: 12, episode: 80, episodeTitle: null, start: 0 }), path.join(dir, 'Show', 'Show - S12E80.mkv'));
  const start = new Date(2026, 9, 11, 20, 30).getTime(); // local time
  assert.equal(recordingPath({ recordingsDir: dir, title: 'News', season: null, episode: 3, episodeTitle: 'x', start }), path.join(dir, 'News', 'News - 2026-10-11 20-30.mkv'));
  assert.equal(recordingPath({ recordingsDir: dir, title: 'News', start, part: 2 }), path.join(dir, 'News', 'News - 2026-10-11 20-30 (part 2).mkv'));
});

test('nfoFor writes an episodedetails with the guide\'s fields', () => {
  const start = new Date(2026, 9, 11, 20, 30).getTime();
  const nfo = nfoFor({ title: 'Show & Co', episodeTitle: 'The <End>', season: 1, episode: 2, plot: 'It ends.', start }, 'TVNZ 1');
  assert.match(nfo, /^<\?xml version="1.0" encoding="UTF-8"/);
  assert.match(nfo, /<episodedetails>/);
  assert.match(nfo, /<title>The &lt;End&gt;<\/title>/);
  assert.match(nfo, /<showtitle>Show &amp; Co<\/showtitle>/);
  assert.match(nfo, /<season>1<\/season>/);
  assert.match(nfo, /<episode>2<\/episode>/);
  assert.match(nfo, /<plot>It ends.<\/plot>/);
  assert.match(nfo, /<aired>2026-10-11<\/aired>/);
  assert.match(nfo, /<studio>TVNZ 1<\/studio>/);
  const bare = nfoFor({ title: 'News', start }, 'One');
  assert.match(bare, /<title>News 2026-10-11 20:30<\/title>/);
  assert.ok(!bare.includes('<season>'));
});

test('a recording copies the buffer\'s pieces for its window and joins them into a playable mkv', { skip }, async () => {
  const chan = { key: 'src\u0000r1', url: `${provider.url}/live/1.ts`, headers: {}, media: MEDIA, label: 'One' };
  const tuner = await pool.acquire(chan, { id: 'viewer', kind: 'viewer' });
  await wait(9000); // a few pieces in the buffer
  const now = Date.now();
  const workDir = path.join(tempDir(), 'work');
  const rec = new Recorder({ tuner, from: now - 6000, to: now + 8000, workDir, ffmpegPath: 'ffmpeg' });
  rec.start();
  await rec.idle();
  assert.ok(fs.readdirSync(workDir).length >= 1, 'pieces already in the buffer were copied');
  await wait(Math.max(0, now + 8000 - Date.now()) + 5000); // the piece holding the end has been written
  const out = path.join(tempDir(), 'Show', 'Show - S01E01.mkv');
  const res = await rec.finish(out);
  assert.equal(res.file, out);
  assert.equal(res.gapSeconds, 0);
  const info = probe(out);
  const dur = Number(info.format.duration);
  assert.ok(Math.abs(dur - 14) <= 5, `duration ${dur}`);
  assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
  assert.ok(!fs.existsSync(workDir), 'the work folder is gone');
  pool.release('viewer');
});

test('a drop inside the window: the mkv spans both runs and the gap is counted', { skip }, async () => {
  const chan = { key: 'src\u0000r2', url: `${provider.url}/live/2.ts`, headers: {}, media: MEDIA, label: 'Two' };
  const tuner = await pool.acquire(chan, { id: 'rec2', kind: 'recording' });
  const from = Date.now();
  const to = from + 30000;
  const rec = new Recorder({ tuner, from, to, workDir: path.join(tempDir(), 'w2'), ffmpegPath: 'ffmpeg' });
  rec.start();
  await wait(5000);
  await fetch(`${provider.url}/__drop`);
  await wait(Math.max(0, to - Date.now()) + 5000);
  assert.ok(tuner.runs.length >= 2, 'the tuner restarted');
  const out = path.join(tempDir(), 'drop.mkv');
  const res = await rec.finish(out);
  assert.ok(res.gapSeconds > 0, `gap ${res.gapSeconds}`);
  const dur = Number(probe(out).format.duration);
  assert.ok(dur > 12 && dur < 30 - res.gapSeconds + 6, `duration ${dur}, gap ${res.gapSeconds}`);
  pool.release('rec2');
});

test('a window with nothing in it fails to finish and leaves no file', { skip }, async () => {
  const chan = { key: 'src\u0000r3', url: `${provider.url}/live/3.ts`, headers: {}, media: MEDIA, label: 'Three' };
  const tuner = await pool.acquire(chan, { id: 'rec3', kind: 'recording' });
  const workDir = path.join(tempDir(), 'w3');
  const rec = new Recorder({ tuner, from: Date.now() + 3600_000, to: Date.now() + 7200_000, workDir, ffmpegPath: 'ffmpeg' });
  rec.start();
  await wait(1500);
  const out = path.join(tempDir(), 'none.mkv');
  await assert.rejects(rec.finish(out), (e) => e.empty === true);
  assert.ok(!fs.existsSync(out));
  assert.ok(!fs.existsSync(workDir));
  pool.release('rec3');
});

test('DirectRecorder records an unbuffered channel straight from the provider', { skip }, async () => {
  const workDir = path.join(tempDir(), 'direct');
  const rec = new DirectRecorder({ url: `${provider.url}/live/9.ts`, headers: {}, workDir, ffmpegPath: 'ffmpeg' });
  rec.start();
  await wait(8000);
  const out = path.join(tempDir(), 'direct.mkv');
  const res = await rec.finish(out);
  assert.equal(res.file, out);
  const dur = Number(probe(out).format.duration);
  assert.ok(dur > 4 && dur < 10, `duration ${dur}`);
  assert.ok(!fs.existsSync(workDir));
});

/** A stand-in ffmpeg that writes what the work folder holds, then fails (a full disk, a broken join). */
function failingFfmpeg(dir) {
  const script = path.join(dir, 'ffmpeg-fails.sh');
  fs.writeFileSync(script, `#!/bin/sh\nfind "$WORK" -type f > "$WORK.listing"\nexit 1\n`, { mode: 0o755 });
  return script;
}

test('a join that fails keeps the work folder (nothing lost) and leaves no half file; no full copy is made first', { skip }, async () => {
  const chan = { key: 'src\u0000r4', url: `${provider.url}/live/4.ts`, headers: {}, media: MEDIA, label: 'Four' };
  const tuner = await pool.acquire(chan, { id: 'rec4', kind: 'recording' });
  const base = tempDir();
  const workDir = path.join(base, 'w4');
  process.env.WORK = workDir;
  const rec = new Recorder({ tuner, from: Date.now(), to: Date.now() + 5000, workDir, ffmpegPath: failingFfmpeg(base) });
  rec.start();
  await wait(9000);
  const out = path.join(base, 'Show', 'fail.mkv');
  await assert.rejects(rec.finish(out));
  delete process.env.WORK;
  assert.ok(fs.existsSync(workDir), 'the pieces are still there');
  assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}.part`));
  const listing = fs.readFileSync(`${workDir}.listing`, 'utf8');
  assert.ok(!/part-\d+\.mp4/.test(listing), `no joined copy of the pieces before ffmpeg runs:\n${listing}`);
  // finishLeftover can still save it.
  const res = await finishLeftover(workDir, out, 'ffmpeg');
  assert.ok(fs.existsSync(res.file));
  assert.ok(!fs.existsSync(workDir));
  pool.release('rec4');
});

test('pieces already in the buffer are copied without blocking: start() returns first, idle() when copied', { skip }, async () => {
  const chan = { key: 'src\u0000r5', url: `${provider.url}/live/5.ts`, headers: {}, media: MEDIA, label: 'Five' };
  const tuner = await pool.acquire(chan, { id: 'v5', kind: 'viewer' });
  await wait(6000);
  const workDir = path.join(tempDir(), 'w5');
  const rec = new Recorder({ tuner, from: Date.now() - 5000, to: Date.now() + 1000, workDir, ffmpegPath: 'ffmpeg' });
  rec.start();
  const segs = () => (fs.existsSync(workDir) ? fs.readdirSync(workDir, { recursive: true }).filter((n) => String(n).endsWith('.m4s')).length : 0);
  assert.equal(segs(), 0, 'nothing copied yet: the copy runs after start() returns');
  await rec.idle();
  assert.ok(segs() >= 1);
  rec.abort();
  pool.release('v5');
});

test('DirectRecorder backs off when the provider keeps refusing: 2 s, 4 s, 8 s … at most 60 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rec = new DirectRecorder({ url: 'http://127.0.0.1:9/never.ts', headers: {}, workDir: path.join(tempDir(), 'd2'), ffmpegPath: 'false' });
  rec.start();
  const waitClose = async (n) => {
    const end = performance.now() + 5000; // the clock itself isn't mocked
    while (!(rec.retry && rec.files.length === n) && performance.now() < end) await new Promise((r) => setImmediate(r));
  };
  const delays = [];
  for (let n = 1; n <= 7; n++) {
    await waitClose(n);
    delays.push(rec.retryDelay);
    t.mock.timers.tick(rec.retryDelay);
  }
  rec.stopped = true;
  clearTimeout(rec.retry);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});
