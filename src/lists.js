// Playlists and the Watchlist. A list belongs to a profile; a video list holds movies and episodes, a music
// list tracks, the Watchlist movies and shows. Shared lists are visible to the household; kids see a shared
// list only when everything in it passes their age rule. Only the owner edits.
import { HttpError } from './http/router.js';
import { imageUrl } from './api/serialize.js';

const TAKES = { watchlist: ['movie', 'show'], video: ['movie', 'episode'], music: ['track'] };

const PLAYABLE = new Set(['movie', 'episode', 'track']);

export class Lists {
  constructor({ db, library }) {
    this.db = db;
    this.library = library;
    this.listeners = [];
  }
  onChange(fn) {
    this.listeners.push(fn);
  }
  changed(listId) {
    for (const fn of this.listeners) fn(listId);
  }
  get(id) {
    return this.db.get('SELECT * FROM lists WHERE id = ?', Number(id)) || null;
  }
  watchlist(profileId) {
    const row = this.db.get("SELECT * FROM lists WHERE profile_id = ? AND kind = 'watchlist'", profileId);
    if (row) return row;
    const now = Date.now();
    const id = Number(this.db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (?, 'watchlist', 'Watchlist', ?, ?)", profileId, now, now).lastInsertRowid);
    return this.get(id);
  }
  create(profileId, { kind, name }) {
    if (!['video', 'music'].includes(kind)) throw new HttpError(400, 'A playlist is for videos or for songs.');
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new HttpError(400, 'Give the playlist a name.');
    const now = Date.now();
    const id = Number(this.db.run('INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', profileId, kind, clean, now, now).lastInsertRowid);
    this.changed(id);
    return this.get(id);
  }
  notWatchlist(list, what) {
    if (!list) throw new HttpError(404, 'No such list');
    if (list.kind === 'watchlist') throw new HttpError(400, `The Watchlist can't be ${what}.`);
    return list;
  }
  rename(id, name) {
    const list = this.notWatchlist(this.get(id), 'renamed');
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new HttpError(400, 'Give the playlist a name.');
    this.db.run('UPDATE lists SET name = ?, updated_at = ? WHERE id = ?', clean, Date.now(), list.id);
    this.changed(list.id);
    return this.get(list.id);
  }
  setShared(id, shared) {
    const list = this.notWatchlist(this.get(id), 'shared');
    this.db.run('UPDATE lists SET shared = ?, updated_at = ? WHERE id = ?', shared ? 1 : 0, Date.now(), list.id);
    this.changed(list.id);
    return this.get(list.id);
  }
  remove(id) {
    const list = this.notWatchlist(this.get(id), 'deleted');
    this.db.run('DELETE FROM lists WHERE id = ?', list.id);
    this.changed(list.id);
  }
  /** Append an item if its kind fits the list and it isn't there yet. Returns whether it was added. */
  add(listId, itemId) {
    const list = this.get(listId);
    const item = this.library.get(Number(itemId));
    if (!list || !item || !TAKES[list.kind].includes(item.kind)) return false;
    if (this.db.get('SELECT 1 FROM list_items WHERE list_id = ? AND item_id = ?', list.id, item.id)) return false;
    const pos = this.db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM list_items WHERE list_id = ?', list.id).p;
    const now = Date.now();
    this.db.run('INSERT INTO list_items (list_id, item_id, position, added_at) VALUES (?, ?, ?, ?)', list.id, item.id, pos, now);
    this.db.run('UPDATE lists SET updated_at = ? WHERE id = ?', now, list.id);
    this.changed(list.id);
    return true;
  }
  /** A season's episodes, in order. Returns how many were added. */
  addSeason(listId, seasonId) {
    const eps = this.db.all("SELECT id FROM items WHERE parent_id = ? AND kind = 'episode' ORDER BY episode, id", Number(seasonId));
    let n = 0;
    for (const e of eps) if (this.add(listId, e.id)) n++;
    return n;
  }
  removeItem(listId, itemId) {
    this.db.run('DELETE FROM list_items WHERE list_id = ? AND item_id = ?', Number(listId), Number(itemId));
    this.renumber(Number(listId));
    this.changed(Number(listId));
  }
  renumber(listId) {
    const rows = this.db.all('SELECT item_id FROM list_items WHERE list_id = ? ORDER BY position, item_id', listId);
    this.db.transaction(() => rows.forEach((r, i) => this.db.run('UPDATE list_items SET position = ? WHERE list_id = ? AND item_id = ?', i, listId, r.item_id)));
  }
  move(listId, itemId, position) {
    const rows = this.db.all('SELECT item_id FROM list_items WHERE list_id = ? ORDER BY position, item_id', Number(listId)).map((r) => r.item_id);
    const from = rows.indexOf(Number(itemId));
    if (from < 0) throw new HttpError(404, 'Not in this list');
    rows.splice(from, 1);
    rows.splice(Math.max(0, Math.min(rows.length, Number(position))), 0, Number(itemId));
    this.db.transaction(() => rows.forEach((id, i) => this.db.run('UPDATE list_items SET position = ? WHERE list_id = ? AND item_id = ?', i, Number(listId), id)));
    this.db.run('UPDATE lists SET updated_at = ? WHERE id = ?', Date.now(), Number(listId));
    this.changed(Number(listId));
  }
  rows(listId) {
    return this.db.all('SELECT i.*, li.position, li.added_at AS list_added_at FROM list_items li JOIN items i ON i.id = li.item_id WHERE li.list_id = ? ORDER BY li.position, li.item_id', Number(listId));
  }
  /** The list's items the viewer may see, serialized with progress, in order. */
  items(listId, viewer) {
    const rows = this.rows(listId).filter((r) => this.library.canSee(viewer, r));
    return this.library.withProgress(rows, viewer).map((s, i) => ({ ...s, listAddedAt: rows[i].list_added_at }));
  }
  /** Kids see a shared list only when all of it passes their age rule; everyone else sees any shared list. */
  visibleTo(list, viewer) {
    if (!list) return false;
    if (list.profile_id === viewer.profileId) return true;
    if (!list.shared) return false;
    if (viewer.maxAge == null) return true;
    return this.rows(list.id).every((r) => this.library.canSee(viewer, r));
  }
  /** Own lists (Watchlist first), then shared ones from other profiles, with counts and a few posters. */
  forProfile(profile, viewer) {
    const own = this.db.all("SELECT * FROM lists WHERE profile_id = ? ORDER BY CASE kind WHEN 'watchlist' THEN 0 ELSE 1 END, created_at, id", profile.id);
    if (!own.some((l) => l.kind === 'watchlist')) own.unshift(this.watchlist(profile.id));
    const shared = this.db
      .all('SELECT l.*, p.name AS owner_name FROM lists l JOIN profiles p ON p.id = l.profile_id WHERE l.shared = 1 AND l.profile_id != ? ORDER BY l.updated_at DESC', profile.id)
      .filter((l) => this.visibleTo(l, viewer));
    const summarise = (l, ownFlag) => {
      const rows = this.rows(l.id).filter((r) => this.library.canSee(viewer, r));
      const posterOf = (r) => (r.kind === 'track' && r.parent_id ? imageUrl(this.library.get(r.parent_id) || r, 'poster') : imageUrl(r, 'poster'));
      return {
        id: l.id,
        kind: l.kind,
        name: l.name,
        shared: Boolean(l.shared),
        own: ownFlag,
        ownerName: ownFlag ? profile.name : l.owner_name,
        count: rows.length,
        posters: rows.slice(0, 4).map(posterOf).filter(Boolean),
        updatedAt: l.updated_at,
      };
    };
    return [...own.map((l) => summarise(l, true)), ...shared.map((l) => summarise(l, false))];
  }
  contains(profileId, itemId) {
    const rows = this.db.all('SELECT l.id, l.kind FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.item_id = ? AND l.profile_id = ?', Number(itemId), profileId);
    return { watchlist: rows.some((r) => r.kind === 'watchlist'), lists: rows.filter((r) => r.kind !== 'watchlist').map((r) => r.id) };
  }
  /**
   * The next playable item after `afterItemId`: films, episodes and songs the viewer may see (a show in the Watchlist
   * is skipped). Null when there is none, or when `afterItemId` is no longer in the list (it never restarts).
   */
  nextIn(listId, afterItemId, viewer) {
    const rows = this.rows(listId);
    const at = rows.findIndex((r) => r.id === Number(afterItemId));
    if (at < 0) return null;
    return rows.slice(at + 1).find((r) => PLAYABLE.has(r.kind) && this.library.canSee(viewer, r)) || null;
  }
  /** Where Play on a list starts: the first playable item the viewer may see, or null. */
  firstPlayable(listId, viewer) {
    return this.rows(listId).find((r) => PLAYABLE.has(r.kind) && this.library.canSee(viewer, r)) || null;
  }
}
