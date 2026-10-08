# Atomix: connected servers — design (round 13, v0.11.0)

Date: 2026-10-02. Author: Claude, with Dallas's choices. Builds on v0.10.0.

## 1. What Dallas wants

"If you have a media server, connect it in Atomix." His choices during the design:

- Servers: **Jellyfin**, **Emby** and **another Atomix** this round; **Plex** as its own round after (its plex.tv
  sign-in and API differ).
- A connected server's libraries **appear beside your own** — in the menu, on Home, in search, picks, playlists.
- Video reaches the TV **through Atomix** (Atomix proxies or converts; the TV never talks to the other server).
- **Everyone** sees a connected server's libraries, under the same rules as local ones (account and profile
  library access; kids profiles by age rating).
- Atomix **copies the server's catalogue** (titles, artwork, descriptions), refreshed on a schedule and on demand;
  playback and watched state go live to the server.

Success looks like: an admin types a Jellyfin address and sign-in, ticks "Movies" and "TV Shows", and a minute
later those titles are on Home, in search and in the Movies menu entry like any local library, playing with one
press on the TV, with their watched state visible in Jellyfin's own apps afterwards. Taking the server away
removes all of it. A friend's Atomix connects the same way with an Atomix account.

Project-wide rules that apply throughout: Node ≥ 22.13, zero npm dependencies; plain ES-module browser JS; Orbit
first with a TV remote; older themes only change where this spec adds content; nothing leaves the server except
calls to the servers the admin connected; the design stays private.

## 2. Data

Migration 11 (`src/db.js`, `MIGRATIONS[10]`):

- Table `servers`: `id`, `kind TEXT CHECK (kind IN ('jellyfin','emby','atomix'))`, `name TEXT`, `url TEXT`
  (normalised: scheme, host, port, path, no trailing slash), `username TEXT`, `secret TEXT` (the access token for
  Jellyfin/Emby; the password for Atomix — see §3.3), `remote_user_id TEXT` (Jellyfin/Emby user id; Atomix profile
  id), `status TEXT NOT NULL DEFAULT 'ok'` (`ok`, `unreachable`, `unauthorized`), `status_detail TEXT`, `last_sync
  INTEGER`, `created_at INTEGER NOT NULL`.
