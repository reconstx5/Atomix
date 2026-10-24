// Audiobooks (v0.22): each folder of audio files is one book (disc folders — "CD1", "Disc 2", "Part 3" — join their
// parent's book); a file straight in the library's folder (an .m4b, say) is a book of its own. A book in several
// files is an `audiobook` row with no file of its own and one `chapter` row per file, in natural order; a single-file
// book is an `audiobook` row with its file. Either way it plays as one timeline: progress is the book's.
import fs from 'node:fs';
import path from 'node:path';
import { probe } from './probe.js';
import { normaliseTags } from './music.js';
import { sortTitle } from './parser.js';
import { parseJson } from '../db.js';

export const AUDIOBOOK_EXTS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.wma', '.mka']);
const DISC = /^(cd|disc|disk|part)\s*[-_ ]?\s*\d+$/i;
const COVERS = ['cover', 'folder', 'front', 'poster'];
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The folder a file's book is named by (disc folders belong to their parent), or null: a book of its own. */
function bookDirOf(file, roots) {
  let dir = path.dirname(file);
  if (DISC.test(path.basename(dir))) dir = path.dirname(dir);
  return roots.some((r) => path.resolve(r) === path.resolve(dir)) ? null : dir;
}

/** A part's name from its file when it has no title tag: "01 - The Start.mp3" → "The Start". */
function partName(file) {
  const stem = path.parse(file).name;
  return stem.replace(/^\d+\s*[-_.]?\s*/, '').trim() || stem;
}

function coverIn(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const pics = names.filter((n) => /\.(jpe?g|png|webp)$/i.test(n));
  const best = pics.find((n) => COVERS.includes(path.parse(n).name.toLowerCase())) || pics[0];
  return best ? path.join(dir, best) : null;
}

/**
 * Bring the library's books up to date with the files found. Returns the ids of new books.
 * @param {object} scanner the Scanner (db, config, tools)
 */
