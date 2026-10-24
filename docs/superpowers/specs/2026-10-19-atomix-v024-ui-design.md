# Atomix Round 26 — v0.24.0: UI upgrades (faster artwork, a clearer menu, search that helps)

Approved in conversation with Dallas, 19 Oct 2026: approach 1, then "looks good" to each of the three sections.

## Intent

Dallas asked for "some ui upgrades/updates", and then for research on other UIs and UI optimisations. The research covered:
- TV / 10-foot design guidance (Smashing Magazine 2025; Amazon Fire TV guidelines);
- the reaction to Netflix's 2024–25 TV redesign;
- the streaming-app UX critique in Fast Company;
- Infuse vs Plex;
- 2026 web-performance guidance.

It was set against a measured audit of Orbit on the dev server. From the findings he picked three areas: **faster artwork**, **a clearer menu** and **search that helps**. He left out "TV-sized Orbit" for this round.

Success:
- Orbit downloads artwork at the size it is shown.
- Every menu entry is told apart at a glance, and Search and Settings are always reachable.
- On a remote, a search mostly needs a few presses: recent searches, suggestions from the first letter, and genre and library tiles.

Audit facts this design answers (Orbit, dev server):
- On Home, 21 of 37 images are at least 1.5× the size they are shown (a 1280-px backdrop on a 400-px phone; 600-px posters in 196-px cards).
- The menu has 15 entries. Audiobooks, Books and Comics share one icon, and Recordings and TV Shows share another. Search, Add-ons and Settings are below the fold at 1080p.
- The phone's dock scrolls sideways with icons cut off, and its profile pill sits over row headings.
- Search starts empty ("Type at least two letters"), the expensive case on a remote (about 38 presses for "hey there").

## Global constraints

- Node ≥ 22.13, `node:sqlite`, ffmpeg; plain ES-module browser JS with no build step; **no dependencies**; no Kodi GPL code, no copied icons (all new icons drawn for Atomix).
- Older themes stay pixel-identical: `node /home/claude/devtools/oldthemes-compare.mjs compare` → "all pages match". The new artwork sizes, icons, menu layout and search page are Orbit's; older themes keep theirs.
- Kids profiles never see admin data, nor any title outside their rules (age rating, allow-unrated, libraries). This covers suggestions, people, genre tiles, library tiles and recent searches.
- Every new control works with a remote (D-pad, Select, Back), a mouse, touch and a screen reader.

## 1. Faster artwork (approach 1: copies made on request and kept)

- **Sized addresses.** Picture addresses accept a width: `/api/items/:id/image/:type?v=…&w=300`.
  - The width snaps up to the nearest size on a fixed list:
    - posters and square art: 200, 300, 450, 600;
    - backdrops and stills: 480, 960, 1280, 1920;
    - logos: 400, 800.
  - A copy is never larger than its original. Asking for a width at or above the original sends the original.
- **Making a copy.**
  - ffmpeg scales the original once.
  - The format is WebP when the request accepts `image/webp` and ffmpeg has `libwebp`, else JPEG. Logos keep transparency (WebP with alpha, else PNG).
  - Copies live in `cacheDir/thumbs/`, named from the original's reference, its size and mtime, the width and the format, so a changed original makes a new copy.
  - At most 2 resizes run at once, and requests for the same copy share one job.
  - If a copy isn't ready within about 1.5 s, that request is sent the original and the copy finishes for next time.
  - A copy that can't be made (ffmpeg missing, a broken picture) falls back to the original, and the failure is remembered for an hour.
- **What it covers.** Everything `sendArtwork` serves:
  - local and cached artwork;
  - connected servers' cached pictures;
  - book, comic and audiobook covers;
  - collection and list pictures served the same way.

  The music apps' cover requests (`getCoverArt` `size`) use the same copies. Pictures that are only links to other sites (redirects) are left as they are.
- **The cache.**
  - A daily sweep removes copies whose original is gone.
  - A size limit (2 GB by default, `thumbCacheMB` in Settings → Server) removes the least recently used copies first.
  - Removing a title removes its copies.
- **Browser caching.** Artwork addresses carry a version (`?v=`), so responses use `private, max-age=31536000, immutable`.
- **Orbit's cards.**
  - Poster, square, landscape, hero and logo images carry `srcset` (the sizes above) and a `sizes` matching the card's shown width at each layout.
  - The hero backdrop and the first row's first cards load first: eager, with `fetchpriority="high"` on the hero. Everything else stays lazy with `decoding="async"` and its reserved size.
