// What the background jobs have done: seek-bar preview layouts, which episodes
// have been checked for intros, and the intro/credits markers themselves.
import { parseJson } from '../db.js';

// Who wins when sources disagree: an admin, then the file's chapters, then audio matching.
const RANK = { audio: 1, chapter: 2, manual: 3 };
// A job is needed when it never ran for this file, or the file changed since.
const STALE = '(j.item_id IS NULL OR j.source_size IS NOT i.size OR j.source_mtime IS NOT i.mtime)';
const PREVIEWABLE = `i.kind IN ('movie', 'episode') AND i.path IS NOT NULL AND i.duration > 0
  AND json_extract(i.media, '$.video') IS NOT NULL
  AND COALESCE(json_extract(l.options, '$.previews'), 1) != 0`;
const CHECKABLE = "i.kind = 'episode' AND i.path IS NOT NULL AND i.duration > 0";
const ONLY = 'AND i.id IN (SELECT value FROM json_each(?))';

const pad = (n) => String(n ?? 0).padStart(2, '0');
function label({ kind, title, season, episode }, showTitle) {
  return kind === 'episode' && showTitle ? `${showTitle} S${pad(season)}E${pad(episode)}` : title;
}

/** Run a write; false if the item has been deleted in the meantime. */
function unlessGone(fn) {
  try {
    fn();
    return true;
  } catch (err) {
    if (/FOREIGN KEY/i.test(err.message)) return false;
    throw err;
  }
}

export class ExtrasStore {
  constructor(db) {
    this.db = db;
  }

  job(itemId, job) {
    const row = this.db.get('SELECT * FROM media_jobs WHERE item_id = ? AND job = ?', itemId, job);
    return row ? { ...row, data: parseJson(row.data, null) } : null;
  }

  /** Record what a job did for the file `item` describes (its size/mtime at the time). */
  saveJob(item, job, { status, data = null, error = null }) {
    return unlessGone(() =>
      this.db.run(
        `INSERT INTO media_jobs (item_id, job, status, data, error, source_size, source_mtime, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, job) DO UPDATE SET status = excluded.status, data = excluded.data, error = excluded.error,
           source_size = excluded.source_size, source_mtime = excluded.source_mtime, updated_at = excluded.updated_at`,
        item.id,
        job,
        status,
        data == null ? null : JSON.stringify(data),
        error ? String(error).slice(0, 500) : null,
        item.size ?? null,
        item.mtime ?? null,
        Date.now(),
      ),
    );
  }

  // ---- Work still to do ----
  /** Oldest movie/episode still needing previews (only among `onlyIds` if given). */
  nextPreviewItem(onlyIds = null) {
    return (
      this.db.get(
        `SELECT i.* FROM items i JOIN libraries l ON l.id = i.library_id
         LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'previews'
         WHERE ${PREVIEWABLE} AND ${STALE} ${onlyIds ? ONLY : ''}
         ORDER BY i.id LIMIT 1`,
        ...(onlyIds ? [JSON.stringify(onlyIds)] : []),
      ) || null
    );
  }

  /** The season of the oldest episode still needing an intro check. */
  nextIntroSeason(onlyIds = null) {
    const row = this.db.get(
      `SELECT i.parent_id AS season_id FROM items i
       LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'intros'
       WHERE ${CHECKABLE} AND ${STALE} ${onlyIds ? ONLY : ''}
       ORDER BY i.id LIMIT 1`,
      ...(onlyIds ? [JSON.stringify(onlyIds)] : []),
    );
    return row ? row.season_id : null;
  }

  pendingIntroEpisodes(seasonId) {
    return this.db.all(
      `SELECT i.* FROM items i LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'intros'
       WHERE i.parent_id = ? AND ${CHECKABLE} AND ${STALE} ORDER BY i.episode, i.id`,
      seasonId,
    );
  }

  seasonEpisodes(seasonId) {
    return this.db.all(`SELECT i.* FROM items i WHERE i.parent_id = ? AND ${CHECKABLE} ORDER BY i.episode, i.id`, seasonId);
  }

  /** An episode from the same show's nearest other season (for one-episode seasons). */
  otherSeasonEpisode(seasonId) {
    const season = this.db.get('SELECT COALESCE(show_id, parent_id) AS show_id, season FROM items WHERE id = ?', seasonId);
    if (!season) return null;
    return (
      this.db.get(
        `SELECT i.* FROM items i WHERE i.show_id = ? AND i.parent_id != ? AND ${CHECKABLE}
         ORDER BY ABS(COALESCE(i.season, 0) - ?), i.season, i.episode LIMIT 1`,
        season.show_id,
        seasonId,
        season.season ?? 0,
      ) || null
    );
  }

