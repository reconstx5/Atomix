# Atomix: Plex, and tidier connected servers — design (round 14, v0.12.0)

Date: 2026-10-06. Author: Claude, with Dallas's choices. Builds on v0.11.0 (connected servers).

## 1. What Dallas wants

"Do some updates and add new features." His choices during the design:

- **Plex as a connected server** this round, next to Jellyfin, Emby and Atomix. **Casting** (Chromecast, DLNA,
  AirPlay) is the round after, with its own design.
- Plex sign-in by **link code at plex.tv/link**: Atomix shows a short code, he enters it on his phone, no password
  is typed into Atomix, two-factor accounts work.
- Two sets of quality-of-life fixes for every connected server:
  - **dates and artwork**: the server's own "added" dates, artwork that refreshes when it changes on the server,
    and cached artwork cleaned up on Remove;
  - **playback bookkeeping**: the server is told when a stream starts and stops (no phantom streams), the reports
    never hold up the player, and removing a server stops its live streams.

Success looks like this. An admin presses **Connect a server…**, picks Plex, types the four characters into
plex.tv/link on a phone, picks "Living room PC", ticks Movies and TV Shows, and a minute later those titles are on
Home and in search like any other library. "Recently added" shows only what Plex itself added lately. A title
plays with one press on the TV, Plex's dashboard shows it playing and then stopped, and it is marked watched in
Plex at the end. A poster changed in Plex shows up after the next sync. **Remove** takes it all away, including
the cached artwork and any stream still playing.

Project-wide rules that apply throughout:

- Node ≥ 22.13 and zero npm dependencies; plain ES-module browser JS; no build step.
- Orbit first, with a TV remote. The older themes change only where this spec adds content.
- Tokens travel in headers, never in a URL the browser sees. No route returns a stored token.
- Nothing leaves the server except calls to plex.tv (sign-in and the server list) and to the servers the admin
  connected, plus the existing LRCLIB query and YouTube embed.
- The design stays private.

## 2. Data

Migration 12 (`src/db.js`, `MIGRATIONS[11]`):

- `servers` is rebuilt so its `kind` CHECK allows `plex`, and it gains `extra TEXT` (JSON; provider-specific state
  that no route returns). Every existing row and column is copied across unchanged.
- `items.remote_updated INTEGER`: the server's own "last changed" time for a title, in milliseconds.
  - Plex: `updatedAt` × 1000.
  - Jellyfin, Emby and Atomix: null.
  - The sync uses it to skip the detail request for titles that haven't changed (§4.3).
- The `settings` table gains `plexClientId`. This is a random UUID made the first time Plex is used. It identifies
  this Atomix to plex.tv and to Plex servers as one stable device.

For a Plex server the `servers` row holds:

| Column | What it holds |
| --- | --- |
| `url` | the connection chosen (§3.2) |
| `username` | the Plex account's username |
| `secret` | the server's access token. For your own server it is your account token; for a shared server it is the token plex.tv gives for that server. |
| `remote_user_id` | the server's machine identifier |
| `extra` | `{ accountToken, relay }`: `accountToken` is used to look the server's addresses up again (§7); `relay` is true when the chosen connection is Plex's relay |

## 3. Signing in to Plex

### 3.1 The link code

This all runs on the Atomix server. The browser only ever sees the code and the server names.

1. **Ask for a code.** `POST https://plex.tv/api/v2/pins?strong=false` with these headers:
   - `X-Plex-Product: Atomix`
   - `X-Plex-Version: <version>`
   - `X-Plex-Client-Identifier: <plexClientId>`
   - `X-Plex-Device-Name: <serverName>`
   - `Accept: application/json`

   The answer is `{ id, code, expiresAt }`.
2. **Show the code.** Atomix keeps the pin in memory: `pins` Map, keyed by id, dropped 30 minutes after creation.
   It answers the browser with `{ pinId, code, expiresAt }`.
3. **Poll.** The browser asks Atomix every 2 s whether the code has been linked. Atomix asks
   `GET https://plex.tv/api/v2/pins/:id` (same headers).
4. **Linked.** Once the answer carries `authToken`, Atomix keeps the token in the Map entry and asks
   `GET https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1` with `X-Plex-Token`. It keeps the entries
   that provide `server`.
5. **List the servers.** Atomix answers `{ linked: true, servers: [{ id: clientIdentifier, name, owner, owned }] }`.
   For a shared server, `owner` is its `sourceTitle`.
