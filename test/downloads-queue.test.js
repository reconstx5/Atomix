// The download queue (v0.21): one copy per title, quality and format; one at a time at low priority; waits while a
// converted video plays; keeps its folder within its limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, makeAudio } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { probe } from '../src/library/probe.js';
import { DownloadQueue } from '../src/downloads/queue.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const dir = tempDir();
let db;
let n = 0;
const settings = { get: (k) => ({ downloadsDir: '', downloadsCacheGb: 50 })[k] };
async function addItem(file, kind = 'movie') {
  const id = ++n;
  const media = await probe('ffprobe', file);
  db.run('INSERT INTO items (id, library_id, kind, title, path, media, duration, added_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, 1, 1)', id, kind, `T${id}`, file, JSON.stringify(media), media.duration);
  return db.get('SELECT * FROM items WHERE id = ?', id);
}
const make = (o = {}) => new DownloadQueue({ db, config: { ffmpegPath: 'ffmpeg', downloadsDir: path.join(dir, 'dl') }, settings, pollMs: 50, ...o });
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};
let big;
let small;
let song;
before(async () => {
  if (!hasFfmpeg) return;
  db = openDatabase(path.join(dir, 'q.db'));
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'M', 'movies', '[]', '{}', 1)");
  const bigFile = path.join(dir, 'big.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=12:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', bigFile]);
  big = await addItem(bigFile);
  makeVideo(path.join(dir, 'small.mp4'), { seconds: 2 });
  small = await addItem(path.join(dir, 'small.mp4'));
  makeAudio(path.join(dir, 'song.flac'), { seconds: 2, codec: 'flac' });
  song = await addItem(path.join(dir, 'song.flac'), 'track');
});
after(() => db?.close());

test('one job per title, quality and format', { skip }, async () => {
  let spawns = 0;
  const q = make({ onSpawn: () => spawns++ });
  q.start();
  const a = q.request(big, { quality: '720', format: 'mp4' });
  const b = q.request(big, { quality: '720', format: 'mp4' });
  assert.equal(a.id, b.id);
  await until(() => q.get(a.id).status === 'ready');
  const job = q.get(a.id);
  assert.equal(job.progress, 1);
  const file = q.fileFor(a.id);
  assert.equal(fs.statSync(file).size, job.size);
  const out = await probe('ffprobe', file);
  assert.equal(out.video.codec, 'h264');
  assert.equal(out.video.height, 720);
  assert.equal(out.audio[0].codec, 'aac');
  assert.equal(spawns, 1);
  assert.equal(q.request(big, { quality: '720', format: 'mp4' }).status, 'ready', 'asked again later: the ready copy');
  await q.stop();
});

test('jobs run one at a time, and wait while a converted video plays', { skip }, async () => {
  let busy = true;
  const q = make({ busy: () => busy });
  q.start();
  const a = q.request(small, { quality: '480', format: 'webm' });
  const b = q.request(song, { quality: '720', format: 'audio' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(q.get(a.id).status, 'queued', 'waits while busy');
  assert.equal(q.preparingCount(), 2);
  busy = false;
  await until(() => q.get(a.id).status !== 'queued');
  assert.equal(q.get(b.id).status, 'queued', 'the second waits for the first');
  await until(() => q.get(b.id).status === 'ready');
  assert.equal((await probe('ffprobe', q.fileFor(a.id))).video.codec, 'vp9');
  assert.equal((await probe('ffprobe', q.fileFor(b.id))).audio[0].codec, 'aac');
  assert.equal(q.preparingCount(), 0);
  await q.stop();
});

test('a copy plan copies the file as it is', { skip }, async () => {
  const q = make();
  q.start();
  const a = q.request(small, { quality: '720', format: 'mp4' });
  await until(() => q.get(a.id).status === 'ready');
  assert.equal(q.get(a.id).file.endsWith('.mp4'), true);
  const out = await probe('ffprobe', q.fileFor(a.id));
  assert.equal(out.video.height, 90, 'small enough already: not scaled');
  await q.stop();
});

test("a song for a browser with no AAC ('webm') becomes Opus in WebM, a separate copy from the AAC one", { skip }, async () => {
  const q = make();
  q.start();
  const w = q.request(song, { quality: 'audio', format: 'webm' });
  const a = q.request(song, { quality: 'audio', format: 'audio' });
  assert.notEqual(w.id, a.id);
  await until(() => q.get(w.id).status === 'ready' && q.get(a.id).status === 'ready');
  assert.equal(q.get(w.id).file.endsWith('.webm'), true);
  assert.equal((await probe('ffprobe', q.fileFor(w.id))).audio[0].codec, 'opus');
  assert.equal(q.get(a.id).file.endsWith('.m4a'), true);
  await q.stop();
});

test('a failed job says why and can be asked again', { skip }, async () => {
  const gone = path.join(dir, 'gone.mp4');
  makeVideo(gone, { seconds: 1 });
  const item = await addItem(gone);
  fs.rmSync(gone);
  const q = make();
  q.start();
  const a = q.request(item, { quality: '720', format: 'mp4' });
  await until(() => q.get(a.id).status === 'failed');
  assert.equal(q.get(a.id).error, 'The file is missing on the server — try rescanning the library.');
  assert.equal(fs.readdirSync(path.join(dir, 'dl')).filter((f) => f.endsWith('.part')).length, 0);
  assert.equal(q.fileFor(a.id), null);
  assert.equal(q.request(item, { quality: '720', format: 'mp4' }).status, 'queued');
  await q.stop();
});

test('the cache keeps under its size, oldest first, and drops what nobody used for 7 days', { skip }, async () => {
  const q = make({ cacheBytes: 1 });
  const ready = db.all("SELECT * FROM download_jobs WHERE status = 'ready' ORDER BY id");
  assert.ok(ready.length >= 3);
  const now = Date.now();
  db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now - 3 * 3600_000, ready[0].id);
  db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now - 2 * 3600_000, ready[1].id);
  db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now - 10_000, ready[2].id);
  q.cleanup(now);
  assert.equal(q.get(ready[0].id), null, 'the oldest goes');
  assert.ok(q.get(ready[2].id), 'one used in the last minute stays');
  assert.ok(!fs.existsSync(path.join(dir, 'dl', ready[0].file)));
  const big2 = make();
  big2.cleanup(now + 8 * 86400_000);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM download_jobs WHERE status = 'ready'").n, 0, 'unused 7 days: gone');
});