  /** A new episode arrived: episodes where nothing was found get another go. */
  resetSeasonNone(seasonId) {
    this.db.run("DELETE FROM media_jobs WHERE job = 'intros' AND status = 'none' AND item_id IN (SELECT id FROM items WHERE parent_id = ?)", seasonId);
  }

  clearIntroJobs(seasonId) {
    this.db.run("DELETE FROM media_jobs WHERE job = 'intros' AND item_id IN (SELECT id FROM items WHERE parent_id = ?)", seasonId);
  }

  retryFailed() {
    return Number(this.db.run("DELETE FROM media_jobs WHERE status = 'failed'").changes);
  }

  failed(limit = 20) {
    return this.db
      .all(
        `SELECT j.item_id, j.job, j.error, i.kind, i.title, i.season, i.episode, s.title AS show_title
         FROM media_jobs j JOIN items i ON i.id = j.item_id LEFT JOIN items s ON s.id = i.show_id
         WHERE j.status = 'failed' ORDER BY j.updated_at DESC LIMIT ?`,
        limit,
      )
      .map((r) => ({ itemId: r.item_id, job: r.job, error: r.error, title: label(r, r.show_title) }));
  }

  pendingCounts() {
    const previews = this.db.get(
      `SELECT COUNT(*) AS n FROM items i JOIN libraries l ON l.id = i.library_id
       LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'previews' WHERE ${PREVIEWABLE} AND ${STALE}`,
    ).n;
    const intros = this.db.get(
      `SELECT COUNT(DISTINCT i.parent_id) AS n FROM items i
       LEFT JOIN media_jobs j ON j.item_id = i.id AND j.job = 'intros' WHERE ${CHECKABLE} AND ${STALE}`,
    ).n;
    return { previews, intros };
  }

  // ---- Previews ----
  previewIds() {
    return new Set(this.db.all("SELECT item_id FROM media_jobs WHERE job = 'previews' AND status = 'done'").map((r) => r.item_id));
  }

  /** The layout the player needs, or null (none yet, or made from a file that has since changed). */
  previewManifest(item) {
    const j = this.db.get("SELECT * FROM media_jobs WHERE item_id = ? AND job = 'previews' AND status = 'done'", item.id);
    if (!j || j.source_size !== (item.size ?? null) || j.source_mtime !== (item.mtime ?? null)) return null;
    const data = parseJson(j.data, null);
    if (!data?.sheets) return null;
    return { ...data, url: `/api/items/${item.id}/previews/{n}?v=${j.updated_at}` };
  }

  // ---- Markers ----
  markers(itemId) {
    const out = { intro: null, credits: null };
    for (const r of this.db.all('SELECT * FROM markers WHERE item_id = ?', itemId)) {
      out[r.kind] = r.start_time == null ? { none: true, source: r.source } : { start: r.start_time, end: r.end_time, source: r.source };
    }
    return out;
  }

  playbackMarkers(itemId) {
    const m = this.markers(itemId);
    const plain = (x) => (x && !x.none ? { start: x.start, end: x.end } : null);
    return { intro: plain(m.intro), credits: plain(m.credits) };
  }

  /** Save a marker unless a more trusted one is already there. Returns true if saved. */
  setMarker(itemId, kind, { start = null, end = null, source }) {
    const existing = this.db.get('SELECT source FROM markers WHERE item_id = ? AND kind = ?', itemId, kind);
    if (existing && RANK[existing.source] > RANK[source]) return false;
    const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
    return unlessGone(() =>
      this.db.run(
        `INSERT INTO markers (item_id, kind, start_time, end_time, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, kind) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time,
           source = excluded.source, updated_at = excluded.updated_at`,
        itemId,
        kind,
        round(start),
        round(end),
        source,
        Date.now(),
      ),
    );
  }

  deleteMarker(itemId, kind, { sources = null } = {}) {
    if (sources) this.db.run('DELETE FROM markers WHERE item_id = ? AND kind = ? AND source IN (SELECT value FROM json_each(?))', itemId, kind, JSON.stringify(sources));
    else this.db.run('DELETE FROM markers WHERE item_id = ? AND kind = ?', itemId, kind);
  }

  // ---- Labels for the dashboard ----
  itemLabel(item) {
    const show = item.kind === 'episode' && item.show_id ? this.db.get('SELECT title FROM items WHERE id = ?', item.show_id) : null;
    return label(item, show?.title);
  }

  seasonLabel(seasonId) {
    const r = this.db.get('SELECT se.season, s.title AS show_title FROM items se LEFT JOIN items s ON s.id = COALESCE(se.show_id, se.parent_id) WHERE se.id = ?', seasonId);
    return r ? `${r.show_title} season ${r.season ?? 0}` : `Season ${seasonId}`;
  }
}
