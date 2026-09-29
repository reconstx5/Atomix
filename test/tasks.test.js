// The job runner: one job at a time, new titles first, pauses (and redoes the
// interrupted job) while a conversion plays, records failures, cleans up.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Settings } from '../src/settings.js';
import { ExtrasStore } from '../src/extras/store.js';
import { makeJobs } from '../src/extras/jobs.js';
import { TaskRunner } from '../src/tasks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function setup() {
  const db = openDatabase(path.join(tempDir(), 't.db'));
  const store = new ExtrasStore(db);
  const settings = new Settings(db);
  const t = Date.now();
  let seq = 0;
  const lib = (type) => Number(db.run('INSERT INTO libraries (name, type, paths, created_at) VALUES (?, ?, ?, ?)', type, type, '[]', t).lastInsertRowid);
  const add = (f) => {
    const all = { title: `item ${++seq}`, path: `/media/${seq}`, size: 1, mtime: 1, duration: 600, media: JSON.stringify({ video: { width: 640, height: 360 }, audio: [{ index: 0 }] }), ...f };
    const cols = Object.keys(all);
    return Number(db.run(`INSERT INTO items (${cols.join(', ')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`, ...Object.values(all), t, t).lastInsertRowid);
  };
  const row = (id) => db.get('SELECT * FROM items WHERE id = ?', id);
  return { db, store, settings, lib, add, row };
}
const withFfmpeg = () => ({ ffmpeg: { available: true }, filters: {} });
const done = (store, item) => store.saveJob(item, 'previews', { status: 'done', data: { sheets: 1 } });

