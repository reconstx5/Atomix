// Scanning books and comics (v0.22). A book is one EPUB; its series (calibre:series, or an EPUB 3 collection) is a
// `series` item the book points to with show_id — a book without one stands alone (its folder is usually its author).
// A file Atomix can't open is skipped with its reason in the log, and the scan carries on.
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';
import { readEpub } from './epub.js';
import { bookCover } from './covers.js';
import { parseComicInfo, ageFor } from './comicinfo.js';
import { archiveList, archiveEntry } from './archive-tool.js';
import { sortTitle } from '../library/parser.js';
import { parseJson } from '../db.js';
import { logger } from '../log.js';

const log = logger('books');

export const BOOK_EXTS = new Set(['.epub']);

/** "1", "1.5", "Annual 2" → a number to sort by (annuals and specials after the numbered issues). */
export function issueSort(issue) {
  if (issue == null || issue === '') return null;
  const s = String(issue).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const n = /(\d+(\.\d+)?)/.exec(s);
  return 100000 + (n ? Number(n[1]) : 0);
}

/** The series item of this name in the library, made when it isn't there yet. */
export function seriesFor(db, lib, title, scanId, now = Date.now()) {
  const row = db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'series' AND title = ? COLLATE NOCASE", lib.id, title);
  if (row) {
    db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, row.id);
    return row;
  }
  const id = Number(db.run("INSERT INTO items (library_id, kind, title, sort_title, seen_scan, added_at, updated_at) VALUES (?, 'series', ?, ?, ?, ?, ?)", lib.id, title, sortTitle(title), scanId, now, now).lastInsertRowid);
  return db.get('SELECT * FROM items WHERE id = ?', id);
}

/**
 * A series' picture (unless one was chosen for it) is its first title's that the most profiles may see — the lowest
 * age rating, rated before unrated — so a Kids profile shown the series never sees an adults-only cover.
 */
export function seriesPosters(db, libId) {
  db.run(
    `UPDATE items SET poster = (SELECT b.poster FROM items b WHERE b.show_id = items.id AND b.poster IS NOT NULL
       ORDER BY COALESCE(b.min_age, 99), b.issue_sort IS NULL, b.issue_sort, b.sort_title LIMIT 1)
     WHERE library_id = ? AND kind = 'series' AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(items.locked_fields, '[]')) WHERE value = 'poster')`,
    libId,
  );
}

/**
 * Bring the library's books up to date with the EPUB files found. Returns the ids of new books.
 * @param {object} scanner the Scanner (db, config, status)
 */
export async function scanBooks(scanner, lib, files, scanId) {
  const { db, config } = scanner;
  const added = [];
  for (const f of files) {
    const now = Date.now();
    const old = db.get("SELECT * FROM items WHERE library_id = ? AND path = ? AND kind = 'book'", lib.id, f.file);
    if (old && old.size === f.size && old.mtime === f.mtime) {
      db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, old.id);
      if (old.show_id) db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, old.show_id);
      scanner.status.done++;
      continue;
    }
    let info;
    let zip;
    try {
      zip = await openZip(f.file);
      info = await readEpub(zip);
    } catch (err) {
      await zip?.close().catch(() => {});
      log.warn(`Skipping ${path.basename(f.file)}: ${err.message}`);
      if (old) db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, old.id); // kept (and its place) until it is fixed
      scanner.status.done++;
      continue;
    }
    try {
      const locks = new Set(parseJson(old?.locked_fields, []));
      const keep = (field, value, current) => (old && locks.has(field) ? current : value);
      const title = info.title || path.parse(f.file).name;
      const series = keep('series', info.series ? seriesFor(db, lib, info.series, scanId, now).id : null, old?.show_id);
      const issue = keep('issue', info.series ? info.seriesIndex : null, old?.issue);
      const mediaJson = JSON.stringify({ spine: info.spine, toc: info.toc, opfDir: info.opfDir, language: info.language, isbn: info.isbn || null });
      let id = old?.id;
      if (!old) {
        id = Number(
          db.run(
            "INSERT INTO items (library_id, kind, title, sort_title, author, overview, year, path, size, mtime, media, show_id, issue, issue_sort, seen_scan, added_at, updated_at) VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            lib.id, title, sortTitle(title), info.author, info.description, info.year, f.file, f.size, f.mtime, mediaJson, series, issue, issueSort(issue), scanId, now, now,
          ).lastInsertRowid,
        );
        added.push(id);
      } else {
        db.run(
          'UPDATE items SET title = ?, sort_title = ?, author = ?, overview = ?, year = ?, size = ?, mtime = ?, media = ?, show_id = ?, issue = ?, issue_sort = ?, seen_scan = ?, updated_at = ?, metadata_at = NULL WHERE id = ?',
          keep('title', title, old.title), keep('title', sortTitle(title), old.sort_title), keep('author', info.author, old.author), keep('overview', info.description, old.overview), keep('year', info.year, old.year),
          f.size, f.mtime, mediaJson, series, issue, issueSort(issue), scanId, now, id,
        );
      }
      if (info.coverEntry && !locks.has('poster')) {
        const bytes = await zip.read(info.coverEntry).catch(() => null);
        const ref = bytes && (await bookCover(config, id, bytes));
        if (ref) db.run('UPDATE items SET poster = ? WHERE id = ?', ref, id);
      }
    } finally {
      await zip.close().catch(() => {});
    }
    scanner.status.done++;
  }
  seriesPosters(db, lib.id);
  return added;
}

