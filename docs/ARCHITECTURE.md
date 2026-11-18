# Atomix architecture

Atomix is one Node.js process with no npm dependencies (the web app keeps two small libraries in its own folder — see "Preact without a build step"). It uses only built-in modules
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
                              data/atomix.db (SQLite) · data/images · data/cache · data/transcode
```

## Start-up

`server.js` checks the Node version and calls `createApp()` in `src/app.js`, which:

1. loads static config (`src/config.js`: env vars → `atomix.config.json` → defaults) and creates the data folders.
   Names from before the rename still work: `NODEFLIX_*` variables, `nodeflix.config.json`, and `nodeflix.db`,
   which is renamed to `atomix.db` after opening and closing it once (that folds the `-wal` file into it; if the
   `-wal` file is still there, another program has it open and the old name is kept). `config.notices` says what
   happened and is logged at start-up;
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
| `libraries` | name, type (`movies`/`tv`/`music`), folder list; a connected server's library has `server_id` and `remote_id` (its id there) and an empty folder list |
| `servers` | connected Jellyfin/Emby/Plex/Atomix servers: kind, name, url, username, `secret` (the API token — for Plex the server's own access token — or the password for an Atomix; never returned by any route), `remote_user_id` (for Plex the machine identifier), `status` (`ok`/`unreachable`/`unauthorized`) and `status_detail`, `last_sync`, `extra` (JSON, never returned: Plex keeps `{ accountToken, relay }`) |
| `items` | every movie, show, season, episode, artist, album, track and extra (`kind = 'extra'`, `extra_kind` trailer/featurette/…, `parent_id` the film or show, rating copied from it; `trailer` holds the TMDB/YouTube pick as JSON). `parent_id` builds the tree (episode → season → show, track → album → artist); `show_id` shortcuts episodes to their show and tracks to their album artist. Files store `size`/`mtime` (change detection) and `media` (ffprobe summary JSON). `certification` / `min_age` hold the age rating; tracks keep their own `artist`. |
| `progress` | per **profile** × item: position, duration, watched flag |
| `collections` / `collection_items` | film series from TMDB (`tmdb_id`, `parts` JSON with the whole series so missing films can be listed) and hand-made ones (`manual`); admins can `hidden` a TMDB one. Members are ordered items. |
| `lyrics` | one row per song: `source` (`file`, `tags`, `lrclib`, or `none` — a miss, retried after 30 days), `synced`, the text, the `.lrc` file's mtime |
| `lists` / `list_items` | per-profile lists: `kind` is `watchlist` (one per profile, made on first use), `video` or `music`; `shared` shows a playlist to the whole household. Items are ordered; a season adds its episodes. |
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
7. NodeFlix becomes Atomix: a stored server name of `NodeFlix` (the setup screen's suggestion) changes to `Atomix`.
8. The Orbit theme becomes the default: a stored server default of `arctic` changes to `orbit`. Themes people picked
   for their own profile are kept.
9. Lists and collections: `items.keywords` and `items.people` (JSON; people are `{ name, role }` with role
   `director`/`creator`/`cast`, or a single `none` entry once a title has been looked up and has nobody), plus the
   `collections`, `collection_items`, `lists` and `list_items` tables and a unique index for one Watchlist per profile.
10. Trailers, extras and lyrics: `items.extra_kind`, `items.trailer`, the `lyrics` table, and `media_jobs` rebuilt so it can
    record the `thumb` job (a still frame for each extra).
11. Connected servers: the `servers` table, `libraries.server_id` (cascade) and `libraries.remote_id`, `items.remote_id`
    with an index on (`library_id`, `remote_id`), and the `remoteSyncHours` setting.
12. Plex: `servers` rebuilt so `kind` allows `plex`, plus `servers.extra`; `items.remote_updated` (the server's own
    "last changed" time, so unchanged Plex titles skip their detail request). Setting `plexClientId` (made once).
13. Casting: the `cast_devices` table (devices an admin added by address: `kind` chromecast/dlna, `name`, `address`),
    and the `castEnabled` / `castBaseUrl` settings.
14. Indexes for the lookups that run per deleted item / per deleted profile.
15. Live TV: `live_channels` (per source and key: number, name, groups, logo, radio, catch-up, guide id, `hidden`),
    `live_programmes` (per channel, indexed by start), `live_favourites` (per profile, ordered), `live_kids_groups`
    (the groups a Kids profile may see) and `live_sources` (each source's last refresh, counts, warning and error).
16. Encrypted Live TV channels: `live_channels.drm` (the system name, NULL = plain).
17. Live TV: a channel missing from a refresh is hidden (`missing_since`) and deleted after 7 days.
18. Recordings: `live_series_rules`, `live_recordings` (their own copy of the programme's fields) and
    `live_programmes.repeat`.
19. Play history and smart playlists: `plays` (one row per playing: started/updated, listened `seconds`, `counted`,
    `client`), `user_ratings` (per profile: `stars` 1–5, `favourite`), and `lists` rebuilt so `kind` may be `smart`
    with `media` (`music`/`video`) and `rules` (JSON).
20. Music apps and scrobbling: `app_passwords` (per profile; kept as they are, since Subsonic's token sign-in needs
    them), `profile_scrobblers` (ListenBrainz token / Last.fm session key, last sent, last error, stopped) and
    `scrobble_queue`.
21. The activity log: `activity` (time, type, user, profile, sentence, address), indexed by time and by type.
22. Player extras and editing: `play_settings` (per profile and title: `audio_delay`, `subtitle_delay`; a row with
    both at zero is deleted), `items.locked_fields` (JSON list of hand-edited fields) and `items.studio`.
    (Migrations 23-29 are described in the sections below; 30-33 (recap markers, app links, clips, colours) in CLAUDE.md and the card motion note.)

34. The Jellyfin API: `jellyfin_tokens` (per device: sha256 of the token, the app password it belongs to, device and
    client names, created and last used), deleted with its app password.

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

### Lists, collections and picks (`src/lists.js`, `src/collections.js`, `src/picks.js`)

`Lists` owns the Watchlist and playlists (create, rename, share, add an item or a season, move, remove) and
answers `nextIn(listId, afterItemId)` for the player's **Up next**; `visibleTo(viewer)` is a profile's own lists
plus shared ones. `Collections` stores film series as metadata finds them (`upsertTmdb` from a movie's
`belongs_to_collection`, with the series' parts fetched once per run) and hand-made ones, and `get(id)` splits a
series into the films you own and the ones you don't. `Picks` scores every visible title against a seed title
(same collection 5, shared keyword 3, same director or creator 3, shared cast 2, shared genre 1, same decade 1;
at least 3 to count), unwatched first, cached ten minutes per profile; Home asks for two seeds from the profile's
recent progress and clears the cache after every scan. Keywords, people and the collection come from TMDB with
the rest of a title's metadata (`append_to_response`); libraries scanned before 0.9.0 are filled in by
`MetadataManager.enrichMissing()`, a low-priority pass that starts a few seconds after boot and after each scan,
touching only titles with a TMDB id and no `people` yet.

### Extras, trailers and lyrics (`src/library/parser.js`, `src/lyrics.js`, `src/extras/thumbs.js`)

`extraKindOf(file)` names a Kodi-style extra from its folder (`Featurettes/`, `Deleted Scenes/`…) or its name's suffix
(`-featurette`, `-trailer`…). The scanner walks those folders now, keeps the extras aside, and after the films and
episodes are known gives each one an owner (`Scanner.ownerOf`): the single film in the same folder, a film whose stem
starts the extra's, or the show whose folder it sits under; orphans are dropped. Extras are probed like any video,
never matched against TMDB, carry their owner's rating, and only appear on the owner's page (`Library.extrasOf`) — every
other query whitelists kinds. The background runner's third job, `thumb`, takes one frame a tenth of the way in
(`makeThumb`) for extras without a picture. A film's TMDB trailer comes with the metadata it already fetches (`videos`
appended; `pickTrailer` prefers official, the metadata language, English, then the newest) and is stored on the item;
`GET /api/items/:id` answers `trailer` as `{ kind: 'local', itemId }` (a trailer file the viewer may see) or
`{ kind: 'youtube', key }` (never for kids, and only with `onlineTrailers` on). `Lyrics.get(track)` looks beside the
song (`.lrc`, `.txt`), then in its tags (`media.tags.lyrics`, kept by `probe.js`), then asks LRCLIB once (artist,
title, album, length; `onlineLyrics` switch; one request in flight per song); `public/js/lrc.js` parses LRC for both
the server and the browser.

### Connected servers (`src/remote/`)

`provider.js` is the base every kind implements — `connect`, `libraries`, `items` (an async generator per kind of
item, paged), `imageUrl` / `streamUrl` (a URL plus the headers that carry the token), `reportProgress`, `ping` —
with `request()` turning the far server's 401 into an `HttpError(401)` and anything else into a 502.
`jellyfin.js` covers Jellyfin and Emby (the same API; Emby wants `X-Emby-Authorization`), `atomix.js` another
Atomix (signs in with the stored password, keeps the session cookie per server in memory, picks the first non-kids
profile without a PIN, and signs in again once on a 401). `index.js` names remote items: `path` is
`remote:<server id>:<remote id>`, so everything that keys on a path (`isRemotePath`) can tell them apart, and
`resolveSource()` gives playback the stream URL and headers. `sync.js` runs when the scanner meets a library with
a `server_id`: ping (an unreachable or unauthorized server marks itself and leaves the catalogue alone), check the
library is still on the server (if not, `options.remoteGone` is set and nothing is pruned), then walk movies or
show → season → episode or artist → album → track through `scanner.upsertItem` with `metadata_locked = 1`, the
server's rating mapped by `certToAge` (children inherit their show's), and poster/backdrop/logo stored as the
server's image URLs; the usual `prune` removes what the server no longer lists. The scanner keeps a second timer
(`remoteSyncHours`) so folder scans and server syncs run on their own schedules; previews, intros, thumbs and
TMDB enrichment all skip `remote:` paths.

Playing: `/api/items/:id/file` is a Range-forwarding proxy (`proxyRemote`) with the token added server-side, and
`PlaybackManager.create()` takes a `source` so ffmpeg reads the server's stream URL (`-headers … -reconnect …`)
when a conversion is needed; a 401/403 from the server at play marks it unauthorized and answers 502. Images are
fetched with the token and cached by `ImageCache` (named by the response's content-type when the URL has no
extension). `progress.js` listens to `playback:progress` and pushes position (at most every 10 s per item) and
watched state back through `reportProgress`. The servers API (`src/api/servers.js`) is admin-only, answers 400
(never 401, which the client reads as this session ending) when the far server refuses a sign-in, refuses to
connect this Atomix to itself (`isSelf`: its own port on a loopback name, the configured host, the machine's
hostname or any interface address), and names a new library "`<name> (<server>)`" when the name is already taken.

### Plex (`src/remote/plextv.js`, `src/remote/plex.js`)

`plextv.js` talks to plex.tv (base `ATOMIX_PLEXTV_BASE`): `createPin` / `checkPin` for the link code entered at
plex.tv/link, `resources` (the account's servers, each with its own access token and addresses), `user`, and
`chooseConnection` (local, then remote https, then other direct, then relay; each tried with `/identity` and a
matching machine id). Every call carries `X-Plex-Product: Atomix`, the version and `plexClientId`. The servers API
keeps pins in memory (30 min) with their token, so the browser only sees the code and server names; `POST
/api/servers { kind: 'plex', pinId, serverId }` stores the server's token, machine id and `extra`, and Plex
reconnect takes a fresh `pinId`. `PlexProvider` pages sections (`X-Plex-Container-Start/Size`, to the first empty
page or `totalSize`), walks `/children` for seasons, episodes, albums and tracks, maps `contentRating` (`gb/15` →
`GB:15`, US labels as they are), and keeps Plex's own `thumb`/`art` paths (with their timestamps) as image URLs; an
absolute URL on another host is used as-is and never gets the token (`imageHeaders`). `details()` reads a title's
real tracks from `/library/metadata/:id`, and the sync only asks when a title is new, its `updatedAt` moved, or it
was never detailed. Streams are the part key (Plex's original file); reports are `/:/timeline` (playing, paused,
stopped) and `/:/scrobble`. A sync whose ping can't reach the server asks plex.tv for the same machine's addresses
once and saves a new `url` if one answers.

### For every connected server (v0.12.0)

Items carry the server's added date (`added_at`; rows from before 0.12 are corrected once). Image URLs carry the
server's version (Plex's timestamp, Jellyfin's `?tag=`, the far Atomix's `?v=`), so a changed picture is a new URL;
the sync `forget`s the superseded cache file and Remove forgets all of the server's. `src/remote/progress.js`
(`attachReporter`) turns `playback:start`, `playback:progress` and `playback:stop` into `reportStart`,
`reportProgress` (at most every 10 s per title; watched at once) and `reportStop` (exactly once per started
session, with its last position), queued per server and never awaited by the request that triggered them. Remove
stops the server's live sessions (`server removed`) before deleting the row.

The proxy (`proxyRemote`, v0.13.0) sends a HEAD upstream as a HEAD, always asks for `accept-encoding: identity`,
passes a 416 through with its `content-range`, and gives up with a 504 "<server> didn't answer in time" when the
headers take more than 15 s (`core.remote.proxyHeaderTimeoutMs`), aborting the upstream request. Redirects go
through `fetchFollowing` (`src/remote/provider.js`): the same origin is followed with the sign-in (at most 3 hops);
a stream sent to another origin is a 502, and an image on another origin (a CDN) is fetched without any of the
server's headers (`ImageCache.download` uses the same rule). The reporter coalesces: a progress report still
waiting in a server's queue takes the newer position, so a hung server gets the latest one and then the stop.
Plex timeline calls carry `X-Plex-Session-Identifier: <session id>` and `X-Plex-Client-Identifier:
<plexClientId>-<session id>`, so two people on one title are two players there.

v0.14.0: the reporter's throttle and coalescing are keyed per playback session (`sessionId || item`), and a pending
watched report is never replaced by a plain one. On a film's refresh TMDB's series parts and artwork update the
collection (our name and overview stay) and a film TMDB no longer lists in a series is detached; a forced refresh
skips the TMDB response cache. The scan prunes a show left with only extras (its episodes went) and re-reads a
re-tagged song's lyrics (its `none`/`tags` lyrics row goes). A `lyrics` background job re-probes songs probed before
0.10 (no `tags.lyrics` and no `tags.lyricsChecked`) once; every probe now writes `lyricsChecked`.

## Casting (`src/cast/`, `src/api/cast.js`, v0.13.0)

Atomix drives the TV; the browser is only a remote. Everything is hand-written over node:tls, node:http and
node:dgram.

- **Finding devices** (`mdns.js`, `ssdp.js`, `udp.js`, `devices.js`): one mDNS PTR question for
  `_googlecast._tcp.local` (a small DNS reader for PTR/SRV/TXT/A with name compression; TXT `fn`/`md`/`id`) and an
  SSDP `M-SEARCH` for `MediaRenderer:1`, whose `LOCATION` descriptions give the AVTransport, RenderingControl and
  ConnectionManager control URLs (resolved against `URLBase`, else the location). `udpTransport` opens one socket per
  IPv4 interface; the tests inject fakes. `CastDevices` keeps the result 5 minutes and adds the `cast_devices` rows
  and, for development only, `ATOMIX_CAST_DEVICES=chromecast:host:port#Name,dlna:<url>#Name`
  (`ATOMIX_CAST_DISCOVERY=off` turns the search off).
