// Edit details (v0.20, admins): a title's fields written by hand, each one then locked (`items.locked_fields`) so a
// refresh and Fix match leave it as it is. Unlock hands a field back to the providers at the next refresh.
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { certToAge } from './ratings.js';
import { sortTitle as makeSortTitle } from './parser.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffImage } from './images.js';
import { seriesFor, issueSort } from '../books/scan.js';


const FILM = ['title', 'sortTitle', 'originalTitle', 'year', 'releaseDate', 'overview', 'tagline', 'genres', 'studio', 'certification'];
export const EDITABLE = {
  movie: FILM,
  show: FILM,
  episode: ['title', 'season', 'episode', 'airDate', 'overview'],
  album: ['title', 'albumArtist', 'year', 'genres'],
  artist: ['title', 'overview'],
  podcast: ['title', 'overview', 'genres', 'certification'],
  podcast_episode: ['title', 'overview'],
  audiobook: ['title', 'year', 'overview', 'genres', 'certification'],
  book: ['title', 'author', 'year', 'overview', 'genres', 'certification', 'series', 'issue'],
  series: ['title', 'overview', 'certification', 'readingDir'],
  comic: ['title', 'issue', 'year', 'overview', 'certification'],
};

/** Each field's column (the artwork fields are locked the same way by Task 5's setArtwork). */
export const LOCK_COLUMNS = {
  title: 'title',
  sortTitle: 'sort_title',
  originalTitle: 'original_title',
  year: 'year',
  releaseDate: 'air_date',
  airDate: 'air_date',
  overview: 'overview',
  tagline: 'tagline',
  genres: 'genres',
  studio: 'studio',
  certification: 'certification',
  season: 'season',
  episode: 'episode',
  albumArtist: 'artist',
  author: 'author', // v0.22 books and comics
  series: 'show_id',
  issue: 'issue',
  readingDir: 'reading_dir',
  poster: 'poster',
  backdrop: 'backdrop',
  logo: 'logo',
  scores: 'scores', // v0.23: cleared with "Clear scores" (never typed in)
};

const LABELS = {
  title: 'Title',
  sortTitle: 'Sort title',
  originalTitle: 'Original title',
  year: 'Year',
  releaseDate: 'Release date',
  airDate: 'Aired',
  overview: 'Plot',
  tagline: 'Tagline',
  genres: 'Genres',
  studio: 'Studio',
  certification: 'Age rating',
  season: 'Season',
  episode: 'Episode',
  albumArtist: 'Album artist',
  author: 'Author',
  series: 'Series',
  issue: 'Number',
  readingDir: 'Reading direction',
};

const bad = (sentence) => new HttpError(400, sentence);
/** Text compared as a reader sees it: line endings, runs of spaces and each line's ends don't count. */
const norm = (v) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim();
const sameText = (a, b) => norm(a) === norm(b);
const blank = (v) => v == null || (typeof v === 'string' && !v.trim());

