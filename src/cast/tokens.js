// Cast links: the private, short-lived token a TV (or an Apple TV through AirPlay) uses to fetch one title's media
// from Atomix without a sign-in. A link serves only its own item (and that item's show/album artwork) or its own
// playback session, only on the media routes, and dies with its cast or playback session, after 12 h at most.
import crypto from 'node:crypto';

const ROUTES = new Set(['file', 'stream', 'subtitle', 'image']);

export class CastLinks {
  /** @param {{ db?: object }} opts  db lets an image link cover the item's show and album artwork */
  constructor({ db } = {}) {
    this.db = db;
    this.links = new Map(); // token → { itemId, related, sessionId, castId, userId, profileId, expires }
  }
  /** @returns {string} 32 random bytes, URL-safe */
  issue({ sessionId = null, itemId = null, userId, profileId = null, castId = null, ttlMs = 12 * 3600 * 1000 }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const row = itemId != null && this.db ? this.db.get('SELECT show_id, parent_id FROM items WHERE id = ?', itemId) : null;
    const related = [row?.show_id, row?.parent_id].filter((x) => x != null).map(Number);
    this.links.set(token, { itemId: itemId != null ? Number(itemId) : null, related, sessionId, castId, userId, profileId, expires: Date.now() + ttlMs });
    return token;
  }
  sweep() {
    const now = Date.now();
    for (const [t, l] of this.links) if (l.expires <= now) this.links.delete(t);
  }
  /**
   * @param {string} token
   * @param {{ route: 'file'|'stream'|'subtitle'|'image', itemId?: number|string, sessionId?: string }} want
   * @returns {object|null} the link, when it may serve that request
   */
  check(token, { route, itemId, sessionId } = {}) {
    this.sweep();
    const l = token && this.links.get(String(token));
    if (!l || !ROUTES.has(route)) return null;
    if (route === 'stream') return sessionId && l.sessionId === sessionId ? l : null;
    const id = Number(itemId);
    if (l.itemId === id) return l;
    if (route === 'image' && l.related.includes(id)) return l;
    return null;
  }
  revoke(token) {
    this.links.delete(token);
  }
  /** Every link for a playback session (it stopped). */
  revokeSession(sessionId) {
    for (const [t, l] of this.links) if (l.sessionId === sessionId) this.links.delete(t);
  }
  /** Every link for a cast session (it ended). */
  revokeCast(castId) {
    for (const [t, l] of this.links) if (l.castId === castId) this.links.delete(t);
  }
}