// ---- Comics ----
export const COMIC_EXTS = new Set(['.cbz', '.cbr', '.cb7']);
export const PAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** An archive's pictures, in reading order (hidden files and macOS's __MACOSX left out). */
export function pagesOf(names) {
  return names
    .filter((n) => PAGE_EXTS.has(path.posix.extname(n).toLowerCase()) && !n.split('/').some((part) => part.startsWith('.') || part === '__MACOSX'))
    .sort((a, b) => natural.compare(a, b));
}

/** The number in a file name after its series' name: "Saga 012 (2013)" → "12", "Saga Annual 2" → "Annual 2". */
export function issueFromName(stem, series) {
  let rest = String(stem).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim();
  if (series && rest.toLowerCase().startsWith(series.toLowerCase())) rest = rest.slice(series.length);
  const annual = /\bannual\s*#?\s*(\d+)/i.exec(rest);
  if (annual) return `Annual ${Number(annual[1])}`;
  const n = /#?\s*(\d+(?:\.\d+)?)/.exec(rest);
  return n ? String(Number(n[1])) : null;
}

/** What a comic file holds: its pages and ComicInfo (null pages when a CBR/CB7 needs 7-Zip that isn't here). */
async function readComic(scanner, file, format) {
  if (format === 'cbz') {
    const zip = await openZip(file);
    try {
      const pages = pagesOf([...zip.entries.keys()]);
      const ciName = [...zip.entries.keys()].find((n) => n.toLowerCase() === 'comicinfo.xml');
      const ci = ciName ? await zip.read(ciName).catch(() => null) : null;
      const cover = pages.length ? await zip.read(pages[0]).catch(() => null) : null;
      return { pages, comicInfo: ci, cover };
    } finally {
      await zip.close().catch(() => {});
    }
  }
  const tool = scanner.tools?.archive;
  if (!tool?.available) return { pages: null, comicInfo: null, cover: null };
  const list = await archiveList(tool, file);
  const pages = pagesOf(list);
  const ciName = list.find((n) => n.toLowerCase() === 'comicinfo.xml');
  const ci = ciName ? await archiveEntry(tool, file, ciName, { list }).catch(() => null) : null;
  const cover = pages.length ? await archiveEntry(tool, file, pages[0], { list }).catch(() => null) : null;
  return { pages, comicInfo: ci, cover };
}

/**
 * Bring the library's comics up to date: each .cbz/.cbr/.cb7 file, and each folder of two or more pictures with no
 * comic file in it. Returns the ids of new comics.
 */
