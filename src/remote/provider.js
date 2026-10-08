// What every connected-server kind provides. `server` is a row of the `servers` table.
//
//   connect({ url, username, password }) → { secret, remoteUserId, serverName }   (throws HttpError 400/401/502)
//   libraries(server) → [{ remoteId, name, type: 'movies'|'tv'|'music' }]
//   items(server, library, kind, parentRemoteId?) → async iterable of RemoteItem
//   imageUrl(server, item, type) → { url, headers } | null                            (poster|backdrop|logo)
//   streamUrl(server, item) → { url, headers }
//   imageHeaders(server, url) → headers for fetching an image URL: the sign-in only for the server's own host
//   reportStart / reportStop(server, item, { position, duration }) → Promise<void>   (best effort; may do nothing)
//   reportProgress(server, item, { position, duration, watched, paused }) → Promise<void>     (best effort)
//   details?(server, item) → media | null    (only where the listing lacks the real tracks: Plex)
//   ping(server) → { ok, detail, unreachable? }
//
// RemoteItem: { remoteId, kind, title, sortTitle, year, overview, tagline, genres, rating, runtime, airDate,
//   certification, tmdbId, imdbId, keywords, people, season, episode, artist, album, track, disc, duration,
//   media | null, images: { poster, backdrop, logo }, parentRemoteId, addedAt (ms) | null, updated (ms) | null }
import { HttpError } from '../http/router.js';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * fetch with the redirects handled here, so a connected server's sign-in never follows a redirect to another site:
 * the same origin is followed with `headers` (at most `max` times); another origin is a refusal (`sameOriginOnly`,
 * streams: code ECROSSORIGIN) or followed with no headers at all (images on a CDN).
 * @returns {Promise<Response>}
 */
export async function fetchFollowing(url, { headers = {}, method = 'GET', signal, sameOriginOnly = false, max = 3 } = {}) {
  const origin = new URL(url).origin;
  let current = url;
  let h = { ...headers };
  for (let hops = 0; ; hops++) {
    const res = await fetch(current, { method, headers: h, signal, redirect: 'manual' });
    const location = REDIRECTS.has(res.status) && res.headers.get('location');
    if (!location) return res;
    await res.body?.cancel().catch(() => {});
    if (hops >= max) throw Object.assign(new Error('Too many redirects'), { code: 'EREDIRECT' });
    const next = new URL(location, current);
    if (!/^https?:$/.test(next.protocol)) throw Object.assign(new Error('Redirected to an unsupported address'), { code: 'EREDIRECT' });
    if (next.origin !== origin) {
      if (sameOriginOnly) throw Object.assign(new Error('Redirected to another site'), { code: 'ECROSSORIGIN' });
      h = {};
    }
    current = next.href;
  }
}

export class RemoteProvider {
  constructor({ kind, version = '0' } = {}) {
    this.kind = kind;
    this.version = version;
  }
  /** fetch with a timeout; 401 → HttpError 401, network trouble or 5xx → HttpError 502 naming the server. */
  async request(server, url, { method = 'GET', headers = {}, body, timeoutMs = 15000, raw = false } = {}) {
    let res;
    try {
      res = await fetch(url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    } catch (err) {
      throw new HttpError(502, `Can't reach ${server?.name || 'the server'}: ${err.cause?.code || (err.name === 'TimeoutError' ? 'no answer' : err.cause?.message || err.message)}`);
    }
    if (res.status === 401) throw new HttpError(401, `${server?.name || 'The server'} no longer accepts this sign-in.`);
    if (res.status === 403) throw new HttpError(502, `${server?.name || 'The server'} refused that (403).`);
    if (res.status >= 500) throw new HttpError(502, `Can't reach ${server?.name || 'the server'}: it answered ${res.status}.`);
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `${server?.name || 'The server'} answered ${res.status}.`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new HttpError(502, `${server?.name || 'The server'} sent something that isn't JSON.`);
    }
  }
  connect() { throw new HttpError(500, 'not implemented'); }
  libraries() { throw new HttpError(500, 'not implemented'); }
  async *items() { throw new HttpError(500, 'not implemented'); }
  imageUrl() { return null; }
  /** An image on the server's own host gets the sign-in; anywhere else (a metadata CDN) gets nothing. */
  imageHeaders(server, url) {
    const base = String(server.url || '').replace(/\/+$/, '');
    return base && (url === base || String(url).startsWith(`${base}/`)) ? this.headers?.(server) || {} : {};
  }
  async reportStart() {}
  async reportStop() {}
  streamUrl() { throw new HttpError(500, 'not implemented'); }
  async reportProgress() {}
  async ping() { return { ok: false, detail: 'not implemented' }; }
}
