# Atomix Jellyfin API for Infuse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infuse (iPhone, Apple TV) can add Atomix at `https://<host>/jellyfin` as a Jellyfin server, sign in with
username + app password, browse films and TV, direct-play, resume, mark watched, favourite and download (grown-ups,
local files), with Atomix's viewer rules and per-account stream cap intact.

**Architecture:** A new `src/jellyfin/` package that mirrors `src/subsonic/`. It has its own handler mounted in
`src/app.js` before `/api/`, a small case-insensitive route table, and a token store (migration 34) on top of the
existing `app_passwords`. Every read goes through `core.profiles.viewer()` and `core.library` (`visibility`/`canSee`).
Streams reuse `sendFile` / `proxyRemoteFile` and are counted against the account's cap through
`playback.externalLists`, as `LiveDrm` does. Progress goes through `recordProgress`.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, `node:test`), plain ESM, no dependencies. The web Settings screen is the
existing non-Preact `settings-music.js`.

**Spec:** `docs/superpowers/specs/2026-11-18-atomix-jellyfin-api-design.md` (read it first; this plan argues from it).

## Global Constraints

- Node ≥ 22.13; **no `npm install`, no new dependencies, no build step.**
- Test first: write the failing test, watch it fail, then make it pass (RED → GREEN). Run `node --test <file>` per
  task. Run the full suite in groups at the end (15 known failures: TLS/Tailscale, vendor checksums,
  `deviceKeySystems` and similar; `test/api.test.js` is sometimes flaky).
- **Never use port 8787.** Dev checks use `BASE=http://localhost:8797`.
- App passwords, Jellyfin tokens, file paths, connected-server URLs and tokens **never** appear in a response body, an
  error message or a log line. Tokens arrive in headers **and** `api_key`/`ApiKey` query strings; both are redacted.
- Every item read goes through the viewer. A hidden title is `404` everywhere: list, item, image, stream, download,
  PlaybackInfo, played/favourite writes.
- Per-account cap: `MAX_SESSIONS_PER_USER = 4` (`src/stream/playback.js:139`), one slot per Infuse token.
- Ticks: `1 s = 10_000_000` ticks.
- Messages shown in Atomix's own Settings are plain-English sentences. Jellyfin JSON error bodies stay minimal.
- Git: work on branch `jellyfin-api` off `main`. Commit only once Dallas has said commits are fine for this
  execution; commits are authored as reconstx5 (repo config) with **no co-author line**.

## Review Focus

1. **The same Infuse device reading several titles quickly** (pre-reading tracks, next episode, jumping): it must stay
   one slot and never get `429` while the account has room. Test in Task 6 (`switching titles keeps one slot`).
2. **A token in the address** (`?api_key=` on image and stream URLs, which Infuse uses): it must sign in, and it must
   not appear in any log line, including the app's `[media]` warnings and error lines. Test in Task 3
   (`api_key in the query signs in and is never logged`).
3. **Paths in other capitalisations and `/emby` prefixes** (`/jellyfin/users/…`, `/jellyfin/emby/Users/…`): they
   must route the same. Test in Task 3 (`routes match without regard to capitals and with /emby`).
4. **A connected server's title** in item JSON, PlaybackInfo and the stream: it plays through Atomix, and no field
   carries the far URL, the token or a real path. Test in Task 6 (`connected-server title passes through and leaks
   nothing`), with `test/helpers-jellyfin.js`'s `fakeJellyfin` as the far server.
