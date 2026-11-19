// Read-side queries shared by the API, the home screen and plugins.
//
// Everything that returns items takes a `viewer` — who is watching:
//   { userId, profileId, kids, maxAge, allowUnrated, libraryIds }
// so library access and Kids-profile age limits are applied in one place.
import { SPOKEN_KINDS, READING_KINDS } from './kinds.js';
import { ratingsFor } from './userratings.js';
import { serializeItem } from '../api/serialize.js';
import { EXTRA_CAPTIONS } from './parser.js';
import { ensureSearchKeys, keyMatch, keyPrefix } from './searchkey.js';

const DEVICES = new Set(['phone', 'tablet', 'computer', 'TV']);
/** A place in a book ({ chapter, offset }) or a comic ({ page }) — whole numbers — or null. */
function cleanLocator(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const n = (x) => Number.isInteger(x) && x >= 0 && x < 1e9;
  if (n(v.page)) return JSON.stringify({ page: v.page });
  if (n(v.chapter) && n(v.offset)) return JSON.stringify({ chapter: v.chapter, offset: v.offset });
  return null;
}

const SORTS = {
  title: 'i.sort_title COLLATE NOCASE ASC, i.year ASC',
  added: 'i.added_at DESC',
  year: 'i.year DESC, i.sort_title COLLATE NOCASE ASC',
  rating: 'i.rating DESC NULLS LAST, i.sort_title COLLATE NOCASE ASC',
  episode: 'i.season ASC, i.episode ASC',
  track: 'i.season ASC, i.episode ASC, i.sort_title COLLATE NOCASE ASC',
  random: 'RANDOM()',
  shortest: 'length(i.title) ASC, i.sort_title COLLATE NOCASE ASC', // v0.24: suggestions
};

// Music isn't age-rated; parents limit it by taking the library away instead.
const UNRATED_KINDS = "('artist','album','track')";

/** An all-seeing viewer for internal jobs (scanner, admin tools). */
export const EVERYONE = Object.freeze({ userId: 0, profileId: 0, kids: false, maxAge: null, allowUnrated: true, libraryIds: null });

export class Library {
  constructor(db) {
    this.db = db;
  }

  /** SQL condition limiting rows (alias `a`) to what the viewer may see. */
  visibility(viewer, a = 'i') {
    const parts = [];
    const params = [];
    if (viewer?.libraryIds) {
      if (!viewer.libraryIds.length) parts.push('0');
      else {
        parts.push(`${a}.library_id IN (${viewer.libraryIds.map(() => '?').join(',')})`);
        params.push(...viewer.libraryIds);
      }
    }
    if (viewer?.maxAge != null) {
      const age = `COALESCE(${a}.min_age, (SELECT s.min_age FROM items s WHERE s.id = ${a}.show_id))`;
      // v0.22: a series of books or comics shows when one of its titles may be seen (by its own rating, else the series').
      const inner = `COALESCE(b.min_age, ${a}.min_age)`;
      const series = `(${a}.kind = 'series' AND EXISTS (SELECT 1 FROM items b WHERE b.show_id = ${a}.id AND b.kind IN ('book', 'comic') AND (${inner} <= ?${viewer.allowUnrated ? ` OR ${inner} IS NULL` : ''})))`;
      parts.push(`(${a}.kind IN ${UNRATED_KINDS} OR ${series} OR (${a}.kind != 'series' AND (${age} <= ?${viewer.allowUnrated ? ` OR ${age} IS NULL` : ''})))`);
      params.push(viewer.maxAge, viewer.maxAge);
    }
    // Kids: a Live TV recording only from a channel in one of the profile's ticked groups (a show or season of the
    // Recordings library only with such an episode).
    if (viewer?.kids && viewer.profileId) {
      const blocked = (e) =>
        `EXISTS (SELECT 1 FROM live_recordings r WHERE r.item_id = ${e}.id AND NOT EXISTS (SELECT 1 FROM live_channels c, json_each(c.groups) j, live_kids_groups g WHERE c.id = r.channel_id AND g.profile_id = ? AND g.source = c.source AND g.grp = j.value))`;
      const under = (e) => `(${e}.show_id = ${a}.id OR ${e}.parent_id = ${a}.id)`;
      parts.push(
        `NOT (${a}.kind = 'episode' AND ${blocked(a)})`,
        `NOT (${a}.kind IN ('show','season') AND EXISTS (SELECT 1 FROM items e JOIN live_recordings r ON r.item_id = e.id WHERE ${under('e')}) AND NOT EXISTS (SELECT 1 FROM items e WHERE e.kind = 'episode' AND ${under('e')} AND NOT ${blocked('e')}))`,
      );
      params.push(viewer.profileId, viewer.profileId);
    }
    return { sql: parts.length ? parts.join(' AND ') : '1', params };
  }

