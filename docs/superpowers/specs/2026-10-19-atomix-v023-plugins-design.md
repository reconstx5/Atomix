# Atomix Round 25 — v0.23.0: more plugins (info and artwork, Home rows, alerts)

Approved in conversation with Dallas, 19 Oct 2026 ("looks good" to each section; approach 1).

## Intent

Dallas asked to "create and add some more plugins". He picked two areas: **better info and artwork**, and **new Home rows and alerts**. For alerts he chose **new films and episodes** and **server problems**; for rows **Finish what you started**, **Seasonal picks** and **On this day**.

Success: a household can turn on Fanart.tv, OMDb, Open Library and MusicBrainz in Settings → Plugins and see better logos, outside scores, book and album details fill in; Home gains three rows that respect every profile's rules; the alerts plugin reaches a phone through ntfy, Telegram or Pushover, for new titles and for server problems.

**Assumed (stated, not corrected):** the four info plugins listed (Fanart.tv, OMDb, Open Library, MusicBrainz + Cover Art Archive); Fanart.tv and OMDb need a free personal key pasted in Settings; one round, v0.23.0; Native execution as before.

## Global constraints

- Node ≥ 22.13, `node:sqlite`, ffmpeg; plain ES-module browser JS; **no dependencies**.
- No Kodi GPL code.
- Keys and tokens (Fanart.tv, OMDb, Telegram, Pushover, ntfy) never reach the browser or the logs; plugin `password` settings as today.
- Kids profiles never see admin data, and never see a title outside their rules (age rating, allow-unrated, libraries) — in every new row.
- Older themes stay pixel-identical: `node devtools/oldthemes-compare.mjs compare` → "all pages match".
- Plugins only fill gaps: what files, `.nfo`s, Edit details or TMDB already gave stays. Locked fields stay locked.
- Every plugin works with no network: a lookup that fails is logged once and tried again at the next refresh, never breaking a scan.
- Tests reach fake services only: each plugin reads its service's base address from an environment variable used by the tests (`ATOMIX_FANART_BASE`, `ATOMIX_OMDB_BASE`, `ATOMIX_OPENLIBRARY_BASE`, `ATOMIX_MUSICBRAINZ_BASE`, `ATOMIX_COVERART_BASE`, `ATOMIX_TELEGRAM_BASE`, `ATOMIX_PUSHOVER_BASE`).

## Approach

One plugin per job, plus small core extensions the plugins need (approach 1). Push alerts go into the existing "New-episode alerts" plugin, renamed **Alerts**, so there is one place for every alert and one Test button.

## 1. Core extensions (Plan A)

