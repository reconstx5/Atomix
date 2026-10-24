// Subtitles: sidecar .srt/.vtt/.ass files and text tracks embedded in the
// video, all delivered to the browser as WebVTT.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';
import { SUBTITLE_EXTS, parseSubtitleName } from '../library/parser.js';
import { parseJson } from '../db.js';
import { isRemotePath } from '../remote/index.js';
import { headerArgs } from './ffheaders.js';

export const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
export const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

const LANG_NAMES = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean',
  zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic',
  sv: 'Swedish', swe: 'Swedish', no: 'Norwegian', nor: 'Norwegian', da: 'Danish', dan: 'Danish', fi: 'Finnish',
  fin: 'Finnish', pl: 'Polish', pol: 'Polish', tr: 'Turkish', tur: 'Turkish', hi: 'Hindi', hin: 'Hindi',
  mi: 'Māori', mao: 'Māori', mri: 'Māori', el: 'Greek', gre: 'Greek', ell: 'Greek', he: 'Hebrew', heb: 'Hebrew',
  cs: 'Czech', cze: 'Czech', ces: 'Czech', hu: 'Hungarian', hun: 'Hungarian', th: 'Thai', tha: 'Thai',
  vi: 'Vietnamese', vie: 'Vietnamese', id: 'Indonesian', ind: 'Indonesian', uk: 'Ukrainian', ukr: 'Ukrainian',
};
export const languageName = (code) => (code ? LANG_NAMES[code.toLowerCase()] || code.toUpperCase() : null);

function sidecars(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.parse(videoPath).name;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => SUBTITLE_EXTS.has(path.extname(f).toLowerCase()) && f.toLowerCase().startsWith(base.toLowerCase()))
    .sort()
    .map((f, i) => ({ id: `s${i}`, file: path.join(dir, f), ...parseSubtitleName(f, base) }));
}

/** The file behind a sidecar subtitle id (`s<N>`), or null. */
export function sidecarFile(item, subId) {
  if (!/^s\d+$/.test(String(subId)) || isRemotePath(item.path)) return null;
  return sidecars(item.path).find((s) => s.id === subId)?.file || null;
}

// ---- Subtitles downloaded from online providers (kept in the data folder, so
// read-only media folders work too) ----
function downloadDir(config, itemId) {
  return path.join(config.dataDir, 'subtitles', String(Number(itemId)));
}

function readMeta(config, itemId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(downloadDir(config, itemId), 'meta.json'), 'utf8'));
  } catch {
    return [];
  }
}

function writeMeta(config, itemId, entries) {
  const dir = downloadDir(config, itemId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(entries, null, 2));
}

/** Save a downloaded subtitle and return its list entry. */
export function saveDownloaded(config, item, { content, format = 'srt', language = null, label = null, provider = null, hearingImpaired = false }) {
  const ext = ['srt', 'vtt', 'ass', 'ssa'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'srt';
  const entries = readMeta(config, item.id);
  const n = entries.reduce((m, e) => Math.max(m, e.n), -1) + 1;
  const file = `${n}.${(language || 'und').replace(/[^a-z-]/gi, '')}.${ext}`;
  fs.mkdirSync(downloadDir(config, item.id), { recursive: true });
  fs.writeFileSync(path.join(downloadDir(config, item.id), file), typeof content === 'string' ? content : Buffer.from(content));
  entries.push({ n, file, language, label, provider, hearingImpaired: Boolean(hearingImpaired), addedAt: Date.now() });
  writeMeta(config, item.id, entries);
  return listSubtitles(item, config).find((s) => s.id === `d${n}`);
}

export function deleteDownloaded(config, item, subId) {
  const n = Number(String(subId).slice(1));
  const entries = readMeta(config, item.id);
  const entry = entries.find((e) => e.n === n);
  if (!entry) return false;
  fs.rmSync(path.join(downloadDir(config, item.id), entry.file), { force: true });
  writeMeta(config, item.id, entries.filter((e) => e !== entry));
  return true;
}

export function removeAllDownloaded(config, itemId) {
  fs.rmSync(downloadDir(config, itemId), { recursive: true, force: true });
}

/** All subtitle tracks for an item, in a shape the player understands. */
export function listSubtitles(item, config) {
  const out = [];
  if (!item.path) return out;
  const remote = isRemotePath(item.path); // a connected server's title: only the stream's own tracks
  if (config && !remote) {
    for (const e of readMeta(config, item.id)) {
      const bits = [languageName(e.language) || 'Unknown', e.hearingImpaired && 'SDH', 'Downloaded'].filter(Boolean);
      out.push({ id: `d${e.n}`, label: bits.join(' · '), language: e.language, forced: false, kind: 'text', source: 'downloaded', provider: e.provider, release: e.label, url: `/api/items/${item.id}/subtitles/d${e.n}.vtt` });
    }
  }
  for (const s of remote ? [] : sidecars(item.path)) {
    const bits = [languageName(s.language) || 'Unknown', s.label, s.forced && 'Forced', s.sdh && 'SDH'].filter(Boolean);
    out.push({ id: s.id, label: bits.join(' · '), language: s.language, forced: s.forced, kind: 'text', source: 'external', url: `/api/items/${item.id}/subtitles/${s.id}.vtt` });
  }
  const media = parseJson(item.media, null);
  for (const s of media?.subtitles || []) {
    const isText = TEXT_SUB_CODECS.has(s.codec);
    const isImage = IMAGE_SUB_CODECS.has(s.codec);
    if (!isText && !isImage) continue;
    const lang = languageName(s.language) || 'Unknown';
    // A track titled just its language ("English") — what Plex and Jellyfin send — would read "English · English".
    const title = s.title && s.title.trim().toLowerCase() !== lang.toLowerCase() ? s.title : null;
    const bits = [lang, title, s.forced && 'Forced', isImage && '(burn-in)'].filter(Boolean);
    out.push({
      id: `e${s.index}`,
      label: bits.join(' · '),
      language: s.language,
      forced: s.forced,
      default: s.default,
      kind: isText ? 'text' : 'image',
      source: 'embedded',
      streamIndex: s.index,
      url: isText ? `/api/items/${item.id}/subtitles/e${s.index}.vtt` : null,
    });
  }
  return out;
}

export const decodeSubtitleText = (buf) => decodeText(buf);
function decodeText(buf) {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
  return text.replace(/^﻿/, '');
}

export function srtToVtt(srt) {
  const body = srt
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
    .replace(/\{\\an\d\}/g, '')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/** Produce WebVTT text for a subtitle file (.srt/.vtt read directly; .ass/.ssa through ffmpeg, cp1252 on a retry). */
export async function toVtt(file, ffmpegPath) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vtt') return decodeText(await fs.promises.readFile(file));
  if (ext === '.srt') return srtToVtt(decodeText(await fs.promises.readFile(file)));
  const convert = (charset) => run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(charset ? ['-sub_charenc', charset] : []), '-i', file, '-f', 'webvtt', 'pipe:1']);
  try {
    return (await convert(null)).toString('utf8');
  } catch (err) {
    // ffmpeg's ASS reader insists on UTF-8; an older Windows-made file is Latin-1, so say so and try again.
    if (!/utf-?8|invalid/i.test(err.message)) throw err;
    return (await convert('cp1252')).toString('utf8');
  }
}

