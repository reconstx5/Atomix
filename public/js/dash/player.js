// A small DASH player for encrypted live channels: one MediaSource with a SourceBuffer for video and one for audio,
// fed from Atomix's relayed manifest (re-read as a live manifest changes), keys from the browser's own key system
// (eme.js), quality chosen by abr.js. The pure decisions are exported and tested in Node; the class runs in the
// browser. Every address it fetches is Atomix's (the relay), never the provider's.
import { parseMpd } from './mpd.js';
import { segmentsAt, liveEdge, clockOffset } from './timeline.js';
import { pickRepresentation } from './abr.js';
import { setupKeys, WONT_PLAY, NO_WIDEVINE, NO_WIDEVINE_IPHONE, NO_FAIRPLAY, REFUSED, NOT_ANSWERING, UNREADABLE, EXPIRED, NEED_SECURE, mseType } from './eme.js';

export { mseType, UNREADABLE };
const AHEAD = 30; // seconds buffered ahead at most
const AHEAD_MOBILE = 10; // v0.27: on mobile data (Save-Data, or a cellular connection)
export const LOWER_QUALITY = "This phone's protection won't play HD; playing a lower quality";

/** v0.27: how far ahead to buffer: less on mobile data. `connection` is navigator.connection (Safari has none). */
export function aheadFor(connection) {
  return connection && (connection.saveData || connection.type === 'cellular') ? AHEAD_MOBILE : AHEAD;
}

/**
 * v0.27: the levels whose key isn't refused (a representation's own key id, else its set's). [] when none is left;
 * keys no level uses change nothing.
 */
export function playableLevels(reps, restricted, setProtection = []) {
  const refused = new Set(restricted);
  const kidOf = (r) => (r.contentProtection || []).find((c) => c.kid)?.kid || setProtection.find((c) => c.kid)?.kid || null;
  return reps.filter((r) => !refused.has(kidOf(r)));
}
const KEEP_BEHIND = 30;
const STALL_MS = 4000;
const RETRIES = [500, 1000, 2000];
const MAX_SKIPS = 4;
const EPS = 1e-3;
const START_MS = 20_000; // nothing decodable this long after starting: say why instead of spinning
const STARVED_MS = 30_000; // playing, out of data, and nothing new for this long: the channel has stopped
const NO_KEY = "The playlist doesn't have the key for this channel";
const SENTENCES = new Set([UNREADABLE, WONT_PLAY, NO_WIDEVINE, REFUSED, NOT_ANSWERING, NO_KEY, EXPIRED, NEED_SECURE, LOWER_QUALITY, NO_WIDEVINE_IPHONE, NO_FAIRPLAY]);

/** What the person is told for an error: one of the spec's sentences, never a browser's own message. */
export function sentenceOf(err) {
  const text = typeof err === 'string' ? err : err?.sentence || err?.message;
  return SENTENCES.has(text) ? text : UNREADABLE;
}

/** What an init segment and timestamp offset belong to: the period too (ids repeat across periods). */
export function initKey(period, rep) {
  const t = rep.template || {};
  return [period.id ?? '', period.start, rep.id, rep.baseUrl ?? '', t.initialization ?? '', t.presentationTimeOffset ?? 0, t.timescale ?? 1].join('|');
}

/** Can the player address this representation's segments (a SegmentTemplate with media)? */
export const hasSegments = (rep) => Boolean(rep?.template?.media);

/** The segment to fetch after `cursor` (presentation seconds): the first that ends after it; null when none yet. */
export function nextSegment(segments, cursor) {
  return segments.find((s) => s.end > cursor + EPS) || null;
}

/** The buffered ranges (or parts) more than `keepBehind` seconds behind the playhead: what to remove. */
export function trimRanges(buffered, currentTime, keepBehind = KEEP_BEHIND) {
  const limit = currentTime - keepBehind;
  return buffered.filter(([start]) => start < limit).map(([start, end]) => [start, Math.min(end, limit)]);
}

/** Where to start: a live stream's live edge, a static one's first segment. */
export function liveStart(mpd, segments) {
  if (!segments.length) return 0;
  if (mpd.type !== 'dynamic') return segments[0].start;
  return Math.max(segments[0].start, liveEdge(mpd, segments));
}

