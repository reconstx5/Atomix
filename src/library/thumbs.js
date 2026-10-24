// Smaller copies of artwork (v0.24): a picture asked for at a width is scaled once by ffmpeg to the nearest size on
// a short ladder and kept in cacheDir/thumbs/, so a phone or a card never downloads a 1280-px original. A copy is
// never bigger than its original; while one is being made (or if it can't be), the original is sent instead.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run as probeRun } from './probe.js';
import { imageSize } from '../books/image-size.js';
import { sendFile, mimeFor } from '../http/static.js';

export const LADDERS = {
  poster: [200, 300, 450, 600],
  square: [200, 300, 450, 600],
  backdrop: [480, 960, 1280, 1920],
  logo: [400, 800],
};

const TYPES = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
const DAY = 86_400_000;

/** The ladder size a width asks for: the smallest step at or above it (the top step above the ladder). */
export function snapWidth(type, w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A size that is a step on any ladder is used as it is: a landscape card asks for a backdrop width of a picture
  // stored as a poster (an episode still, an extra's thumbnail). Still only the ladders' sizes are ever made.
  if (type !== 'logo' && STEPS.has(n)) return n;
  const ladder = LADDERS[type] || LADDERS.poster;
  return ladder.find((s) => s >= n) ?? ladder.at(-1);
}
const STEPS = new Set([...LADDERS.poster, ...LADDERS.backdrop]);

async function head(file, bytes = 65536) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export class Thumbs {
  constructor({ config, tools, maxJobs = 2, waitMs = 1500, failMs = 3_600_000, now = Date.now, run = probeRun }) {
    this.config = config;
    this.tools = tools;
    this.maxJobs = maxJobs;
    this.waitMs = waitMs;
    this.failMs = failMs;
    this.now = now;
    this.run = run;
    this.dir = path.join(config.cacheDir, 'thumbs');
    this.jobs = new Map(); // output file → Promise<boolean>
    this.failed = new Map(); // output file → when it failed
    this.touched = new Map(); // output file → when its mtime was last bumped (the sweep's "last used")
    this.active = 0;
    this.waiting = [];
  }

  /**
   * The file to send for a picture asked for at `width`: a copy, or the original.
   * @returns {Promise<{ file: string, contentType: string }>}
   */
  async picture(file, { type = 'poster', width = null, webp = false } = {}) {
    const original = { file, contentType: mimeFor(file) };
    // Sent in place of a copy that isn't ready (or can't be made): the browser must ask again later (review fix).
    const fallback = { ...original, fallback: true };
    const w = snapWidth(type, width);
    if (!w) return original;
    if (!this.tools?.ffmpeg?.available) return fallback;
    try {
      const stat = await fs.promises.stat(file);
      const dims = imageSize(await head(file));
      if (!dims?.width || dims.width <= w) return original; // never bigger than the original
      const ext = type === 'logo' ? (webp && this.tools.webp ? 'webp' : 'png') : webp && this.tools.webp ? 'webp' : 'jpg';
      const folder = path.join(this.dir, crypto.createHash('sha1').update(file).digest('hex'));
      const out = path.join(folder, `${Math.floor(stat.mtimeMs)}-${stat.size}-${w}.${ext}`);
      if (fs.existsSync(out)) {
        this.touch(out);
        return { file: out, contentType: TYPES[ext] };
      }
      const failedAt = this.failed.get(out);
      if (failedAt != null && this.now() - failedAt < this.failMs) return fallback;
      let job = this.jobs.get(out);
      if (!job) {
        job = this.make(file, folder, out, { w, ext, logo: type === 'logo' }).finally(() => this.jobs.delete(out));
        this.jobs.set(out, job);
      }
      let timer;
      const late = new Promise((resolve) => (timer = setTimeout(() => resolve(false), this.waitMs)));
      const made = await Promise.race([job, late]);
      clearTimeout(timer);
      return made ? { file: out, contentType: TYPES[ext] } : fallback;
    } catch {
      return fallback;
    }
  }

  async slot() {
    if (this.active < this.maxJobs) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    this.waiting.shift()?.();
  }

  /** Make one copy (at most maxJobs at once). Resolves true when it exists, false when it failed. */
  async make(file, folder, out, { w, ext, logo }) {
    await this.slot();
    const tmp = `${out}.tmp.${ext}`;
    try {
      await fs.promises.mkdir(folder, { recursive: true });
      const source = path.join(folder, 'source');
      if (!fs.existsSync(source)) await fs.promises.writeFile(source, file);
      const codec = ext === 'webp' ? ['-c:v', 'libwebp', '-quality', '80', ...(logo ? ['-pix_fmt', 'yuva420p'] : [])] : ext === 'jpg' ? ['-q:v', '3'] : [];
      await this.run(this.config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-vf', `scale=${w}:-2:flags=lanczos`, '-frames:v', '1', ...codec, tmp], { timeout: 30000 });
      const st = await fs.promises.stat(tmp);
      if (!st.size) throw new Error('empty');
      await fs.promises.rename(tmp, out);
      return true;
    } catch {
      this.failed.set(out, this.now());
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      return false;
    } finally {
      this.release();
    }
  }

  /**
   * Housekeeping (daily): copies of pictures that are gone or that no title uses any more go, stale copies of a
   * changed original go, then the least recently used copies until the folder is under `limitBytes`.
   * @param {{ referenced: Set<string>, limitBytes: number }} o
   * @returns {Promise<{ removed: number, bytes: number }>} folders removed, and the bytes left
   */
  async sweep({ referenced, limitBytes }) {
    let removed = 0;
    const kept = [];
    let names = [];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return { removed: 0, bytes: 0 };
    }
    for (const name of names) {
      const folder = path.join(this.dir, name);
      const source = await fs.promises.readFile(path.join(folder, 'source'), 'utf8').catch(() => null);
      const stat = source ? await fs.promises.stat(source).catch(() => null) : null;
      if (!stat || !referenced.has(source)) {
        await fs.promises.rm(folder, { recursive: true, force: true });
        removed++;
        continue;
      }
      const current = `${Math.floor(stat.mtimeMs)}-${stat.size}-`;
      for (const f of await fs.promises.readdir(folder)) {
        if (f === 'source' || f.includes('.tmp.')) continue;
        const file = path.join(folder, f);
        if (!f.startsWith(current)) {
          await fs.promises.rm(file, { force: true });
          continue;
        }
        const st = await fs.promises.stat(file).catch(() => null);
        if (st) kept.push({ file, size: st.size, used: st.mtimeMs });
      }
    }
    let bytes = kept.reduce((n, k) => n + k.size, 0);
    kept.sort((a, b) => a.used - b.used);
    for (const k of kept) {
      if (bytes <= limitBytes) break;
      await fs.promises.rm(k.file, { force: true });
      bytes -= k.size;
    }
    return { removed, bytes };
  }

  /** Mark a copy used (its mtime), at most once a day, for the sweep's least-used order. */
  touch(out) {
    const last = this.touched.get(out) || 0;
    if (this.now() - last < DAY) return;
    this.touched.set(out, this.now());
    const t = new Date();
    fs.promises.utimes(out, t, t).catch(() => {});
  }
}

