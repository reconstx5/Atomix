// Turns messy file and folder names into titles, years and episode numbers.
import path from 'node:path';

export const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.mts', '.wmv', '.flv',
  '.mpg', '.mpeg', '.ogv', '.3gp', '.divx', '.vob',
]);

export const SUBTITLE_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa']);

export const EXTRAS_DIRS = new Set([
  'extras', 'featurettes', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts',
  'trailers', 'other', 'sample', 'samples', 'bonus', 'specials features',
]);

// Words that mark the end of the real title in scene-style names.
const JUNK = [
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'hdr', 'hdr10', 'dv',
  'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'web-dl', 'webdl', 'webrip', 'hdtv', 'pdtv',
  'dvdrip', 'dvdscr', 'dvd', 'hdrip', 'hdcam', 'x264', 'x265', 'h264', 'h.264', 'h265', 'h.265',
  'hevc', 'avc', 'xvid', 'divx', 'av1', '10bit', '8bit', 'aac', 'ac3', 'eac3', 'dts', 'dts-hd', 'truehd',
  'atmos', 'ddp', 'dd5', 'mp3', '5.1', '7.1', 'proper', 'repack', 'unrated',
  'remastered', 'imax', 'internal', 'multi', 'subbed',
  'dubbed', 'nf', 'amzn', 'dsnp', 'hmax', 'atvp', 'itunes',
];
const JUNK_RE = new RegExp(`(?:^|[\\s._\\-\\[(])(?:${JUNK.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[\\s._\\-\\])])`, 'i');

const EPISODE_PATTERNS = [
  // S01E02, s1e2, S01E02E03, S01E02-E03, S01.E02, s01_e02, S01xE02 (same separators Kodi accepts)
  /(?<![a-z0-9])S(\d{1,2})[ ._x-]*E(\d{1,3})(?:[-_ ]?E(\d{1,3})|-(\d{1,3})(?=[\s._-]|$))?/i,
  // 1x02
  /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i,
  // Season 1 Episode 2
  /season[ ._-]?(\d{1,2})[ ._-]*episode[ ._-]?(\d{1,3})/i,
];

export function cleanTitle(raw, { episode = false } = {}) {
  let s = String(raw);
  s = s.replace(/\[[^\]]*\]/g, ' '); // [Group] tags
  s = s.replace(/\{[^}]*\}/g, ' '); // {tmdb-123} tags
  // Dots/underscores as separators (but keep dots in things like "Mr. Robot" when spaces exist)
  if (!/\s/.test(s) || /[._]\w+[._]\w+/.test(s)) s = s.replace(/[._]/g, ' ');
  const junk = JUNK_RE.exec(s);
  if (junk && (junk.index > 0 || episode)) s = s.slice(0, junk.index);
  s = s.replace(/\(\s*\)/g, ' ');
  s = s.replace(/\s+-\s*$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[-\s]+|[-\s(]+$/g, '').trim();
  return s;
}

/** Find the release year and the title that precedes it. */
export function splitTitleYear(name) {
  const base = String(name);
  // Prefer "(2010)" or "[2010]"
  const paren = /[([](19\d{2}|20\d{2})[)\]]/.exec(base);
  if (paren && paren.index > 0) {
    return { title: cleanTitle(base.slice(0, paren.index)), year: Number(paren[1]) };
  }
  // Otherwise the last standalone year that isn't at the very start ("2001 A Space Odyssey 1968")
  const re = /(?:^|[\s._-])(19\d{2}|20\d{2})(?=$|[\s._)\]-])/g;
  let m;
  let last = null;
  while ((m = re.exec(base))) {
    const idx = m.index + (m[0].length - m[1].length);
    if (idx > 0) last = { idx, year: Number(m[1]) };
  }
  if (last) {
    const title = cleanTitle(base.slice(0, last.idx));
    if (title) return { title, year: last.year };
  }
  return { title: cleanTitle(base), year: null };
}

const RELEASE_WORDS = /^(web|hdtv|proper|repack|internal|real|final|complete|sd|hd)$/i;
function episodeTitle(rest) {
  const t = cleanTitle(String(rest).replace(/^[\s._-]+/, ''), { episode: true }).replace(/-[A-Za-z0-9]+$/, (m) => (/[a-z]/.test(m) ? m : ''));
  if (!t || /^\d+$/.test(t) || RELEASE_WORDS.test(t)) return null;
  return t;
}

