// Recording a Live TV programme: copy the channel tuner's pieces whose wall-clock time falls inside the recording's
// window (pieces already in the 30-minute buffer included) into a work folder, then join them without converting
// (`-c copy`) into one .mkv. A channel that can't be buffered is recorded by its own ffmpeg (DirectRecorder).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { liveInputArgs } from '../stream/ffheaders.js';

const GAP_TOLERANCE_MS = 500; // piece times are rounded to the millisecond; pieces of one run are back to back
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file or folder name Windows accepts: no `<>:"/\|?*` or control characters, no trailing dots or spaces. */
export function safeName(text) {
  let s = String(text ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, ''); // a leading dot would make a hidden folder; Windows drops trailing ones
  if (!s) s = 'Untitled';
  if (RESERVED.test(s)) s += '_';
  return s.slice(0, 120).replace(/[. ]+$/, '') || 'Untitled';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const localTime = (ms, sep) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}${sep}${pad(d.getMinutes())}`;
};

/** `<dir>/<Show>/<Show> - S01E02 - <Episode title>.mkv`, or `<Show> - 2026-10-11 20-30.mkv`; ` (part 2)` after a restart. */
export function recordingPath({ recordingsDir, title, season = null, episode = null, episodeTitle = null, start, part = 1 }) {
  const show = safeName(title);
  let name;
  if (season != null && episode != null) {
    name = `${show} - S${pad(season)}E${pad(episode)}`;
    if (episodeTitle) name += ` - ${safeName(episodeTitle)}`;
  } else {
    name = `${show} - ${localDate(start)} ${localTime(start, '-')}`;
  }
  if (part > 1) name += ` (part ${part})`;
  return path.join(recordingsDir, show, `${name}.mkv`);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The .nfo beside a recording, so the library shows it with the guide's details. */
export function nfoFor(rec, channelName) {
  const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<episodedetails>'];
  const tag = (name, value) => value != null && value !== '' && lines.push(`  <${name}>${xml(value)}</${name}>`);
  tag('title', rec.episodeTitle || `${rec.title} ${localDate(rec.start)} ${localTime(rec.start, ':')}`);
  tag('showtitle', rec.title);
  if (rec.season != null && rec.episode != null) {
    tag('season', rec.season);
    tag('episode', rec.episode);
  }
  tag('plot', rec.plot);
  tag('aired', localDate(rec.start));
  tag('studio', channelName);
  lines.push('</episodedetails>', '');
  return lines.join('\n');
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = [];
    proc.stderr.on('data', (c) => err.length < 50 && err.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(err).toString().trim().split('\n').at(-1) || `ffmpeg exited ${code}`))));
  });
}

const quote = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;

/**
 * A part's own playlist (its init piece and pieces in order): ffmpeg reads the pieces where they lie, so joining
 * needs disk for the .mkv only (never a second copy of the pieces).
 */
function partPlaylist(dir, pieces) {
  const target = Math.max(1, ...pieces.map((p) => Math.ceil((p.d || 4000) / 1000)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MAP:URI="init.mp4"'];
  for (const p of pieces) lines.push(`#EXTINF:${((p.d || 4000) / 1000).toFixed(3)},`, p.name);
  lines.push('#EXT-X-ENDLIST', '');
  const file = path.join(dir, 'recording.m3u8');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

/**
 * Join the parts (part playlists, or a direct recording's .ts files) into `outFile` with the concat demuxer,
 * `-c copy`. A failed join leaves no half file; the caller keeps the work folder.
 */
let joining = 0;
/** v0.21: true while a recording is being joined (the download queue waits for it). */
export const isJoining = () => joining > 0;

async function joinParts(ffmpegPath, parts, outFile, workDir) {
  joining++;
  try {
    return await joinPartsNow(ffmpegPath, parts, outFile, workDir);
  } finally {
    joining--;
  }
}