- **Chromecast** (`protobuf.js`, `castv2.js`, `chromecast.js`): TLS to port 8009 without certificate checks (local
  devices only), 4-byte length-framed `CastMessage`s, request ids, heartbeat PING/PONG. It launches the Default Media
  Receiver `CC1AD845` (or joins it), `LOAD`s the cast link with text tracks (WebVTT links) and artwork, and maps
  `MEDIA_STATUS` / `RECEIVER_STATUS` to `{ state, position, duration, volume, idleReason }` (`finished`, `stopped`,
  `error`, `taken`).
- **DLNA** (`dlna.js`): SOAP `SetAVTransportURI` with DIDL-Lite (retried once with empty metadata on a fault),
  `Play`/`Pause`/`Stop`/`Seek REL_TIME` (fault 710 → `seekSupported = false`), RenderingControl volume, and the
  ConnectionManager `Sink` list for formats. A 2 s poll of `GetPositionInfo`/`GetTransportInfo` (`GetMediaInfo` every
  fifth) gives the same status shape; a changed `CurrentURI` is `taken`, still STOPPED 10 s after a load is `error`, and
  two unreachable polls emit `close`.
- **Formats and the address** (`caps.js`, `baseUrlFor`): `castCaps(device)` gives `decide()` its caps (Chromecast:
  mp4/webm, h264/vp8/vp9, plus hevc and HDR on Google TV/Ultra; DLNA: from the Sink list, falling back to
  mp4/h264/aac). DLNA always gets subtitles burned in (picture ones with `overlay`, text ones with libass from a .vtt
  Atomix writes) and converted streams carry `transferMode.dlna.org` / `contentFeatures.dlna.org`. The address a TV
  fetches from is `castBaseUrl` (setting, then `ATOMIX_CAST_BASE_URL`), else the IPv4 address on the TV's own subnet,
  else the first private address not on a docker/bridge/VPN interface, else none.
- **Cast links** (`tokens.js`): 32 random bytes, URL-safe, for one item (and its show/album artwork) or one playback
  session, accepted only as `?cast=` on the file, stream, HLS, subtitle and image routes (which then send
  `Access-Control-Allow-Origin: *`), revoked when that playback session stops or the cast ends, 12 h at most. AirPlay
  asks `POST /api/playback/:sid/cast-link` for one for the player's own session.
