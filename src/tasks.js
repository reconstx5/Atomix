// Background jobs: seek-bar previews and intro finding. One job at a time, ffmpeg
// at low CPU priority, and nothing runs while someone watches a video the server
// is converting. A job that's running when a conversion starts is stopped and
// redone later.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('tasks');
const LOW_PRIORITY = 10; // nice 10; "below normal" on Windows

export class TaskRunner {
  /**
   * @param {object} o
   * @param {import('./extras/store.js').ExtrasStore} o.store
   * @param {{ all(): object }} o.settings
   * @param {() => object} o.tools   the current ffmpeg detection result
   * @param {() => boolean} o.busy   true while a converted video is playing
   * @param {{ previews(item, ctx): Promise, intros(seasonId, ctx): Promise }} o.jobs  ctx = { signal, onSpawn }
   * @param {string} o.previewsDir
   */
  constructor({ store, settings, tools, busy, jobs, previewsDir, pollMs = 5 * 60 * 1000, busyPollMs = 5000, gapMs = 200 }) {
    Object.assign(this, { store, settings, tools, busy, jobs, previewsDir, pollMs, busyPollMs, gapMs });
    this.priority = new Set();
    this.current = null;
    this.stopped = true;
    this.wake = null;
    this.loopDone = Promise.resolve();
    this.lastDone = null; // key of the last job that finished without an error
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.sweep();
    this.loopDone = this.loop();
  }

  async stop() {
    this.stopped = true;
    this.abortCurrent();
    this.kick();
    await this.loopDone;
  }