6. **Expired.** Past `expiresAt`, or when the pin is gone, the answer is `{ expired: true }`.

The plex.tv base URL comes from `ATOMIX_PLEXTV_BASE` (default `https://plex.tv`), so the tests and the dev mock
never touch the real service.

### 3.2 Picking a server and choosing its address

`POST /api/servers { kind: 'plex', pinId, serverId }` takes the pin's token and the chosen resource. It tries the
resource's connections in this order:

1. local, non-relay;
2. remote https, non-relay;
3. other non-relay;
4. relay.

Each try is `GET <uri>/identity` with a 4 s timeout, answered with the resource's `accessToken`. The first that
answers with the same `machineIdentifier` wins.

- **Something answers.** Atomix stores the row (§2) and answers like the other kinds, with `available` (§4.1). The
  pin entry is dropped.
- **Nothing answers.** It is a 400: "Couldn't reach <name> at any of its addresses (<uri>, <uri>, …)". Nothing is
  stored. The pin stays, so the admin can pick again.
- **Already connected.** If the same `remote_user_id` (machine id) is already connected, it is a 409:
  "<name> is already connected."
- **Self-connect.** A Plex server can't be "this Atomix", so there is no self-connect check.

### 3.3 Reconnect

`POST /api/servers/:id/reconnect` for a Plex row takes `{ pinId }` from a fresh link code, not a password. Atomix
looks up the same machine id in the new account's resources and runs §3.2 again. If it finds it, it updates
`url`, `secret`, `extra` and sets `status = 'ok'`. If the server isn't among that account's resources, it is a
400: "That Plex account can't see <name>."

### 3.4 The dialog

- **Choosing Plex.** In **Connect a server…**, the Plex pill replaces the address, username and password fields
  with:
  - a large code (4 characters, spaced for reading from a sofa);
  - "Go to **plex.tv/link** on your phone or computer and enter this code";
  - a small spinner reading "Waiting for Plex…".
- **After the code is entered.** The dialog moves to **Pick a server**: one row per server with its name and
  "Yours" or "Shared by <owner>". With the remote, Up and Down move between rows and Enter picks one; a mouse
  click picks too. The pick goes straight to the existing libraries step, titled "Add libraries from <name>".
- **When something goes wrong.**
  - An expired code reads "That code has expired" with a **New code** button.
  - A plex.tv error reads "Couldn't reach plex.tv: <detail>" with **Try again**.
  - An account with no servers reads "This Plex account has no servers."
- **Closing the dialog.** Polling stops when the dialog closes.
- **Sign in again.** On a Plex row, **Sign in again** opens the code step and then reconnects (§3.3). There is no
  server list, since the server is already known.
- **The server row.** It reads "Plex · Living room PC · Movies, TV Shows", and adds " · via Plex relay (slow)" when
  `extra.relay` is set.

## 4. The Plex provider (`src/remote/plex.js`)

`PlexProvider` follows the `RemoteProvider` interface.

- **Requests.** Every request sends `X-Plex-Token`, `X-Plex-Client-Identifier`, `X-Plex-Product` and
  `X-Plex-Version` as headers, and `Accept: application/json`.
- **Errors.** `request()` already turns a 401 into `HttpError(401)`.
- **`connect()`.** For `kind: 'plex'`, `connect()` is not used. Sign-in is §3, through `src/remote/plextv.js`
  (pins, resources and connection choice; testable alone).

### 4.1 Libraries

`GET /library/sections` returns `Directory[]`. Section types map like this:

| Plex type | Atomix type |
| --- | --- |
| `movie` | `movies` |
| `show` | `tv` |
| `artist` | `music` |

`photo` and anything else is skipped. Each library is `remoteId = key`, `name = title`.

### 4.2 Items

**Listing a section.** Paged with `X-Plex-Container-Start` and `X-Plex-Container-Size: 200` (as query
parameters), with `includeGuids=1`. It reads until a page comes back short, or until `totalSize` is reached when
the server gives one.

**Requests per kind.**

| Kind | Request |
| --- | --- |
| movies | `/library/sections/:key/all?type=1` |
| shows | `/library/sections/:key/all?type=2` |
| seasons, episodes | `/library/metadata/:ratingKey/children` (show → seasons, season → episodes) |
| artists | `/library/sections/:key/all?type=8` |
| albums, tracks | `/children` (artist → albums, album → tracks) |

