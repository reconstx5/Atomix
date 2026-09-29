// Read-side queries shared by the API, the home screen and plugins.
//
// Everything that returns items takes a `viewer` — who is watching:
//   { userId, profileId, kids, maxAge, allowUnrated, libraryIds }
// so library access and Kids-profile age limits are applied in one place.
import { serializeItem } from '../api/serialize.js';

const SORTS = {
  title: 'i.sort_title COLLATE NOCASE ASC, i.year ASC',
  added: 'i.added_at DESC',
  year: 'i.year DESC, i.sort_title COLLATE NOCASE ASC',
  rating: 'i.rating DESC NULLS LAST, i.sort_title COLLATE NOCASE ASC',
  episode: 'i.season ASC, i.episode ASC',
  track: 'i.season ASC, i.episode ASC, i.sort_title COLLATE NOCASE ASC',
  random: 'RANDOM()',
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
      parts.push(`(${a}.kind IN ${UNRATED_KINDS} OR ${age} <= ?${viewer.allowUnrated ? ` OR ${age} IS NULL` : ''})`);
      params.push(viewer.maxAge);
    }
    return { sql: parts.length ? parts.join(' AND ') : '1', params };
  }

  /** Same rules as visibility(), for a single row already loaded. */
  canSee(viewer, row) {
    if (!row) return false;
    if (viewer?.libraryIds && !viewer.libraryIds.includes(row.library_id)) return false;
    if (viewer?.maxAge != null && !['artist', 'album', 'track'].includes(row.kind)) {
      let age = row.min_age;
      if (age == null && row.show_id) age = this.db.get('SELECT min_age FROM items WHERE id = ?', row.show_id)?.min_age;
      if (age == null) return Boolean(viewer.allowUnrated);
      return age <= viewer.maxAge;
    }
    return true;
  }

  visibleLibraries(viewer) {
    const libs = this.db.all('SELECT * FROM libraries ORDER BY name');
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

  /** Serialize rows and attach the viewer's progress. */
  withProgress(rows, viewer, extra = {}) {
    const map = this.progressFor(viewer?.profileId, rows.map((r) => r.id));
    return rows.map((r) => serializeItem(r, { ...extra, progress: map.get(r.id) || null }));
  }

  list({ viewer = EVERYONE, libraryId, kind, parentId, showId, sort = 'title', genre, unwatched, search, limit = 5000, offset = 0 } = {}) {
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
    if (showId) add('i.show_id = ?', Number(showId));
    if (genre) add('EXISTS (SELECT 1 FROM json_each(i.genres) g WHERE g.value = ?)', String(genre));
    if (search) {
      const like = `%${String(search).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      add("(i.title LIKE ? ESCAPE '\\' OR i.original_title LIKE ? ESCAPE '\\')", like, like);
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
      where.push("(i.title LIKE ? ESCAPE '\\' OR i.artist LIKE ? ESCAPE '\\')");
      const like = `%${String(search).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(like, like);
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

  /** For shows the viewer is watching: the first unwatched episode after the last watched one. */
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
      const last = this.db.get(
        `SELECT i.season, i.episode FROM progress p JOIN items i ON i.id = p.item_id
         WHERE p.profile_id = ? AND i.show_id = ? AND p.watched = 1 ORDER BY p.updated_at DESC LIMIT 1`,
        viewer.profileId,
        show_id,
      );
      const next = this.db.get(
        `SELECT i.*, s.title AS show_title, s.backdrop AS show_backdrop, s.poster AS show_poster, s.logo AS show_logo, s.metadata_at AS show_meta
         FROM items i JOIN items s ON s.id = i.show_id
         LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?
         WHERE i.show_id = ? AND i.kind = 'episode' AND COALESCE(p.watched, 0) = 0 AND COALESCE(p.position, 0) <= 30
           AND i.season > 0 AND (i.season > ? OR (i.season = ? AND i.episode > ?))
         ORDER BY i.season, i.episode LIMIT 1`,
        viewer.profileId,
        show_id,
        last.season,
        last.season,
        last.episode,
      );
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

  saveProgress(profileId, item, position, duration) {
    const dur = Number(duration) || item.duration || null;
    const pos = Math.max(0, Number(position) || 0);
    const watched = dur ? pos / dur >= 0.9 : false;
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
}
