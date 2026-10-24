// Who may download (v0.21): admins always, other accounts when an admin switched it on — and only while the server's
// downloads are switched on.
import { HttpError } from '../http/router.js';

export const canDownload = (user, settings) => Boolean(user) && settings.get('downloadsEnabled') !== false && (user.role === 'admin' || user.can_download === 1);

/** A 403 with the sentence that says why, when this account may not download. */
export function requireDownloads(user, settings) {
  if (settings.get('downloadsEnabled') === false) throw new HttpError(403, 'Downloads are switched off on this server.');
  if (!canDownload(user, settings)) throw new HttpError(403, "Downloads aren't switched on for this account. Ask an admin.");
}

/** The account may download (the server's own switch aside: it only stops new downloads). */
export function requireAccountDownloads(user) {
  if (!(user && (user.role === 'admin' || user.can_download === 1))) throw new HttpError(403, "Downloads aren't switched on for this account. Ask an admin.");
}

/**
 * Keys seen once (the activity line for a first fetch): each kept for `ttlMs` (24 h), at most `max` (5,000) — the
 * oldest go first — so the set can't grow for as long as the server runs.
 */
export class FetchedOnce {
  constructor({ max = 5000, ttlMs = 24 * 3600_000, now = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    this.seen = new Map(); // key → when (insertion order = age)
  }
  get size() {
    return this.seen.size;
  }
  /** True the first time a key is seen (within the time limit), false after. */
  first(key) {
    const now = this.now();
    for (const [k, at] of this.seen) {
      if (now - at <= this.ttlMs) break;
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value);
    return true;
  }
}