**How each Plex field maps:**

| Atomix field | Plex field |
| --- | --- |
| `remoteId` | `ratingKey` |
| `title` | `title` |
| `sortTitle` | `titleSort` |
| `year` | `year` |
| `overview` | `summary` |
| `tagline` | `tagline` |
| `genres` | `Genre[].tag` |
| `rating` | `audienceRating`, else `rating` |
| `runtime` | `duration / 60000` (minutes) |
| `duration` | `duration / 1000` (seconds) |
| `airDate` | `originallyAvailableAt` |
| `season` | `index` (seasons) / `parentIndex` (episodes) |
| `episode` | `index` |
| `track` | `index` |
| `disc` | `parentIndex` (tracks) |
| `artist` | `grandparentTitle` (tracks) / `title` (artists) |
| `album` | `parentTitle` |
| `people` | `Director[].tag` as `director`; up to 8 `Role[].tag` as `cast` |
| `tmdbId`, `imdbId` | from `Guid[].id` (`tmdb://…`, `imdb://…`) |
| `addedAt` | `addedAt × 1000` |
| `updated` | `updatedAt × 1000` |

**Certification.** `contentRating` is mapped like this:

- `gb/15` becomes `GB:15` when the prefix is a known rating country. Plex writes the country in lower case,
  `uk` included, which is treated as `GB`.
- `PG-13`, `TV-MA` and `NR` stay as they are.
- `certToAge` then decides, so an unknown string follows "allow unrated".
- Seasons and episodes inherit their show's rating, as for Jellyfin.

**Images.** `{ poster: Boolean(thumb), backdrop: Boolean(art), logo: false }`. The provider keeps the raw
`thumb`/`art` paths, which carry Plex's own timestamp (for example `/library/metadata/12/thumb/1712345678`).

**Media from the listing.** The listing's `Media[0]` gives:

```
{ container, bitrate (kb/s), video: { codec: videoCodec, width, height, hdr: false, bitDepth: null },
  audio: [{ index: 0, codec: audioCodec, channels: audioChannels, default: true }], subtitles: [] }
```

It also gives `Media[0].Part[0].key`, the stream path, kept as `media.plexPart`. A title with no `Media` gets
`media: null`, which plays as "<server> has no playable file for this title" (the v0.11 rule).

### 4.3 Detail only when it changed

For movies, episodes and tracks the sync calls `provider.details(server, item)` only in these cases:

- the title is new;
- its stored `remote_updated` differs from the listing's `updatedAt`;
- its stored media has no streams yet.

`details()` does `GET /library/metadata/:ratingKey` and fills `media` from `Media[0].Part[0].Stream[]`:

| Plex `streamType` | Becomes | Fields |
| --- | --- | --- |
| 1 | video | `codec`, `bitDepth`, `width`, `height`; `hdr` when `colorTrc` is `smpte2084`/`arib-std-b67` or the display title says HDR/Dolby Vision |
| 2 | audio | per-type `index`, `codec`, `channels`, `language` (`languageCode`), `title` (`displayTitle`), `default` |
| 3 | subtitles | per-type `index`, `codec`, `language`, `title`, `forced`, `default` |

Subtitle streams with a `key` are external files on the Plex server. They are left out this round; only embedded
ones are listed. A detail request that fails keeps the listing's media and leaves `remote_updated` unset, so it is
asked again next sync.

Detail requests are paced 25 ms apart. On a re-sync where nothing changed, a library of 5,000 films costs 25
listing requests and no detail requests.

### 4.4 URLs

| What | URL | Notes |
| --- | --- | --- |
| Image | `<url><thumb or art>` | the token goes in the header |
| Stream | `<url><media.plexPart>` | Plex's original file; Range works |
| Progress | `GET <url>/:/timeline?ratingKey=…&key=/library/metadata/…&state=playing\|paused\|stopped&time=<ms>&duration=<ms>` | |
| Watched | `GET <url>/:/scrobble?key=<ratingKey>&identifier=com.plexapp.plugins.library` | |
| Ping | `GET <url>/identity` (machine id must match) | then `GET <url>/library/sections` with the token; a 401 means `unauthorized` |

## 5. Quality of life for every connected server

### 5.1 The server's own "added" dates

- **What each provider reports.** Each provider's items carry `addedAt`, in milliseconds:
  - Jellyfin and Emby: `DateCreated`, which is added to `Fields`.
  - Plex: `addedAt`.
  - Atomix: the far item's `addedAt`.
