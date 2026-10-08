# Atomix: collections, playlists, Watchlist and picks (v0.9.0)

Design, 1 October 2026. Approved by Dallas in conversation; this document is the record.

## What this is

Four things a streaming service has that a library of files doesn't:

1. **Collections**: film series from TMDB (Alien, Harry Potter…) for free, plus hand-made ones an admin builds from films and shows.
2. **Playlists**: per profile, video ones (films and episodes, played through in order) and song ones (played by the music player), each shareable to the household.
3. **A Watchlist** per profile: one button on any film or show, one row on Home.
4. **Picks**: up to two "Because you watched…" rows on Home and a "More like this" row on title pages, scored from your own library. Nothing leaves the server.

Dallas chose: playlists owned per profile and flippable to "everyone"; video and song playlists kept separate; collections both automatic and hand-made; two picks rows.

## Words used here

- **Viewer**: the profile making the request, with its kids/age limits and library access (`src/library/queries.js`'s viewer).
- **Kid-safe**: passes the viewer's age rule as `library.canSee` decides today.
- **A list**: a row in `lists` — a Watchlist (one per profile, made on demand), a video playlist or a song playlist.
- **A collection**: a row in `collections` — from TMDB (`tmdb_id` set) or hand-made (`manual = 1`).

## 1. Data (migration 9, `src/db.js`)

```
ALTER TABLE items ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';   -- ["space", "android", …]
ALTER TABLE items ADD COLUMN people TEXT NOT NULL DEFAULT '[]';     -- [{ "name": "Ridley Scott", "role": "director" }, { "name": "Sigourney Weaver", "role": "cast" }, …] (director first, then the top 8 cast)
CREATE TABLE collections (
  id INTEGER PRIMARY KEY, tmdb_id INTEGER UNIQUE, name TEXT NOT NULL, overview TEXT, poster TEXT, backdrop TEXT,
  manual INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE collection_items (collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, position INTEGER NOT NULL, PRIMARY KEY (collection_id, item_id));
CREATE TABLE lists (id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('watchlist','video','music')), name TEXT NOT NULL, shared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX lists_watchlist ON lists(profile_id) WHERE kind = 'watchlist';
CREATE TABLE list_items (list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, position INTEGER NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (list_id, item_id));
```

- **Metadata** (`src/library/metadata.js`): movies fetch `append_to_response=release_dates,images,keywords,credits`; shows `external_ids,content_ratings,images,keywords,aggregate_credits`. Stored: `keywords` (names, lower-cased, at most 30), `people` (director(s) from `crew` where `job = 'Director'`, then the first 8 of `cast` by `order`; shows use `aggregate_credits.cast` and `created_by` as "creator"). A movie's `belongs_to_collection` upserts a `collections` row (name, overview, poster, backdrop from TMDB; `/collection/{id}` is fetched once for the artwork and the release order) and a `collection_items` row with `position` = index in TMDB's `parts` by release date; parts not in the library are not stored. A refresh of a title (Fix match, Refresh metadata) re-does all of this; unmatching removes the title from its TMDB collection.
- **Catch-up**: a new background job kind `enrich` in `src/tasks.js` (lowest priority, after previews and intros) runs once per matched movie/show whose `keywords` is `'[]'` and `people` is `'[]'` and `tmdb_id` is set, fetching only what §1 adds (no artwork). It is queued for all such titles when the server starts after migration 9, and for new titles after each scan. It obeys the runner's rules (one at a time, waits while someone watches, retried from the dashboard). Without a TMDB key it does nothing and says so once in the log.

## 2. Server (`src/lists.js`, `src/collections.js`, `src/picks.js`, `src/api/lists.js`)

**Lists** (`core.lists`):
- `watchlist(profileId)` gets or creates the profile's Watchlist. `create(profileId, { kind, name })`, `rename`, `setShared`, `remove` (a Watchlist can't be removed), `add(listId, itemId)` (appends; a song list takes tracks only, a video list movies and episodes only, a Watchlist movies and shows only; adding a show to a video list adds nothing — the client offers "Add season" which adds its episodes in order), `removeItem`, `move(listId, itemId, position)`, `items(listId, viewer)` (in order, filtered by what the viewer can see, with progress), `forProfile(profileId, viewer)` (own lists plus shared ones from the same user's other profiles and from other users; a kids viewer gets a shared list only if every item is kid-safe), `contains(profileId, itemId)` → `{ watchlist: bool, lists: [ids] }`.
- Only the owning profile edits a list. Editing a shared list from another profile is refused (403) — "cross-profile editing" is out of scope.

**Collections** (`core.collections`):
- `upsertTmdb(...)` (from metadata), `create(admin, { name, itemIds })`, `update` (name, overview, hidden, itemIds in order, artwork by choosing a member's poster/backdrop or an upload later — this round: a member's), `remove` (hand-made only; TMDB ones can be hidden), `forItem(itemId)`, `list(viewer)` (collections with at least one visible member, with `owned` = visible member count and `total` = TMDB `parts` count when known), `get(id, viewer)`.

**Picks** (`core.picks`):
- `becauseYouWatched(viewer)`: the two most recently watched or in-progress titles (an episode counts as its show; the same show is one), each with up to 20 picks. `similar(itemId, viewer)`: up to 20 picks for a title page.
- Scoring, for every movie and show the viewer can see, not the seed, unwatched first (a title with any progress or watched = 1 scores but sorts after unwatched ones): same collection +5, each shared keyword +3, shared director/creator +3, each shared cast member +2, each shared genre +1, same decade +1. Keep scores ≥ 3, top 20 by score then rating. Cached in memory per profile id for 10 minutes; the cache is cleared when a scan finishes or a list changes.

**API** (all profile-scoped, kids-filtered like the rest of `/api`):
- `GET /api/lists` → the viewer's lists (`forProfile`) with counts and the first four posters; `POST /api/lists` `{ kind, name }`; `PATCH /api/lists/:id` `{ name?, shared? }`; `DELETE /api/lists/:id`.
- `GET /api/lists/:id` → the list with its items; `POST /api/lists/:id/items` `{ itemId }` or `{ seasonId }`; `DELETE /api/lists/:id/items/:itemId`; `PUT /api/lists/:id/items/:itemId/position` `{ position }`.
- `PUT /api/watchlist/:itemId` (add), `DELETE /api/watchlist/:itemId` (remove).
- `GET /api/collections`, `GET /api/collections/:id`; admin: `POST /api/collections`, `PATCH /api/collections/:id`, `DELETE /api/collections/:id`.
- `GET /api/items/:id` gains `collection` (`{ id, name, owned, total, items: [...] }` or null), `inWatchlist`, `inLists` (ids), and `similar` (picks).
- `GET /api/home` gains rows, in this order after Continue watching: `watchlist` ("My Watchlist", poster style, newest added first, only when non-empty), `lists` ("Playlists", a `list` card style: the list's name over a 2 × 2 mosaic of its first posters, only when there are any), then the library rows, then up to two `picks-<seedId>` rows ("Because you watched *Alien*", poster style), then plugin rows.
- `GET /api/playback/next?list=<id>&after=<itemId>` → the next playable item in a video list (skipping what the viewer can't see) or null; the existing next-episode logic stays for seasons.

## 3. The screens (Orbit first; the older themes get the same rows and pages in their own card style)

- **A film or show page**: a round **Watchlist** button (plus → tick) right after Play; the "…" sheet (`openSheet`) gains **Add to playlist…** which opens a second sheet listing the profile's video playlists plus **New playlist…** (a name prompt); for a show, the sheet also offers **Add season to playlist…**. New rows under the episodes/details: **Part of: <Collection>** (its films in order; the page's title is marked; "3 of 8 in your library" as the row's subtitle) and **More like this**.
- **An album, artist or song**: their menus gain **Add to playlist…** (song playlists; an album adds its tracks in order).
- **Home**: the rows in §2. The Watchlist row's cards keep their normal press (open the title); the Playlists row's cards open the list page.
- **Lists** (`#/lists`, a new Orbit menu entry with a list icon after the libraries; in the older themes a nav link): three groups — My Watchlist, Playlists (mine, then shared ones labelled with their owner's profile name), Collections. A list page (`#/lists/:id`): a header with the name, count and total runtime, **Play** (from the first unwatched item; a song list plays in the music player from the start), **Shuffle** (song lists), and the "…" sheet with **Rename**, **Share with everyone / Keep to me**, **Delete** (not for the Watchlist). Items as a vertical list (a landscape thumbnail for episodes, a poster for films, a square for songs); each item's "…" sheet: **Move up**, **Move down**, **Remove**, **Go to title**. A mouse can drag to reorder (HTML drag and drop, no library).
- **A collection page** (`#/collections/:id`): the backdrop and overview, the films in order with the ones you don't own greyed out at the end (title and year only, from TMDB's parts, when known), **Play all** (in order, from the first unwatched).
- **The Movies library**: the filter bar gains a **Collections** toggle that swaps the grid for collection cards (name, owned/total); pressing one opens the collection page.
- **Playing a video playlist**: `#/play/:id?list=<listId>`; the player asks `/api/playback/next?list=…` instead of the next episode when `list` is set, so the Up next card and auto-advance walk the list. A song playlist calls `music.playTracks(tracks, 0, { shuffle })` with the list's tracks.
- **Settings → Libraries → Collections** (admins): the hand-made collections with **New collection**: name, a search box that adds films and shows from the library, the members in order with move/remove, the artwork picked from a member, Save. TMDB collections appear in the same table with Rename and Hide only.
- **Kids**: no Lists entry for playlists that aren't kid-safe; a shared list is shown only when all its items pass; the Watchlist button and "Add to playlist…" are present (a kid can keep a watchlist), sharing is not offered to kids profiles.
- **Copy**: "Watchlist", "Add to playlist…", "New playlist…", "Because you watched", "More like this", "Part of", "Play all", "Shuffle", "Share with everyone", "Keep to me". Toasts: "Added to your Watchlist", "Removed from your Watchlist", "Added to <name>".

## 4. Testing

**Node (`node:test`):** `test/lists.test.js` (create/rename/share/remove, adding by kind rules, ordering and `move`, the Watchlist being one per profile, `forProfile` with shared lists and the kids rule, cross-profile edits refused), `test/collections.test.js` (upsert from TMDB, hand-made CRUD, hidden, `list` counts, `forItem`), `test/picks.test.js` (a fixture library of 12 titles with known keywords/people/genres: the scoring order is exact, unwatched first, the ≥ 3 threshold, kids filtering, the two seeds, the cache clearing on a list change), `test/api.test.js` additions (every route, 403 on another profile's list, `/api/items/:id` fields, the Home rows and their order, `/api/playback/next?list`), a migration-9 test on a copy of the fixture database, and a metadata test that a TMDB movie with `belongs_to_collection` (the mock TMDB server in `devtools/mock-tmdb.mjs` gains one) lands in `collections`.

**Browser (`/home/claude/devtools/lists-ui.mjs`, Playwright, cloud only):** the Watchlist button on a film (toggle, toast, the Home row appears/disappears), Add to playlist… from the sheet (new list, then an existing one), the Lists page with the remote (Enter opens, "…" sheet moves an item down and the order sticks after a reload), a video playlist playing through two items via Up next, a song playlist starting the music player with the right first track and shuffle on, the collection page and the Movies library's Collections view, the kids profile not seeing a non-kid-safe shared list, and no console errors; the older themes' pixel comparison (`oldthemes-compare.mjs`) is re-baselined only for the new rows and must otherwise match; `orbit-ui.mjs`, `orbit-sizes.mjs`, `orbit-a11y.mjs` and `gate-ui.mjs` still pass.

## Out of scope

Smart playlists (rules), M3U import/export, editing someone else's playlist, collections for music, uploading collection artwork, picks that use other people's viewing.

## Files

New: `src/lists.js`, `src/collections.js`, `src/picks.js`, `src/api/lists.js`, `public/js/views/lists.js` (the Lists page, a list page and a collection page), `public/js/lists.js` (client helpers: watchlist toggle, add-to-playlist sheet), `test/lists.test.js`, `test/collections.test.js`, `test/picks.test.js`, devtools `lists-ui.mjs`.

Modified: `src/db.js` (migration 9), `src/library/metadata.js`, `src/library/queries.js` (new columns in serialisation; collection/list lookups), `src/tasks.js` (`enrich`), `src/api/library.js` (home rows, item fields), `src/api/playback.js` (`next?list`), `src/api/serialize.js`, `src/app.js` (routes), `public/js/app.js` (routes for lists and collections), `public/js/shell.js` and the older layouts' nav (Lists entry), `public/js/views/item.js`, `public/js/views/library.js` (Collections view), `public/js/views/player.js` (list playback), `public/js/music.js` (playlist menus), `public/js/views/settings.js` (Collections panel), `public/js/components.js` (list card), `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css`, `devtools/mock-tmdb.mjs`, `docs/ARCHITECTURE.md`, `README.md`, `package.json` (0.9.0).
