// The download queue (v0.21): prepares the copies devices download. One job at a time, at low CPU priority, never while
// someone watches a converted video or a recording is being joined. A copy is shared by everyone asking for the same
// title, quality and format; the folder is kept under its size (oldest used first) and copies nobody fetched for 7
// days are removed.
import { AUDIO_KINDS, READING_KINDS } from '../library/kinds.js';
import { prepareReading } from '../books/download.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseJson } from '../db.js';
import { logger } from '../log.js';
import { planDownload, downloadArgs } from './plan.js';

const log = logger('downloads');
const LOW_PRIORITY = 10;
const KEEP_UNUSED_MS = 7 * 86400_000;
const RECENT_MS = 10 * 60_000; // a copy fetched in the last 10 minutes is never removed for space (a slow phone link)
const UNFETCHED_MS = 86400_000; // a ready copy nobody has fetched yet is kept a day before space can take it
const OWN_PART = /^\d+-(480|720|1080|audio)\.\w+\.part$/;
const MISSING = 'The file is missing on the server — try rescanning the library.';
const FAILED = "Couldn't prepare this download. Try again later.";

export class DownloadQueue {
  /**
   * @param {{ db, config, settings, busy?: () => boolean, hooks?, ffmpegPath?: string, onSpawn?: (proc) => void,
   *   pollMs?: number, cacheBytes?: number }} o  cacheBytes overrides the setting (tests)
   */
  constructor({ db, config, settings, busy = () => false, tools = () => null, hooks = null, ffmpegPath, onSpawn = null, pollMs = 2000, cacheBytes = null }) {
    Object.assign(this, { db, config, settings, busy, tools, hooks, onSpawn, pollMs, cacheBytes });
    this.ffmpegPath = ffmpegPath || config.ffmpegPath || 'ffmpeg';
    this.running = null; // { id, proc }
    this.stopped = true;
    this.timer = null;
  }

  dir() {
    return this.settings?.get?.('downloadsDir') || this.config.downloadsDir;
  }