- **Sessions** (`sessions.js`, `CastManager`): one per device and owned by the profile that started it. A start runs the
  playback checks, makes a playback session with the device's caps (`clientIp: 'cast'`, `castDevice`), issues a link
  and loads it from the resume point. Status updates save progress through `recordProgress`
  (`src/library/progress.js`, shared with the player's progress POST) at most every 10 s and at the end, heartbeat
  the playback session, run Up next (10 s, the profile's autoplay setting) and music queues, and end on a takeover,
  an error or a device lost for 30 s. Seeking a converted stream, choosing a subtitle that must be burned in, or
  changing the audio track restarts the stream at the current time with an offset; the old playback session (and its
  ffmpeg and links) is stopped after the new one is loaded. An ended session leaves a note (`taken`, `lost`,
  `finished`, `error`, `stopped`) for 2 minutes. Shutdown stops every cast (≤ 3 s), and an admin's Stop on the
  dashboard row ends the cast too.
- **Routes**: `GET /api/cast/devices` (`baseUrl` and `?refresh=1` for admins only; everyone gets the cached list),
  `POST`/`DELETE /api/cast/devices` (admin), `POST /api/cast/sessions`, `GET /api/cast/sessions/current` (204 when
  there is nothing), `POST /api/cast/sessions/:id/:command`.
- **v0.14.0 polish**: a session keeps its subtitle list, previews and queue titles from the load (`subtitlesChanged`
  refreshes them after a download); links are revoked the moment a cast ends; a DLNA TV that refuses Seek gets a
  converted restart from the resume point; a DLNA poll from before a load is dropped (`generation`); a subtitle that
  arrived after the load restarts a Chromecast with the new tracks, and the chosen subtitle/audio is recorded only
  once the restart took; a link whose profile was deleted is refused and its cast stopped; a `.vtt` written for a
  start that fails is deleted and `cast-subs/` is emptied at startup; `tools.filters.subtitles` (libass) gates
  burning text subtitles for DLNA ("This ffmpeg can't draw subtitles onto video (it needs libass)").

## Live TV (`src/live/`, `src/api/live.js`, `plugins/iptv-simple/`, v0.16.0)

A plugin registers a **live source** (`api.registerLiveSource`, see `docs/PLUGINS.md`); the core owns everything else.

- **`LiveRefresher`** (`src/live/refresh.js`) calls each source's `refresh()` on its own timer (`refreshHours()`, 6 h by
  default; sooner when the stored guide ends within 24 h; 15 min after a failure) and when its plugin's settings change
  (a change during a run queues one more run). Zero channels is an error; `programmes: null` or an empty list keeps the
  old guide. Unmatched channel names stay in memory for the Settings card.
- **`LiveStore`** (`src/live/store.js`) upserts channels by (source, key) and replaces programmes in 4000-row
  transactions with pauses between them, new rows before old ones go, so a 100 000-programme guide never stalls the
  server. `nowNext` reads at most two rows per channel within two days.
- **`LiveStreams`** (`src/live/stream.js`) starts a channel or a catch-up programme: a synchronous **reservation**
  against the source's `maxStreams()` (taken before any await, so two presses can't both pass; the same profile's own
  older stream on that source is stopped instead of refusing it, otherwise 409 with who holds the streams), then
  the source's `stream()` / `catchup()` (only `http(s)` addresses), an ffprobe, and `playback.create` with
  `session.live = { kind: 'live'|'catchup', sourceKey, channelId, channelName, programmeId?, offset? }`.
- **Playback** gives a live input `-user_agent`/headers, reconnect flags, `-rw_timeout` and a protocol whitelist;
  live HLS keeps a 6-segment sliding window. Three drops in two minutes are retried (the ping carries the notice);
  the fourth ends the session with "This channel stopped sending video." Provider URLs are redacted from logs.
- **Routes** (`src/api/live.js`) filter every list through the viewer: a Kids profile sees only its ticked groups
  (none ticked: no Live TV at all). Logos and programme pictures go through `/api/live/…/logo|image` (downloaded
  once, or read only from a source's `imageRoots()`). The routes object is shared as `core.live.routes` for Home's
  "On now" row (`homeCards`) and casting (`visibleChannel`, `visibleChannels`).
- **Casting** (`src/cast/sessions.js`): a cast with `live` plays through `LiveStreams` with the cast pass-throughs
  (`castDevice`, DLNA headers, `keepUntilLoaded`); channel up/down re-check visibility; live can't seek; nothing is
  written to progress.
- **Browser**: `public/js/live.js` (fetching, captions, the zap order and `zapQueue`, which coalesces quick channel
  presses and stops a start that a newer press overtook), `views/live.js` (channels), `views/guide.js` (grid and
  programme sheet), the player's live/catch-up modes, `music.playLive()` for radio.

### Tuners, pause/rewind and recordings (`src/live/tuner.js`, `timeshift.js`, `recordings.js`, `recorder.js`, `scheduler.js`, v0.19.0)

- **`TunerPool`** keeps one ffmpeg per channel (key `source\0channel`), copying the provider's stream without
  converting into HLS fMP4 pieces under `<data>/timeshift/<id>/run-<n>/` (a run per connection; a drop starts a new
  run, three in two minutes end it with "This channel stopped sending video."). Holders are viewers, conversions and
  recordings; a tuner closes 30 s after its last holder. Pieces older than 30 minutes are deleted. `LiveStreams`
  counts a tuner once against `maxStreams()`; idle tuners close when a slot is granted.
- **Watching**: a browser that plays the codecs as they are gets Atomix's own dynamic DASH manifest
  (`/api/live/tuner/:id/manifest.mpd`, a Period per run, `timeShiftBufferDepth` 30 min, UTCTiming from Atomix) and
  plays it with `public/js/dash/player.js` in clear mode; others get a conversion reading the tuner's local playlist,
  rewound by restarting it `behind` seconds back. `ATOMIX_LIVE_TUNERS=off` restores the old per-viewer path.
- **Recordings** (migration 18: `live_recordings`, `live_series_rules`, `live_programmes.repeat`): the `Scheduler`
  ticks every 15 s. A due recording takes a slot with `LiveStreams.takeSlotFor` (the newest viewers on other channels
  are stopped with "Stopped to record <title>"; recordings are never stopped; one in its late minutes gives way to the
  next) and holds the channel's tuner (`kind: 'recording'`). The `Recorder` copies the pieces whose wall-clock time is
  inside the padded window (the buffer included) into `<recordingsDir>/.work/<id>/part-<n>/`, and at the end writes a
  playlist per part and joins them with ffmpeg's concat demuxer `-c copy` into `<Show>/<Show> - S01E02 - <Title>.mkv`
  (or `<Show> - YYYY-MM-DD HH-MM.mkv`) with a `.nfo`; a failed join keeps the work folder. Channels the tuner can't
  buffer use a `DirectRecorder` (its own ffmpeg to MPEG-TS). Finished files are added to the "Recordings" TV library
  (made on first use) and scanned. On start `recover()` saves interrupted recordings and continues them as part 2.
  Below 5 GB free nothing starts and a running one is kept as far as it got. Series rules run after every guide
  refresh (`LiveRefresher.onRefreshed`), 7 days ahead, skipping repeats when "new episodes only" and anything already
  recorded or scheduled (the same airing, the same episode of the show, or the same title + episode title).
- **Routes** (`src/api/recordings.js`): record a programme or a series, the lists, stop, delete, rule edits; Kids get
  403. The guide's programmes carry `recording` (matched by channel + start, since programme ids change every refresh)
  and the programme sheet `canRecord`, `recordingId`, `ruleId`. Kids' library queries hide recordings from channels
  outside their groups (`Library.visibility`).
- **Browser**: the sheet's Record actions and the red dot (`views/guide.js`, `views/live.js`), `views/recordings.js`
  (Live TV → Recordings), Settings → Live TV → Recording, and the Dashboard's "Tuners in use" and "Next recordings".

### Encrypted channels (`src/live/drm.js`, `public/js/dash/`, v0.17.0; tidied in v0.18.0)

v0.18.0: a manifest re-read refused 401/403/410 asks the source for a fresh address once; at most 32 provider origins
per manifest (64 remembered per session, reused when the last two manifests don't name them); the provider's own
UTCTiming clock is used (fetched server-side, cached 60 s); credentials only go to the manifest's own origin; inherited
SegmentBase/SegmentList; `manifest_params`/`stream_params` added to addresses; `license_data` and
`server_certificate` reach the browser in the play reply. In the browser each SourceBuffer's work runs through one
queue, only same-origin addresses are fetched, a static manifest stops refreshing and ends with "This programme has
ended", and the keys are detached before a plain channel loads.

ffmpeg can't decrypt Widevine/ClearKey DASH, so the browser plays those channels itself with Encrypted Media
Extensions; Atomix never holds a Widevine key.

- **IPTV Simple** (`plugins/iptv-simple/drm.js`) reads Kodi's `#KODIPROP` lines: `license_type` + `license_key`
  (`url|headers|post data|response`; post `R{SSM}`/`b{SSM}`/`B{SSM}` or a template; response raw, `B`, `J<path>`,
  `JB<path>`, `BJ<path>`, `HB`), `drm_legacy`, `manifest_headers`, `stream_headers`, ClearKey keys written in the
  playlist. `live_channels.drm` (migration 16) marks the channel; `stream()` returns `drm: { system, licence }`.
- **`LiveDrm`** opens an **encrypted session** instead of an ffmpeg one (the play reply has `delivery: 'drm'`,
  `manifest`, `licence`, `keySystem`). It counts toward the source's stream limit and the account's 4 streams, is
  pinged/stopped at `/api/live/drm/:sid/ping|stop`, reaped after 2 idle minutes and listed on the Dashboard.
- **The relay** (`/api/live/drm/:sid/manifest.mpd | r/<n>/… | licence | time`): the manifest is fetched fresh and
  rewritten — every address becomes `r/<n>/<path>` where `<n>` is a provider origin the session keeps, BaseURLs are
  folded into each representation's template, licence URLs, reports, xlink and other DRM systems' data are dropped,
  UTCTiming points at Atomix's clock, and no provider host is left. Segments go only to the origin named; every hop
  (redirects included) is checked by `relayCheck` — a manifest on the internet can't reach this machine or the home
  network, by address or by DNS name. The licence is forwarded in the playlist's request/answer form (ClearKey keys
  from the playlist are answered by Atomix). Relays end when the browser goes or the session stops.
- **The player** (`public/js/dash/`): `xml.js`, `mpd.js`, `timeline.js` (the live window, bounded), `abr.js` (quality)
  and the pure parts of `eme.js`/`player.js` are tested in Node; `DashPlayer` drives one MediaSource (a SourceBuffer
  each for video and audio), keeps 10–30 s ahead, re-reads a live manifest, jumps to the live edge after a stall and
  turns failures into one sentence. `views/player.js` uses it for `delivery: 'drm'`; Quality offers Auto + levels.

**Phones (v0.27.0 Plan B).**
- **Before starting** an encrypted channel, `dash/support.js` `protectionVerdict(system)` decides from iOS, the page's security and a cached `requestMediaKeySystemAccess` probe. An iPhone with a Widevine channel hears "This channel is encrypted with Widevine, which iPhones can't play."; a browser without Widevine, "This browser can't play this channel's protection."; a non-Safari browser with a FairPlay channel, "…plays in Safari on Apple devices". The protection comes from the player's channel list or, opened from Live TV, the guide or search, from the last list `live.js` fetched (`protectionOf`); then no stream is asked for. Only a bare link with neither checks the reply's key system and stops the stream at once. A refusal also stops what was playing (sound, stream and its place in the provider's limit).
- **Android polish**, live channels on touch devices only (`views/phone-live.js`): a Screen Wake Lock while playing (released on pause and leave, taken again when the page is shown), and `screen.orientation.lock('landscape')` in full screen. On mobile data (`saveData` or `cellular`) `DashPlayer` keeps 10 s ahead instead of 30 (`aheadFor`).
- **Refused quality:** key statuses `output-restricted`/`usable-in-future` (`eme.js` `restrictedKids` → `onRestricted`) make `DashPlayer.restrict()` drop those levels (`playableLevels`), once saying "This phone's protection won't play HD; playing a lower quality". No level left is the usual "won't play".
- **FairPlay** (an Atomix extension: `license_type=com.apple.fps`, the same `license_key` grammar plus `{CONTENTID}`, `server_certificate` an address or base64; HLS):
  - `live_channels.drm = 'fairplay'`;
  - `src/live/hls-relay.js` `rewritePlaylist` turns every address in the master and media playlists into `/api/live/drm/<sid>/r/<n>/…` (at most 64 origins, never reused), keeps `skd:`/`data:` URIs, and drops other systems' key lines, session data and content steering;
  - the routes: `master.m3u8`; `r/…` (playlists, recognised by type or `.m3u8`, are rewritten); `certificate` (fetched by Atomix at most 64 KB, kept on the session, or decoded); `licence?contentId=` (SPC in, CKC out in the playlist's forms);
  - in Safari, `dash/fairplay.js` `playFairPlay` sets the certificate, then the keys, then `video.src` (giving up quietly if a zap made it stale); on `encrypted` (`skd`) it asks the relayed licence. A video error or end on a FairPlay channel restarts it like DASH (3 in 2 minutes), then "This channel's stream couldn't be read";
  - every `…URI="…"`/`X-ASSET-LIST` attribute on any tag is relayed (interstitials included), plain comment lines are dropped, and a body with a vague type (`application/octet-stream`, `text/…`) that starts with `#EXTM3U` is rewritten too.

### Several systems per channel (v0.28; `src/live/drm.js`, `src/api/cast.js`, `public/js/dash/support.js`, `public/js/dash/playable.js`)
- A channel can offer several key systems (`live_channels.drm` is a comma-separated list, the API returns an array; the
  old single name still reads). The device probes which of FairPlay, PlayReady, Widevine and ClearKey it has
  (`support.js` `availableKeySystems`, secure page only, in its own order: Safari FairPlay first, Edge PlayReady first)
  and sends them with the play request as `keySystems`. The **server chooses** (`chooseSystem`): the first of the device's
  list the channel offers. None in common is a 409 with one sentence, before any provider is asked or stream reserved. A
  page that sends no list gets the channel's first system, as in v0.27. A single-system channel behaves as before.
- Only the chosen system is kept: the source is asked for that system's address and licence
  (`stream(key, { system })`), and the relay's manifest keeps only that system's ContentProtection.
- **PlayReady** joins the DASH relay. Edge sends the licence challenge wrapped in a `PlayReadyKeyMessage` (UTF-16 XML);
  the relay unwraps it, posts the challenge to the provider with the wrapped Content-Type and SOAPAction plus the
  playlist's headers, and returns the answer unchanged. A raw challenge passes through; a broken message is posted as
  it is, never a 500. Nothing is decrypted on the server.
- **The licence address is always Atomix's.** In the manifest's `mspr:pro` header (and PlayReady pssh) the LA_URL is
  rewritten to Atomix's licence address (the browser's relay address, or a cast link for a TV) and LUI_URL is removed;
  an unreadable header is dropped. Chromecast manifests also get `dashif:Laurl`. Casting prefers Widevine, then
  PlayReady, then ClearKey; FairPlay can't be cast.
- **Hiding unplayable channels.** `playable.js` `channelPlayable(drm, device)` says whether this device has any of the
  channel's systems (an iPhone or iPad without FairPlay/ClearKey is known without asking; elsewhere from the probe, on a
  secure page only). Live TV, the guide, Home's On now, search and the player's list and zapping hide channels that
  can't play, with a per-device switch to show them dimmed. Opening one shows a message card (the sentence, Watch on
  TV, and Open <app> when the channel has a provider link; Kids profiles get no link). It starts no stream.

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