- **What the sync stores.** `added_at` is set to that date when an item is created. When an item has no date, the
  sync falls back to now, as before.
- **Existing items.** Ones synced before 0.12.0 have `added_at` corrected once, on their next sync, when the server
  gives a date. Afterwards `added_at` never moves.
- **Effect.** "Recently added", sorted by date and limited to recent titles, shows what the server itself added
  lately. New-episode alerts still skip a library's first sync (the existing `firstScan` rule).

### 5.2 Artwork that refreshes, and is cleaned up

- **A version in each image URL.** Each provider's image URL carries the server's version of the picture:
  - Plex: the timestamp in `thumb`/`art`.
  - Jellyfin and Emby: `?tag=<ImageTags.Primary | BackdropImageTags[0] | ImageTags.Logo>`.
  - Atomix: the far poster URL's `?v=`.
- **Effect.** A changed picture is a changed URL. `ImageCache` keys on the URL, so it fetches the new one. The
  item's stored `poster`/`backdrop`/`logo` changes too, so `metadata_at` moves and the browser's `?v=` changes with
  it.
- **Superseded pictures.** When a sync replaces an image URL, the old URL's cached file is deleted
  (`images.forget(url)`).
- **Remove.** `DELETE /api/servers/:id` collects every image URL of that server's items before deleting, then
  forgets each one.

### 5.3 Start, stop, and never in the way

`src/remote/progress.js` grows from a progress listener into a small reporter. The provider interface gains
`reportStart(server, item, { position, duration })` and `reportStop(server, item, { position, duration })`.
`reportProgress` stays.

| Event | Jellyfin / Emby | Plex | Atomix (far) |
| --- | --- | --- | --- |
| start | `POST /Sessions/Playing` `{ ItemId, PositionTicks, PlayMethod: 'DirectStream', CanSeek: true }` | timeline `state=playing` | nothing (the far server already records progress) |
| progress | as now, `IsPaused` from the session | timeline `state=playing` or `paused` | as now |
| stop | `POST /Sessions/Playing/Stopped` `{ ItemId, PositionTicks }` | timeline `state=stopped` | nothing |
| watched | as now | scrobble | as now |

- **Triggers.** `playback:start` and `playback:stop` are already emitted by the PlaybackManager, for direct and
  converted sessions alike. `playback:stop` covers leaving the player, replacing the session, the idle reap,
  shutdown and removal.
- **One queue per server.** The reporter keeps one promise chain per server, so start → progress → stop arrive in
  order.
- **Off the request path.** The listeners return at once, so a progress POST never waits on the far server.
- **Order and staleness.** The 10 s rate limit on progress stays. A stop always goes out, carrying the last
  position Atomix knows.
- **Failures.** They are logged at most once an hour per server, as now.

### 5.4 Removing a server stops its streams

Before deleting, `DELETE /api/servers/:id` stops every live playback session whose item belongs to one of that
server's libraries, with reason `server removed`. That ends its ffmpeg process and sends the stop report while the
row still exists. A viewer's next heartbeat answers 404, as today.

## 6. API and Settings changes

- `POST /api/servers/plex/pins` → `{ pinId, code, expiresAt }`.
- `GET /api/servers/plex/pins/:id` → one of:
  - `{ linked: false, expiresAt }`
  - `{ linked: true, servers: [...] }`
  - `{ expired: true }`
- `POST /api/servers` accepts `{ kind: 'plex', pinId, serverId, name? }`.
- `POST /api/servers/:id/reconnect` accepts `{ pinId }` for Plex.
- `serializeServer` adds `relay: true` when set. It never returns `extra` or `secret`.

All of these are admin only. plex.tv errors reach the admin as 502 "Couldn't reach plex.tv: …", or 400 for an
unknown pin. A 401 from plex.tv or a Plex server is never passed on as a 401: the v0.11 rule, because the browser
reads a 401 as this Atomix session ending.

Settings → Libraries: the Plex pill and its steps (§3.4), and the relay note on the row. Nothing else in Settings
changes.

## 7. Errors and edge cases

- **Expired code or no answer from plex.tv.** The dialog offers a new code or Try again. Nothing is stored until a
  server is picked and answers.
- **No address answers.** It is a 400 naming the addresses tried, and the admin can pick again.
- **No servers, or nothing reachable.** The dialog says so.
- **A shared server.** It is listed as "Shared by <owner>". Only the sections the owner shared are listed, and
  the access token is that server's own.
