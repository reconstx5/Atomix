// Artwork cache. Item image fields are stored as one of:
//   cache:<file>   downloaded into data/images
//   file:<path>    artwork sitting next to the media (poster.jpg etc.)
//   http(s)://...  remote image (plugin sources) — fetched & cached on demand
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../log.js';
import { fetchFollowing } from '../remote/provider.js';

const log = logger('images');
const inflight = new Map();

export class ImageCache {
  constructor(config) {
    this.dir = config.imagesDir;
  }

  /** Extension from the URL when it has one; otherwise from the response type (a connected server's image routes
   *  carry no extension), falling back to jpg. */
  extFor(url, contentType = '') {
    const fromUrl = /\.(jpe?g|png|webp|gif)(?:$|\?)/i.exec(url)?.[1];
    const fromType = /^image\/(jpe?g|png|webp|gif)/i.exec(contentType)?.[1];
    return (fromUrl || fromType || 'jpg').toLowerCase().replace('jpeg', 'jpg');
  }

  fileFor(url, contentType) {
    return crypto.createHash('sha1').update(url).digest('hex') + '.' + this.extFor(url, contentType);
  }

  /** A cached file for this URL under any of the known extensions, or null. */
  cachedFor(url) {
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    for (const ext of ['jpg', 'png', 'webp', 'gif']) if (fs.existsSync(path.join(this.dir, `${hash}.${ext}`))) return `${hash}.${ext}`;
    return null;
  }

  /** Delete the cached file for a URL (any extension), if there is one: a superseded or removed server's picture. */
  forget(url) {
    if (!/^https?:\/\//i.test(url || '')) return;
    const name = this.cachedFor(url);
    if (name) fs.rmSync(path.join(this.dir, name), { force: true });
  }

  /** Download a remote image once and return a `cache:` reference. */
  async download(url, headers = {}) {
    if (!/^https?:\/\//i.test(url)) return null;
    const have = this.cachedFor(url);
    if (have) return `cache:${have}`;
    const key = crypto.createHash('sha1').update(url).digest('hex');
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        // With a sign-in, redirects are followed here: the headers go only to the server's own address.
        const signal = AbortSignal.timeout(20000);
        const res = headers && Object.keys(headers).length ? await fetchFollowing(url, { headers, signal }) : await fetch(url, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
        const name = this.fileFor(url, type);
        const dest = path.join(this.dir, name);
        const buf = Buffer.from(await res.arrayBuffer());
        const tmp = dest + '.tmp';
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, dest);
        return `cache:${name}`;
      } catch (err) {
        log.warn(`Could not download ${url}: ${err.message}`);
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
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