- `libraries.server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE` (null for folder libraries) and
  `libraries.remote_id TEXT` (that server's library id). A remote library has `paths = '[]'`.
- `items.remote_id TEXT` — the server's item id. A remote item's `path` is `remote:<server_id>:<remote_id>` (the
  scanner's unique key per library/kind), and `remote_id` makes lookups cheap. Index `items_remote` on
  `(library_id, remote_id)`.
- `ON DELETE CASCADE` from `servers` to `libraries` and from `libraries` to `items` (confirm `items.library_id`
  cascades; migration 3's rebuild has it) means removing a server removes its libraries and titles, their progress,
  list memberships and collection memberships.

Settings: `remoteSyncHours: 6` (0 = only on demand), shown in Settings → Server beside the rescan interval.

The `/api/admin/settings` secret masking (`SECRET_SETTINGS`) is for settings; servers mask their own `secret` in
every API response (`'••••••••' + last 4` is not needed — the secret is never returned at all).

## 3. Providers (`src/remote/`)

One interface, `RemoteProvider`, implemented by `jellyfin.js` (used for `emby` too, with the header name and a
couple of paths switched) and `atomix.js`:

```
connect({ url, username, password }) → { secret, remoteUserId, serverName }     // throws HttpError 401/502
libraries(server) → [{ remoteId, name, type: 'movies'|'tv'|'music' }]            // only the three types Atomix has
*items(server, library, kind, parentRemoteId?) → async pages of RemoteItem        // movie|show|season|episode|artist|album|track
imageUrl(server, item, type) → { url, headers }                                   // poster|backdrop|logo|still
streamUrl(server, item) → { url, headers }                                        // the original file as a byte stream
reportProgress(server, item, { position, duration, watched }) → void             // best effort; errors logged, never thrown
ping(server) → { ok, detail }
```

`RemoteItem`: `{ remoteId, kind, title, sortTitle, year, overview, tagline, genres, rating, runtime, airDate,
certification, tmdbId, imdbId, keywords, people, season, episode, artist, album, track, disc, duration, media:
{ container, video: { codec, width, height, hdr }, audio: [{ index, codec, channels, language }], subtitles: [...] },
images: { poster: bool, backdrop: bool, logo: bool }, parentRemoteId }`.

### 3.1 Jellyfin and Emby

- Connect: `POST /Users/AuthenticateByName` `{ Username, Pw }` with the header
  `Authorization: MediaBrowser Client="Atomix", Device="Atomix", DeviceId="atomix-<server row id or random>", Version="<version>"`
  (Emby: the same with `X-Emby-Authorization`). The answer's `AccessToken` is the secret and `User.Id` the remote
  user id. Every later call sends `Authorization: MediaBrowser Token="<secret>", Client=…`.
- Libraries: `GET /Users/{userId}/Views`; `CollectionType` `movies` → movies, `tvshows` → tv, `music` → music;
  others are left out.
- Items: `GET /Users/{userId}/Items?ParentId=<library>&IncludeItemTypes=Movie&Recursive=true&Fields=…&StartIndex=&Limit=200`
  for movies; `Series` (Recursive) for shows, then `Season` and `Episode` with `ParentId` per show and season;
  `MusicArtist`, `MusicAlbum`, `Audio` for music. `Fields`: `Overview,Genres,Taglines,ProductionYear,OfficialRating,
  CommunityRating,RunTimeTicks,PremiereDate,ProviderIds,People,Tags,MediaSources,MediaStreams,ImageTags,
  BackdropImageTags,SortName,ParentId,IndexNumber,ParentIndexNumber,AlbumArtist,Artists,Album`.
  Runtime from `RunTimeTicks / 10 000 000`; certification `OfficialRating` as given (e.g. `PG-13`, `NZ-R16`), fed to
  `certToAge` after the `XX-` country prefix is turned into Atomix's `XX:` form; people from `People`
  (`Type === 'Director'` → director, `Actor` → cast, up to 8); keywords from `Tags`; `tmdbId`/`imdbId` from
  `ProviderIds.Tmdb`/`.Imdb`; media from the first `MediaSource` and its `MediaStreams`.
- Images: `GET /Items/{id}/Images/Primary` (poster; for episodes the still), `/Images/Backdrop/0`, `/Images/Logo`,
  with the token as the `Authorization` header (never in the URL, so it is never in a log or an `<img src>`).
- Stream: `GET /Videos/{id}/stream?static=true` for video, `GET /Audio/{id}/stream?static=true` for music, with the
  same header: the original file, with `Range` passed through.
- Progress: `POST /Sessions/Playing/Progress` `{ ItemId, PositionTicks, IsPaused }` every report; on `watched`
  `POST /Users/{userId}/PlayedItems/{id}`; a position reset (`position < 30` and not watched) sends
  `POST /Sessions/Playing/Stopped` with the position.
- Ping: `GET /System/Info/Public` (no auth) then `GET /Users/Me` (auth) → `unauthorized` on 401.

### 3.2 Another Atomix

- Connect: `POST /api/auth/login` `{ username, password }`; the `atomix_session` cookie is kept in memory per
  server (not stored); `GET /api/me` gives the profile; if the account has several profiles the first non-kids,
  non-PIN profile is selected with `POST /api/profiles/:id/select` (a server whose only profiles need a PIN
  answers "Make a profile without a PIN for Atomix to use"). On any 401 later, Atomix signs in again once with
  the stored password (`secret`), then marks the server `unauthorized`.
- Libraries: `GET /api/libraries` (type as is).
- Items: `GET /api/libraries/:id/items?limit=5000&offset=` (movies, shows, albums, artists per `view`),
  `GET /api/items/:id/children` for seasons and episodes, `GET /api/items/:id` for album tracks; the far Atomix
  serialises everything Atomix needs (`media` comes from `GET /api/items/:id` with `full: true` — one call per
  movie and episode, paced like the enrich pass; a sync of a large far library takes minutes, logged as such).
- Images: `/api/items/:id/image/:type` with the cookie. Stream: `/api/items/:id/file` with the cookie.
- Progress: `POST /api/items/:id/progress` `{ position, duration }`.
- Ping: `GET /api/status`, then `GET /api/me`.

### 3.3 Secrets

Jellyfin/Emby tokens and Atomix passwords live in `servers.secret` in the database, like the TMDB key does in
`settings`. They are never sent to the browser. The Connect dialog's password field is sent once to
`POST /api/servers` and not kept for Jellyfin/Emby (the token is).

## 4. Sync (`src/remote/sync.js`)

`RemoteSync.syncLibrary(lib)` is what `Scanner.scanLibrary` calls when `lib.server_id` is set (the scanner keeps
its phases, status and `scan:start`/`scan:complete` hooks, so the dashboard, the alerts plugin and the picks
cache behave as for a folder scan):

1. `ping` → on failure the library is left as it was, `servers.status` is set, and the scan status reports
   "Couldn't reach <name>: <detail>".
2. For each kind in order (movies; shows → seasons → episodes; artists → albums → tracks) page through
   `provider.items()` and upsert (`Scanner.upsertItem` with `path = remote:<server>:<remoteId>`, `remote_id`, the
   metadata fields written directly — `metadata_at = now`, `metadata_locked = 1` so the TMDB pass never touches
   them — `media` JSON, `duration`, `poster`/`backdrop`/`logo` as `https://…` (or `http://`) image URLs with no
   token: the image route resolves `remote:` items to `provider.imageUrl()` and fetches with the header; the
   `ImageCache.download(url, headers)` already supports headers; the cache key is the URL). `certification` →
   `min_age` through `certToAge`. `keywords`, `people`, and the TMDB collection: when `tmdbId` is set the existing
   `Collections.upsertTmdb` is called only if the TMDB key is configured (the collection's parts need
   `/collection/{id}`); otherwise nothing.
3. Prune: rows of this library with `seen_scan != scanId` go, as for files (`prune()` already handles any kind
   whose `path` is set; containers left empty go too).
4. `servers.last_sync = now`, status `ok`.

Local-only machinery skips remote items: previews, intro detection and thumbnails (`PREVIEWABLE`, `CHECKABLE`,
`THUMBABLE` gain `AND i.path NOT LIKE 'remote:%'`), subtitles on disk (`listSubtitles` returns the embedded
tracks only), Download (`/api/items/:id/download` → 400 "Downloads come from the server that holds the file"),
Refresh info and Fix match (hidden for remote titles; the routes answer 400), `enrichMissing` (`WHERE path NOT
LIKE 'remote:%'`). Extras: not synced this round (Jellyfin's `Extras` need another call per title; deferred).

Schedule: `remoteSyncHours` → the scanner's `schedule()` queues remote libraries on that interval (separately
from `scanIntervalMinutes` for folders). `POST /api/libraries/:id/scan` and `POST /api/scan` include them.

## 5. Playback and progress

`PlaybackManager.create()` gets the item's source from a small resolver: for a remote item
`{ file: <stream url>, headers }` from `provider.streamUrl()`; `decide()` is unchanged (it reads `media`); the
ffmpeg args pass `-headers 'Authorization: …\r\n'` (or `-cookies`) before `-i <url>` when converting; a `direct`
decision gives `delivery: 'file'` and `/api/items/:id/file` proxies: it forwards `Range`, `If-Range` and the
method, copies `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges` and the status (200/206) back,
and pipes the body; a 401 from the server marks it `unauthorized` and answers 502 "Can't reach <name>"; a
connection error answers 502 with the same wording and the player shows it as it shows any start failure.

`report()` from the player keeps saving progress per profile locally (`saveProgress`); the `playback:progress`
hook (already emitted) gets a listener in `src/remote/progress.js` that pushes to the server, rate-limited to one
call per 10 s per item plus the final one, with `watched` on the 90 % threshold the local rule uses. Failures are
logged once per server per hour, never shown while playing.

Music: tracks play through the same `/api/items/:id/file` proxy (the music player already uses the start route).

## 6. Settings and the API

`src/api/servers.js`, admin only:

- `GET /api/servers` → `[{ id, kind, name, url, username, status, statusDetail, lastSync, libraries: [{ id, name, type, remoteId }] }]`.
- `POST /api/servers` `{ kind, url, username, password, name? }` → connects (provider.connect), stores the row,
  answers the row plus `available: [{ remoteId, name, type }]` (that server's libraries of the three types).
- `PUT /api/servers/:id/libraries` `{ remoteIds: [] }` → creates missing `libraries` rows (name from the server,
  type mapped), removes unticked ones (with their items), queues a sync of the new ones.
- `POST /api/servers/:id/sync` → queues all its libraries. `POST /api/servers/:id/reconnect` `{ password }` →
  a fresh token (Jellyfin/Emby) or password (Atomix) and `status = 'ok'`.
- `DELETE /api/servers/:id` → cascade; the picks cache is cleared.
- `GET /api/status` (admin fields) gains `servers: [{ name, status }]` for the dashboard card.

Settings → Libraries gets a **Connected servers** panel above the libraries list: each server as a row
(name, kind, address, "Synced 2 h ago" or "Sign in again" / "Can't reach", buttons **Sync now**, **Libraries…**,
**Remove**), and **Connect a server…** which opens a two-step dialog (kind as three pills, Address, Username,
Password → **Connect**; then the libraries as tick-boxes → **Add**). Remote libraries in the normal libraries
list show the server's name as a caption and no folder paths; their Edit dialog has no paths and no previews
switch. The dashboard's status card lists connected servers and their state.

Kids profiles: remote titles carry `min_age` from the server's rating, and `allowUnrated` governs unrated ones,
exactly as for local titles. Library access per account and profile applies by library id as now.

## 7. Errors and edge cases

- A server that is down at sync: the library keeps its last catalogue; the dashboard shows "Can't reach <name>";
  the next scheduled sync tries again.
- A server that answers 401 at sync or play: `unauthorized`, "Sign in again" on the panel; nothing is pruned.
- A library removed on the server: the next sync finds it gone (`provider.libraries()` no longer lists it) and
  marks it in the panel as "No longer on <name>"; its items stay until the admin unticks it.
- Two servers with the same title: both appear (different libraries), as two local libraries would.
- The same Atomix connecting to itself (URL resolves to its own port): refused at connect, "That's this Atomix".
- URL normalising: `https://` assumed when no scheme; a trailing `/` dropped; `http://` allowed (a LAN box) with
  a note in the dialog that sign-ins travel unencrypted.
- A remote item's TMDB id matches a local film: they stay separate items (no merging this round).

## 8. Out of scope (deliberately)

Plex (next round); extras from remote servers; subtitles on the server's disk; two-way progress (pulling the
server's watched state into local profiles); Atomix API tokens (the Atomix connection uses a password); merging a
remote title with the same local title; remote playlists or collections.

## 9. Testing

Node: migration 11; `jellyfin.js` against a fake Jellyfin server (`fakeServer`): connect (token and user id,
401 → error), libraries mapping, item paging and `RemoteItem` shape (ticks, rating prefix, people, media
streams), image and stream URL/headers, progress calls; `atomix.js` against a second real Atomix started
in-process (`startAtomix` twice): connect, profile selection, items, stream with the cookie, re-login on 401;
`sync.js`: items land as `remote:` rows with `metadata_locked`, prune on the second sync, kids via
`OfficialRating`, the enrich pass and previews skip them; the proxy route with `Range` (206 and `Content-Range`
copied), 401 → 502 and status `unauthorized`; ffmpeg transcoding from a URL (the fake server serves a real small
file; skipped without ffmpeg); progress push rate limit; the servers API (admin only; secrets never returned;
delete cascades); `remoteSyncHours` scheduling.

Browser (`devtools/servers-ui.mjs`, with a mock Jellyfin on :9914 serving the dev clips): connect in Settings
(the two-step dialog with a remote), the server row and states, the remote library in the menu and on Home,
playing a remote film to the end on the TV, the kids profile seeing only the rated-safe remote title, Remove
taking everything away; `orbit-ui`, `orbit-sizes` (the panel at phone size), `orbit-a11y` (the panel's text),
older themes unchanged (their frozen data has no servers).

## 10. Dev data

`devtools/mock-jellyfin.mjs` on :9914: `AuthenticateByName` for `dallas`/`4321`, two views (Movies, TV Shows),
three movies and one show with two episodes whose streams are the dev VP9 clips, images drawn like the mock
TMDB's, `OfficialRating` `NZ-G` on two titles and `NZ-R16` on one, progress endpoints that record calls for the
harness to read (`GET /__calls`).