// ---- Review fixes (Plan A) ----
test('an ffmpeg that cannot start fails the job, not the server', { skip }, async () => {
  const q = make({ ffmpegPath: '/nonexistent/ffmpeg-missing' });
  q.start();
  const a = q.request(small, { quality: '480', format: 'mp4' });
  await until(() => q.get(a.id).status === 'failed');
  assert.equal(q.get(a.id).error, "Couldn't prepare this download. Try again later.");
  await q.stop();
  const off = make({ tools: () => ({ ffmpeg: { available: false } }) });
  off.start();
  const b = off.request(big, { quality: '480', format: 'mp4' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(off.get(b.id).status, 'queued', 'no ffmpeg on this server: it waits');
  await off.stop();
});

test('a bad folder does not stop the start, and only the queue\'s own half files are removed', { skip }, async () => {
  const file = path.join(dir, 'not-a-folder');
  fs.writeFileSync(file, 'x');
  const q = new DownloadQueue({ db, config: { ffmpegPath: 'ffmpeg', downloadsDir: path.join(file, 'dl') }, settings, pollMs: 50 });
  assert.doesNotThrow(() => q.start());
  await q.stop();
  const own = path.join(dir, 'dl', '99-720.mp4.part');
  const other = path.join(dir, 'dl', 'firefox-download.part');
  fs.writeFileSync(own, 'x');
  fs.writeFileSync(other, 'x');
  const q2 = make();
  q2.start();
  await q2.stop();
  assert.ok(!fs.existsSync(own));
  assert.ok(fs.existsSync(other), "another app's .part stays");
});

test('job ids are never reused', { skip }, async () => {
  const q = make();
  const a = q.request(song, { quality: 'x1', format: 'audio' });
  db.run('DELETE FROM download_jobs WHERE id = ?', a.id);
  const b = q.request(song, { quality: 'x2', format: 'audio' });
  assert.ok(b.id > a.id, `${b.id} > ${a.id}`);
  db.run("DELETE FROM download_jobs WHERE quality IN ('x1', 'x2')");
});

test('ready copies nobody has fetched yet are kept, and the queue waits while they fill the folder', { skip }, async () => {
  db.run('DELETE FROM download_jobs');
  const q = make({ cacheBytes: 1 });
  q.start();
  const a = q.request(small, { quality: '720', format: 'mp4' });
  await until(() => q.get(a.id).status === 'ready');
  const now = Date.now();
  db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now - 3 * 3600_000, a.id);
  q.cleanup(now);
  assert.ok(q.get(a.id), 'never fetched: kept (within a day)');
  const b = q.request(big, { quality: '480', format: 'mp4' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(q.get(b.id).status, 'queued', 'the folder is full of copies still to fetch: wait');
  q.fileFor(a.id); // fetched now
  db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now - 3 * 3600_000, a.id);
  q.cleanup(now);
  assert.equal(q.get(a.id), null, 'fetched and not used for hours: it may go');
  q.kick();
  await until(() => q.get(b.id).status !== 'queued');
  await q.stop();
});

test('a copy fetched in the last 10 minutes is kept', { skip }, async () => {
  db.run('DELETE FROM download_jobs');
  const q = make({ cacheBytes: 1 });
  q.start();
  const a = q.request(small, { quality: '720', format: 'mp4' });
  await until(() => q.get(a.id).status === 'ready');
  q.fileFor(a.id);
  const now = Date.now();
  db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now - 5 * 60_000, a.id);
  q.cleanup(now);
  assert.ok(q.get(a.id));
  await q.stop();
});

test('a running job stops when someone starts watching a converted video', { skip }, async () => {
  db.run('DELETE FROM download_jobs');
  let busy = false;
  const q = make({ busy: () => busy });
  q.start();
  const a = q.request(big, { quality: '1080', format: 'webm' });
  await until(() => q.get(a.id).status === 'preparing');
  busy = true;
  q.interruptIfBusy();
  await until(() => q.get(a.id).status === 'queued');
  assert.equal(fs.readdirSync(path.join(dir, 'dl')).filter((f) => f.startsWith(`${a.id}-`)).length, 0, 'its half file is gone');
  await q.stop();
});
