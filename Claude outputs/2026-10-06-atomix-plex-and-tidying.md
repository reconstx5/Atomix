# Plex and tidier connected servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Plex as a fourth connected-server kind (sign-in with a plex.tv link code), and make every connected server keep its own "added" dates, refresh changed artwork, tell the server when a stream starts and stops without slowing the player, and stop live streams when it is removed. Ships as v0.12.0.

**Architecture:** Two new modules, `src/remote/plextv.js` (pins, resources, choosing an address) and `src/remote/plex.js` (`PlexProvider`, the `RemoteProvider` interface), plus Plex routes in `src/api/servers.js` and a Plex branch in the connect dialog. The sync gains "details only when changed", server added dates and image forgetting. `src/remote/progress.js` becomes a per-server queued reporter of start, progress, stop and watched, fed by the existing `playback:start`, `playback:progress` and `playback:stop` hooks.

**Tech Stack:** Node ≥ 22.13 (node:http, node:sqlite, node:test, global fetch), zero npm dependencies, plain ES-module browser JS, Playwright harnesses in `/home/claude/devtools` (cloud only).

**Spec:** `docs/superpowers/specs/2026-10-06-atomix-plex-and-tidying-design.md`

## Global Constraints

- Node ≥ 22.13 and zero npm dependencies; plain ES-module browser JS; no build step.
- Orbit first with a TV remote. The older themes change only where this spec adds content.
- Tokens travel in headers, never in a URL the browser sees. No route returns a stored token: `secret` and `extra` are never serialised.
- Nothing leaves the server except calls to plex.tv (sign-in and the server list) and to the servers the admin connected, plus the existing LRCLIB query and YouTube embed.
- The plex.tv base comes from `ATOMIX_PLEXTV_BASE` (default `https://plex.tv`). Tests and the dev mock never touch the real service.
- A 401 from plex.tv or any connected server is never passed on as a 401: it becomes a 400 or 502, since the client reads a 401 as this session ending.
- Plex headers on every call: `X-Plex-Product: Atomix`, `X-Plex-Version: <version>`, `X-Plex-Client-Identifier: <plexClientId>`, `Accept: application/json`; plus `X-Plex-Token` when a token is used, and `X-Plex-Device-Name: <serverName>` on pins.
- Copy, exactly as the spec gives it:
  - "Go to **plex.tv/link** on your phone or computer and enter this code"
  - "Waiting for Plex…"
  - "That code has expired" with the button **New code**
  - "Couldn't reach plex.tv: <detail>" with the button **Try again**
  - "This Plex account has no servers."
  - "Pick a server"
  - "Yours" / "Shared by <owner>"
  - "via Plex relay (slow)"
  - "Couldn't reach <name> at any of its addresses (<uri>, …)"
  - "<name> is already connected."
  - "That Plex account can't see <name>."
- `package.json` version `0.12.0`; migration 12.

## Review Focus

1. A Plex `thumb` that is an absolute URL to another host (e.g. `https://metadata-static.plex.tv/...`, which agents set): Atomix must use it as-is, never prefix the server address, and never send the Plex token to that other host. Pinned in Task 3.
2. A shared server: playback, images, timeline and scrobble must use the resource's own `accessToken` (the stored `secret`), not the account token in `extra`. Pinned in Task 2 and Task 5.
3. A stream that ends by idle reap, replacement or shutdown sends exactly one stop report. A session stopped twice (leaving the player, then the reap) must not report twice. Pinned in Task 6.
4. A pin that has already been used to connect (it is dropped from the Map) and is then polled, or used again in `POST /api/servers`: the answer is `{ expired: true }` or a 400, never a 500. Pinned in Task 5.
5. A Plex listing whose pages are exactly 200 long and that carries no `totalSize`: the sync reads to the first empty page, and stops there instead of looping or cutting off. Pinned in Task 3.

---

### Task 1: Migration 12 and the Plex client id

**Files:**
- Modify: `src/db.js` (append `MIGRATIONS[11]`), `src/settings.js` (default `plexClientId: null`), `src/api/admin.js` (`plexClientId` must not be settable through `PUT /api/admin/settings`)
- Test: `test/migrations.test.js`

