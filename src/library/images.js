// Artwork cache. Item image fields are stored as one of:
//   cache:<file>   downloaded into data/images
//   file:<path>    artwork sitting next to the media (poster.jpg etc.)
//   http(s)://...  remote image (plugin sources) — fetched & cached on demand
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../log.js';
import { redactUrl, checkResolved } from '../http/net.js';

// Every hop is checked, names too: an image address (often from someone else's playlist) can't lead to link-local.
const refusePrivate = (lookup) => (u) => checkResolved(u, lookup ? { lookup } : {});
import { fetchFollowing } from '../remote/provider.js';

const log = logger('images');
const IMAGE_MAX = 10 * 1024 * 1024; // a poster or logo; anything bigger isn't kept
const FAILED_FOR_MS = 60 * 60_000; // an address that failed isn't asked again (or logged again) for an hour
const inflight = new Map();
const KNOWN_MAX = 2000; // checked pictures remembered by address
// Servers that send pictures without saying so (many CDNs: "application/octet-stream"): the bytes decide.
const GENERIC_TYPE = /^(application|binary)\/octet-stream\b|^$/i;

/** The image type its first bytes say (PNG, JPEG, GIF, WebP, AVIF/HEIF, BMP, ICO), or null. */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(avif|avis|heic|heix|mif1)$/.test(buf.subarray(8, 12).toString('latin1'))) return buf.subarray(8, 12).toString('latin1').startsWith('av') ? 'image/avif' : 'image/heic';
  if (buf.length >= 14 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf[4] + buf[5] > 0) return 'image/x-icon';
  return null;
}

export class ImageCache {
  constructor(config) {
    this.dir = config.imagesDir;
    this.lookup = config.lookup || null; // tests inject a resolver
    this.now = config.now || Date.now;
    this.failed = new Map(); // url hash → when it last failed
    this.known = new Map(); // url → a kept file already checked to be a picture (v0.22: no re-check per request)
  }

  /** Remember a checked file for a URL (oldest dropped past KNOWN_MAX). */
  noteKnown(url, name) {
    this.known.delete(url);
    this.known.set(url, name);
    while (this.known.size > KNOWN_MAX) this.known.delete(this.known.keys().next().value);
  }

  /** The `cache:` reference of a kept, checked picture for this URL, or null — reading the network never. */
  cachedPicture(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    const name = this.known.get(url);
    if (name) {
      if (fs.existsSync(path.join(this.dir, name))) return `cache:${name}`;
      this.known.delete(url); // it has gone from disk
    }
    const have = this.cachedFor(url);
    if (!have || this.isPageNotPicture(path.join(this.dir, have))) return null;
    this.noteKnown(url, have);
    return `cache:${have}`;
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
    this.known.delete(url);
    const name = this.cachedFor(url);
    if (name) fs.rmSync(path.join(this.dir, name), { force: true });
  }

  /** Whether a kept file is plainly not a picture (a page or text kept under an image name, before the bytes were
   *  always checked). Anything else is left alone: a format this check doesn't know may still be one. */
  isPageNotPicture(file) {
    try {
      const fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(64);
      const n = fs.readSync(fd, head, 0, 64, 0);
      fs.closeSync(fd);
      return /^\s*[<{]/.test(head.subarray(0, n).toString('latin1'));
    } catch {
      return false;
    }
  }

  /** Download a remote image once and return a `cache:` reference. */
  async download(url, headers = {}) {
    if (!/^https?:\/\//i.test(url)) return null;
    const kept = this.cachedPicture(url);
    if (kept) return kept;
    const have = this.cachedFor(url);
    // A copy kept from before the bytes were always checked that isn't a picture goes (and is asked again).
    if (have) fs.rmSync(path.join(this.dir, have), { force: true });
    const key = crypto.createHash('sha1').update(url).digest('hex');
    if (inflight.has(key)) return inflight.get(key);
    const failedAt = this.failed.get(key);
    if (failedAt != null && this.now() - failedAt < FAILED_FOR_MS) return null;
    const job = (async () => {
      try {
        // With a sign-in, redirects are followed here: the headers go only to the server's own address.
        const signal = AbortSignal.timeout(20000);
        // Every hop is checked: an image address (often from someone else's playlist) can't lead to a link-local one.
        const res = await fetchFollowing(url, { headers: headers || {}, signal, check: refusePrivate(this.lookup) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let type = res.headers.get('content-type') || '';
        const generic = GENERIC_TYPE.test(type.trim());
        if (!type.startsWith('image/') && !generic) throw new Error(`not an image (${type})`);
        const length = Number(res.headers.get('content-length'));
        if (length > IMAGE_MAX) {
          await res.body?.cancel().catch(() => {});
          throw new Error('too large');
        }
        const parts = [];
        let size = 0;
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > IMAGE_MAX) throw new Error('too large'); // a stream with no length (or a wrong one)
          parts.push(chunk);
        }
        const buf = Buffer.concat(parts.map((c) => Buffer.from(c)));
        // Kept only when the bytes are a picture, whatever the label says (a sign-in page can call itself image/png);
        // a generic label is named by what the bytes are.
        const sniffed = sniffImage(buf);
        if (!sniffed) throw new Error(`not an image (${res.headers.get('content-type') || 'no type'})`);
        if (generic) type = sniffed;
        const name = generic ? `${key}.${this.extFor('', type)}` : this.fileFor(url, type);
        const dest = path.join(this.dir, name);
        const tmp = dest + '.tmp';
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, dest);
        this.failed.delete(key);
        this.noteKnown(url, name);
        return `cache:${name}`;
      } catch (err) {
        this.failed.set(key, this.now());
        log.warn(`Could not download ${redactUrl(url)}: ${err.message} (not asked again for an hour)`); // the path or query may hold a login
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