v0.15.0 details (`decide()` / `buildFfmpegArgs()`): an HDR or Dolby Vision source for a sink without HDR is tone-mapped
(`scale` first, then zscale+tonemap with the probe's colour tags, or `libplacebo`; neither → a plain 422); `detectTools`
runs a one-frame libplacebo test since "listed" isn't "usable". Surround audio is mixed to stereo with a `pan=` matrix that
keeps the centre at full strength; audio the sink can play is copied even in transcode mode; a video without audio maps
none. Progressive MP4 fragments every 0.5 s; HLS uses 2 s segments and `-readrate 1.5`; hardware encoders force IDR
frames on segment boundaries. Software conversion is capped at `maxSoftwareHeight`. A remux that starts mid-file asks
ffprobe for the keyframe at or before the time (`src/stream/keyframes.js`) and reports that as the session's `start`.
Embedded text subtitles are extracted into the cache by a background job (`subtitles`, one ffmpeg per file) and on demand
within the ffmpeg pool; libass fonts are warmed up once at startup (`src/stream/warmup.js`). `maxTranscodes` counts
every live ffmpeg; an account holds at most four playback sessions.

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
- **Preview clips and dominant colours** (card motion v2). The `clip` job (`extras/clips.js`, migration 32 lets
  `media_jobs` record it) makes a 5 s silent H.264 clip per film or episode into the previews folder (`clip.mp4`,
  kept when sheets are regenerated; HDR needs zscale/tonemap, otherwise "none"). It follows the admin switch
  `cardClips`; the previews manifest carries `clip` and `clipUrl`, and `GET /api/items/:id/clip` is hidden from Kids.
  Dominant colours (`library/colors.js`, migration 33 `items.colors`) are worked out lazily when `sendArtwork`
  serves a poster or backdrop: an 8 x 8 ffmpeg downscale, saturation lifted, at most two at a time, never waited on.
  Cards then carry `tint` and `tintWide` (null until known); editing artwork or refreshing metadata resets them.
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

## Play history, stars and smart playlists (`src/library/plays.js`, `userratings.js`, `smart.js`, v0.20.0)

Every progress report for a film, episode or song (the player, the music player every 30 s, casts, music apps)
goes to `Plays.report`. A report within 6 hours of the last one carries on its play; a finished title started again
from the top is a new play. Only listened time counts: a report adds at most the wall time since the previous one
(plus 5 s), and nothing after a pause. A song is counted at half its length or 4 minutes; a film or episode when
it's watched. `onStarted` / `onCounted` feed the scrobblers. `Library.withProgress` adds the viewer's `playCount`,
`lastPlayed`, `stars` and `favourite` to every item. A smart list stores only its rules; `smartRows` turns them into
one SQL query over the viewer's visibility each time the list is opened or played (`Lists.seeds` keeps a random
order steady between opening a list and its Up next).

## Music apps (`src/subsonic/`, v0.20.0)

`/rest/<method>[.view]` is handled before `/api/` by `Subsonic.handle`: query or form parameters, an app password on
every request (`u`+`p`/`enc:`, `u`+`t`+`s`, or `apiKey`; failed sign-ins share the web's lockout), and answers in
Subsonic's envelope (XML by default, `f=json`, `f=jsonp`) with HTTP 200. The app password's profile is the viewer, so
library access and Kids rules apply to every method. Ids carry their kind (`ar-`, `al-`, `tr-`, `pl-`, `sp-`, `mf-`);
song paths are made up from artist/album/file name. `stream` sends the original with ranges when it fits, else
converts to MP3/Opus in a slot of the ffmpeg pool; a connected server's songs are passed through. Stars, ratings,
scrobbles and playlists are Atomix's own data.

## Jellyfin apps (`src/jellyfin/`, v0.30)

`/jellyfin/…` is handled before `/api/` by `Jellyfin.handle`, like the Subsonic handler: its own small router, answers in
Jellyfin's PascalCase JSON with Jellyfin's status codes and `{}` as every error body. Paths match without regard to
capitals and with or without an `/emby` prefix; a route with fewer `{params}` wins.

- **Signing in.** An app (Infuse) signs in at `POST /Users/AuthenticateByName` with the username and an *app password*
  (the same ones Subsonic apps use; Settings → Profile → Apps). The answer carries a 64-hex token, kept only as its
  sha256 in `jellyfin_tokens` (migration 34, one row per device, tied to the app password; revoking the password ends its
  tokens). The token comes in the `Authorization: MediaBrowser Token="…"` header, `X-Emby-Token`, or `api_key`/`ApiKey`
  in the query (Infuse puts it in image and stream addresses). Failed sign-ins share the web's lockout. The token's app
  password names the profile, and that profile's viewer decides what is visible: a hidden title is 404 everywhere (list,
  item, image, stream, download, PlaybackInfo, played and favourite writes), and Kids rules apply.