  /** Look for work now instead of at the next poll. */
  kick() {
    this.lastDone = null;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** A newly scanned title: its jobs go before the backlog. */
  prioritise(item) {
    if (!item || !['movie', 'episode'].includes(item.kind)) return;
    this.priority.add(item.id);
    if (item.kind === 'episode' && item.parent_id) this.store.resetSeasonNone(item.parent_id);
    this.kick();
  }

  /** Playback started: if a conversion is now playing, stop the running job. */
  interruptIfBusy() {
    if (this.current && this.busy()) this.abortCurrent();
  }

  abortCurrent() {
    const c = this.current;
    if (!c) return;
    c.controller.abort();
    try {
      c.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  status() {
    const s = this.settings.all();
    const c = this.current;
    let paused = null;
    if (!this.tools()?.ffmpeg?.available) paused = 'no-ffmpeg';
    else if (!s.previewsEnabled && !s.introDetection) paused = 'disabled';
    else if (!c && this.busy()) paused = 'converting';
    return {
      running: c ? { job: c.job, itemId: c.itemId, title: c.title, startedAt: c.startedAt } : null,
      paused,
      queued: { ...this.store.pendingCounts(), ...(!s.previewsEnabled || s.cardClips === false ? { clips: 0 } : {}) }, // not waiting for what is switched off (clips need previews on)
      failed: this.store.failed(20),
    };
  }

  /** Delete half-written preview folders, and previews of titles that are gone. */
  sweep() {
    let entries;
    try {
      entries = fs.readdirSync(this.previewsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const keep = this.store.previewIds();
    const working = ['previews', 'clip'].includes(this.current?.job) ? this.current.itemId : null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = Number(e.name.replace(/\.tmp$/, ''));
      if (id === working) continue;
      if (!e.name.endsWith('.tmp') && keep.has(id)) continue;
      try {
        fs.rmSync(path.join(this.previewsDir, e.name), { recursive: true, force: true });
      } catch (err) {
        // A locked file (antivirus, Explorer thumbnails) or a folder we can't write: try again next sweep.
        log.warn(`Couldn't remove old previews in ${e.name}: ${err.message}`);
      }
    }
  }

  /** Nothing to do: no ffmpeg, or the optional jobs are off and no one-off catch-up (lyrics, subtitles) is waiting. */
  shouldIdle(s = this.settings.all()) {
    if (!this.tools()?.ffmpeg?.available) return true;
    if (s.previewsEnabled || s.introDetection) return false;
    const q = this.store.pendingCounts();
    return !q.lyrics && !q.subtitles && !q.loudness;
  }

  next() {
    const s = this.settings.all();
    const pick = (only) => {
      if (s.introDetection) {
        const seasonId = this.store.nextIntroSeason(only);
        if (seasonId != null) {
          const ids = this.store.pendingIntroEpisodes(seasonId).map((e) => e.id);
          return { key: `intros:${seasonId}:${ids.join(',')}`, job: 'intros', seasonId, itemId: seasonId, title: this.store.seasonLabel(seasonId) };
        }
      }
      if (s.previewsEnabled) {
        const item = this.store.nextPreviewItem(only);
        if (item) return { key: `previews:${item.id}:${item.size}:${item.mtime}`, job: 'previews', item, itemId: item.id, title: this.store.itemLabel(item) };
        const ex = this.store.nextThumbItem(only);
        if (ex) return { key: `thumb:${ex.id}:${ex.size}:${ex.mtime}`, job: 'thumb', item: ex, itemId: ex.id, title: this.store.itemLabel(ex) };
      }
      // v0.28 card motion: a 5 s silent clip for cards (after the previews, intro checks and thumbnails).
      if (s.previewsEnabled && s.cardClips !== false) {
        const item = this.store.nextClipItem(only);
        if (item) return { key: `clip:${item.id}:${item.size}:${item.mtime}`, job: 'clip', item, itemId: item.id, title: this.store.itemLabel(item) };
      }
      // Embedded lyrics for songs probed before 0.10: one ffprobe each, once.
      const song = this.store.nextLyricsItem(only);
      if (song) return { key: `lyrics:${song.id}`, job: 'lyrics', item: song, itemId: song.id, title: this.store.itemLabel(song) };
      // Embedded text subtitles, extracted once so the player doesn't demux the whole file on demand.
      const sub = this.store.nextSubtitleItem(only);
      if (sub) return { key: `subtitles:${sub.id}`, job: 'subtitles', item: sub, itemId: sub.id, title: this.store.itemLabel(sub) };
      // v0.28: each song's loudness, measured once, for even volume.
      const song2 = this.store.nextLoudnessItem(only);
      if (song2) return { key: `loudness:${song2.id}`, job: 'loudness', item: song2, itemId: song2.id, title: this.store.itemLabel(song2) };
      return null;
    };
    if (this.priority.size) {
      const first = pick([...this.priority]);
      if (first) return first;
      this.priority.clear();
    }
    return pick(null);
  }

  idle(ms) {
    this.lastDone = null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async loop() {
    while (!this.stopped) {
      try {
        const s = this.settings.all();
        if (this.shouldIdle(s)) {
          await this.idle(this.pollMs);
          continue;
        }
        if (this.busy()) {
          await this.idle(this.busyPollMs);
          continue;
        }
        const task = this.next();
        if (!task) {
          await this.idle(this.pollMs);
          continue;
        }
        if (task.key === this.lastDone) {
          // It ran, didn't fail, and is still wanted: it recorded nothing. Don't spin on it.
          this.recordFailure(task, new Error('The job finished without recording a result.'));
          this.lastDone = null;
          continue;
        }
        await this.runTask(task);
      } catch (err) {
        log.error(`Background tasks: ${err.stack || err.message}`);
        if (!this.stopped) await this.idle(this.busyPollMs);
      }
      if (!this.stopped && this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
    }
  }

  async runTask(task) {
    const controller = new AbortController();
    this.current = { ...task, startedAt: Date.now(), controller, proc: null };
    const ctx = {
      signal: controller.signal,
      onSpawn: (proc) => {
        if (this.current?.controller === controller) this.current.proc = proc;
        try {
          os.setPriority(proc.pid, LOW_PRIORITY);
        } catch {
          /* not allowed here; it still runs */
        }
        if (controller.signal.aborted) proc.kill('SIGKILL');
      },
    };
    try {
      if (task.job === 'previews') await this.jobs.previews(task.item, ctx);
      else if (task.job === 'thumb') await this.jobs.thumb(task.item, ctx);
      else if (task.job === 'clip') await this.jobs.clip(task.item, ctx);
      else if (task.job === 'lyrics') await this.jobs.lyrics(task.item, ctx);
      else if (task.job === 'subtitles') await this.jobs.subtitles(task.item, ctx);
      else if (task.job === 'loudness') await this.jobs.loudness(task.item, ctx);
      else await this.jobs.intros(task.seasonId, ctx);
      this.lastDone = task.key;
    } catch (err) {
      this.lastDone = null;
      if (controller.signal.aborted) log.info(`Stopped "${task.title}" for now; it will be redone later.`);
      else {
        log.warn(`${{ previews: 'Previews', thumb: 'Thumbnail', clip: 'Preview clip', intros: 'Intro check', lyrics: 'Lyrics check', subtitles: 'Subtitle check', loudness: 'Volume check' }[task.job]} for "${task.title}" failed: ${err.message}`);
        this.recordFailure(task, err);
      }
    } finally {
      this.current = null;
    }
  }

  recordFailure(task, err) {
    if (task.job === 'lyrics' || task.job === 'subtitles' || task.job === 'loudness') return; // the job marks the item checked itself
    if (task.job === 'previews' || task.job === 'thumb' || task.job === 'clip') this.store.saveJob(task.item, task.job, { status: 'failed', error: err.message });
    else for (const ep of this.store.pendingIntroEpisodes(task.seasonId)) this.store.saveJob(ep, 'intros', { status: 'failed', error: err.message });
  }
}
