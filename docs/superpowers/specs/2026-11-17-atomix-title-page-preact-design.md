# Atomix — the title page on Preact (design)

Date: 17 Nov 2026. Status: draft for Dallas's approval.

## Why

The title page (`public/js/views/item.js`, 605 lines) is the biggest screen still built with the older hand-made DOM
(`render(el, params, query)`). It is the next step in the Preact move planned in
`docs/superpowers/specs/2026-10-22-atomix-v026-preact-foundation-design.md` (round 1: Home, the title page and lists;
Home and Lists moved in v0.28). Moving it lets later work (the Jellyfin API, more title-page features) build on
components, and lets the older helpers it alone uses be retired.

## Goals

- `views/item.js` becomes a Preact screen (`load()` + `Screen`), following CONTRIBUTING.md "How to write an Atomix
  screen" and the way `views/home.js` moved.
- Everything it draws today moves: films, shows (season tabs, the episode list, Orbit's episode row), episodes,
  albums and artists (Dallas, 17 Nov: albums and artists move now, not with the music round).
- The page looks and behaves exactly as today in every theme and size: same elements, classes, attributes, text and
  focus order. The before/after pictures are the same.

## Non-goals

- No visual change, no new features, no new API routes or server changes.
- Book, comic, series, podcast and audiobook pages stay in their own older modules (`book.js`, `podcast.js`,
  `audiobook.js`; later rounds). The title page keeps forwarding to them.
- The dialogs (Fix match, intro editor, Edit details, rating, cast picker, sheets) stay plain function calls
  (`openDialog`, `openSheet`, …), as CONTRIBUTING.md says.
- The music engine's `trackList` stays engine code, hosted in an `Island`.

## Anti-goals (a failure even if it works)

- Any pixel or markup difference in a theme at rest (the older themes especially).
- The card-to-page morph, the rise-in of the first blocks, or Back's focus restore breaking or getting slower.
- First focus landing somewhere new (Play/Resume, or the right track for `?track=`), or a spinner flash where today
  the page arrives complete.
- Kids rules loosening (no "Save the file" for Kids), or admin-only actions showing for others.
- Leaked listeners or timers after leaving the page.

## Constraints

- No dependencies, no build step; Preact + htm through `public/js/ui.js` only.
- `refreshView()` re-runs the route (calls `load()` again and redraws), which is how Mark watched, Refresh info,
  Fix match and the intro editor update the page today; that keeps working.
- Anything outside the screen (listeners on `view`/`window`/`document`, classes on `view`) goes in `useLayoutEffect`.
- Motion hooks are part of the markup contract (`public/js/transitions.js`, `card-motion.js`, `backdrop.js`):
  `header.detail-header[data-art]`, `.detail-poster .art`, `.logo-box` / `.detail-title`, and the `data-rise` 0–3
  markers (meta line, overview, actions, the body's first block). `backdropReady()` must still see the page's
  `setBackdrop()` call as early as today.

## Approaches considered

1. **One screen, built from components (chosen).** `load()` fetches the item (and, for a show, the selected season)
   and handles the redirects; `Screen` picks a `TitlePage`, `AlbumPage` or `ArtistPage` component. Small components
   replace the DOM helpers the page uses. Meets the foundation spec's "done" bar (no hand-built DOM left except calls
   into engines and dialogs).
2. **A Preact shell around the old code** (an `Island` that calls the old `render`). Quick, but changes nothing real
   and fails the "done" bar. Rejected.
3. **Films/TV now, music later.** Smaller, but leaves `item.js` half old, half new until the music round. Rejected by
   Dallas on 17 Nov.

## The design

### Data (`load(params, query)`)

- Fetches `/api/items/:id`, sets the page title (as today, before the page is announced) and calls `setBackdrop()`
  straight away, before any season fetch, so `backdropReady()` sees it at least as early as today (my call).
- Redirects exactly as today, with `navigate(…, { replace: true })`: a season → its show `?season=`, a track → its
  album `?track=`, a podcast episode → its podcast `?episode=`, a chapter → its audiobook.
- A show: also fetches the selected season (`query.season`, else the next episode's season, else the first numbered
  season, else the first), so the page arrives complete as it does today (today's `render` awaits the first
  `selectSeason`).
- Book, comic, series, podcast and audiobook: the page is handed to the older module unchanged (see "Older pages").

### Components (new, in `public/js/ui/` where shared, else in `item.js`)

Each draws exactly what its older helper draws for the same inputs (the v0.26 rule for building blocks):

- `MediaChips` (`mediaChips`), `TitleArt` (the logo box: typed title until the logo loads, kept if it fails),
  the detail `MetaLine` with the "ends at" span (`metaLine` + `endsAt`; the spotlight's `MetaLine` is reused if it
  draws the same), `Genres`, `MediaDetails`, `IntroLine`.
- `WatchlistButton`, `DownloadButton`, `RatingControl`: components if small; otherwise the existing helpers
  (`watchlistButton`, `downloadButton`, `ratingControl`) in an `Island`, noted as such.
- `SeasonTabs` + season panel: state in the component; Left/Right between tabs, one tab stop, `aria-selected`,
  `aria-controls`/`aria-labelledby`, `history.replaceState` of `?season=`, a spinner while a later season loads,
  the season overview when it differs from the show's.
- `EpisodeList` (classic) and `EpisodeRow` (Orbit: wide cards, the story and Episode details button following focus
  through `followFocus`, the row opened at the resume/first-unwatched episode), keyed by episode id.
- The collection row with the current movie as a non-link `is-current` card and its "This movie" badge, the extras
  and "More like this" rows, "Next episode" — from `Row`/`LandscapeCard`.
- The action set (`moreItems`, `headerMore`, `adminMenu`) keeps one source of truth: the same list, the same order,
  Orbit folding everything into "…" and the classic layouts showing Refresh info / Fix match / the download inline.
- Music: `AlbumPage` and `ArtistPage` share a `MusicHeader`; the album's songs are `trackList` in an `Island`
  (`?track=` focuses and centres that track as today); the artist's albums are a `Grid` of square cards.

### Older pages (book, podcast, audiobook)

These modules export `render(el, params, query, data)`. The title page keeps forwarding to them; the builder picks the
least surprising way that keeps first focus and the page announcement right (for example `load()` renders the older
page into a fresh element before returning, and the screen adopts it). Their pages must look and behave as today.

### What is removed

The old `render` and every hand-built DOM path in `item.js`. Helpers in `components.js`, `lists.js`, `rating.js` and
`offline/ui.js` that other screens still use stay.

## Verification

All browser checks run against the dev server on http://localhost:8797 with the dev data in
`%USERPROFILE%\atomix-devtools\dev\data`, never against :8787 (Dallas's live server). The "before" captures are taken
from `main` before any change.

**Test data (Dallas, 17 Nov: made-up data, not his library).** The dev library only has 8 plain films and a
one-season show, so:
- `compare.mjs` and `item-fn.mjs` answer `/api/items/:id` (and the season requests) from JSON fixtures in
  `devtools/fixtures/items/` through `page.route`, the way `compare.mjs` already rewrites `/api/home`. Fixtures cover:
  a film with logo, trailer, extras, a collection (current movie inside it), "More like this", media details and
  subtitles; a film in progress (Resume); a show with three seasons (one all watched) and a next episode; an episode
  with intro markers (admin line); an album with two discs; an artist with albums; a book, a podcast and an
  audiobook hand-off. Each fixture's shape is taken from what the real API returns (`src/api/` serialisers), so the
  page sees realistic data. Artwork addresses point at the dev library's existing pictures.
- The dev database (already a throwaway copy) gets a Kids profile and a non-admin user, so the "…" sheet and the
  admin-only parts are checked for admin, non-admin and Kids.
- Clicks that change data (Mark watched, Refresh info) are checked against the fixtures by watching the request
  that goes out and the redraw that follows; nothing touches real data.

- **Test first**, as the project works: Node tests for any pure logic pulled out (the selected-season rule, the action
  list per kind/theme/admin/Kids, the episode the row opens at), written failing first.
- **Markup and pixels:** `devtools/compare.mjs` before/after on `#/item/1`, `#/item/9`, `#/item/10` (real dev data)
  plus every fixture page above (an album also with `?track=`), every theme, desktop and phone: no differences (or
  each one ruled on and explained).
- **Behaviour:** a new `devtools/item-fn.mjs` (like `home-fn.mjs`/`lists-fn.mjs`): first focus per kind; season tabs by
  keyboard and click (address, spinner, focus); Orbit episode row story follows focus; Mark watched / Refresh info
  redraw in place keeping scroll; the "…" sheet's items per theme, admin and Kids; the collection's current card is
  not a stop; entering and leaving 20 times leaves no extra listeners or timers.
- **Motion:** `card-open.mjs` and `card-load.mjs` give the same results as on `main` before the move (both have known
  failures on main today; no new ones); `theme-check.mjs`, `focus-check.mjs`, `type-floor.mjs` still pass.
- Full Node suite in groups: no new failures.
- One fresh review and one fix pass.

## Left to the builder

- File layout (one `item.js` or `item.js` plus `item-show.js` / `item-music.js`), component names, which helpers
  become components vs `Island`s.
- How the older-page hand-off is done (above), and how `load()`'s redirects interact with the router (check
  `app.js`'s render token so a redirect doesn't draw a half page).
- Extra before/after pages for coverage.
