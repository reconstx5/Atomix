// FairPlay channels' HLS playlists, rewritten for the browser (v0.27): every address becomes
// /api/live/drm/<sid>/r/<n><path><query>, where <n> is the provider origin the session keeps (session.bases), so
// Safari only ever asks Atomix. skd:// key ids (FairPlay's own) and data: URIs stay as written; key lines for other
// systems and the tags that would send the browser elsewhere (session data, content steering) are dropped.

const MAX_ORIGINS = 64; // an HLS session's provider origins; slots are never reused (playlists refresh in parallel)
const DROPPED = new Set(['EXT-X-SESSION-DATA', 'EXT-X-CONTENT-STEERING']);
const KEPT_SCHEMES = /^(skd|data):/i;
const PLAYLIST_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(x-)?mpegurl)\b/i;
// Every attribute that holds an address, on any tag (URI, X-ASSET-URI, X-ASSET-LIST, a future …-URI): whole names only.
const ADDRESS_ATTR = /(^|[:,])((?:[A-Z0-9-]*-)?URI|X-ASSET-LIST)="([^"]*)"/g;

/** Is this answer a playlist (to rewrite) rather than a segment (to pass along)? By its type, else by `.m3u8`. */
export function isPlaylist(url, contentType) {
  if (contentType && PLAYLIST_TYPES.test(String(contentType).trim())) return true;
  return /\.m3u8$/i.test(url.pathname);
}

/** The session's slot for an origin (added at the end; refused past 64). */
function slotOf(session, origin) {
  let n = session.bases.indexOf(origin);
  if (n >= 0) return n;
  if (session.bases.length >= MAX_ORIGINS) throw new Error('playlist too big');
  return session.bases.push(origin) - 1;
}

/**
 * @param {string} text the provider's playlist
 * @param {string} playlistUrl where it really came from (after redirects): relative addresses resolve against it
 * @param {{ id: string, bases: string[] }} session
 * @returns {string}
 */
export function rewritePlaylist(text, playlistUrl, session) {
  const src = String(text || '').replace(/^﻿/, '');
  if (!/^#EXTM3U/.test(src)) throw new Error('not an HLS playlist');
  const prefix = `/api/live/drm/${session.id}/r/`;
  const relay = (ref) => {
    const u = new URL(ref, playlistUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not a network address');
    return `${prefix}${slotOf(session, u.origin)}${u.pathname}${u.search}`;
  };
  const out = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      out.push(relay(line));
      continue;
    }
    if (!line.startsWith('#EXT')) continue; // a comment: nothing Safari needs, and it may name the provider
    const tag = /^#([A-Z0-9-]+)/.exec(line)?.[1] || '';
    if (DROPPED.has(tag)) continue;
    let drop = false;
    // A callback, so a "$&" in an address is copied as it is (not read as a replacement pattern).
    const rewritten = line.replace(ADDRESS_ATTR, (all, lead, name, uri) => {
      if (KEPT_SCHEMES.test(uri)) return all;
      // Another system's key (PlayReady's own scheme, …), or an address that isn't http(s): not Safari's to use.
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^https?:/i.test(uri)) {
        drop = true;
        return all;
      }
      return `${lead}${name}="${relay(uri)}"`;
    });
    if (!drop) out.push(rewritten);
  }
  return `${out.join('\n')}\n`;
}