- **Older themes.** They keep the full-size originals (the browser's downscale and ffmpeg's differ slightly, so the pixel-identical rule holds).
- **Scripts fetched early.** The server adds `<link rel="modulepreload">` for the core module graph to the page it serves (worked out from `app.js`'s static imports at start-up), and each view's imports when that view is opened. This cuts round trips on a VPS.
- **Measured afterwards.**
  - On Orbit's Home, library, title and search pages, no image is decoded at more than 1.5× its shown size times the device pixel ratio (unless the original is smaller).
  - Home's picture download on a phone is checked with real-size artwork (1280-px backdrops, 500–600-px posters) and reported before and after.

## 2. A clearer menu (Orbit)

- **Icons.** New icons, in the same line style as Orbit's:
  - Audiobooks: headphones over a book.
  - Books: an open book.
  - Comics: a speech bubble.
  - Podcasts: a microphone.
  - TV Shows: a TV.
  - Recordings: a TV with a record dot. This is the TV library over the Live TV recordings folder.
  - Live TV: a broadcast mast.
  - Movies, Music, Lists, Downloads and Add-ons keep theirs.

  Two libraries of the same kind share an icon; their names show when the menu opens, as now.
- **Pinned Search and Settings.**
  - Search and Settings sit at the bottom of the rail below a divider, always on screen at 1080p and 720p.
  - The entries above them scroll, and the remote keeps the focused one in view.
  - Up from the pinned group goes into the list, and Down from the list's end goes into the pinned group.
- **The phone's dock.**
  - It holds Home, Search, the first three libraries in menu order, and **More**. More opens a panel with every entry: all libraries, Lists, Live TV, Downloads, Add-ons and Settings.
  - The panel is a dialog: focus moves into it, and Back or Escape closes it.
  - The dock never scrolls sideways; it fits a 360-px screen.
- **The phone's profile pill.** It slides away while scrolling down and returns on any scroll up (and at the top of the page). The cast and settings buttons beside it go with it.
- **Accessibility.** Every entry keeps its accessible name and the current-page marker. Reduced motion shows and hides the pill without sliding.

## 3. Search that helps

- **Recent searches (migration 29).**
  - A `search_history` table holds up to 10 per profile, newest first, with exact repeats moved to the top. Kids profiles have their own list.
  - A search is remembered when the person presses Enter or opens a result, not on every letter.
  - The API, for the signed-in profile:
    - `GET /api/search/recent`;
    - `DELETE /api/search/recent/:id`;
    - `DELETE /api/search/recent` to clear all.
  - Deleting a profile deletes its list.
- **Before typing (Orbit's search page).**
  - Recent searches, each one opening that search, with a remove button and Clear.
  - Up to 12 genre tiles: the genres of the films and shows this viewer can see, most common first. A tile opens a genre page of films and shows across the viewer's film and TV libraries.
  - A tile for each library the viewer can see.
- **Suggestions as you type (from the first letter).**
  - `GET /api/search/suggest?q=` returns up to 8 entries across films, shows, artists, albums, podcasts, audiobooks, books, comics and people. Each entry is `{ kind, id?, title, subtitle, poster? }`.
  - Ranking: a title that starts with the query, then one where a word starts with it, then one that contains it. Shorter titles win ties.
  - Debounced (about 150 ms); a request is abandoned when typing continues.
  - Down from the box enters the suggestions; Select opens one; Back returns to the box.
- **Matching (every theme, the full results and the music apps' search too).**
  - Accents, case, punctuation and a leading "the" are ignored: "amelie" finds *Amélie*, and "spiderman" finds *Spider-Man*.
  - A normalised search key is kept per title (title and original title). It is written on every insert and update, and filled for existing titles by the migration.
- **People.**
  - Names in the cast and crew TMDB gave (`items.people`) are suggested.
  - Picking one opens a person page listing their films and shows in the library this viewer can see, with role (director, actor) and character where known.
- **Full results** stay grouped by kind as now, using the same matching.
- **Older themes.** Their search page keeps its current look; only the matching improves.
- **Kids profiles.** Suggestions, people, person pages, genres, genre pages and library tiles all go through the viewer's rules. A person whose only titles the Kids profile can't see is never suggested to it.

## Verification

- Unit suite in groups, including the PC.
- New `devtools/v024-ui.mjs` sections:
  - `artwork`: no oversize images, `srcset` present, the hero loads first;
  - `menu`: distinct icons, pinned entries visible at 1080p and 720p, the More panel, the pill;
  - `search`: recents, tiles, suggestions with a remote, accents, a Kids profile.
- `v023-ui`, `v022-ui`, `a11y-ui`, `music-ui`, `lists-ui`, `settings-check` green.
- `oldthemes-compare` "all pages match".
- A fresh review and one fix pass per plan.
- Pictures (`devtools/v024-shots.mjs`, Orbit desktop and phone): the menu at 1080p, the phone dock and More panel, search before typing, suggestions, a person page, and a before/after of Home's picture download.

**Not yet verified (listed in build status):** real TVs' browsers (webOS / Tizen) with `srcset` and `modulepreload`; WebP on a Windows ffmpeg without `libwebp`; Safari's WebP decoding speed on old iPhones.

## Plans

- A: Faster artwork.
- B: The menu.
- C: Search, and v0.24.0.

Native (inline) execution, as before.