/**
 * @param {object} [source]  for a connected server's title: { file: stream URL, headers } — ffmpeg reads the stream
 */
/** Extractions under way, by cache file: a second request for the same track waits for the first. */
const inflight = new Map();

/**
 * @param {{ slot?: () => { release(): void } }} [opts] slot: taken around the ffmpeg run (the playback pool's cap;
 *   it throws 503 when the server is busy converting).
 */
export async function getSubtitleVtt(item, subId, { ffmpegPath, cacheDir, dataDir }, source = null, { slot = null } = {}) {
  if (subId.startsWith('d')) {
    const entry = readMeta({ dataDir }, item.id).find((e) => e.n === Number(subId.slice(1)));
    if (!entry) return null;
    return toVtt(path.join(downloadDir({ dataDir }, item.id), entry.file), ffmpegPath);
  }
  if (subId.startsWith('s')) {
    const side = sidecars(item.path).find((s) => s.id === subId);
    if (!side) return null;
    return toVtt(side.file, ffmpegPath);
  }
  if (subId.startsWith('e')) {
    const index = Number(subId.slice(1));
    if (!Number.isInteger(index)) return null;
    // Only a text track the probe listed: anything else is a 404, not an ffmpeg run.
    const media = parseJson(item.media, null);
    if (!(media?.subtitles || []).some((t) => t.index === index && TEXT_SUB_CODECS.has(t.codec))) return null;
    const dir = path.join(cacheDir, 'subs');
    await fs.promises.mkdir(dir, { recursive: true });
    const cacheFile = embeddedCacheFile(item, index, { cacheDir });
    try {
      return await fs.promises.readFile(cacheFile, 'utf8');
    } catch {
      /* not cached yet */
    }
    if (inflight.has(cacheFile)) return inflight.get(cacheFile);
    const job = (async () => {
      const held = slot ? slot() : null;
      try {
        const out = await run(
          ffmpegPath,
          ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(source?.headers ? headerArgs(source.headers) : []), '-i', source?.file || item.path, '-map', `0:s:${index}`, '-f', 'webvtt', 'pipe:1'],
          { timeout: 10 * 60 * 1000 },
        );
        const text = out.toString('utf8');
        await fs.promises.writeFile(cacheFile, text);
        return text;
      } finally {
        held?.release();
      }
    })();
    inflight.set(cacheFile, job);
    try {
      return await job;
    } finally {
      inflight.delete(cacheFile);
    }
  }
  return null;
}

/** The embedded text tracks of a title (what the background job extracts). */
export function embeddedTextTracks(item) {
  const media = parseJson(item.media, null);
  return (media?.subtitles || []).filter((t) => TEXT_SUB_CODECS.has(t.codec));
}

/** The cache file an embedded track's VTT lives in. */
export function embeddedCacheFile(item, index, { cacheDir }) {
  return path.join(cacheDir, 'subs', `${item.id}-${index}-${item.mtime || item.metadata_at || 0}.vtt`);
}

/**
 * Extracts every embedded text track of a local file into the cache with ONE ffmpeg run (one demux of the file,
 * however many tracks). Tracks already cached are skipped. Returns how many were written.
 */
export async function extractEmbeddedTracks(item, { ffmpegPath, cacheDir }, { onSpawn, signal } = {}) {
  const todo = embeddedTextTracks(item).filter((t) => !fs.existsSync(embeddedCacheFile(item, t.index, { cacheDir })));
  if (!todo.length) return 0;
  await fs.promises.mkdir(path.join(cacheDir, 'subs'), { recursive: true });
  const outputs = todo.flatMap((t) => ['-map', `0:s:${t.index}`, '-f', 'webvtt', `${embeddedCacheFile(item, t.index, { cacheDir })}.part`]);
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', item.path, ...outputs], { timeout: 30 * 60 * 1000, onSpawn });
  signal?.throwIfAborted();
  for (const t of todo) {
    const file = embeddedCacheFile(item, t.index, { cacheDir });
    try {
      fs.renameSync(`${file}.part`, file);
    } catch {
      /* a track ffmpeg skipped: the on-demand route will try it alone */
    }
  }
  return todo.length;
}