5. **A Kids profile guessing ids**: grown-up ids in `Items/{id}`, `Images`, `stream`, `Download`, `PlayedItems`,
   `FavoriteItems` and `PlaybackInfo` are all `404` (Download is `403` before visibility only when the title *is*
   visible). Test in Task 4 (`a Kids token can't reach a grown-up title by id`), extended in Tasks 5–8.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/db.js` | migration 34: `jellyfin_tokens` |
| `src/settings.js` | `jellyfinServerId: ''` default (made once at start) |
| `src/jellyfin/ids.js` | GUID ↔ `{ kind, id }` |
| `src/jellyfin/tokens.js` | `JellyfinTokens`: issue/check/logout, reading the token from a request |
| `src/jellyfin/index.js` | `Jellyfin` class: routing, sign-in per request, errors, trace and redaction |
| `src/jellyfin/routes.js` | `createJellyfin(core)`: registers every route below |
| `src/jellyfin/system.js` | System/Info, Users/Public, AuthenticateByName, Logout, Users/Me, harmless stubs |
| `src/jellyfin/shapes.js` | `BaseItemDto`, `UserDto`, `UserData`, `MediaSources`/`MediaStreams` |
| `src/jellyfin/browse.js` | Views, Items, Item, Seasons, Episodes, Resume, NextUp, Latest |
| `src/jellyfin/media.js` | Images, PlaybackInfo, stream, Download, Subtitles |
| `src/jellyfin/sessions.js` | `JellyfinSessions`: one slot per token, cap, reaping, admin list |
| `src/jellyfin/userdata.js` | Sessions/Playing*, PlayedItems, FavoriteItems |
| `src/app.js` | mount `/jellyfin`, build `core.jellyfin`, server id |
| `src/api/admin.js:84` | add Jellyfin sessions to the playing list |
| `src/api/account.js:329-342` | app-password reply gains `jellyfin` address |
| `public/js/views/settings-music.js` | "Music apps" → "Apps", Infuse text, `/jellyfin` address + copy |
| `test/helpers-jellyfin-api.js` | `jf(base)` client for these tests (the existing `helpers-jellyfin.js` is a *fake far server*: leave it) |
| `test/jellyfin-*.test.js` | per task below |
| `test/fixtures/infuse-session.json` | the Infuse call list (Task 9) |
| `devtools/jellyfin-smoke.mjs` | fetch-only smoke check against `BASE` |
| `docs/ARCHITECTURE.md`, `CLAUDE.md` | "Jellyfin apps" section; current state |

---

### Task 1: Token store, ids and migration 34

**Files:**
- Modify: `src/db.js` (append migration 34 after 33 at ~line 778), `src/settings.js` (`SETTING_DEFAULTS`)
- Create: `src/jellyfin/ids.js`, `src/jellyfin/tokens.js`
- Test: `test/jellyfin-tokens.test.js`

**Interfaces:**
- Produces:
  - `toGuid(kind: 'item'|'library'|'user'|'person'|'server', id: number|string) → string` (32 lowercase hex, no
    dashes). Layout: `'a70a1f00'` + 8-hex kind code (`item 1, library 2, user 3, person 4, server 5`) + 16-hex
    zero-padded id. `person` ids are the first 16 hex of `sha1(name)`, so `fromGuid` returns
    `{ kind: 'person', id: '<16 hex>' }`.
  - `fromGuid(s: string) → { kind, id } | null`: accepts dashes and any case, and returns `null` for anything else.
    Integer kinds give `id` as a Number.
  - `class JellyfinTokens { constructor({ db, now = Date.now })`, `issue({ appPasswordId, deviceId, deviceName,
    client, version }) → string` (64 hex, stored as sha256), `check(token) → { user, profile, appPassword, tokenRow } |
    null` (null for unknown, logged out, or revoked app password), `logout(token) → void`, `touch(id)` }.
  - `readToken(req, url) → string|null`: from `X-Emby-Token`, `X-MediaBrowser-Token`, `Authorization` or
    `X-Emby-Authorization` (`MediaBrowser … Token="…"`), else `api_key` / `ApiKey` query.
  - `readClient(req) → { client, device, deviceId, version }` from the same `MediaBrowser` header.
  - Migration 34 SQL: `CREATE TABLE jellyfin_tokens (id INTEGER PRIMARY KEY, app_password_id INTEGER NOT NULL
    REFERENCES app_passwords(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, device_id TEXT, device_name TEXT,
    client TEXT, version TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)` + index on `app_password_id`.
  - `SETTING_DEFAULTS.jellyfinServerId = ''`.

- [ ] **Step 1: Write the failing tests** (`openDatabase` on a temp file, an account + profile + app password via
  `AppPasswords`):
  - `guids round trip`: `fromGuid(toGuid('item', 42))` deep-equals `{ kind: 'item', id: 42 }`; the dashed upper-case
    form parses the same; `fromGuid('nope')`, `fromGuid('0'.repeat(32))` and `fromGuid(toGuid('item', 42).slice(1))`
    are `null`; `toGuid('item', 42)` matches `/^[0-9a-f]{32}$/`.
  - `a token is issued, checked and stored hashed`: `issue()` gives 64 hex; `check()` returns the profile;
    `SELECT token_hash` ≠ the token.
  - `revoking the app password ends its tokens`: after `appPasswords.revoke()`, `check()` is `null`.
  - `logout ends one token only`: two tokens from one password; logout one, and the other still checks.
  - `readToken reads every form`: each of the five header/query forms returns `'abc'`.
  - `migration 34 runs on an existing database`: `openDatabase(file, { upTo: 33 })`, then a full open, has the table.
- [ ] **Step 2:** `node --test test/jellyfin-tokens.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement as in Interfaces. `check` hashes the token and does one indexed lookup (a 256-bit secret
  needs no constant-time scan), joins `app_passwords` with `revoked = 0`, and loads profile and user.
- [ ] **Step 4:** Run the tests again. Expected: PASS. Also run `node --test test/subsonic-auth.test.js` (app passwords
  untouched).
- [ ] **Step 5: Commit** `Jellyfin API: token store, ids, migration 34`.

### Task 2: Item shapes

**Files:**
- Create: `src/jellyfin/shapes.js`
- Test: `test/jellyfin-shapes.test.js` (pure: made-up rows, no server)

**Interfaces:**
- Consumes: `toGuid`.
- Produces:
  - `TICKS = 10_000_000`
  - `itemDto(row, { serverId, progress?, stats?, rating?, counts?, fields?: Set<string>, base = '/jellyfin' }) → object`
    for kinds `movie|show|season|episode` → `Type` `Movie|Series|Season|Episode`. Always: `Name`, `Id`, `ServerId`,
    `Type`, `IsFolder`, `ImageTags`, `BackdropImageTags`, `UserData`, `RunTimeTicks`, `ProductionYear`,
    `IndexNumber`/`ParentIndexNumber`, `SeriesId`/`SeasonId`/`ParentId`, `SeriesName`, `LocationType: 'FileSystem'`,
    `MediaType: 'Video'` for playable kinds. With `fields` (or always, if Infuse needs it: Task 9 decides):
    `Overview`, `Genres`, `OfficialRating` (`certification`), `CommunityRating` (`rating`), `PremiereDate`
    (`air_date` or `year-01-01`), `OriginalTitle`, `SortName`, `Studios` (`[{ Name, Id }]` from `studio`), `People`
    (from `people` JSON: `{ Name, Id: toGuid('person', name), Role: character||'', Type: cast→'Actor',
    director→'Director', creator→'Creator' }`), `ProviderIds` (`Tmdb`, `Imdb`), `DateCreated` (`added_at` ISO),
    `MediaSources` (playable kinds), `ChildCount`.
  - `userData(progress, rating, row, counts) → { PlaybackPositionTicks, PlayCount, Played, IsFavorite,
    LastPlayedDate?, UnplayedItemCount?, PlayedPercentage?, Key }`.
  - `mediaSources(row, { subtitles = [], canDownload, base }) → [MediaSource]`: one source, `Id = toGuid('item', id)`,
    `Protocol: 'File'`, `Container` from the file extension, `Size`, `Bitrate`, `RunTimeTicks`, `SupportsDirectPlay:
    true`, `SupportsDirectStream: true`, `SupportsTranscoding: false`, `MediaStreams` from `items.media`
    (`video`, `audio[]`, `subtitles[]`; `Index`, `Codec`, `Language`, `Title`, `IsDefault`, `Width`/`Height`,
    `Channels`, `VideoRange` from `hdrFormat`), and each external subtitle as
    `{ Type: 'Subtitle', IsExternal: true, DeliveryMethod: 'External', DeliveryUrl:
    '/jellyfin/Videos/{guid}/{guid}/Subtitles/{index}/0/Stream.{srt|vtt}', Codec, Language }`. **No `Path` field**,
    or `Path` = `'/' + basename` only.
  - `userDto(user, profile, { serverId }) → { Name: profile.name, Id: toGuid('user', profile.id), ServerId,
    HasPassword: true, HasConfiguredPassword: true, Policy: { IsAdministrator: false, IsDisabled: false,
    EnableContentDownloading: !profile.kids, EnableMediaPlayback: true, EnableContentDeletion: false, … },
    Configuration: { PlayDefaultAudioTrack: true, SubtitleMode: 'Default', … } }`.
  - `libraryDto(lib, serverId) → { Name, Id: toGuid('library', id), Type: 'CollectionFolder', CollectionType:
    lib.type === 'movies' ? 'movies' : 'tvshows', IsFolder: true, ImageTags: {} }`.

- [ ] **Step 1: Write the failing tests:**
  - `a film becomes a Movie`: `Type 'Movie'`, `RunTimeTicks === duration*TICKS` (rounded),
    `ProviderIds.Tmdb === '603'`, `OfficialRating === 'R16'`.
  - `an episode carries its series and season`: `SeriesId === toGuid('item', show.id)`, `IndexNumber 2`,
    `ParentIndexNumber 1`.
  - `user data from progress`: `{ position: 120, watched: 0 }` gives `PlaybackPositionTicks 1_200_000_000`,
    `Played false`; a heart gives `IsFavorite true`.
  - `no real path anywhere`: `JSON.stringify(itemDto(row with path 'D:\\Films\\x.mkv'))` contains neither `D:` nor
    `Films`. A remote row with path `jellyfin://3/abc` contains neither `jellyfin://` nor any `http`.
  - `external subtitles are delivery URLs under /jellyfin`.
  - `Kids user cannot download`: `userDto(...kids profile).Policy.EnableContentDownloading === false`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Image tags: `ImageTags.Primary` = `String(metadata_at||updated_at||0)` when `poster`;
  `Logo` when `logo`; `Thumb` when `backdrop` (used for wide cards); `BackdropImageTags` = `[tag]` when `backdrop`.
  Episodes with only a still use `poster` as Primary (Atomix keeps the still there).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `Jellyfin API: item shapes`.

### Task 3: The handler, sign-in and system routes

**Files:**
- Create: `src/jellyfin/index.js`, `src/jellyfin/routes.js`, `src/jellyfin/system.js`, `test/helpers-jellyfin-api.js`
- Modify: `src/app.js` (import; `core.jellyfin = createJellyfin(core)` next to `core.subsonic`; dispatch
  `if (/^\/jellyfin(\/|$)/i.test(url.pathname)) await core.jellyfin.handle(req, res, url)` before `/rest/`; on start
  `if (!settings.get('jellyfinServerId')) settings.set({ jellyfinServerId: crypto.randomBytes(16).toString('hex') })`)
- Test: `test/jellyfin-auth.test.js`

**Interfaces:**
- Consumes: `JellyfinTokens`, `readToken`, `readClient`, `AppPasswords` (`core.appPasswords`), `auth.checkRateLimit /
  recordFailure / clientIp`, `core.profiles.viewer`, `userDto`.
- Produces:
  - `class Jellyfin { constructor(core)`; `route(method: string|string[], pattern: string, fn(ctx), { auth = true,
    adult = false } = {})`; `handle(req, res, url)`; `sessions` (Task 6); `tokens: JellyfinTokens }`.
    The pattern is matched against the path after `/jellyfin` with an optional leading `/emby`, case-insensitive,
    with `{name}` segments (e.g. `'/Users/{userId}/Items/{itemId}'`).
  - `ctx = { core, req, res, url, query /* lower-cased keys */, params, body() /* JSON, 1 MB, 15 s */, user, profile,
    viewer, token, tokenRow, client, serverId, redirect(u) }`. `fn` returns an object (sent as JSON 200), `null` (204),
    or handles `ctx.res` itself.
  - Errors: `HttpError` status → that status with `{}` body. Others → 500, logged by method + pattern only.
  - `helpers-jellyfin-api.js`: `jf(base, { token } = {}) → { get(path, query?), post(path, body?, query?),
    del(path), raw(path, init) }`. It sends `Authorization: MediaBrowser Client="Infuse-Direct", Device="iPhone",
    DeviceId="test-dev-1", Version="8.0", Token="<token>"`. `signIn(base, username, password, { deviceId }) → {
    status, token, user, body }`.
  - Routes (system.js): `GET /System/Info/Public` (open: `{ ServerName, Version: '10.10.7', ProductName: 'Jellyfin
    Server', Id: serverId, StartupWizardCompleted: true, LocalAddress }`), `GET /System/Info` (signed in, same +
    `OperatingSystem`), `GET /Users/Public` (open: `[]`), `POST /Users/AuthenticateByName` (open), `POST
    /Sessions/Logout`, `GET /Users/Me`, `GET /Users/{userId}` (must be the token's own profile, else 404),
    `GET /System/Ping` and `POST /System/Ping` (open: `"Jellyfin Server"`).
  - Trace: `ATOMIX_JELLYFIN_TRACE=1` (read in `config.js` as `cfg.jellyfinTrace`) logs `[jellyfin] METHOD
    /path?query → status ms` at info, with `api_key`/`apikey` values replaced by `***`. Without it, nothing is logged
    per request except 5xx.

- [ ] **Step 1: Write the failing tests** (`startAtomix`, `dallas`/`password123`, a Kids profile `Mia`, one app
  password each, made through `/api/me/app-passwords` as `subsonic-auth.test.js` does):
  - `the public info answers without a sign-in`: `GET /jellyfin/System/Info/Public` → 200, `Id` is 32 hex and the same
    after `app.stop()` + restart on the same data dir; `ProductName === 'Jellyfin Server'`.
  - `Users/Public names nobody`: `[]`.
  - `the right app password signs in to the right profile`: `signIn('dallas', kidSecret)` → 200, `User.Name === 'Mia'`,
    `User.Policy.EnableContentDownloading === false`, `AccessToken` 64 hex, `ServerId` = the public Id.
  - `a wrong password is 401 and counts toward the lockout`: 10 wrong `AuthenticateByName` → the 11th with the right
    password is 429 (or the web's lockout status, whatever `checkRateLimit` throws), and the web's
    `/api/auth/login` from the same address is refused too.
  - `a bad token is 401 and does not count`: 20 calls with `Token="0000"` → each 401, then the right password still
    signs in.
  - `the account password does not sign in`: `signIn('dallas', 'password123')` → 401.
  - `api_key in the query signs in and is never logged`: capture `console.log/warn/error` during `GET
    /jellyfin/Users/Me?api_key=<token>` with `ATOMIX_JELLYFIN_TRACE=1` and during a 404 on
    `/jellyfin/Videos/<bad>/stream?api_key=<token>`; the token appears in no captured line.
  - `routes match without regard to capitals and with /emby`: `/jellyfin/users/me`, `/jellyfin/emby/Users/Me` and
    `/JELLYFIN/Users/Me` all → 200 with the same `Id`.
  - `logout ends the token`: `POST /Sessions/Logout` → 204, then `/Users/Me` → 401.
  - `revoking the app password signs Infuse out`: `DELETE /api/me/app-passwords/:id` → `/Users/Me` → 401.
  - `another profile's user id is 404`: `GET /Users/<Mia's guid>` with Dallas's token → 404.
  - `the web is untouched`: `GET /api/me` without a cookie stays 401, and `/rest/ping.view` still answers.
- [ ] **Step 2:** `node --test test/jellyfin-auth.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. `AuthenticateByName`: `checkRateLimit(req)` first; reuse `AppPasswords.check({
  username: Username, password: Pw })` (plain-password branch); on error `recordFailure(req)` → 401. On success:
  activity note on first use (as `Subsonic.signIn`), `appPasswords.touch`, `tokens.issue(...)` with `readClient`.
  Reply `{ User: userDto, SessionInfo: { Id, UserId, DeviceId, DeviceName, Client }, AccessToken, ServerId }`.
  Token failures never call `recordFailure`.
- [ ] **Step 4:** Run. Expected: PASS. Also `node --test test/subsonic-auth.test.js test/api.test.js`.
- [ ] **Step 5: Commit** `Jellyfin API: sign-in with app passwords under /jellyfin`.

### Task 4: Browsing

**Files:**
- Create: `src/jellyfin/browse.js`
- Test: `test/jellyfin-browse.test.js` (film library: three films, one with `certification` `R16`; TV library: one show,
  two seasons, three episodes; set `certification`/`min_age` directly in the db after the scan, as other Kids tests
  do; a second account-less profile `Guest` without access to the TV library via `PATCH /api/profiles/:id`)

**Interfaces:**
- Consumes: `itemDto`, `libraryDto`, `userData`, `library.visibleLibraries(viewer)`, `library.list({ viewer,
  libraryId, kind, parentId, showId, sort, search, limit, offset, topLevel })`, `library.get`, `library.canSee`,
  `library.withProgress`, `library.progressFor`, `library.continueWatching(viewer, limit)`,
  `library.nextUp(viewer, limit)`, `library.nextUpFor(viewer, showId)`,
  `library.recentlyAdded({ viewer, kind, libraryId, limit })`, `core.ratings` (heart).
- Produces routes (all signed in; the `{userId}` forms check that it's the token's own profile):
  - `GET /Users/{userId}/Views`, `GET /UserViews` → `{ Items: [libraryDto] (film/TV only), TotalRecordCount }`.
  - `GET /Users/{userId}/Items`, `GET /Items` → `{ Items, TotalRecordCount, StartIndex }`. Supported query:
    `ParentId` (a library → its top level; a show → seasons; a season → episodes), `Recursive`, `IncludeItemTypes`,
    `Fields`, `SortBy` (`SortName`, `DateCreated`, `PremiereDate`, `ProductionYear`, `CommunityRating`,
    `DatePlayed`, `Random`), `SortOrder`, `StartIndex`, `Limit`, `Filters` (`IsPlayed`, `IsUnplayed`,
    `IsFavorite`, `IsResumable`), `IsFavorite`, `SearchTerm`, `Ids`, `MinDateLastSaved`,
    `MinDateLastSavedForUser`. Anything else is ignored.
  - `GET /Users/{userId}/Items/{itemId}`, `GET /Items/{itemId}` → `itemDto` with all fields (`ChildCount`,
    `UnplayedItemCount` for shows and seasons).
  - `GET /Shows/{seriesId}/Seasons`, `GET /Shows/{seriesId}/Episodes` (`SeasonId`, `Season`) → paged shape.
  - `GET /Users/{userId}/Items/Resume`, `GET /UserItems/Resume` → `continueWatching` (films and episodes only).
  - `GET /Shows/NextUp` (`SeriesId` → `nextUpFor`) → `nextUp`.
  - `GET /Users/{userId}/Items/Latest`, `GET /Items/Latest` (`ParentId`, `IncludeItemTypes`, `Limit`) → a plain
    **array** (Jellyfin's Latest is not paged) from `recentlyAdded`; for TV, episodes are grouped to their show, as
    Jellyfin does with `GroupItems=true` (default).
  - A library `ParentId` the viewer can't see, or an unknown id, → 404.
  - `ensureVisible(ctx, guid) → row` (exported for Tasks 5–8): parses with `fromGuid`, `kind 'item'`, `canSee`, else
    `HttpError(404)`.

- [ ] **Step 1: Write the failing tests:**
  - `views list film and TV libraries only`: with a music library added too, Views has exactly the two, with
    `CollectionType` `movies` / `tvshows`.
  - `a library lists its films, paged`: `ParentId=<films>&StartIndex=1&Limit=1&SortBy=SortName` → 1 item,
    `TotalRecordCount 3`, the second film by name.
  - `recursive episodes of a library`: `ParentId=<tv>&Recursive=true&IncludeItemTypes=Episode` → 3.
  - `seasons and episodes`: `/Shows/<show>/Seasons` → 2; `/Shows/<show>/Episodes?SeasonId=<s1>` → 2, in order.
  - `filters`: after saving progress 30 s on film A via `/api/items/:id/progress`, `Filters=IsResumable` → [A]; after
    marking B watched on the web, `IsPlayed` → [B] and `IsUnplayed` → the other two.
  - `Resume, NextUp and Latest match the web`: the ids from `/Users/{me}/Items/Resume` equal the web's continue
    watching ids, in order; NextUp gives episode 2 after episode 1 is watched; Latest is an array.
  - `a Kids token can't reach a grown-up title by id`: Mia's token → `Items/<R16 film>` 404, absent from every list,
    search and Latest.
  - `a profile without the TV library can't list it`: Guest → `ParentId=<tv>` 404, Views has only films.
  - `unknown query parameters are ignored`: `EnableImageTypes=Primary&EnableTotalRecordCount=true&Foo=1` → 200.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement in `browse.js` as `registerBrowse(j: Jellyfin)`. Use `library.list()` and its
  `limit`/`offset` for paging. A separate `COUNT` comes through the same `visibility()` SQL. `IsFavorite` filters join
  `user_ratings.favourite`. Per-row user data comes from one `progressFor` call and one ratings query per page (no
  per-row queries, as in `subsonic/browse.js`).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `Jellyfin API: browsing films and TV`.

### Task 5: Images

**Files:**
- Create: `src/jellyfin/media.js` (`registerMedia(j)`; Tasks 6 and 8 add to it)
- Test: `test/jellyfin-media.test.js` (shared with Tasks 6–8; films/episodes from Task 4's setup, `makeImage` posters)

**Interfaces:**
- Consumes: `ensureVisible`, `sendArtwork(core, ctx, row, type, { redirect: false })`.
- Produces: `GET|HEAD /Items/{itemId}/Images/{type}` and `/Items/{itemId}/Images/{type}/{index}`. The type map is
  `Primary→poster`, `Backdrop→backdrop`, `Thumb→backdrop`, `Logo→logo`; anything else → 404. `maxWidth`,
  `fillWidth` or `width` (the largest given) becomes `ctx.query.w`; `tag` becomes `ctx.query.v`, so a tagged picture is
  cached for a year, as the web's versioned ones are.

- [ ] **Step 1: Write the failing tests:** `a poster is sent, resized`: `Images/Primary?maxWidth=200` → 200,
  `image/*`. `a missing logo is 404`. `a Kids token gets 404 for a grown-up poster`. `api_key works for images` (no
  header, `?api_key=`).
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `Jellyfin API: artwork`.

### Task 6: Playing — PlaybackInfo, the stream, one slot per device

**Files:**
- Create: `src/jellyfin/sessions.js`, `src/jellyfin/userdata.js` (`registerUserData(j)`: the `Sessions/Playing*` part
  here; Task 7 adds the rest)
- Modify: `src/jellyfin/media.js`, `src/api/admin.js:84` (append `...(core.jellyfin?.sessions.list() || [])`)
- Test: `test/jellyfin-media.test.js`, `test/jellyfin-cap.test.js`

**Interfaces:**
- Consumes: `ensureVisible`, `mediaSources`, `sendFile(req, res, file, { cacheControl: 'private, no-cache',
  contentType })` (`src/http/static.js`), `proxyRemoteFile(core, ctx, row)` (`src/stream/remotefile.js`),
  `isRemotePath`, `recordProgress(core, { user, viewer, item, position, duration, client: 'jellyfin', paused })`,
  `MAX_SESSIONS_PER_USER`, `playback.sessionsOf(userId)`.
- Produces:
  - `class JellyfinSessions { constructor({ playback, now = Date.now, idleMs = 120_000 })`;
    `open({ tokenRow, user, profile, item, clientIp, client }) → session` (one per `tokenRow.id`: same token → the
    existing session is moved to `item` and touched; new token → counted. If `playback.sessionsOf(user.id).length >=
    MAX_SESSIONS_PER_USER`, throw `HttpError(429, 'Too many streams open on this account.')`); `touch(tokenId,
    { position?, paused? })`; `stop(tokenId)`; `reap()` (every 15 s, unref'd; idle > `idleMs` is stopped);
    `list() → publicSession-like rows { id, user, itemId, title, mode: 'direct', delivery: 'jellyfin', position,
    paused, startedAt, clientIp, castDevice: null, transcoding: false, client }`; `close()` }.
    It registers `(playback.externalLists ||= []).push((userId) => [...].filter((s) => s.userId === userId))`, as
    `LiveDrm` does.
  - Routes: `GET|POST /Items/{itemId}/PlaybackInfo` → `{ MediaSources: mediaSources(row, …), PlaySessionId:
    <random 32 hex> }` (no slot taken). `GET|HEAD /Videos/{itemId}/stream` and `/Videos/{itemId}/stream.{ext}`
    (films and episodes with a path) → `sessions.open(...)`, then `sendFile` (local; missing → 404 "The file is missing
    on the server.") or `proxyRemoteFile` (connected server). `POST /Sessions/Playing`, `POST
    /Sessions/Playing/Progress`, `POST /Sessions/Playing/Stopped` (body `{ ItemId, PositionTicks, IsPaused,
    PlaySessionId }`), and `POST /Users/{userId}/PlayingItems/{itemId}`, `…/Progress`, `DELETE
    /Users/{userId}/PlayingItems/{itemId}` (query `PositionTicks`). These save progress through `recordProgress`
    (item checked with `ensureVisible`; `duration` = row duration) and `touch`/`stop` the token's session. `Stopped`
    also stops it. `POST /Sessions/Playing/Ping` touches. `POST /Sessions/Logout` (Task 3) also calls
    `sessions.stop`.

- [ ] **Step 1: Write the failing tests:**
  - `PlaybackInfo offers direct play only`: `SupportsDirectPlay true`, `SupportsTranscoding false`, one source,
    a `PlaySessionId`, no `Path` with a real folder.
  - `the stream sends the original with ranges`: `Range: bytes=0-99` → 206, 100 bytes equal to the file's first 100;
    `HEAD` → 200 with `Content-Length` = file size.
  - `a missing file is 404`: delete the file, stream → 404.
  - (`jellyfin-cap.test.js`) `several range reads are one slot`: 5 parallel ranged GETs with one token → all 206; the
    admin `/api/admin/dashboard` (the route at admin.js:84) lists **one** jellyfin session.
  - `switching titles keeps one slot`: one token reads film A, then episode 1, then film B → all 206; still one session,
    and its `itemId` is film B.
  - `a fifth device is refused`: four tokens (four `signIn`s with distinct `DeviceId`) each stream → 206; a fifth
    token → 429; `Sessions/Playing/Stopped` on one, then the fifth → 206.
  - `web sessions and Infuse share the cap`: three web playback sessions (`POST /api/items/:id/playback`) + one
    Infuse stream → the next web `playback` → 429.
  - `an idle Infuse stream is freed`: `JellyfinSessions` with `idleMs: 50` and a fake `now`; `reap()` frees it
    (unit test, no server).
  - `progress lands in Atomix`: `Sessions/Playing/Progress { ItemId, PositionTicks: 600_000_000 }` → the web's
    `/api/items/:id` shows position 60. `Stopped` near the end → watched on the web.
  - `connected-server title passes through and leaks nothing`: connect a `fakeJellyfin({ movies: [...], streamFile })`
    far server as `test/remote*.test.js` do; the item JSON, PlaybackInfo and the streamed response headers contain
    neither the far server's port nor its token `tok1`; the stream bytes equal `streamFile`'s.
  - `a Kids token can't stream or report a grown-up title`: stream → 404, `Playing/Progress` → 404, and the R16
    film's progress is unchanged.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Implement. Open the session **before** sending bytes, so a refusal sends nothing. A `HEAD` doesn't
  open one. `core.jellyfin.sessions` is closed in the app's stop path, next to the playback manager.
- [ ] **Step 4:** Run. Expected: PASS. Also `node --test test/media-links.test.js test/cast-sessions.test.js`.
- [ ] **Step 5: Commit** `Jellyfin API: direct play, one stream per device, progress`.

### Task 7: Watched and favourites

**Files:**
- Modify: `src/jellyfin/userdata.js`
- Test: `test/jellyfin-userdata.test.js`

**Interfaces:**
- Consumes: `ensureVisible`, `library.setWatched(profileId, item, watched)` (the web's `POST /api/items/:id/watched`
  uses it; it already marks a show's or season's episodes), `core.ratings.set(
  profileId, row, { favourite })`, `userData`.
- Produces: `POST|DELETE /Users/{userId}/PlayedItems/{itemId}`, `POST|DELETE /UserPlayedItems/{itemId}`,
  `POST|DELETE /Users/{userId}/FavoriteItems/{itemId}`, `POST|DELETE /UserFavoriteItems/{itemId}`. Each answers the
  item's new `UserData`.

- [ ] **Step 1: Write the failing tests:** `marking a film played shows on the web` (`/api/items/:id` `watched`
  true; `DELETE` → false). `marking a series played marks every episode`. `a heart set in Infuse is the web's
  heart` (and the reverse shows in `UserData.IsFavorite`). `a Kids token can't mark a grown-up title` (404, nothing
  changed).
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `Jellyfin API: watched and favourites`.

### Task 8: Downloads and subtitles

**Files:**
- Modify: `src/jellyfin/media.js`, `src/jellyfin/shapes.js` (`CanDownload`)
- Test: `test/jellyfin-media.test.js`

**Interfaces:**
- Consumes: `ensureVisible`, `sendFile`, `isRemotePath`, `listSubtitles(item, config)` (`src/stream/subtitles.js`),
  the web's subtitle-file route logic in `src/api/library.js` (reuse its reader; extract a shared function there if it
  is inline, and keep the web route's tests green).
- Produces:
  - `GET|HEAD /Items/{itemId}/Download`, signed in with `{ adult: true }`: a Kids profile → 403 (after
    `ensureVisible`, so a hidden title is still 404); a connected server's title → 400; films and episodes only; local
    file with ranges, `Content-Disposition: attachment; filename*=UTF-8''<basename>`. **No** `sessions.open`.
  - `itemDto`: `CanDownload: !profile.kids && !isRemotePath(row.path)` for films and episodes.
  - `GET /Videos/{itemId}/{sourceId}/Subtitles/{index}/{start}/Stream.{srt|vtt}` and
    `/Videos/{itemId}/{sourceId}/Subtitles/{index}/Stream.{srt|vtt}`: the subtitle at that index from
    `listSubtitles`, sent as the format the extension asks for (`text/vtt` or `application/x-subrip`). The index is
    the one `mediaSources` put in `DeliveryUrl`.

- [ ] **Step 1: Write the failing tests:** `a grown-up downloads a film` (200, full bytes, attachment header, and the
  admin dashboard shows **no** jellyfin session). `a Kids profile can't download` (403 for a visible title; 404 for a
  hidden one). `a connected server's title can't be downloaded` (400 with the web's sentence, and `CanDownload
  false` in its item JSON). `a sidecar .srt is offered and sent` (a `Film.en.srt` next to a film appears in
  `MediaStreams` as `IsExternal`; its `DeliveryUrl` → 200 with the cue text; `.vtt` → starts with `WEBVTT`).
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `Jellyfin API: downloads and subtitles`.

### Task 9: What Infuse calls — stubs, the recorded session, the smoke check

**Files:**
- Modify: `src/jellyfin/system.js`
- Create: `test/fixtures/infuse-session.json`, `test/jellyfin-infuse.test.js`, `devtools/jellyfin-smoke.mjs`

**Interfaces:**
- Produces:
  - Harmless answers of the right shape, signed in: `GET /DisplayPreferences/{id}` → `{ Id, SortBy: 'SortName',
    SortOrder: 'Ascending', CustomPrefs: {} }`, `POST /DisplayPreferences/{id}` → 204,
    `GET /Users/{userId}/Configuration` → the `Configuration` object, `POST /Sessions/Capabilities` and
    `/Sessions/Capabilities/Full` → 204, `GET /Branding/Configuration` (open) → `{ LoginDisclaimer: '', CustomCss:
    '' }`, `GET /Localization/Cultures|Countries|ParentalRatings` → `[]`, `GET /Users/{userId}/Items/{itemId}/
    Intros` → `{ Items: [], TotalRecordCount: 0 }`, `GET /Items/{itemId}/Similar`, `GET /Items/{itemId}/
    SpecialFeatures` → empty, `GET /Genres` (`ParentId`) → the viewer's genres as `{ Name, Id }` items,
    `GET /QuickConnect/Enabled` (open) → `false`.
  - Any other path under `/jellyfin` → 404 with `{}`. With trace on, it's logged so Dallas's capture shows it.
  - `test/fixtures/infuse-session.json`: `{ "source": "jellyfin-docs" | "infuse-<version>-<date>", "calls": [{
    "method", "path", "query" }] }`, with ids written as `{film}`, `{show}`, `{season}`, `{episode}`, `{library:films}`,
    `{library:tv}`, `{user}`. First version: `source: "jellyfin-docs"`, the sequence add server → sign in → views →
    each library's items (`Recursive`, `Fields`, `StartIndex`, `Limit` 100) → Resume → NextUp → Latest → a show's
    seasons → episodes → one episode → PlaybackInfo → stream (range) → Playing → Progress → Stopped → PlayedItems →
    DisplayPreferences → Logout, as Jellyfin's API documentation describes those calls.
  - `devtools/jellyfin-smoke.mjs`: `BASE`, `USER`, `APP_PASSWORD` from the environment; refuses `:8787`; walks the
    same sequence with `fetch` and prints `PASS`/`FAIL <method> <path> <status>` per step, ending `ALL PASS` or
    `n FAILED`.

- [ ] **Step 1: Write the failing test** `every call in the recorded Infuse session answers` (replays the fixture
  against Task 4's library, filling the placeholders; every call is 2xx/206 and parses as JSON where it's JSON).
  Plus `an unknown route is 404, not 500`.
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement the stubs and the fixture. **Step 4:** Run. PASS.
- [ ] **Step 5:** Start the dev server on 8797 (`.claude/launch.json` / `npm run dev` with the dev data dir), make an
  app password in Settings, and run
  `BASE=http://localhost:8797 USER=dallas APP_PASSWORD=<secret> node devtools/jellyfin-smoke.mjs`. Expected: `ALL PASS`.
- [ ] **Step 6: Commit** `Jellyfin API: what Infuse asks for, a recorded session and a smoke check`.

### Task 10: Settings "Apps", docs and the full suite

**Files:**
- Modify: `src/api/account.js:331-337` (reply adds `jellyfin: server + '/jellyfin'`),
  `public/js/views/settings-music.js` (section title "Apps"; text below; the made-password dialog shows the
  Jellyfin address with a copy button next to the Subsonic one), `docs/ARCHITECTURE.md` (new "Jellyfin apps
  (`src/jellyfin/`, v0.30)" after "Music apps": signing in, ids, routes, the one-slot rule, downloads, trace switch;
  migration 34 in the list), `CLAUDE.md` (a "Jellyfin API (v0.30 work)" section: files, rules that matter, checks,
  "waiting on a real Infuse"), `docs/HANDOFF-2026-11.md` "Next" item 3
- Test: `test/subsonic-auth.test.js` (extend the shown-once test: `made.data.jellyfin` ends with `/jellyfin`)

Copy (exact):
- Section title: `Apps`
- Lead: `Sign in to other apps with an app password. Music apps such as Symfonium, Amperfy or play:Sub use it as a
  Subsonic server. Infuse uses it as a Jellyfin server. Each app gets its own password, and revoking one signs that
  app out.`
- After a password is made: `In Infuse, add a Jellyfin server with the address {jellyfin}, your username {username}
  and this password. Music apps use the address {server}.`

- [ ] **Step 1:** Extend the test (`jellyfin` field). Run it. FAIL. **Step 2:** Implement the route field and the
  screen. **Step 3:** Run `node --test test/subsonic-auth.test.js test/theme-tokens.test.js`. PASS.
- [ ] **Step 4:** Check the screen in the dev server (8797) with the built-in browser: Settings → Profile → Apps,
  make a password, and the dialog shows both addresses. Take one screenshot for Dallas (an unchanged look apart from the
  text, so no before/after gallery).
- [ ] **Step 5:** Full suite in groups (e.g. `node --test test/[a-c]*.test.js`, `[d-l]*`, `[m-r]*`, `[s-z]*`,
  live-tuner tests alone). Expected: only the 15 known failures (and possibly `api.test.js`). Re-run any other failure
  alone before calling it real.
- [ ] **Step 6: Commit** `Jellyfin API: Settings → Apps, docs`.

### Task 11: Real devices (Dallas)

Not code. Hand Dallas the checklist from the spec's "Real devices" list, plus: run the dev or live server with
`ATOMIX_JELLYFIN_TRACE=1` during the first Infuse sign-in and browse, and keep the log. The calls in that log replace
the `jellyfin-docs` fixture (`source: "infuse-<version>-<date>"`), and any call that got a 404 becomes a follow-up.
Record the result in CLAUDE.md.

---

## Self-review notes

- Spec coverage: sign-in/tokens (1, 3), ids (1), shapes (2), browsing (4), images (5), PlaybackInfo/stream/cap and
  progress (6), watched/favourites (7), downloads/subtitles (8), stubs/trace/fixture/smoke (3, 9), Settings/docs
  (10), real devices (11). Non-goals have no tasks.
