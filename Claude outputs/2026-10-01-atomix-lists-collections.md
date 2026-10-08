# Collections, playlists, Watchlist and picks (v0.9.0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Film series from TMDB and hand-made collections, per-profile video and song playlists (shareable), a Watchlist, and "Because you watched…" picks, on the server and in every theme.

**Architecture:** Three new server stores (`src/lists.js`, `src/collections.js`, `src/picks.js`) over four new tables (migration 9) plus two JSON columns on `items`; the TMDB provider fetches keywords, credits and the film series; one new route file `src/api/lists.js`; on the client a helper module `public/js/lists.js` (Watchlist toggle, add-to-playlist sheet), a new view `public/js/views/lists.js` (Lists page, list page, collection page), and small hooks into the item page, Home, the library, the player, the music menus and Settings.

**Tech Stack:** Node ≥ 22.13, `node:sqlite`, `node:test`; plain ES modules in the browser; Playwright (cloud only) for browser checks; the dev server on :8787 (`/home/claude/devtools/restart-dev.sh`).

**Spec:** `docs/superpowers/specs/2026-10-01-atomix-lists-collections-design.md`

## Global Constraints

- Zero npm dependencies; no build step; Node ≥ 22.13.
- Every store method takes the viewer where visibility matters and uses `library.visibility()` / `library.canSee()`; nothing a kids profile can't see leaks through a list, a collection or a pick.
- Copy, verbatim: "Watchlist", "Add to playlist…", "New playlist…", "Because you watched", "More like this", "Part of", "Play all", "Shuffle", "Share with everyone", "Keep to me"; toasts "Added to your Watchlist", "Removed from your Watchlist", "Added to <name>".
- A Watchlist is one per profile (partial unique index), can't be renamed, shared or deleted.
- Only the owning profile edits a list (403 otherwise). Kids profiles can't share.
- Picks scoring: same collection +5, each shared keyword +3, shared director/creator +3, each shared cast member +2, each shared genre +1, same decade +1; keep ≥ 3; top 20 by score then rating; unwatched first; cached 10 minutes per profile, cleared on scan complete and list change.
- The six older themes stay pixel-identical except for the new rows and pages (`oldthemes-compare.mjs` is re-baselined only where the spec adds content).
- No git in the cloud copy; "Commit" steps mean a ledger line. Never `pkill -f`.

## Review Focus

1. A film in a TMDB collection whose other parts aren't in the library: the "Part of" row must show the owned film alone with "1 of N in your library", never an empty row or a crash on `parts` being missing — Task 4's test covers a collection with one owned part.
2. Deleting an item from the library (rescan after the file is gone) that is in a playlist or collection: `ON DELETE CASCADE` must remove the membership and the list's count must drop — Task 2's test deletes an item and re-reads the list.
3. A kids profile opening a shared playlist by URL that contains a non-kid-safe item: 404, not a filtered view — Task 6's API test.
4. A video playlist whose next item is one the viewer can't play (deleted or hidden mid-list): `/api/playback/next` must skip to the following one — Task 6's test.
5. Renaming a TMDB collection then a later refresh of one of its films: the rename must survive (upsert never overwrites `name` when the row already exists) — Task 3's test.

---

### Task 1: Migration 9

**Files:**
- Modify: `src/db.js` (append to `MIGRATIONS` after the `// 8:` entry)
- Test: `test/migrations.test.js` (new)

**Interfaces:**
- Produces: tables `collections`, `collection_items`, `lists`, `list_items`; columns `items.keywords`, `items.people` (JSON text, default `'[]'`).

- [ ] **Step 1: Write the failing test**

```js
// Migration 9: the tables and columns for collections, playlists and the Watchlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase, MIGRATIONS } from '../src/db.js';

test('migration 9 adds lists, collections and the keyword/people columns', () => {
  const db = openDatabase(path.join(tempDir(), 'm.db'));
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ['collections', 'collection_items', 'lists', 'list_items']) assert.ok(tables.includes(t), t);
  const cols = db.all('PRAGMA table_info(items)').map((c) => c.name);
  assert.ok(cols.includes('keywords') && cols.includes('people'));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'lists_watchlist'").n, 1);
  assert.ok(MIGRATIONS.length >= 9);
});

test('a profile has at most one Watchlist', () => {
  const db = openDatabase(path.join(tempDir(), 'w.db'));
  const now = Date.now();
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, ?)", now);
  db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'watchlist', 'Watchlist', ?, ?)", now, now);
  assert.throws(() => db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'watchlist', 'Watchlist', ?, ?)", now, now), /UNIQUE/);
  db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'video', 'Friday', ?, ?)", now, now); // other kinds are unlimited
});
```

Check `openDatabase` and `MIGRATIONS` are exported from `src/db.js` (`grep -n "^export" src/db.js`); if `MIGRATIONS` isn't, export it. Check the `profiles` insert columns against `CREATE TABLE profiles` in `src/db.js` and adjust.

- [ ] **Step 2: Run it**

Run: `cd /home/claude/nodeflix && node --test test/migrations.test.js 2>&1 | grep -E "^# (pass|fail)|not ok|Error"`
Expected: 2 failing (no such table / column).

- [ ] **Step 3: Add the migration** — append after the `// 8:` entry in `MIGRATIONS`:

```js
  // 9: collections (TMDB film series and hand-made), playlists and the Watchlist (lists), and the
  //    keywords/people TMDB gives us, which the picks are scored on.
  `
  ALTER TABLE items ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE items ADD COLUMN people TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    tmdb_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    overview TEXT,
    poster TEXT,
    backdrop TEXT,
    manual INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    parts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (collection_id, item_id)
  );
  CREATE INDEX collection_items_item ON collection_items(item_id);
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('watchlist', 'video', 'music')),
    name TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX lists_watchlist ON lists(profile_id) WHERE kind = 'watchlist';
  CREATE TABLE list_items (
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, item_id)
  );
  CREATE INDEX list_items_item ON list_items(item_id);
  `,
```