- **Ids.** Jellyfin ids are 32-hex GUIDs: `a70a1f00` + an 8-hex kind code (item, library, user, person, server) + 16 hex
  (`ids.js`). A person's is the first 16 hex of sha1(name). Dates are in ticks (1 s = 10,000,000).
- **Routes.** `system.js` (public info, ping, sign-in, Users/Me, view stubs, Genres), `browse.js` (views, Items, Resume,
  Latest, NextUp, Seasons, Episodes), `routes.js` (registers every route on the one handler), `media.js` (images, PlaybackInfo, video stream with ranges,
  subtitles, Download), `userdata.js` (played, favourite, Sessions/Playing/Progress/Stopped/Ping and PlayingItems),
  `shapes.js` (the item, media source and user JSON).
- **The one-slot rule.** A device (token) holds one stream slot in `JellyfinSessions` (`sessions.js`), shared with web
  playback, Live TV and casting toward the account's cap (`MAX_SESSIONS_PER_USER`, 4). Every range read of that device
  shares the slot and reading another title moves it, so pre-reading or jumping to the next episode never gets 429
  while the account has room. A slot ends at Sessions/Playing/Stopped, Sessions/Logout, or 120 s of silence.
- **Connected servers.** A connected server's title plays through Atomix; no field carries the far address, token or a
  real path.
- **Downloads.** `Items/{id}/Download` sends the original file; a Kids profile gets 403 (after the visibility check,
  so a hidden title is still 404) and a connected server's title is 400, so `CanDownload` is false for both.
- **Trace.** `ATOMIX_JELLYFIN_TRACE=1` logs each request's path and query with token values as `***`. Tokens, app
  passwords, file paths and connected-server addresses never reach a response body or a log line (`redactUrl`,
  `redactError`).
- Checks: `test/jellyfin-*.test.js` and `devtools/jellyfin-smoke.mjs` (refuses port 8787).

## Scrobbling (`src/scrobble/`, v0.20.0)

`Scrobblers` listens to `Plays` for songs: "now playing" is sent at once and never queued; a listen is written to
`scrobble_queue` first, then sent oldest first per profile and service. Network errors, 5xx and rate limits wait
2, 4, 8… minutes (at most 6 hours) for up to 14 days; a refused listen is dropped with its message; a refused sign-in
stops that service for the profile ("Connect again"). Last.fm signs in on last.fm with a one-use, 10-minute state
bound to the profile; calls are signed with the admin's shared secret.

## Household (`src/together.js`, `src/quickconnect.js`, `src/activity.js`, `src/stats.js`, v0.20.0)

