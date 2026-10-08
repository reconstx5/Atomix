# Atomix architecture

Atomix is one Node.js process with no npm dependencies. It uses only built-in modules
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
  stored hashed, `Secure` when served over HTTPS (set `ATOMIX_TRUST_PROXY=true` behind a proxy). The cookie is
  `atomix_session`; `nf_session` (from before the rename) is still read, and signing out clears both.
- CSRF: every state-changing request must be `application/json` and, if an `Origin` header is present, same-origin.
- Sign-in rate limit: 10 failures per IP per 15 minutes.
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

Plain ES modules, loaded on demand per view. `app.js` owns routing (hash-based), theming and session state.
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
