// Finding intros (and credits) in TV episodes: chapter names first, then the
// longest stretch of sound a season's episodes share (the theme tune).
import { parseJson } from '../db.js';
import { run } from '../library/probe.js';
import { fingerprint, SAMPLE_RATE } from './fingerprint.js';
import { createMatcher } from './matcher.js';

const INTRO_TITLES = new Set(['intro', 'opening', 'opening credits', 'op', 'title sequence', 'main titles']);
const CREDITS_TITLES = new Set(['credits', 'end credits', 'ending', 'ed', 'outro', 'closing credits']);

/** ffprobe chapters → { intro, credits } (first chapter of each kind wins). */
export function markersFromChapters(chapters = []) {
  const out = { intro: null, credits: null };
  for (const c of chapters || []) {
    const title = String(c?.tags?.title ?? '').trim().toLowerCase();
    const start = Number(c?.start_time);
    const end = Number(c?.end_time);
    if (!Number.isFinite(start) || !(end > start)) continue;
    if (!out.intro && INTRO_TITLES.has(title)) out.intro = { start, end };
    else if (!out.credits && CREDITS_TITLES.has(title)) out.credits = { start, end };
  }
  return out;
}

export async function readChapters(ffprobePath, file, { onSpawn } = {}) {
  const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_chapters', file], { timeout: 60000, onSpawn });
  return JSON.parse(out.toString('utf8')).chapters || [];
}

/** How much of the start of an episode to search, in seconds. */
export const searchWindow = (duration) => Math.min(600, 0.4 * duration);

export async function audioFingerprint(ffmpegPath, file, duration, { onSpawn, matcher } = {}) {
  const out = await run(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-t', searchWindow(duration).toFixed(2), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
    { timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024, onSpawn },
  );
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
export async function runIntroJob({ seasonId, store, ffmpegPath, ffprobePath, signal, onSpawn }) {
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
    await checkSeason({ pending, season, other, store, ffmpegPath, ffprobePath, signal, onSpawn, matcher });
  } finally {
    signal?.removeEventListener('abort', stop);
    await matcher.close();
  }
}

async function checkSeason({ pending, season, other, store, ffmpegPath, ffprobePath, signal, onSpawn, matcher }) {
  const prints = new Map(); // episode id → { fp, error }
  async function printOf(ep) {
    if (!prints.has(ep.id)) {
      const entry = { fp: null, error: null };
      if (checkable(ep)) {
        try {
          entry.fp = await audioFingerprint(ffmpegPath, ep.path, ep.duration, { onSpawn, matcher });
        } catch (err) {
          signal?.throwIfAborted();
          entry.error = err.message;
        }
      }
      prints.set(ep.id, entry);
    }
    signal?.throwIfAborted();
    return prints.get(ep.id);
  }

  for (const ep of pending) {
    signal?.throwIfAborted();
    try {
      // A replaced file (same name, e.g. an upgrade): what was found in the old one no longer applies.
      // Times an admin set by hand stay.
      const before = store.job(ep.id, 'intros');
      if (before && (before.source_size !== ep.size || before.source_mtime !== ep.mtime)) {
        store.deleteMarker(ep.id, 'intro', { sources: ['chapter', 'audio'] });
        store.deleteMarker(ep.id, 'credits', { sources: ['chapter', 'audio'] });
      }
      let chapters = { intro: null, credits: null };
      try {
        chapters = markersFromChapters(await readChapters(ffprobePath, ep.path, { onSpawn }));
      } catch {
        signal?.throwIfAborted(); // no readable chapters: carry on with the audio
      }
      if (chapters.credits) store.setMarker(ep.id, 'credits', { ...chapters.credits, source: 'chapter' });
      if (chapters.intro) {
        store.setMarker(ep.id, 'intro', { ...chapters.intro, source: 'chapter' });
        store.saveJob(ep, 'intros', { status: 'done' });
        continue;
      }
      const mine = await printOf(ep);
      if (mine.error) {
        store.saveJob(ep, 'intros', { status: 'failed', error: mine.error });
        continue;
      }
      let found = false;
      if (mine.fp) {
        for (const partner of partnersFor(ep, season, other)) {
          const theirs = (await printOf(partner)).fp;
          if (!theirs) continue;
          const match = await matcher.compare(mine.fp, theirs);
          signal?.throwIfAborted();
          if (!match) continue;
          store.setMarker(ep.id, 'intro', { start: match.aStart, end: match.aEnd, source: 'audio' });
          if (!store.markers(partner.id).intro) store.setMarker(partner.id, 'intro', { start: match.bStart, end: match.bEnd, source: 'audio' });
          found = true;
          break;
        }
      }
      store.saveJob(ep, 'intros', { status: found ? 'done' : 'none' });
    } catch (err) {
      signal?.throwIfAborted();
      store.saveJob(ep, 'intros', { status: 'failed', error: err.message });
    }
  }
}
