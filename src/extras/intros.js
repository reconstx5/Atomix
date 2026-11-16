// Finding intros, credits and recaps in TV episodes: chapter names first, then the longest stretch of sound a
// season's episodes share (the theme tune at the start; v0.28: the ending theme at the end), then (v0.28, when an
// admin allows it) TheIntroDB's shared timestamps for what is still missing.
import { parseJson } from '../db.js';
import { run } from '../library/probe.js';
import { fingerprint, SAMPLE_RATE } from './fingerprint.js';
import { createMatcher } from './matcher.js';
import { fetchSegments } from './community.js';
import { INTROS_VERSION } from './store.js';

const INTRO_TITLES = new Set(['intro', 'opening', 'opening credits', 'op', 'title sequence', 'main titles']);
const CREDITS_TITLES = new Set(['credits', 'end credits', 'ending', 'ed', 'outro', 'closing credits']);
const RECAP_TITLES = new Set(['recap', 'previously', 'previously on', 'last time', 'previously on…', 'previously on...']);

/** ffprobe chapters → { intro, credits } and, when there is one, recap (first chapter of each kind wins). */
export function markersFromChapters(chapters = []) {
  const out = { intro: null, credits: null };
  for (const c of chapters || []) {
    const title = String(c?.tags?.title ?? '').trim().toLowerCase();
    const start = Number(c?.start_time);
    const end = Number(c?.end_time);
    if (!Number.isFinite(start) || !(end > start)) continue;
    if (!out.intro && INTRO_TITLES.has(title)) out.intro = { start, end };
    else if (!out.credits && CREDITS_TITLES.has(title)) out.credits = { start, end };
    else if (!out.recap && RECAP_TITLES.has(title)) out.recap = { start, end };
  }
  return out;
}

/** v0.28: the end of an episode searched for the ending theme a season shares: the last quarter, at most 5 minutes. */
export function endWindow(duration) {
  const length = Math.min(300, 0.25 * duration);
  return { start: duration - length, length };
}

/** The ffmpeg argv for the end of an episode's main audio track. */
function endFingerprintArgs(file, duration, audioIndex = 0) {
  const w = endWindow(duration);
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', w.start.toFixed(2), '-i', file, '-t', w.length.toFixed(2), '-map', `0:a:${Number(audioIndex) || 0}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
}

export async function readChapters(ffprobePath, file, { onSpawn } = {}) {
  const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_chapters', file], { timeout: 60000, onSpawn });
  return JSON.parse(out.toString('utf8')).chapters || [];
}

/** How much of the start of an episode to search, in seconds. */
export const searchWindow = (duration) => Math.min(600, 0.4 * duration);

/** The ffmpeg argv that pulls the first part of an episode's main audio track for fingerprinting. */
export function fingerprintArgs(file, duration, audioIndex = 0) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-t', searchWindow(duration).toFixed(2), '-map', `0:a:${Number(audioIndex) || 0}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'];
}

export async function audioFingerprint(ffmpegPath, file, duration, { onSpawn, matcher, audioIndex = 0, end = false } = {}) {
  const out = await run(ffmpegPath, end ? endFingerprintArgs(file, duration, audioIndex) : fingerprintArgs(file, duration, audioIndex), { timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, onSpawn });
  // Copy into a fresh ArrayBuffer (2-byte aligned) before reading it as 16-bit samples.
  const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + (out.length & ~1));
  const samples = new Int16Array(bytes);
  return matcher ? matcher.fingerprint(samples) : fingerprint(samples);
}

/** Who to compare an episode with, in order: next, next-but-one, previous, then another season's. */
export function partnersFor(ep, seasonEpisodes, otherSeason = null) {
  const i = seasonEpisodes.findIndex((e) => e.id === ep.id);
  const near = i < 0 ? [] : [seasonEpisodes[i + 1], seasonEpisodes[i + 2], seasonEpisodes[i - 1]];
  return [...near, otherSeason].filter((e) => e && e.id !== ep.id);
}

const checkable = (ep) => ep.duration >= 60 && (parseJson(ep.media, null)?.audio || []).length > 0;