/** The period to play: the first with video, else the first with audio. */
export function periodToPlay(mpd) {
  const has = (p, type) => p.adaptationSets.some((a) => a.type === type && a.representations.length);
  return mpd.periods.find((p) => has(p, 'video')) || mpd.periods.find((p) => has(p, 'audio')) || null;
}

/**
 * One SourceBuffer's work in order: an append, a remove, a changeType or a timestampOffset never overlaps another,
 * and each step's listeners are removed once it's done. `sync` steps (changeType, timestampOffset) finish at once.
 */
export function sbQueue(sb) {
  let tail = Promise.resolve();
  const settle = () => {
    const ac = new AbortController();
    const done = new Promise((resolve, reject) => {
      sb.addEventListener('updateend', () => (ac.abort(), resolve()), { signal: ac.signal });
      sb.addEventListener('error', () => (ac.abort(), reject(new Error('append failed'))), { signal: ac.signal });
    });
    return { done, cancel: () => ac.abort() };
  };
  return {
    run(fn, { sync = false } = {}) {
      const job = tail.then(async () => {
        while (sb.updating) await settle().done;
        if (sync) return fn(sb);
        const w = settle();
        try {
          fn(sb);
        } catch (err) {
          w.cancel();
          throw err;
        }
        return w.done;
      });
      tail = job.catch(() => {});
      return job;
    },
  };
}

/** Where a stalled playhead goes: a static stream steps 0.1 s forward; a live one goes to the live point. */
export function stallNudge(mpd, currentTime, segments) {
  return mpd.type === 'dynamic' ? liveStart(mpd, segments) : currentTime + 0.1;
}