**Interfaces:**
- Produces:
  - `servers.kind` accepts `'plex'`; `servers.extra TEXT` (JSON); `items.remote_updated INTEGER`.
  - `plexClientId(settings) → string` in `src/remote/plextv.js`. It is created in Task 2, but its contract is fixed here: it generates `crypto.randomUUID()` on first call, stores it with `settings.set({ plexClientId })`, and returns the same value afterwards.

- [ ] **Step 1: Failing test** `migration 12 lets servers be plex, adds servers.extra and items.remote_updated, and keeps existing rows`:
  - open a DB `upTo: 11`;
  - insert a jellyfin server row and a library pointing at it;
  - reopen it fully;
  - assert the row is unchanged, `extra` exists and is null, `INSERT … kind = 'plex'` succeeds, `items` has `remote_updated`, the library's `server_id` still points at the row, and `user_version` is `MIGRATIONS.length`.
- [ ] **Step 2: Run** `node --test test/migrations.test.js`. Expected: FAIL (`kind` CHECK constraint).
- [ ] **Step 3: Implement** the migration.
  - Rebuild `servers` with `PRAGMA foreign_keys = OFF` around it, as migration 10 did for `media_jobs`. The FK from `libraries` must survive the rename.
  - Add `ALTER TABLE items ADD COLUMN remote_updated INTEGER`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Ledger** `Task 1: complete`.

### Task 2: plex.tv — link codes, the server list, choosing an address

**Files:**
- Create: `src/remote/plextv.js`, `test/helpers-plex.js` (`fakePlexTv`, `fakePlex`; Task 3 extends `fakePlex`), `test/plextv.test.js`
- Modify: `src/config.js` (read `ATOMIX_PLEXTV_BASE` into `config.plexTvBase`)

**Interfaces:**
- Consumes: the `settings` object; `HttpError`.
- Produces (`src/remote/plextv.js`):
  - `plexHeaders({ clientId, version, token?, deviceName? }) → object`
  - `class PlexTv`, built with `{ base, settings, version, serverName: () => string }`, with these methods:
    - `createPin() → { id, code, expiresAt }` (`expiresAt` in ms)
    - `checkPin(id) → { authToken } | { pending: true, expiresAt } | { expired: true }`
    - `resources(token) → [{ clientIdentifier, name, owned, sourceTitle, accessToken, connections: [{ uri, local, relay, protocol }] }]` (servers only)
  - `chooseConnection(resource, { timeoutMs = 4000 }) → { url, relay } | null`
    - Order: local non-relay → remote `https` non-relay → other non-relay → relay.
    - Each try is `GET <uri>/identity` with `X-Plex-Token: resource.accessToken`; it accepts only a matching `MediaContainer.machineIdentifier`.
    - It records the tried URIs on `chooseConnection.lastTried` for the error message.
  - `plexClientId(settings)` (Task 1 contract).
  - Errors: a network failure or 5xx from plex.tv is `HttpError(502, "Couldn't reach plex.tv: <detail>")`; a 401 from plex.tv is `HttpError(400, 'Plex did not accept that sign-in.')`.

- [ ] **Step 1: Failing tests** in `test/plextv.test.js`, against `fakePlexTv({ linkAfter: 2, servers })` and two `fakePlex` instances (one live, one closed port, for a dead address):
  - `a pin is created with Atomix's headers, stays pending, then links with a token`:
    - the fake records `x-plex-product: Atomix` and the client id;
    - `checkPin` returns `{ pending: true }` twice, then `{ authToken: 'acct1' }`.
  - `an expired pin says so`: the fake was made with `expireAfter: 0`, so the answer is `{ expired: true }`.
  - `resources keeps servers only, with owner and the server's own token`:
    - a `player` resource is dropped;
    - the shared server keeps `sourceTitle: 'Friend'` and `accessToken: 'shared1'`, not `acct1`.
  - `chooseConnection skips a dead local address and takes the working one; a relay only when nothing else answers; a mismatched machine id is refused`. Three resources cover it:
    - one with a dead local and a live remote, giving the live URL and `relay: false`;
    - one with only a relay live, giving `relay: true`;
    - one whose live server has another machine id, giving null with `lastTried` listing both URIs.
  - `plexClientId is made once and kept`: two calls give the same UUID, and settings hold it.
  - `plex.tv down is a 502 "Couldn't reach plex.tv"; a 401 is a 400`.