  /** The folder, made when it's missing; null (and a log line) when it can't be. */
  ensureDir() {
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      return this.dir();
    } catch (err) {
      log.warn(`The downloads folder can't be used: ${err.message}`);
      return null;
    }
  }

  start() {
    this.stopped = false;
    // A job cut off by a restart starts again; its half file goes (only the queue's own: the folder may be shared).
    this.db.run("UPDATE download_jobs SET status = 'queued', progress = 0 WHERE status = 'preparing'");
    if (this.ensureDir()) {
      try {
        for (const f of fs.readdirSync(this.dir())) if (OWN_PART.test(f)) fs.rmSync(path.join(this.dir(), f), { force: true });
        this.cleanup();
      } catch (err) {
        log.warn(`Tidying the downloads folder failed: ${err.message}`);
      }
    }
    this.kick();
  }

  /** Someone started watching a converted video: the running job stops and waits its turn again. */
  interruptIfBusy() {
    const r = this.running;
    if (!r || !this.busy()) return;
    r.stopping = true;
    r.proc.kill('SIGKILL');
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const r = this.running;
    if (r) {
      r.stopping = true;
      r.proc.kill('SIGKILL');
      await r.done.catch(() => {});
    }
  }

  /** The job for this title, quality and format (made when there is none; a failed one is asked again). */
  request(item, { quality = '720', format }) {
    const key = [item.id, String(quality), format];
    let job = this.db.get('SELECT * FROM download_jobs WHERE item_id = ? AND quality = ? AND format = ?', ...key);
    const now = Date.now();
    if (!job) {
      const res = this.db.run("INSERT INTO download_jobs (item_id, quality, format, status, progress, created_at, used_at) VALUES (?, ?, ?, 'queued', 0, ?, ?)", ...key, now, now);
      job = this.get(Number(res.lastInsertRowid));
    } else if (job.status === 'failed' || (job.status === 'ready' && !fs.existsSync(path.join(this.dir(), path.basename(job.file || ''))))) {
      this.db.run("UPDATE download_jobs SET status = 'queued', progress = 0, error = NULL, file = NULL, size = NULL, used_at = ? WHERE id = ?", now, job.id);
      job = this.get(job.id);
    } else this.db.run('UPDATE download_jobs SET used_at = ? WHERE id = ?', now, job.id); // asked for again: in use
    this.kick();
    return job;
  }

  get(id) {
    return this.db.get('SELECT * FROM download_jobs WHERE id = ?', Number(id)) || null;
  }

  /** The ready copy's path (and the job counts as used), or null. */
  fileFor(id) {
    const job = this.get(id);
    if (!job || job.status !== 'ready' || !job.file) return null;
    const file = path.join(this.dir(), path.basename(job.file));
    if (!fs.existsSync(file)) return null;
    this.db.run('UPDATE download_jobs SET used_at = ?, fetched_at = COALESCE(fetched_at, ?) WHERE id = ?', Date.now(), Date.now(), job.id);
    return file;
  }

  preparingCount() {
    return this.db.get("SELECT COUNT(*) AS n FROM download_jobs WHERE status IN ('queued', 'preparing')").n;
  }

  kick() {
    if (this.stopped || this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.next(), 0);
  }

  next() {
    try {
      this.nextNow();
    } catch (err) {
      log.warn(`The download queue stopped for a moment: ${err.message}`); // never the server
      this.timer = setTimeout(() => this.next(), Math.max(this.pollMs, 5000));
    }
  }

  nextNow() {
    if (this.stopped || this.running) return;
    const job = this.db.get("SELECT * FROM download_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1");
    if (!job) return;
    // Wait while a converted video plays, while this server has no ffmpeg, or while copies nobody has fetched yet
    // already fill the folder (preparing more would only push them out).
    const needsFfmpeg = job.format !== 'epub' && job.format !== 'cbz'; // a book or comic is copied or packed, not converted
    if (this.busy() || (needsFfmpeg && this.tools()?.ffmpeg?.available === false) || this.unfetchedBytes() > this.limit()) {
      this.timer = setTimeout(() => this.next(), this.pollMs);
      return;
    }
    this.run(job)
      .catch((err) => log.warn(`Download ${job.id} failed: ${err.message}`))
      .finally(() => {
        this.running = null;
        this.cleanup();
        this.kick();
      });
  }

  async run(job) {
    const item = this.db.get('SELECT * FROM items WHERE id = ?', job.item_id);
    const fail = (error) => this.db.run("UPDATE download_jobs SET status = 'failed', error = ?, progress = 0 WHERE id = ?", error, job.id);
    if (!item?.path || !fs.existsSync(item.path)) return fail(MISSING);
    if (READING_KINDS.has(item.kind)) return this.runReading(job, item, fail);
    const media = parseJson(item.media, null);
    const original = job.format === 'original';
    const codec = (media?.audio || [])[media?.defaultAudio ?? 0]?.codec;
    // A song's format says what it becomes: 'original' as it is, 'audio' AAC, 'webm' Opus (a browser with no AAC).
    const opus = AUDIO_KINDS.has(item.kind) && job.format === 'webm';
    const plan = planDownload({ item, media, quality: job.quality, format: original || opus ? 'audio' : job.format, caps: original ? { audio: [codec] } : opus ? { audio: ['opus'] } : {} });
    const name = `${job.id}-${job.quality}.${plan.ext}`;
    const out = path.join(this.dir(), name);
    const part = `${out}.part`;
    const duration = Number(media?.duration || item.duration) || 0;
    if (!this.ensureDir()) return fail(FAILED);
    this.db.run("UPDATE download_jobs SET status = 'preparing', progress = 0 WHERE id = ?", job.id);
    const proc = spawn(this.ffmpegPath, downloadArgs(plan, item.path, part), { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      os.setPriority(proc.pid, LOW_PRIORITY);
    } catch {
      /* not allowed here: it still runs */
    }
    this.onSpawn?.(proc);
    let lastWrite = 0;
    let stderr = '';
    proc.stdout.on('data', (buf) => {
      const m = /out_time_us=(\d+)/g;
      let last = null;
      for (let x; (x = m.exec(String(buf))); ) last = Number(x[1]);
      if (last == null || !duration || Date.now() - lastWrite < 1000) return;
      lastWrite = Date.now();
      this.db.run('UPDATE download_jobs SET progress = ? WHERE id = ?', Math.min(0.99, last / 1e6 / duration), job.id);
    });
    proc.stderr.on('data', (buf) => (stderr = (stderr + buf).slice(-2000)));
    const running = { id: job.id, proc, stopping: false };
    // An ffmpeg that can't start (missing, not allowed) is an 'error' event, never a 'close': it fails the job.
    running.done = new Promise((resolve) => {
      proc.on('error', (err) => {
        stderr = err.message;
        resolve(-1);
      });
      proc.on('close', (code) => resolve(code));
    });
    this.running = running;
    // A converted video or a recording join that starts meanwhile stops this job (it waits its turn again).
    const watch = setInterval(() => this.interruptIfBusy(), Math.max(200, this.pollMs));
    const code = await running.done.finally(() => clearInterval(watch));
    if (running.stopping) {
      fs.rmSync(part, { force: true });
      this.db.run("UPDATE download_jobs SET status = 'queued', progress = 0 WHERE id = ?", job.id);
      return;
    }
    if (code !== 0) {
      fs.rmSync(part, { force: true });
      log.warn(`Preparing "${item.title}" failed: ${stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`}`);
      return fail(FAILED);
    }
    fs.renameSync(part, out);
    const size = fs.statSync(out).size;
    this.db.run("UPDATE download_jobs SET status = 'ready', progress = 1, file = ?, size = ?, error = NULL, used_at = ? WHERE id = ?", name, size, Date.now(), job.id);
    await this.hooks?.emit?.('downloads:ready', { job: this.get(job.id) });
  }

  /** A book or comic: the whole file (a comic packed as a CBZ when it isn't one), no ffmpeg. */
  async runReading(job, item, fail) {
    if (!this.ensureDir()) return fail(FAILED);
    const name = `${job.id}-file.${job.format === 'epub' ? 'epub' : 'cbz'}`;
    const out = path.join(this.dir(), name);
    const part = `${out}.part`;
    this.db.run("UPDATE download_jobs SET status = 'preparing', progress = 0 WHERE id = ?", job.id);
    try {
      await prepareReading(item, part, { tool: this.tools()?.archive, tmpRoot: this.config.cacheDir });
    } catch (err) {
      fs.rmSync(part, { force: true });
      log.warn(`Preparing "${item.title}" failed: ${err.message}`);
      return fail(err.message);
    }
    fs.renameSync(part, out);
    const size = fs.statSync(out).size;
    this.db.run("UPDATE download_jobs SET status = 'ready', progress = 1, file = ?, size = ?, error = NULL, used_at = ? WHERE id = ?", name, size, Date.now(), job.id);
    await this.hooks?.emit?.('downloads:ready', { job: this.get(job.id) });
  }

  /** Copies nobody fetched for 7 days go; then the oldest used until the folder fits (never one used a minute ago). */
  limit() {
    return this.cacheBytes ?? (Number(this.settings?.get?.('downloadsCacheGb')) || 50) * 1024 ** 3;
  }

  unfetchedBytes() {
    return this.db.get("SELECT COALESCE(SUM(size), 0) AS n FROM download_jobs WHERE status = 'ready' AND fetched_at IS NULL").n;
  }

  /** Copies nobody fetched for 7 days go; then the oldest used until the folder fits — never a copy fetched in the last
   *  10 minutes, nor one prepared in the last day that no device has fetched yet. */
  cleanup(now = Date.now()) {
    const remove = (job) => {
      try {
        if (job.file) fs.rmSync(path.join(this.dir(), path.basename(job.file)), { force: true });
      } catch (err) {
        log.warn(`Couldn't remove a prepared download: ${err.message}`);
      }
      this.db.run('DELETE FROM download_jobs WHERE id = ?', job.id);
    };
    for (const job of this.db.all("SELECT * FROM download_jobs WHERE status IN ('ready', 'failed') AND used_at < ?", now - KEEP_UNUSED_MS)) remove(job);
    const limit = this.limit();
    const ready = this.db.all("SELECT * FROM download_jobs WHERE status = 'ready' ORDER BY used_at, id");
    let total = ready.reduce((sum, j) => sum + (j.size || 0), 0);
    for (const job of ready) {
      if (total <= limit) break;
      if (now - job.used_at < RECENT_MS) continue;
      if (job.fetched_at == null && now - job.used_at < UNFETCHED_MS) continue;
      remove(job);
      total -= job.size || 0;
    }
  }
}
