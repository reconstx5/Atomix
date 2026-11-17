# The title page on Preact — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `public/js/views/item.js` becomes a Preact screen (`load()` + `Screen`) that draws films, shows, episodes,
albums and artists exactly as today, in every theme and size.

**Architecture:** Test data and behaviour checks come first and pass on the old page (they pin today's behaviour);
the "before" pictures are taken then. The page is then rebuilt in three slices (films/episodes, shows, music). Until a
slice moves, its kinds go through a hand-off that runs the older render into a detached element, the same hand-off
that books, podcasts and audiobooks keep for good.

**Tech Stack:** Preact 11 + htm via `public/js/ui.js`, `node:test`, Playwright (outside the repo) for devtools checks.

**Spec:** `docs/superpowers/specs/2026-11-17-atomix-title-page-preact-design.md`

## Global Constraints

- No `npm install`, no dependencies, no build step. Components import only from `public/js/ui.js` and `public/js/ui/`.
- Same elements, classes, attributes, text and focus order as today in every theme (orbit, arctic, arctic-side, midnight, daylight, harbour, obsidian), desktop and phone.
- Motion hooks stay: `header.detail-header[data-art="backdrop"|"poster"]`, `.detail-poster .art`, `.logo-box`/`.detail-title`, `data-rise` 0 (meta line), 1 (overview), 2 (actions), 3 (the body's first block).
- `setBackdrop()` is called in `load()` straight after the item arrives, before any season fetch.
- Anything outside the screen (listeners on `view`/`window`/`document`, classes on `view`) goes in `useLayoutEffect`.
- Dialogs stay function calls: `openDialog`, `openSheet`, `toast`, `openEditDetails`, `openRating`, `openCastPicker`.
- Kids: no "Save the file"/download link; admin-only actions only for admins and never for `item.remote`.
- Browser checks run only with `BASE=http://localhost:8797` (dev data in `%USERPROFILE%\atomix-devtools\dev\data`); every new or touched check refuses BASE unset or `:8787`. Run them from PowerShell, one at a time.
- User-facing text is unchanged.
- Work on branch `title-page-preact` from `main`. Commits authored by reconstx5 (repo config), **no Co-Authored-By or other trailer**. Nothing is pushed or merged without Dallas.

## Review Focus

- A title with no poster, backdrop or logo: placeholder art, `data-art="poster"`, the typed title, no errors.
- A logo that fails to load: the typed title stays visible (no `visually-hidden`), the box has no `has-logo`.
- Switching seasons quickly: the season picked last is the one shown, even when an earlier season's answer arrives later.
- A remote title (`item.remote`, from a connected server): no admin buttons, no download, no "Edit details".
- A show with no seasons, and a season with no episodes: "No episodes found." and no errors.

Each line has a check in Task 2 (`item-fn.mjs`), pinned against the old page and then the new one.

---

### Task 1: Test data, test users and the "before" pictures

**Files:**
- Create: `devtools/fixtures/items/*.json`, `devtools/item-fixtures.mjs`, `devtools/item-users.mjs`
- Modify: `devtools/compare.mjs` (BASE guard; item fixtures routed; more pages), `devtools/README.md`

**Interfaces:**
- Produces: `routeItems(page): Promise<void>` in `devtools/item-fixtures.mjs`. It answers `GET /api/items/:id` for ids 900001–900099 from `devtools/fixtures/items/<id>.json`, and leaves every other request alone.
- Produces: `FIXTURE_PAGES: string[]`, the hashes below, exported from the same module.
- Produces: `devtools/item-users.mjs`, which makes, if missing, a Kids profile "Kids" under `dallas` and a non-admin user `guest` / `atomix-dev-guest` with one profile. Running it twice changes nothing.

Fixture ids and contents. Each file is the JSON `/api/items/:id` returns, shaped from a real dev response (`/api/items/1`, `/api/items/9`) and `src/api/serialize.js`. Pictures use the dev library's own `/api/items/1/image/…` addresses.

| id | page |
|---|---|
| 900001 | a film: logo, tagline, genres, `media` (4K, Dolby Vision, Atmos, 7.1, subtitles), `subtitles`, `trailer` (remote), `extras` (2), `collection` (3 items, one `isCurrent`), `similar` (4), `inWatchlist: true` |
| 900002 | a film part-watched (`progress.position` 1800 of 6000): Resume, From the start, "… left" |
| 900003 | a film with no poster, backdrop or logo, and no overview |
| 900004 | a film whose logo address 404s (the route answers 404 for `/api/items/900004/image/logo`) |
| 900005 | a remote film (`remote: true`, `serverName`) |
| 900010 | a show with 3 seasons (900011 all watched, 900012, 900013) and `nextEpisode` in 900012 |
| 900011–900013 | those seasons (`item` + `episodes`, 3 each; 900012 holds one part-watched episode) |
| 900014 | a show with no seasons |
| 900015 | a show with one season, 900016, which has no episodes |
| 900020 | an episode with `markers.intro` (source `audio`) and `nextEpisode` |
| 900030 | an album with 2 discs (`tracks` with `season` 1 and 2), `artist` 900031 |
| 900031 | an artist with 2 `albums` and `tracks` |
| 900040 / 900041 / 900042 | a book, a podcast and an audiobook (only the fields their modules read) |

`FIXTURE_PAGES` = `#/item/900001`, `#/item/900002`, `#/item/900003`, `#/item/900004`, `#/item/900005`, `#/item/900010`, `#/item/900010?season=900013`, `#/item/900014`, `#/item/900015`, `#/item/900020`, `#/item/900030`, `#/item/900030?track=<a disc-2 track id>`, `#/item/900031`, `#/item/900040`, `#/item/900041`, `#/item/900042`.

- [ ] **Step 1: Create branch** `git checkout -b title-page-preact`
- [ ] **Step 2: Write the fixtures and `item-fixtures.mjs`.** Check by hand: `BASE=http://localhost:8797` with a page routed shows every fixture page with no page errors on today's `item.js` (a throwaway loop over `FIXTURE_PAGES` printing `pageerror`s). Expected: none. Fix a fixture whose shape the page rejects.
- [ ] **Step 3: Write `item-users.mjs`** (log in as `dallas`, `GET /api/profiles` and `/api/users`, `POST /api/profiles` with `{ name: 'Kids', kids: true }` and `POST /api/users` only when missing; field names from `src/api/account.js`). Run it twice. Expected: the second run prints "already there" for both.
- [ ] **Step 4: Update `compare.mjs`.** Refuse to run when `BASE` is unset or ends in `:8787` (the same message as `theme-check.mjs`). Call `routeItems(page)` after the `/api/home` route. Default `PAGES` = today's list plus `FIXTURE_PAGES`. Mask `.ends-at` in pictures (the clock moves).
- [ ] **Step 5: Capture the "before" pictures from today's page.**
  Run: `BASE=http://localhost:8797 node devtools/compare.mjs capture devtools/out/item-before`
  Expected: one `.html` + `.png` per page/theme/size, and empty `errors-*.txt` files.
- [ ] **Step 6: Commit** `git add devtools/ && git commit -m "Title page: test data, test users and before pictures for the Preact move"` (`devtools/out/` is gitignored).

### Task 2: Behaviour checks for the title page (`item-fn.mjs`), passing on today's page

**Files:**
- Create: `devtools/item-fn.mjs`
- Modify: `devtools/lib.mjs` (`open({ user })` logs in as `dallas` or `guest`; `selectProfile(context, name)`)

**Interfaces:**
- Consumes: `routeItems`, `FIXTURE_PAGES` (Task 1).
- Produces: `node devtools/item-fn.mjs [leg …]`, legs `focus seasons row actions redraw collection empty leaks`, exit 1 on any FAIL. Refuses BASE unset or `:8787`.

Checks (each one `check(name, ok, detail)`; Orbit unless named):
- `focus`: first focus is the Play/Resume button on 900001, 900002, 900020 and 900010 (Play S2E…); on 900030 the Play button; on `900030?track=` the given track's row, centred.
- `seasons`: on 900010, season 2 is selected; ArrowRight moves focus and selection to season 3 and the address becomes `?season=900013`; one tab stop (`tabindex="0"` count is 1); the panel's `aria-labelledby` names the selected tab. With season 900013's answer delayed by 800 ms, press Right then Left at once: the panel shows season 2's episodes after 1.5 s (Review Focus: newest wins).
- `row` (Orbit): the row opens at the part-watched episode; focusing another card changes `.episode-story` and the Episode details button's `href`.
- `actions`: the "…" sheet's labels on 900001 for `dallas` (Orbit and Midnight), `guest` and the Kids profile, written down from today's page and compared exactly; 900005 (remote) has no Refresh info, Fix match, Edit details or download (Review Focus).
- `redraw`: on 900001 (classic theme, Midnight) clicking Mark watched sends `POST /api/items/900001/watched` (answered by the route) and the page redraws keeping `scrollTop` within 2 px.
- `collection`: the current movie's card is a `div.is-current[tabindex="-1"][aria-current="true"]` with a "This movie" badge, and arrowing along the row skips it.
- `empty`: 900003 has `data-art="poster"` and the typed title; 900004's title is not `visually-hidden` and the box lacks `has-logo`; 900014 and 900015 show "No episodes found." (Review Focus).
- `leaks`: with `addEventListener`/`setTimeout`/`setInterval` wrapped by an init script, open 900010 and go Home 20 times; document and window listener counts and live timers after the 20th round equal those after the 1st.

- [ ] **Step 1: Write `item-fn.mjs` and the `lib.mjs` additions.**
- [ ] **Step 2: Run it on today's page.**
  Run: `BASE=http://localhost:8797 node devtools/item-fn.mjs`
  Expected: every check PASS, except the fast-season-switch check, which may FAIL on today's page (today's `selectSeason` has no guard). Record what it does in the commit message; the new page must pass it.
- [ ] **Step 3: Commit** `git commit -m "Title page: behaviour checks (item-fn) pinned on today's page"`

### Task 3: Title-page rules, test first

**Files:**
- Create: `public/js/item-rules.js`, `test/item-rules.test.js`

**Interfaces:**
- Produces (pure, no DOM, Node-importable):
  - `resumeInfo(item) → { position, left } | null`: `null` when there's no progress, it's watched, or `position < 30`; `left` = (progress.duration || item.duration) − position, at least 0, or `null` when there's no duration.
  - `selectedSeasonId(seasons, { query, nextEpisode }) → number | null`: `Number(query.season)` if it is one of `seasons`, else `nextEpisode.parentId`, else the first season with `season > 0`, else the first, else `null`.
  - `rowStartEpisode(episodes) → episode | undefined`: the first with `resumeInfo`, else the first not watched, else the first.
  - `introText(markers) → string`: "Intro not found yet" / "No intro" / "Intro 0:42–1:32 · found automatically" (sources: audio = "found automatically", chapter = "from chapters", manual = "set by hand").
  - `isWatched(item) → boolean`: shows: `unwatched === 0`; others: `Boolean(progress?.watched)`.

- [ ] **Step 1: Write the failing tests**, one per rule with the values above, including `selectedSeasonId` with a `query.season` that isn't one of the show's seasons (falls through to `nextEpisode`) and `resumeInfo` at 29 s (null) and 30 s (kept).
- [ ] **Step 2: Run** `node --test test/item-rules.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `public/js/item-rules.js`**, moving the logic out of `item.js` (`formatClock` from `dom.js` only if `dom.js` imports in Node; otherwise a local `m:ss` formatter giving the same text).
- [ ] **Step 4: Run** `node --test test/item-rules.test.js`. Expected: PASS. Point today's `item.js` at these functions and run `item-fn.mjs focus row empty`. Expected: unchanged results.
- [ ] **Step 5: Commit** `git commit -m "Title page: rules in item-rules.js with tests"`

### Task 4: Building blocks for the title page

**Files:**
- Create: `public/js/ui/detail.js`, `devtools/item-blocks.mjs`
- Modify: `public/js/ui/cards.js` (`Row` gains `card`)

**Interfaces:**
- Produces, in `public/js/ui/detail.js`:
  - `MediaChips({ item })`: as `mediaChips(item)` (null when it's null).
  - `DetailMeta({ item, ends, rise })`: as `metaLine(item)` plus a `span.ends-at` when `ends` is set; `rise` becomes `data-rise`.
  - `TitleArt({ logo, title })`: as `titleArt()`. The `img` is hidden until `load`, then the heading gets `visually-hidden` and the box gets `has-logo`; on `error` the img goes. Drawn with state, not by changing the elements by hand.
  - `Genres({ genres })`: `ul.genres[role=list] > li.chip`, or null.
  - `WatchlistButton({ item, initialIn })`: as `watchlistButton()`, including the busy guard, toasts and `aria-pressed`.
  - `DownloadButton({ item })`: as `downloadButton()` (null when `canDownloadHere()` is false; the label follows `downloads.events`, and the listener is removed on unmount). Export `canDownloadHere`/`stateLabel`/`manage` from `offline/ui.js` if needed.
  - `RatingControl({ item })`: an `Island` with `tag="div" class="my-rating"` whose `make` returns the children of `ratingControl(item)` (the heart button and the stars group). Same markup, and the older control keeps its listeners.
- Produces: `Row({ …, card })`, where `card(item, i)` returns a vnode or `undefined` (`undefined` means the normal card).
- Produces: `node devtools/item-blocks.mjs`, which draws each block and its older helper side by side on a loaded page for the fixture items and compares `outerHTML` (after `?v=` normalising). Exit 1 on any difference. Refuses BASE unset or `:8787`.

- [ ] **Step 1: Write `item-blocks.mjs`** for `MediaChips`, `DetailMeta`, `TitleArt` (before and after the logo loads), `Genres`, `WatchlistButton` (in and out), `DownloadButton`, `RatingControl` and `Row` with and without `card`.
- [ ] **Step 2: Run it.** Expected: FAIL (`ui/detail.js` missing).
- [ ] **Step 3: Implement `ui/detail.js` and the `Row` change.**
- [ ] **Step 4: Run** `BASE=http://localhost:8797 node devtools/item-blocks.mjs`. Expected: all PASS. Then `node --test test/theme-tokens.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Title page: Preact building blocks (chips, meta, logo box, watchlist, download, rating)"`

### Task 5: The screen, films and episodes, and the hand-off

**Files:**
- Modify: `public/js/views/item.js`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: `export async function load(params, query)` and `export function Screen({ params, query, data, view })`. `load` returns one of:
  - `{ redirect: true }`: it called `navigate(…, { replace: true })` (season → `#/item/<showId>?season=<id>`, track → `#/item/<albumId>?track=<id>`, podcast episode → `#/item/<showId>?episode=<id>`, chapter → `#/item/<parentId>`); `Screen` draws nothing.
  - `{ older: Node[] }`: book/comic/series → `book.js`, podcast → `podcast.js`, audiobook → `audiobook.js`. Also, until Tasks 6 and 7, show → the old show render and album/artist → the old music renders. The older render runs in `load()` into a detached `div`, awaited, and its child nodes are returned. `Screen` appends them to `view` in a `useLayoutEffect` and removes them in its cleanup.
  - `{ page: data }` for films and episodes (plus shows, albums and artists once moved): `setTitle(…)` and `setBackdrop(…)` already called with today's values.
- The action set: `moreItems(item, markers, extra)` stays the plain list it is (it builds sheet items, not DOM). `HeaderActions` draws, per theme: Orbit puts everything in `MoreButton`; classic themes show `MoreButton` with the rest, the inline download link (not for shows, Kids or remote) and the admin `Button`s Refresh info / Fix match, in today's order.
- `identifyDialog` and `introDialog` stay as they are (dialog bodies built with `h()` are allowed: they are dialogs).

- [ ] **Step 1: Rebuild films and episodes as components**: header (poster `Art` eager, `TitleArt`, eyebrow for episodes, `DetailMeta` with ends-at, `MediaChips`, `Genres`, tagline, overview or "No description yet.", time left, actions, `RatingControl` on Orbit, `IntroLine` for admins with markers) and body (Next episode `LandscapeCard`, `MediaDetails`, Extras `Row`, the collection `Row` with `card` drawing the current movie as `div.card.poster-card.is-current[tabindex=-1][aria-current=true]` plus `span.badge.badge-current` "This movie", More like this `Row`), with `data-rise` on the same elements as today. Remove the old film/episode DOM code.
- [ ] **Step 2: Implement `load()` and the hand-off** as in Interfaces. If an older module needs to be on the page while it renders (it reads `isConnected` or layout), note it and give that kind a plain fallback that renders into `view` in the layout effect.
- [ ] **Step 3: Run the checks.** Expected for each:
  - `BASE=http://localhost:8797 node devtools/item-fn.mjs`: all PASS that passed in Task 2.
  - `node devtools/compare.mjs capture devtools/out/item-after` then `node devtools/compare.mjs diff devtools/out/item-before devtools/out/item-after`: no MARKUP or PIXELS lines.

  Any difference is fixed, or written in the commit message with the reason it can't match.
- [ ] **Step 4: Commit** `git commit -m "Title page: Preact screen for films and episodes; older pages handed off"`

### Task 6: Shows — season tabs, episode list and Orbit's episode row

**Files:**
- Modify: `public/js/views/item.js` (or a new `public/js/views/item-show.js` if `item.js` passes about 450 lines)

**Interfaces:**
- Consumes: `selectedSeasonId`, `rowStartEpisode`, `resumeInfo` (Task 3).
- `load()` for a show also fetches the selected season (`/api/items/<seasonId>`) and returns it as `data.page.season`.
- Produces: `SeasonTabs({ show, seasons, selectedId, onSelect })`, `EpisodeList({ episodes })` (classic) and `EpisodeRow({ episodes })` (Orbit), all keyed by id.
- Season state lives in the show component: picking a season sets `?season=` with `history.replaceState`, shows `Spinner` in the panel, fetches, and ignores an answer that isn't for the season picked last. The season overview shows when it differs from the show's.
- `EpisodeRow` opens scrolled to `rowStartEpisode` (in a layout effect, as today's `reveal`), and the story and Episode details follow focus through `followFocus` from `backdrop.js`, whose cleanup runs on unmount.
- "Add season to playlist…" and "Download season" read the selected season from the component (no more `document.querySelector('.season-tab[aria-selected]')`).

- [ ] **Step 1: Implement**, and remove the show path from the hand-off.
- [ ] **Step 2: Run** `item-fn.mjs seasons row actions empty leaks`. Expected: all PASS, the fast-switch check included.
- [ ] **Step 3: Run** compare capture/diff on the show pages (`PAGES=#/item/900010,#/item/900010?season=900013,#/item/900014,#/item/900015,#/item/10`). Expected: no differences.
- [ ] **Step 4: Commit** `git commit -m "Title page: shows on Preact (season tabs, episode list, Orbit episode row)"`

### Task 7: Albums and artists

**Files:**
- Modify: `public/js/views/item.js` (or a new `public/js/views/item-music.js`)

**Interfaces:**
- Produces: `MusicHeader({ item, eyebrow, meta, actions, round })`, `AlbumPage({ data, query })`, `ArtistPage({ data })`.
- The album's songs are an `Island tag="section" class="detail-section"` whose `make` returns `[h2.visually-hidden "Songs", trackList(tracks, { showArtist: artist?.title || true, discs: true, focusId })]` or the "No songs found." paragraph, so the markup matches today's section. `?track=` centres that row after the first draw.
- Play / Shuffle / Add to queue are `Button`s calling `music.playTracks` / `music.addToQueue` exactly as today. The artist's albums are a `Grid style="square"`.

- [ ] **Step 1: Implement**, remove the music path from the hand-off and delete the last old-style render code in `item.js`. `grep -n "h('" public/js/views/item.js` should list only the two dialogs.
- [ ] **Step 2: Run** `item-fn.mjs focus actions` and compare capture/diff on `#/item/900030`, `#/item/900030?track=…` and `#/item/900031`. Expected: all PASS, no differences.
- [ ] **Step 3: Commit** `git commit -m "Title page: albums and artists on Preact"`

### Task 8: Whole-page verification and docs

**Files:**
- Modify: `CLAUDE.md` ("Preact screens": the title page done; next Guide/Recordings), `CONTRIBUTING.md` (one line naming `views/item.js` as a larger example, and `Row`'s `card`), `docs/HANDOFF-2026-11.md` (Next list)

- [ ] **Step 1: Full before/after.** Capture `devtools/out/item-after` again and diff it against `item-before`. Expected: no differences.
- [ ] **Step 2: Behaviour and motion checks, one at a time, each with `BASE=http://localhost:8797`:**
  - `item-fn.mjs`, `item-blocks.mjs`, `theme-check.mjs`, `focus-check.mjs`, `type-floor.mjs`: expected 0 FAIL.
  - `card-open.mjs` and `card-load.mjs`: expected the same failures as on `main` (run both on `main` first and keep the output).
- [ ] **Step 3: Node suite in groups.** Expected: no failures beyond the 15 known ones on `main` (tls-*, passover-*, vendor checksums and bare imports, dash-multi-drm `deviceKeySystems`), plus `api.test.js`, which fails only under load.
- [ ] **Step 4: Update the docs.**
- [ ] **Step 5: Commit** `git commit -m "Title page on Preact: checks pass; docs updated"`, then one fresh whole-branch review and one fix pass. Ask Dallas before any merge or push.
