# Atomix as a Jellyfin server for Infuse — design

Date: 18 Nov 2026. Status: draft for Dallas's approval.

## Why

Dallas wants to watch his Atomix films and TV in **Infuse on his iPhone and Apple TV**. Infuse speaks Jellyfin's API,
so Atomix answers enough of that API, under `/jellyfin`, for Infuse to sign in, browse, play, resume and mark watched
as if Atomix were a Jellyfin server. Atomix stays the source of truth: progress, watched state and favourites made in
Infuse are Atomix's own data, and the web app carries on where Infuse left off (and the other way round).

Infuse plays almost every file itself, so this is mostly "describe the library well and hand over the original file
with byte ranges". It needs no ffmpeg on the server.

## Goals

- Infuse (iPhone and Apple TV) can add Atomix as a Jellyfin server at `https://<host>/jellyfin` (`http://` on the
  home network works too) and sign in with **username + an app password**.
- Infuse shows the profile's **film and TV libraries**, with titles, years, overviews, ratings, genres, people,
  posters, backdrops, logos and episode stills. It also shows **Continue Watching**, **Next Up** and **Recently Added**.
- Films and episodes **play by direct play**: the original file with HTTP ranges, seeking in place. Titles from a
  connected server (Jellyfin, Emby, Plex, another Atomix) are passed through Atomix, so the far server's address and
  token never reach Infuse.
- Infuse's progress reports move the profile's Atomix progress, and playing to the end marks the title watched by
  Atomix's own rules. "Mark watched/unwatched" and favourites (Atomix's heart) work both ways.
- External subtitles that Atomix knows (sidecar files and ones downloaded through the subtitle plugin) are offered as
  external streams. Infuse reads embedded tracks from the file itself.
- Everything goes through the profile's **viewer**: library access, Kids rules (age limits, unrated) and hidden
  titles apply exactly as on the web. A Kids profile's app password shows a Kids library.
- The **per-account stream cap** (4 playback sessions) and the stream counting stay right. A film playing in Infuse
  is one session on the account.

## Non-goals (this round)

- Swiftfin and Streamyfin (they need server transcoding through Jellyfin's PlaybackInfo/HLS), Finamp and music
  libraries, Live TV and recordings, books, podcasts and audiobooks, photos.
- Transcoding or remuxing for Jellyfin clients. PlaybackInfo offers direct play only.
- Quick Connect for Jellyfin apps, UDP server discovery (port 7359), a separate port.
- Jellyfin's admin, plugin, scheduled-task, user-management and SyncPlay APIs. Writing metadata from the app.
- Intro/credits skipping in Infuse (Jellyfin media segments). Possible later, since Atomix has the markers.
- Collections and playlists as Jellyfin BoxSets/Playlists. Possible later.

## Anti-goals (a failure even if Infuse "works")

- An app password, session token, provider address or connected-server token appears in a log line, an error
  message or any response body (tokens arrive in headers **and** in `api_key=` query strings: both are redacted).
- A Kids profile, or a profile without access to a library, can reach a hidden title by guessing an id, through an
  image or stream URL, a search, Next Up or Latest.
- Infuse opens more streams than the account's cap allows, or a stopped Infuse stream holds a slot for longer than
  the web's own idle reaping (2 minutes).
- Jellyfin routes change or slow down anything the web app, casting, Live TV or the Subsonic API does.
- Users read Jellyfin jargon. Messages in Atomix's own Settings are plain sentences.

## Constraints

- Node ≥ 22.13, no new dependencies, no build step (CLAUDE.md).
- Test first (RED → GREEN) with `node --test`. Real-device checks on Dallas's iPhone and Apple TV are the final gate.
  Until then the work is "delivered, waiting on a real Infuse".
- Never port 8787 for checks. The dev server is `BASE=http://localhost:8797`.
- Provider addresses, keys and tokens never reach clients or logs. No DRM work is involved.

## Approaches considered

1. **Inside Atomix under `/jellyfin` (chosen by Dallas).** Same process, port, HTTPS and Tailscale Serve address.
   Jellyfin apps accept a server address with a path, because that's how real Jellyfin runs behind a proxy. This
   reuses the library, viewer, playback sessions and stream cap, as the Subsonic API under `/rest/` does, and can't
   clash with the web app's own addresses.
2. Inside Atomix at the top level: a bare address, but Jellyfin paths (matched without regard to capitals) would sit
   next to the web app's files and page routes, so one could quietly break the other.
3. A second port that looks like real Jellyfin (8096): closest to the real thing, with discovery possible. But it's
   another port, another HTTPS setup and another Tailscale Serve entry, for little gain.

Profiles: Jellyfin has users and no "Who's watching?", so each sign-in lands on one profile. Considered: (A) app
passwords per profile, like the music apps; (B) the account password with `name/Profile` usernames; (C) the account
password and the primary profile only. **Dallas chose A.** The real password never goes into a third-party app, each
profile (Kids included) gets its own login, and revoking a password signs that app out.

## Design

### Shape (mirrors `src/subsonic/`)

- `src/jellyfin/`: its own small handler, like `Subsonic`. `src/app.js` sends `/jellyfin` and `/jellyfin/…` to
  `core.jellyfin.handle(req, res, url)` before `/api/`. Paths after `/jellyfin` match **case-insensitively**, with
  and without the legacy `/emby` prefix if Infuse uses it (builder to confirm from real traffic). Answers are
  Jellyfin's JSON (PascalCase), HTTP status codes as Jellyfin uses them. CORS isn't needed (Infuse is native).
- Every signed-in request resolves `{ user, profile, viewer }` through `core.profiles.viewer(user, profile)`, the same
  viewer the web and Subsonic use. All item reads go through `library.visibility` / `library.canSee`.

### Signing in

- **App passwords are shared with the music apps**: the same `app_passwords` table and the same list in Settings.
  Any one of a profile's app passwords signs in to either API. *(Builder's call recorded: one list is simpler for a
  household; the leak risk is the same either way.)* Settings → Profile's "Music apps" section becomes **"Apps"**,
  with text naming Infuse alongside the Subsonic apps and saying what to type: the server address ending in
  `/jellyfin`, your username, and the app password.