function text(key, v, { required = false } = {}) {
  if (blank(v)) {
    if (required) throw bad(`${LABELS[key]} can't be empty.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > 2000) throw bad(`${LABELS[key]} can be 2000 characters at most.`);
  return s;
}
function date(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad('Dates are written 2024-05-31.');
  return s;
}
function whole(v, lo, hi, sentence) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(sentence);
  return n;
}
function genreList(v) {
  const list = (Array.isArray(v) ? v : blank(v) ? [] : String(v).split(',')).map((g) => String(g).trim()).filter(Boolean);
  if (list.length > 20 || list.some((g) => g.length > 40)) throw bad('Up to 20 genres, each up to 40 characters.');
  return [...new Set(list)];
}

/** One field's value as stored, or a 400 naming the field. */
function clean(key, v) {
  switch (key) {
    case 'title':
      return text(key, v, { required: true });
    case 'year':
      return whole(v, 1870, 2100, 'Year must be between 1870 and 2100.');
    case 'releaseDate':
    case 'airDate':
      return date(v);
    case 'season':
    case 'episode': {
      const n = whole(v, 0, 9999, 'Season and episode numbers are 0 to 9999.');
      if (n == null) throw bad('Season and episode numbers are 0 to 9999.');
      return n;
    }
    case 'genres':
      return genreList(v);
    case 'sortTitle':
      return text(key, v)?.toLowerCase() ?? null; // sort keys are lower case; a hand-typed one keeps its words
    case 'issue': {
      const s = text(key, v);
      if (s && s.length > 20) throw bad('Number can be 20 characters at most.');
      return s;
    }
    case 'readingDir':
      if (blank(v)) return null;
      if (v !== 'ltr' && v !== 'rtl') throw bad('Reading direction is left to right (ltr) or right to left (rtl).');
      return v;
    case 'certification': {
      const s = text(key, v);
      if (s && s.length > 20) throw bad('Age rating can be 20 characters at most.');
      return s;
    }
    default:
      return text(key, v);
  }
}

/** The values the dialog shows, keyed by field (a book's series by its name, which needs `db`). */
export function detailValues(item, db = null) {
  const out = {};
  for (const key of EDITABLE[item.kind] || []) {
    if (key === 'series') {
      out.series = item.show_id && db ? db.get('SELECT title FROM items WHERE id = ?', item.show_id)?.title ?? null : null;
      continue;
    }
    const v = item[LOCK_COLUMNS[key]];
    out[key] = key === 'genres' ? parseJson(v, []) : v ?? null;
  }
  return out;
}
export const lockedFields = (item) => parseJson(item.locked_fields, []);

/**
 * Write the changed fields (validated first, all or nothing) and lock each one. `unlock` lists fields to hand back.
 * @returns the updated row
 */
export async function editDetails(core, item, changes = {}, { unlock = [], clearScores = false } = {}) {
  const fields = EDITABLE[item.kind];
  if (!fields) throw bad("This title's details can't be edited.");
  const sets = {};
  const changed = [];
  const { db } = core;
  for (const [key, raw] of Object.entries(changes || {})) {
    if (!fields.includes(key)) throw bad(`${LABELS[key] || 'That field'} can't be edited for this title.`);
    const v = clean(key, raw);
    if (key === 'series') {
      // A book's series by name: the library's series of that name (made when new), or none.
      const id = v ? seriesFor(db, { id: item.library_id }, v, null).id : null;
      if (id === (item.show_id ?? null)) continue;
      sets.show_id = id;
      changed.push(key);
      continue;
    }
    const col = LOCK_COLUMNS[key];
    const stored = key === 'genres' ? JSON.stringify(v) : v;
    const current = key === 'genres' ? JSON.stringify(parseJson(item[col], [])) : item[col] ?? null;
    if (stored === current) continue;
    // A plot that only differs in line endings or spacing (a copy and paste) isn't a change: nothing locked.
    if (key === 'overview' && sameText(stored, current)) continue;
    sets[col] = stored;
    if (key === 'issue') sets.issue_sort = issueSort(stored);
    changed.push(key);
  }
  // v0.23: "Clear scores" — the outside scores go, and stay gone (locked) until unlocked.
  if (clearScores && ['movie', 'show'].includes(item.kind) && item.scores != null) {
    sets.scores = null;
    changed.push('scores');
  }
  // Episodes: a new season number moves the episode into that season of the same show.
  if ('season' in sets) {
    const season = db.get("SELECT id FROM items WHERE show_id = ? AND kind = 'season' AND season = ?", item.show_id, sets.season);
    if (!season) throw bad(`This show has no season ${sets.season}.`);
    sets.parent_id = season.id;
  }
  // Never two episodes with one number in a season.
  if (item.kind === 'episode' && ('season' in sets || 'episode' in sets)) {
    const s = 'season' in sets ? sets.season : item.season;
    const e = 'episode' in sets ? sets.episode : item.episode;
    if (e != null && db.get("SELECT 1 FROM items WHERE show_id = ? AND kind = 'episode' AND season IS ? AND episode = ? AND id != ?", item.show_id, s, e, item.id)) throw bad(`Season ${s} already has episode ${e}.`);
  }
  if ('certification' in sets) {
    sets.min_age = certToAge(sets.certification, core.settings?.get?.('ratingCountry'));
    // A rating no age can be read from would count as unrated, and some Kids profiles may watch those.
    if (sets.certification != null && sets.min_age == null) throw bad("Age rating isn't one Atomix knows. Use one like G, PG, M or R16, or an age such as 16.");
  }
  // A new title re-sorts it, unless the sort title is set (or locked) by hand.
  const locks = new Set(lockedFields(item));
  if ('title' in sets && !('sort_title' in sets) && !locks.has('sortTitle') && item.kind !== 'episode') sets.sort_title = makeSortTitle(sets.title);
  const clearedSort = 'sort_title' in sets && sets.sort_title == null;
  if (clearedSort) sets.sort_title = makeSortTitle(sets.title ?? item.title);
  for (const k of changed) locks.add(k);
  if (clearedSort) locks.delete('sortTitle'); // cleared: worked out from the title again, so not held by hand
  for (const k of unlock || []) locks.delete(String(k));
  sets.locked_fields = JSON.stringify([...locks]);
  sets.updated_at = Date.now();
  const cols = Object.keys(sets);
  db.run(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => sets[c]), item.id);
  // Extras take their owner's rating (a Kids profile sees an extra exactly when it sees the film).
  if ('min_age' in sets) db.run("UPDATE items SET certification = ?, min_age = ? WHERE kind = 'extra' AND parent_id = ?", sets.certification, sets.min_age, item.id);
  // The season it left, now without episodes: it goes (a season of nothing would stay on the show's page).
  if ('parent_id' in sets && item.parent_id && item.parent_id !== sets.parent_id && !db.get("SELECT 1 FROM items WHERE parent_id = ? AND kind = 'episode'", item.parent_id)) {
    db.run("DELETE FROM items WHERE id = ? AND kind = 'season'", item.parent_id);
  }
  const updated = db.get('SELECT * FROM items WHERE id = ?', item.id);
  if (changed.length) await core.hooks?.emit('metadata:updated', { item: updated });
  return updated;
}

