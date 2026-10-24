// Tuners: one provider connection per Live TV channel, shared by everyone watching or recording it. ffmpeg copies
// the channel (no conversion) into a 30-minute buffer of fMP4 pieces, a folder per run (a run per connection, so a
// restart after a drop never overwrites what was kept); the browser's manifest is built from the runs
// (timeshift.js). A tuner closes 30 s after its last holder leaves.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tunerArgs, codecTags, parsePlaylist, parseCodecs, fallbackCodecs, buildManifest, piecesBack, WINDOW_SEC } from './timeshift.js';
import { liveInputArgs, redactText } from '../stream/ffheaders.js';

const DROPS = 3; // restarts allowed…
const DROP_WINDOW_MS = 120_000; // …in this long
const POLL_MS = 1000;
const PIECE_NAME = /^(init-\d+\.mp4|seg-\d+-\d{6}\.m4s)$/;
export const STOPPED = 'This channel stopped sending video.';
/** ffmpeg's own words for a provider's 401/403 (not a URL that happens to contain 401 or 403). */
export const refusedText = (text) => /(Server returned|HTTP error) 40[13]\b/i.test(String(text));

/**
 * The provider input for a tuner: the playlist's headers and a read timeout, but no in-ffmpeg reconnects — a drop
 * ends the run, and the tuner starts a clean one (a new period) instead of ffmpeg stitching timestamps across it.
 */
