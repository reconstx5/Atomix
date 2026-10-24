// The recording scheduler: every 15 s it ends recordings whose (padded) programme is over and starts the ones due,
// through the channel's tuner (shared with anyone watching it). A recording that needs a slot takes one from the
// newest viewer; it never stops another recording. Finished recordings land in the "Recordings" TV library with a
// .nfo. Series rules schedule programmes after each guide refresh (Task 4). The routes are in api/recordings.js.
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../db.js';
import { episodeNumbers } from './recordings.js';
import { Recorder, DirectRecorder, recordingPath, nfoFor, finishLeftover } from './recorder.js';

const MIN = 60_000;
const TICK_MS = 15_000;
const RETUNE_MAX_WAIT = 120_000; // a tuner that gave up is tried again 15 s, 30 s, 60 s … then every 2 min, until the end
export const JOIN_WAIT_MS = 10_000; // how long a shutdown waits for joins under way
const DISK_FLOOR = 5 * 1024 ** 3;
const LOOK_AHEAD_MS = 7 * 24 * 3600_000; // series rules schedule this far ahead
export const SENTENCES = {
  full: 'The recordings folder is full',
  gone: 'This channel no longer exists.',
  encrypted: "Encrypted channels can't be recorded",
  radio: "Radio can't be recorded",
  missed: "Atomix wasn't running at the time",
  nothing: 'Nothing was recorded',
  early: 'Stopped early',
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function defaultFreeBytes(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function defaultMakeRecorder({ tuner, direct, from, to, workDir, ffmpegPath, now }) {
  return direct ? new DirectRecorder({ url: direct.url, headers: direct.headers, workDir, ffmpegPath, now }) : new Recorder({ tuner, from, to, workDir, ffmpegPath, now });
}

export class Scheduler {
  constructor({ store, recordings, streams, tuners, plugins, settings, config, scanner, db, log = console, now = Date.now, makeRecorder = defaultMakeRecorder, freeBytes = defaultFreeBytes, finishLeftover: leftover = finishLeftover }) {
    Object.assign(this, { store, recordings, streams, tuners, plugins, settings, config, scanner, db, log, now, makeRecorder, freeBytes, finishLeftover: leftover });
    this.active = new Map(); // recording id → { recorder, holderId, tuner, sourceKey, channelKey }
    this.direct = new Map(); // holder id → stream entry (a recording with its own provider connection counts too)
    this.finishing = new Set(); // recording ids being joined
    this.starting = new Set(); // recording ids waiting for their tuner (a cancel then stops them as they start)
    this.claimed = new Set(); // file names being written (two recordings never get the same one)
    this.pending = new Set(); // promises of joins and scans (settled() waits for them)
    this.timer = null;
    this.ticking = null;
    streams.openSources.push((sourceKey) => [...this.direct.values()].filter((e) => e.live.sourceKey === sourceKey));
  }

  dir() {
    return this.settings.get('recordingsDir') || this.config.recordingsDir;
  }

  padding() {
    return { pre: clampInt(this.settings.get('recordPre'), 0, 30, 1), post: clampInt(this.settings.get('recordPost'), 0, 60, 3) };
  }

  /** A recording's pieces: where its start put them (kept on the row), else under today's recordings folder. */
  workDir(rec) {
    return rec.workDir || path.join(this.dir(), '.work', String(rec.id));
  }

  start() {
    this.stopped = false;
    this.recover().catch((err) => this.log.warn?.(`Recordings: ${err.message}`));
    this.timer = setInterval(() => this.tick().catch((err) => this.log.warn?.(`Recordings: ${err.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  /** Atomix is stopping: running recordings keep their work folder (the next start saves it and records part 2);
   *  joins already under way are waited for (at most `waitMs`), so the database is still open when they finish. */
  async stop({ waitMs = JOIN_WAIT_MS } = {}) {
    this.stopped = true; // a tick still running starts nothing more (its tune may answer after this)
    clearInterval(this.timer);
    this.timer = null;
    for (const a of this.active.values()) a.recorder.suspend?.();
    this.active.clear();
    let timer;
    const tickDone = this.ticking ? this.ticking.catch(() => {}) : Promise.resolve();
    await Promise.race([tickDone.then(() => this.settled()), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
  }

  /** Every join and library scan started so far has finished. */
  async settled() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ---- scheduling ----

  /**
   * Schedule a programme (the caller checked the profile may, and that the channel is TV and not encrypted). The same
   * airing scheduled twice is one recording.
   * @returns {{ recording, clash: string|null }}
   */
  schedule({ profile, programme, channel, ruleId = null }) {
    const same = this.recordings.airing(channel.source, channel.key, programme.start);
    if (same) return { recording: same, clash: this.clashFor(same) };
    const eps = episodeNumbers(programme.episode);
    const { pre, post } = this.padding();
    const id = this.recordings.add({
      profileId: profile.id,
      source: channel.source,
      channelKey: channel.key,
      channelId: channel.id,
      channelName: channel.name,
      programmeId: programme.id ?? null,
      title: String(programme.title || 'Untitled'),
      episodeTitle: programme.subtitle || null,
      season: eps?.season ?? null,
      episode: eps?.episode ?? null,
      plot: programme.description || null,
      start: programme.start,
      end: programme.end,
      pre,
      post,
      ruleId,
    });
    const recording = this.recordings.get(id);
    return { recording, clash: this.clashFor(recording) };
  }

  /** "Your provider allows N stream(s) at a time — this overlaps M other recording(s)", or null. */
  clashFor(rec) {
    const source = this.plugins.getLiveSource(rec.source);
    const max = Number(typeof source?.maxStreams === 'function' ? source.maxStreams() : Infinity);
    if (!Number.isFinite(max)) return null;
    const others = this.recordings.overlapping(rec.source, rec.start, rec.end, rec.id).filter((o) => o.channelKey !== rec.channelKey);
    // Recordings of one channel share one tuner: counted once.
    const tuners = new Set(others.map((o) => o.channelKey)).size;
    if (tuners + 1 <= max) return null;
    return `Your provider allows ${max} stream${max === 1 ? '' : 's'} at a time — this overlaps ${tuners} other recording${tuners === 1 ? '' : 's'}`;
  }

  /** Cancel: a scheduled one is cancelled; one recording stops now and is kept as far as it got. */
  async cancel(id) {
    const r = this.recordings.get(id);
    if (!r) return null;
    if (r.status === 'scheduled') return this.recordings.update(id, { status: 'cancelled' });
    // Still waiting for its tuner: nothing recorded yet — it's cancelled, and lets go as soon as the tuner answers.
    if (r.status === 'recording' && this.starting.has(r.id)) return this.recordings.update(id, { status: 'cancelled' });
    if (r.status === 'recording' && !this.finishing.has(r.id)) await this.finishRec(r, { error: SENTENCES.early });
    return this.recordings.get(id);
  }

  // ---- the clock ----

  tick() {
    if (this.stopped) return Promise.resolve();
    if (!this.ticking) this.ticking = this.runTick().finally(() => (this.ticking = null));
    return this.ticking;
  }

  async runTick() {
    const now = this.now();
    // At its end a recording whose tuner never came back says why (what it got is saved).
    for (const r of this.recordings.ending(now)) if (!this.finishing.has(r.id)) this.finishRec(r, { error: this.active.get(r.id)?.tuner?.closed ? this.active.get(r.id).lostWhy || null : null });
    const low = this.active.size ? this.lowDisk() : false;
    for (const [id, a] of [...this.active]) {
      if (this.stopped) return;
      const row = this.recordings.get(id);
      // Its row went (the profile was deleted) or was changed behind it: let go of everything.
      if (!row || row.status !== 'recording') this.drop(id, a);
      else if (low) this.finishRec(row, { error: SENTENCES.full });
      else if (a.tuner?.closed && !this.stopped) await this.retune(id, a);
    }
    for (const r of this.recordings.due(now)) {
      if (this.stopped) return;
      await this.startRec(r, now);
    }
  }

  lowDisk() {
    const dir = this.dir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      return this.freeBytes(dir) < DISK_FLOOR;
    } catch (err) {
      this.log.warn?.(`Recordings folder: ${err.message}`);
      return true;
    }
  }

  /** Throw a running recording away (its row is gone or no longer recording): the hold goes, nothing is saved. */
  drop(id, a) {
    this.active.delete(id);
    a.recorder.abort?.();
    if (a.tuner) this.tuners.release(a.holderId);
    this.direct.delete(a.holderId);
  }

  fail(r, error) {
    this.recordings.update(r.id, { status: 'failed', error });
  }

  channelOf(r) {
    const row = this.db.get('SELECT * FROM live_channels WHERE source = ? AND key = ? AND hidden = 0 AND missing_since IS NULL', r.source, r.channelKey);
    return row ? { id: row.id, source: row.source, key: row.key, name: row.name, radio: Boolean(row.radio), drm: row.drm || null } : null;
  }

  async startRec(r, now) {
    if (r.end + r.post * MIN <= now) return this.fail(r, SENTENCES.missed);
    const source = this.plugins.getLiveSource(r.source);
    const channel = source ? this.channelOf(r) : null;
    if (!source || !channel) return this.fail(r, SENTENCES.gone);
    if (channel.drm) return this.fail(r, SENTENCES.encrypted);
    if (channel.radio) return this.fail(r, SENTENCES.radio);
    if (this.lowDisk()) return this.fail(r, SENTENCES.full);
    let slot = this.streams.takeSlotFor(source, { channelKey: r.channelKey, title: r.title });
    if (!slot.ok) {
      // Recordings hold every slot. One whose programme is over (in its late minutes) gives way now; one ending by
      // this programme's start is waited for (this one starts without its early minutes); else this one fails.
      const others = [...this.active.keys()].map((id) => this.recordings.get(id)).filter((o) => o && o.source === r.source && o.channelKey !== r.channelKey);
      const over = others.filter((o) => o.end <= now);
      if (over.length) {
        for (const o of over) this.finishRec(o);
        slot = this.streams.takeSlotFor(source, { channelKey: r.channelKey, title: r.title });
      }
      if (!slot.ok) {
        if (slot.waiting) return; // a viewer is starting on the last slot: tried again next tick (it can be stopped then)
        if (now < r.start && others.every((o) => o.end <= r.start)) return;
        return this.fail(r, slot.error);
      }
    }
    const holderId = `rec:${r.id}`;
    const userId = this.db.get('SELECT user_id FROM profiles WHERE id = ?', r.profileId)?.user_id ?? null;
    const info = { id: holderId, userId, profileId: r.profileId, username: 'Recording', createdAt: now, live: { sourceKey: r.source, channelId: channel.id, channelName: channel.name } };
    const holder = { id: holderId, kind: 'recording', title: r.title, info };
    this.recordings.update(r.id, { status: 'recording', error: null, workDir: this.workDir(r) });
    r = this.recordings.get(r.id);
    this.starting.add(r.id);
    try {
      const tuned = await this.streams.tuneForRecording(source, channel, holder);
      // Atomix stopped while the tuner was starting: no recorder now (the row stays 'recording', so the next start
      // records the rest, as for a recording running at shutdown).
      if (this.stopped) {
        if (tuned.tuner) this.tuners.release(holderId);
        return;
      }
      // Cancelled (or its row deleted) while the tuner was starting: let go now.
      if (this.recordings.get(r.id)?.status !== 'recording') {
        if (tuned.tuner) this.tuners.release(holderId);
        return;
      }
      const workDir = this.workDir(r);
      const opts = { from: r.start - r.pre * MIN, to: r.end + r.post * MIN, workDir, ffmpegPath: this.config.ffmpegPath, now: this.now };
      let recorder;
      if (tuned.tuner) recorder = this.makeRecorder({ ...opts, tuner: tuned.tuner });
      else {
        this.direct.set(holderId, { ...info, recording: true });
        recorder = this.makeRecorder({ ...opts, direct: tuned.direct });
      }
      recorder.start();
      this.active.set(r.id, { recorder, holderId, tuner: tuned.tuner || null, sourceKey: r.source, channelKey: r.channelKey });
    } catch (err) {
      this.tuners?.release(holderId);
      this.direct.delete(holderId);
      // Stopping refused the tuner: the row stays 'recording' for the next start, not failed.
      if (!this.stopped && this.recordings.get(r.id)?.status === 'recording') this.fail(r, err?.message || "This channel isn't answering right now");
    } finally {
      this.starting.delete(r.id);
      slot.release();
    }
  }

  /** The tuner gave up (the provider kept dropping): a fresh one through a slot like any start, tried again with a
   *  growing wait (15 s → 2 min) until the recording's end, which then saves what it got with the reason. */
  async retune(id, a) {
    const r = this.recordings.get(id);
    if (!r) return;
    const now = this.now();
    if (a.nextRetune && now < a.nextRetune) return;
    const source = this.plugins.getLiveSource(r.source);
    const channel = source ? this.channelOf(r) : null;
    if (!source || !channel) return;
    let why = "This channel isn't answering right now";
    const slot = this.streams.takeSlotFor(source, { channelKey: r.channelKey, title: r.title });
    if (slot.waiting) return; // a viewer is starting on the last slot: next tick, and that's not a try
    a.retuneWait = Math.min(RETUNE_MAX_WAIT, (a.retuneWait || TICK_MS / 2) * 2);
    a.nextRetune = now + a.retuneWait;
    if (slot.ok) {
      try {
        const tuned = await this.streams.tuneForRecording(source, channel, { id: a.holderId, kind: 'recording', title: r.title, info: { id: a.holderId, userId: null, profileId: r.profileId, username: 'Recording', createdAt: this.now(), live: { sourceKey: r.source, channelId: channel.id, channelName: channel.name } } });
        // Atomix stopped while it tuned: let the new tuner go (the next start records the rest).
        if (this.stopped) {
          if (tuned.tuner) this.tuners.release(a.holderId);
          return;
        }
        if (tuned.tuner) {
          a.tuner = tuned.tuner;
          a.recorder.attach?.(tuned.tuner);
          a.retuneWait = 0;
          a.nextRetune = 0;
          a.lostWhy = null;
          return;
        }
      } catch (err) {
        why = err?.message || why;
      } finally {
        slot.release();
      }
    } else why = slot.error || why;
    a.lostWhy = why;
  }

  /** A series rule changed: its scheduled airings that no longer match it (another channel, a repeat when only new
   *  episodes are wanted) are cancelled; the next refresh schedules the ones that do. */
  ruleChanged(ruleId) {
    const rule = this.recordings.rule(ruleId);
    if (!rule) return 0;
    let n = 0;
    for (const r of this.recordings.list({ ruleId: rule.id, status: 'scheduled' })) {
      const wrongChannel = rule.channelKey && r.channelKey !== rule.channelKey;
      const repeat = rule.newOnly && Boolean(this.db.get('SELECT p.repeat FROM live_programmes p JOIN live_channels c ON c.id = p.channel_id WHERE c.source = ? AND c.key = ? AND p.start = ?', r.source, r.channelKey, r.start)?.repeat);
      if (wrongChannel || repeat) {
        // Gone, not cancelled: a cancelled row would still count as "this episode is known" and block the channel the
        // rule moved to (and a move back).
        this.recordings.remove(r.id);
        n++;
      }
    }
    return n;
  }

  /** A failed recording whose pieces are still there can be joined again. */
  canRetry(r) {
    return r?.status === 'failed' && !this.finishing.has(r.id) && fs.existsSync(this.workDir(r)) && fs.readdirSync(this.workDir(r)).length > 0;
  }
  /** Join a failed recording's pieces again (Try again on the Recordings page). */
  /** The row stays under Failed while it is joined (`saving()` says so), never back under "Recording now".
   *  @returns {Promise<void>|null} resolves when the join has saved (or failed again); null when it can't be tried */
  retryJoin(id) {
    const r = this.recordings.get(id);
    if (!this.canRetry(r)) return null;
    this.recordings.update(r.id, { error: null });
    return this.finishRec(this.recordings.get(r.id));
  }
  /** A failed recording being joined again. */
  saving(id) {
    return this.finishing.has(id);
  }

  /**
   * End a recording: the tuner hold is let go now; the join, the .nfo and the library scan follow.
   * @returns {Promise<void>} resolves once the row says how it ended (done or failed) — not waiting for the scan
   */
  finishRec(r, { error = null } = {}) {
    if (!r || this.finishing.has(r.id)) return Promise.resolve();
    this.finishing.add(r.id);
    const a = this.active.get(r.id);
    this.active.delete(r.id);
    if (a?.tuner) this.tuners.release(a.holderId);
    let markSaved;
    const saved = new Promise((res) => (markSaved = res));
    const out = uniquePath(recordingPath({ recordingsDir: this.dir(), title: r.title, season: r.season, episode: r.episode, episodeTitle: r.episodeTitle, start: r.start, part: r.part }), this.claimed);
    this.claimed.add(out);
    const p = (async () => {
      let res;
      try {
        res = a ? await a.recorder.finish(out) : await this.finishLeftover(this.workDir(r), out, this.config.ffmpegPath);
      } catch (err) {
        this.log.warn?.(`Recording "${r.title}" couldn't be saved: ${err.message}`);
        return this.fail(r, err?.empty ? SENTENCES.nothing : "Couldn't save the recording");
      } finally {
        if (a) this.direct.delete(a.holderId);
      }
      try {
        fs.writeFileSync(out.replace(/\.mkv$/, '.nfo'), nfoFor(r, r.channelName));
      } catch (err) {
        this.log.warn?.(`Recording "${r.title}": no .nfo (${err.message})`);
      }
      this.recordings.update(r.id, { status: 'done', path: out, gapSeconds: res.gapSeconds || 0, error });
      this.claimed.delete(out);
      markSaved();
      await this.addToLibrary(r.id, out);
      await this.afterFinish(this.recordings.get(r.id));
    })()
      .catch((err) => this.log.warn?.(`Recording "${r.title}": ${err.message}`))
      .finally(() => {
        this.claimed.delete(out);
        markSaved();
        this.pending.delete(p);
        this.finishing.delete(r.id);
      });
    this.pending.add(p);
    return saved;
  }

  /** The TV library over the recordings folder ("Recordings", made the first time), scanned; the item noted. */
  async addToLibrary(recId, file) {
    const dir = path.resolve(this.dir());
    let lib = this.recordingsLibrary();
    if (!lib) {
      const res = this.db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Recordings', 'tv', ?, '{}', ?)", JSON.stringify([dir]), Date.now());
      lib = { id: Number(res.lastInsertRowid) };
    }
    try {
      await this.scanner.enqueue(lib.id);
    } catch (err) {
      this.log.warn?.(`Recordings library scan: ${err.message}`);
    }
    const item = this.db.get('SELECT id FROM items WHERE path = ?', file);
    if (item) this.recordings.update(recId, { itemId: item.id });
  }

  // ---- series rules ----

  /**
   * After a guide refresh: each rule of the source schedules its programmes in the next 7 days (title matched
   * case-insensitively and trimmed; its channel, or any TV channel of the source; repeats skipped when "new episodes
   * only"), skipping any airing or episode already scheduled or recorded.
   */
  afterRefresh(sourceKey) {
    const rules = this.recordings.rules().filter((r) => r.source === sourceKey);
    if (!rules.length) return 0;
    const now = this.now();
    const channels = this.store.channels({ sources: [sourceKey] }).filter((c) => !c.hidden && !c.radio && !c.drm);
    if (!channels.length) return 0;
    const guide = this.store.guide(channels.map((c) => c.id), now, now + LOOK_AHEAD_MS);
    const norm = (t) => String(t ?? '').trim().toLowerCase();
    let added = 0;
    for (const rule of rules) {
      const profile = this.db.get('SELECT id, kids FROM profiles WHERE id = ?', rule.profileId);
      if (!profile || profile.kids) continue;
      for (const channel of channels) {
        if (rule.channelKey && rule.channelKey !== channel.key) continue;
        for (const p of guide.get(channel.id) || []) {
          if (p.start < now || norm(p.title) !== norm(rule.title) || (rule.newOnly && p.repeat)) continue;
          const eps = episodeNumbers(p.episode);
          const known = this.recordings.exists({ ruleId: rule.id, source: sourceKey, channelKey: channel.key, start: p.start, season: eps?.season ?? null, episode: eps?.episode ?? null, title: p.title, episodeTitle: p.subtitle || null });
          if (known) continue;
          this.schedule({ profile, programme: p, channel, ruleId: rule.id });
          added++;
        }
      }
    }
    return added;
  }

  /** A recording of a rule finished: a rule keeping the last N deletes its oldest finished recordings beyond N. */
  async afterFinish(rec) {
    if (!rec?.ruleId) return;
    const rule = this.recordings.rule(rec.ruleId);
    if (!rule?.keep) return;
    const done = this.recordings.list({ ruleId: rule.id, status: 'done' }).sort((a, b) => b.start - a.start);
    for (const old of done.slice(rule.keep)) this.removeRecording(old);
  }

  /** A finished recording deleted: its file, .nfo and library item; the row goes. */
  removeRecording(rec) {
    if (rec.status !== 'recording') fs.rmSync(this.workDir(rec), { recursive: true, force: true }); // a failed join's pieces
    if (rec.path) {
      for (const f of [rec.path, rec.path.replace(/\.mkv$/, '.nfo')]) fs.rmSync(f, { force: true });
      const lib = this.recordingsLibrary();
      if (lib) this.scanner.removePaths?.(lib.id, [rec.path]);
    }
    this.recordings.remove(rec.id);
  }

  recordingsLibrary() {
    const dir = path.resolve(this.dir());
    return this.db.all("SELECT * FROM libraries WHERE type = 'tv' AND server_id IS NULL ORDER BY id").find((l) => parseJson(l.paths, []).some((p) => path.resolve(p) === dir)) || null;
  }

  /**
   * Atomix started: recordings it was making are saved from their work folder, and one still inside its window
   * carries on as part 2; scheduled ones whose time passed while Atomix was off fail.
   */
  async recover() {
    const now = this.now();
    for (const r of this.recordings.list({ status: 'recording' })) {
      if (this.active.has(r.id)) continue;
      if (now < r.end + r.post * MIN) {
        const { id, status, error, gapSeconds, path: _p, itemId, createdAt, workDir: _w, ...fields } = r;
        this.recordings.add({ ...fields, part: r.part + 1, status: 'scheduled' });
      }
      this.finishRec(r);
    }
    for (const r of this.recordings.list({ status: 'scheduled' })) if (r.end + r.post * MIN <= now) this.fail(r, SENTENCES.missed);
  }
}

/** `file.mkv`, or `file (2).mkv` … when that name is taken (on disk, or being written by another recording). */
function uniquePath(file, claimed = new Set()) {
  const free = (f) => !fs.existsSync(f) && !claimed.has(f);
  if (free(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  for (let i = 2; ; i++) if (free(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
}