export async function scanComics(scanner, lib, files, scanId, roots) {
  const { db, config } = scanner;
  const archives = files.filter((f) => COMIC_EXTS.has(path.extname(f.file).toLowerCase()));
  const dirsWithArchives = new Set(archives.map((f) => path.dirname(f.file)));
  const folders = new Map();
  for (const f of files) {
    if (!PAGE_EXTS.has(path.extname(f.file).toLowerCase())) continue;
    const dir = path.dirname(f.file);
    if (dirsWithArchives.has(dir) || roots.includes(dir)) continue;
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push(f);
  }
  const comics = [
    ...archives.map((f) => ({ ...f, format: path.extname(f.file).slice(1).toLowerCase() })),
    ...[...folders].filter(([, pics]) => pics.length >= 2).map(([dir, pics]) => ({ file: dir, size: pics.reduce((s, p) => s + p.size, 0), mtime: Math.max(...pics.map((p) => p.mtime)), format: 'folder', pics })),
  ];
  scanner.status.total = comics.length;
  const added = [];
  const toolHere = Boolean(scanner.tools?.archive?.available);
  for (const c of comics) {
    const now = Date.now();
    const old = db.get("SELECT * FROM items WHERE library_id = ? AND path = ? AND kind = 'comic'", lib.id, c.file);
    const waitingForTool = old && old.page_count == null && c.format !== 'cbz' && c.format !== 'folder' && toolHere;
    if (old && old.size === c.size && old.mtime === c.mtime && !waitingForTool) {
      db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, old.id);
      if (old.show_id) db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, old.show_id);
      scanner.status.done++;
      continue;
    }
    let found;
    try {
      if (c.format === 'folder') {
        const pages = c.pics.map((p) => path.basename(p.file)).sort((a, b) => natural.compare(a, b));
        found = { pages, comicInfo: null, cover: await fs.promises.readFile(path.join(c.file, pages[0])).catch(() => null) };
      } else found = await readComic(scanner, c.file, c.format);
    } catch (err) {
      log.warn(`Skipping ${path.basename(c.file)}: ${err.message}`);
      if (old) db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, old.id);
      scanner.status.done++;
      continue;
    }
    let ci = {};
    try {
      if (found.comicInfo) ci = parseComicInfo(found.comicInfo);
    } catch {
      ci = {}; // a ComicInfo that doesn't parse: the file name and folder say what they can
    }
    const stem = c.format === 'folder' ? path.basename(c.file) : path.parse(c.file).name;
    const parent = path.dirname(c.file);
    const seriesName = ci.series || (roots.includes(parent) ? null : path.basename(parent));
    const locks = new Set(parseJson(old?.locked_fields, []));
    const keep = (field, value, current) => (old && locks.has(field) ? current : value);
    const series = seriesName ? seriesFor(db, lib, seriesName, scanId, now) : null;
    if (series && ci.manga === 'rtl' && !parseJson(series.locked_fields, []).includes('readingDir')) db.run("UPDATE items SET reading_dir = 'rtl' WHERE id = ?", series.id);
    const title = keep('title', ci.title || stem, old?.title);
    const issue = keep('issue', ci.number || issueFromName(stem, seriesName), old?.issue);
    const age = ageFor(ci.ageRating);
    const cert = keep('certification', age == null ? null : String(age), old?.certification);
    const minAge = old && locks.has('certification') ? old.min_age : age;
    const mediaJson = JSON.stringify({ pages: found.pages, format: c.format });
    const pageCount = found.pages ? found.pages.length : null;
    let id = old?.id;
    if (!old) {
      id = Number(
        db.run(
          "INSERT INTO items (library_id, kind, title, sort_title, overview, year, path, size, mtime, media, page_count, show_id, issue, issue_sort, certification, min_age, seen_scan, added_at, updated_at) VALUES (?, 'comic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          lib.id, title, sortTitle(title), ci.summary || null, ci.year || null, c.file, c.size, c.mtime, mediaJson, pageCount, keep('series', series?.id ?? null, null), issue, issueSort(issue), cert, minAge, scanId, now, now,
        ).lastInsertRowid,
      );
      added.push(id);
    } else {
      db.run(
        'UPDATE items SET title = ?, sort_title = ?, overview = ?, year = ?, size = ?, mtime = ?, media = ?, page_count = ?, show_id = ?, issue = ?, issue_sort = ?, certification = ?, min_age = ?, seen_scan = ?, updated_at = ? WHERE id = ?',
        title, keep('title', sortTitle(title), old.sort_title), keep('overview', ci.summary || null, old.overview), keep('year', ci.year || null, old.year), c.size, c.mtime, mediaJson, pageCount,
        keep('series', series?.id ?? null, old.show_id), issue, issueSort(issue), cert, minAge, scanId, now, id,
      );
    }
    if (found.cover && !locks.has('poster')) {
      const ref = await bookCover(config, id, found.cover);
      if (ref) db.run('UPDATE items SET poster = ? WHERE id = ?', ref, id);
    }
    scanner.status.done++;
  }
  seriesPosters(db, lib.id);
  return added;
}
