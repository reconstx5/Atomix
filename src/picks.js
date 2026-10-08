// "Because you watched" and "More like this": scored from the library itself, nothing leaves the server.
// Same collection 5 · each shared keyword 3 · shared director/creator 3 · each shared cast member 2 ·
// each shared genre 1 · same decade 1. Keep ≥ 3, top 20 by score then rating, unwatched first.
import { EVERYONE } from './library/queries.js';
import { parseJson } from './db.js';

export class Picks {
  constructor({ db, library, collections, ttlMs = 10 * 60 * 1000 }) {
    this.db = db;
    this.library = library;
    this.collections = collections;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // `${viewer rules}:${key}` → { at, value }; the ranked ids, never progress
  }
  clear() {
    this.cache.clear();
  }
  /** The cache is keyed on what the viewer may see, so a changed age limit or library access misses it at once. */
  cached(viewer, key, make) {
    const k = `${viewer.profileId}:${viewer.kids ? 1 : 0}:${viewer.maxAge ?? ''}:${viewer.allowUnrated ? 1 : 0}:${(viewer.libraryIds || []).join('.')}:${key}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    if (this.cache.size > 5000) this.cache.clear();
    const value = make();
    this.cache.set(k, { at: Date.now(), value });
    return value;
  }
  /** item id → collection id, for every item in a collection, in one query. */
  collectionMap() {
    return new Map(this.db.all('SELECT item_id, MIN(collection_id) AS collection_id FROM collection_items GROUP BY item_id').map((r) => [r.item_id, r.collection_id]));
  }
  profile(row, collectionOf) {
    const people = parseJson(row.people, []);
    return {
      id: row.id,
      genres: new Set(parseJson(row.genres, [])),
      keywords: new Set(parseJson(row.keywords, [])),
      leads: new Set(people.filter((p) => p.role === 'director' || p.role === 'creator').map((p) => p.name)),
      cast: new Set(people.filter((p) => p.role === 'cast').map((p) => p.name)),
      decade: row.year ? Math.floor(row.year / 10) : null,
      collection: collectionOf.get(row.id) ?? null,
    };
  }
  score(a, b) {
    let s = 0;
    if (a.collection != null && a.collection === b.collection) s += 5;
    for (const k of b.keywords) if (a.keywords.has(k)) s += 3;
    for (const p of b.leads) if (a.leads.has(p)) s += 3;
    for (const p of b.cast) if (a.cast.has(p)) s += 2;
    for (const g of b.genres) if (a.genres.has(g)) s += 1;
    if (a.decade != null && a.decade === b.decade) s += 1;
    return s;
  }
  candidates(viewer) {
    const vis = this.library.visibility(viewer);
    return this.db.all(`SELECT i.* FROM items i WHERE i.kind IN ('movie', 'show') AND ${vis.sql}`, ...vis.params);
  }
  /** Titles like this one, for its page. */
  similar(itemId, viewer = EVERYONE, { limit = 20 } = {}) {
    const ranked = this.cached(viewer, `similar:${itemId}`, () => {
      const seed = this.library.get(Number(itemId));
      if (!seed) return [];
      const collectionOf = this.collectionMap();
      const a = this.profile(seed, collectionOf);
      const rows = this.candidates(viewer).filter((r) => r.id !== seed.id);
      const seen = new Set(viewer.profileId ? this.db.all('SELECT item_id FROM progress WHERE profile_id = ?', viewer.profileId).map((r) => r.item_id) : []);
      const scored = rows.map((r) => ({ id: r.id, score: this.score(a, this.profile(r, collectionOf)), seen: seen.has(r.id), rating: r.rating || 0 })).filter((x) => x.score >= 3);
      scored.sort((x, y) => Number(x.seen) - Number(y.seen) || y.score - x.score || y.rating - x.rating || x.id - y.id);
      return scored.slice(0, limit).map((x) => ({ id: x.id, score: x.score }));
    });
    // Progress is attached fresh on every read, so what you just watched shows as watched right away.
    if (!ranked.length) return [];
    const byId = new Map(this.db.all(`SELECT * FROM items WHERE id IN (${ranked.map(() => '?').join(',')})`, ...ranked.map((x) => x.id)).map((r) => [r.id, r]));
    const kept = ranked.filter((x) => byId.has(x.id));
    return this.library.withProgress(kept.map((x) => byId.get(x.id)), viewer).map((s, i) => ({ ...s, score: kept[i].score }));
  }
  /** Up to two seeds: the most recently watched or in-progress titles (an episode counts as its show, once). */
  becauseYouWatched(viewer, { seeds = 2 } = {}) {
    if (!viewer.profileId) return [];
    const seedIds = this.cached(viewer, 'byw', () => {
      const recent = this.db.all('SELECT i.*, p.updated_at AS seen_at FROM progress p JOIN items i ON i.id = p.item_id WHERE p.profile_id = ? ORDER BY p.updated_at DESC LIMIT 40', viewer.profileId);
      const out = [];
      const used = new Set();
      for (const r of recent) {
        const seedRow = r.kind === 'episode' && r.show_id ? this.library.get(r.show_id) : r;
        if (!seedRow || !['movie', 'show'].includes(seedRow.kind) || used.has(seedRow.id) || !this.library.canSee(viewer, seedRow)) continue;
        used.add(seedRow.id);
        if (this.similar(seedRow.id, viewer).length) out.push(seedRow.id);
        if (out.length >= seeds) break;
      }
      return out;
    });
    return seedIds
      .map((id) => this.library.get(id))
      .filter(Boolean)
      .map((seedRow) => ({ seed: this.library.withProgress([seedRow], viewer)[0], items: this.similar(seedRow.id, viewer) }));
  }
}