  /** A film's or show's extras the viewer may see, in kind order then title. */
  extrasOf(ownerId, viewer) {
    const vis = this.visibility(viewer);
    const order = Object.keys(EXTRA_CAPTIONS).map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ');
    return this.db.all(`SELECT i.* FROM items i WHERE i.kind = 'extra' AND i.parent_id = ? AND ${vis.sql} ORDER BY CASE i.extra_kind ${order} ELSE 99 END, i.sort_title COLLATE NOCASE`, ownerId, ...vis.params);
  }

  /** Same rules as visibility(), for a single row already loaded. */
  canSee(viewer, row) {
    if (!row) return false;
    if (viewer?.libraryIds && !viewer.libraryIds.includes(row.library_id)) return false;
    if (viewer?.kids && viewer.profileId && ['episode', 'show', 'season'].includes(row.kind) && this.db.get('SELECT 1 FROM live_recordings LIMIT 1')) {
      const vis = this.visibility({ kids: true, profileId: viewer.profileId });
      if (!this.db.get(`SELECT 1 FROM items i WHERE i.id = ? AND ${vis.sql}`, row.id, ...vis.params)) return false;
    }
    if (viewer?.maxAge != null && row.kind === 'series') {
      const vis = this.visibility({ maxAge: viewer.maxAge, allowUnrated: viewer.allowUnrated });
      return Boolean(this.db.get(`SELECT 1 FROM items i WHERE i.id = ? AND ${vis.sql}`, row.id, ...vis.params));
    }
    if (viewer?.maxAge != null && !['artist', 'album', 'track'].includes(row.kind)) {
      let age = row.min_age;
      if (age == null && row.show_id) age = this.db.get('SELECT min_age FROM items WHERE id = ?', row.show_id)?.min_age;
      if (age == null) return Boolean(viewer.allowUnrated);
      return age <= viewer.maxAge;
    }
    return true;
  }

  visibleLibraries(viewer) {
    const libs = this.db.all('SELECT l.*, s.name AS server_name FROM libraries l LEFT JOIN servers s ON s.id = l.server_id ORDER BY l.name');
    return viewer?.libraryIds ? libs.filter((l) => viewer.libraryIds.includes(l.id)) : libs;
  }

  progressFor(profileId, ids) {
    if (!ids.length || !profileId) return new Map();
    const rows = this.db.all(
      `SELECT * FROM progress WHERE profile_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`,
      profileId,
      ...ids,
    );
    return new Map(rows.map((r) => [r.item_id, r]));
  }

  /** Counted plays and the last time each was played (any play): Map<id, { playCount, lastPlayed }>. */
  statsFor(profileId, ids) {
    if (!profileId || !ids.length) return new Map();
    const rows = this.db.all(
      `SELECT item_id, SUM(counted) AS n, MAX(updated_at) AS last FROM plays WHERE profile_id = ? AND item_id IN (${ids.map(() => '?').join(',')}) GROUP BY item_id`,
      profileId,
      ...ids,
    );
    return new Map(rows.map((r) => [r.item_id, { playCount: r.n || 0, lastPlayed: r.last ?? null }]));
  }

