# Atomix connected servers (v0.11.0) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin connects a Jellyfin, Emby or Atomix server in Settings; its chosen libraries are synced into Atomix as ordinary libraries, play through Atomix, and report progress back.

**Architecture:** A `servers` table and `libraries.server_id`; one provider module per kind behind a shared interface (`src/remote/jellyfin.js` serves Emby too, `src/remote/atomix.js`); `src/remote/sync.js` turns a server's catalogue into `remote:`-pathed items via the scanner's existing upsert/prune; playback resolves a remote item to a stream URL plus headers so `decide()`/ffmpeg are unchanged and `/api/items/:id/file` proxies with Range; a `playback:progress` listener pushes progress to the server.

**Tech Stack:** Node ≥ 22.13 (`node:http`, `node:sqlite`, `node:test`, global `fetch`), ffmpeg, plain ES-module browser JS, Playwright for the browser suite (cloud devtools).

**Spec:** `docs/superpowers/specs/2026-10-02-atomix-connected-servers-design.md`

## Global Constraints

- Zero npm dependencies; Node ≥ 22.13; no build step; Orbit and a TV remote first; older themes change only where the Settings panel adds content.
- Nothing leaves the server except calls to servers the admin connected; tokens travel in headers, never in URLs the browser sees; `servers.secret` is never returned by any route.
- Kids and library-access rules apply to remote titles exactly as to local ones (`min_age` from the server's rating).
- Version `0.11.0`; migration 11.
- No git in the cloud copy: base snapshot workspace, hash-checked delivery to `D:\Nodeflix`, as in rounds 7–12.

## Review Focus

1. A Jellyfin movie with no `MediaSources` (a stub, or a folder item): the sync must store it without `media` and playback must answer a clear error, not crash `decide()` — Task 3's shape test includes a source-less movie.
2. A server whose URL is typed with a trailing slash, no scheme, or an IP:port: connect must normalise and work — Task 2's `normaliseUrl` test.
3. Removing a server while one of its titles is playing: the session ends cleanly (404 on the next heartbeat, no crash) — Task 6's API test.
4. A kids profile and a remote title with an unknown rating string (`TV-MA`, `Not Rated`): `allowUnrated` decides; nothing throws in `certToAge` — Task 4's kids test includes an unknown rating.
5. The far Atomix's own kids/PIN profiles: connecting with an account whose only profiles need a PIN must fail with the spec's message, not hang — Task 2's Atomix connect test.

---

### Task 1: Migration 11, settings, the provider interface and the Jellyfin/Emby provider

**Files:**
- Modify: `src/db.js` (`MIGRATIONS[10]`), `src/settings.js` (`remoteSyncHours: 6`)
- Create: `src/remote/provider.js` (the interface as a documented base class with `kind`), `src/remote/jellyfin.js`, `src/remote/urls.js` (`normaliseUrl`)
- Test: `test/migrations.test.js` (add), `test/remote-jellyfin.test.js` (new, with a fake Jellyfin via `fakeServer`)

**Interfaces:**
- Produces: `normaliseUrl(input: string) → string` (adds `https://` when no scheme, drops a trailing `/`, keeps path and port; throws `HttpError(400)` on garbage); `class JellyfinProvider { constructor({ kind: 'jellyfin'|'emby', version }) ; connect({ url, username, password }) → Promise<{ secret, remoteUserId, serverName }> ; libraries(server) → Promise<[{ remoteId, name, type }]> ; async *items(server, library, kind, parentRemoteId?) ; imageUrl(server, item, type) → { url, headers } | null ; streamUrl(server, item) → { url, headers } ; reportProgress(server, item, { position, duration, watched }) → Promise<void> ; ping(server) → Promise<{ ok, detail }> }`; `RemoteItem` as in spec §3; `server` is the `servers` row.
- Tables/columns: `servers`, `libraries.server_id`, `libraries.remote_id`, `items.remote_id`, index `items_remote`.

- [ ] **Step 1: Failing migration test** — `test/migrations.test.js`: `migration 11 adds servers, libraries.server_id/remote_id, items.remote_id` asserting the `servers` columns `['id','kind','name','url','username','secret','remote_user_id','status','status_detail','last_sync','created_at']`, the two library columns, `items.remote_id`, index `items_remote`, and `user_version === MIGRATIONS.length`.
- [ ] **Step 2: Run** `node --test test/migrations.test.js` — Expected: FAIL.
- [ ] **Step 3: Migration** — append `MIGRATIONS[10]` per spec §2 (`servers` with `CHECK (kind IN ('jellyfin','emby','atomix'))` and `status` default `'ok'`; `ALTER TABLE libraries ADD COLUMN server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE`; `ALTER TABLE libraries ADD COLUMN remote_id TEXT`; `ALTER TABLE items ADD COLUMN remote_id TEXT`; `CREATE INDEX items_remote ON items(library_id, remote_id)`). Add `remoteSyncHours: 6` to `SETTING_DEFAULTS`.
- [ ] **Step 4: Run** `node --test test/migrations.test.js test/themes.test.js` — Expected: PASS.
- [ ] **Step 5: Failing provider tests** — `test/remote-jellyfin.test.js` with a fake Jellyfin (`fakeServer`) that records requests and answers: `POST /Users/AuthenticateByName` (200 `{ AccessToken: 'tok1', User: { Id: 'u1' }, ServerName: 'Fake Jellyfin' }` when the body is `{ Username: 'dallas', Pw: '4321' }`, else 401); `GET /Users/u1/Views` → `Items: [{ Id: 'lib-m', Name: 'Movies', CollectionType: 'movies' }, { Id: 'lib-t', Name: 'TV Shows', CollectionType: 'tvshows' }, { Id: 'lib-x', Name: 'Photos', CollectionType: 'homevideos' }]`; `GET /Users/u1/Items?ParentId=lib-m&IncludeItemTypes=Movie…` → two pages of one movie each (`TotalRecordCount: 2`, honour `StartIndex`), one with `RunTimeTicks: 7200000000`, `OfficialRating: 'NZ-R16'`, `People: [{ Name: 'Ridley Scott', Type: 'Director' }, { Name: 'Sigourney Weaver', Type: 'Actor' }]`, `Tags: ['space']`, `ProviderIds: { Tmdb: '348', Imdb: 'tt0078748' }`, `MediaSources: [{ Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080, VideoRange: 'HDR' }, { Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', Index: 1 }, { Type: 'Subtitle', Codec: 'subrip', Language: 'eng', Index: 2 }] }]`, `ImageTags: { Primary: 'x' }`, `BackdropImageTags: ['y']`, and a second movie with no `MediaSources` and `OfficialRating: 'Not Rated'`; `GET /System/Info/Public` → 200; `GET /Users/Me` → 200 with the right token header, 401 otherwise. Tests:
  - `connect: a good sign-in gives the token, user id and server name; a bad one is a 401 HttpError` (also asserts the request carried `Authorization: MediaBrowser Client="Atomix", …` for jellyfin and `X-Emby-Authorization` when `kind: 'emby'`).
  - `libraries: only movies, tvshows and music views, mapped to Atomix types` → `[{ remoteId: 'lib-m', name: 'Movies', type: 'movies' }, { remoteId: 'lib-t', name: 'TV Shows', type: 'tv' }]`.
  - `items: pages through movies and shapes them` → two `RemoteItem`s; the first has `runtime: 120`, `certification: 'NZ:R16'`, `people: [{ name: 'Ridley Scott', role: 'director' }, { name: 'Sigourney Weaver', role: 'cast' }]`, `keywords: ['space']`, `tmdbId: 348`, `imdbId: 'tt0078748'`, `media.container === 'mkv'`, `media.video.codec === 'hevc'`, `media.video.hdr === true`, `media.audio[0].channels === 2`, `images.poster === true && images.backdrop === true`; the second has `media: null` and `certification: 'Not Rated'`.
  - `imageUrl/streamUrl carry the token in a header, never in the URL` → `url` matches `/Items/<id>/Images/Primary$` and `/Videos/<id>/stream?static=true$`, `headers.Authorization` includes `Token="tok1"`, and `url` does not contain `tok1`.
  - `reportProgress posts progress, played, and stopped` → the fake records `POST /Sessions/Playing/Progress` with `PositionTicks: 300000000` for `{ position: 30 }`, `POST /Users/u1/PlayedItems/<id>` for `{ watched: true }`, and `POST /Sessions/Playing/Stopped` for `{ position: 5, watched: false }`.
  - `ping: ok, unreachable, unauthorized` → `{ ok: true }`; a dead port → `{ ok: false, detail: /ECONNREFUSED|fetch failed/ }`; a wrong token → `{ ok: false, detail: 'unauthorized' }`.
  - `normaliseUrl` → `'jelly.local:8096'` → `'https://jelly.local:8096'`; `'http://10.0.0.5:8096/'` → `'http://10.0.0.5:8096'`; `'https://x/jellyfin/'` → `'https://x/jellyfin'`; `'not a url'` throws 400.
- [ ] **Step 6: Run** — Expected: FAIL (modules missing).
- [ ] **Step 7: Implement** `src/remote/urls.js`, `src/remote/provider.js` (base class documenting the methods; throws "not implemented"), `src/remote/jellyfin.js` per spec §3.1. Fetch helper inside the provider: `request(server, path, { method, body, query, headers, timeoutMs = 15000 })` using `fetch` with `AbortSignal.timeout`, throwing `HttpError(401)` on 401 and `HttpError(502, 'Can't reach <server.name>')` on network errors/5xx. Ticks ↔ seconds: `× 10 000 000`. The rating prefix: `/^([A-Z]{2})-(.+)$/` → `XX:rest`, else as given. Item paging: `Limit=200`, loop while `StartIndex < TotalRecordCount`.
- [ ] **Step 8: Run** `node --test test/remote-jellyfin.test.js` and `npm test` — Expected: PASS; suite green.
- [ ] **Step 9: Ledger** `Task 1: complete`.

---

### Task 2: The Atomix provider (against a real second Atomix)

**Files:**
- Create: `src/remote/atomix.js`
- Test: `test/remote-atomix.test.js` (two in-process Atomix servers via `startAtomix` — the far one with a movie, a show and a song made by `makeVideo`/`makeAudio`; a second account `guest` with two profiles both PIN'd for the Review-Focus case)

**Interfaces:**
- Produces: `class AtomixProvider` with the same interface; `server.secret` is the password; the cookie lives in a module-level `Map<serverId, cookie>`.

- [ ] **Step 1: Failing tests**
  - `connect signs in, picks the first PIN-less non-kids profile, and gives its id` → `{ secret: 'password123', remoteUserId: '<profile id>', serverName: <far server name> }`; a wrong password → 401; the `guest` account (PIN'd profiles only) → `HttpError(400, 'Make a profile without a PIN for Atomix to use')`.
  - `libraries lists the far libraries with their types` → three entries.
  - `items shape movies, shows, seasons, episodes, artists, albums and tracks with media and images` → the movie `RemoteItem` has `media.video` (from the far `/api/items/:id`), `images.poster` true when the far item has a poster; a show → its seasons via `parentRemoteId` → episodes with `season`/`episode` numbers; tracks carry `artist`, `album`, `track`, `duration`.
  - `streamUrl and imageUrl use the far routes with the cookie header` → `url` ends with `/api/items/<id>/file`, `headers.cookie` starts with `atomix_session=`.
  - `a 401 later signs in again once, then marks unauthorized` → change the far password through its API, call `ping` → `{ ok: false, detail: 'unauthorized' }`.
  - `reportProgress posts to the far progress route` → the far item's progress reads back.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `src/remote/atomix.js` per spec §3.2 (`signIn(server)` → cookie; `request` retries once after a fresh sign-in on 401; profile choice through `GET /api/me` → `profiles` from `/api/status`'s `profileCount`? No: use `GET /api/profiles` (it exists for the account) and pick the first with `!kids && !hasPin`; items from `/api/libraries/:id/items`, `/api/items/:id/children`, `/api/items/:id`).
- [ ] **Step 4: Run** `node --test test/remote-atomix.test.js` — Expected: PASS.
- [ ] **Step 5: Ledger** `Task 2: complete`.

---

### Task 3: The sync — remote libraries become items

**Files:**
- Create: `src/remote/sync.js`, `src/remote/index.js` (`providerFor(kind, { version })`, `isRemotePath(p)`, `remotePath(serverId, remoteId)`)
- Modify: `src/library/scanner.js` (`scanLibrary` hands a `server_id` library to `RemoteSync`; `schedule()` adds the remote interval; `prune` unchanged), `src/library/metadata.js` (`enrichMissing` skips `remote:%`), `src/extras/store.js` (`PREVIEWABLE`, `CHECKABLE`, `THUMBABLE` gain `AND i.path NOT LIKE 'remote:%'`), `src/app.js` (wire `core.remote = { providers, sync }`)
- Test: `test/remote-sync.test.js` (a real Atomix with a `servers` row pointing at the fake Jellyfin from Task 1's fixture — move that fake into `test/helpers-jellyfin.js` exporting `fakeJellyfin({ movies, shows })`)

**Interfaces:**
- Consumes: Task 1 and 2 providers.
- Produces: `RemoteSync.syncLibrary(lib, { scanId, status }) → Promise<{ added, removed, error? }>`; items with `path = 'remote:<serverId>:<remoteId>'`, `remote_id`, `metadata_locked = 1`, `metadata_at`, `poster`/`backdrop`/`logo` as the provider's image URLs (fetched with headers by Task 5's route), `media`, `duration`, `min_age`, `keywords`, `people`.

- [ ] **Step 1: Failing tests** (insert the `servers` row and the library directly in the db, then `POST /api/libraries/:id/scan` and `waitForScan`):
  - `a sync creates remote items with locked metadata, media, rating and people` → the two movies exist with `path` `remote:1:<id>`, `metadata_locked === 1`, `min_age === 16` for `NZ:R16`, `keywords` and `people` JSON, `media` JSON for the first and `media === null` for the stub.
  - `a show syncs with its seasons and episodes under it` → `parent_id`/`show_id` set, `season`/`episode` numbers.
  - `a second sync prunes what the server no longer has` → remove a movie from the fake, rescan, the row is gone (and the library's `last_scan` moved).
  - `an unreachable server leaves the library as it was and marks the server` → point the row at a dead port, rescan, items still there, `servers.status === 'unreachable'`, scan status `error` mentions the server name.
  - `local-only jobs skip remote titles` → `store.nextPreviewItem()` and `nextIntroSeason()` return nothing for them; `metadata.enrichMissing()` reports `done: 0`.
  - `remoteSyncHours schedules remote libraries apart from folder ones` → with `scanIntervalMinutes: 0` and `remoteSyncHours: 6` the scanner's `schedule()` sets a remote timer (`scanner.remoteTimer` defined) and none for folders.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §4: the scanner's `scanLibrary` early-branch `if (lib.server_id) return this.remote.syncLibrary(lib, …)` keeping the status/phase/hook calls; `RemoteSync` pages kinds in order and calls `scanner.upsertItem` with the fields listed above (plus `sort_title`, `added_at` from the first sight, `seen_scan`), then `scanner.prune(lib, ['remote'], scanId, ['remote'])` — read `prune`'s path filter: it keeps rows whose `path` is under a reachable root; pass a root of `remote:<serverId>:` so the `startsWith` check matches. `certToAge(certification, settings.get('ratingCountry'))` for `min_age`. Collections: `collections.upsertTmdb` only when `tmdbId` and a TMDB key exist — call `metadata.tmdb.collectionOf({ id })`? No: TMDB gives `belongs_to_collection` only on a movie fetch; skip collections for remote titles this round and ledger it (spec §4 step 2 allows "otherwise nothing").
- [ ] **Step 4: Run** `node --test test/remote-sync.test.js` then `npm test` — Expected: PASS.
- [ ] **Step 5: Ledger** `Task 3: complete`.

---

### Task 4: Kids, access and the hidden local-only actions

**Files:**
- Modify: `src/api/library.js` (`/api/items/:id/download` → 400 for remote; `/api/items/:id/refresh` and `/identify` → 400; `listSubtitles` call skipped for remote — embedded tracks come from `media`), `public/js/views/item.js` (no Download/Refresh info/Fix match for `item.remote`), `src/api/serialize.js` (`remote: true` on remote items; `serializeLibrary` adds `serverId`, `serverName`, `remoteId`)
- Test: `test/remote-sync.test.js` (add cases)

- [ ] **Step 1: Failing tests** — `a kids profile sees the G-rated remote film and not the R16 one; an unknown rating follows allowUnrated` (fake movies rated `NZ-G`, `NZ-R16`, `Not Rated`; `maxAge: 10`, `allowUnrated` false then true); `download, refresh and identify answer 400 for a remote title`; `serializeLibrary carries the server name` via `GET /api/libraries`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; in `item.js` hide the three buttons/sheet entries when `item.remote`.
- [ ] **Step 4: Run** — Expected: PASS; `npm test` green.
- [ ] **Step 5: Ledger** `Task 4: complete`.

---

### Task 5: Playback through Atomix — the proxy, ffmpeg from a URL, images, progress push

**Files:**
- Modify: `src/stream/playback.js` (`create()` takes `source: { file, headers }` resolved by the caller; `buildFfmpegArgs` adds `-headers` before `-i` when `plan.headers`), `src/api/playback.js` (resolve the source: local path or `provider.streamUrl`), `src/api/library.js` (`/api/items/:id/file` proxies for remote; `/api/items/:id/image/:type` downloads with headers for remote), `src/library/images.js` (`download(url, headers)` already; add `downloadWithKey(key, url, headers)` so the cache file name is keyed on the item not the URL? — no: the URL is stable per server; keep `download`)
- Create: `src/remote/progress.js` (`attachProgressPush(core)`: listens to `playback:progress`, rate-limits 10 s per item, pushes with `watched`)
- Test: `test/remote-play.test.js` (the fake Jellyfin serves a real small MP4 from `makeVideo` at `/Videos/<id>/stream` honouring `Range`, and records progress calls)

**Interfaces:**
- Produces: `GET /api/items/:id/file` for a remote item → proxied 200/206 with `Content-Range` copied; `POST /api/items/:id/playback` works for remote items (direct or transcode); `playback:progress` → provider.reportProgress.

- [ ] **Step 1: Failing tests** — `the file route proxies a remote stream with Range` (request `Range: bytes=0-99` → 206, `Content-Range` starts with `bytes 0-99/`, body 100 bytes); `a start on a remote film works, direct or converted` (`POST /api/items/:id/playback` 200 with `url` `/api/items/:id/file` for a direct decision; then with `quality: '480p'` or `forceTranscode`, an HLS/progressive session whose first bytes arrive — skipped without ffmpeg); `an image route fetches the poster with the token and caches it` (the fake serves a PNG at `/Items/<id>/Images/Primary` only with the token header; `GET /api/items/:id/image/poster` → 200 image, and the fake saw the header); `progress is pushed to the server, at most once per 10 s plus the final one` (three quick `POST /api/items/:id/progress` → one `Sessions/Playing/Progress` call; a `watched` report → `PlayedItems`); `a server that answers 401 at play marks it unauthorized and the start answers 502` ; `removing the server mid-play ends the session cleanly` (heartbeat → 404, no crash).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §5: a `resolveSource(item)` in `src/remote/index.js` → `{ file: item.path, headers: null }` for local, `{ file: url, headers }` for remote (looks up the library's server and provider); `create()` stores `headers` on the session; `buildFfmpegArgs` pushes `'-headers', Object.entries(headers).map(([k, v]) => \`${k}: ${v}\\r\\n\`).join('')` before `-i` (and `-reconnect 1 -reconnect_streamed 1`); the file route for remote: `fetch(url, { headers: { ...headers, range: req.headers.range }, signal })`, copy status and the listed headers, pipe `res.body` (Readable.fromWeb) to the response, abort on client close; the image route for remote: `images.download(url, headers)` then `sendFile`.
- [ ] **Step 4: Run** `node --test test/remote-play.test.js` then `npm test` — Expected: PASS.
- [ ] **Step 5: Ledger** `Task 5: complete`.

---

### Task 6: The servers API

**Files:**
- Create: `src/api/servers.js` (`registerServerRoutes(r, core)`), register in `src/app.js`
- Modify: `src/api/admin.js` or wherever `/api/status` builds admin fields (`servers: [{ id, name, kind, status, statusDetail, lastSync }]`), `src/library/scanner.js` (`scanAll` and the servers' `sync` queue remote libraries)
- Test: `test/remote-api.test.js` (fake Jellyfin + a real Atomix as admin and as a viewer)

**Interfaces:**
- Produces the routes of spec §6: `GET /api/servers`, `POST /api/servers`, `PUT /api/servers/:id/libraries`, `POST /api/servers/:id/sync`, `POST /api/servers/:id/reconnect`, `DELETE /api/servers/:id`; all `{ auth: 'admin' }`.

- [ ] **Step 1: Failing tests** — `POST /api/servers connects, stores the row without returning the secret, and lists available libraries` (`available` has Movies and TV Shows only; the response has no `secret`; `GET /api/servers` neither); `a bad sign-in is a 401 with the server's message`; `connecting this Atomix to itself is refused` (`url` = `nf.base` → 400 "That's this Atomix"); `PUT libraries creates library rows, queues a sync, and unticking removes a library and its items`; `DELETE removes the server, its libraries and items; the picks cache is cleared` ; `viewers and kids get 403`; `/api/status lists servers with their state` ; `reconnect replaces the secret and resets status`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §6 and §7 (self-connect check: the normalised URL's host:port equals one of this server's own listening addresses or `127.0.0.1`/`localhost` with the same port — compare against `config.port` and `os.networkInterfaces()` addresses).
- [ ] **Step 4: Run** — Expected: PASS; `npm test` green.
- [ ] **Step 5: Ledger** `Task 6: complete`.

---

### Task 7: Settings — the Connected servers panel, library rows, the dashboard card

**Files:**
- Modify: `public/js/views/settings.js` (`serversPanel()` above the libraries list; `connectServerDialog()` two steps; `chooseLibrariesDialog(server)`; remote rows in the libraries list show the server name and no paths; `libraryDialog` hides paths/previews for remote; the dashboard status card lists servers), `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css` (`.servers-panel`, `.server-row`, `.server-state`, the kind pills)
- Harness: `devtools/mock-jellyfin.mjs` (:9914, per spec §10; add to `restart-dev.sh`), `devtools/servers-ui.mjs`

- [ ] **Step 1: Mock + failing browser checks** — `servers-ui.mjs` sections `connect|browse|play|kids|remove`: connect through the dialog with a remote (`Tab`/arrows to the kind pills, type the address `http://127.0.0.1:9914`, `dallas`/`4321`, Enter → the libraries step → tick Movies and TV Shows → Add) and assert the server row says "Synced just now" after the scan; the menu has the new libraries; Home has a "Recently added in Movies (Fake Jellyfin)" row; a remote film page has Play and no Download/Fix match; playing it to the end returns to the page and the mock recorded `Sessions/Playing/Progress` and `PlayedItems`; the kids profile sees the G film and not the R16 one; Remove takes the server, its libraries and rows away; no console errors.
- [ ] **Step 2: Run** `node /home/claude/devtools/servers-ui.mjs` — Expected: FAIL at the panel.
- [ ] **Step 3: Implement** the panel and dialogs (copy: "Connect a server…", "Connect", "Add", "Sync now", "Libraries…", "Remove", "Sign in again", "Can't reach <name>", "Synced <relative time>", "No longer on <name>"; the http note "Sign-ins travel unencrypted over http" under the address field when the address starts with `http://`); styles; dashboard card.
- [ ] **Step 4: Run** the harness ×2, `orbit-ui`, `orbit-sizes` (add a `settings-libraries` page at phone size with a server row), `orbit-a11y` (add `.server-row .muted` contrast) — Expected: all PASS.
- [ ] **Step 5: Ledger** `Task 7: complete`.

---

### Task 8: Pictures, docs, version, full verification, delivery

- [ ] **Step 1: Pictures** — `devtools/v011-shots.mjs`: the Connected servers panel with one server, the connect dialog's second step, a remote film page, Home with the remote row; desktop and phone; sheets `orbit-progress/v0110-desktop.png`, `v0110-phone.png`; look and fix.
- [ ] **Step 2: Older themes** — `oldthemes-compare.mjs compare` → all match (frozen data has no servers).
- [ ] **Step 3: Docs and version** — README bullet **Connected servers** (Jellyfin, Emby, another Atomix; synced, played through Atomix, progress pushed back; Plex next), a "Connecting a server" paragraph under Organising; ARCHITECTURE: `servers`, migration 11, `src/remote/*`, the sync, the proxy, progress push; `package.json` `0.11.0`.
- [ ] **Step 4: Full verification** — `npm test` (expect ≥ 250), `servers-ui` ×2, `extras-lyrics-ui` 32, `lists-ui` 24, `orbit-ui` 158, `orbit-sizes` 85+, `orbit-a11y` 61+, `gate-ui` 60, `extras-ui`, `rebrand-ui`, `music-kbd`, `profiles-ui`, `dialogs`, older themes.
- [ ] **Step 5: Delivery** — hash-check and deliver to `D:\Nodeflix`; PC `npm test`; project note (Round 13 / v0.11.0; what to try with a real Jellyfin: connect, sync time on a big library, play a 4K HEVC title through Atomix on the TV, watched state in Jellyfin's app).
- [ ] **Step 6: Ledger** `Task 8: complete`; the fresh review (Review Focus verbatim; ledger rulings), one fix pass, final message, workspace deleted (ledger copy kept).
