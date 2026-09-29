// Artwork cache. Item image fields are stored as one of:
//   cache:<file>   downloaded into data/images
//   file:<path>    artwork sitting next to the media (poster.jpg etc.)
//   http(s)://...  remote image (plugin sources) — fetched & cached on demand
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../log.js';

const log = logger('images');
const inflight = new Map();

export class ImageCache {
  constructor(config) {
    this.dir = config.imagesDir;
  }

  fileFor(url) {
    const ext = (/\.(jpe?g|png|webp|gif)(?:$|\?)/i.exec(url)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
    return crypto.createHash('sha1').update(url).digest('hex') + '.' + ext;
  }

  /** Download a remote image once and return a `cache:` reference. */
  async download(url, headers = {}) {
    if (!/^https?:\/\//i.test(url)) return null;
    const name = this.fileFor(url);
    const dest = path.join(this.dir, name);
    if (fs.existsSync(dest)) return `cache:${name}`;
    if (inflight.has(name)) return inflight.get(name);
    const job = (async () => {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const tmp = dest + '.tmp';
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, dest);
        return `cache:${name}`;
      } catch (err) {
        log.warn(`Could not download ${url}: ${err.message}`);
        return null;
      } finally {
        inflight.delete(name);
      }
    })();
    inflight.set(name, job);
    return job;
  }

  /** Normalise whatever a metadata provider returned into a stored reference. */
  async store(value) {
    if (!value) return null;
    if (value.startsWith('cache:') || value.startsWith('file:')) return value;
    if (/^https?:\/\//i.test(value)) return this.download(value);
    if (path.isAbsolute(value) && fs.existsSync(value)) return `file:${value}`;
    return null;
  }

  /** Resolve a stored reference to a local file path (or a remote URL). */
  resolve(ref) {
    if (!ref) return null;
    if (ref.startsWith('cache:')) {
      const name = path.basename(ref.slice(6));
      return { file: path.join(this.dir, name) };
    }
    if (ref.startsWith('file:')) return { file: ref.slice(5) };
    if (/^https?:\/\//i.test(ref)) return { url: ref };
    return null;
  }
}