async function joinPartsNow(ffmpegPath, parts, outFile, workDir) {
  const list = path.join(workDir, 'parts.ffconcat');
  fs.writeFileSync(list, ['ffconcat version 1.0', ...parts.map((p) => `file ${quote(p)}`), ''].join('\n'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.part`;
  try {
    await runFfmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'matroska', tmp]);
    fs.renameSync(tmp, outFile);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const emptyError = () => Object.assign(new Error('Nothing was recorded'), { empty: true });

/**
 * A recording's work folder left by an Atomix that stopped mid-recording (or a join that failed): each `part-<n>`
 * folder becomes a part, a direct recording's .ts files too, joined into `outFile`. The folder is removed once the
 * file is saved (and when there was nothing in it); a failed join keeps it.
 */
export async function finishLeftover(workDir, outFile, ffmpegPath = 'ffmpeg') {
  let names = [];
  try {
    names = fs.readdirSync(workDir);
  } catch {
    /* no work folder: nothing was copied */
  }
  const parts = [];
  for (const name of names.filter((n) => /^part-\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    const dir = path.join(workDir, name);
    const pieces = fs.readdirSync(dir).filter((n) => /^seg-\d+-\d{6}\.m4s$/.test(n)).sort();
    if (!pieces.length || !fs.existsSync(path.join(dir, 'init.mp4'))) continue;
    parts.push(partPlaylist(dir, pieces.map((n) => ({ name: n, d: null }))));
  }
  for (const n of names.filter((x) => /^direct-\d+\.ts$/.test(x)).sort((a, b) => parseInt(a.slice(7), 10) - parseInt(b.slice(7), 10))) {
    if (fs.statSync(path.join(workDir, n)).size > 0) parts.push(path.join(workDir, n));
  }
  if (!parts.length) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw emptyError();
  }
  await joinParts(ffmpegPath, parts, outFile, workDir);
  fs.rmSync(workDir, { recursive: true, force: true });
  return { file: outFile, gapSeconds: 0 };
}

/** Missing time between consecutive covered spans [{a, b}] (sorted by a), in whole seconds. */
function holes(spans) {
  let gap = 0;
  let reach = null;
  for (const s of [...spans].sort((x, y) => x.a - y.a)) {
    if (reach != null && s.a - reach > GAP_TOLERANCE_MS) gap += s.a - reach;
    reach = reach == null ? s.b : Math.max(reach, s.b);
  }
  return Math.round(gap / 1000);
}

export class Recorder {
  constructor({ tuner, from, to, workDir, ffmpegPath = 'ffmpeg', now = Date.now }) {
    Object.assign(this, { from, to, workDir, ffmpegPath, now });
    this.folders = []; // { key: tuner.id + run, dir, srcDir, run, copied: Set<seq>, spans: [] }
    this.tuner = null;
    this.onPiece = (r) => this.copyRun(r);
    this.stopped = false;
    this.pending = tuner;
    this.chain = Promise.resolve(); // copies run one after another, off the event loop's critical path
  }

  start() {
    fs.mkdirSync(this.workDir, { recursive: true });
    if (this.pending) this.attach(this.pending);
    this.pending = null;
    return this;
  }

  /** Every copy asked for so far has been made. */
  idle() {
    return this.chain;
  }

  /** Follow a (new) tuner of the channel: after the old one ended, the next pieces come from this one. */
  attach(tuner) {
    if (this.tuner) this.tuner.off('piece', this.onPiece);
    this.tuner = tuner;
    tuner.on('piece', this.onPiece);
    for (const r of tuner.runs) this.copyRun(r);
  }

  folderFor(r) {
    const key = `${this.tuner.id}:${r.run}`;
    let f = this.folders.find((x) => x.key === key);
    if (!f) {
      f = { key, dir: path.join(this.workDir, `part-${this.folders.length + 1}`), srcDir: path.join(this.tuner.dir, `run-${r.run}`), run: r.run, copied: new Set(), queued: new Set(), spans: [], init: false };
      this.folders.push(f);
    }
    return f;
  }

  /**
   * Queue copies of the run's pieces inside the window not copied yet (the run's init piece with the first). The
   * copies are asynchronous (a recording started mid-programme copies up to 30 minutes of buffer).
   */
  copyRun(r) {
    if (this.stopped || r.start == null) return;
    for (const p of r.pieces) {
      const a = r.start + p.t;
      const b = a + p.d;
      if (b <= this.from || a >= this.to) continue;
      const f = this.folderFor(r);
      if (f.queued.has(p.seq)) continue;
      f.queued.add(p.seq);
      const name = `seg-${r.run}-${String(p.seq).padStart(6, '0')}.m4s`;
      this.chain = this.chain.then(async () => {
        if (this.stopped && !this.finishing) return;
        try {
          if (!f.init) {
            await fs.promises.mkdir(f.dir, { recursive: true });
            await fs.promises.copyFile(path.join(f.srcDir, `init-${r.run}.mp4`), path.join(f.dir, 'init.mp4'));
            f.init = true;
          }
          await fs.promises.copyFile(path.join(f.srcDir, name), path.join(f.dir, name));
          f.copied.add(p.seq);
          f.spans.push({ a, b, seq: p.seq, d: p.d, name });
        } catch {
          /* the piece left the buffer (or the tuner closed) before it could be copied */
        }
      });
    }
  }

  gapSeconds() {
    return holes(this.folders.flatMap((f) => f.spans));
  }

  get copiedPieces() {
    return this.folders.reduce((n, f) => n + f.copied.size, 0);
  }

  /**
   * Stop copying (the copies already queued finish), join what was copied into `outFile` (.mkv), remove the work
   * folder. A failed join keeps the work folder (finishLeftover() can still save it) and rejects.
   */
  async finish(outFile) {
    this.finishing = true;
    this.stopped = true;
    this.tuner?.off('piece', this.onPiece);
    await this.chain;
    const parts = [];
    for (const f of this.folders) {
      if (!f.copied.size || !f.init) continue;
      parts.push(partPlaylist(f.dir, [...f.spans].sort((x, y) => x.seq - y.seq)));
    }
    if (!parts.length) {
      this.abort();
      throw emptyError();
    }
    const gapSeconds = this.gapSeconds();
    await joinParts(this.ffmpegPath, parts, outFile, this.workDir);
    this.abort();
    return { file: outFile, gapSeconds };
  }

  abort() {
    this.suspend();
    fs.rmSync(this.workDir, { recursive: true, force: true });
  }

  /** Atomix is stopping: stop copying, keep the work folder (the next start finishes it and records part 2). */
  suspend() {
    this.stopped = true;
    this.tuner?.off('piece', this.onPiece);
  }
}

/**
 * A channel the tuner can't buffer (no fMP4 tag for its codecs, or no first piece in time): its own ffmpeg copies the
 * provider's stream into MPEG-TS files, a new file after each drop, joined at the end.
 */
export class DirectRecorder {
  constructor({ url, headers = {}, workDir, ffmpegPath = 'ffmpeg', now = Date.now }) {
    Object.assign(this, { url, headers, workDir, ffmpegPath, now });
    this.files = [];
    this.proc = null;
    this.stopped = false;
    this.spans = [];
    this.retry = null;
  }

  start() {
    fs.mkdirSync(this.workDir, { recursive: true });
    this.spawnNext();
    return this;
  }

  spawnNext() {
    this.retry = null;
    if (this.stopped) return;
    const file = path.join(this.workDir, `direct-${this.files.length + 1}.ts`);
    this.files.push(file);
    const span = { a: this.now(), b: null };
    this.spans.push(span);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...liveInputArgs(this.headers), '-i', this.url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', file];
    const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    this.proc = proc;
    proc.on('error', () => {});
    proc.on('close', () => {
      span.b = this.now();
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return proc.emit('finished');
      // A provider that keeps refusing is asked less often: 2 s, doubling to 60 s; a connection that lasted resets it.
      this.retryDelay = span.b - span.a > 30_000 || !this.retryDelay ? 2000 : Math.min(60_000, this.retryDelay * 2);
      this.retry = setTimeout(() => this.spawnNext(), this.retryDelay);
      this.retry.unref?.();
    });
  }

  gapSeconds() {
    return holes(this.spans.map((s) => ({ a: s.a, b: s.b ?? this.now() })));
  }

  async finish(outFile) {
    this.stopped = true;
    clearTimeout(this.retry);
    const proc = this.proc;
    if (proc) {
      const done = new Promise((r) => proc.once('finished', r));
      proc.kill('SIGINT');
      const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await done;
      clearTimeout(t);
    }
    const parts = this.files.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0);
    if (!parts.length) {
      this.abort();
      throw emptyError();
    }
    const gapSeconds = this.gapSeconds();
    await joinParts(this.ffmpegPath, parts, outFile, this.workDir);
    this.abort();
    return { file: outFile, gapSeconds };
  }

  abort() {
    this.suspend();
    fs.rmSync(this.workDir, { recursive: true, force: true });
  }

  suspend() {
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.proc) this.proc.kill('SIGKILL');
  }
}
