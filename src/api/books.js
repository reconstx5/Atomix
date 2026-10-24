// Reading routes (v0.22 Plan D): an EPUB's own files for the reader's frame — each answer with a policy that lets
// nothing run and nothing load from outside the book — and a comic's pages one at a time (a page over 4000 px scaled
// once to 2400 px for phones; ?full=1 for the original when zooming past that).
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { withZip, ZipError } from '../books/zip.js';
import { archiveEntry } from '../books/archive-tool.js';
import { imageSize } from '../books/image-size.js';
import { sniffImage } from '../library/images.js';
import { run } from '../library/probe.js';

const TYPES = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', xml: 'application/xml', opf: 'application/xml', ncx: 'application/xml',
  css: 'text/css', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', smil: 'application/smil+xml',
};
export const BIG_PAGE = 4000;
export const PHONE_PAGE = 2400;

/** The policy for a file of a book: its own files only, no scripts, no forms, no frames — and sandboxed. */
export function bookPolicy(own) {
  return `default-src 'none'; img-src ${own} data:; style-src ${own} 'unsafe-inline'; font-src ${own}; media-src ${own}; script-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; sandbox allow-same-origin`;
}

export function registerBookRoutes(r, core) {
  const { library, config } = core;
  /** This Atomix's address as the browser used it (a host that isn't a plain host name gives the bare path). */
  const origin = (ctx) => {
    const host = String((config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host || '');
    if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return '';
    return `${core.auth.isSecure(ctx.req) ? 'https' : 'http'}://${host}`;
  };
  const titleOf = (ctx, kind) => {
    const row = library.get(Number(ctx.params.id));
    if (!row || row.kind !== kind || !library.canSee(ctx.viewer, row)) throw new HttpError(404, 'Not found');
    return row;
  };
  const refuse = (err) => {
    if (err instanceof HttpError) throw err;
    throw new HttpError(err instanceof ZipError ? 422 : 503, err.message);
  };

  // ---- A book's files ----
  r.get('/api/books/:id/file/:entry*', async (ctx) => {
    const book = titleOf(ctx, 'book');
    const name = ctx.params.entry;
    let bytes;
    try {
      bytes = await withZip(book.path, (z) => z.read(name));
    } catch (err) {
      refuse(err);
    }
    if (!bytes) throw new HttpError(404, 'Not found');
    const ext = path.extname(name).slice(1).toLowerCase();
    const own = `${origin(ctx)}/api/books/${book.id}/file/`;
    ctx.res.writeHead(200, {
      'Content-Type': TYPES[ext] ? `${TYPES[ext]}${/^(text|application)\//.test(TYPES[ext]) && ext !== 'smil' ? '; charset=utf-8' : ''}` : 'application/octet-stream',
      'Content-Length': bytes.length,
      'Content-Security-Policy': bookPolicy(own),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : bytes);
  });

  // ---- A comic's pages ----
  async function pageBytes(comic, name) {
    const m = parseJson(comic.media, {}) || {};
    if (m.format === 'folder') return fs.promises.readFile(path.join(comic.path, path.basename(name)));
    if (m.format === 'cbz') return withZip(comic.path, async (z) => z.read(name));
    return archiveEntry(core.tools?.archive, comic.path, name, { list: m.pages || [] });
  }
  /** The phone-sized copy of a big page, made once (named by the comic's file time, so a changed file makes a new one). */
  async function scaled(comic, n, bytes) {
    const dir = path.join(config.cacheDir, 'comic-pages');
    const out = path.join(dir, `${comic.id}-${n}-${comic.mtime || 0}.jpg`);
    if (fs.existsSync(out)) return fs.promises.readFile(out);
    await fs.promises.mkdir(dir, { recursive: true });
    const src = `${out}.src`;
    await fs.promises.writeFile(src, bytes);
    try {
      await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', `scale='if(gt(iw,ih),${PHONE_PAGE},-2)':'if(gt(iw,ih),-2,${PHONE_PAGE})'`, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', `${out}.part`], { timeout: 60000 });
      await fs.promises.rename(`${out}.part`, out);
      return fs.promises.readFile(out);
    } catch {
      await fs.promises.rm(`${out}.part`, { force: true });
      return bytes; // ffmpeg couldn't: the original page
    } finally {
      await fs.promises.rm(src, { force: true });
    }
  }
  r.get('/api/comics/:id/pages/:n', async (ctx) => {
    const comic = titleOf(ctx, 'comic');
    const pages = (parseJson(comic.media, {}) || {}).pages || [];
    const n = Number(ctx.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= pages.length) throw new HttpError(404, 'Not found');
    let bytes;
    try {
      bytes = await pageBytes(comic, pages[n]);
    } catch (err) {
      refuse(err);
    }
    if (!bytes) throw new HttpError(404, 'Not found');
    const size = imageSize(bytes);
    if (size && Math.max(size.width, size.height) > BIG_PAGE && ctx.query.full !== '1') bytes = await scaled(comic, n, bytes);
    ctx.res.writeHead(200, { 'Content-Type': sniffImage(bytes) || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : bytes);
  });
}
