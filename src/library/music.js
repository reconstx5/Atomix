// Music: reading tags and working out artist / album / track from them,
// with the folder layout (Artist/Album (Year)/01 Title.mp3) as a fallback.
import path from 'node:path';
import { splitTitleYear } from './parser.js';

export const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.aiff', '.aif', '.alac', '.ape', '.wv', '.mka']);

const ALIASES = {
  tracknumber: 'track',
  trck: 'track',
  discnumber: 'disc',
  disk: 'disc',
  tpos: 'disc',
  albumartist: 'album_artist',
  'album artist': 'album_artist',
  'album_artist': 'album_artist',
  tpe2: 'album_artist',
  year: 'date',
  originaldate: 'date',
  tdrc: 'date',
};
const KEEP = new Set(['title', 'artist', 'album', 'album_artist', 'track', 'disc', 'date', 'genre', 'compilation']);

/** Lower-case tag names and map the common variants onto one name each. */
export function normaliseTags(...sources) {
  const out = {};
  for (const tags of sources) {
    for (const [rawKey, value] of Object.entries(tags || {})) {
      if (value == null || value === '') continue;
      const key = ALIASES[rawKey.toLowerCase()] || rawKey.toLowerCase();
      if (KEEP.has(key) && !(key in out)) out[key] = String(value).trim();
    }
  }
  return out;
}

const firstNumber = (v) => {
  const m = /\d+/.exec(String(v ?? ''));
  return m ? Number(m[0]) : null;
};

/**
 * @param {object} tags  normalised tags
 * @param {string} file  full path
 * @param {string} root  library folder
 */
export function parseTrack(tags, file, root) {
  const rel = path.relative(root, file).split(path.sep);
  const folders = rel.slice(0, -1);
  const stem = path.parse(file).name;

  // "07 - Song", "07. Song", "1-07 Song" (disc-track)
  const numbered = /^(?:(\d)[-.])?(\d{1,3})\s*[-._ ]\s*(.+)$/.exec(stem);
  const fileTitle = numbered ? numbered[3].trim() : stem;
  const fileTrack = numbered ? Number(numbered[2]) : null;
  const fileDisc = numbered?.[1] ? Number(numbered[1]) : null;

  const albumFolder = folders.length >= 1 ? folders[folders.length - 1] : null;
  const artistFolder = folders.length >= 2 ? folders[folders.length - 2] : null;
  const folderAlbum = albumFolder ? splitTitleYear(albumFolder) : { title: null, year: null };

  const year = firstNumber(tags.date) && String(firstNumber(tags.date)).length === 4 ? firstNumber(tags.date) : folderAlbum.year || null;
  const genres = String(tags.genre || '')
    .split(/\s*[;/,|]\s*/)
    .map((g) => g.trim())
    .filter(Boolean);

  return {
    title: tags.title || fileTitle,
    artist: tags.artist || artistFolder || null,
    albumArtist: tags.album_artist || null,
    album: tags.album || folderAlbum.title || null,
    track: firstNumber(tags.track) ?? fileTrack,
    disc: firstNumber(tags.disc) ?? fileDisc ?? 1,
    year,
    genres: [...new Set(genres)],
  };
}
