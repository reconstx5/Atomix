# NodeFlix architecture

NodeFlix is one Node.js process with no npm dependencies. It uses only built-in modules
(`node:http`, `node:sqlite`, `node:crypto`, `node:child_process`) plus the external `ffmpeg`/`ffprobe` binaries.

```
 Browser (public/)                           Server (src/)
 ┌──────────────────────────┐   JSON/HTTP   ┌──────────────────────────────────────────────┐
 │ app.js   router + shell  │ ────────────▶ │ app.js      http server, CSRF, auth gate      │
 │ nav.js   arrow-key focus │               │ http/       tiny router, static + ranges      │
 │ views/   pages & player  │ ◀──────────── │ api/        account · library · playback ·    │
 │ caps.js  codec detection │   video bytes │             admin endpoints                   │
 │ music.js mini-player     │               │ auth.js     scrypt, sessions, rate limiting   │
 │ queue.js up-next logic   │               │ profiles.js who's watching, PINs, Kids limits │
 └──────────────────────────┘               │                                               │
                                            │ library/    scanner · parser · probe · music ·│
                                            │             metadata · ratings · queries      │
                                            │ stream/     playback decisions · ffmpeg ·     │
                                            │             subtitles                         │
                                            │ plugins.js  loader + plugin API               │
                                            │ themes.js   theme discovery                   │
                                            └──────────────┬───────────────────────────────┘
                                                           │
                              data/nodeflix.db (SQLite) · data/images · data/cache · data/transcode
```

## Start-up

`server.js` checks the Node version and calls `createApp()` in `src/app.js`, which:

1. loads static config (`src/config.js`: env vars → `nodeflix.config.json` → defaults) and creates the data folders;
2. opens SQLite and runs migrations (`src/db.js`, `PRAGMA user_version`; see below);
3. detects ffmpeg/ffprobe and available H.264 encoders;
4. builds the services (settings, hooks, metadata, scanner, playback, plugins) and registers routes;
5. loads enabled plugins, starts listening, schedules periodic scans and kicks off a catch-up scan.

## Data model

| Table | Purpose |
| --- | --- |
| `users` | accounts, scrypt password hash, role (`admin`/`user`), `library_access` (JSON list of library ids, or null for all) |
| `profiles` | “Who's watching?” profiles per account: name, avatar, optional scrypt PIN hash, `kids`, `max_age`, `allow_unrated`, `libraries`, `prefs` JSON (theme, accent, subtitle size…). Every account has one primary profile. |
| `sessions` | SHA-256 of each session token, expiry (sliding), user agent, IP, and the chosen `profile_id` |
| `settings` | runtime settings (TMDB key, transcoding options, rating country…) as JSON values |
| `libraries` | name, type (`movies`/`tv`/`music`), folder list |
| `items` | every movie, show, season, episode, artist, album and track. `parent_id` builds the tree (episode → season → show, track → album → artist); `show_id` shortcuts episodes to their show and tracks to their album artist. Files store `size`/`mtime` (change detection) and `media` (ffprobe summary JSON). `certification` / `min_age` hold the age rating; tracks keep their own `artist`. |
| `progress` | per **profile** × item: position, duration, watched flag |
| `plugins` | enabled flag and saved settings per plugin |

### Migrations

`PRAGMA user_version` records the schema version. Each migration runs in a transaction with foreign keys switched
off, then `PRAGMA foreign_key_check` must come back clean before they are switched on again. Tables that need a
changed constraint are rebuilt the way SQLite recommends (create the new table, copy, drop, rename).

1. The original schema.
2. Profiles: adds `profiles` (one primary profile per existing account), `users.library_access`,
   `sessions.profile_id`, `items.certification`/`min_age`, and moves `progress` from users to profiles.
3. Music: rebuilds `libraries` and `items` without the old `CHECK` lists (so `music`, `artist`, `album`, `track`
   are allowed) and adds `items.artist`.
4. The Arctic theme becomes the default: a stored server default of `midnight` (saving Settings → Server always
   stored whatever was showing) changes to `arctic`. Themes people picked for their own profile are kept.
5. `items.logo`: clear logos (transparent title art) from `clearlogo.png`/`logo.png` next to the media, or TMDB's
   logos (metadata language first, then English, then language-less; most votes wins).