export function parseEpisode(fileName) {
  const base = path.parse(fileName).name;
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(base);
    if (m) {
      const season = Number(m[1]);
      const episode = Number(m[2]);
      const episodeEnd = m[3] || m[4] ? Number(m[3] || m[4]) : null;
      const before = base.slice(0, m.index);
      const after = base.slice(m.index + m[0].length);
      const epTitle = episodeTitle(after);
      return {
        season,
        episode,
        episodeEnd: episodeEnd && episodeEnd > episode ? episodeEnd : null,
        showHint: before ? splitTitleYear(before).title : null,
        episodeTitle: epTitle,
      };
    }
  }
  // Daily shows: 2024.03.05 / 2024-03-05 → season 2024, episode 305
  const daily = /(?:^|[\s._-])((?:19|20)\d{2})[.-](\d{2})[.-](\d{2})(?=$|[\s._-])/.exec(base);
  if (daily) {
    const [, y, mo, d] = daily;
    return {
      season: Number(y),
      episode: Number(mo) * 100 + Number(d),
      episodeEnd: null,
      showHint: daily.index > 0 ? splitTitleYear(base.slice(0, daily.index)).title : null,
      episodeTitle: `${y}-${mo}-${d}`,
    };
  }
  // "Show.103.Title" → S1E03 (Kodi's last-resort rule). Skip things that look like resolutions or years.
  const compact = /(?:^|[\s._-])(\d{1,2})(\d{2})(?=[\s._-]|$)/.exec(base);
  if (compact && !/^(480|576|720|1080|2160|264|265)$/.test(compact[1] + compact[2]) && !/^(19|20)\d{2}$/.test(compact[1] + compact[2])) {
    const epTitle = episodeTitle(base.slice(compact.index + compact[0].length));
    return {
      season: Number(compact[1]),
      episode: Number(compact[2]),
      episodeEnd: null,
      showHint: compact.index > 0 ? splitTitleYear(base.slice(0, compact.index)).title : null,
      episodeTitle: epTitle || null,
    };
  }
  // "Episode 5" / "Ep 05" / "E05" / leading "05 - Title" — season from folder
  const loose = /(?:^|[\s._-])(?:episode|ep|e)[ ._-]?(\d{1,3})(?=$|[\s._-])/i.exec(base) || /^(\d{1,3})(?=[\s._-])/.exec(base);
  if (loose) {
    const epTitle = episodeTitle(base.slice(loose.index + loose[0].length));
    return { season: null, episode: Number(loose[1]), episodeEnd: null, showHint: null, episodeTitle: epTitle || null };
  }
  return null;
}

export function parseSeasonFolder(folderName) {
  const name = String(folderName).trim();
  if (/^(specials?|extras? season|season 0+)$/i.test(name)) return 0;
  const m = /^(?:season|series|staffel|saison|temporada|s)[ ._-]?(\d{1,3})\b/i.exec(name);
  if (m) return Number(m[1]);
  if (/^\d{1,2}$/.test(name)) return Number(name);
  return null;
}

/**
 * Work out what a movie file is called.
 * Uses the parent folder if it looks like "Title (Year)", otherwise the file name.
 */
export function parseMovie(filePath, libraryRoot) {
  const file = path.parse(filePath);
  const parent = path.basename(file.dir);
  const inOwnFolder = path.resolve(file.dir) !== path.resolve(libraryRoot);
  const fromFile = splitTitleYear(file.name.replace(/[ ._-](cd|disc|part|pt)[ ._-]?\d$/i, ''));
  if (inOwnFolder) {
    const fromFolder = splitTitleYear(parent);
    if (fromFolder.year && fromFolder.title) return fromFolder;
    if (!fromFile.year && fromFolder.title && fromFile.title.length < 3) return fromFolder;
  }
  return fromFile;
}

/** Sort key that ignores leading articles. */
export function sortTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

/** Parse "movie.en.forced.srt" style sidecar names. */
export function parseSubtitleName(subFile, videoBase) {
  const name = path.parse(subFile).name;
  let rest = name.length > videoBase.length ? name.slice(videoBase.length).replace(/^[._\s-]+/, '') : '';
  const parts = rest ? rest.split(/[._\s-]+/) : [];
  const flags = { forced: false, sdh: false };
  let language = null;
  const labelParts = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'forced') flags.forced = true;
    else if (lower === 'sdh' || lower === 'cc' || lower === 'hi') flags.sdh = true;
    else if (!language && /^[a-z]{2,3}$/i.test(p)) language = lower;
    else labelParts.push(p);
  }
  return { language, ...flags, label: labelParts.join(' ') || null };
}