  /** Serialize rows and attach the viewer's progress, play count, last played, stars and favourite. */
  withProgress(rows, viewer, extra = {}) {
    const ids = rows.map((r) => r.id);
    const map = this.progressFor(viewer?.profileId, ids);
    const stats = this.statsFor(viewer?.profileId, ids);
    const rated = ratingsFor(this.db, viewer?.profileId, ids);
    return rows.map((r) => serializeItem(r, { ...extra, progress: map.get(r.id) || null, mine: { ...(stats.get(r.id) || {}), ...(rated.get(r.id) || {}) } }));
  }

  list({ viewer = EVERYONE, libraryId, kind, parentId, showId, sort = 'title', genre, keyword, missingScores = false, releasedOn, unwatched, search, searchPrefix = false, limit = 5000, offset = 0, topLevel = false } = {}) {
    const pid = viewer?.profileId || 0;
    const params = [pid]; // placeholder inside the unwatched_count column
    const where = [];
    const add = (clause, ...values) => {
      where.push(clause);
      params.push(...values);
    };
    let join = '';
    if (unwatched && pid) {
      join = 'LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?';
      params.push(pid);
    }
    const vis = this.visibility(viewer);
    add(vis.sql, ...vis.params);
    if (libraryId) add('i.library_id = ?', Number(libraryId));
    if (kind) {
      const kinds = [].concat(kind);
      add(`i.kind IN (${kinds.map(() => '?').join(',')})`, ...kinds);
    }
    if (parentId) add('i.parent_id = ?', Number(parentId));
    if (topLevel) add("(i.kind NOT IN ('book', 'comic') OR i.show_id IS NULL)"); // v0.22: a series stands for its titles
    if (showId) add('i.show_id = ?', Number(showId));
    if (genre) add('EXISTS (SELECT 1 FROM json_each(i.genres) g WHERE g.value = ?)', String(genre));
    // v0.23: a TMDB keyword (they are stored lower-cased).
    // v0.23: released on this day ('MM-DD') in an earlier year; only full dates count.
    if (typeof releasedOn === 'string' && /^\d{2}-\d{2}$/.test(releasedOn)) add('i.air_date LIKE ? AND length(i.air_date) = 10 AND substr(i.air_date, 1, 4) < ?', `%-${releasedOn}`, String(new Date().getFullYear()));
    if (missingScores) add("(i.scores IS NULL OR i.scores = 'null') AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(i.locked_fields, '[]')) lf WHERE lf.value = 'scores')"); // v0.23
    if (keyword) add('EXISTS (SELECT 1 FROM json_each(i.keywords) k WHERE k.value = ?)', String(keyword).trim().toLowerCase());
    if (search) {
      // v0.24: accents, case, punctuation and a leading "the" ignored (src/library/searchkey.js)
      ensureSearchKeys(this.db);
      const m = searchPrefix ? keyPrefix('i.search_key', search) : keyMatch('i.search_key', search); // prefix: suggestions' first pass
      add(m.sql, ...m.params);
    }
    if (unwatched && pid) {
      add(
        `((i.kind IN ('movie','episode') AND COALESCE(p.watched, 0) = 0) OR
          (i.kind IN ('show','season') AND EXISTS (
            SELECT 1 FROM items e LEFT JOIN progress pe ON pe.item_id = e.id AND pe.profile_id = ?
            WHERE e.kind = 'episode' AND (e.show_id = i.id OR e.parent_id = i.id) AND COALESCE(pe.watched, 0) = 0)))`,
        pid,
      );
    }
    params.push(Number(limit), Number(offset));
    const sql = `SELECT i.* ${this.countColumns()} FROM items i ${join}
      WHERE ${where.join(' AND ')}
      ORDER BY ${SORTS[sort] || SORTS.title} LIMIT ? OFFSET ?`;
    return this.db.all(sql, ...params);
  }