/** After a refresh wrote new values: put each locked field back as it was before (the rating's age with it). */
export function restoreLocked(db, before) {
  const locks = lockedFields(before).filter((k) => LOCK_COLUMNS[k]);
  if (!locks.length) return;
  const cols = [...new Set(locks.map((k) => LOCK_COLUMNS[k]))];
  if (locks.includes('certification')) cols.push('min_age');
  if (locks.includes('title') && !locks.includes('sortTitle')) cols.push('sort_title');
  if (locks.includes('issue')) cols.push('issue_sort');
  db.run(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => before[c] ?? null), before.id);
}

// ---- Artwork (v0.20) ----
export const ARTWORK_TYPES = ['poster', 'backdrop', 'logo'];
export const UPLOAD_MAX = 10 * 1024 * 1024;
const TMDB_PATH = /^\/[A-Za-z0-9_-]+\.(jpe?g|png|webp)$/i; // an image path as TMDB lists it (no SVG: not a picture we keep)
export const isTmdbPath = (p) => TMDB_PATH.test(String(p || ''));
const SIZES = { poster: 'w500', backdrop: 'w1280', logo: 'w500' };

/** TMDB's choices for each picture: shown through Atomix's own preview route, never TMDB's address. */
export async function artworkOptions(core, item) {
  const lists = await core.metadata.tmdb.images(item).catch(() => ({ posters: [], backdrops: [], logos: [] }));
  const map = (list) =>
    list
      .filter((x) => isTmdbPath(x.file_path))
      .map((x) => ({ url: `/api/items/${item.id}/artwork/preview?path=${encodeURIComponent(x.file_path)}`, path: x.file_path, width: x.width || null, height: x.height || null, language: x.iso_639_1 || null }));
  return { poster: map(lists.posters), backdrop: map(lists.backdrops), logo: map(lists.logos) };
}

/** A small copy of one of TMDB's pictures, cached here: a `cache:` reference, or null. */
export const previewRef = (core, tmdbPath) => (isTmdbPath(tmdbPath) ? core.images.download(core.metadata.tmdb.img(tmdbPath, 'w342')) : Promise.resolve(null));

/**
 * Set a picture from TMDB (`tmdbPath`), an address (`url`, downloaded once) or uploaded bytes (`buffer`), and lock it.
 * @returns the updated row
 */
export async function setArtwork(core, item, type, { tmdbPath, url, buffer } = {}) {
  const { images, db } = core;
  let ref = null;
  if (buffer) {
    if (buffer.length > UPLOAD_MAX) throw new HttpError(413, 'Pictures can be 10 MB at most.');
    const kind = sniffImage(buffer);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(kind)) throw bad('Use a JPEG, PNG or WebP picture.');
    const name = `upload-${crypto.createHash('sha1').update(buffer).digest('hex')}.${{ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[kind]}`;
    const dest = path.join(images.dir, name);
    if (!fs.existsSync(dest)) {
      await fs.promises.writeFile(`${dest}.tmp`, buffer);
      await fs.promises.rename(`${dest}.tmp`, dest);
    }
    ref = `cache:${name}`;
  } else if (tmdbPath != null) {
    if (!isTmdbPath(tmdbPath)) throw bad('Pick one of the pictures shown.');
    ref = await images.download(core.metadata.tmdb.img(tmdbPath, SIZES[type]));
    if (!ref) throw bad("That picture couldn't be fetched. Try again.");
  } else if (url != null) {
    ref = /^https?:\/\//i.test(String(url).trim()) ? await images.download(String(url).trim()) : null;
    if (!ref) throw bad("That address isn't a picture.");
  } else throw bad('Pick a picture, upload one or give an address.');
  const locks = new Set(lockedFields(item));
  locks.add(type);
  const now = Date.now();
  db.run(`UPDATE items SET ${type} = ?, colors = NULL, locked_fields = ?, metadata_at = ?, updated_at = ? WHERE id = ?`, ref, JSON.stringify([...locks]), now, now, item.id);
  const updated = db.get('SELECT * FROM items WHERE id = ?', item.id);
  await core.hooks?.emit('metadata:updated', { item: updated });
  return updated;
}