/** The video levels as one comparable string (a refresh that changes them tells the Quality menu). */
const levelsKey = (reps) => [...reps].sort((a, b) => b.bandwidth - a.bandwidth).map((r) => `${r.id}:${r.bandwidth}:${r.height}`).join(',');
const levelsOf = (reps) => [...reps].sort((a, b) => b.bandwidth - a.bandwidth).map((r) => ({ id: r.id, height: r.height, bandwidth: r.bandwidth }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contentType = mseType;
const rangesOf = (sb) => {
  const out = [];
  try {
    for (let i = 0; i < sb.buffered.length; i++) out.push([sb.buffered.start(i), sb.buffered.end(i)]);
  } catch {
    /* removed from the MediaSource */
  }
  return out;
};

export class DashPlayer {
  /**
   * @param {HTMLVideoElement} video
   * @param {{ manifest: string, licence: string, keySystem: string, timeUrl?: string, onError?: (sentence: string) => void,
   *   onLevels?: (levels: { id: string, height: number|null, bandwidth: number }[]) => void, onStall?: (on: boolean) => void }} opts
   */
  constructor(video, { manifest, licence, keySystem, timeUrl = null, serverCertificate = null, initData = null, ahead = AHEAD, onError = () => {}, onLevels = () => {}, onStall = () => {}, onEnded = () => {}, onNotice = () => {}, fetch = globalThis.fetch.bind(globalThis) }) {
    Object.assign(this, { video, manifestUrl: manifest, licence, keySystem, timeUrl, serverCertificate, initData, ahead, onError, onLevels, onStall, onEnded, onNotice, fetch });
    this.restricted = new Set(); // key ids the device refuses (v0.27)
    this.refreshMinMs = 2000;
    this.offset = 0;
    this.fixed = null; // a level chosen in the Quality menu (null = Auto)
    this.throughput = null;
    this.destroyed = false;
    this.failed = false;
    this.controllers = new Set();
    this.timers = [];
    this.tracks = [];
    this.inits = new Map();
    this.listeners = [];
  }

  now() {
    return Date.now() + this.offset;
  }

  get level() {
    return this.fixed ?? 'auto';
  }

  /** The video level being fetched now. */
  get currentLevel() {
    return this.tracks.find((t) => t.kind === 'video')?.rep?.id ?? null;
  }

  setLevel(id) {
    this.fixed = id === 'auto' ? null : String(id);
  }

  /** The video levels the device can decrypt (all of them until a key is refused). */
  playable(reps) {
    if (!this.restricted.size) return reps;
    const ok = playableLevels(reps, [...this.restricted], this.tracks.find((t) => t.kind === 'video')?.as?.contentProtection || []);
    return ok.length ? ok : reps;
  }

  /** v0.27: keys the device refuses (output protection): drop their levels, once said; none left is "won't play". */
  restrict(kids) {
    const fresh = kids.filter((k) => !this.restricted.has(k));
    if (!fresh.length || this.destroyed) return;
    const t = this.tracks.find((x) => x.kind === 'video');
    const reps = t?.as?.representations || [];
    const before = playableLevels(reps, [...this.restricted], t?.as?.contentProtection || []);
    for (const k of fresh) this.restricted.add(k);
    if (!t) return;
    const ok = playableLevels(reps, [...this.restricted], t.as.contentProtection || []);
    if (ok.length === before.length) return; // keys no level uses
    if (!ok.length) return this.fail(WONT_PLAY);
    if (this.fixed && !ok.some((r) => r.id === this.fixed)) this.fixed = null;
    if (!ok.includes(t.rep)) t.rep = this.pick(reps, null);
    if (!this.lowered) {
      this.lowered = true;
      this.onNotice(LOWER_QUALITY);
    }
    this.lastLevels = levelsKey(ok);
    this.onLevels(levelsOf(ok));
  }

  async get(url, as = 'text') {
    if (this.destroyed) throw new Error('stopped');
    // Only Atomix's own addresses (the relay): never a provider's, whatever a manifest says.
    if (new URL(url, location.href).origin !== location.origin) throw new Error(UNREADABLE);
    const ac = new AbortController();
    this.controllers.add(ac);
    try {
      const res = await this.fetch(url, { signal: ac.signal, credentials: 'same-origin' });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return as === 'text' ? await res.text() : await res.arrayBuffer();
    } finally {
      this.controllers.delete(ac);
    }
  }

  fail(sentence) {
    if (this.destroyed || this.failed) return;
    this.failed = true;
    this.destroy();
    this.onError(sentence);
  }

  on(target, name, fn) {
    target.addEventListener(name, fn);
    this.listeners.push(() => target.removeEventListener(name, fn));
  }

  async loadManifest() {
    const text = await this.get(this.manifestUrl);
    return parseMpd(text, new URL(this.manifestUrl, location.href).href);
  }

  async start() {
    try {
      await this.open();
    } catch (err) {
      this.lastError = err;
      if (!this.destroyed) this.fail(sentenceOf(err));
    }
  }

  async open() {
    if (!globalThis.MediaSource) throw Object.assign(new Error(WONT_PLAY), { sentence: WONT_PLAY });
    if (this.timeUrl) {
      try {
        this.offset = clockOffset(await this.get(this.timeUrl), Date.now());
      } catch {
        this.offset = 0;
      }
    }
    let mpd;
    try {
      mpd = await this.loadManifest();
    } catch {
      throw new Error(UNREADABLE);
    }
    if (this.destroyed) return;
    this.mpd = mpd;
    this.period = periodToPlay(mpd);
    if (!this.period) throw new Error(UNREADABLE);
    const sets = this.choose(this.period);
    if (!sets.video && !sets.audio) throw new Error(WONT_PLAY);
    await this.openKeys(sets);
    if (this.destroyed) return this.keys.close();
    if (sets.video) {
      this.lastLevels = levelsKey(sets.video.representations);
      this.onLevels(levelsOf(sets.video.representations));
    }

    this.ms = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.ms);
    const opened = new Promise((resolve) => this.ms.addEventListener('sourceopen', resolve, { once: true }));
    this.video.src = this.objectUrl;
    await opened;
    if (this.destroyed) return;
    if (mpd.type === 'dynamic') {
      try {
        this.ms.duration = Infinity;
      } catch {
        /* some browsers refuse; the seekable range still works */
      }
    }
    for (const kind of ['video', 'audio']) {
      const as = sets[kind];
      if (!as) continue;
      const rep = kind === 'video' ? this.pick(as.representations, null) : as.representations[0];
      const sb = this.ms.addSourceBuffer(contentType(rep));
      this.tracks.push({ kind, as, rep, sb, q: sbQueue(sb), cursor: 0, skips: 0, initFor: null, done: false, gen: 0 });
    }
    const first = this.tracks[0];
    const segs = segmentsAt(first.rep, this.period, mpd, this.now()).segments;
    const start = liveStart(mpd, segs);
    for (const t of this.tracks) t.cursor = start;
    this.updateSeekable(segs);
    this.video.currentTime = start;
    this.watch();
    for (const t of this.tracks) this.pump(t);
    if (mpd.type === 'dynamic') this.refreshLoop();
  }

  /** The browser's key system for an encrypted channel; nothing for a clear one (a tuner's buffer). */
  async openKeys(sets) {
    if (!this.keySystem) {
      this.keys = { close: () => Promise.resolve() };
      return;
    }
    const cp = [sets.video, sets.audio].filter(Boolean).flatMap((as) => [...(as.contentProtection || []), ...as.representations.flatMap((r) => r.contentProtection || [])]);
    this.keysSetup = setupKeys(this.video, {
      keySystem: this.keySystem,
      licenceUrl: this.licence,
      contentProtection: cp,
      tracks: { video: sets.video?.representations || [], audio: sets.audio?.representations || [] },
      serverCertificate: this.serverCertificate,
      initData: this.initData,
      isStale: () => this.destroyed,
      onError: (sentence) => this.fail(sentence),
      onRestricted: (kids) => this.restrict(kids),
    });
    this.keys = await this.keysSetup;
  }

  /** The segments of the first track now (the window a live manifest offers). */
  currentSegments() {
    return this.tracks.length ? segmentsAt(this.tracks[0].rep, this.period, this.mpd, this.now()).segments : [];
  }

  /** The seekable window in presentation seconds: its first piece, the live point, its last piece's end. */
  window() {
    const segs = this.currentSegments();
    if (!segs.length) return null;
    return { start: segs[0].start, live: this.mpd.type === 'dynamic' ? liveStart(this.mpd, segs) : segs.at(-1).end, end: segs.at(-1).end };
  }

  /** Go to `t` (presentation seconds) inside the window: the tracks fetch from there (pause, rewind, Live). */
  seek(t) {
    const w = this.window();
    if (!w) return;
    const to = Math.max(w.start, Math.min(w.live, Number(t) || 0));
    for (const tr of this.tracks) {
      const have = rangesOf(tr.sb).some(([s, e]) => s <= to && to < e);
      if (!have) {
        tr.cursor = to;
        tr.gen++; // a download in flight for the old position mustn't move the cursor back
      }
    }
    this.video.currentTime = to;
  }

  /** The playhead fell behind the window (paused too long): the oldest point kept, and the viewer is told. */
  checkWindow(segs) {
    if (!this.video.paused) this.pauseNoticed = false; // playing again: a later pause may say it again
    if (this.mpd.type !== 'dynamic' || !segs.length || this.video.currentTime >= segs[0].start) return false;
    this.seek(segs[0].start + 1);
    // Said once per pause: while still paused the window keeps moving past the playhead.
    if (!this.pauseNoticed) this.onNotice('You were paused too long — playing from the earliest point kept');
    if (this.video.paused) this.pauseNoticed = true;
    return true;
  }

  /** Move every track on to the period after this one, when the live manifest has one. */
  advancePeriod() {
    const i = this.mpd.periods.indexOf(this.period);
    const ids = this.mpd.periods.map((p) => p.id);
    const at = i >= 0 ? i : ids.indexOf(this.period?.id);
    const next = at >= 0 ? this.mpd.periods[at + 1] : null;
    if (!next) return false;
    const sets = this.choose(next);
    this.period = next;
    this.periodJump = next.start; // the playhead crosses the gap between the periods when it gets there
    for (const t of this.tracks) {
      const as = sets[t.kind];
      if (!as) continue;
      t.as = as;
      t.rep = t.kind === 'video' ? this.pick(as.representations, null) : as.representations[0];
      t.initFor = null;
      if (t.cursor < next.start) t.cursor = next.start;
      t.gen++;
    }
    return true;
  }

  /** At the end of an earlier period's pieces (a reconnect left a gap): jump to where the next period begins. */
  crossGap() {
    const to = this.periodJump;
    if (to == null) return false;
    const t = this.video.currentTime;
    if (t >= to) {
      this.periodJump = null;
      return false;
    }
    const ranges = this.tracks.length ? rangesOf(this.tracks[0].sb) : [];
    if (ranges.some(([s, e]) => s <= t && t < e - 0.2)) return false; // still playing the old period
    if (!ranges.some(([s]) => s >= to - 0.1)) return false; // the next period isn't buffered yet
    this.periodJump = null;
    this.video.currentTime = to + 0.05;
    return true;
  }

  /** The video set, and an audio set in the browser's language when there's a choice. */
  choose(period) {
    const playable = (as) => ({ ...as, representations: as.representations.filter((r) => r.mimeType && r.codecs && hasSegments(r) && MediaSource.isTypeSupported(contentType(r))) });
    const video = period.adaptationSets.filter((a) => a.type === 'video').map(playable).find((a) => a.representations.length) || null;
    const audios = period.adaptationSets.filter((a) => a.type === 'audio').map(playable).filter((a) => a.representations.length);
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const audio = audios.find((a) => (a.lang || '').toLowerCase().startsWith(lang)) || audios[0] || null;
    return { video, audio };
  }

  pick(all, current) {
    const reps = this.playable(all);
    if (this.fixed) return reps.find((r) => r.id === this.fixed) || current || reps[0];
    const ahead = current ? this.bufferedAhead(this.tracks.find((t) => t.kind === 'video')?.sb) : 0;
    return pickRepresentation(reps, { throughputBps: this.throughput, bufferedSec: ahead, maxHeight: (this.video.clientHeight || 720) * (globalThis.devicePixelRatio || 1), current });
  }

  bufferedAhead(sb) {
    if (!sb) return 0;
    const t = this.video.currentTime;
    const r = rangesOf(sb).find(([s, e]) => s - 0.5 <= t && t < e);
    return r ? r[1] - t : 0;
  }

  async append(t, data) {
    try {
      await t.q.run((sb) => sb.appendBuffer(data));
    } catch (err) {
      if (err?.name !== 'QuotaExceededError') throw err;
      await this.trim(t, 10);
      await t.q.run((sb) => sb.appendBuffer(data)); // a second QuotaExceededError ends the channel (the caller's catch)
    }
  }

  async trim(t, keep = KEEP_BEHIND) {
    if (this.endedSent) return; // after endOfStream a remove would reopen the MediaSource and the video never ends
    for (const [a, b] of trimRanges(rangesOf(t.sb), this.video.currentTime, keep)) {
      if (this.destroyed) return;
      await t.q.run((sb) => sb.remove(a, b));
    }
  }

  /** A segment, retried a few times; only video segments feed the throughput estimate (audio ones are tiny). */
  async fetchSegment(url, { kind = null } = {}) {
    for (let i = 0; ; i++) {
      try {
        const began = performance.now();
        const data = await this.get(url, 'bytes');
        if (kind === 'video') {
          const secs = Math.max(0.05, (performance.now() - began) / 1000);
          const bps = (data.byteLength * 8) / secs;
          this.throughput = this.throughput == null ? bps : 0.7 * this.throughput + 0.3 * bps;
        }
        return data;
      } catch (err) {
        if (this.destroyed || err?.name === 'AbortError' || i >= RETRIES.length) return null;
        await sleep(RETRIES[i]);
      }
    }
  }

  async pump(t) {
    try {
      while (!this.destroyed) {
        if (this.bufferedAhead(t.sb) >= this.ahead) {
          await sleep(500);
          continue;
        }
        if (t.kind === 'video') t.rep = this.pick(t.as.representations, t.rep);
        const key = initKey(this.period, t.rep);
        if (t.initFor !== key) {
          let init = this.inits.get(key);
          const tpl = t.rep.template;
          if (!init && tpl?.initialization) {
            const url = segmentsAt(t.rep, this.period, this.mpd, this.now()).init;
            init = url ? await this.fetchSegment(url) : null;
            if (!init) throw new Error(UNREADABLE);
            this.inits.set(key, init);
          }
          if (this.destroyed) return;
          const offset = this.period.start - (tpl?.presentationTimeOffset || 0) / (tpl?.timescale || 1);
          const type = t.sb.changeType && t.initFor ? contentType(t.rep) : null;
          await t.q.run(
            (sb) => {
              if (type) sb.changeType(type);
              sb.timestampOffset = offset;
            },
            { sync: true },
          );
          if (init) await this.append(t, init);
          t.initFor = key;
        }
        const segs = segmentsAt(t.rep, this.period, this.mpd, this.now()).segments;
        const seg = nextSegment(segs, t.cursor);
        if (!seg) {
          if (this.mpd.type !== 'dynamic') return this.finish(t);
          // This period has no more pieces and a later one has begun (a reconnect): carry on there.
          if (this.advancePeriod()) continue;
          await sleep(500);
          continue;
        }
        const gen = t.gen;
        const data = await this.fetchSegment(seg.url, { kind: t.kind });
        if (this.destroyed) return;
        if (t.gen !== gen) continue; // jumped to the live edge meanwhile: this one is behind it
        if (!data) {
          t.cursor = seg.end; // give up on this one; the next may be there
          if (++t.skips >= MAX_SKIPS) throw new Error(UNREADABLE);
          continue;
        }
        t.skips = 0;
        await this.append(t, data);
        this.lastAppend = Date.now();
        if (t.gen === gen) t.cursor = seg.end;
      }
    } catch (err) {
      this.lastError = Object.assign(err instanceof Error ? err : new Error(String(err)), { track: t.kind });
      if (!this.destroyed) this.fail(UNREADABLE);
    }
  }

  finish(t) {
    t.done = true;
    if (!this.tracks.every((x) => x.done)) return;
    if (this.ms?.readyState === 'open') {
      try {
        this.ms.endOfStream();
      } catch {
        /* already ended */
      }
    }
    if (!this.endedSent) {
      this.endedSent = true;
      this.onEnded();
    }
  }

  updateSeekableFor(period, mpd) {
    if (this.tracks.length) this.updateSeekable(segmentsAt(this.tracks[0].rep, period, mpd, this.now()).segments);
  }

  updateSeekable(segs) {
    if (!segs.length || this.mpd.type !== 'dynamic' || !this.ms?.setLiveSeekableRange) return;
    try {
      this.ms.setLiveSeekableRange(segs[0].start, segs.at(-1).end);
    } catch {
      /* not open */
    }
  }

  async refreshLoop() {
    let failures = 0;
    while (!this.destroyed) {
      await sleep(Math.max(this.refreshMinMs, (this.mpd.minimumUpdatePeriod || 0) * 1000));
      if (this.destroyed) return;
      try {
        const mpd = await this.loadManifest();
        const period = mpd.periods.find((p) => p.id != null && p.id === this.period.id) || periodToPlay(mpd);
        if (!period) throw new Error(UNREADABLE);
        this.mpd = mpd;
        this.period = period;
        for (const t of this.tracks) {
          const as = period.adaptationSets.find((a) => a.type === t.kind && (a.id == null || a.id === t.as.id)) || period.adaptationSets.find((a) => a.type === t.kind);
          if (!as) continue;
          const reps = as.representations.filter((r) => r.mimeType && r.codecs && hasSegments(r) && MediaSource.isTypeSupported(contentType(r)));
          if (!reps.length) continue;
          t.as = { ...as, representations: reps };
          t.rep = reps.find((r) => r.id === t.rep.id) || (t.kind === 'video' ? this.pick(reps, null) : reps[0]);
          if (t.kind === 'video' && levelsKey(this.playable(reps)) !== this.lastLevels) {
            this.lastLevels = levelsKey(this.playable(reps));
            this.onLevels(levelsOf(this.playable(reps)));
          }
        }
        this.updateSeekableFor(period, mpd);
        failures = 0;
        if (mpd.type !== 'dynamic') return; // the programme ended: nothing more to read
      } catch {
        if (this.destroyed) return;
        if (++failures >= 3) return this.fail(UNREADABLE);
      }
    }
  }

  /** Stalls, falling behind the window, gaps at the start, trimming, and the video's own errors. */
  watch() {
    let lastTime = -1;
    let stuckSince = null;
    this.started = Date.now();
    this.lastAppend = Date.now();
    this.decoding = false;
    this.waitingKey = false;
    this.on(this.video, 'playing', () => (this.decoding = true));
    this.on(this.video, 'waitingforkey', () => (this.waitingKey = true));
    this.on(this.video, 'waiting', () => this.onStall(true));
    this.on(this.video, 'playing', () => this.onStall(false));
    this.on(this.video, 'error', () => {
      this.lastError = this.video.error;
      this.fail(UNREADABLE);
    });
    const tick = () => {
      if (this.destroyed) return;
      const v = this.video;
      const t = v.currentTime;
      if (v.readyState >= 3) this.decoding = true;
      if (!this.decoding && Date.now() - this.started > START_MS) return this.fail(this.waitingKey ? WONT_PLAY : UNREADABLE);
      if (this.mpd.type === 'dynamic' && !v.paused && this.tracks.every((x) => this.bufferedAhead(x.sb) < 2) && Date.now() - this.lastAppend > STARVED_MS) return this.fail(UNREADABLE);
      const segs = this.tracks.length ? segmentsAt(this.tracks[0].rep, this.period, this.mpd, this.now()).segments : [];
      if (this.crossGap()) return;
      // A gap: the playhead in no buffered range, data starting just ahead → step over it.
      const ranges = this.tracks.length ? rangesOf(this.tracks[0].sb) : [];
      if (!ranges.some(([s, e]) => s <= t && t < e)) {
        const ahead = ranges.find(([s]) => s > t && s - t < 3);
        if (ahead) v.currentTime = ahead[0] + 0.05;
      }
      if (!v.paused && Math.abs(t - lastTime) < 0.01) stuckSince ??= Date.now();
      else stuckSince = null;
      if (this.checkWindow(segs)) {
        stuckSince = null;
      } else if (stuckSince && Date.now() - stuckSince > STALL_MS) {
        stuckSince = null;
        if (this.mpd.type === 'dynamic') this.jumpToLive(segs);
        else v.currentTime = stallNudge(this.mpd, t, segs); // a static stream: step over the hole, never back to the start
      }
      lastTime = t;
    };
    this.timers.push(setInterval(tick, 1000));
    this.timers.push(setInterval(() => this.tracks.forEach((t) => this.trim(t).catch(() => {})), 5000));
  }

  jumpToLive(segs) {
    if (!segs.length) return;
    const start = liveStart(this.mpd, segs);
    for (const t of this.tracks) {
      const have = rangesOf(t.sb).some(([s, e]) => s <= start && start < e);
      if (!have) {
        t.cursor = start;
        t.gen++; // a download in flight for the old position mustn't move the cursor back
      }
    }
    this.video.currentTime = start;
  }

  destroy() {
    if (this.destroyed) return this.released || Promise.resolve();
    this.destroyed = true;
    for (const id of this.timers) clearInterval(id);
    for (const ac of this.controllers) ac.abort();
    for (const off of this.listeners) off();
    try {
      if (this.ms?.readyState === 'open') this.ms.endOfStream();
    } catch {
      /* already closed */
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    if (this.video.getAttribute('src') === this.objectUrl) {
      this.video.removeAttribute('src');
      this.video.load();
    }
    // The keys' release (the next channel waits for it before using the video).
    // Keys still being set up: the release waits for them (they may be attaching right now) and closes them.
    this.released = this.keys ? this.keys.close().catch(() => {}) : this.keysSetup ? this.keysSetup.then((k) => k.close(), () => {}).catch(() => {}) : Promise.resolve();
    return this.released;
  }
}