  countColumns() {
    return `,
      CASE WHEN i.kind IN ('show','season') THEN (
        SELECT COUNT(*) FROM items e LEFT JOIN progress pe ON pe.item_id = e.id AND pe.profile_id = ?
        WHERE e.kind = 'episode' AND (e.show_id = i.id OR e.parent_id = i.id) AND COALESCE(pe.watched, 0) = 0
      ) WHEN i.kind IN ('artist','album') THEN NULL END AS unwatched_count,
      CASE WHEN i.kind IN ('show','season') THEN (
        SELECT COUNT(*) FROM items e WHERE e.kind = 'episode' AND (e.show_id = i.id OR e.parent_id = i.id)
      ) WHEN i.kind = 'album' THEN (
        SELECT COUNT(*) FROM items t WHERE t.kind = 'track' AND t.parent_id = i.id
      ) WHEN i.kind = 'artist' THEN (
        SELECT COUNT(*) FROM items al WHERE al.kind = 'album' AND al.parent_id = i.id
      ) END AS child_count`;
  }

  get(id) {
    return this.db.get('SELECT * FROM items WHERE id = ?', Number(id));
  }

  /** Tracks with their album's title and artwork (for lists, search and the queue). */
  tracks({ viewer = EVERYONE, libraryId, albumId, artistId, search, sort = 'track', limit = 500 } = {}) {
    const vis = this.visibility(viewer);
    const where = [`i.kind = 'track'`, vis.sql];
    const params = [...vis.params];
    if (libraryId) where.push('i.library_id = ?') && params.push(Number(libraryId));
    if (albumId) where.push('i.parent_id = ?') && params.push(Number(albumId));
    // An artist's songs follow their albums as the artist page lists them (newest first).
    if (artistId) where.push('i.show_id = ?') && params.push(Number(artistId));
    if (artistId && sort === 'track') sort = 'artist';
    if (search) {
      ensureSearchKeys(this.db); // v0.24: the title's key, or the artist's
      const t = keyMatch('i.search_key', search);
      const a = keyMatch('atomix_key(i.artist)', search);
      where.push(`(${t.sql} OR ${a.sql})`) && params.push(...t.params, ...a.params);
    }
    const order =
      sort === 'random' ? 'RANDOM()'
      : sort === 'added' ? 'i.added_at DESC'
      : sort === 'artist' ? 'al.year DESC, al.sort_title COLLATE NOCASE, al.id, i.season, i.episode, i.sort_title'
      : sort === 'title' ? 'i.sort_title'
      : 'i.season, i.episode, i.sort_title';
    return this.db.all(
      `SELECT i.*, al.title AS album_title, al.poster AS album_poster, al.metadata_at AS album_meta
       FROM items i JOIN items al ON al.id = i.parent_id
       WHERE ${where.join(' AND ')} ORDER BY ${sort === 'title' ? 'i.title COLLATE NOCASE' : order} LIMIT ?`,
      ...params,
      Number(limit),
    );
  }

  /** Items the viewer started but didn't finish, newest first. */
  continueWatching(viewer, limit = 20) {
    const vis = this.visibility(viewer);
    return this.db.all(
      `SELECT i.*, s.title AS show_title, s.backdrop AS show_backdrop, s.poster AS show_poster, s.logo AS show_logo, s.metadata_at AS show_meta
       FROM progress p JOIN items i ON i.id = p.item_id
       LEFT JOIN items s ON s.id = i.show_id
       WHERE p.profile_id = ? AND p.watched = 0 AND p.position > 30 AND i.kind IN ('movie','episode') AND ${vis.sql}
       ORDER BY p.updated_at DESC LIMIT ?`,
      viewer.profileId,
      ...vis.params,
      limit,
    );
  }