6. Background jobs: `libraries.options` (JSON, e.g. `{"previews": false}`), `media_jobs` (what each job did for which
   file: `status` done/none/failed, the file's size and mtime at the time, preview layout in `data`) and `markers`
   (intro/credits per episode; `source` manual > chapter > audio; start and end both NULL mean "no intro").

### Viewers

Every request resolves a *viewer* — `{ userId, profileId, kids, maxAge, allowUnrated, libraryIds }` — from the
account and the profile stored on the session (`src/profiles.js`). If an account has several profiles, or its only
one has a PIN, requests answer `428 PROFILE_REQUIRED` until one is chosen. All library queries go through
`Library.visibility(viewer)` (`src/library/queries.js`), which adds the library and age-rating conditions to the SQL,
so a Kids profile can't reach a hidden title by id, search, home rows or plugins. Age ratings are stored as
`COUNTRY:LABEL` (`NZ:R16`, `US:PG-13`…) and mapped to a minimum age by `src/library/ratings.js`. Music is not
age-rated; it is limited by library access instead. Admin routes are refused while a Kids profile is active.

Artwork references in `items.poster`/`items.backdrop` are `cache:<file>` (downloaded to `data/images`),
`file:<path>` (artwork next to the media) or an `https://` URL. The browser always asks
`/api/items/:id/image/:type`, so file paths are never exposed.

## Library scanning (`src/library/scanner.js`)

1. Walk each library folder (skipping hidden, `Extras`, `Sample`, `-trailer` files…).
2. In one transaction, upsert every video file. Movies use `parseMovie()`; TV uses the first folder under the
   library root as the show, season folders or `SxxEyy` for seasons, and `parseEpisode()` for numbers.
3. Remove items whose files disappeared — **only** under folders that were readable this scan, so an
   unplugged drive doesn't wipe your library.
4. `ffprobe` new/changed files (3 at a time) and store codecs, tracks and duration.
5. Fetch metadata for new items: movies and shows first, then seasons and episodes (which need the show's TMDB id).

Music libraries take a different path (`scanMusic`): changed audio files are probed first, because the tags decide
where a song belongs (`src/library/music.js` normalises tag names and falls back to `Artist/Album (Year)/07 - Title`).
Songs are grouped into albums by folder + album name; the album artist is the `album_artist` tag, else the single
artist, else “Various Artists”. Cover art comes from `cover.jpg`/`folder.jpg`/… in the album folder, or is pulled
out of the files' embedded pictures once and cached. Empty albums and artists are pruned with the songs.

`item:added` and `scan:complete` carry `firstScan`, so plugins such as the alerts plugin can stay quiet while a new
library fills up.

Metadata providers run in priority order and only fill fields that are still empty:
`local-artwork` (5) → `nfo` plugin (10) → `tmdb` (50) → other plugins (default 100).
An admin **Fix match** pins a TMDB id and locks the item against automatic changes.

## Playback (`src/stream/playback.js`)

The player sends what the browser can decode (`public/js/caps.js`). The server picks the cheapest option:

| Mode | When | Cost |
| --- | --- | --- |
| **direct** | container is MP4/WebM, codecs supported, default audio track, no quality cap | none — the file is served with HTTP range requests |
| **remux** | video codec supported but container/audio isn't (e.g. MKV, AC3/DTS audio) | low — video copied, audio converted to AAC |
| **transcode** | unsupported video (HEVC in Firefox, 10-bit H.264…), lower quality chosen, or picture subtitles burned in | high — H.264 via libx264 or a hardware encoder |

Delivery for converted streams:

- **Progressive fragmented MP4** (`/api/stream/:session`) for Chrome, Edge and Firefox.
- **HLS** (`/api/hls/:session/index.m3u8`, fMP4 segments) for Safari and iOS, which can't play an unbounded MP4.
- **WebM (VP8/Opus)** for the rare browser built without H.264.

Converted streams can't be seeked by the browser, so the player keeps a *logical* timeline
(`stream start + video.currentTime`) and asks for a new session starting at the target time when you seek
(debounced, and the old ffmpeg process is killed). Sessions send a heartbeat every few seconds; silent
sessions are reaped after two minutes. `maxTranscodes` caps concurrent conversions.

**Music** uses the same sessions with audio-only decisions (`decideAudio`): files the browser can decode play
directly (usually MP3, AAC/M4A, FLAC, WAV, Ogg/Opus); anything else (WMA, ALAC, APE…) becomes AAC in fragmented MP4,
HLS on Safari, or Opus in WebM for browsers without AAC.

Subtitles are fetched as WebVTT and drawn by the player itself (so they follow the logical timeline and can be
styled). Sidecar `.srt` files are converted in JS (with a Windows-1252 fallback for old files); embedded text
tracks are extracted once with ffmpeg and cached. Subtitle provider plugins (OpenSubtitles) can be searched from the
player; downloads are saved under `data/subtitles/<item id>/` and listed with the other tracks.

## Background tasks (`src/tasks.js`, `src/extras/`)

`TaskRunner` runs one job at a time and asks the database what's next: titles from the latest scan first, then the
backlog oldest first. Intro checks (seconds each) come before previews. ffmpeg runs at low priority
(`os.setPriority`), and nothing runs while a video is being converted for someone. If a conversion starts during a
job, its ffmpeg is killed and the job is redone later. A job counts as needed when it has no `media_jobs` row, or
the file's size or mtime has changed. Failed jobs wait for an admin's **Try again**.

- **Previews** (`extras/previews.js`): a single ffmpeg pass with `-skip_frame nokey` (keyframes only) and
  `setpts=PTS-STARTPTS,fps=1/10:round=up` (1/5 under 20 minutes; each tile is the last frame at or before its
  time, counted from the first picture even when the audio starts a moment earlier),
  `scale=320:<even height>`, `tile=10x10`, giving JPEG sheets in `data/previews/<item id>/`.
  Sheets are written into `<id>.tmp` and swapped in. The player picks a tile with `public/js/previews.js`.
- **Intros** (`extras/intros.js`, `extras/fingerprint.js`): chapters named Intro/Opening/… (and Credits/End
  Credits/…) win. Otherwise the first `min(10 min, 40%)` of each episode is decoded to 8 kHz mono and turned into
  32-bit codes every 64 ms (Haitsma–Kalker band-energy differences). Two episodes are compared at every alignment,
  and the longest stretch that matches for 15–150 s is the intro (a match covering 90% or more of the searched
  audio is a duplicate file, not an intro). Each episode is compared with the next, the next-but-one, the previous,
  then another season. The FFT and the comparisons run in a worker thread (`extras/matcher.js`,
  `extras/fingerprint-worker.js`) so the server keeps answering. When a file is replaced, its chapter/audio markers
  are dropped and found again; hand-set ones stay.
- Past the start of the credits, the player reports the episode as finished, so leaving from Up next marks it watched.
- The player gets `previews` and `markers` in the playback response.

## Security model

- Passwords: scrypt (N=16384, r=8, p=1) with per-user salt; timing-safe comparison.
- Sessions: 256-bit random tokens in an `HttpOnly; SameSite=Lax` cookie (also accepted as `Authorization: Bearer`),
  stored hashed, `Secure` when served over HTTPS (set `NODEFLIX_TRUST_PROXY=true` behind a proxy).
- CSRF: every state-changing request must be `application/json` and, if an `Origin` header is present, same-origin.
- Sign-in rate limit: 10 failures per IP per 15 minutes.
- Media is only reachable through item ids from the database — no user-supplied file paths. The folder browser is admin-only.
- Strict Content-Security-Policy (`script-src 'self'`), `nosniff`, frame protection.
- Plugins run with full server privileges — only install ones you trust.

## Web client (`public/`)

Plain ES modules, loaded on demand per view. `app.js` owns routing (hash-based), theming and session state.
`nav.js` implements spatial navigation: arrow keys move focus to the nearest focusable element in that direction
(same line first for ←/→, nearest line first for ↑/↓), which is what makes it usable with a TV remote.
Dialogs use native `<dialog>`; the layout switches between top and side navigation based on the theme.

`tint.js` works out the colour a picture would cast into a dark room (the most vivid hue, weighted towards
saturated mid-tones, then lightened or darkened into a band that shows on dark backgrounds and keeps dark text on it
readable; tested in `test/tint.test.js`). `backdrop.js` samples each backdrop into a 48×27 canvas, sets `--tint` on
the page, and the registered custom property animates between titles.

`backdrop.js` owns the full-screen artwork layer behind every page; views call `setBackdrop(url)`, and
`followFocus()` makes it (and the home spotlight from `components.js`) follow the focused or hovered card. The router
clears it for views that don't set one. On big screens the home view is a fixed-height column — spotlight on top, a
scrolling `.home-rows` area below — and `nav.js` keeps arrow-key movement inside a scrolling area (the rows, a row of
cards) before jumping out of it, so items scrolled out of sight are still reached in order.

`music.js` owns a single `<audio>` element and the mini-player bar, which live outside the page views so music
keeps playing while you browse. The queue logic (shuffle that keeps the current song, repeat all/one, play next,
move/remove) is plain code in `queue.js`, tested in Node (`test/queue.test.js`). The queue is saved per profile in
`localStorage`, playback sessions are pinged every 30 seconds, the Media Session API connects lock-screen and
media-key controls, and opening the video player pauses the music and hands the media keys to the video.