- **Outside scores.** A metadata provider may return `scores: [{ source: 'imdb' | 'rt' | 'metacritic', value: '7.8/10' | '93%' | '81/100' }]`. Migration 28 adds `items.scores` (JSON). The film/show page shows "IMDb 7.8 · Rotten Tomatoes 93% · Metacritic 81" in its meta line (all themes; older themes' demo titles have none, so they stay identical). `/api/items/:id` and the serializer carry `scores`. Edit details can clear them (a "Clear scores" button; not hand-edited).
- **Books and audiobooks ask metadata providers.** The scanner's metadata pass and Refresh info include `book` and `audiobook`; a provider lists those kinds in `kinds`. For these kinds the merge only fills fields that are empty on the row (description, poster, genres, year); the title and author from the book itself always win; Edit details locks apply.
- **Ids between providers in one refresh.** The TMDB provider returns `tvdbId` for shows (from its external ids); a provider may return `musicbrainzId` (album) and `musicbrainzArtistId` (artist). These go into `ctx.merged` for later providers in the same refresh and are not stored.
- **Library helpers for rows** (all filtered for the viewer: age rating, allow-unrated, libraries):
  - `library.list({ keyword })` — titles whose TMDB keywords include it (case-insensitive).
  - `library.startedShows(viewer, { idleDays })` → `[{ show, next, left, lastWatchedAt }]`: shows with at least one watched and at least one unwatched episode, last watched more than `idleDays` ago; `next` the first unwatched episode in order.
  - `library.partlySeenSeries(viewer)` → `[{ collection, next, seen, total }]`: film series (TMDB collections) with some parts watched and at least one unwatched part in the library.
  - `library.playedOn(viewer, date)` → items this profile played on that local day (from plays).
- **Server-problem events.** `server:problem { kind, key, text }` and `server:recovered { kind, key }`, each sent once per key until it clears. Kinds:
  - `library-folder` — a library folder missing, or suddenly empty (the prune guard);
  - `remote-server` — a connected server not answering at its sync;
  - `podcast-feed` — a feed failing 3 checks in a row;
  - `live-source` — a Live TV source whose refresh failed;
  - `disk` — under 5 GB free where data, recordings or downloads are kept (checked hourly).
  `text` is a sentence for people ("The Movies folder D:\Movies is missing.") with no addresses' secrets or tokens.
- **Docs:** `docs/PLUGINS.md` documents scores, the new kinds, the ids, the helpers and the events.

## 2. Info and artwork plugins (Plan B)

Each is off until turned on; with no key (where one is needed) it does nothing and its card says so. Results are kept in the plugin's storage (`api.storage` or `api.dataDir`) so a rescan doesn't ask again.

- **`fanart-tv`** (free personal key). Films by TMDB id, shows by TheTVDB id (`ctx.merged.tvdbId`), artists and albums by MusicBrainz id. Fills missing **logo**, **backdrop** and **poster** — the metadata language first, then English, then no language; most-liked first. Setting: which of logo / backdrop / poster it may fill (all on).
- **`omdb-ratings`** (free key, 1,000 a day). Films and shows by IMDb id, else title + year (type movie/series). Stores IMDb, Rotten Tomatoes and Metacritic as `scores`. Stops at a daily limit (setting, default 900; the day is the server's local day) and carries on the next day. Action **Fetch missing scores**: works through films and shows with no scores in the background, a few at a time, within the limit; it reports how many it did.
- **`open-library`** (no key). Books and audiobooks by ISBN when known, else title + author. Fills description, cover (the "-L" image; none when Open Library has no cover), first-published year, up to 3 subjects as genres. About one request a second; a User-Agent naming Atomix and its version.
- **`musicbrainz`** (no key). Albums by artist + album name (release groups); artists by name. Fills the album cover from the Cover Art Archive (front, 500 px) when the folder and tags have none, the first-release year and up to 3 genres; passes `musicbrainzId` / `musicbrainzArtistId` on. At most one request a second; User-Agent `Atomix/<version> ( <contact email setting, optional> )`.

## 3. Home rows, Alerts and v0.23.0 (Plan C)

- **`more-home-rows`** (on by default). Three rows, each in Arrange home (keys `plugin:more-home-rows/<row>`), each hidden when empty:
  - **Finish what you started** — started shows idle ≥ 14 days (setting) with the next episode as the card ("4 episodes left"), and partly seen film series with the next film ("Part 3 of 4"); titles already in Continue watching are left out.
  - **Seasonal picks** — Christmas films (1–31 Dec), Halloween frights (1–31 Oct), Valentine's picks (1–14 Feb, romance), Summer films (Dec–Feb in the Southern hemisphere, the default; Jun–Aug in the Northern — a setting). From TMDB keywords and genres; shown only with at least 4 matches; the row's title follows the season. Christmas wins over Summer in December.
  - **On this day** — films released on today's month and day in earlier years ("Released 19 Oct 1985"), and what this profile watched a year ago today ("You watched this a year ago").
- **Alerts** (the `notifications` plugin, renamed; its settings kept). New channels: **ntfy** (server, default `https://ntfy.sh`; topic; optional access token), **Telegram** (bot token, chat id), **Pushover** (app token, user key). Switches: **New films and episodes** (today's one message per scan, on), **Server problems** (the events above, on), **Say when a problem clears** (off). A problem is sent once per key, at most once a day if it comes back. **Test** sends to every channel filled in and reports each one ("ntfy: sent · Telegram: Unauthorized (check the bot token)").
- **v0.23.0:** version; README Plugins section (all 11 plugins and what each needs); PLUGINS.md; pictures (`devtools/v023-shots.mjs`, Orbit desktop + phone): scores on a film page, a Fanart.tv logo, an Open Library book, the three rows on Home, the Alerts card, an alert received by a fake ntfy.

## Verification

Per plan and for the round: unit suite in groups; new `devtools/v023-ui.mjs` sections; `v022-ui`, `v021-ui`, `a11y-ui`, `live-ui`, `music-ui`, `lists-ui`, `cast-ui`, `settings-check` green; `oldthemes-compare` "all pages match"; a fresh review and one fix pass per plan; hash-checked PC delivery and PC tests in groups.

**Not yet verified (listed in build status):** the real Fanart.tv, OMDb, Open Library and MusicBrainz services (keys; the cloud may block hosts); real phones receiving ntfy, Telegram and Pushover.

## Plans

A Core extensions · B Info and artwork plugins · C Home rows, Alerts and v0.23.0. Native (inline) execution.