/** Check a season's pending episodes and record markers and results. */
export async function runIntroJob({ seasonId, store, ffmpegPath, ffprobePath, signal, onSpawn, community = null }) {
  signal?.throwIfAborted();
  const pending = store.pendingIntroEpisodes(seasonId);
  if (!pending.length) return;
  const season = store.seasonEpisodes(seasonId);
  const other = store.otherSeasonEpisode(seasonId);
  // The maths runs in a worker thread so the server keeps answering; stopping the job stops it too.
  const matcher = createMatcher();
  const stop = () => matcher.close();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await checkSeason({ pending, season, other, store, ffmpegPath, ffprobePath, signal, onSpawn, matcher, community });
  } finally {
    signal?.removeEventListener('abort', stop);
    await matcher.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkSeason({ pending, season, other, store, ffmpegPath, ffprobePath, signal, onSpawn, matcher, community }) {
  const prints = new Map(); // `${episode id}:${start|end}` → { fp, error }
  async function printOf(ep, end = false) {
    const key = `${ep.id}:${end ? 'end' : 'start'}`;
    if (!prints.has(key)) {
      const entry = { fp: null, error: null };
      if (checkable(ep)) {
        try {
          entry.fp = await audioFingerprint(ffmpegPath, ep.path, ep.duration, { onSpawn, matcher, audioIndex: parseJson(ep.media, null)?.defaultAudio || 0, end });
        } catch (err) {
          signal?.throwIfAborted();
          entry.error = err.message;
        }
      }
      prints.set(key, entry);
    }
    signal?.throwIfAborted();
    return prints.get(key);
  }
  /** The longest stretch of sound this episode shares with a partner: { mine: {start,end}, theirs, partner } or null. */
  async function shared(ep, end) {
    const mine = await printOf(ep, end);
    if (!mine.fp) return { error: mine.error };
    const offset = (e) => (end ? endWindow(e.duration).start : 0);
    for (const partner of partnersFor(ep, season, other)) {
      const theirs = (await printOf(partner, end)).fp;
      if (!theirs) continue;
      const match = await matcher.compare(mine.fp, theirs);
      signal?.throwIfAborted();
      if (!match) continue;
      return { mine: { start: offset(ep) + match.aStart, end: offset(ep) + match.aEnd }, theirs: { start: offset(partner) + match.bStart, end: offset(partner) + match.bEnd }, partner };
    }
    return {};
  }
  const showTmdb = new Map();
  const tmdbOf = (ep) => {
    if (!showTmdb.has(ep.show_id)) showTmdb.set(ep.show_id, store.db.get('SELECT tmdb_id FROM items WHERE id = ?', ep.show_id)?.tmdb_id || null);
    return showTmdb.get(ep.show_id);
  };
  let asked = 0;

  for (const ep of pending) {
    signal?.throwIfAborted();
    try {
      // A replaced file (same name, e.g. an upgrade): what was found in the old one no longer applies.
      // Times an admin set by hand stay.
      const before = store.job(ep.id, 'intros');
      if (before && (before.source_size !== ep.size || before.source_mtime !== ep.mtime)) {
        for (const kind of ['intro', 'credits', 'recap']) store.deleteMarker(ep.id, kind, { sources: ['chapter', 'audio', 'community'] });
      }
      let chapters = { intro: null, credits: null };
      const probed = parseJson(ep.media, null)?.chapters; // in the summary since 0.15 (one ffprobe per file, at scan)
      try {
        chapters = markersFromChapters(Array.isArray(probed) ? probed.map((c) => ({ start_time: c.start, end_time: c.end, tags: { title: c.title } })) : await readChapters(ffprobePath, ep.path, { onSpawn }));
      } catch {
        signal?.throwIfAborted(); // no readable chapters: carry on with the audio
      }
      for (const kind of ['intro', 'credits', 'recap']) if (chapters[kind]) store.setMarker(ep.id, kind, { ...chapters[kind], source: 'chapter' });
      let failed = null;
      let found = Boolean(chapters.intro);
      // The theme tune at the start.
      if (!chapters.intro) {
        const m = await shared(ep, false);
        if (m.error) failed = m.error;
        if (m.mine) {
          store.setMarker(ep.id, 'intro', { ...m.mine, source: 'audio' });
          if (!store.markers(m.partner.id).intro) store.setMarker(m.partner.id, 'intro', { ...m.theirs, source: 'audio' });
          found = true;
        }
      }
      // v0.28: the ending theme at the end: the credits start where it does.
      if (!chapters.credits && !failed && ep.duration >= 60) {
        const m = await shared(ep, true);
        if (m.mine && m.mine.start > ep.duration * 0.5) {
          store.setMarker(ep.id, 'credits', { start: m.mine.start, end: ep.duration, source: 'audio' });
          const pc = store.markers(m.partner.id).credits;
          if (!pc || pc.source === 'community') store.setMarker(m.partner.id, 'credits', { start: m.theirs.start, end: m.partner.duration, source: 'audio' });
        }
      }
      // v0.28: TheIntroDB for what is still missing (an admin's switch; nothing is sent when it is off).
      const have = store.markers(ep.id);
      const tmdb = community ? tmdbOf(ep) : null;
      if (tmdb && (!have.intro || !have.credits || !have.recap)) {
        if (asked++) await sleep(community.spacingMs ?? 400);
        const got = await fetchSegments({ base: community.base, tmdbId: tmdb, season: ep.season, episode: ep.episode, duration: ep.duration, fetchImpl: community.fetchImpl });
        signal?.throwIfAborted();
        for (const kind of ['intro', 'recap', 'credits']) {
          if (got?.[kind] && !have[kind]) {
            store.setMarker(ep.id, kind, { ...got[kind], source: 'community' });
            if (kind === 'intro') found = true;
          }
        }
      }
      if (failed && !found) store.saveJob(ep, 'intros', { status: 'failed', error: failed, data: { v: INTROS_VERSION } });
      else store.saveJob(ep, 'intros', { status: found ? 'done' : 'none', data: { v: INTROS_VERSION } });
    } catch (err) {
      signal?.throwIfAborted();
      store.saveJob(ep, 'intros', { status: 'failed', error: err.message, data: { v: INTROS_VERSION } });
    }
  }
}