export async function scanAudiobooks(scanner, lib, files, scanId, roots) {
  const { db, config } = scanner;
  const groups = new Map();
  for (const f of files) {
    const dir = bookDirOf(f.file, roots);
    const key = dir || f.file;
    if (!groups.has(key)) groups.set(key, { dir, files: [] });
    groups.get(key).files.push(f);
  }
  const added = [];
  const now = Date.now();
  for (const { dir, files: group } of groups.values()) {
    // Disc folders first (CD1 before CD2), then the files in natural order.
    group.sort((a, b) => natural.compare(path.relative(dir || path.dirname(a.file), a.file), path.relative(dir || path.dirname(b.file), b.file)));
    const parts = [];
    for (const f of group) {
      const old = db.get('SELECT * FROM items WHERE library_id = ? AND path = ? AND kind IN (?, ?)', lib.id, f.file, 'chapter', 'audiobook');
      let media = old && old.size === f.size && old.mtime === f.mtime ? parseJson(old.media, null) : null;
      if (!media && scanner.tools.ffprobe?.available) {
        try {
          media = await probe(config.ffprobePath, f.file);
        } catch {
          media = null;
        }
      }
      parts.push({ f, media, old });
    }
    const tags = normaliseTags(parts[0].media?.tags || {});
    const title = tags.album || (dir ? path.basename(dir) : path.parse(group[0].file).name);
    const author = tags.album_artist || tags.artist || null;
    const narrator = tags.narrator || tags.composer || null;
    const year = Number.parseInt(String(tags.date || '').slice(0, 4), 10) || null;
    const duration = parts.reduce((s, p) => s + (Number(p.media?.duration) || 0), 0) || null;
    const cover = dir ? coverIn(dir) : null; // a loose file's folder is the library's own: no cover from it
    const single = parts.length === 1 && !dir;
    // The existing book: by its own file (one file), else by any of its parts' files.
    let book = single
      ? db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'audiobook' AND path = ?", lib.id, group[0].file)
      : db.get("SELECT b.* FROM items c JOIN items b ON b.id = c.parent_id WHERE c.library_id = ? AND c.kind = 'chapter' AND c.path IN (" + group.map(() => '?').join(',') + ') LIMIT 1', lib.id, ...group.map((f) => f.file));
    const locks = new Set(parseJson(book?.locked_fields, []));
    const keep = (field, value, current) => (locks.has(field) ? current : value);
    if (!book) {
      const id = Number(
        db.run(
          "INSERT INTO items (library_id, kind, title, sort_title, author, narrator, year, duration, path, size, mtime, media, poster, seen_scan, added_at, updated_at) VALUES (?, 'audiobook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          lib.id,
          title,
          sortTitle(title),
          author,
          narrator,
          year,
          duration,
          single ? group[0].file : null,
          single ? group[0].size : null,
          single ? group[0].mtime : null,
          single && parts[0].media ? JSON.stringify(parts[0].media) : null,
          cover ? `file:${cover}` : null,
          scanId,
          now,
          now,
        ).lastInsertRowid,
      );
      book = db.get('SELECT * FROM items WHERE id = ?', id);
      added.push(id);
    } else {
      db.run(
        'UPDATE items SET title = ?, sort_title = ?, author = ?, narrator = ?, year = ?, duration = ?, path = ?, size = ?, mtime = ?, media = ?, poster = COALESCE(?, poster), seen_scan = ?, updated_at = ?, metadata_at = CASE WHEN ? THEN NULL ELSE metadata_at END WHERE id = ?',
        keep('title', title, book.title),
        keep('title', sortTitle(title), book.sort_title),
        author,
        narrator,
        keep('year', year ?? book.year, book.year), // no year in the tags: the one a plugin filled stays
        duration,
        single ? group[0].file : null,
        single ? group[0].size : null,
        single ? group[0].mtime : null,
        single && parts[0].media ? JSON.stringify(parts[0].media) : null,
        locks.has('poster') ? null : cover ? `file:${cover}` : null,
        scanId,
        now,
        parts.some((p) => !p.old || p.old.size !== p.f.size || p.old.mtime !== p.f.mtime) ? 1 : 0, // changed files: offered to providers again
        book.id,
      );
    }
    if (single) continue;
    // The parts: one chapter row per file, numbered in order.
    parts.forEach((p, i) => {
      const t = normaliseTags(p.media?.tags || {});
      const partTitle = t.title || partName(p.f.file);
      const fields = [book.id, book.id, partTitle, sortTitle(partTitle), i + 1, p.f.size, p.f.mtime, Number(p.media?.duration) || null, p.media ? JSON.stringify(p.media) : null, scanId, now];
      if (p.old?.kind === 'chapter') db.run('UPDATE items SET parent_id = ?, show_id = ?, title = ?, sort_title = ?, episode = ?, size = ?, mtime = ?, duration = ?, media = ?, seen_scan = ?, updated_at = ? WHERE id = ?', ...fields, p.old.id);
      else db.run("INSERT INTO items (library_id, kind, parent_id, show_id, title, sort_title, episode, size, mtime, duration, media, seen_scan, updated_at, path, added_at) VALUES (?, 'chapter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", lib.id, ...fields, p.f.file, now);
    });
  }
  return added;
}

/** A book's parts in order: { id, title, start, duration } (start: seconds from the start of the book). */
export function bookParts(db, book) {
  if (book.path) return [{ id: book.id, title: book.title, start: 0, duration: book.duration || 0 }];
  let start = 0;
  return db.all("SELECT id, title, duration FROM items WHERE parent_id = ? AND kind = 'chapter' ORDER BY episode, id", book.id).map((p) => {
    const part = { id: p.id, title: p.title, start, duration: p.duration || 0 };
    start += p.duration || 0;
    return part;
  });
}

/** A book's chapters: a single file's own chapters, else one per part. */
export function bookChapters(db, book) {
  if (book.path) {
    const own = parseJson(book.media, null)?.chapters || [];
    if (own.length) return own.map((c) => ({ title: c.title || null, start: c.start }));
  }
  return bookParts(db, book).map((p) => ({ title: p.title, start: p.start }));
}

/**
 * A report for one file of a book in several is the book's place: seconds into the whole book, against its whole
 * length. Anything else comes back as given.
 */
export function placeOnBook(db, library, row, position, duration) {
  if (row.kind !== 'chapter') return { row, position, duration };
  const book = library.get(row.parent_id);
  const parts = book ? bookParts(db, book) : [];
  const part = parts.find((p) => p.id === row.id);
  if (!book || !part) return { row, position, duration };
  return { row: book, position: part.start + (Number(position) || 0), duration: parts.reduce((s, p) => s + p.duration, 0) || book.duration };
}