**Watch together** rooms live in memory (`Rooms`): a title, a position at a time, playing/paused, and up to 8
members (each its own playback session). Players hold `GET /api/together/:code/events` (Server-Sent Events) and post
`play`/`pause`/`seek`/`ready`/`buffering`/`ended`/`next`/`leave`. Play and seek wait for every connected member's
`ready` (at most 10 s); a member more than 2 s out is seeked by its own player. The player sends the person's own
presses (not the video element's events, which also fire when a converted stream restarts). A member gone 30 s is
dropped while others remain; a room nobody is connected to closes after 10 minutes. **Quick Connect** keeps waiting
codes in memory; the TV polls with a private token and gets a session cookie when someone signed in approves its code
(constant-time compare, 5 wrong codes in a row from one account cancel every waiting code, wrong codes count toward
the sign-in lockout). The **activity log** is written where things happen and pruned after 30 days. **Stats** are
sums over `plays` (listened seconds; top lists from counted plays; the grid in the browser's own time zone).

## Player extras and editing (`src/library/playsettings.js`, `chapters.js`, `editing.js`, v0.20.0)

**Speed** and the **text-subtitle delay** are the browser's (`playbackRate`; cue times shifted when drawn). The
**audio delay** is ffmpeg's: the playback plan carries `audioDelay`, `buildFfmpegArgs` reads the audio from a second
input of the same file opened with `-itsoffset`, and a file that would play as-is is remuxed instead (the picture is
copied). A burned-in picture subtitle gets its delay the same way (the overlay reads a shifted second input). Both
delays are kept per profile and title in `play_settings`; the player sends a changed audio delay with its restart and
saves the subtitle delay with `PUT /api/items/:id/play-settings`.

**Chapters** come from the stored probe (`media.chapters`, since 0.15). An item probed before that is read again once
in the background (`Chapters.forItem`), and what was found — `[]` when nothing — is written into `media`.

**Edit details** (`PATCH /api/items/:id/details`) validates every field first, writes the changed ones and adds them
to `locked_fields`; `MetadataManager.refresh` (also behind Fix match) writes the providers' values and then puts the
locked columns back (`restoreLocked`; the rating's `min_age` and the sort title with them). Artwork
(`/api/items/:id/artwork…`) lists TMDB's `/images` (previewed through Atomix), downloads a chosen one or an address
through the image cache, or stores an upload after checking its first bytes; each locks its field the same way.

## Downloads and offline use (`src/downloads/`, `src/api/downloads.js`, `src/api/shell.js`, `public/js/offline/`, v0.21.0)

**Server.** Migration 23 adds `users.can_download` (admins 1), `download_jobs` (one copy per title, quality and format:
`mp4`, `webm`, `audio`, `original`; `queued → preparing → ready | failed`) and `live_recordings.work_dir`. The
`DownloadQueue` makes one copy at a time at low priority (it waits while a converted video plays or a recording is
joined, and stops a running job when one starts), copying when the codecs already play and converting otherwise
(`plan.js`: H.264 or VP9 by height, AAC/Opus stereo; songs as they are, AAC, or Opus in WebM for a browser without AAC).
Copies live in the downloads folder within a size cap, the oldest used first, unused ones after 7 days. Routes:
`POST /api/downloads` (titles, a season, an album, an artist or a list), `/jobs`, `/:job/file` (Range), subtitles,
`/check` (which of a device's downloads it may keep) and `/progress` (offline progress, newest wins).

**The offline helper.** `/sw.js` is served from `public/js/offline/range.js` + `worker.js` as one classic script,
registered with the shell's version (`/api/shell` lists the app's files and a hash of them). It keeps that list in a
cache and answers pages and files from it, so the app opens with no connection; a new version waits until every page is
closed. `/offline/<profile>/<file>` is answered from the browser's private file storage (OPFS) with Range. API calls
always go to the network (declared with static routes where the browser has them, so a closing page's last requests
aren't cut off).

**The device.** `store.js` keeps the index in IndexedDB (entries per profile, queued progress, the account's profiles
with a PIN's salted PBKDF2 hash) and the files in OPFS, written by a dedicated worker with sync access handles.
`downloader.js` fetches 8 MB pieces at their byte offsets, two downloads at a time, each bound to the copy (job and size)
its bytes came from. `sync.js` sends offline progress and runs the check for the profile picked, works out expiry from
each download's last check, and keeps what an offline open needs. With `/api/status` unreachable (or answered by
something that isn't Atomix) and downloads on the device, `app.js` boots offline: the kept profiles, then Downloads;
the player and the music player play `/offline/…` files.

**Live TV tuners (v0.21).** A tuner writes one playlist across its kept runs (`index-all.m3u8`, a discontinuity and its
own init piece per run), so a conversion can rewind into an earlier run; a restart asks the source for a fresh address,
and a provider's 401/403 ends a fresh tuner at once ("The provider refused this channel").

## Home you can arrange (`src/home/`, `public/js/views/arrange-home.js`, v0.22.0)

`home/rows.js` is the catalogue: every row Home can show has a stable key (`continue`, `continue-listening`,
`continue-reading`, `live-now`, `watchlist`, `lists`, `recent-<libraryId>`, `picks`, `plugin:<key>`, pinned rows,
`web-apps`), built with the viewer's rules each time. `layout.js` keeps an arrangement — an ordered `{ key, hidden }`
list plus pinned row definitions (`pins.js`: a list, a genre in a library, a collection, a library sort, a web app) —
in `home_layouts` (migration 24): `profile_id NULL` is the household's, a profile gets its own row only when it changes
something, and kinds missing from a saved arrangement are put in at their default place. `webapps.js` keeps the
household's `web_apps` (name, address, picture, for Kids or not). `/api/home` rows carry their `key`; the editor lists
every row the viewer could have, empty ones too.

## Podcasts and audiobooks (`src/podcasts/`, `src/library/audiobooks.js`, `src/api/podcasts.js`, v0.22.0)

**The feed checker.** `podcasts/feed.js` reads RSS 2.0 (with the iTunes tags) and Atom with the same DOM-free XML
reader the DASH code uses (no DOCTYPE or entity declarations), fetched with `If-None-Match` / `If-Modified-Since`,
capped at 5 MB and 500 episodes, through the private-address check used for artwork and connected servers.
`podcasts/index.js` checks every feed on a schedule (`podcastCheckHours`, 6 by default, 0 = only by hand) and downloads
new episodes one at a time into `<folder>/<show>/<YYYY-MM-DD> <title>.<ext>` (written as `.part`, resumed); it keeps the
newest N of each show (or all) plus the episodes an admin keeps, and removes played ones outside that. Migration 25:
`podcast_feeds` (the address stays there, never sent to a browser; last error and time) and `podcast_episodes`
(enclosure, download state), plus `items.author`, `narrator`, `published_at`. A feed's `explicit` counts as 18.

**Audiobooks.** A folder per book (its files in natural order, one timeline) or one `.m4b`; tags and chapters by
ffprobe (the v0.20 chapters code), else a chapter per file. Progress is the book's whole timeline.

**The spoken player.** `public/js/music.js` plays books and episodes through the music bar in a *spoken* mode: skip back
and forward (profile prefs `spokenBack`, `spokenForward`), a speed per profile for spoken titles with the pitch kept,
the sleep timer (minutes or end of chapter, a 10 s fade), chapters on the seek bar, the place saved every 10 s, and a 5 s
rewind after more than 10 minutes away. Subsonic gets `getPodcasts` and `getNewestPodcasts`.

## Books and comics (`src/books/`, `src/api/books.js`, `public/js/reader/`, v0.22.0)

**The ZIP reader.** `public/js/reader/zip.js` has no imports and is shared three ways: the server (`src/books/zip.js`,
inflating with zlib and keeping the central directories of the last 16 archives), a page, and the offline helper
(`/sw.js` joins it in, inflating with `DecompressionStream`). It reads only the central directory and the entry asked
for; ZIP64; limits: 5,000 entries, 50 MB per entry, inflated ≤ 100× its packed size, an entry's data ending before the
central directory, no absolute, `..` or duplicate names. A refusal is a sentence (`ZipError`), never a crash.

**Books.** `books/epub.js` reads the container, the package (title, author, series from calibre or EPUB 3, language,
cover) and the contents (nav, else NCX). `/api/books/:id/file/<entry>` serves the book's own files.

**The reader's security policy.** Each book file is sent with its own policy: `sandbox allow-same-origin`,
`script-src 'none'`, pictures, styles and fonts only from the book (no outside requests). The reader shows it in a frame
without `allow-scripts`; the app's own policy allows frames from `'self'` for that. Links inside the book move within
it; links out of it aren't followed; forms send nothing. The place is a chapter and a text offset (it survives a font
size or screen change), with the kind of device it was read on (`progress.locator`, `progress.device`, migration 26).

**Comics and 7-Zip.** `books/scan.js` makes a `series` title (ComicInfo.xml Series, else the folder) with its issues
(`issue`, `issue_sort` from ComicInfo Number or the file name; `page_count`; `reading_dir` rtl for
`Manga=YesAndRightToLeft`); age from ComicInfo AgeRating (`comicinfo.js`). A series is visible to a Kids profile when
one of its titles is. CBZ is read with the ZIP reader; CBR/CB7 with 7-Zip or unrar (`archive-tool.js`: found on the
PATH or at `archiveToolPath`, run with argument arrays, never a shell, with a timeout and a list check). Pages over
4000 px are scaled once to 2400 px for phones (`/api/comics/:id/pages/:n`, `?full=1` the original). For Downloads a
CBR/CB7 is unpacked once into the cache and packed as a stored CBZ (`zip-write.js`). Reading time is the gap between the
reader's reports (2 minutes at most each), with the pages turned (`plays.pages`). Migration 27 rebuilds `lists` for
reading lists.

## Plugin support added in v0.23.0 (`src/problems.js`, `src/library/metadata.js`, `src/library/queries.js`)

Migration 28 adds `items.scores` (JSON `[{ source, value }]`): a metadata provider's IMDb / Rotten Tomatoes /
Metacritic scores, checked by `cleanScores()` (known sources, exact forms), shown by `public/js/scores.js` in the title
page's meta line, cleared (and locked) by Edit details' "Clear scores". Books and audiobooks join the scanner's metadata
pass; for them `refresh()` fills only empty columns and never writes the title, author or age rating. `tvdbId`,
`musicbrainzId` and `musicbrainzArtistId` travel in `ctx.merged` between providers without being stored.
`queries.js` gains `list({ keyword })`, `startedShows`, `partlySeenSeries` and `playedOn` for plugin rows.
`Problems` turns report/clear calls from the scanner (a folder missing or looking empty), remote sync (a server not
answering), podcasts (3 failed checks), the Live TV refresher (a source that worked before failing) and the hourly
disk watch (under 5 GB free) into one `server:problem` per kind and key, and one `server:recovered`.

The info plugins (`plugins/fanart-tv`, `omdb-ratings`, `open-library`, `musicbrainz`) are metadata providers ranked
after TMDB, so they only fill gaps; they share `plugins/_lib/service.js` (one request at a time with a gap counted
from the answer, a result cache in `api.storage`, a failure logged once, fail-fast while a service is down, and the
titles that failed handed to `api.metadata.offerAgain()` at the end of the scan). `api.setStatus()` puts a sentence on
a plugin's card ("Paste your key to start."). When a built-in provider fails during a refresh, the row's own artwork
stays, so a later plugin can't replace it.

`plugins/more-home-rows` builds its three rows from the viewer's helpers only (so `canSee()` and Kids limits apply as
everywhere); `src/home/rows.js` keeps a database row's `note` on its card and lets `items()` return
`{ title, items }` for a title per viewer. The `notifications` plugin (shown as "Alerts") sends new titles and
`server:problem` / `server:recovered` to ntfy, Telegram, Pushover, Discord, a webhook and email; a problem is sent at
most once a day per kind and key (its time kept in the plugin's storage).

## Artwork sizes and the page (v0.24.0; `src/library/thumbs.js`, `src/http/page.js`, `public/js/sized.js`)

Every picture route (`sendArtwork`, collections, the music apps' `getCoverArt`) sends through `sendPicture()`: with a
`?w=` the width snaps up a ladder (posters/square 200–600, backdrops 480–1920, logos 400–800) and `Thumbs` scales
the original once with ffmpeg into `cacheDir/thumbs/<sha1(path)>/<mtime>-<size>-<w>.<webp|jpg|png>` (WebP when the
request accepts it and ffmpeg has libwebp; logos keep alpha). A copy is never bigger than the original; at most two
are made at once, a request waits about 1.5 s and then gets the original, and a failure is remembered for an hour. A
`?v=` address is `immutable` for a year. A daily sweep drops copies whose original is gone, unused or changed, then
the least used ones above `thumbCacheMB` (Settings → Server, 2 GB). Only Orbit asks for sizes (`sizedAttrs`: srcset
with `sizes="auto, …"` on lazy cards, a single copy for the backdrop and logos from the screen width, Home's first
row eager, the hero backdrop `fetchpriority="high"`); the older themes keep the originals. The page is served by
`page.js`: `index.html` plus `<link rel="modulepreload">` for everything `app.js` imports statically and a JSON
graph of each view's modules, which `lazyView()` preloads when a view opens.

## Orbit's menu (v0.24.0; `public/js/shell.js`, `public/js/orbit-rules.js`)

`renderOrbitNav` builds one glass `.orbit-menu` holding two lists: `ul.orbit-list` (Home, the libraries, Lists, Live TV,
Downloads, Add-ons), which scrolls, and `ul.orbit-pinned` (a divider, Search, Settings, More), which never does. Both
sit in the menu element `nav.js` drives, so Up/Down walk them in DOM order: down off the list's end lands on Search.
Each library's icon comes from `orbitLibraryIcon()` (one per kind; `/api/libraries` marks the Live TV recordings
library with `recordings: true` so it gets its own). Older themes keep `libraryIcon()` and their own nav.

On phones and portrait screens both lists become `display: contents` and only `li.orbit-dock` shows: Home, Search, the
first three libraries and More, ordered with `order` into one row that fits 360 px. More opens `openMore()`, a native
dialog listing every entry (closed by Back, Escape or picking one); `highlightNav` marks More current when the page
you're on isn't in the dock. The profile pill hides while scrolling down: `pillShown()` decides, `app.js` toggles
`html.pill-hidden`, and focus inside the pill or a new page brings it back.

## Search (v0.24.0; `src/library/searchkey.js`, `src/api/search.js`, `public/js/views/search.js`)

Matching ignores accents, case, punctuation and a leading "the". `searchKey()` reduces text to lower-case letters
and digits (NFKD, marks dropped); each item keeps `search_key` = key(title) | key(original title). The column
starts NULL and a pure-SQL trigger (migration 29) sets it back to NULL when a title changes, so no write path needs
to know about it; `ensureSearchKeys()` fills the missing ones (a partial index finds them) just before any search.
`atomix_key()` is registered on the app's connection for that fill and for columns without a stored key (a song's
artist, the music apps' `search3`). `keyMatch()` builds the `LIKE` for a query's keys (with and without "the"); a
query of only punctuation matches nothing. `rankTitle()` orders suggestions: prefix, a word starting with it,
contains, then shorter titles.

`src/api/search.js`: `/api/search/recent` (10 per profile in `search_history`, a repeat moves to the top, saved on
Enter or on opening a result), `/api/search/suggest` (8 across films, shows, music, podcasts, audiobooks, books,
comics and people from `items.people`), `/api/search/browse` (12 genres and the viewer's libraries) and the genre
and person pages' `/api/genres/:name/items` and `/api/people/:name/items`. All go through `library.visibility()`,
so a Kids profile never sees a title — or a person — outside its rules. The full results stay at `/api/search`.

Orbit's search page adds the before-typing section (`.search-discover`) and the suggestion list (`.search-suggest`,
debounced 150 ms, each request aborted by the next and only the latest answer drawn); Back in the list returns to
the box. Older themes keep their page.

## Orbit's Live TV page (v0.25.0; since v0.26 a Preact screen: `public/js/views/live.js`, `views/live-data.js`, `ui/live.js`, `public/js/live-rules.js`)

Orbit only; older themes keep the rows and their "…" exactly as before.

- **Cards.** `channelCard(c)` replaces `row(c)` and `ul.live-wall` replaces `ul.live-list`. Each `li.live-item[data-id]` holds one 16:9 `button.live-card` named like the old row (`rowName`). The picture is the programme's `image`, or else the logo on `--tint` (`channelTint(name)`, a stable hue from the name). A picture that fails to load falls back to the logo. Radio shows the logo and a Radio tag; no guide shows "No guide information". The wall is four across at 1600 px and wider, three on laptops, two in the dock layout. Each item uses `content-visibility: auto` for long playlists and reaches past its card so the selection ring isn't clipped.
- **Spotlight.** `LiveSpotlight({ c, onWatch, onRecord, onFavourite, onGuide, onCast })` (`ui/live.js`; v0.25's `live-spot.js`). It follows focus and the mouse through `followFocus(list, …, { selector: '.live-card' })`. It starts on the first favourite or the first channel (`spotStart`), and keeps its channel across reloads while it is still listed (`spotKeep`). It shows the logo, LIVE, the channel number and group, the title, the start time with a bar and "N min left" (`minutesLeft`), and two lines of description. The backdrop is the programme picture; with none, a wash uses `--spot-tint`.
- **Buttons.**
  - Watch live.
  - Record: hidden for Kids and channels without a guide. When the programme is already marked, the button reads Recording or Recording scheduled and opens the programme sheet.
  - ★, with `aria-pressed`.
  - Guide: this channel's guide.
  - Cast to…: hidden for radio, encrypted channels or when casting is off.
  - The buttons keep their elements between channels, so focus is never lost; one about to hide while it holds focus hands it to Watch live.
- **The other screens** (the Guide, Recordings, the player) draw the same logo, lock and recording dot with the `h()` helpers in `live-bits.js`.
- **Layout.** On TVs and laptops the spotlight has a fixed height and `.live-scroll` (chips, the Guide/Recordings links and the wall) scrolls under it. Past the first row `.live-view.is-compact` shrinks the spotlight and drops its description and buttons. Phones get a short banner with Watch live and one swipeable chip row.

## Orbit's Movies and TV Shows pages (v0.25.0; since v0.26 a Preact screen: `public/js/views/library.js`, `views/library-shelf.js`, `views/library-parts.js`, `views/library-data.js`, `ui/az-rail.js`, `public/js/library-rules.js`)

These pages change only in Orbit and only for `movies` and `tv` libraries. Older themes and the other library types keep today's page.

- **Server.**
  - `GET /api/libraries/:id/recent` returns `[{ id, at, episode? }]`: the titles this profile is part-way through, newest first, at most 50.
    - It includes a film or episode that has been started and not finished, and a show whose next episode is waiting.
    - Episodes are listed under their show, which carries `episode`: the one part-watched, else the next one.
    - Kids rules apply through the usual visibility filter. Other library types return `[]`.
  - Items also carry `sortTitle`.
- **Spotlight.** It is Home's spotlight (the `Spotlight` block since v0.26), which accepts two options. `playAs` names the primary button: "Resume", or "Resume S1 · E3" / "Play S1 · E4" for a show. `quiet` re-shows the same title without the fade.
  - It opens on the most recent title (`spotStartItem`), follows focus and the mouse, and compacts past the first row. It hides when nothing is listed.
  - Its trailer, season count and next episode come from `/api/items/:id`, fetched once per title. A late answer never changes another title's buttons.
- **The bar.** `.library-bar` holds Sort ▾ and Genre ▾ (both open sheets; `openSheet` items can be `current`), Unwatched (`aria-pressed`), Search (the box opens in place) and "…" (Collections, and Scan for admins). Choices stay in the URL.
  - The header reads `countLine(...)`: "42 shows · 3 in progress".
  - In Orbit, posters of shows part-way through get a progress line (`posterFraction`).
  - "Nothing matches" offers Clear filters.
- **A–Z rail.** `AzRail({ items, cards })` lists the letters that have titles (# first, accents folded, a leading "the"/"a"/"an" ignored).
  - It appears when sorted A–Z with 20 or more titles and no search.
  - Select jumps to the letter's first title and selects it. The letter in view is marked on scroll.
  - Up/Down move between letters and Left returns to the posters. On phones it is a thin strip.

## Security model

- Passwords: scrypt (N=16384, r=8, p=1) with per-user salt; timing-safe comparison.
- Sessions: 256-bit random tokens in an `HttpOnly; SameSite=Lax` cookie (also accepted as `Authorization: Bearer`),
  stored hashed, `Secure` when served over HTTPS (set `ATOMIX_TRUST_PROXY=true` behind a proxy). The cookie is
  `atomix_session`; `nf_session` (from before the rename) is still read, and signing out clears both.
- CSRF: every state-changing request must be `application/json` and, if an `Origin` header is present, same-origin.
- Sign-in rate limit: 10 failures per IP per 15 minutes (with `trustProxy`, the IP is the last `X-Forwarded-For` hop;
  `trustProxy: N` trusts N proxies and takes the Nth address from the right).
- First-run setup needs the printed code unless the socket is loopback, addressed to localhost/127.0.0.1/[::1], with no
  forwarding header and `trustProxy` off.
- Connected-server requests follow redirects only on their own origin (`fetchFollowing`), so a token never travels elsewhere.
- Server and TV addresses can't be link-local or the unspecified address (`src/http/net.js`); loopback is allowed (a
  Jellyfin on this machine is a normal setup).
- A request body that trickles in longer than 30 s is refused (408) and its connection closed.
- Media is only reachable through item ids from the database — no user-supplied file paths. The folder browser is admin-only.
- Strict Content-Security-Policy (`script-src 'self'`), `nosniff`, frame protection.
- Plugins run with full server privileges — only install ones you trust.
- Connected servers: the token or password lives only in the `servers` table; routes never return it, and the browser
  only ever sees Atomix's own URLs (`/api/items/:id/file`, `/image/…`), never the far server's. Nothing leaves the
  server except calls to the servers an admin connected and, for Plex, to plex.tv (plus the LRCLIB query and the
  YouTube embed). A Plex token is only sent to that server's own address.
- Casting: TVs get only Atomix's own cast links (never a connected server's URL or token); the only other traffic is to
  devices on the local network that discovery found or an admin added. CORS `*` only on responses served with a link.

## Web client (`public/`)

### The secure address (v0.27.0; `src/tls/`)

- **Why:** EME (encrypted channels) and service workers (installing) need a secure context; a phone on `http://<pc>:8787` has none.
- **`server.js` `HttpsManager`:** a second listener (`https.createServer`, the app's own `handle` function, port `httpsPort` 8443 or `ATOMIX_HTTPS_PORT`) for `httpsMode` `tailscale` or `own`. `apply()` starts, stops or re-keys it (`setSecureContext`) and never throws: a failure is `state().sentence` (with `command` for Tailscale's administrator case). Applies are serialized; `state().busy` is true while one is queued or running (the card shows "Starting…" and polls). `start()` doesn't wait for it. A daily timer renews under 30 days (a refused renewal keeps serving a certificate that hasn't ended, with a warning sentence); a 60-s watch remakes the own certificate when the home addresses change. `PUT /api/admin/settings` applies and waits; `GET /api/admin/https` reports; `/api/status` carries `secureUrlFor(Host)` (own mode: the name the phone used when the certificate carries it, else 192.168 > 10 > 172.16/12 first). The session cookie on HTTPS is `__Secure-atomix_session` (a Secure cookie under the plain name would block the plain address's own sign-in: cookies ignore the port).
- **`tailscale.js`:** finds the CLI (`ATOMIX_TAILSCALE`, PATH, the usual install folder), reads `status --json` (`Self.DNSName`, `CertDomains`), runs `cert --cert-file --key-file` into `<data>/certs/` (`status` 20 s, `cert` 120 s); a valid `ts.crt` with over 30 days left is used without asking (one an administrator made included). On Windows the administrator command is prefixed `& ` for PowerShell.
- **`own.js` + `x509.js`:** a home CA (EC P-256, 10 years, critical nameConstraints: `.local`, localhost, the dotless hostname, `ATOMIX_HTTPS_NAMES`; 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8) and a server certificate it signs (825 days; SAN hostname, `.local`, localhost, the LAN IPv4 addresses, 127.0.0.1, `ATOMIX_HTTPS_NAMES`, filtered to what the CA may vouch for; issuer copied byte for byte from the CA's subject), remade from the same CA when the addresses change or near its end. `x509.js` writes the DER itself (no library). `/tls/atomix-home-ca.crt` and `.mobileconfig` (public, `own` mode only) for phones.
- **Browser:** `dash/eme.js` throws `NEED_SECURE` on an insecure page before asking for a key system; the player offers the secure address (`state.status.secureUrl`). `views/settings-https.js` is the card.

### Preact without a build step (v0.26.0)

- **The rule:** no `npm install` and no build step. The only libraries are **Preact 11** (with `preact/hooks`, MIT) and **htm 3** (Apache-2.0).
  - They are kept in `public/js/vendor/` and pinned in `checksums.json` (checked by `test/vendor.test.js`), with their licences in `LICENSES.md`.
  - They import each other by relative path, so no import map is needed. `node scripts/vendor-update.mjs <preact> <htm>` refreshes them (it needs the system `tar`).
  - Nothing else is added without changing this rule here.
- **`ui.js`** is the one entry point components import from. It re-exports `html` (htm bound to Preact; no JSX), `render`, the hooks, and `useAppState(select)`, which re-renders when a value from `app.js`'s state changes.
- **`state-events.js`:**
  - `watchState()` wraps `app.js`'s `state`, so every top-level write notifies;
  - `notifyState(key)` covers changes inside a value (`applyTheme()` calls it for prefs);
  - `onState(fn)` listens.
- **`screen.js` `mountView()`:** a view module exports either `render(el, params, query)` (returning its cleanup) or a `Screen` component taking `{ params, query, data, view }`. The router mounts both and unmounts a `Screen` on leave, which runs its effects' cleanups (layout effects at once, others a frame later).
  - A Screen's `load(params, query)` gives its `data`; the page is announced and focused once that is drawn.
  - **Speed:** a route may name the Screen's data module (`data: lazyData('views/live-data.js')`): the router starts its `load()` beside the screen's own modules. The page preloads Preact's core (`ui.js` and the vendor files) with the boot (`src/http/page.js`); it only runs when a Screen opens.
- **Converted screens (v0.26.0):** Live TV, every library page, Search, genre and person. `devtools/v026-dom.mjs` compares their markup with v0.25.0's, page by page.
- **Building blocks (`public/js/ui/`):**
  - `basics.js`: `Icon`, `Button`, `EmptyState`, `MoreButton`, `Spinner`;
  - `cards.js`: `Art`, `PosterCard`, `SquareCard`, `LandscapeCard`, `LiveCard`, `Grid`, `Row`;
  - `spotlight.js`: `Spotlight`, `MetaLine`;
  - `live.js`: `ChannelLogo`, `LockBadge`, `RecDot`, `ChannelRow`, `ChannelCard`, `LiveSpotlight`; `az-rail.js`: `AzRail`; `basics.js` also has `Island`, for children built by older code (the music `trackList`).
  - Each draws exactly what its `components.js` helper draws (checked by `devtools/v026-ui.mjs blocks`).
  - Cards register themselves in `cardItems`.
  - `openSheet`, `openDialog` and `toast` stay plain calls.
- Screens move over a few per round (`CONTRIBUTING.md` says how). The engines (`dash/`, `reader/`, `offline/`, the service worker) stay as they are.

Plain ES modules, loaded on demand per view. `app.js` owns routing (hash-based), theming and session state.
Screen readers hear changes through two live regions created at boot (`announce()` in `components.js`: polite status,
assertive alerts); seek bars write `aria-valuetext` through `sliderText()` (on focus, on a press, else at most every
10 s) and volume sliders through `percentSlider()`. The stylesheet is written against tokens — `app.css` declares the
classic scales (`--space-*`, `--dur-*`, `--z-*`, `--pill`), `tokens.css` the colours (ramps, semantic names, the focus ring
colour `--focus-ring` and `--focus-width`) and `themes/orbit/theme.css` Orbit's
(`--focus-bg/--focus-fg`, glass, `--text-tinted`, radii, spaces); `orbit.css` lays out and never colours. Shared
recipes: one slider, one round icon button, one selectable row (`.option-row` and friends), `rowActions()`,
`spinner({ inline })`, `emptyState()`, `TOASTS`, and `moreItems()` builds the detail page's action set for every theme.
`nav.js` implements spatial navigation: arrow keys move focus to the nearest focusable element in that direction
(same line first for ←/→, nearest line first for ↑/↓), which is what makes it usable with a TV remote.
Dialogs use native `<dialog>`; the layout switches between top, side and Orbit navigation based on the theme. For Orbit, `shell.js` builds the
floating menu, and `nav.js` drives it with the remote: Left from the leftmost control enters it, Up/Down move,
Right/Back leave and restore focus. Rows scroll so the selected card stays at the left, and Back on Home goes to
the top first, then opens the menu. These rules are plain functions in `orbit-rules.js`, tested in Node
(`test/orbit-rules.test.js`). On wide screens `main` is a fixed, full-screen scroll box whose left padding keeps
the menu's rail clear (168 × `--px` on TVs, 112 px on laptops); the artwork fills the screen beneath it. Phones
and portrait screens use the document scroll and a dock. Home's spotlight gives up height on short windows (a
desktop browser) so the first row is always whole; on narrow screens Settings' sections are a swipeable chip row.

Home rows come from `/api/home` in this order: continue watching, the Watchlist and playlists (when they have
something in them), each library's rows, the two "Because you watched" rows, then plugin rows. `lists.js` (client)
holds the Watchlist button and the **Add to playlist…** sheet, used by the film, show, season and track menus;
`views/lists.js` is the Lists page, a list page (drag or the "…" sheet to reorder) and a collection page.
`views/trailer.js` embeds a YouTube trailer (the CSP allows frames from `youtube-nocookie.com` only; a full-screen
route, so Back takes focus and music pauses); `views/nowplaying.js` is the full-screen music page over the same
`music` object the mini-player drives (it gained `position`, `duration` and a `time` event): synced lyrics keep the
current line centred, the queue sits beside them on wide screens, Up/Down walk the lines and Enter seeks.
`views/lists.js` re-renders only the items on a move or remove and keeps the remote on the moved item;
`views/nowplaying.js` shows another song's lyrics at `#/now-playing?song=<id>` with **Play this song**, without
touching the queue. `cast.js` (v0.13.0) is the casting side: `openCastPicker` (the device sheet), the cast state polled from
`/api/cast/sessions/current` (every 5 s, every second on the Remote), `castCommand`, and the **Playing on…** pill in
the mini-player's corner (stacked above it when both show); `views/remote.js` is the Remote (`#/cast`), with the
scrubber and seek-bar previews of the player. The player adds **Cast** and, in Safari, **AirPlay** (the `<video>`'s
`src` swaps to a cast link while it plays on the Apple TV).

`gate.js` decides what a page load shows, the way a TV app does: each tab keeps a note in `sessionStorage`
(`{ profileId, lastActive }`). No note is a fresh open: `splash.js` plays the Orbit animation (the logo's own
paths, in the theme's colours) while the app boots behind it, then "Who's watching?" follows when the account has
more than one profile or a PIN. A fresh note (a reload) shows neither. Once a note is older than the server's
`pickerIdleMinutes` (Settings → Server, default 30; 0 = never) with nothing playing, the picker comes back over
the page and picking the same profile returns to it (from a player, to the page it was opened from; anyone else
starts at Home). With storage blocked the note lives in memory, so the picker still comes back within the page.
The splash waits (briefly, capped) for the profile's theme stylesheet before it shows, and an arrow key that skips
it puts the page in keyboard mode. The server session is untouched: PINs and library access are enforced there as
before; the gate only decides what this tab shows. The decision is a pure function, tested in `test/gate.test.js`.

`tint.js` works out the colour a picture would cast into a dark room (the most vivid hue, weighted towards
saturated mid-tones, then lightened or darkened into a band that shows on dark backgrounds and keeps dark text on it
readable; tested in `test/tint.test.js`). `backdrop.js` samples each backdrop into a 48×27 canvas, sets `--tint` on
the page, and the registered custom property animates between titles.

A person's accent goes through `clampAccent()` in `tint.js` (moved into the theme's band in OKLCH, ink black or white by
APCA), and `applyAccent()` in `app.js` writes `--a-1..12`, `--accent`, `--accent-solid`, `--accent-text` and `--tint-default`
inline for every theme (`test/accent-clamp.test.js`). `src/themes/apca.js` and `src/themes/tokens.js` are test-side helpers
(APCA contrast and a reader for theme custom properties; `test/theme-tokens.test.js`); the server doesn't load them.
Colours are described in `docs/THEMES.md` (token layers) and `public/css/tokens.css`.

`backdrop.js` owns the full-screen artwork layer behind every page; views call `setBackdrop(url)`, and
`followFocus()` makes it (and the home spotlight from `components.js`) follow the focused or hovered card. The router
clears it for views that don't set one. On big screens the home view is a fixed-height column — spotlight on top, a
scrolling `.home-rows` area below — and `nav.js` keeps arrow-key movement inside a scrolling area (the rows, a row of
cards) before jumping out of it, so items scrolled out of sight are still reached in order.

In Orbit the same artwork also feeds the *environment* around the window: a 64 × 36 canvas stretched to the whole
screen (two canvases cross-fade). This keeps the soft background cheap on TV browsers.

`music.js` owns a single `<audio>` element and the mini-player bar, which live outside the page views so music
keeps playing while you browse. The queue logic (shuffle that keeps the current song, repeat all/one, play next,
move/remove) is plain code in `queue.js`, tested in Node (`test/queue.test.js`). The queue is saved per profile in
`localStorage` (key names in `storage.js`, which also moves anything saved under the old `nf-` names to `atomix-`),
playback sessions are pinged every 30 seconds, the Media Session API connects lock-screen and
media-key controls, and opening the video player pauses the music and hands the media keys to the video.