  /** Books and podcast episodes the viewer started but didn't finish, newest first (v0.22: Continue listening). */
  continueListening(viewer, limit = 20) {
    const vis = this.visibility(viewer);
    return this.db.all(
      `SELECT i.*, s.title AS show_title FROM progress p JOIN items i ON i.id = p.item_id LEFT JOIN items s ON s.id = i.show_id
       WHERE p.profile_id = ? AND p.watched = 0 AND p.position > 30 AND i.kind IN ('audiobook','podcast_episode') AND ${vis.sql}
       ORDER BY p.updated_at DESC LIMIT ?`,
      viewer.profileId,
      ...vis.params,
      limit,
    );
  }

  /**
   * Books and comics this profile is reading (v0.22), newest first: those open, and — in a series whose last title
   * read was finished — the next one, within the viewer's rules.
   */
  continueReading(viewer, limit = 20) {
    if (!viewer?.profileId) return [];
    const vis = this.visibility(viewer);
    const open = this.db.all(
      `SELECT i.*, p.updated_at AS read_at FROM progress p JOIN items i ON i.id = p.item_id
       WHERE p.profile_id = ? AND p.watched = 0 AND p.position > 0 AND i.kind IN ('book', 'comic') AND ${vis.sql}`,
      viewer.profileId,
      ...vis.params,
    );
    const busy = new Set(open.map((r) => r.show_id).filter(Boolean));
    const finished = this.db.all(
      `SELECT i.show_id, i.issue_sort, p.updated_at AS read_at FROM progress p JOIN items i ON i.id = p.item_id
       WHERE p.profile_id = ? AND i.kind IN ('book', 'comic') AND i.show_id IS NOT NULL AND i.issue_sort IS NOT NULL
         AND p.updated_at = (SELECT MAX(p2.updated_at) FROM progress p2 JOIN items i2 ON i2.id = p2.item_id WHERE p2.profile_id = p.profile_id AND i2.show_id = i.show_id)
         AND p.watched = 1`,
      viewer.profileId,
    );
    const next = [];
    for (const f of finished) {
      if (busy.has(f.show_id)) continue;
      const row = this.db.get(
        `SELECT i.* FROM items i LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?
         WHERE i.show_id = ? AND i.kind IN ('book', 'comic') AND i.issue_sort > ? AND COALESCE(p.watched, 0) = 0 AND ${vis.sql}
         ORDER BY i.issue_sort LIMIT 1`,
        viewer.profileId,
        f.show_id,
        f.issue_sort,
        ...vis.params,
      );
      if (row) next.push({ ...row, read_at: f.read_at });
    }
    return [...open, ...next].sort((a, b) => b.read_at - a.read_at).slice(0, limit);
  }

  // ---- v0.23: helpers for plugin Home rows (each within the viewer's rules) ----