(`parts` on `collections` holds TMDB's `[{ tmdbId, title, year }]` in release order, so a collection page can grey out the films you don't own; the spec's table gains this one column.) Make sure `PRAGMA foreign_keys = ON` is set in `openDatabase` (grep; it is for the existing cascades).

- [ ] **Step 4: Run it, then the whole suite**

Run: `node --test test/migrations.test.js 2>&1 | grep -E "^# (pass|fail)"` then `npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: 2 pass; suite 176 pass (174 + 2).

- [ ] **Step 5: Commit (ledger)** `Task 1: complete`

---

### Task 2: The lists store

**Files:**
- Create: `src/lists.js`
- Test: `test/lists.test.js`

**Interfaces:**
- Produces: `class Lists({ db, library })` with `watchlist(profileId)`, `create(profileId, { kind, name })`, `rename(id, name)`, `setShared(id, shared)`, `remove(id)`, `get(id)`, `add(listId, itemId)`, `addSeason(listId, seasonId)`, `removeItem(listId, itemId)`, `move(listId, itemId, position)`, `items(listId, viewer)` → serialized items with progress in order, `forProfile(profile, viewer)` → `[{ id, kind, name, shared, own, ownerName, count, posters: [url…] }]`, `contains(profileId, itemId)` → `{ watchlist, lists }`, `nextIn(listId, afterItemId, viewer)` → row or null, `visibleTo(list, viewer)` → bool, `onChange(fn)`.
- Consumes: `library.canSee`, `library.withProgress`, `library.visibility`, `library.get`, `serializeItem`.

- [ ] **Step 1: Write the failing tests**

```js
// Playlists and the Watchlist: kinds, order, sharing, the kids rule, cascade.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Lists } from '../src/lists.js';

let db, library, lists;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
function addItem(f) {
  const fields = { library_id: 1, kind: 'movie', title: `T${++seq}`, path: `/m/${seq}`, size: 1, mtime: 1, duration: 100, media: VIDEO, genres: '[]', ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const viewer = (profileId, extra = {}) => ({ userId: 1, profileId, kids: false, maxAge: null, allowUnrated: true, libraryIds: null, ...extra });
const ids = {};

before(() => {
  db = openDatabase(path.join(tempDir(), 'lists.db'));
  library = new Library(db);
  lists = new Lists({ db, library });
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('d', 'Dallas', 'x', 'admin', ?)", now);
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('g', 'Guest', 'x', 'user', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'dallas', 'blue', 1, ?)", now); // 1
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, kids, max_age, created_at) VALUES (1, 'Mia', 'green', 0, 1, 10, ?)", now); // 2
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (2, 'guest', 'red', 1, ?)", now); // 3
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now); // 1
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('TV', 'tv', '[]', '{}', ?)", now); // 2
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Music', 'music', '[]', '{}', ?)", now); // 3
  ids.kids = addItem({ title: 'Cartoon', min_age: 0 });
  ids.scary = addItem({ title: 'Scary', min_age: 16 });
  ids.plain = addItem({ title: 'Plain', min_age: 8 });
  ids.show = addItem({ library_id: 2, kind: 'show', title: 'Show', min_age: 8 });
  ids.season = addItem({ library_id: 2, kind: 'season', title: 'Season 1', parent_id: ids.show, show_id: ids.show, season: 1 });
  ids.ep1 = addItem({ library_id: 2, kind: 'episode', title: 'E1', parent_id: ids.season, show_id: ids.show, season: 1, episode: 1 });
  ids.ep2 = addItem({ library_id: 2, kind: 'episode', title: 'E2', parent_id: ids.season, show_id: ids.show, season: 1, episode: 2 });
  ids.track = addItem({ library_id: 3, kind: 'track', title: 'Song' });
});

test('every profile gets one Watchlist on demand, which can\'t be renamed, shared or removed', () => {
  const w = lists.watchlist(1);
  assert.equal(w.kind, 'watchlist');
  assert.equal(lists.watchlist(1).id, w.id);
  assert.throws(() => lists.rename(w.id, 'x'), /Watchlist/);
  assert.throws(() => lists.setShared(w.id, true), /Watchlist/);
  assert.throws(() => lists.remove(w.id), /Watchlist/);
});

test('kinds decide what a list takes; a show adds nothing, a season adds its episodes in order', () => {
  const video = lists.create(1, { kind: 'video', name: 'Friday' });
  const music = lists.create(1, { kind: 'music', name: 'Chill' });
  assert.equal(lists.add(video.id, ids.plain), true);
  assert.equal(lists.add(video.id, ids.show), false);
  assert.equal(lists.add(video.id, ids.track), false);
  assert.equal(lists.add(music.id, ids.plain), false);
  assert.equal(lists.add(music.id, ids.track), true);
  assert.equal(lists.addSeason(video.id, ids.season), 2);
  assert.deepEqual(lists.items(video.id, viewer(1)).map((i) => i.id), [ids.plain, ids.ep1, ids.ep2]);
  assert.equal(lists.add(video.id, ids.plain), false, 'no duplicates');
  const w = lists.watchlist(1);
  assert.equal(lists.add(w.id, ids.show), true);
  assert.equal(lists.add(w.id, ids.ep1), false, 'the Watchlist takes movies and shows');
  ids.video = video.id;
  ids.music = music.id;
});

test('move puts an item at a position and closes the gap', () => {
  lists.move(ids.video, ids.ep2, 0);
  assert.deepEqual(lists.items(ids.video, viewer(1)).map((i) => i.id), [ids.ep2, ids.plain, ids.ep1]);
  lists.move(ids.video, ids.ep2, 2);
  assert.deepEqual(lists.items(ids.video, viewer(1)).map((i) => i.id), [ids.plain, ids.ep1, ids.ep2]);
  lists.removeItem(ids.video, ids.ep1);
  assert.deepEqual(lists.items(ids.video, viewer(1)).map((i) => i.id), [ids.plain, ids.ep2]);
  assert.deepEqual(db.all('SELECT position FROM list_items WHERE list_id = ? ORDER BY position', ids.video).map((r) => r.position), [0, 1]);
});

test('forProfile: own lists, then shared ones from anyone; kids see a shared list only when all of it is kid-safe', () => {
  const shared = lists.create(3, { kind: 'video', name: 'Guest picks' });
  lists.add(shared.id, ids.kids);
  lists.setShared(shared.id, true);
  const mine = lists.forProfile({ id: 1, kids: false }, viewer(1));
  assert.deepEqual(mine.map((l) => l.name), ['Watchlist', 'Friday', 'Chill', 'Guest picks']);
  assert.equal(mine[3].own, false);
  assert.equal(mine[3].ownerName, 'guest');
  assert.equal(mine[1].count, 2);
  const kid = lists.forProfile({ id: 2, kids: true }, viewer(2, { kids: true, maxAge: 10, allowUnrated: false }));
  assert.ok(kid.some((l) => l.name === 'Guest picks'), 'all kid-safe: visible');
  lists.add(shared.id, ids.scary);
  const kid2 = lists.forProfile({ id: 2, kids: true }, viewer(2, { kids: true, maxAge: 10, allowUnrated: false }));
  assert.ok(!kid2.some((l) => l.name === 'Guest picks'), 'one scary film hides the whole list from a kid');
  assert.equal(lists.visibleTo(lists.get(shared.id), viewer(2, { kids: true, maxAge: 10, allowUnrated: false })), false);
  ids.shared = shared.id;
});

test('contains and nextIn', () => {
  assert.deepEqual(lists.contains(1, ids.plain), { watchlist: false, lists: [ids.video] });
  assert.deepEqual(lists.contains(1, ids.show), { watchlist: true, lists: [] });
  assert.equal(lists.nextIn(ids.video, ids.plain, viewer(1)).id, ids.ep2);
  assert.equal(lists.nextIn(ids.video, ids.ep2, viewer(1)), null);
  // A hidden item in the middle is skipped for a viewer who can't see it.
  lists.add(ids.shared, ids.plain);
  assert.equal(lists.nextIn(ids.shared, ids.kids, viewer(2, { kids: true, maxAge: 10, allowUnrated: false })).id, ids.plain);
});

test('deleting an item drops it from every list; onChange fires', () => {
  let fired = 0;
  lists.onChange(() => fired++);
  const gone = addItem({ title: 'Gone', min_age: 0 });
  lists.add(ids.video, gone);
  db.run('DELETE FROM items WHERE id = ?', gone);
  assert.ok(!lists.items(ids.video, viewer(1)).some((i) => i.id === gone));
  lists.add(ids.video, ids.ep1);
  assert.ok(fired >= 1);
});
```

Check the `profiles` columns (`kids`, `max_age`, `is_primary`, `avatar`) against `CREATE TABLE profiles` in `src/db.js` and later migrations; use the real names. Check `Library` needs only `db` in its constructor.

- [ ] **Step 2: Run it** — Expected: FAIL, `Cannot find module '../src/lists.js'`.

- [ ] **Step 3: Write `src/lists.js`**

```js
// Playlists and the Watchlist. A list belongs to a profile; a video list holds movies and episodes, a music
// list tracks, the Watchlist movies and shows. Shared lists are visible to the household; kids see a shared
// list only when everything in it passes their age rule. Only the owner edits.
import { HttpError } from './http/router.js';

const TAKES = { watchlist: ['movie', 'show'], video: ['movie', 'episode'], music: ['track'] };

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
    const own = this.db.all("SELECT * FROM lists WHERE profile_id = ? ORDER BY CASE kind WHEN 'watchlist' THEN 0 ELSE 1 END, created_at", profile.id);
    if (!own.some((l) => l.kind === 'watchlist')) own.unshift(this.watchlist(profile.id));
    const shared = this.db.all('SELECT l.*, p.name AS owner_name FROM lists l JOIN profiles p ON p.id = l.profile_id WHERE l.shared = 1 AND l.profile_id != ? ORDER BY l.updated_at DESC', profile.id).filter((l) => this.visibleTo(l, viewer));
    const summarise = (l, ownFlag) => {
      const rows = this.rows(l.id).filter((r) => this.library.canSee(viewer, r));
      return { id: l.id, kind: l.kind, name: l.name, shared: Boolean(l.shared), own: ownFlag, ownerName: ownFlag ? profile.name : l.owner_name, count: rows.length, posters: rows.slice(0, 4).map((r) => `/api/items/${r.kind === 'track' && r.parent_id ? r.parent_id : r.id}/image/poster?v=${r.metadata_at || 0}`), updatedAt: l.updated_at };
    };
    return [...own.map((l) => summarise(l, true)), ...shared.map((l) => summarise(l, false))];
  }
  contains(profileId, itemId) {
    const rows = this.db.all('SELECT l.id, l.kind FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.item_id = ? AND l.profile_id = ?', Number(itemId), profileId);
    return { watchlist: rows.some((r) => r.kind === 'watchlist'), lists: rows.filter((r) => r.kind !== 'watchlist').map((r) => r.id) };
  }
  /** The next playable item after `afterItemId`, skipping what the viewer can't see. */
  nextIn(listId, afterItemId, viewer) {
    const rows = this.rows(listId);
    const at = rows.findIndex((r) => r.id === Number(afterItemId));
    return rows.slice(at + 1).find((r) => this.library.canSee(viewer, r)) || null;
  }
}
```

Check `db.transaction(fn)` exists in `src/db.js` (grep showed it at line ~304) and its signature. The poster URL shape must match `imageUrl()` in `src/api/serialize.js` — read it and copy the exact form.

- [ ] **Step 4: Run** — Expected: 6 pass. Then `npm test` → 182 pass.
- [ ] **Step 5: Commit (ledger)** `Task 2: complete`

---

### Task 3: The collections store

**Files:**
- Create: `src/collections.js`
- Test: `test/collections.test.js`

**Interfaces:**
- Produces: `class Collections({ db, library })` with `upsertTmdb({ tmdbId, name, overview, poster, backdrop, parts }, item, position)`, `detach(itemId)`, `create({ name, overview, itemIds })`, `update(id, { name, overview, hidden, itemIds, artworkFrom })`, `remove(id)`, `get(id, viewer)` → `{ id, name, overview, poster, backdrop, manual, hidden, owned, total, items: [serialized in order], missing: [{ title, year }] }` or null, `forItem(itemId, viewer)` → the same shape or null, `list(viewer, { includeHidden })` → summaries.
- `poster`/`backdrop` are stored as the image-cache keys the `images.store()` returns (same as items); serialized through `imageUrl`-style `/api/collections/:id/image/:type`.

- [ ] **Step 1: Write the failing tests**

```js
// Collections: film series from TMDB and hand-made ones; a rename survives a refresh; hidden; kids filtering.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Collections } from '../src/collections.js';