test('one job at a time: new titles first, then intros, then the backlog oldest first', async () => {
  const { db, store, settings, lib, add, row } = setup();
  const movies = lib('movies');
  const m1 = add({ library_id: movies, kind: 'movie' });
  const m2 = add({ library_id: movies, kind: 'movie' });
  const tv = lib('tv');
  const show = add({ library_id: tv, kind: 'show', duration: null, media: null });
  const s1 = add({ library_id: tv, kind: 'season', parent_id: show, show_id: show, season: 1, duration: null, media: null });
  const e1 = add({ library_id: tv, kind: 'episode', parent_id: s1, show_id: show, season: 1, episode: 1 });

  const log = [];
  let active = 0;
  let most = 0;
  const jobs = {
    async previews(item) {
      log.push(`p${item.id}`);
      most = Math.max(most, ++active);
      await sleep(15);
      active--;
      done(store, item);
    },
    async intros(seasonId) {
      log.push(`i${seasonId}`);
      for (const ep of store.pendingIntroEpisodes(seasonId)) store.saveJob(ep, 'intros', { status: 'none' });
    },
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.prioritise(row(m2));
  runner.start();
  await until(() => log.length === 4 && !runner.current, 'four jobs');
  await runner.stop();
  assert.deepEqual(log, [`p${m2}`, `i${s1}`, `p${m1}`, `p${e1}`]);
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(runner.status().queued, { previews: 0, intros: 0 });
  db.close();
});

test('a conversion pauses the runner, and the interrupted job is redone', async () => {
  const { db, store, settings, lib, add, row } = setup();
  const movie = add({ library_id: lib('movies'), kind: 'movie', title: 'Big Film' });
  let busy = false;
  const calls = [];
  const exits = [];
  const jobs = {
    async previews(item, ctx) {
      calls.push(item.id);
      if (calls.length === 1) {
        // Stand-in for ffmpeg: a process that would run for 30 s.
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
        ctx.onSpawn(child);
        exits.push(await new Promise((r) => child.on('exit', (code, signal) => r(signal))));
        throw new Error('ffmpeg exited with null');
      }
      done(store, item);
    },
    async intros() {},
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => busy, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await until(() => runner.current?.proc, 'the job to start its process');
  assert.equal(runner.status().running.title, 'Big Film');
  busy = true;
  runner.interruptIfBusy();
  await until(() => exits.length === 1, 'the process to be killed');
  assert.deepEqual(exits, ['SIGKILL']);
  await until(() => runner.status().paused === 'converting', 'paused');
  assert.equal(store.job(movie, 'previews'), null, 'nothing recorded for the interrupted job');
  busy = false;
  runner.kick();
  await until(() => store.job(movie, 'previews')?.status === 'done', 'the redo');
  assert.deepEqual(calls, [movie, movie]);
  await runner.stop();
  db.close();
});

test('stopping the server stops the running job', async () => {
  const { db, store, settings, lib, add } = setup();
  const movie = add({ library_id: lib('movies'), kind: 'movie' });
  let child;
  const jobs = {
    async previews(item, ctx) {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
      ctx.onSpawn(child);
      await new Promise((r) => child.on('exit', r));
      throw new Error('killed');
    },
    async intros() {},
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await until(() => runner.current?.proc, 'the job to start');
  await runner.stop();
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(store.job(movie, 'previews'), null, 'redone next time the server starts');
  db.close();
});

test('failures are recorded once, and a job that records nothing does not loop', async () => {
  const { db, store, settings, lib, add } = setup();
  const movies = lib('movies');
  const broken = add({ library_id: movies, kind: 'movie', title: 'Broken' });
  const silent = add({ library_id: movies, kind: 'movie', title: 'Silent' });
  const calls = [];
  const jobs = {
    async previews(item) {
      calls.push(item.id);
      if (item.id === broken) throw new Error('moov atom not found');
    },
    async intros() {},
  };
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 30, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await until(() => store.job(silent, 'previews')?.status === 'failed', 'the silent job to be failed');
  await sleep(80);
  await runner.stop();
  assert.deepEqual(calls, [broken, silent], 'each ran once');
  assert.equal(store.job(broken, 'previews').error, 'moov atom not found');
  assert.match(store.job(silent, 'previews').error, /without recording a result/);
  assert.deepEqual(runner.status().failed.map((f) => f.title).sort(), ['Broken', 'Silent']);
  db.close();
});

test('nothing runs without ffmpeg, or with both jobs switched off', async () => {
  const { db, store, settings, lib, add } = setup();
  add({ library_id: lib('movies'), kind: 'movie' });
  const calls = [];
  const jobs = { previews: async (item) => calls.push(item.id), intros: async () => {} };
  let tools = { ffmpeg: { available: false } };
  const runner = new TaskRunner({ store, settings, tools: () => tools, busy: () => false, jobs, previewsDir: tempDir(), pollMs: 20, busyPollMs: 10, gapMs: 0 });
  runner.start();
  await sleep(80);
  assert.deepEqual(calls, []);
  assert.equal(runner.status().paused, 'no-ffmpeg');
  tools = withFfmpeg();
  settings.set({ previewsEnabled: false, introDetection: false });
  runner.kick();
  await sleep(80);
  assert.deepEqual(calls, []);
  assert.equal(runner.status().paused, 'disabled');
  await runner.stop();
  db.close();
});

test('sweeping removes half-made and orphaned preview folders only', () => {
  const { db, store, settings, lib, add, row } = setup();
  const movies = lib('movies');
  const kept = add({ library_id: movies, kind: 'movie' });
  const gone = add({ library_id: movies, kind: 'movie' });
  done(store, row(kept));
  const dir = tempDir();
  for (const name of [String(kept), String(gone), `${kept}.tmp`, '999']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs: {}, previewsDir: dir });
  runner.sweep();
  assert.deepEqual(fs.readdirSync(dir).sort(), [String(kept), 'notes.txt'].sort());
  db.close();
});

test('a title removed while its previews are made leaves nothing behind', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const { db, store, lib, add, row } = setup();
  const file = path.join(tempDir(), 'Soon Gone (2020).mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=2:duration=60', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', file]);
  const id = add({ library_id: lib('movies'), kind: 'movie', path: file, duration: 60, media: JSON.stringify({ video: { width: 160, height: 90 } }) });
  const dir = tempDir();
  const jobs = makeJobs({ store, config: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', previewsDir: dir }, tools: withFfmpeg });
  const item = row(id);
  // The library scan removes the title while ffmpeg is still working.
  await jobs.previews(item, { signal: new AbortController().signal, onSpawn: () => db.run('DELETE FROM items WHERE id = ?', id) });
  assert.deepEqual(fs.readdirSync(dir), [], 'no folder for a title that no longer exists');
  db.close();
});

test('a preview folder that cannot be deleted does not stop the server or the runner', async () => {
  const { db, store, settings, lib, add } = setup();
  add({ library_id: lib('movies'), kind: 'movie' });
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '999')); // an orphan the sweep will try to remove
  const calls = [];
  const jobs = { previews: async (item) => (calls.push(item.id), done(store, item)), intros: async () => {} };
  // Windows antivirus / Explorer thumbnails, or a root-owned folder in Docker.
  const rm = mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  });
  try {
    const runner = new TaskRunner({ store, settings, tools: withFfmpeg, busy: () => false, jobs, previewsDir: dir, pollMs: 30, busyPollMs: 10, gapMs: 0 });
    assert.doesNotThrow(() => runner.start());
    await until(() => calls.length === 1, 'the runner to carry on anyway');
    assert.doesNotThrow(() => runner.sweep(), 'a sweep after a scan must not throw either');
    await runner.stop();
  } finally {
    rm.mock.restore();
  }
  db.close();
});
