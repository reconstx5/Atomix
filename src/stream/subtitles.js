// Subtitles: sidecar .srt/.vtt/.ass files and text tracks embedded in the
// video, all delivered to the browser as WebVTT.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';
import { SUBTITLE_EXTS, parseSubtitleName } from '../library/parser.js';
import { parseJson } from '../db.js';

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
  if (config) {
    for (const e of readMeta(config, item.id)) {
      const bits = [languageName(e.language) || 'Unknown', e.hearingImpaired && 'SDH', 'Downloaded'].filter(Boolean);
      out.push({ id: `d${e.n}`, label: bits.join(' · '), language: e.language, forced: false, kind: 'text', source: 'downloaded', provider: e.provider, release: e.label, url: `/api/items/${item.id}/subtitles/d${e.n}.vtt` });
    }
  }
  for (const s of sidecars(item.path)) {
    const bits = [languageName(s.language) || 'Unknown', s.label, s.forced && 'Forced', s.sdh && 'SDH'].filter(Boolean);
    out.push({ id: s.id, label: bits.join(' · '), language: s.language, forced: s.forced, kind: 'text', source: 'external', url: `/api/items/${item.id}/subtitles/${s.id}.vtt` });
  }
  const media = parseJson(item.media, null);
  for (const s of media?.subtitles || []) {
    const isText = TEXT_SUB_CODECS.has(s.codec);
    const isImage = IMAGE_SUB_CODECS.has(s.codec);
    if (!isText && !isImage) continue;
    const bits = [languageName(s.language) || 'Unknown', s.title, s.forced && 'Forced', isImage && '(burn-in)'].filter(Boolean);
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

/** Produce WebVTT text for a subtitle id, using a disk cache for extracted tracks. */
async function toVtt(file, ffmpegPath) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vtt') return decodeText(await fs.promises.readFile(file));
  if (ext === '.srt') return srtToVtt(decodeText(await fs.promises.readFile(file)));
  const out = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'webvtt', 'pipe:1']);
  return out.toString('utf8');
}

export async function getSubtitleVtt(item, subId, { ffmpegPath, cacheDir, dataDir }) {
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
    const dir = path.join(cacheDir, 'subs');
    await fs.promises.mkdir(dir, { recursive: true });
    const cacheFile = path.join(dir, `${item.id}-${index}-${item.mtime || 0}.vtt`);
    try {
      return await fs.promises.readFile(cacheFile, 'utf8');
    } catch {
      /* not cached yet */
    }
    const out = await run(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', item.path, '-map', `0:s:${index}`, '-f', 'webvtt', 'pipe:1'],
      { timeout: 10 * 60 * 1000 },
    );
    const text = out.toString('utf8');
    await fs.promises.writeFile(cacheFile, text);
    return text;
  }
  return null;
}