  /**
   * Shows this profile started and left: at least one episode watched and one not, last watched more than
   * `idleDays` ago. `next` is the first unwatched episode (seasons before specials); newest first.
   * @returns {{ show: object, next: object, left: number, lastWatchedAt: number }[]}
   */
  startedShows(viewer, { idleDays = 14, limit = 20 } = {}) {
    if (!viewer?.profileId) return [];
    const vis = this.visibility(viewer, 's');
    const cutoff = Date.now() - Math.max(0, Number(idleDays) || 0) * 86_400_000;
    const shows = this.db.all(
      `SELECT s.*, MAX(p.updated_at) AS last_watched FROM progress p JOIN items e ON e.id = p.item_id JOIN items s ON s.id = e.show_id
       WHERE p.profile_id = ? AND e.kind = 'episode' AND s.kind = 'show' AND ${vis.sql}
       GROUP BY s.id HAVING MAX(p.updated_at) <= ? AND SUM(p.watched) > 0 ORDER BY last_watched DESC`,
      viewer.profileId,
      ...vis.params,
      cutoff,
    );
    const ev = this.visibility(viewer, 'e');
    const out = [];
    for (const show of shows) {
      const left = this.db.all(
        // Regular episodes only: a show whose seasons are all watched isn't "left" because of its specials (v0.23 review).
        // The show's own title and art travel with the episode, as in Continue watching.
        `SELECT e.*, sh.title AS show_title, sh.backdrop AS show_backdrop, sh.poster AS show_poster, sh.logo AS show_logo, sh.metadata_at AS show_meta FROM items e LEFT JOIN progress p ON p.item_id = e.id AND p.profile_id = ?
         LEFT JOIN items sh ON sh.id = e.show_id
         WHERE e.show_id = ? AND e.kind = 'episode' AND e.season > 0 AND COALESCE(p.watched, 0) = 0 AND ${ev.sql}
         ORDER BY e.season, e.episode`,
        viewer.profileId,
        show.id,
        ...ev.params,
      );
      if (!left.length) continue;
      const { last_watched: lastWatchedAt, ...row } = show;
      out.push({ show: row, next: left[0], left: left.length, lastWatchedAt });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Film series (collections, not hidden) with some parts watched and one not, among the parts this viewer may see.
   * @returns {{ collection: { id, name, poster }, next: object, seen: number, total: number }[]}
   */
  partlySeenSeries(viewer, { limit = 20 } = {}) {
    if (!viewer?.profileId) return [];
    const vis = this.visibility(viewer);
    const rows = this.db.all(
      `SELECT c.id AS c_id, c.name AS c_name, c.poster AS c_poster, ci.position AS c_pos, COALESCE(p.watched, 0) AS seen_it, p.updated_at AS seen_at, i.*
       FROM collections c JOIN collection_items ci ON ci.collection_id = c.id JOIN items i ON i.id = ci.item_id
       LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?
       WHERE c.hidden = 0 AND i.kind = 'movie' AND ${vis.sql}
       ORDER BY c.id, ci.position`,
      viewer.profileId,
      ...vis.params,
    );
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.c_id)) by.set(r.c_id, { collection: { id: r.c_id, name: r.c_name, poster: r.c_poster }, parts: [], last: 0 });
      const g = by.get(r.c_id);
      const { c_id, c_name, c_poster, c_pos, seen_it, seen_at, ...item } = r;
      g.parts.push({ item, seen: Boolean(seen_it) });
      if (seen_it) g.last = Math.max(g.last, seen_at || 0);
    }
    const out = [];
    for (const g of by.values()) {
      const seen = g.parts.filter((x) => x.seen).length;
      const next = g.parts.find((x) => !x.seen);
      if (seen && next) out.push({ collection: g.collection, next: next.item, part: g.parts.indexOf(next) + 1, seen, total: g.parts.length, last: g.last });
    }
    return out.sort((a, b) => b.last - a.last).slice(0, limit).map(({ last, ...x }) => x);
  }

  /** What this profile played (counted plays) on one local day ('YYYY-MM-DD' in `tz`), newest first, once each. */
  playedOn(viewer, date, { tz } = {}) {
    if (!viewer?.profileId || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return [];
    const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dayOf = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
    // The plays within a day either side (every zone's day is inside it), then each play's own local day.
    const mid = Date.parse(`${date}T12:00:00Z`);
    const vis = this.visibility(viewer);
    const rows = this.db.all(
      `SELECT i.*, sh.title AS show_title, sh.backdrop AS show_backdrop, sh.poster AS show_poster, sh.logo AS show_logo, sh.metadata_at AS show_meta, pl.started_at AS played_at FROM plays pl JOIN items i ON i.id = pl.item_id
       LEFT JOIN items sh ON sh.id = i.show_id
       WHERE pl.profile_id = ? AND pl.counted = 1 AND pl.started_at BETWEEN ? AND ? AND ${vis.sql}
       ORDER BY pl.started_at DESC`,
      viewer.profileId,
      mid - 2 * 86_400_000,
      mid + 2 * 86_400_000,
      ...vis.params,
    );
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (seen.has(r.id) || dayOf(r.played_at) !== date) continue;
      seen.add(r.id);
      const { played_at, ...item } = r;
      out.push(item);
    }
    return out;
  }

  /** For shows the viewer is watching: the first unwatched episode after the last watched one. */
  /** The next unwatched episode of one show after the last one this profile finished, or null. */
  nextUpFor(viewer, showId) {
    const vis = this.visibility(viewer);
    const show = this.db.get(`SELECT i.id FROM items i WHERE i.id = ? AND i.kind = 'show' AND ${vis.sql}`, Number(showId), ...vis.params);
    if (!show) return null;
    return this.nextEpisodeAfterLast(viewer, show.id);
  }
  /** A show's first episode this viewer may see (specials last), or null: the title page's episode before any is watched. */
  firstEpisodeFor(viewer, showId) {
    const vis = this.visibility(viewer);
    return this.db.get(`SELECT i.* FROM items i WHERE i.show_id = ? AND i.kind = 'episode' AND ${vis.sql} ORDER BY i.season = 0, i.season, i.episode LIMIT 1`, Number(showId), ...vis.params) || null;
  }
  nextEpisodeAfterLast(viewer, show_id) {
    const last = this.db.get(
      `SELECT i.season, i.episode FROM progress p JOIN items i ON i.id = p.item_id
       WHERE p.profile_id = ? AND i.show_id = ? AND i.kind = 'episode' AND p.watched = 1 ORDER BY p.updated_at DESC LIMIT 1`,
      viewer.profileId,
      show_id,
    );
    if (!last) return null;
    // The next episode this viewer may see (an episode can be rated above the show, or be a Kids-blocked recording).
    const vis = this.visibility(viewer);
    return (
      this.db.get(
        `SELECT i.*, s.title AS show_title, s.backdrop AS show_backdrop, s.poster AS show_poster, s.logo AS show_logo, s.metadata_at AS show_meta
         FROM items i JOIN items s ON s.id = i.show_id
         LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?
         WHERE i.show_id = ? AND i.kind = 'episode' AND COALESCE(p.watched, 0) = 0 AND COALESCE(p.position, 0) <= 30
           AND i.season > 0 AND (i.season > ? OR (i.season = ? AND i.episode > ?)) AND ${vis.sql}
         ORDER BY i.season, i.episode LIMIT 1`,
        viewer.profileId,
        show_id,
        last.season,
        last.season,
        last.episode,
        ...vis.params,
      ) || null
    );
  }
  nextUp(viewer, limit = 20) {
    const vis = this.visibility(viewer);
    const shows = this.db.all(
      `SELECT i.show_id, MAX(p.updated_at) AS last FROM progress p JOIN items i ON i.id = p.item_id
       WHERE p.profile_id = ? AND i.kind = 'episode' AND p.watched = 1 AND ${vis.sql}
       GROUP BY i.show_id ORDER BY last DESC LIMIT ?`,
      viewer.profileId,
      ...vis.params,
      limit,
    );
    const out = [];
    for (const { show_id } of shows) {
      const next = this.nextEpisodeAfterLast(viewer, show_id);
      if (next) out.push(next);
    }
    return out;
  }

  recentlyAdded({ viewer = EVERYONE, kind, libraryId, limit = 24 }) {
    const vis = this.visibility(viewer);
    if (kind === 'episode') {
      return this.db.all(
        `SELECT i.*, s.title AS show_title, s.backdrop AS show_backdrop, s.poster AS show_poster, s.logo AS show_logo, s.metadata_at AS show_meta
         FROM items i JOIN items s ON s.id = i.show_id
         WHERE i.kind = 'episode' ${libraryId ? 'AND i.library_id = ?' : ''} AND ${vis.sql}
         ORDER BY i.added_at DESC, i.season DESC, i.episode DESC LIMIT ?`,
        ...(libraryId ? [libraryId] : []),
        ...vis.params,
        limit,
      );
    }
    return this.db.all(
      `SELECT * FROM items i WHERE i.kind = ? ${libraryId ? 'AND i.library_id = ?' : ''} AND ${vis.sql} ORDER BY i.added_at DESC LIMIT ?`,
      kind,
      ...(libraryId ? [libraryId] : []),
      ...vis.params,
      limit,
    );
  }

  /** The episode that follows this one (for autoplay). */
  nextEpisode(item) {
    if (item.kind !== 'episode') return null;
    return this.db.get(
      `SELECT * FROM items WHERE show_id = ? AND kind = 'episode'
       AND (season > ? OR (season = ? AND episode > ?)) ORDER BY season, episode LIMIT 1`,
      item.show_id,
      item.season,
      item.season,
      item.episode,
    );
  }

  genres(libraryId, viewer = EVERYONE) {
    const vis = this.visibility(viewer);
    return this.db
      .all(
        `SELECT g.value AS genre, COUNT(*) AS n FROM items i, json_each(i.genres) g
         WHERE i.library_id = ? AND i.kind IN ('movie','show','album') AND ${vis.sql} GROUP BY g.value ORDER BY g.value`,
        Number(libraryId),
        ...vis.params,
      )
      .map((r) => r.genre);
  }

  setWatched(profileId, item, watched) {
    const now = Date.now();
    const targets =
      item.kind === 'show'
        ? this.db.all(`SELECT id, duration FROM items WHERE show_id = ? AND kind = 'episode'`, item.id)
        : item.kind === 'season'
          ? this.db.all(`SELECT id, duration FROM items WHERE parent_id = ? AND kind = 'episode'`, item.id)
          : [item];
    this.db.transaction(() => {
      for (const t of targets) {
        this.db.run(
          `INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 0, ?, ?, ?)
           ON CONFLICT(profile_id, item_id) DO UPDATE SET watched = excluded.watched, position = 0, updated_at = excluded.updated_at`,
          profileId,
          t.id,
          t.duration || null,
          watched ? 1 : 0,
          now,
        );
      }
    });
    return targets.length;
  }

  saveProgress(profileId, item, position, duration, { locator, device, watched: read } = {}) {
    if (READING_KINDS.has(item.kind)) return this.saveReading(profileId, item, position, duration, { locator, device, read });
    const dur = Number(duration) || item.duration || null;
    const pos = Math.max(0, Number(position) || 0);
    const watched = dur ? pos / dur >= (SPOKEN_KINDS.has(item.kind) ? 0.95 : 0.9) : false; // a spoken title: past 95%
    this.db.run(
      `INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
         watched = CASE WHEN excluded.watched = 1 THEN 1 ELSE progress.watched END, updated_at = excluded.updated_at`,
      profileId,
      item.id,
      watched ? 0 : pos,
      dur,
      watched ? 1 : 0,
      Date.now(),
    );
    // Rewatching a finished item: once they pass the start again, un-mark it.
    if (!watched && pos > 30) this.db.run('UPDATE progress SET watched = 0 WHERE profile_id = ? AND item_id = ?', profileId, item.id);
    return { watched };
  }

  /**
   * A book's or a comic's place (v0.22): percent read (a book) or the page (a comic), where exactly (the locator) and
   * on what kind of device. Read only when the reader says it went past the last page.
   */
  saveReading(profileId, item, position, duration, { locator, device, read }) {
    const pos = Math.max(0, Number(position) || 0);
    const dur = Number(duration) || null;
    const watched = read === true;
    const loc = cleanLocator(locator);
    const dev = DEVICES.has(device) ? device : null;
    this.db.run(
      `INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at, locator, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
         watched = CASE WHEN excluded.watched = 1 THEN 1 WHEN excluded.position > 0 THEN 0 ELSE progress.watched END,
         updated_at = excluded.updated_at, locator = excluded.locator, device = excluded.device`,
      profileId, item.id, watched ? 0 : pos, dur, watched ? 1 : 0, Date.now(), watched ? null : loc, dev,
    );
    return { watched };
  }
}