- `POST /Users/AuthenticateByName` `{ Username, Pw }`: the username is the Atomix account name, and the password is
  one of that account's profiles' app passwords. Each candidate is compared in constant time, as in
  `AppPasswords.check`. It shares the web's sign-in rate limit and lockout (`auth.checkRateLimit` / `recordFailure`),
  as Subsonic does, and a first sign-in is noted in the activity log. *(Builder's call, recorded:)* only a wrong
  username/password at `AuthenticateByName` counts as a failure. A bad, logged-out or revoked **token** answers
  `401` but is not counted, because Infuse retries its saved token in the background and tokens are 256-bit random,
  so they can't be guessed. The lockout is per client address, so behind Tailscale Serve it depends on
  `trustProxy`, the same as for the web and the music apps today.
- A success issues a **Jellyfin access token**: 256-bit random, stored **hashed** in a new table (migration 34)
  `jellyfin_tokens (id, app_password_id → app_passwords ON DELETE CASCADE, token_hash, device_id, device_name,
  client, version, created_at, last_used_at)`. Revoking the app password (it's flagged `revoked`, not deleted) makes
  every token issued from it fail on its next call. `POST /Sessions/Logout` deletes the token.
- The token is read from `Authorization: MediaBrowser … Token="…"`, `X-Emby-Authorization`, `X-Emby-Token`,
  `X-MediaBrowser-Token` or `api_key`/`ApiKey` in the query. A bad token gets `401` with no body detail.
- `GET /Users/Public` answers `[]` (no account names are shown before sign-in). `GET /System/Info/Public` is open and
  gives the server name, a stable server `Id`, and a Jellyfin-compatible `Version` and `ProductName` that Infuse
  accepts (builder: use the values real Infuse needs, e.g. `10.10.x`, and test them).
- The Jellyfin **user** is the profile: `Id` is a GUID made from the profile id, and `Name` is the profile name.
  `Policy` says not an administrator and no deleting. Downloading follows the offline-download rules under Playing.

### Ids

Jellyfin ids are 32-hex GUIDs. Atomix maps them both ways deterministically and without a table: a fixed prefix,
the kind (item, library, profile, server), and the integer id, written as a GUID. An id that doesn't parse, or names
something the viewer can't see, is `404`. Ids are stable across restarts (Infuse caches them).

### Browsing (what Infuse needs; the builder confirms the exact set from a real Infuse session)

- `GET /Users/{id}/Views` and `/UserViews`: the viewer's **film and TV libraries** as `CollectionFolder`s
  (`CollectionType` `movies` / `tvshows`). Other library types aren't listed.
- `GET /Users/{id}/Items` and `/Items`, with the parameters Infuse uses: `ParentId`, `Recursive`,
  `IncludeItemTypes` (`Movie`, `Series`, `Season`, `Episode`), `Fields`, `SortBy`/`SortOrder`, `StartIndex`/`Limit`
  (paged, with `TotalRecordCount`), `Filters` (`IsPlayed`, `IsUnplayed`, `IsFavorite`, `IsResumable`),
  `SearchTerm`, `Ids`, `MinDateLastSaved`/`MinDateLastSavedForUser` if Infuse uses them for quick re-syncs.
  Unknown parameters are ignored, never an error.
- `GET /Users/{id}/Items/{itemId}` and `/Items/{itemId}`: one item. `GET /Shows/{id}/Seasons` and
  `/Shows/{id}/Episodes` (`SeasonId`, `Fields`). `GET /Users/{id}/Items/Resume`, `GET /Shows/NextUp`,
  `GET /Users/{id}/Items/Latest`: from Atomix's own Continue Watching, Next Up and recently added, so they match the
  web.
- Item shape (`BaseItemDto`): `Name`, `OriginalTitle`, `SortName`, `Type`, `Id`, `ServerId`, `ParentId`/`SeriesId`/
  `SeasonId`, `IndexNumber`/`ParentIndexNumber`, `ProductionYear`, `PremiereDate`, `Overview`, `Genres`,
  `OfficialRating` (Atomix certification), `CommunityRating`, `RunTimeTicks` (1 s = 10,000,000 ticks), `Studios`,
  `People` (name, `Type` Actor/Director/Creator, `Role` = character; no pictures, since Atomix keeps none for people), `ProviderIds` (Tmdb/Imdb/Tvdb when known, so Infuse can
  match its own metadata), `ImageTags`/`BackdropImageTags`, `UserData` (`PlaybackPositionTicks`, `PlayCount`,
  `Played`, `IsFavorite`, `LastPlayedDate`, `UnplayedItemCount` for series and seasons), `MediaSources`/
  `MediaStreams` from Atomix's probe (`items.media`), `LocationType: FileSystem`, `IsFolder`, `ChildCount`.
  Shapes are built in one place (`shapes.js`), as in Subsonic.
- Images: `GET /Items/{id}/Images/{Primary|Backdrop|Logo|Thumb}[/{index}]` with `maxWidth`/`maxHeight`/`fillWidth`/
  `quality`/`tag`, served from Atomix's artwork and its existing sizes (`src/library/thumbs.js`). Visibility is
  checked like any item.

### Playing

- `GET|POST /Items/{id}/PlaybackInfo`: one `MediaSource` (the file) with `SupportsDirectPlay: true`,
  `SupportsDirectStream: true`, `SupportsTranscoding: false`, its streams, and a `PlaySessionId`.
- `GET|HEAD /Videos/{id}/stream` (`?static=true`, any `.{container}` suffix, `MediaSourceId`): the original file
  with ranges. Local files are served as `/api/items/:id/file` serves them; a connected server's title is fetched
  and passed through by Atomix (the existing remote source path, `proxyRemoteFile`), so its URL and token stay on
  the server. A missing file is `404`.
- **Offline downloads — the same rules as the web's Downloads (Dallas, 18 Nov).** `GET /Items/{id}/Download` sends
  the original file (ranges, so Infuse can resume) for films and episodes, with the same limits as
  `/api/items/:id/download`: **grown-up profiles only** (a Kids profile gets `403`) and **local files only** (a
  connected server's title gets `400`, "Downloads come from the server that holds the file."). Like the web's
  download, it takes **no stream slot**. The user `Policy` says `EnableContentDownloading: true` for grown-up
  profiles and `false` for Kids, and a connected server's title says `CanDownload: false` (`SupportsDirectPlay`
  stays true). Progress watched offline arrives later through the normal `/Sessions/Playing*` and `PlayedItems`
  calls and is saved like any other report, as it arrives. Jellyfin reports carry no time of viewing, so the web's
  "newer than what the server has" rule for its own offline sync can't apply. Infuse sends them when it reconnects.
- **Stream cap — one slot per Infuse device (builder's call, recorded).** A Jellyfin stream opens an Atomix
  playback session in `direct` mode, keyed by the **token** (one signed-in Infuse on one device), so it counts
  toward `MAX_SESSIONS_PER_USER` and shows where the web shows playing sessions. Every range connection of that
  device shares the session. Reading a **different** title on the same device (Infuse pre-reads a file's opening bytes
  for its tracks, loads the next episode, or jumps between episodes without `Stopped`) moves the device's one
  session to the new title; it never opens a second one. Range requests and `/Sessions/Playing/Progress` keep it
  alive. `/Sessions/Playing/Stopped`, `/Sessions/Logout`, or 2 minutes of silence (the existing reaper) end it. A
  device that has no session yet while the account is at its cap gets `429`, and nothing is served. Reason: a device
  plays one thing at a time, and counting per title would let Infuse's pre-reads fill the account's slots.
- `POST /Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped` (and the older
  `/Users/{id}/PlayingItems/{itemId}` forms if Infuse uses them): positions in ticks are saved as Atomix progress
  for the profile, through the same code the web's progress route uses (so scrobblers, play history, "watched near
  the end" and Next Up behave the same). A profile's Kids/age rules are checked on the item first.
- `POST /Users/{id}/PlayedItems/{itemId}` / `DELETE` mark watched/unwatched (a series or season marks its episodes,
  as the web does). `POST|DELETE /Users/{id}/FavoriteItems/{itemId}` sets Atomix's heart.
- Subtitles: each external subtitle from `listSubtitles` is an `External` `MediaStream` with a
  `DeliveryUrl` under `/jellyfin/Videos/{id}/{sourceId}/Subtitles/{index}/0/Stream.{srt|vtt}`, served from Atomix's
  subtitle code. Embedded text and picture tracks are listed as embedded streams, and Infuse reads them from the file.
- Anything else Infuse asks for that this round doesn't cover (e.g. `/DisplayPreferences`, `/Users/{id}/
  Configuration`, `/Branding/*`, `/Sessions/Capabilities*`, `/Localization/*`) gets a harmless empty answer of the
  right shape. The builder lists these from a real Infuse session.

### Security and logs

- Tokens and app passwords are redacted from every log line, including the request URL (`api_key=`) and the
  `Authorization` headers. `[jellyfin]` log lines name the method and status only.
- Responses contain only `/jellyfin/…` URLs. Never a file path (`Path` is left out or made up like Subsonic's song
  paths, never the real path), never a connected server's URL.
- Admin-only things are not offered. A Kids profile's token behaves like the Kids profile on the web.

### Settings (web)

- Settings → Profile → **Apps** (was "Music apps"): the app-password list as today, with text that names both kinds
  of app and explains the `/jellyfin` address. It shows the full address for this server (the page's own origin +
  `/jellyfin`) with a copy button. The section follows the existing screen. It isn't moved to Preact in this round.
- No admin switch: the API is on like Subsonic's. An app password is the only way in.

## Testing

- Node tests (`test/jellyfin-*.test.js`), test first, against the in-process server with a made-up library:
  sign-in (right/wrong password, revoked password, rate limit, token in each header form and in `api_key`), ids round
  trip, views and items per viewer (a Kids profile and a profile without a library can't list, open, image or stream
  hidden titles), paging and filters, Resume/NextUp/Latest matching the web, progress and played/favourite writes
  landing in Atomix's own tables, the stream cap (several range requests and a different title on one device = one
  session; a 5th device while 4 are playing = 429; Stopped and Logout free the slot), downloads (grown-ups and local
  files only, no slot taken; Kids 403; connected server 400), connected-server pass-through hides the far URL, a bad
  token doesn't count toward the lockout, and no token or password in any log line.
- A recorded **Infuse session** (method, path and query of every call Infuse makes during add server → browse → play →
  stop) is kept as a fixture. A contract test replays it and checks every call gets a 2xx of the right shape.
  The first recording is made from a real Infuse against the dev server (see below); until then the builder writes
  it from Jellyfin's API documentation and marks it so.
- `devtools/jellyfin-smoke.mjs`: plain `fetch` (no Playwright) against `BASE=http://localhost:8797`. It signs in,
  walks views → a show → an episode, asks for PlaybackInfo, reads the first megabyte of the stream with a range, and
  reports progress and stopped.
- **Real devices (Dallas):** Infuse on the iPhone through the Tailscale address, and on the Apple TV on the home
  network. Add server, browse both libraries, play a film and an episode (direct play, seeking, subtitles), stop
  half-way and resume in the web app, finish one and see it watched, download an episode on the iPhone and watch part
  of it offline (the progress reaches Atomix once back online), sign in a Kids profile and check a grown-up title is
  missing and downloading is off. A logging switch (`ATOMIX_JELLYFIN_TRACE=1`, method + path + status, tokens redacted) lets
  Dallas capture what Infuse calls, so missing routes can be added.

## Left to the builder

- The exact route list and the fields Infuse reads, from Jellyfin's API documentation and, as soon as possible, a
  real Infuse session.
- The `Version` / `ProductName` values Infuse accepts. Whether `/emby/…` aliases are needed.
- How the GUID encodes kind + id, and the server `Id` (stable, stored in settings on first use).
- Where the direct-play session is opened (stream route vs PlaybackInfo) as long as the cap rules above hold.
- Updating `docs/ARCHITECTURE.md` (a "Jellyfin apps" section next to "Music apps") and CLAUDE.md's current state.