- **A token revoked at plex.tv.** A 401 at sync or play marks the server `unauthorized`, and nothing is pruned.
  **Sign in again** asks for a new code.
- **An address that changed** (for example a new LAN IP after a router restart). When a sync's ping fails with a
  network error and the row has `extra.accountToken`, Atomix asks plex.tv for the resources once, re-runs the
  address choice (§3.2) for the same machine id, saves a new `url` if one answers, and pings again. The address
  is never moved to a different machine.
- **The relay.** It is only used when nothing else answers, and the row says so. Plex's relay limits bandwidth, so
  4K may stutter. The note is the warning.
- **Plex's own transcoder** is not used. Atomix plays the original file and converts with its own ffmpeg when
  needed, so there is one place where conversion is decided and the TV never talks to Plex.
- **A Plex Home with managed users.** Atomix uses the account that entered the code. Switching to a managed user
  is out of scope.
- **A stop report after the server is gone** (deleted mid-stream). It is sent before the row is deleted (§5.4). If
  it fails, it is only logged.
- **Older items** with `added_at` from v0.11 are corrected once (§5.1). Items without a server date keep theirs.

## 8. Out of scope (deliberately)

- Casting (next round).
- Plex playlists and collections.
- Watched state pulled from the server.
- External subtitle files on the server.
- Plex photo sections.
- Plex managed users.
- Plex's transcoder.
- Proxy hardening (HEAD, compression, 416, header timeouts, redirects). Dallas left it for another round.
- The older review leftovers: Now Playing volume, Escape on Now Playing, the Watchlist double press, the "Part of"
  marker.

## 9. Testing

**Fakes in `test/helpers-plex.js`:**

- `fakePlexTv` serves pins (linked after N polls, or expired), resources (owned and shared, several connections
  each, some dead), and a revoked token.
- `fakePlex` serves `/identity`, `/library/sections`, the paged `/all` listings (with or without `totalSize`),
  `/children`, `/library/metadata/:id` with streams, images (which need the token header), a Range stream from a
  file, timeline and scrobble calls (recorded), and a token switch for 401s.

**Node tests:**

- **Sign-in:** pins, polling, expiry, the resource list, connection order (a dead local address falls through to
  the remote one), machine-id mismatch, the 409 duplicate, and reconnect with a new pin.
- **The provider:** sections, paging, the field mapping, ratings (`gb/15`, `uk/12A`, `PG-13`, `TV-MA`, `NR`),
  music, and detail only when `updatedAt` changes, counted by the fake.
- **Sync:** kids rules on Plex titles, added dates for all kinds, and the one-time correction of old `added_at`.
- **Artwork:** a changed thumb timestamp gives a new image, the old cache file is deleted, and Remove deletes
  every cached image.
- **Playback:** the proxy with Range, ffmpeg from the Plex URL, embedded subtitles, and a title with no media.
- **Reporting:** start/stop/watched calls, in order, for Jellyfin (the existing fake gains `/Sessions/Playing`)
  and Plex; a hanging fake server doesn't delay the progress POST; removal mid-play stops the session and its
  ffmpeg, and sends the stop.
- **Address change:** the fake server moves port, the sync finds it through resources, and the url is updated.

**Browser:** `devtools/servers-ui.mjs` gains a `plex` section. It covers the code shown, auto-linking, picking a
server with the remote, the libraries step, the row (relay note when forced), playing, and checks in the mock that
the timeline recorded playing then stopped and that the scrobble arrived. Remove follows. The existing sections
stay green. orbit-sizes and orbit-a11y add the code step at phone size and the code's contrast.

## 10. Dev data

`devtools/mock-plex.mjs` on :9915 is both plex.tv and one Plex server.

- **plex.tv side.** The base is `ATOMIX_PLEXTV_BASE=http://127.0.0.1:9915/plextv`, set in `run-dev.sh`. A pin
  links on its third poll. Resources list "Dev Plex" (owned) with a dead local address and a working one, and
  "Friend's Plex" (shared) whose only address is dead.
- **Plex server side.** Two movies (one `gb/PG`, one `TV-MA`) and a show with two episodes, streams are the dev
  VP9 clips, and images are drawn like the other mocks. `GET /__calls` lists the timeline and scrobble calls, and
  `/__reset` clears them.

It is added to `restart-dev.sh` beside the Jellyfin mock.
