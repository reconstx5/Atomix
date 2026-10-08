// Collections: film series TMDB knows about (one row per tmdb_id, members placed by release order) and
// hand-made ones an admin builds from films and shows. A collection shows only the members the viewer
// may see; with none, it isn't there for that viewer.
import { HttpError } from './http/router.js';
import { parseJson } from './db.js';

export class Collections {
  constructor({ db, library }) {
    this.db = db;
    this.library = library;
  }
  row(id) {
    return this.db.get('SELECT * FROM collections WHERE id = ?', Number(id)) || null;
  }
  /** From TMDB, on a movie's refresh. Never overwrites a name (renames stick); parts and artwork follow TMDB. */
  upsertTmdb(series, item) {
    if (!series?.tmdbId || !item) return null;
    const now = Date.now();
    let c = this.db.get('SELECT * FROM collections WHERE tmdb_id = ?', series.tmdbId);
    if (!c) {
      const id = Number(
        this.db.run(
          'INSERT INTO collections (tmdb_id, name, overview, poster, backdrop, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          series.tmdbId,
          series.name || 'Collection',
          series.overview || null,
          series.poster || null,
          series.backdrop || null,
          JSON.stringify(series.parts || []),
          now,
          now,
        ).lastInsertRowid,
      );
      c = this.row(id);
    } else {
      // A new sequel on TMDB, or new artwork there, reaches the collection; our overview stays when we have one.
      // An empty list is a failed /collection call, not a series with no films: the stored list stays.
      const parts = series.parts?.length ? JSON.stringify(series.parts) : c.parts;
      const poster = series.poster || c.poster;
      const backdrop = series.backdrop || c.backdrop;
      if (parts !== c.parts || poster !== c.poster || backdrop !== c.backdrop || (!c.overview && series.overview)) {
        this.db.run('UPDATE collections SET overview = COALESCE(overview, ?), poster = ?, backdrop = ?, parts = ?, updated_at = ? WHERE id = ?', series.overview || null, poster, backdrop, parts, now, c.id);
      }
      c = this.row(c.id);
    }
    const parts = parseJson(c.parts, []);
    const position = Math.max(0, parts.findIndex((p) => p.tmdbId === item.tmdb_id));
    // A film belongs to one TMDB series; a hand-made collection may also hold it.
    this.db.run('DELETE FROM collection_items WHERE item_id = ? AND collection_id IN (SELECT id FROM collections WHERE tmdb_id IS NOT NULL AND id != ?)', item.id, c.id);
    this.db.run('INSERT OR REPLACE INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)', c.id, item.id, position);
    return this.row(c.id);
  }
  detach(itemId) {
    this.db.run('DELETE FROM collection_items WHERE item_id = ? AND collection_id IN (SELECT id FROM collections WHERE tmdb_id IS NOT NULL)', Number(itemId));
  }
  create({ name, overview = null, itemIds = [] }) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new HttpError(400, 'Give the collection a name.');
    const now = Date.now();
    const id = Number(this.db.run('INSERT INTO collections (name, overview, manual, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', clean, overview || null, now, now).lastInsertRowid);
    this.setItems(id, itemIds);
    return this.summary(this.row(id));
  }
  setItems(id, itemIds) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM collection_items WHERE collection_id = ?', id);
      let pos = 0;
      for (const itemId of itemIds || []) {
        const it = this.library.get(Number(itemId));
        if (!it || !['movie', 'show'].includes(it.kind)) continue;
        this.db.run('INSERT OR IGNORE INTO collection_items (collection_id, item_id, position) VALUES (?, ?, ?)', id, it.id, pos++);
      }
    });
  }
  update(id, { name, overview, hidden, itemIds, artworkFrom } = {}) {
    const c = this.row(id);
    if (!c) throw new HttpError(404, 'No such collection');
    const sets = [];
    const params = [];
    if (name !== undefined) {
      const clean = String(name).trim().slice(0, 80);
      if (!clean) throw new HttpError(400, 'Give the collection a name.');
      sets.push('name = ?');
      params.push(clean);
    }
    if (overview !== undefined) {
      sets.push('overview = ?');
      params.push(overview || null);
    }
    if (hidden !== undefined) {
      sets.push('hidden = ?');
      params.push(hidden ? 1 : 0);
    }
    if (artworkFrom !== undefined) {
      const it = this.library.get(Number(artworkFrom));
      if (!it) throw new HttpError(404, 'No such title');
      sets.push('poster = ?', 'backdrop = ?');
      params.push(it.poster || null, it.backdrop || null);
    }
    if (itemIds !== undefined) {
      if (!c.manual) throw new HttpError(400, "A TMDB collection's films come from TMDB.");
      this.setItems(c.id, itemIds);
    }
    if (sets.length) this.db.run(`UPDATE collections SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, Date.now(), c.id);
    return this.summary(this.row(c.id));
  }
  remove(id) {
    const c = this.row(id);
    if (!c) throw new HttpError(404, 'No such collection');
    if (!c.manual) throw new HttpError(400, 'A TMDB collection can be hidden, not deleted.');
    this.db.run('DELETE FROM collections WHERE id = ?', c.id);
  }
  members(id) {
    return this.db.all('SELECT i.*, ci.position FROM collection_items ci JOIN items i ON i.id = ci.item_id WHERE ci.collection_id = ? ORDER BY ci.position, i.year, i.id', Number(id));
  }
  summary(c, extra = {}) {
    return {
      id: c.id,
      tmdbId: c.tmdb_id,
      name: c.name,
      overview: c.overview,
      manual: Boolean(c.manual),
      hidden: Boolean(c.hidden),
      poster: c.poster ? `/api/collections/${c.id}/image/poster?v=${c.updated_at}` : null,
      backdrop: c.backdrop ? `/api/collections/${c.id}/image/backdrop?v=${c.updated_at}` : null,
      ...extra,
    };
  }
  /**
   * Full shape for a viewer, or null when they can see none of it. `everything` (admin screens) skips the viewer
   * filter so an empty or out-of-reach collection can still be managed. "Missing" is what nobody owns: a film the
   * viewer may not see is neither listed nor counted as missing, so a kid never learns its name.
   */
  get(id, viewer, { everything = false } = {}) {
    const c = this.row(id);
    if (!c) return null;
    const all = this.members(c.id);
    const rows = everything ? all : all.filter((r) => this.library.canSee(viewer, r));
    if (!rows.length && !everything) return null;
    const parts = parseJson(c.parts, []);
    const ownedTmdb = new Set(all.map((r) => r.tmdb_id));
    const missing = parts.filter((p) => !ownedTmdb.has(p.tmdbId)).map((p) => ({ title: p.title, year: p.year }));
    const items = this.library.withProgress(rows, viewer);
    const s = this.summary(c, { owned: rows.length, total: c.manual ? rows.length : Math.max(parts.length, rows.length), items, missing, libraryIds: [...new Set(rows.map((r) => r.library_id))] });
    if (!s.poster) s.poster = items[0]?.poster || null;
    if (!s.backdrop) s.backdrop = items[0]?.backdrop || null;
    return s;
  }
  forItem(itemId, viewer) {
    const link = this.db.get('SELECT collection_id FROM collection_items WHERE item_id = ? ORDER BY collection_id LIMIT 1', Number(itemId));
    return link ? this.get(link.collection_id, viewer) : null;
  }
  list(viewer, { includeHidden = false, everything = false } = {}) {
    const rows = this.db.all(`SELECT * FROM collections ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY name COLLATE NOCASE`);
    return rows
      .map((c) => this.get(c.id, viewer, { everything }))
      .filter(Boolean)
      .map(({ items, missing, ...rest }) => ({ ...rest, firstPoster: items[0]?.poster || null }));
  }
}
