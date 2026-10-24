# Atomix Round 24 — v0.22.0: an arrangeable Home, podcasts, audiobooks, books and comics

Approved in conversation with Dallas, 17 Oct 2026 ("looks good" to each section; one round, v0.22.0).

## Intent

Atomix grows from films, TV, music and Live TV into a hub for spoken word and reading, and each profile can shape its own Home. Success: a household can subscribe to podcasts that the server keeps, listen to audiobooks with chapters and a sleep timer, read EPUB books and CBZ/CBR comics on a phone or tablet (a TV remote still works), and arrange Home per profile from a household default — with every existing rule intact.

**Dallas chose:** Home screen you can arrange; Podcasts & audiobooks; Books & comics. Podcasts: the server keeps the episodes. Reading: phones and tablets first. Home: each profile, with a household default. CBR: use 7-Zip/unrar if installed.

**Assumed (stated, not corrected):** the new libraries get search, playlists, Downloads, Edit details, per-profile progress and Kids rules; PDF is out of scope; one round.

## Global constraints

- Node ≥ 22.13, `node:sqlite`, ffmpeg; plain ES-module browser JS; **no dependencies** (7-Zip/unrar are optional external tools, like ffmpeg).
- No Kodi GPL code. No DRM circumvention.
- Provider/feed addresses, headers and tokens never reach the browser or the logs (the browser only sees Atomix's own addresses).
- Kids profiles never see admin data, and never see a title outside their rules (age rating, allow-unrated, libraries).
- Older themes stay pixel-identical: `node devtools/oldthemes-compare.mjs compare` → "all pages match".
- Feed and directory requests use the same private-address check as connected servers.
- Book content never runs scripts.

## Architecture

New library types inside the existing library (approach 1): new `libraries.type` values `podcasts`, `audiobooks`, `books`, `comics`; new `items.kind` values `podcast`, `podcast_episode`, `audiobook`, `chapter`, `book`, `comic` (and `series` for book/comic series). Search, lists, Downloads, permissions (`canSee`/`visibility`), progress, ratings, stats and Edit details are extended rather than duplicated. One migration (24) adds the tables and columns below.

## 1. Home screen you can arrange (Plan A)

- **Catalogue.** `/api/home` builds rows from a catalogue of row kinds with stable keys: `continue` (Continue watching), `continue-listening`, `continue-reading`, `live-now`, `watchlist`, `lists`, `recent-<libraryId>`, `picks`, each plugin row (`plugin:<key>`), pinned rows, and `web-apps`.
- **Pinned rows:** a playlist or smart playlist, a genre in a library, a collection, a library sort ("Recently added", "Random"). Each is drawn with the viewer's rules every time.
- **Web apps:** shortcut tiles (name, address, picture) kept by admins in a household list; choosing one opens the site (new tab; same tab on TV). No API, no embedding. A Kids profile sees only web apps the admin marks "for Kids".
- **Arrangement:** an ordered list of `{ key, hidden }` plus pinned row definitions. The household default (admin, Settings → Server → Home screen); a profile has its own copy only once it changes something (until then it follows the default and its changes); "Reset to household" deletes the profile's copy. Row kinds missing from a saved arrangement are inserted at their default position.
- **Editor ("Arrange home"):** in Home's "…" and Settings → Profile. One list: Up/Down move focus; OK picks a row up, Up/Down move it, OK drops it; a show/hide switch per row; Remove on pinned rows; "Add a row" → Playlist, Genre, Collection, Library sort, Web app (admins). Drag handles for touch/mouse. Older themes reach it from "…"; their Home is unchanged until someone changes it.
- **Data:** `home_layouts(profile_id NULL = household, layout JSON, updated_at)`, `web_apps(id, name, url, image, kids, position)`. `/api/home` rows carry `key`.
- **Tests:** order applied; a new kind appears in its default place; a pinned row never shows a title outside a Kids profile's rules; only admins change the household default and web apps; reset; browser: arranging by remote keys only, adding/removing a pinned row; oldthemes compare.

## 2. Podcasts and audiobooks on the server (Plan B)

- **Podcasts library** (folder = where kept episodes go). Admins subscribe by feed address or by searching the Apple Podcasts directory (JSON search) and choosing a show. The feed address stays server-side.
- **Feed checker:** a scheduled task (every 6 h by default, Settings → Server) reads RSS/Atom with the small XML reader the Live TV guide uses, with If-Modified-Since/ETag. Caps: 5 MB of XML, 500 episodes read per check. Failing feeds keep their last error and time, shown to admins on the podcast's page ("Couldn't reach the feed (3 tries since Tuesday)").
- **Kept episodes:** downloaded one at a time per server into `<folder>/<show>/<YYYY-MM-DD> <title>.<ext>`, written as `.part` and resumed; a failed download retries at the next check. Per show: keep the newest N (default 10) or all; a "keep" pin protects an episode; played episodes outside the kept set are deleted (default: delete played, keep unplayed). Artwork, description, length and date from the feed; a missing length from ffprobe after download.
- **Audiobooks library:** one folder per book or one `.m4b` per book; tags (album/author/narrator/year/cover) via ffprobe; chapters from the file (v0.20 chapters code) or from the files in natural-sort order; a multi-file book plays as one timeline (position and "x h left" for the whole book).
- **Progress and rules:** the existing progress table; past 95% = played; "Mark played / unplayed". Age rating like other titles; a feed's `explicit` flag counts as 18 unless an admin sets a rating; unrated follows allow-unrated.
- **Also:** search, playlists, Downloads (sound copied, or AAC when the browser can't play it), stats (listening hours). Subsonic: `getPodcasts`, `getNewestPodcasts` (and the episode stream); audiobooks are not in music apps.
- **Tests:** a fake feed server — new episodes found, ETag respected, oversized/private-address feed refused, keep N with deletion and pins, partial download resumed; chapters from tags and from file order; progress across files; explicit under Kids rules; Subsonic podcast calls.

## 3. The spoken-word player (Plan C)

- Plays through the music engine and bottom bar (background play, lock screen and headphones, casting, queue) in a **spoken** mode: skip back 15 s / forward 30 s (Settings → Profile; keys `J`/`L`, Left/Right on a remote); title and chapter; "x h y min left"; speed 0.75–3× remembered per profile for spoken titles (music stays 1×), pitch kept; sleep timer 15/30/45/60 min or end of chapter, a 10 s fade at the end, "Add 10 min"; Chapters list and chapter ticks on the seek bar; position saved every 10 s and on pause/leave; returning after more than 10 minutes rewinds 5 s.
- **Pages:** Podcasts library (grid with "New" badges, a "New episodes" strip; admins: Subscribe, Check now); a podcast (episodes newest first, filters Unplayed/Downloaded/All; per episode Play, Mark played, Keep (admin), Download; "Play unplayed in order" oldest first; admins: Keep settings, last check or error); an audiobook (cover, author, narrator, length, chapters; "Resume chapter 7, 2 h 14 min left"; Mark finished; Download).
- Every control reachable by arrows and OK; on phones the bar keeps its size and Now Playing gets large skip buttons. Older themes: the music bar looks the same for music; spoken mode appears only while a book or episode plays.
- **Offline:** downloaded books and episodes play from Downloads through the same bar (v0.21's offline path for audio); progress syncs later.
- **Tests (browser):** skip and speed per profile; sleep timer with a fast clock (fade, end of chapter); chapter jumps; resume with the 5 s rewind; mark played; podcast filters; an offline book; oldthemes compare with music playing.

## 4. Books and comics (Plan D)

- **Libraries:** Books (EPUB), Comics (CBZ, CBR, CB7, and folders of images as one comic). Series from ComicInfo.xml (Series/Number), EPUB `belongs-to-collection` / calibre:series, else the folder name; issue numbers from the file name.
- **ZIP reader (server, no dependencies):** reads the central directory, inflates one entry at a time with `zlib`; ZIP64; limits: 50 MB per entry, inflated ≤ 100× its packed size, ≤ 5,000 entries; damaged files are refused with a sentence, not a crash.
- **CBR/CB7:** Settings → Server finds `7z`/`7za`/`unrar` on the PATH or at an admin-given path and says what was found. With a tool: list once (cached), pull one page at a time from the tool's standard output; arguments as an array, never a shell; entry names checked against the cached list. Without: listed with "Install 7-Zip to read this".
- **Metadata and covers:** EPUB package (title, author, series, description, language, cover); ComicInfo.xml; first page as the comic's cover; thumbnails by ffmpeg, cached. Edit details works; no online lookup this round.
- **EPUB reader (phone/tablet first):** chapters served by Atomix with a strict CSP (no scripts, no outside requests, images only from the book) in a sandboxed frame without `allow-scripts`. Pages as CSS columns; tap edges, swipe, arrows or remote; text size, line spacing, font (book's / serif / sans), theme (light, sepia, dark, the app's), margins — per profile; table of contents; "Chapter 3 · 42% · 12 min left in chapter". Position = chapter + text offset (survives font size and screen); synced per profile; on another device "Jump to page 87 (from your phone)?" when they differ.
- **Comic reader:** single or two-up on wide screens (cover alone); fit width/height/screen; pinch-zoom, pan, double-tap; right-to-left per series (automatic for `Manga=YesAndRightToLeft`); pages fetched ahead; "Next issue" at the end; remote: Left/Right page, Up/Down pan when zoomed, OK zoom. Pages over 4000 px scaled once by ffmpeg for phones; the original fetched when zooming past it.
- **Also:** Continue reading; past the last page = Read; age rating (ComicInfo AgeRating or Edit details), unrated follows allow-unrated; search, reading lists, stats (pages and time read). Downloads keep the whole file; offline readers use the same ZIP code in the browser on DecompressionStream; CBR is converted to CBZ when downloaded.
- **Tests:** ZIP reader (stored, deflated, ZIP64, damaged, bomb limits); EPUB metadata/TOC/cover; ComicInfo and series; the 7z path via a fake tool; a chapter response carries the script-free CSP; position sync; Kids rules; browser: EPUB paging by touch and keys, settings keep the position, comic two-up / right-to-left / zoom, an offline book and comic, older themes unchanged.

## 5. v0.22.0, the leftovers and verification (Plan E, with leftovers in their owning plans)

- **v0.21 deferred minors:**
  - Plan B: downloads `/jobs` and `/subtitles` honour the account's switch, unknown jobs answer "gone"; a ready copy's `used_at` refreshed when asked again; `skipped` counts extras; 416 sent `no-store`; the fetched-jobs set pruned; a lowered cache limit applies at once; If-Range on resume.
  - Plan C: `/offline/` refuses typed navigations; offline PIN tries limited (5, then 30 s, doubling); an old PIN hash stops working offline once a new one is seen; `/api/shell` lists only what `/themes/` serves; one tab runs downloads ("Downloading in another tab"); Downloads buttons carry their title and focus stays sensible after Remove; offline subtitles fall back for older Safari; offline progress keeps one row per title.
  - Plan D: Watch together ready after a failed restart; the duplicate delay PUT; karaoke timestamps in cast subtitles; connected-server artwork kept for a while; a deleted profile's play settings removed.
  - Plan E: a hung provider `stream()` gets a timeout; the 4 s replay after a drop; no recorder start after shutdown; an empty-name list PATCH refused before saving; Try again's row placement; focus after a failed row action; rating listeners; the `plays.js` comment; the README Downloads-link wording.
- **Migration 24** (types, kinds, feeds, kept episodes, book/comic fields: series, issue, reading direction, position offset; `home_layouts`, `web_apps`), with a migration test.
- **Docs:** README (Arranging Home, Podcasts, Audiobooks, Books and comics with "Install 7-Zip for .cbr"); ARCHITECTURE (ZIP reader, feed checker, reader security policy, home catalogue); Settings help text.
- **Pictures** (`devtools/v022-shots.mjs`, Orbit desktop + phone): Arrange home and a pinned row; a podcast page and Subscribe; the spoken bar and Now Playing with the sleep timer; an audiobook page; the EPUB reader in two themes; the comic reader two-up and right-to-left; Continue reading and listening on Home.
- **Verification per plan and for the round:** unit suite in groups; new `devtools/v022-ui.mjs` sections; `v021-ui`, `v020-ui`, `a11y-ui`, `live-ui`, `music-ui`, `lists-ui`, `cast-ui`, `settings-check` green; `oldthemes-compare` "all pages match"; a fresh review and one fix pass per plan; hash-checked PC delivery and PC tests in groups.
- **Not yet verified (listed in build status):** real podcast feeds (the cloud may block hosts), 7-Zip on Windows, large EPUBs with complex CSS, reading on a real iPad, iPhone storage for big comics.

## Plans

A Home screen · B Podcasts and audiobooks (server) · C Spoken-word player · D Books and comics · E v0.22.0 release. Native (inline) execution, as in earlier rounds.