let db, library, collections;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
function addItem(f) {
  const fields = { library_id: 1, kind: 'movie', title: `T${++seq}`, path: `/m/${seq}`, size: 1, mtime: 1, duration: 100, media: VIDEO, genres: '[]', ...f };
  const cols = Object.keys(fields);
  return Number(db.run(`INSERT INTO items (${cols.join(',')}, added_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...Object.values(fields), now, now).lastInsertRowid);
}
const adult = { userId: 1, profileId: 1, kids: false, maxAge: null, allowUnrated: true, libraryIds: null };
const kid = { userId: 1, profileId: 2, kids: true, maxAge: 10, allowUnrated: false, libraryIds: null };
const ids = {};
const series = { tmdbId: 8091, name: 'Alien Collection', overview: 'Xenomorphs.', poster: null, backdrop: null, parts: [{ tmdbId: 348, title: 'Alien', year: 1979 }, { tmdbId: 679, title: 'Aliens', year: 1986 }, { tmdbId: 8077, title: 'Alien³', year: 1992 }] };

before(() => {
  db = openDatabase(path.join(tempDir(), 'c.db'));
  library = new Library(db);
  collections = new Collections({ db, library });
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now);
  ids.alien = addItem({ title: 'Alien', year: 1979, tmdb_id: 348, min_age: 16 });
  ids.aliens = addItem({ title: 'Aliens', year: 1986, tmdb_id: 679, min_age: 16 });
  ids.cartoon = addItem({ title: 'Cartoon', year: 2020, min_age: 0 });
  ids.show = addItem({ library_id: 1, kind: 'show', title: 'Kids Show', min_age: 0 });
});

test('a TMDB collection is created once and films take their release-order position', () => {
  collections.upsertTmdb(series, library.get(ids.aliens));
  collections.upsertTmdb(series, library.get(ids.alien));
  const c = collections.forItem(ids.alien, adult);
  assert.equal(c.name, 'Alien Collection');
  assert.deepEqual(c.items.map((i) => i.title), ['Alien', 'Aliens']);
  assert.equal(c.owned, 2);
  assert.equal(c.total, 3);
  assert.deepEqual(c.missing, [{ title: 'Alien³', year: 1992 }]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM collections').n, 1);
  ids.alienCollection = c.id;
});

test('a rename survives a later refresh; hidden keeps it out of lists but not off a film\'s page', () => {
  collections.update(ids.alienCollection, { name: 'Alien films' });
  collections.upsertTmdb(series, library.get(ids.aliens));
  assert.equal(collections.get(ids.alienCollection, adult).name, 'Alien films');
  collections.update(ids.alienCollection, { hidden: true });
  assert.ok(!collections.list(adult).some((c) => c.id === ids.alienCollection));
  assert.equal(collections.forItem(ids.alien, adult).name, 'Alien films');
  collections.update(ids.alienCollection, { hidden: false });
});

test('a kid sees only the safe part of a collection, and none of it when nothing is safe', () => {
  assert.equal(collections.get(ids.alienCollection, kid), null);
  assert.ok(!collections.list(kid).some((c) => c.id === ids.alienCollection));
});

test('hand-made collections mix films and shows, keep their order, and can be removed; TMDB ones can\'t', () => {
  const c = collections.create({ name: 'Family night', itemIds: [ids.show, ids.cartoon] });
  assert.equal(c.manual, true);
  assert.deepEqual(collections.get(c.id, adult).items.map((i) => i.title), ['Kids Show', 'Cartoon']);
  collections.update(c.id, { itemIds: [ids.cartoon, ids.show], artworkFrom: ids.cartoon });
  assert.deepEqual(collections.get(c.id, kid).items.map((i) => i.title), ['Cartoon', 'Kids Show']);
  assert.equal(collections.get(c.id, adult).total, 2, 'a hand-made collection\'s total is what it holds');
  assert.equal(collections.forItem(ids.cartoon, adult).id, c.id);
  assert.throws(() => collections.remove(ids.alienCollection), /TMDB/);
  collections.remove(c.id);
  assert.equal(collections.get(c.id, adult), null);
});

test('detach takes a film out of its TMDB collection (unmatching), and a deleted film disappears', () => {
  collections.detach(ids.aliens);
  assert.deepEqual(collections.get(ids.alienCollection, adult).items.map((i) => i.title), ['Alien']);
  db.run('DELETE FROM items WHERE id = ?', ids.alien);
  assert.equal(collections.get(ids.alienCollection, adult), null, 'no visible members: nothing to show');
});
```

- [ ] **Step 2: Run** — Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/collections.js`**

```js
// Collections: film series TMDB knows about (one row per tmdb_id, members placed by release order) and
// hand-made ones an admin builds from films and shows. A collection shows only the members the viewer
// may see; with none, it isn't there for that viewer.
import { HttpError } from './http/router.js';
import { serializeItem } from './api/serialize.js';

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

export class Collections {
  constructor({ db, library }) {
    this.db = db;
    this.library = library;
  }
  row(id) {
    return this.db.get('SELECT * FROM collections WHERE id = ?', Number(id)) || null;
  }
  /** From TMDB, on a movie's refresh. Never overwrites a name (renames stick); refreshes artwork/parts if empty. */
  upsertTmdb(series, item) {
    if (!series?.tmdbId || !item) return null;
    const now = Date.now();
    let c = this.db.get('SELECT * FROM collections WHERE tmdb_id = ?', series.tmdbId);
    if (!c) {
      const id = Number(this.db.run('INSERT INTO collections (tmdb_id, name, overview, poster, backdrop, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', series.tmdbId, series.name, series.overview || null, series.poster || null, series.backdrop || null, JSON.stringify(series.parts || []), now, now).lastInsertRowid);
      c = this.row(id);
    } else {
      this.db.run('UPDATE collections SET overview = COALESCE(overview, ?), poster = COALESCE(poster, ?), backdrop = COALESCE(backdrop, ?), parts = CASE WHEN parts = \'[]\' THEN ? ELSE parts END, updated_at = ? WHERE id = ?', series.overview || null, series.poster || null, series.backdrop || null, JSON.stringify(series.parts || []), now, c.id);
    }
    const parts = parse(c.parts, []).length ? parse(c.parts, []) : series.parts || [];
    const position = Math.max(0, parts.findIndex((p) => p.tmdbId === item.tmdb_id));
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
    const id = Number(this.db.run('INSERT INTO collections (name, overview, manual, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', clean, overview, now, now).lastInsertRowid);
    this.setItems(id, itemIds);
    return this.summary(this.row(id));
  }
  setItems(id, itemIds) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM collection_items WHERE collection_id = ?', id);
      let pos = 0;
      for (const itemId of itemIds) {
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
    if (name !== undefined) { const clean = String(name).trim().slice(0, 80); if (!clean) throw new HttpError(400, 'Give the collection a name.'); sets.push('name = ?'); params.push(clean); }
    if (overview !== undefined) { sets.push('overview = ?'); params.push(overview || null); }
    if (hidden !== undefined) { sets.push('hidden = ?'); params.push(hidden ? 1 : 0); }
    if (artworkFrom !== undefined) {
      const it = this.library.get(Number(artworkFrom));
      if (!it) throw new HttpError(404, 'No such title');
      sets.push('poster = ?', 'backdrop = ?'); params.push(it.poster || null, it.backdrop || null);
    }
    if (itemIds !== undefined) { if (!c.manual) throw new HttpError(400, 'A TMDB collection\'s films come from TMDB.'); this.setItems(c.id, itemIds); }
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
    return { id: c.id, tmdbId: c.tmdb_id, name: c.name, overview: c.overview, manual: Boolean(c.manual), hidden: Boolean(c.hidden), poster: c.poster ? `/api/collections/${c.id}/image/poster?v=${c.updated_at}` : null, backdrop: c.backdrop ? `/api/collections/${c.id}/image/backdrop?v=${c.updated_at}` : null, ...extra };
  }
  /** Full shape for a viewer, or null when they can see none of it. */
  get(id, viewer) {
    const c = this.row(id);
    if (!c) return null;
    const rows = this.members(c.id).filter((r) => this.library.canSee(viewer, r));
    if (!rows.length) return null;
    const parts = parse(c.parts, []);
    const ownedTmdb = new Set(rows.map((r) => r.tmdb_id));
    const missing = parts.filter((p) => !ownedTmdb.has(p.tmdbId)).map((p) => ({ title: p.title, year: p.year }));
    const items = this.library.withProgress(rows, viewer);
    const s = this.summary(c, { owned: rows.length, total: c.manual ? rows.length : Math.max(parts.length, rows.length), items, missing });
    if (!s.poster) s.poster = items[0]?.poster || null;
    if (!s.backdrop) s.backdrop = items[0]?.backdrop || null;
    return s;
  }
  forItem(itemId, viewer) {
    const link = this.db.get('SELECT collection_id FROM collection_items WHERE item_id = ? ORDER BY collection_id LIMIT 1', Number(itemId));
    return link ? this.get(link.collection_id, viewer) : null;
  }
  list(viewer, { includeHidden = false } = {}) {
    const rows = this.db.all(`SELECT * FROM collections ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY name COLLATE NOCASE`);
    return rows.map((c) => this.get(c.id, viewer)).filter(Boolean).map(({ items, missing, ...rest }) => ({ ...rest, firstPoster: items[0]?.poster || null }));
  }
}
```

- [ ] **Step 4: Run** — Expected: 5 pass; `npm test` → 187 pass.
- [ ] **Step 5: Commit (ledger)** `Task 3: complete`

---

### Task 4: TMDB keywords, people and the film series; the catch-up pass

**Files:**
- Modify: `src/library/metadata.js` (the TMDB provider's movie and show fetches; `FIELDS`; `refresh()`; new `enrichMissing()`), `src/app.js` (wire `core.lists`, `core.collections`, metadata's collections; run `enrichMissing` at start and on `scan:complete`)
- Test: `test/metadata.test.js` (additions) — read its existing fake-TMDB style first and add to it.

**Interfaces:**
- Produces: TMDB provider results gain `keywords: string[]`, `people: [{ name, role }]`, `collection: { tmdbId, name, overview, poster, backdrop, parts }`; `refresh()` writes `keywords`/`people` and calls `this.collections.upsertTmdb()` / `detach()`; `metadata.setCollections(collections)`; `metadata.enrichMissing()` → `{ done }`.

- [ ] **Step 1: Write the failing tests** (in `test/metadata.test.js`, using its fake TMDB server: add routes)

Add to the fake server: `/3/movie/348` returning `{ id: 348, title: 'Alien', release_date: '1979-05-25', genres: [{ name: 'Horror' }], belongs_to_collection: { id: 8091, name: 'Alien Collection', poster_path: null, backdrop_path: null }, keywords: { keywords: [{ name: 'Space' }, { name: 'Android' }] }, credits: { cast: [{ name: 'Sigourney Weaver', order: 0 }, { name: 'Tom Skerritt', order: 1 }], crew: [{ name: 'Ridley Scott', job: 'Director' }] } }`, `/3/collection/8091` returning `{ id: 8091, name: 'Alien Collection', overview: 'Xenomorphs.', parts: [{ id: 348, title: 'Alien', release_date: '1979-05-25' }, { id: 679, title: 'Aliens', release_date: '1986-07-18' }] }`, `/3/search/movie` matching "alien" → `[{ id: 348, title: 'Alien' }]`, and a show `/3/tv/33` gaining `keywords: { results: [{ name: 'Coast' }] }, aggregate_credits: { cast: [{ name: 'Theo', order: 0 }] }, created_by: [{ name: 'A. Writer' }]`.

```js
test('a matched movie stores keywords, people and its TMDB collection; a show stores keywords and creator', async () => {
  // metadata is the MetadataManager under test, db its database, collections a Collections store wired in
  const alien = row(addItem({ title: 'Alien', year: 1979 }));
  await metadata.refresh(alien);
  const r = row(alien.id);
  assert.deepEqual(JSON.parse(r.keywords), ['space', 'android']);
  assert.deepEqual(JSON.parse(r.people), [{ name: 'Ridley Scott', role: 'director' }, { name: 'Sigourney Weaver', role: 'cast' }, { name: 'Tom Skerritt', role: 'cast' }]);
  const c = db.get('SELECT * FROM collections WHERE tmdb_id = 8091');
  assert.equal(c.name, 'Alien Collection');
  assert.deepEqual(JSON.parse(c.parts).map((p) => p.title), ['Alien', 'Aliens']);
  assert.equal(db.get('SELECT position FROM collection_items WHERE item_id = ?', alien.id).position, 0);
  const show = row(addItem({ kind: 'show', title: 'Demo Show', library_id: tvLibraryId }));
  await metadata.refresh(show);
  assert.deepEqual(JSON.parse(row(show.id).keywords), ['coast']);
  assert.deepEqual(JSON.parse(row(show.id).people)[0], { name: 'A. Writer', role: 'creator' });
});

test('enrichMissing fills titles matched before v0.9.0 and skips the rest', async () => {
  const old = addItem({ title: 'Alien', year: 1979, tmdb_id: 348, metadata_at: 1 }); // matched, but no keywords yet
  const noMatch = addItem({ title: 'Home Video', year: 2021 });
  const r = await metadata.enrichMissing();
  assert.equal(r.done, 1);
  assert.deepEqual(JSON.parse(row(old).keywords), ['space', 'android']);
  assert.equal(row(noMatch).keywords, '[]');
  assert.equal((await metadata.enrichMissing()).done, 0, 'nothing left');
});
```

Adapt the helper names (`row`, `addItem`, the TV library id) to what `test/metadata.test.js` already has; if it has no `Collections`, construct one in `before()` and call `metadata.setCollections(collections)`.

- [ ] **Step 2: Run** — Expected: FAIL (`keywords` is `'[]'`; `collections` empty; `enrichMissing` not a function).

- [ ] **Step 3: The provider** — in the TMDB provider's movie fetch change `append_to_response: 'release_dates,images'` to `'release_dates,images,keywords,credits'` and add to the returned object:

```js
        keywords: keywordNames(m.keywords?.keywords),
        people: people(m.credits?.crew?.filter((c) => c.job === 'Director').map((c) => c.name), 'director', m.credits?.cast),
        collection: await this.collectionOf(m.belongs_to_collection),
```

For the show fetch: `'external_ids,content_ratings,images,keywords,aggregate_credits'` and `keywords: keywordNames(s.keywords?.results), people: people((s.created_by || []).map((c) => c.name), 'creator', s.aggregate_credits?.cast)`. Add module helpers and a provider method:

```js
const keywordNames = (list) => [...new Set((list || []).map((k) => String(k.name || '').trim().toLowerCase()).filter(Boolean))].slice(0, 30);
function people(leads, role, cast) {
  const out = (leads || []).filter(Boolean).map((name) => ({ name, role }));
  for (const c of [...(cast || [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 8)) if (c.name) out.push({ name: c.name, role: 'cast' });
  return out;
}
```

```js
  /** The film series a movie belongs to, with its parts in release order (one extra request, cached per run). */
  async collectionOf(ref) {
    if (!ref?.id) return null;
    this.collectionCache ||= new Map();
    if (!this.collectionCache.has(ref.id)) {
      const c = await this.request(`/collection/${ref.id}`);
      const parts = (c?.parts || []).filter((p) => p.release_date).sort((a, b) => a.release_date.localeCompare(b.release_date)).map((p) => ({ tmdbId: p.id, title: p.title, year: Number(p.release_date.slice(0, 4)) }));
      this.collectionCache.set(ref.id, { tmdbId: ref.id, name: c?.name || ref.name, overview: c?.overview || null, poster: this.img(c?.poster_path || ref.poster_path, 'w500'), backdrop: this.img(c?.backdrop_path || ref.backdrop_path, 'w1280'), parts });
    }
    return this.collectionCache.get(ref.id);
  }
```

Add `'keywords', 'people', 'collection'` to `FIELDS`.

- [ ] **Step 4: `refresh()` writes them** — after the big `UPDATE items SET …` add:

```js
    if (m.keywords || m.people) this.db.run('UPDATE items SET keywords = ?, people = ? WHERE id = ?', JSON.stringify(m.keywords || parseJson(item.keywords, [])), JSON.stringify(m.people || parseJson(item.people, [])), item.id);
    if (this.collections && (item.kind === 'movie')) {
      const fresh = this.db.get('SELECT * FROM items WHERE id = ?', item.id);
      if (m.collection) {
        const [poster, backdrop] = await Promise.all([this.images.store(m.collection.poster), this.images.store(m.collection.backdrop)]);
        this.collections.upsertTmdb({ ...m.collection, poster, backdrop }, fresh);
      } else if (m.tmdbId && m.tmdbId !== item.tmdb_id) this.collections.detach(item.id);
    }
```

Add `setCollections(c) { this.collections = c; }` to `MetadataManager`. Add `enrichMissing()`:

```js
  /** Titles matched before keywords/people/collections existed: fetch just those, one at a time, in the background. */
  async enrichMissing() {
    if (this.enriching) return { done: 0, busy: true };
    const tmdb = this.providers.find((p) => p.id === 'tmdb');
    if (!tmdb?.enabled?.()) { if (!this.warnedNoKey) { log.info('No TMDB key: keywords, cast and collections stay empty.'); this.warnedNoKey = true; } return { done: 0 }; }
    this.enriching = true;
    let done = 0;
    try {
      const rows = this.db.all("SELECT * FROM items WHERE kind IN ('movie','show') AND tmdb_id IS NOT NULL AND keywords = '[]' AND people = '[]' ORDER BY added_at DESC");
      for (const item of rows) {
        try {
          const result = await tmdb.fetch(item, { merged: {}, tmdbId: item.tmdb_id, libraryRoots: [], db: this.db, enrichOnly: true });
          if (!result) continue;
          this.db.run('UPDATE items SET keywords = ?, people = ? WHERE id = ?', JSON.stringify(result.keywords || []), JSON.stringify(result.people || []), item.id);
          if (result.collection && this.collections) {
            const [poster, backdrop] = await Promise.all([this.images.store(result.collection.poster), this.images.store(result.collection.backdrop)]);
            this.collections.upsertTmdb({ ...result.collection, poster, backdrop }, item);
          }
          done++;
          await new Promise((r) => setTimeout(r, 250));
        } catch (err) {
          log.warn(`Couldn't fetch keywords for "${item.title}": ${err.message}`);
        }
      }
    } finally {
      this.enriching = false;
    }
    if (done) log.info(`Fetched keywords and cast for ${done} title${done === 1 ? '' : 's'}.`);
    return { done };
  }
```

Check how the TMDB provider reports "enabled" (an API key present) — grep `apiKey`/`enabled` in `metadata.js` and use its real method; the provider's `fetch(item, ctx)` with `ctx.tmdbId` set must skip the search (it does: `let id = ctx.tmdbId ?? …`). If `enrichMissing` sets `keywords = '[]'` for a title TMDB has none for, it would loop forever: after a successful fetch with no keywords store `'["-"]'`? No — store the empty array but set `people` to `[{"name":"","role":"none"}]`? Neither is honest. Instead add `metadata_at = ?` (now) in the same UPDATE and select `… AND (keywords = '[]' AND people = '[]') AND metadata_at < ?` with the v0.9.0 cut-off = the migration time saved in settings (`settings.get('enrichedAt')`), set once after the first full pass. Simplest correct rule: the query adds `AND COALESCE(json_extract(people, '$[0]'), '') = ''` and after a fetch with nothing to store, write `people = '[{"name":"","role":"none"}]'` so the title is never asked again; `serializeItem` drops `role: 'none'` entries. Do that, and test it with a third fake movie that has no credits.

- [ ] **Step 5: Wire in `src/app.js`** — after `core.extras = …`:

```js
  core.lists = new Lists({ db, library });
  core.collections = new Collections({ db, library });
  metadata.setCollections(core.collections);
```

and after the `scan:complete` hook: `hooks.on('scan:complete', () => { metadata.enrichMissing().catch(() => {}); });` plus, at the end of `createApp` start-up (after plugins load): `setTimeout(() => metadata.enrichMissing().catch(() => {}), 5000);`. Imports at the top. Also `hooks.on('item:removed', …)` isn't needed (cascade).

- [ ] **Step 6: Run** — `node --test test/metadata.test.js` → all pass; `npm test` → 189 pass.
- [ ] **Step 7: Commit (ledger)** `Task 4: complete`

---

### Task 5: Picks

**Files:**
- Create: `src/picks.js`
- Test: `test/picks.test.js`

**Interfaces:**
- Produces: `class Picks({ db, library, collections })` with `similar(itemId, viewer, { limit = 20 })` → serialized items with `score`, `becauseYouWatched(viewer)` → `[{ seed: serialized, items }]` (up to 2), `clear()`; scoring per Global Constraints; a 10-minute per-profile cache.

- [ ] **Step 1: Write the failing test**

```js
// Picks: "Because you watched" and "More like this", scored from the library itself.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Library } from '../src/library/queries.js';
import { Collections } from '../src/collections.js';
import { Picks } from '../src/picks.js';

let db, library, collections, picks;
const now = Date.now();
let seq = 0;
const VIDEO = JSON.stringify({ video: { width: 1920, height: 1080 }, audio: [{ index: 0 }] });
const J = JSON.stringify;
function movie(title, { year = 2000, genres = [], keywords = [], director = null, cast = [], min_age = null, rating = 6 } = {}) {
  const people = [...(director ? [{ name: director, role: 'director' }] : []), ...cast.map((name) => ({ name, role: 'cast' }))];
  return Number(db.run("INSERT INTO items (library_id, kind, title, year, genres, keywords, people, min_age, rating, path, size, mtime, duration, media, added_at, updated_at) VALUES (1, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 100, ?, ?, ?)", title, year, J(genres), J(keywords), J(people), min_age, rating, `/m/${++seq}`, VIDEO, now, now).lastInsertRowid);
}
const adult = { userId: 1, profileId: 1, kids: false, maxAge: null, allowUnrated: true, libraryIds: null };
const kid = { userId: 1, profileId: 2, kids: true, maxAge: 10, allowUnrated: false, libraryIds: null };
const ids = {};

before(() => {
  db = openDatabase(path.join(tempDir(), 'p.db'));
  library = new Library(db);
  collections = new Collections({ db, library });
  picks = new Picks({ db, library, collections, ttlMs: 10 * 60 * 1000 });
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('d', 'd', 'x', 'admin', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'dallas', 'blue', 1, ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, kids, max_age, created_at) VALUES (1, 'Mia', 'green', 0, 1, 10, ?)", now);
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", now);
  ids.alien = movie('Alien', { year: 1979, genres: ['Horror', 'Sci-Fi'], keywords: ['space', 'android', 'monster'], director: 'Ridley Scott', cast: ['Sigourney Weaver', 'Tom Skerritt'], min_age: 16 });
  ids.aliens = movie('Aliens', { year: 1986, genres: ['Action', 'Sci-Fi'], keywords: ['space', 'android', 'marines'], director: 'James Cameron', cast: ['Sigourney Weaver'], min_age: 16, rating: 8 }); // collection +5, kw +6, cast +2, genre +1 = 14
  ids.bladerunner = movie('Blade Runner', { year: 1982, genres: ['Sci-Fi'], keywords: ['android', 'dystopia'], director: 'Ridley Scott', min_age: 16 }); // kw +3, director +3, genre +1, decade +1 = 8
  ids.thing = movie('The Thing', { year: 1982, genres: ['Horror', 'Sci-Fi'], keywords: ['monster', 'isolation'], min_age: 16 }); // kw +3, genre +2, decade +1 = 6
  ids.cartoon = movie('Cartoon', { year: 2020, genres: ['Animation'], keywords: ['space'], min_age: 0 }); // kw +3 = 3 (kept)
  ids.romcom = movie('Romcom', { year: 2019, genres: ['Comedy'], keywords: ['wedding'], min_age: 8 }); // 0 (dropped)
  ids.gladiator = movie('Gladiator', { year: 2000, genres: ['Action'], director: 'Ridley Scott', min_age: 13 }); // director +3 = 3
  const c = collections.create({ name: 'Alien films', itemIds: [ids.alien, ids.aliens] });
  ids.collection = c.id;
});

test('similar: scored and ordered as the spec says, the seed excluded, below 3 dropped', () => {
  const s = picks.similar(ids.alien, adult);
  assert.deepEqual(s.map((i) => [i.title, i.score]), [['Aliens', 14], ['Blade Runner', 8], ['The Thing', 6], ['Cartoon', 3], ['Gladiator', 3]]);
});

test('unwatched first, then by score; a kid only gets kid-safe picks', () => {
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (1, ?, 0, 100, 1, ?)', ids.aliens, now);
  picks.clear();
  const s = picks.similar(ids.alien, adult);
  assert.deepEqual(s.map((i) => i.title), ['Blade Runner', 'The Thing', 'Cartoon', 'Gladiator', 'Aliens']);
  assert.deepEqual(picks.similar(ids.cartoon, kid).map((i) => i.title), [], 'nothing safe shares enough with Cartoon');
});

test('becauseYouWatched: two seeds from what was watched last, most recent first, episodes count as their show', () => {
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (1, ?, 30, 100, 0, ?)', ids.alien, now + 1000);
  picks.clear();
  const rows = picks.becauseYouWatched(adult);
  assert.deepEqual(rows.map((r) => r.seed.title), ['Alien', 'Aliens']);
  assert.equal(rows[0].items[0].title, 'Blade Runner');
});

test('the cache holds until cleared', () => {
  const a = picks.similar(ids.alien, adult);
  movie('Prometheus', { year: 2012, genres: ['Sci-Fi'], keywords: ['space', 'android'], director: 'Ridley Scott', min_age: 16 });
  assert.equal(picks.similar(ids.alien, adult).length, a.length, 'cached');
  picks.clear();
  assert.ok(picks.similar(ids.alien, adult).some((i) => i.title === 'Prometheus'));
});
```

- [ ] **Step 2: Run** — Expected: module not found.

- [ ] **Step 3: Write `src/picks.js`**

```js
// "Because you watched" and "More like this": scored from the library itself, nothing leaves the server.
// Same collection 5 · each shared keyword 3 · shared director/creator 3 · each shared cast member 2 ·
// each shared genre 1 · same decade 1. Keep ≥ 3, top 20 by score then rating, unwatched first.
import { EVERYONE } from './library/queries.js';

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

export class Picks {
  constructor({ db, library, collections, ttlMs = 10 * 60 * 1000 }) {
    this.db = db;
    this.library = library;
    this.collections = collections;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // `${profileId}:${key}` → { at, value }
  }
  clear() {
    this.cache.clear();
  }
  cached(viewer, key, make) {
    const k = `${viewer.profileId}:${key}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = make();
    this.cache.set(k, { at: Date.now(), value });
    return value;
  }
  profile(row) {
    const people = parse(row.people, []);
    return {
      id: row.id,
      genres: new Set(parse(row.genres, [])),
      keywords: new Set(parse(row.keywords, [])),
      leads: new Set(people.filter((p) => p.role === 'director' || p.role === 'creator').map((p) => p.name)),
      cast: new Set(people.filter((p) => p.role === 'cast').map((p) => p.name)),
      decade: row.year ? Math.floor(row.year / 10) : null,
      collection: this.db.get('SELECT collection_id FROM collection_items WHERE item_id = ? LIMIT 1', row.id)?.collection_id ?? null,
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
  similar(itemId, viewer = EVERYONE, { limit = 20 } = {}) {
    return this.cached(viewer, `similar:${itemId}`, () => {
      const seed = this.library.get(Number(itemId));
      if (!seed) return [];
      const a = this.profile(seed);
      const rows = this.candidates(viewer).filter((r) => r.id !== seed.id);
      const progress = this.library.progressFor(viewer.profileId, rows.map((r) => r.id));
      const scored = rows.map((r) => ({ row: r, score: this.score(a, this.profile(r)), seen: progress.has(r.id) })).filter((x) => x.score >= 3);
      scored.sort((x, y) => Number(x.seen) - Number(y.seen) || y.score - x.score || (y.row.rating || 0) - (x.row.rating || 0) || x.row.id - y.row.id);
      const top = scored.slice(0, limit);
      return this.library.withProgress(top.map((x) => x.row), viewer).map((s, i) => ({ ...s, score: top[i].score }));
    });
  }
  /** Up to two seeds: the most recently watched or in-progress titles (an episode counts as its show, once). */
  becauseYouWatched(viewer, { seeds = 2 } = {}) {
    if (!viewer.profileId) return [];
    return this.cached(viewer, 'byw', () => {
      const recent = this.db.all('SELECT i.*, p.updated_at AS seen_at FROM progress p JOIN items i ON i.id = p.item_id WHERE p.profile_id = ? ORDER BY p.updated_at DESC LIMIT 40', viewer.profileId);
      const out = [];
      const used = new Set();
      for (const r of recent) {
        const seedRow = r.kind === 'episode' && r.show_id ? this.library.get(r.show_id) : r;
        if (!seedRow || !['movie', 'show'].includes(seedRow.kind) || used.has(seedRow.id) || !this.library.canSee(viewer, seedRow)) continue;
        used.add(seedRow.id);
        const items = this.similar(seedRow.id, viewer);
        if (items.length) out.push({ seed: this.library.withProgress([seedRow], viewer)[0], items });
        if (out.length >= seeds) break;
      }
      return out;
    });
  }
}
```

Note the "unwatched first" rule: a title with any progress row (watched or in progress) sorts after fresh ones; `progressFor` already returns only rows that exist.

- [ ] **Step 4: Wire** — in `src/app.js` after `core.collections`: `core.picks = new Picks({ db, library, collections: core.collections });`, `core.lists.onChange(() => core.picks.clear());`, and inside the `scan:complete` hook `core.picks.clear();`.
- [ ] **Step 5: Run** — 4 pass; `npm test` → 193.
- [ ] **Step 6: Commit (ledger)** `Task 5: complete`

---

### Task 6: The API

**Files:**
- Create: `src/api/lists.js`
- Modify: `src/app.js` (register), `src/api/library.js` (`/api/items/:id` fields; `/api/home` rows; collections image route), `src/api/playback.js` (`listId` in the start body → `next` from the list)
- Test: `test/lists-api.test.js` (new; uses `startAtomix`, `client`, `makeVideo`, `waitForScan` from `test/helpers.js` like `test/profiles.test.js`)

**Interfaces:**
- Produces the routes in the spec §2. `POST /api/playback/start` accepts `listId`; `next` then comes from `core.lists.nextIn`.

- [ ] **Step 1: Write the failing tests** — the fixture: a Movies library with `Alien (1979)`, `Aliens (1986)`, `Cartoon (2020)` (nfo `NZ:G`), `Scary (2018)` (nfo `R16`), a TV library with `Show/Season 01/E01, E02`, a Music library with two tracks (see `test/music.test.js` for how tracks are made); a fake TMDB that matches Alien/Aliens to collection 8091 as in Task 4. Profiles: `dallas` (admin, adult), `Mia` (kids, max 10) made through `POST /api/profiles`; a second user `guest` through `POST /api/users`. Then:

```js
test('the Watchlist: toggle, item flags, the Home row', async () => {
  assert.equal((await admin.put(`/api/watchlist/${ids.Alien}`)).status, 204);
  assert.equal((await admin.get(`/api/items/${ids.Alien}`)).data.inWatchlist, true);
  const home = (await admin.get('/api/home')).data;
  const row = home.rows.find((r) => r.id === 'watchlist');
  assert.equal(row.title, 'My Watchlist');
  assert.deepEqual(row.items.map((i) => i.title), ['Alien']);
  assert.equal((await admin.del(`/api/watchlist/${ids.Alien}`)).status, 204);
  assert.ok(!(await admin.get('/api/home')).data.rows.some((r) => r.id === 'watchlist'));
});

test('playlists: create, add, reorder, share; a kid sees a shared list only when it is safe; others can\'t edit', async () => {
  const list = (await admin.post('/api/lists', { kind: 'video', name: 'Friday' })).data;
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Cartoon })).status, 204);
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { seasonId: ids.season })).status, 204);
  let got = (await admin.get(`/api/lists/${list.id}`)).data;
  assert.deepEqual(got.items.map((i) => i.title), ['Cartoon', 'E1', 'E2']);
  await admin.put(`/api/lists/${list.id}/items/${ids.Cartoon}/position`, { position: 2 });
  got = (await admin.get(`/api/lists/${list.id}`)).data;
  assert.deepEqual(got.items.map((i) => i.title), ['E1', 'E2', 'Cartoon']);
  assert.equal((await guest.patch(`/api/lists/${list.id}`, { name: 'Mine' })).status, 403);
  assert.equal((await guest.get(`/api/lists/${list.id}`)).status, 404, 'not shared: not there');
  await admin.patch(`/api/lists/${list.id}`, { shared: true });
  assert.equal((await guest.get(`/api/lists/${list.id}`)).status, 200);
  assert.equal((await guest.post(`/api/lists/${list.id}/items`, { itemId: ids.Alien })).status, 403);
  assert.equal((await kid.get(`/api/lists/${list.id}`)).status, 200, 'all kid-safe');
  await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Scary });
  assert.equal((await kid.get(`/api/lists/${list.id}`)).status, 404, 'one R16 film hides it');
  assert.ok(!(await kid.get('/api/lists')).data.some((l) => l.id === list.id));
  const home = (await admin.get('/api/home')).data;
  assert.ok(home.rows.find((r) => r.id === 'lists')?.items.some((c) => c.name === 'Friday'));
  ids.list = list.id;
});

test('a song playlist takes tracks only', async () => {
  const list = (await admin.post('/api/lists', { kind: 'music', name: 'Chill' })).data;
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.track1 })).status, 204);
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Alien })).status, 400);
});

test('playing a video list: next comes from the list and skips what the viewer can\'t see', async () => {
  const s = (await admin.post('/api/playback/start', { itemId: ids.E1, listId: ids.list, caps: {} })).data;
  assert.equal(s.next.title, 'E2');
  const s2 = (await admin.post('/api/playback/start', { itemId: ids.E2, listId: ids.list, caps: {} })).data;
  assert.equal(s2.next.title, 'Cartoon');
  const n = (await admin.get(`/api/playback/next?list=${ids.list}&after=${ids.Cartoon}`)).data;
  assert.equal(n.next.title, 'Scary');
});

test('collections: the film\'s page, the list, admin edits, kids', async () => {
  const alien = (await admin.get(`/api/items/${ids.Alien}`)).data;
  assert.equal(alien.collection.name, 'Alien Collection');
  assert.deepEqual(alien.collection.items.map((i) => i.title), ['Alien', 'Aliens']);
  assert.ok(alien.similar.some((i) => i.title === 'Aliens'));
  const all = (await admin.get('/api/collections')).data;
  assert.equal(all.length, 1);
  const made = (await admin.post('/api/collections', { name: 'Family night', itemIds: [ids.Cartoon, ids.show] })).data;
  assert.equal((await admin.get('/api/collections')).data.length, 2);
  assert.equal((await kid.get('/api/collections')).data.length, 1, 'the Alien films are R16');
  assert.equal((await guest.post('/api/collections', { name: 'x' })).status, 403);
  await admin.patch(`/api/collections/${made.id}`, { name: 'Family films', itemIds: [ids.show, ids.Cartoon] });
  assert.deepEqual((await admin.get(`/api/collections/${made.id}`)).data.items.map((i) => i.title), ['Show', 'Cartoon']);
  assert.equal((await admin.del(`/api/collections/${all[0].id}`)).status, 400, 'TMDB ones can\'t be deleted');
  assert.equal((await admin.del(`/api/collections/${made.id}`)).status, 204);
});

test('Home: Because you watched rows after the library rows, kid-safe for kids', async () => {
  await admin.post('/api/progress', { itemId: ids.Alien, position: 30, duration: 100 }); // check the real progress route in api.test.js and use it
  const home = (await admin.get('/api/home')).data;
  const byw = home.rows.filter((r) => r.id.startsWith('picks-'));
  assert.equal(byw[0].title, 'Because you watched Alien');
  assert.ok(byw[0].items.some((i) => i.title === 'Aliens'));
  const idx = (id) => home.rows.findIndex((r) => r.id === id);
  assert.ok(idx('picks-' + ids.Alien) > idx(`recent-${ids.movies}`));
});
```

- [ ] **Step 2: Run** — Expected: 404s and undefineds everywhere.

- [ ] **Step 3: Write `src/api/lists.js`**

```js
// Playlists, the Watchlist and collections.
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';

export function registerListRoutes(r, core) {
  const { lists, collections, picks, library, images } = core;
  const own = (ctx, id) => {
    const list = lists.get(id);
    if (!list || !lists.visibleTo(list, ctx.viewer)) throw new HttpError(404, 'No such list');
    if (list.profile_id !== ctx.profile.id) throw new HttpError(403, "Only the profile that made this playlist can change it.");
    return list;
  };
  const visible = (ctx, id) => {
    const list = lists.get(id);
    if (!list || !lists.visibleTo(list, ctx.viewer)) throw new HttpError(404, 'No such list');
    return list;
  };
  const shape = (list, ctx) => ({ id: list.id, kind: list.kind, name: list.name, shared: Boolean(list.shared), own: list.profile_id === ctx.profile.id, items: lists.items(list.id, ctx.viewer) });

  r.get('/api/lists', (ctx) => lists.forProfile(ctx.profile, ctx.viewer));
  r.post('/api/lists', async (ctx) => { const b = await ctx.body(); return shape(lists.create(ctx.profile.id, { kind: b.kind, name: b.name }), ctx); });
  r.get('/api/lists/:id', (ctx) => shape(visible(ctx, ctx.params.id), ctx));
  r.patch('/api/lists/:id', async (ctx) => {
    const list = own(ctx, ctx.params.id);
    const b = await ctx.body();
    if (b.name !== undefined) lists.rename(list.id, b.name);
    if (b.shared !== undefined) { if (ctx.profile.kids) throw new HttpError(403, 'Kids profiles can\'t share playlists.'); lists.setShared(list.id, Boolean(b.shared)); }
    return shape(lists.get(list.id), ctx);
  });
  r.delete('/api/lists/:id', (ctx) => { lists.remove(own(ctx, ctx.params.id).id); });
  r.post('/api/lists/:id/items', async (ctx) => {
    const list = own(ctx, ctx.params.id);
    const b = await ctx.body();
    if (b.seasonId) { if (list.kind !== 'video') throw new HttpError(400, 'Seasons go in video playlists.'); lists.addSeason(list.id, b.seasonId); return; }
    const item = library.get(Number(b.itemId));
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'No such title');
    if (!lists.add(list.id, item.id)) {
      if (lists.contains(ctx.profile.id, item.id).lists.includes(list.id)) return; // already there: fine
      throw new HttpError(400, list.kind === 'music' ? 'A song playlist takes songs.' : 'A video playlist takes films and episodes (add a season for a show).');
    }
  });
  r.delete('/api/lists/:id/items/:itemId', (ctx) => { lists.removeItem(own(ctx, ctx.params.id).id, ctx.params.itemId); });
  r.put('/api/lists/:id/items/:itemId/position', async (ctx) => { const b = await ctx.body(); lists.move(own(ctx, ctx.params.id).id, ctx.params.itemId, Number(b.position)); });

  r.put('/api/watchlist/:itemId', (ctx) => {
    const item = library.get(Number(ctx.params.itemId));
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'No such title');
    if (!['movie', 'show'].includes(item.kind)) throw new HttpError(400, 'The Watchlist takes films and shows.');
    lists.add(lists.watchlist(ctx.profile.id).id, item.id);
  });
  r.delete('/api/watchlist/:itemId', (ctx) => { lists.removeItem(lists.watchlist(ctx.profile.id).id, ctx.params.itemId); });

  r.get('/api/collections', (ctx) => collections.list(ctx.viewer, { includeHidden: ctx.user.role === 'admin' && ctx.url.searchParams.get('all') === '1' }));
  r.get('/api/collections/:id', (ctx) => { const c = collections.get(ctx.params.id, ctx.viewer); if (!c) throw new HttpError(404, 'No such collection'); return c; });
  r.get('/api/collections/:id/image/:type', async (ctx) => {
    const c = collections.row(ctx.params.id);
    const key = c?.[ctx.params.type === 'backdrop' ? 'backdrop' : 'poster'];
    if (!key) throw new HttpError(404, 'No image');
    return images.send(ctx, key); // use whatever /api/items/:id/image/:type does in src/api/library.js:318 — copy that helper
  }, { auth: 'none' });
  r.post('/api/collections', async (ctx) => collections.create(await ctx.body()), { auth: 'admin' });
  r.patch('/api/collections/:id', async (ctx) => collections.update(ctx.params.id, await ctx.body()), { auth: 'admin' });
  r.delete('/api/collections/:id', (ctx) => { collections.remove(ctx.params.id); }, { auth: 'admin' });

  r.get('/api/playback/next', (ctx) => {
    const list = visible(ctx, ctx.url.searchParams.get('list'));
    const next = lists.nextIn(list.id, ctx.url.searchParams.get('after'), ctx.viewer);
    return { next: next ? library.withProgress([next], ctx.viewer)[0] : null };
  });
}
```

Read `src/api/library.js:318` (`/api/items/:id/image/:type`) and reuse its exact image-serving code (the route options for the image route too — items' images are `auth: 'none'`?). Read `ctx.url` naming in `createContext`. Register in `src/app.js` after `registerExtrasRoutes`.

- [ ] **Step 4: `/api/items/:id` and `/api/home`** — in `src/api/library.js` inside the `/api/items/:id` handler, before `return out`, for movies and shows:

```js
    if (row.kind === 'movie' || row.kind === 'show') {
      out.collection = core.collections.forItem(row.id, viewer);
      const c = core.lists.contains(viewer.profileId, row.id);
      out.inWatchlist = c.watchlist;
      out.inLists = c.lists;
      out.similar = core.picks.similar(row.id, viewer);
    }
```

In `/api/home`, after the Continue watching row:

```js
    const wl = library.withProgress(core.lists.rows(core.lists.watchlist(viewer.profileId).id).filter((i) => library.canSee(viewer, i)).sort((a, b) => b.list_added_at - a.list_added_at), viewer);
    if (wl.length) rows.push({ id: 'watchlist', title: 'My Watchlist', style: 'poster', items: wl });
    const myLists = core.lists.forProfile(ctx.profile, viewer).filter((l) => l.kind !== 'watchlist' && l.count > 0);
    if (myLists.length) rows.push({ id: 'lists', title: 'Playlists', style: 'list', items: myLists });
```

and after the library rows, before the plugin rows: `for (const p of core.picks.becauseYouWatched(viewer)) rows.push({ id: `picks-${p.seed.id}`, title: `Because you watched ${p.seed.title}`, style: 'poster', seed: p.seed, items: p.items });`.

- [ ] **Step 5: Playback** — in `src/api/playback.js`'s start route: `const listId = body.listId ? Number(body.listId) : null;` and `const next = item.kind === 'track' ? null : listId && core.lists.visibleTo(core.lists.get(listId), ctx.viewer) ? core.lists.nextIn(listId, item.id, ctx.viewer) : library.nextEpisode(item);` and add `listId` to the returned object.

- [ ] **Step 6: Run** — `node --test test/lists-api.test.js` → 6 pass; `npm test` → 199. Also run `test/api.test.js` alone to be sure `/api/home`'s row order for existing rows is unchanged (it asserts on rows).
- [ ] **Step 7: Commit (ledger)** `Task 6: complete`

---

### Task 7: Client helpers, the title page, the music menus

**Files:**
- Create: `public/js/lists.js`
- Modify: `public/js/views/item.js` (the Watchlist button, the sheet entries, "Part of" and "More like this" rows, album/artist/song menus), `public/js/music.js` (track menu entry)
- Test: browser checks are in Task 10's `lists-ui.mjs`; this task's checks are the first section there (`title`), written first.

**Interfaces:**
- Produces (`public/js/lists.js`): `watchlistButton(item, initialIn)` → a button element that toggles via `PUT/DELETE /api/watchlist/:id` with the toasts; `addToPlaylistItems(item, { kind, seasonId })` → sheet items (`{ label: 'Add to playlist…', icon: 'plus', onSelect }`) that open a second sheet listing the profile's lists of `kind` plus "New playlist…" (uses `openDialog` with a name field), posting to `/api/lists/:id/items`; `listCard(list)` (Task 8 uses it).

- [ ] **Step 1: Write the failing browser checks** — create `/home/claude/devtools/lists-ui.mjs` with the shared header (copy the `open/signIn/check/failed/api` imports from `gate-ui.mjs`; sign in with `signIn(page)`) and a `title` section:

```js
if (run('title')) {
  await go(page, '#/item/4', '.detail-info'); // a show
  const btn = await page.$('.detail-info .watchlist-btn');
  check('a show page has a Watchlist button', Boolean(btn));
  await btn.click();
  await page.waitForSelector('.toast:has-text("Added to your Watchlist")');
  check('…which adds with a toast and turns into a tick', await page.evaluate(() => document.querySelector('.watchlist-btn').getAttribute('aria-pressed') === 'true'));
  await go(page, '#/', '.home-view');
  check('Home gains a My Watchlist row', (await page.$('.row[data-row="watchlist"]')) !== null);
  await go(page, '#/item/4', '.detail-info');
  await page.click('.detail-info .watchlist-btn');
  await page.waitForSelector('.toast:has-text("Removed from your Watchlist")');
  // Add to playlist… from the sheet, making a new one.
  await page.click('.detail-info [aria-haspopup="dialog"]');
  await page.click('dialog[open] .sheet-item:has-text("Add season to playlist")');
  await page.click('dialog[open] .sheet-item:has-text("New playlist")');
  await page.fill('dialog[open] input[name=name]', 'Friday');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast:has-text("Added to Friday")');
  const lists = await api(page, 'GET', '/api/lists');
  check('a new video playlist holds the season\'s episodes', lists.find((l) => l.name === 'Friday')?.count >= 2, JSON.stringify(lists));
  // A movie: Part of + More like this rows exist when the data does (the dev library may have none: the check reads the API first).
  const alien = await api(page, 'GET', '/api/items/1');
  await go(page, '#/item/1', '.detail-info');
  check('More like this shows when there are picks', Boolean(await page.$('.row[data-row="similar"]')) === Boolean(alien.similar?.length));
  check('Part of shows when the film is in a collection', Boolean(await page.$('.row[data-row="collection"]')) === Boolean(alien.collection));
}
```

Rows get `data-row` attributes: add `dataset: { row: id }` support to `row()` in `components.js` (an `id` option). Run: FAIL (no button).

- [ ] **Step 2: `public/js/lists.js`**

```js
// Client side of playlists and the Watchlist: the Watchlist button, the "Add to playlist…" sheets, list cards.
import { h, icon } from './dom.js';
import { api } from './api.js';
import { button, openSheet, openDialog, toast, field } from './components.js';

export function watchlistButton(item, initialIn) {
  let on = Boolean(initialIn);
  const el = button('', { icon: on ? 'check' : 'plus', variant: 'ghost', title: on ? 'In your Watchlist' : 'Add to Watchlist', attrs: { 'aria-pressed': String(on), 'aria-label': 'Watchlist' } });
  el.classList.add('watchlist-btn');
  el.addEventListener('click', async () => {
    try {
      if (on) await api.del(`/api/watchlist/${item.id}`);
      else await api.put(`/api/watchlist/${item.id}`, {});
      on = !on;
      el.setAttribute('aria-pressed', String(on));
      el.title = on ? 'In your Watchlist' : 'Add to Watchlist';
      el.replaceChildren(icon(on ? 'check' : 'plus', { size: 20 }));
      toast(on ? 'Added to your Watchlist' : 'Removed from your Watchlist');
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  });
  return el;
}

async function pickList(kind, onPick) {
  const lists = (await api.get('/api/lists')).filter((l) => l.own && l.kind === kind);
  openSheet('Add to playlist', [
    ...lists.map((l) => ({ label: l.name, icon: kind === 'music' ? 'music' : 'film', onSelect: () => onPick(l) })),
    { label: 'New playlist…', icon: 'plus', onSelect: () => newList(kind, onPick) },
  ]);
}
function newList(kind, onPick) {
  const name = h('input', { type: 'text', name: 'name', maxlength: '80', required: true, autocomplete: 'off', 'data-autofocus': true });
  openDialog({ title: 'New playlist', body: field('Name', name), actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'ok', primary: true }], onSubmit: async () => { const list = await api.post('/api/lists', { kind, name: name.value }); onPick(list); } });
}
/** Sheet entries for a title. `what` is { itemId } or { seasonId }; label says which. */
export function addToPlaylistItems(what, { kind = 'video', label = 'Add to playlist…' } = {}) {
  return { label, icon: 'plus', onSelect: () => pickList(kind, async (list) => { try { await api.post(`/api/lists/${list.id}/items`, what); toast(`Added to ${list.name}`); } catch (err) { toast(err.message, { type: 'error' }); } }) };
}
/** A playlist card for a Home row or the Lists page: the name over a 2 × 2 mosaic of its first posters. */
export function listCard(list) {
  return h('a', { class: 'card card-list', href: `#/lists/${list.id}`, dataset: { id: list.id } },
    h('div', { class: 'card-art list-mosaic' }, [0, 1, 2, 3].map((i) => (list.posters[i] ? h('img', { src: list.posters[i], alt: '', loading: 'lazy' }) : h('span', { class: 'list-blank' })))),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, list.name), h('span', { class: 'card-sub' }, `${list.count} ${list.kind === 'music' ? (list.count === 1 ? 'song' : 'songs') : list.count === 1 ? 'title' : 'titles'}${list.own ? '' : ` · ${list.ownerName}`}`)));
}
```

Check `api.del`/`api.put` exist in `public/js/api.js` (grep exports); check `openDialog`'s `onSubmit` and `actions` shapes at `components.js:330`; check `field()`'s signature. Icons `plus`, `check`, `music`, `film` exist in `dom.js`'s icon set (grep `plus:`).

- [ ] **Step 3: The title page** — in `item.js` `render()`: after the Play button(s) and before `watchedButton`, for `movie`/`show`: `actions.push(watchlistButton(item, data.inWatchlist));`. In `moreItems(item, markers, data)` (pass `data` through) add first: for a movie `addToPlaylistItems({ itemId: item.id })`; for a show, `addToPlaylistItems({ seasonId: selectedSeasonId() }, { label: 'Add season to playlist…' })` where the current season id is read from the `season-tab[aria-selected="true"]` at select time; for an episode `addToPlaylistItems({ itemId: item.id })`. In the older (non-Orbit) layout the same entries go into the existing `adminMenu`-style buttons row as a `moreButton`. After the body sections, for movies and shows:

```js
  if (data.collection) body.append(row({ id: 'collection', title: `Part of ${data.collection.name}`, subtitle: `${data.collection.owned} of ${data.collection.total} in your library`, items: data.collection.items, style: 'poster', href: `#/collections/${data.collection.id}` }));
  if (data.similar?.length) body.append(row({ id: 'similar', title: 'More like this', items: data.similar, style: 'poster' }));
```

Add `id` and `subtitle` support to `row()` in `components.js` (`dataset: { row: id }`; a `p.row-subtitle` under the heading when given). For albums (`renderAlbum`) and artists add `addToPlaylistItems({ itemId: <each track> }, { kind: 'music' })` — an album's "Add to playlist…" posts each track in order (loop the tracks, then one toast); in `music.js`'s track menu (line ~751) add `addToPlaylistItems({ itemId: t.id }, { kind: 'music' })` after "Add to queue".

- [ ] **Step 4: Run** — `node /home/claude/devtools/lists-ui.mjs title` → all PASS. Then `orbit-ui.mjs detail` and `oldthemes-compare.mjs compare` (expect DIFF on pages that now have a Watchlist button or new rows — note which, they're re-baselined in Task 10; anything else differing is a bug).
- [ ] **Step 5: Commit (ledger)** `Task 7: complete`

---

### Task 8: The Lists page, a list page, a collection page; Home and library; playing a list

**Files:**
- Create: `public/js/views/lists.js`
- Modify: `public/js/app.js` (routes `#/lists`, `#/lists/:id`, `#/collections/:id`; the older layouts' `navLink('lists', …)`), `public/js/shell.js` (menu entry `lists` after the libraries, icon `list`), `public/js/views/home.js` (the `list` row style uses `listCard`), `public/js/components.js` (`row()` accepts `style: 'list'`), `public/js/views/library.js` (Collections toggle), `public/js/views/player.js` (`query.list` → `listId` in the start body; navigating to `next` keeps `?list=`), `public/js/music.js` if needed.
- Browser checks: `lists-ui.mjs` sections `lists`, `play`.

- [ ] **Step 1: Write the failing checks** (`lists` and `play` sections)

```js
if (run('lists')) {
  await go(page, '#/lists', '.lists-view');
  check('the Lists page has Watchlist, Playlists and Collections groups', (await page.$$('.lists-view h2')).length >= 2);
  const menu = await page.evaluate(() => Boolean(document.querySelector('.orbit-menu .nav-link[data-nav="lists"]')));
  check('the Orbit menu has a Lists entry', menu);
  await page.click('.card-list:has-text("Friday")');
  await page.waitForSelector('.list-view');
  const before = await page.$$eval('.list-view .list-item .card-title', (els) => els.map((e) => e.textContent));
  // Move the first item down with the remote: its "…" sheet.
  await page.focus('.list-view .list-item:first-child [aria-haspopup="dialog"]');
  await page.keyboard.press('Enter');
  await page.click('dialog[open] .sheet-item:has-text("Move down")');
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('.list-view');
  const after = await page.$$eval('.list-view .list-item .card-title', (els) => els.map((e) => e.textContent));
  check('Move down sticks after a reload', after[1] === before[0] && after[0] === before[1], `${before} → ${after}`);
  // Rename and share from the page's "…" sheet.
  await page.click('.list-view .list-head [aria-haspopup="dialog"]');
  await page.click('dialog[open] .sheet-item:has-text("Share with everyone")');
  await page.waitForSelector('.toast');
  check('sharing is a one-press switch', (await api(page, 'GET', '/api/lists')).find((l) => l.name === 'Friday').shared === true);
  // Collections view in the Movies library and a collection page.
  await go(page, '#/library/1', '.library-results');
  const toggle = await page.$('.toolbar :text("Collections")');
  check('the Movies library has a Collections toggle', Boolean(toggle));
  const cols = await api(page, 'GET', '/api/collections');
  if (cols.length) {
    await toggle.click();
    await page.waitForSelector('.collection-card');
    await page.click('.collection-card');
    await page.waitForSelector('.collection-view');
    check('a collection page lists its films in order with Play all', (await page.$('.collection-view .btn:has-text("Play all")')) !== null);
  } else check('a collection page (no collections in the dev library: skipped)', true);
}
if (run('play')) {
  const list = (await api(page, 'GET', '/api/lists')).find((l) => l.name === 'Friday');
  const full = await api(page, 'GET', `/api/lists/${list.id}`);
  await go(page, `#/play/${full.items[0].id}?list=${list.id}`, '.player video');
  await page.waitForFunction(() => document.querySelector('.player video')?.readyState >= 2, null, { timeout: 20000 });
  await page.evaluate(() => { const v = document.querySelector('.player video'); v.currentTime = Math.max(0, v.duration - 1); });
  await page.waitForSelector('.upnext:not([hidden])', { timeout: 15000 });
  check('Up next between list items names the next one in the list', (await page.textContent('.upnext')).includes(full.items[1].title));
  await page.click('.upnext .btn-primary');
  await page.waitForFunction((id) => location.hash.startsWith(`#/play/${id}`) && location.hash.includes('list='), full.items[1].id, { timeout: 10000 });
  check('…and playing it keeps the list', true);
  // A song playlist into the music player.
  const tracks = await api(page, 'GET', '/api/libraries/3/items?view=tracks'); // adjust to the real tracks route (see music-kbd.mjs)
  const ml = await api(page, 'POST', '/api/lists', { kind: 'music', name: `Songs ${Date.now() % 1000}` });
  for (const t of tracks.items.slice(0, 2)) await api(page, 'POST', `/api/lists/${ml.id}/items`, { itemId: t.id });
  await go(page, `#/lists/${ml.id}`, '.list-view');
  await page.click('.list-view .btn:has-text("Shuffle")');
  await page.waitForSelector('.mini:not([hidden])');
  const st = await page.evaluate(async () => { const { music } = await import('/js/music.js'); return { shuffle: music.queue.shuffle, n: music.queue.items?.length ?? music.queue.length }; });
  check('Shuffle on a song playlist starts the music player shuffled with all its songs', st.shuffle === true && st.n === 2, JSON.stringify(st));
  await page.evaluate(async () => (await import('/js/music.js')).music.stop());
  await api(page, 'DELETE', `/api/lists/${ml.id}`);
}
```

Read `music.js`'s `Queue` for the real property names before finalising the last check. Run → FAIL (no `.lists-view`).

- [ ] **Step 2: Routes and menu** — `app.js` routes: `{ pattern: /^\/lists$/, view: () => import('./views/lists.js'), nav: 'lists' }`, `{ pattern: /^\/lists\/(\d+)$/, keys: ['id'], view: () => import('./views/lists.js'), nav: 'lists' }`, `{ pattern: /^\/collections\/(\d+)$/, keys: ['id'], view: () => import('./views/lists.js') }`. `shell.js`: `entry('lists', '#/lists', 'Lists', 'list')` after the libraries (check `list` exists in `dom.js`'s icons; if not add a simple three-lines SVG named `list`). Older layouts: `navLink('lists', '#/lists', 'Lists', 'list')` after the libraries in `renderNav`.

- [ ] **Step 3: `public/js/views/lists.js`** — one module, three renders chosen by `params`:

```js
// Lists: the Lists page (Watchlist, playlists, collections), a list page (play, reorder with the remote,
// rename/share/delete), and a collection page (the films in order, Play all).
import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { state, navigate, setTitle, refreshView, isOrbit } from '../app.js';
import { button, moreButton, openSheet, openDialog, confirmDialog, toast, row, grid, art, spinner, emptyState, field, posterCard, landscapeCard, squareCard } from '../components.js';
import { listCard } from '../lists.js';
import { music } from '../music.js';
import { formatRuntime } from '../format.js';

export async function render(el, params) {
  if (params.id && /collections/.test(location.hash)) return renderCollection(el, params.id);
  if (params.id) return renderList(el, params.id);
  return renderLists(el);
}

async function renderLists(el) {
  setTitle('Lists');
  const [lists, collections] = await Promise.all([api.get('/api/lists'), api.get('/api/collections')]);
  const wl = lists.find((l) => l.kind === 'watchlist');
  const mine = lists.filter((l) => l.kind !== 'watchlist');
  el.classList.add('lists-view');
  el.append(h('header', { class: 'page-head' }, h('h1', {}, 'Lists')));
  const sec = (title, cards, empty) => h('section', { class: 'detail-section' }, h('h2', {}, title), cards.length ? h('div', { class: 'grid grid-poster', role: 'list' }, cards) : h('p', { class: 'muted' }, empty));
  el.append(sec('My Watchlist', wl && wl.count ? [listCard(wl)] : [], 'Press the plus on any film or show to keep it here.'));
  el.append(sec('Playlists', mine.map(listCard), 'Add to playlist… from any title\'s menu makes one.'));
  el.append(sec('Collections', collections.map(collectionCard), 'Film series turn up here as your films are matched.'));
}

function collectionCard(c) {
  return h('a', { class: 'card collection-card', href: `#/collections/${c.id}` }, h('div', { class: 'card-art' }, art(c.poster || c.firstPoster, c.name, { kind: 'poster' })), h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, c.name), h('span', { class: 'card-sub' }, `${c.owned} of ${c.total}`)));
}
export { collectionCard };

async function renderList(el, id) {
  const list = await api.get(`/api/lists/${id}`);
  setTitle(list.name);
  el.classList.add('list-view');
  const items = list.items;
  const total = items.reduce((s, i) => s + (i.duration || 0), 0);
  const firstUnwatched = items.find((i) => !i.progress?.watched) || items[0];
  const actions = [];
  if (items.length) {
    if (list.kind === 'music') {
      actions.push(button('Play', { icon: 'play', variant: 'primary', autofocus: true, onClick: () => music.playTracks(items, 0) }));
      actions.push(button('Shuffle', { icon: 'shuffle', onClick: () => music.playTracks(items, -1, { shuffle: true }) }));
    } else actions.push(button('Play', { icon: 'play', variant: 'primary', autofocus: true, href: `#/play/${firstUnwatched.id}?list=${list.id}` }));
  }
  if (list.own && list.kind !== 'watchlist') {
    actions.push(moreButton(list.name, [
      { label: 'Rename', icon: 'edit', onSelect: () => renameList(list) },
      { label: list.shared ? 'Keep to me' : 'Share with everyone', icon: list.shared ? 'lock' : 'people', onSelect: async () => { await api.patch(`/api/lists/${list.id}`, { shared: !list.shared }); toast(list.shared ? 'Kept to you' : 'Shared with everyone'); refreshView(); } },
      { label: 'Delete', icon: 'trash', onSelect: async () => { if (await confirmDialog('Delete this playlist?', `"${list.name}" will be gone for everyone.`, { confirm: 'Delete', danger: true })) { await api.del(`/api/lists/${list.id}`); navigate('#/lists', { replace: true }); } } },
    ]));
  }
  el.append(h('header', { class: 'page-head list-head' }, h('h1', {}, list.name), h('p', { class: 'muted' }, `${items.length} ${list.kind === 'music' ? 'songs' : 'titles'}${total ? ` · ${formatRuntime(total / 60)}` : ''}${list.own ? '' : ' · shared with you'}`), h('div', { class: 'actions' }, actions)));
  if (!items.length) { el.append(emptyState({ title: 'Nothing here yet', text: list.kind === 'watchlist' ? 'Press the plus on any film or show.' : 'Use Add to playlist… from a title\'s menu.' })); return; }
  const ul = h('ol', { class: 'list-items', role: 'list' });
  items.forEach((item, i) => {
    const card = item.kind === 'track' ? squareCard(item) : item.kind === 'episode' ? landscapeCard(item) : posterCard(item);
    const menu = list.own ? moreButton(item.title, [
      i > 0 ? { label: 'Move up', icon: 'up', onSelect: () => moveItem(list, item, i - 1) } : null,
      i < items.length - 1 ? { label: 'Move down', icon: 'down', onSelect: () => moveItem(list, item, i + 1) } : null,
      { label: 'Remove', icon: 'trash', onSelect: async () => { await api.del(`/api/lists/${list.id}/items/${item.id}`); refreshView(); } },
      { label: 'Go to title', icon: 'forward', href: `#/item/${item.kind === 'track' ? item.parentId : item.id}` },
    ]) : null;
    const li = h('li', { class: 'list-item', draggable: list.own ? 'true' : null, dataset: { id: item.id } }, h('span', { class: 'list-index' }, String(i + 1)), card, menu);
    ul.append(li);
  });
  if (list.own) dragToReorder(ul, list);
  el.append(ul);
}
async function moveItem(list, item, position) { await api.put(`/api/lists/${list.id}/items/${item.id}/position`, { position }); refreshView(); }
function renameList(list) {
  const name = h('input', { type: 'text', name: 'name', value: list.name, maxlength: '80', required: true, 'data-autofocus': true });
  openDialog({ title: 'Rename playlist', body: field('Name', name), actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', primary: true }], onSubmit: async () => { await api.patch(`/api/lists/${list.id}`, { name: name.value }); refreshView(); } });
}
function dragToReorder(ul, list) {
  let dragging = null;
  ul.addEventListener('dragstart', (e) => { dragging = e.target.closest('.list-item'); e.dataTransfer.effectAllowed = 'move'; });
  ul.addEventListener('dragover', (e) => { e.preventDefault(); const over = e.target.closest('.list-item'); if (!over || over === dragging) return; const r = over.getBoundingClientRect(); ul.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling); });
  ul.addEventListener('drop', async (e) => { e.preventDefault(); if (!dragging) return; const position = [...ul.children].indexOf(dragging); await api.put(`/api/lists/${list.id}/items/${dragging.dataset.id}/position`, { position }); dragging = null; refreshView(); });
}

async function renderCollection(el, id) {
  const c = await api.get(`/api/collections/${id}`);
  setTitle(c.name);
  el.classList.add('collection-view');
  const { setBackdrop } = await import('../backdrop.js'); // check the real export used by item.js and use that
  setBackdrop(c.backdrop || c.poster);
  const firstUnwatched = c.items.find((i) => !i.progress?.watched) || c.items[0];
  el.append(h('header', { class: 'page-head' }, h('h1', {}, c.name), h('p', { class: 'muted' }, `${c.owned} of ${c.total} in your library`), c.overview ? h('p', { class: 'overview' }, c.overview) : null, h('div', { class: 'actions' }, button('Play all', { icon: 'play', variant: 'primary', autofocus: true, href: `#/play/${firstUnwatched.kind === 'show' ? firstUnwatched.id : firstUnwatched.id}` }))));
  el.append(h('section', { class: 'detail-section' }, h('h2', { class: 'visually-hidden' }, 'Titles'), grid(c.items, { style: 'poster' })));
  if (c.missing.length) el.append(h('section', { class: 'detail-section' }, h('h2', {}, 'Not in your library'), h('ul', { class: 'missing-list muted', role: 'list' }, c.missing.map((m) => h('li', {}, `${m.title}${m.year ? ` (${m.year})` : ''}`)))));
}
```

"Play all" for a collection: playing a collection in order needs a list; the simplest honest behaviour is Play the first unwatched film (a show opens its page). Record as a plan decision: **collections play one film at a time; a temporary playlist is out of scope** — update the spec's "Play all (in order, from the first unwatched)" to "Play (the first unwatched film)" and note it in the final message. Check every helper import exists (`formatRuntime` location, `setBackdrop` export, icons `up`/`down`/`lock`/`people`/`trash`/`shuffle`, `emptyState`, `confirmDialog`) with grep and substitute the real names.

- [ ] **Step 4: Home, library, player** — `components.js` `row()`: when `style === 'list'` render cards with `listCard`. `library.js`: for `movies` libraries add a `Collections` toggle button (class `btn-ghost`, `aria-pressed`) to the toolbar; when on, replace the grid with `collectionCard`s from `/api/collections` (filtered to those with a member in this library: the API's summaries include `libraryIds`? — add `libraryIds` to `collections.list()` summaries: the distinct `library_id`s of visible members) and keep it in the query string (`view=collections`). `player.js`: read `query.list`, send `listId` in the start body, and when navigating to `session.next` (line ~706 and the Up next "Play" button) append `?list=${listId}` when set.

- [ ] **Step 5: Run** — `lists-ui.mjs lists play` → PASS; `orbit-ui.mjs` full (158 → the shell section counts menu entries? re-check any count-based assertion: the menu has one more entry; fix the expected count); `gate-ui.mjs` unaffected.
- [ ] **Step 6: Commit (ledger)** `Task 8: complete`

---

### Task 9: Settings → Libraries → Collections (admins)

**Files:**
- Modify: `public/js/views/settings.js` (`librariesTab`: a Collections panel), browser check `lists-ui.mjs` section `admin`.

- [ ] **Step 1: The check**

```js
if (run('admin')) {
  await go(page, '#/settings/libraries', '.panel');
  await page.click('.panel:has(h2:has-text("Collections")) .btn:has-text("New collection")');
  await page.fill('dialog[open] input[name=name]', 'Family night');
  await page.fill('dialog[open] input[type=search]', 'Demo');
  await page.waitForSelector('dialog[open] .pick-results button');
  await page.click('dialog[open] .pick-results button');
  await page.click('dialog[open] button:has-text("Save")');
  await page.waitForSelector('.toast');
  const cols = await api(page, 'GET', '/api/collections?all=1');
  const made = cols.find((c) => c.name === 'Family night');
  check('an admin can make a collection from the library', Boolean(made) && made.manual);
  await api(page, 'DELETE', `/api/collections/${made.id}`);
}
```

- [ ] **Step 2: The panel** — in `librariesTab` append a `panel` "Collections": a table of `/api/collections?all=1` rows (name, owned/total, TMDB or Hand-made, Hidden), each with Rename (TMDB and hand-made), Hide/Show (TMDB), Edit (hand-made: the same dialog as New), Delete (hand-made). "New collection" opens `openDialog` with: name, a `search` input that queries `/api/search?q=…` (read the search view for the real route; movies and shows only) into `.pick-results` buttons that append to a members list (`ol.pick-members` with Move up/down/Remove buttons), an artwork `select` of the members; Save posts `/api/collections` (or PATCH). Toast "Collection saved".
- [ ] **Step 3: Run** — `lists-ui.mjs admin` PASS.
- [ ] **Step 4: Commit (ledger)** `Task 9: complete`

---

### Task 10: Styles, the older themes, docs, version, full verification, delivery

**Files:**
- Modify: `public/css/app.css` (`.watchlist-btn`, `.card-list`/`.list-mosaic`, `.list-items`/`.list-item`/`.list-index`, `.row-subtitle`, `.collection-card`, `.missing-list`, `.pick-results`/`.pick-members`), `public/css/orbit.css` (list items as a vertical list with the remote ring; the Lists page grid sizes), `themes/orbit/theme.css` (glass for the list rows), `README.md`, `docs/ARCHITECTURE.md`, `package.json` (0.9.0); `devtools/oldthemes-compare.mjs` baselines; `devtools/mock-tmdb.mjs` (a collection for the dev library's "Another Film"/"HEVC Sample Movie" so the dev server shows a real Part of row).

- [ ] **Step 1: Styles** — write them, then run `lists-ui.mjs` fully and take pictures for Dallas (`/tmp/shots/lists/*.png`: a film page with the Watchlist button and the Part of / More like this rows, the Lists page, a list page, a collection page, Home with the new rows, on desktop 1917×992 and phone 390×844; build two contact sheets into `/mnt/user-data/outputs/orbit-progress/v090-*.png` and look at them).
- [ ] **Step 2: Older themes** — `node devtools/oldthemes-compare.mjs compare`; pages that differ only where the spec adds content (the Watchlist button, the new rows, the Lists nav link) are re-baselined with `save` after eyeballing the diff pictures; anything else is a defect.
- [ ] **Step 3: Docs and version** — README feature list (three bullets: collections and film series, playlists and the Watchlist, "Because you watched"), ARCHITECTURE (the three stores, migration 9, the enrich pass, the Home rows), `package.json` 0.9.0.
- [ ] **Step 4: Full verification** — `npm test` (expect 199+), `lists-ui.mjs` ×2 clean, `orbit-ui.mjs` (158 or the adjusted count), `orbit-sizes.mjs` 79, `orbit-a11y.mjs` 53 (add a contrast check for `.list-item .card-title` and the Watchlist button's ring), `gate-ui.mjs` 60, `oldthemes-compare.mjs compare` → all pages match, and the older suites `extras-ui`, `rebrand-ui`, `music-kbd`, `profiles-ui`, `dialogs`.
- [ ] **Step 5: Delivery** — hash the PC copies against the pre-task snapshot; commit all changed and new files to `D:\Nodeflix`; `npm test` on the PC; update the project note (`claude/build-status.md`: Round 11 / v0.9.0 / what to check with the real library: the enrich pass's log line, a real film series appearing under "Part of", the picks rows after watching something).
- [ ] **Step 6: Commit (ledger)** `Task 10: complete`; then the final whole-branch review (a fresh reviewer; the plan's Review Focus verbatim) and its fix pass.