- [ ] **Step 2: Run** `node --test test/plextv.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/remote/plextv.js` and the fakes.
  - `fakePlexTv` serves `/api/v2/pins`, `/api/v2/pins/:id` and `/api/v2/resources`. It records calls; `state.tokenRevoked` makes resources answer 401.
  - `fakePlex` serves `/identity`, and records calls.
- [ ] **Step 4: Run** the file, then `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 2: complete`.

### Task 3: The Plex provider

**Files:**
- Create: `src/remote/plex.js`, `test/remote-plex.test.js`
- Modify: `src/remote/index.js` (`makeProviders` registers `plex: new PlexProvider({ kind: 'plex', version, settings })`; `makeProviders` now takes `{ version, settings }`, and `src/app.js` passes `settings`), `src/remote/provider.js` (document the interface's new methods), `test/helpers-plex.js` (`fakePlex` gains the library)

**Interfaces:**
- Consumes: `plexHeaders`, `plexClientId` (Task 2); `RATING_COUNTRIES` from `src/library/ratings.js`.
- Produces (`PlexProvider`):
  - `libraries(server) → [{ remoteId, name, type }]`
  - `async *items(server, library, kind, parentRemoteId?)` yields RemoteItems with two added fields, `addedAt` (ms) and `updated` (ms), and with `media.plexPart` set.
  - `details(server, item) → media` (streams filled)
  - `imageUrl(server, item, type) → { url, headers } | null`. The item carries `images.posterPath` and `images.backdropPath` (the raw `thumb`/`art`).
  - `streamUrl(server, item)`, where item is `{ remoteId, kind, media }` → `{ url: server.url + media.plexPart, headers }`
  - `reportStart`, `reportProgress`, `reportStop` → timeline calls; watched → scrobble
  - `ping(server) → { ok, detail }`
  - The RemoteItem contract gains `addedAt` and `updated`, for every provider (Task 4 fills them for the others).

- [ ] **Step 1: Failing tests** in `test/remote-plex.test.js` against `fakePlex` with a movie section, a show section, a music section and a photo section:
  - `libraries maps movie/show/artist and skips photo`.
  - `items page through a section and map fields`:
    - page size 200 is forced to 1 by the fake, with no `totalSize`, giving all 3 movies (Review Focus 5);
    - for "Alien": `runtime 117`, `duration 7020`, `certification 'GB:15'` from `gb/15`, `tmdbId 348` and `imdbId 'tt0078748'` from `Guid`;
    - `people` holds the director, then up to 8 cast;
    - `addedAt` is 1700000000000 and `updated` is 1710000000000;
    - `media.plexPart` is `'/library/parts/11/1700000000/file.mkv'` and `media.video.codec` is `'hevc'`;
    - `images.poster` is true.
  - `ratings: gb/15 → GB:15, uk/12A → GB:12A, PG-13, TV-MA and NR stay`.
  - `shows → seasons → episodes and artists → albums → tracks through /children`: season numbers, episode numbers, track/disc, artist/album names.
  - `details fills video bit depth and HDR, audio and embedded subtitles; external subtitle streams (with a key) are left out`.
  - `image URLs carry Plex's timestamp and the token in a header; an absolute thumb on another host is used as-is with no token` (Review Focus 1).
  - `streamUrl is the server address plus the part key; the token in a header, never in the URL`.
  - `timeline playing/paused/stopped and scrobble are sent with ms times and the ratingKey`: the fake records each call.
  - `ping: ok; a dead address; a 401 is unauthorized; a different machine id is not ok`.
- [ ] **Step 2: Run** `node --test test/remote-plex.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/remote/plex.js` per spec §4.
  - Paging: `X-Plex-Container-Start` and `X-Plex-Container-Size` as query parameters. Stop on an empty page, or when `totalSize` is given and reached.
  - Watched: `reportProgress` with `watched: true` calls scrobble, then a `stopped` timeline.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 3: complete`.

### Task 4: Sync — details only when changed, server dates, artwork that refreshes

**Files:**
- Modify:
  - `src/remote/sync.js`
  - `src/remote/jellyfin.js` (`DateCreated` in `FIELDS`; `addedAt`; image URL `?tag=`)
  - `src/remote/atomix.js` (`addedAt`; image URL keeps the far `?v=`)
  - `src/library/images.js` (`forget(url)`)
  - `test/helpers-jellyfin.js` (`DateCreated`, `ImageTags` values)
- Test: `test/remote-sync.test.js`, `test/remote-plex.test.js` (sync cases)

**Interfaces:**
- Consumes: Task 3's `details`, `addedAt`, `updated` and `images.*Path`.
- Produces:
  - `ImageCache.forget(url) → void`. It deletes the cached file for that URL under any extension, if one exists.
  - `RemoteSync` writes `added_at` from `addedAt` on create.
  - A row with `remote_updated IS NULL` (synced before 0.12) gets `added_at = addedAt` once, when `addedAt` is given. In the same write, `remote_updated` becomes `updated ?? 0`. After that the row is never corrected again.
  - The sync calls `provider.details?.(server, it)` for movie/episode/track when the row is new, when `it.updated != null && remote_updated !== it.updated`, or when the stored media has no `audio` array. Only Plex has `details`.

- [ ] **Step 1: Failing tests:**
  - `remote-sync`: `a Jellyfin title keeps its DateCreated as added_at; Recently added shows only the server's recent titles`.
    - The fake gives `m1` a DateCreated of 2020 and `m2` one of today.
    - Assert `added_at` matches each.
    - `/api/home`'s Recently added row lists `m2` before `m1`.
  - `remote-sync`: `an item synced before 0.12 (remote_updated null) gets its server date once, then never moves`.
  - `remote-sync`: `a changed ImageTags.Primary gives a new poster URL, bumps metadata_at, and the old cached file is forgotten`.
    - Fetch the poster through the image route so it is cached.
    - Change the tag in the fake and sync.
    - Assert the old cache file is gone and the new URL holds `?tag=`.
  - `remote-plex`: `a second sync with nothing changed makes no detail requests; a changed updatedAt makes exactly one`. The fake counts `/library/metadata/:id` calls.
  - `remote-plex`: `a failed detail request keeps the listing's media and asks again next sync`.
  - `remote-plex`: `kids rules apply to Plex titles` (`TV-MA` hidden from a 10-year-old profile, `gb/PG` shown).
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §4.3, §5.1 and §5.2.
  - Pace details at 25 ms (`this.paceMs ?? 25`; tests set 0).
  - Superseded image URL: compare the stored `poster`/`backdrop`/`logo` with the new ones before the UPDATE, and `images.forget(old)` when they differ. `RemoteSync` now gets `images`, which `src/app.js` passes.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 4: complete`.

### Task 5: The servers API for Plex, and Remove that cleans up

**Files:**
- Modify: `src/api/servers.js`, `src/app.js` (`core.remote.plextv = new PlexTv(...)`), `src/remote/sync.js` (the address refresh on a failed ping)
- Test: `test/remote-plex-api.test.js` (new), `test/remote-api.test.js` (the Remove clean-up)

**Interfaces:**
- Consumes: `PlexTv`, `chooseConnection` (Task 2); `PlexProvider` (Task 3); `ImageCache.forget` (Task 4); `core.playback.sessions`, `core.playback.stop(id, reason)`.
- Produces the routes of spec §6:
  - `POST /api/servers/plex/pins`
  - `GET /api/servers/plex/pins/:id`
  - `POST /api/servers` with `kind: 'plex'`
  - `POST /api/servers/:id/reconnect` with `{ pinId }`
  - `serializeServer` adds `relay: true` when set.
  - The pins Map lives in the routes module. It is keyed by pin id: `{ code, expiresAt, created, token?, resources? }`, dropped after 30 min and after a successful connect.

- [ ] **Step 1: Failing tests** in `test/remote-plex-api.test.js`, against `fakePlexTv` and two `fakePlex`:
  - `the pin flow: code, pending, linked with the server list (Yours / Shared by), and the token never reaches the browser`. No answer body contains `acct1` or `shared1`.
  - `connecting a picked server stores url, secret = that server's token, remote_user_id = machine id, extra = { accountToken, relay } and lists available libraries`. For the shared server, `secret` is `shared1` (Review Focus 2).
  - `no address answers is a 400 naming the addresses; the pin stays usable`.
  - `the same machine twice is a 409 "is already connected."`.
  - `a used or unknown pin: poll → { expired: true }; POST /api/servers with it → 400` (Review Focus 4).
  - `reconnect with a fresh pin updates the token and resets status; an account that can't see the server is a 400 "That Plex account can't see <name>."`.
  - `a revoked token at sync marks the server unauthorized and prunes nothing`.
  - `a server whose address moved is found again through plex.tv at sync, and its url is updated`. The fake server is restarted on a new port, and the fake plex.tv lists the new URI.
  - `/api/servers never shows extra or secret; relay is shown`.
  - In `test/remote-api.test.js`: `DELETE removes the server's cached artwork and stops its live sessions with reason "server removed"`.
    - Start a converted session and fetch a poster first.
    - Assert `playback.sessions` no longer holds it.
    - Assert the cached file is gone.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3.2–3.3, §5.4, §6 and §7 (address change).
  - On Remove, stop the sessions before the `DELETE`, so the stop report (Task 6) still finds the row.
  - Every plex.tv or Plex 401 passes through the existing `far()` / `connect()` wrappers, giving a 400.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 5: complete`.

### Task 6: The reporter — start, progress, stop and watched, queued per server

**Files:**
- Modify:
  - `src/remote/progress.js` (rename the export to `attachReporter(core, { everyMs = 10000 })`; keep `attachProgressPush` as an alias)
  - `src/remote/jellyfin.js` (`reportStart`, `reportStop`, `IsPaused`)
  - `src/remote/atomix.js` (`reportStart`/`reportStop` as no-ops)
  - `src/remote/provider.js` (defaults that do nothing)
  - `test/helpers-jellyfin.js` (record `/Sessions/Playing`; `state.hang` makes the progress routes never answer)
- Test: `test/remote-play.test.js`, `test/remote-plex.test.js` (play cases)

**Interfaces:**
- Consumes:
  - the hooks `playback:start` `{ session, item }`, `playback:progress` `{ item, position, watched }` and `playback:stop` `{ session, reason }`, where `session` carries `itemId`, `position`, `paused`, `duration`;
  - Task 3's Plex reports.
- Produces: listeners that return at once. Each server has one chain, `chains: Map<serverId, Promise>`. A per-session `reported: Set<sessionId>` guarantees a single stop.

- [ ] **Step 1: Failing tests:**
  - `remote-play` (Jellyfin): `a start sends /Sessions/Playing, leaving sends /Sessions/Playing/Stopped once with the last position, in order`.
    - Call `playback/:sid/stop`, then run `playback.reap()` with the clock past idle.
    - Assert exactly one Stopped (Review Focus 3).
    - Assert the call order is Playing → Progress → Stopped.
  - `remote-play`: `a hung server does not delay the progress POST`. With `state.hang = true`, the POST answers in under 500 ms.
  - `remote-plex`: `playing a Plex title through the proxy and through ffmpeg; timeline playing → stopped and scrobble at the end`.
  - `remote-plex`: `embedded subtitles extract through the Plex stream; a title with no Media answers "<server> has no playable file"`.
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §5.3.
  - The stop report uses the session's last known position (`session.position`), so it is sent even when the progress rate limit skipped the last update.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 6: complete`.

### Task 7: The connect dialog's Plex steps, the row, the dev mock and the browser checks

**Files:**
- Modify: `public/js/views/settings.js` (`plexLinkStep()`, `pickPlexServer(servers)`, Plex in `kindPills`, Plex reconnect, the relay note on the row), `public/css/app.css` and `themes/orbit/theme.css` (`.plex-code`, `.plex-servers`)
- Create: `devtools/mock-plex.mjs` (:9915, spec §10)
- Modify: `devtools/restart-dev.sh`, `devtools/run-dev.sh` (`ATOMIX_PLEXTV_BASE=http://127.0.0.1:9915/plextv`), `devtools/servers-ui.mjs` (section `plex`), `devtools/orbit-sizes.mjs` and `devtools/orbit-a11y.mjs`

**Interfaces:**
- Consumes: Task 5's routes.

- [ ] **Step 1: Mock and failing browser checks** in `servers-ui.mjs plex`:
  - Picking the Plex pill shows a 4-character `.plex-code` and the plex.tv/link line, and hides the address and password fields.
  - Within about 6 s (the mock links on its third poll) the "Pick a server" list appears with "Dev Plex · Yours" and "Friend's Plex · Shared by Friend".
  - Down/Up and Enter pick "Dev Plex", and the libraries step reads "Add libraries from Dev Plex".
  - Tick both and press Add. The row reads "Plex · …" and, after the scan, "Synced just now".
  - Home has the Plex movie, and the `TV-MA` film is hidden from Mia.
  - Playing a Plex film works, and the mock's `/__calls` shows timeline `playing` then `stopped` after Back, plus the scrobble after `ended`.
  - Picking "Friend's Plex" (only dead addresses) shows "Couldn't reach Friend's Plex at any of its addresses".
  - An expired code (`/__expire` on the mock) shows "That code has expired" and **New code**.
  - Closing the dialog stops polling: the mock's pin poll count stops growing.
  - Remove takes the row and its libraries away.
  - No console errors.
- [ ] **Step 2: Run** `node /home/claude/devtools/servers-ui.mjs plex`. Expected: FAIL at the Plex pill.
- [ ] **Step 3: Implement** the dialog per spec §3.4, using the copy from Global Constraints.
  - Polling is `setTimeout`-chained every 2 s and stops when the dialog closes.
  - The pick list is buttons with `role=radio` inside `role=radiogroup`; Up and Down move focus.
  - The code is spaced with `letter-spacing` and set in the theme's display type.
- [ ] **Step 4: Run** `servers-ui` (all sections) twice, `orbit-ui`, `orbit-sizes` (add `settings-plex-code` at phone size: no overflow, the code fits), and `orbit-a11y` (add `.plex-code` contrast). Expected: all PASS.
- [ ] **Step 5: Ledger** `Task 7: complete`.

### Task 8: Pictures, docs, version, verification, delivery, review

- [ ] **Step 1: Pictures.** Write `devtools/v012-shots.mjs`. It shoots the Plex code step, the server pick, the Plex row on the panel, and a Plex film page, at desktop and phone size. Assemble them into `orbit-progress/v0120-desktop.png` and `v0120-phone.png`. Look at them and fix what's wrong.
- [ ] **Step 2: Older themes.** Run `oldthemes-compare.mjs compare`. Expected: all pages match.
- [ ] **Step 3: Docs and version.**
  - README: the Connected servers bullet gains Plex, and "Connecting a server" gains the link-code paragraph.
  - ARCHITECTURE: migration 12, `plextv.js`, `plex.js`, the reporter, added dates, `images.forget`, and the Remove clean-up.
  - `package.json` to `0.12.0`.
- [ ] **Step 4: Full verification.**
  - `npm test` (expect ≥ 300)
  - `servers-ui` ×2
  - `extras-lyrics-ui`, `lists-ui`, `orbit-ui`, `orbit-sizes`, `orbit-a11y`, `gate-ui`, `extras-ui`, `rebrand-ui`, `music-kbd`, `profiles-ui`, `dialogs`
  - older themes
- [ ] **Step 5: Delivery.**
  - Hash-check against the v0.11.0 snapshot and deliver to `D:\Nodeflix`.
  - Run `npm test` on the PC.
  - Update the project note (Round 14 / v0.12.0). Its "Not yet verified" covers a real plex.tv link, a real Plex server on the LAN and remotely, the relay, a shared server, and the timeline showing in Plex's dashboard.
- [ ] **Step 6: Review and wrap-up.**
  - Ledger `Task 8: complete`.
  - Dispatch a fresh sonnet review, giving it the Review Focus verbatim and the ledger's rulings.
  - Make one fix pass, with each fix RED→GREEN, then re-deliver.
  - Write the final message with every ruling and the deferred minors.
  - Copy the ledger to `scratchpad/note/`, then delete the workspace.