/**
 * Send a picture file, sized when the request asks (`?w=`) and in WebP when it accepts it. An address with a
 * version (`?v=`) may be kept for a year when the picture can't change under it (`stable`: a downloaded copy named
 * by its source); a folder's own poster.jpg can be replaced in place, so it keeps the week and ETag check. An
 * original sent while its copy is still being made is never kept (the next view gets the copy). A width above the
 * ladder's top asks for the original (a music app's full-screen cover).
 */
export async function sendPicture(core, ctx, file, { type = 'poster', cacheControl = 'private, max-age=604800', stable = false } = {}) {
  const top = (LADDERS[type] || LADDERS.poster).at(-1);
  const asked = Number(ctx.query?.w);
  const width = asked > 0 && asked <= top ? asked : null;
  const webp = /image\/webp/.test(ctx.req.headers.accept || '');
  const pic = core.thumbs && width ? await core.thumbs.picture(file, { type, width, webp }) : { file, contentType: undefined };
  const cache = pic.fallback ? 'private, no-cache' : ctx.query?.v && stable ? 'private, max-age=31536000, immutable' : cacheControl;
  return sendFile(ctx.req, ctx.res, pic.file, {
    contentType: pic.contentType,
    cacheControl: cache,
    headers: ctx.query?.w ? { Vary: 'Accept' } : undefined,
  });
}

/**
 * The picture files titles and collections use (the sweep keeps their copies): local and downloaded artwork, and a
 * connected server's pictures by the copy downloaded for them.
 */
export function referencedPictures(db, images) {
  const out = new Set();
  const add = (ref) => {
    if (!ref) return;
    const r = images.resolve(ref);
    if (r?.file) out.add(r.file);
    else if (r?.url) {
      const kept = images.cachedPicture?.(r.url);
      const f = kept && images.resolve(kept)?.file;
      if (f) out.add(f);
    }
  };
  for (const r of db.all('SELECT poster, backdrop, logo FROM items WHERE poster IS NOT NULL OR backdrop IS NOT NULL OR logo IS NOT NULL')) [r.poster, r.backdrop, r.logo].forEach(add);
  for (const r of db.all('SELECT poster, backdrop FROM collections')) [r.poster, r.backdrop].forEach(add);
  return out;
}
