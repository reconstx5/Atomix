// Each profile's stars (1–5) and hearts (favourites) for songs, albums, artists, films and shows. Any profile —
// Kids included — rates what it can see; the routes check visibility.
import { HttpError } from '../http/router.js';

export const RATEABLE = new Set(['track', 'album', 'artist', 'movie', 'show']);

/** The profile's ratings of these items: Map<id, { stars, favourite }> (only rated items are in it). */
export function ratingsFor(db, profileId, ids) {
  if (!profileId || !ids.length) return new Map();
  const rows = db.all(`SELECT item_id, stars, favourite FROM user_ratings WHERE profile_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`, profileId, ...ids);
  return new Map(rows.map((r) => [r.item_id, { stars: r.stars ?? null, favourite: Boolean(r.favourite) }]));
}

export class UserRatings {
  constructor({ db }) {
    this.db = db;
  }
  get(profileId, ids) {
    return ratingsFor(this.db, profileId, ids);
  }
  /** Fields left undefined keep their value; `stars: null` clears the stars. */
  set(profileId, item, { stars, favourite } = {}) {
    if (!RATEABLE.has(item.kind)) throw new HttpError(400, 'Only songs, albums, artists, films and shows can be rated.');
    if (stars !== undefined && stars !== null && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw new HttpError(400, 'Stars are 1 to 5.');
    const now = this.get(profileId, [item.id]).get(item.id) || { stars: null, favourite: false };
    const next = { stars: stars === undefined ? now.stars : stars, favourite: favourite === undefined ? now.favourite : (favourite === true || favourite === 1 || favourite === 'true' || favourite === '1') };
    if (next.stars == null && !next.favourite) this.db.run('DELETE FROM user_ratings WHERE profile_id = ? AND item_id = ?', profileId, item.id);
    else
      this.db.run(
        `INSERT INTO user_ratings (profile_id, item_id, stars, favourite, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, item_id) DO UPDATE SET stars = excluded.stars, favourite = excluded.favourite, updated_at = excluded.updated_at`,
        profileId, item.id, next.stars, next.favourite ? 1 : 0, Date.now(),
      );
    return next;
  }
}