function tunerInputArgs(headers) {
  const args = liveInputArgs(headers);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (['-reconnect', '-reconnect_streamed', '-reconnect_delay_max', '-reconnect_on_network_error'].includes(args[i])) {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

export class Tuner extends EventEmitter {
  constructor(pool, { key, url, headers, media, label, resolve = null }) {
    super();
    // `resolve`: asked for the channel's address again at each restart (a provider's addresses can expire).
    Object.assign(this, { pool, key, url, headers: headers || {}, media, label, resolve });
    this.trimmed = 0; // pieces forgotten so far (the spanning playlist's sequence numbers count from them)
    this.id = crypto.randomBytes(8).toString('hex');
    this.dir = path.join(pool.config.timeshiftDir, this.id);
    this.holders = new Map();
    this.runs = [];
    this.origin = null;
    this.drops = [];
    this.since = pool.now();
    this.closed = false;
    this.proc = null;
    this.idleTimer = null;
    this.audioOnly = !media?.video;
    fs.mkdirSync(this.dir, { recursive: true });
    this.poller = setInterval(() => this.poll(), POLL_MS);
    this.poller.unref?.();
  }

  /** Start the next run (run 1 at first, then one per restart). */
  startRun() {
    const run = (this.runs.at(-1)?.run || 0) + 1;
    fs.mkdirSync(path.join(this.dir, `run-${run}`), { recursive: true });
    this.runs.push({ run, start: null, codecs: null, audioOnly: this.audioOnly, pieces: [], lastSeq: -1, sum: 0 });
    const args = tunerArgs({ url: this.url, media: this.media, dir: this.dir, run, inputArgs: tunerInputArgs(this.headers) });
    const proc = spawn(this.pool.config.ffmpegPath, args, { cwd: path.join(this.dir, `run-${run}`), stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    const err = [];
    proc.stderr.on('data', (c) => err.length < 20 && err.push(c));
    proc.on('error', () => {});
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null;
      if (this.closed || proc.killedOnPurpose) return;
      const text = Buffer.concat(err).toString().trim();
      // Refused before a single piece (the provider said 401/403): say so now, not after the restarts.
      if (!this.ready && refusedText(text)) {
        this.refused = true;
        this.pool.log.warn?.(`${this.label}: the provider refused the channel (${redactText(text.split('\n').at(-1))})`);
        return this.end('refused');
      }
      this.dropped(text.split('\n').at(-1) || '');
    });
  }

  dropped(why) {
    const now = this.pool.now();
    this.drops = [...this.drops.filter((t) => now - t < DROP_WINDOW_MS), now];
    if (this.drops.length > DROPS) {
      this.pool.log.warn?.(`${this.label}: the provider stopped sending (${redactText(why) || 'no reason given'})`);
      return this.end(STOPPED);
    }
    this.emit('drop');
    const t = setTimeout(async () => {
      if (this.closed) return;
      if (this.resolve) {
        try {
          const fresh = await this.resolve();
          if (fresh?.url) {
            this.url = fresh.url;
            this.headers = fresh.headers || {};
          }
        } catch {
          /* the source didn't answer: the address we have */
        }
      }
      if (!this.closed) this.startRun();
    }, 1000);
    t.unref?.();
  }

  /** Read the current run's playlist: new pieces join the run's list (start times from the running sum). */
  poll() {
    const r = this.runs.at(-1);
    if (!r) return;
    const dir = path.join(this.dir, `run-${r.run}`);
    let text;
    try {
      text = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8');
    } catch {
      return;
    }
    if (!r.codecs) {
      try {
        r.codecs = parseCodecs(fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8')) || fallbackCodecs(this.media);
      } catch {
        /* not written yet */
      }
    }
    let added = false;
    for (const s of parsePlaylist(text).segments) {
      if (s.seq <= r.lastSeq) continue;
      if (r.start == null) {
        // A new run's first piece: conversions reading the buffer move to its playlist (it exists now).
        if (r.run > 1) setImmediate(() => this.emit('run', r.run));
        // When the first piece began, by Atomix's clock (the player's clock too): it was just finished, so now minus
        // its length (ffmpeg's own date stamps can run seconds off).
        r.start = this.pool.now() - Math.round(s.duration * 1000);
        if (this.origin == null) this.origin = r.start;
      }
      r.pieces.push({ seq: s.seq, t: Math.round(r.sum), d: Math.round(s.duration * 1000) });
      r.sum += s.duration * 1000;
      r.lastSeq = s.seq;
      added = true;
    }
    if (added) {
      this.emit('piece', r);
      this.trim();
      this.writePlaylist();
    }
  }

  /** One live playlist across the kept runs (a discontinuity between them), so a conversion can rewind into an
   *  earlier run; written whole and renamed into place, so a reader never sees half of it. */
  writePlaylist() {
    const runs = this.runs.filter((r) => r.pieces.length);
    if (!runs.length) return;
    const longest = Math.max(1, ...runs.flatMap((r) => r.pieces.map((p) => Math.ceil(p.d / 1000))));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${longest}`, `#EXT-X-MEDIA-SEQUENCE:${this.trimmed}`, '#EXT-X-INDEPENDENT-SEGMENTS'];
    runs.forEach((r, i) => {
      if (i) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXT-X-MAP:URI="run-${r.run}/init-${r.run}.mp4"`);
      for (const p of r.pieces) lines.push(`#EXTINF:${(p.d / 1000).toFixed(3)},`, `run-${r.run}/seg-${r.run}-${String(p.seq).padStart(6, '0')}.m4s`);
    });
    const file = path.join(this.dir, 'index-all.m3u8');
    try {
      fs.writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`);
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      /* the tuner is closing */
    }
  }

  /** Forget pieces (and whole earlier runs) that left the 30-minute window. */
  trim() {
    const from = this.pool.now() - WINDOW_SEC * 1000 - 60_000;
    for (const r of this.runs) {
      if (r.start == null) continue;
      while (r.pieces.length && r.start + r.pieces[0].t + r.pieces[0].d < from) {
        const old = r.pieces.shift();
        this.trimmed++;
        fs.rm(path.join(this.dir, `run-${r.run}`, `seg-${r.run}-${String(old.seq).padStart(6, '0')}.m4s`), { force: true }, () => {});
      }
    }
    while (this.runs.length > 1 && !this.runs[0].pieces.length) {
      const old = this.runs.shift();
      fs.rm(path.join(this.dir, `run-${old.run}`), { recursive: true, force: true }, () => {});
    }
  }

  get ready() {
    return this.runs.some((r) => r.pieces.length > 0);
  }

  manifest({ now = this.pool.now(), piecePath, timeUrl }) {
    const runs = this.runs.filter((r) => r.start != null && r.pieces.length).map((r) => ({ ...r, codecs: r.codecs || '' }));
    return buildManifest({ runs, origin: this.origin ?? now, now, piecePath, timeUrl });
  }

  /** How many of the newest kept pieces (across runs) cover `behind` seconds (a conversion's starting point). */
  piecesBack(behindSec) {
    return piecesBack(this.runs.flatMap((r) => r.pieces), behindSec);
  }

  /** The playlist across the kept runs (conversions read from it). */
  localPlaylist() {
    return path.join(this.dir, 'index-all.m3u8');
  }

  /** A piece's file, only for a name ffmpeg writes (never a .tmp, never a path), and only if it exists. */
  piecePath(name) {
    if (!PIECE_NAME.test(String(name))) return null;
    const run = /^(?:init|seg)-(\d+)/.exec(name)[1];
    const file = path.join(this.dir, `run-${run}`, name);
    return fs.existsSync(file) ? file : null;
  }

  end(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poller);
    clearTimeout(this.idleTimer);
    if (this.proc) {
      this.proc.killedOnPurpose = true;
      this.proc.kill('SIGKILL');
    }
    this.pool.forget(this);
    fs.rm(this.dir, { recursive: true, force: true }, () => {});
    this.emit('ended', reason);
  }
}

export class TunerPool {
  constructor({ config, log = console, now = Date.now, idleMs = 30_000, firstPieceMs = 10_000 }) {
    Object.assign(this, { config, log, now, idleMs, firstPieceMs });
    this.tuners = new Map(); // key → Tuner
    this.starting = new Map(); // key → Promise<Tuner>
    this.byHolder = new Map(); // holder id → Tuner
    this.startingTuners = new Set(); // tuners still waiting for their first piece (closed on shutdown too)
    // Leftovers from a previous run of Atomix.
    fs.rmSync(config.timeshiftDir, { recursive: true, force: true });
    fs.mkdirSync(config.timeshiftDir, { recursive: true });
  }

  get(key) {
    return this.tuners.get(key);
  }

  /** The channel's tuner, started if needed (resolves once its first piece is written). Rejects `unbuffered`. */
  async acquire(spec, holder) {
    // Atomix is stopping: nothing new starts (an ffmpeg started now would outlive the process).
    if (this.closed) throw Object.assign(new Error('Atomix is stopping'), { code: 'CLOSING' });
    let tuner = this.tuners.get(spec.key);
    if (!tuner) {
      let pending = this.starting.get(spec.key);
      if (!pending) {
        pending = this.start(spec).finally(() => this.starting.delete(spec.key));
        this.starting.set(spec.key, pending);
      }
      tuner = await pending;
    }
    clearTimeout(tuner.idleTimer);
    tuner.holders.set(holder.id, holder);
    this.byHolder.set(holder.id, tuner);
    return tuner;
  }

  async start(spec) {
    const unbuffered = () => Object.assign(new Error('unbuffered'), { unbuffered: true });
    if (!codecTags(spec.media)) throw unbuffered();
    const tuner = new Tuner(this, spec);
    this.startingTuners.add(tuner);
    tuner.once('ended', () => this.startingTuners.delete(tuner));
    tuner.startRun();
    const deadline = this.now() + this.firstPieceMs;
    while (!tuner.ready) {
      if (tuner.refused) throw Object.assign(new Error('The provider refused this channel'), { code: 'REFUSED' });
      if (tuner.closed || this.now() > deadline) {
        tuner.end('unbuffered');
        throw unbuffered();
      }
      await new Promise((r) => setTimeout(r, 200));
      tuner.poll();
    }
    this.startingTuners.delete(tuner);
    this.tuners.set(spec.key, tuner);
    return tuner;
  }

  release(holderId) {
    const tuner = this.byHolder.get(holderId);
    if (!tuner) return;
    this.byHolder.delete(holderId);
    tuner.holders.delete(holderId);
    if (!tuner.holders.size && !tuner.closed) {
      clearTimeout(tuner.idleTimer);
      tuner.idleTimer = setTimeout(() => !tuner.holders.size && tuner.end('idle'), this.idleMs);
      tuner.idleTimer.unref?.();
    }
  }

  /** A hold taken under a temporary id moves to the session's own id. */
  rename(oldId, newId) {
    const tuner = this.byHolder.get(oldId);
    if (!tuner) return;
    const h = tuner.holders.get(oldId);
    tuner.holders.delete(oldId);
    tuner.holders.set(newId, { ...h, id: newId });
    this.byHolder.delete(oldId);
    this.byHolder.set(newId, tuner);
  }

  /** Close now the idle tuners (no holders, waiting their idle time) whose key starts with `prefix` (a source). */
  endIdle(prefix, except = null) {
    for (const t of [...this.tuners.values()]) if (t.key.startsWith(prefix) && t.key !== except && !t.holders.size) t.end('idle');
  }

  /** A tuner that ended: its holders are forgotten (their owners hear 'ended'). */
  forget(tuner) {
    if (this.tuners.get(tuner.key) === tuner) this.tuners.delete(tuner.key);
    for (const id of tuner.holders.keys()) this.byHolder.delete(id);
  }

  list() {
    return [...this.tuners.values()].map((t) => ({ key: t.key, label: t.label, holders: [...t.holders.values()], since: t.since }));
  }

  close() {
    this.closed = true;
    for (const t of [...this.tuners.values(), ...this.startingTuners]) t.end('closing');
  }
}
