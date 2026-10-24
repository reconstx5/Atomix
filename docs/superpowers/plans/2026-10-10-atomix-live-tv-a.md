# Atomix Live TV — plan A (core, plugin, routes, playback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomix can load an M3U playlist and XMLTV guide through an `iptv-simple` plugin, store channels and programmes, answer the Live TV routes, and play a channel, a catch-up programme or a radio station as a playback session.

**Architecture:** A `registerLiveSource()` plugin hook feeds `src/live/` (store, refresher, stream starter); `src/api/live.js` serves it; `src/stream/playback.js` learns `source.live` (endless input with reconnects). The plugin is pure parsing (`m3u.js`, `xmltv.js`, `catchup.js`, `match.js`) plus a thin `index.js`. Plan B builds the pages, the player's live mode, radio in the music player, casting and search on top of these routes.

**Tech Stack:** Node ≥ 22.13 (node:sqlite, node:test, node:zlib, global fetch), ffmpeg/ffprobe, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-live-tv-design.md` (§1, §2, §3, §4 routes, §5 node tests).

## Global Constraints

- Node ≥ 22.13, zero dependencies, ES modules, no build step.
- Original implementation: no code from Kodi's `pvr.iptvsimple` (GPL).
- Provider URLs, credentials in them and request headers never reach the browser; logos and programme images are served through `/api/live/…` routes.
- No route returns `servers.secret`/`extra`; admin-only stays admin-only; Kids see Live TV only through ticked groups.
- Outbound destinations gain only the playlist, guide, logo and stream hosts an admin configures.
- Copy is fixed by the spec, verbatim: "The playlist didn't answer (HTTP 403) — check the address and that your subscription is active", "The guide didn't answer (HTTP 404)", "The playlist took too long to answer", "The guide file isn't XMLTV", "The guide file isn't valid XMLTV (line N)", "This guide is compressed as .xz/.zip — Atomix can read plain or .gz XMLTV", "Your provider allows 1 stream at a time — stop the other one first", "This channel no longer exists.", "This channel isn't answering right now (the provider closed the connection)", "This channel stopped sending video.", summary "312 channels in 14 groups · guide to Sat 6 pm · 12 channels without guide".
- Live and catch-up sessions write no progress and count toward the per-account 4 and the conversion cap.
- Migration 15 is appended; old migrations never edited.

## Review Focus

1. **Credentials in logs** — an Xtream URL `http://host/live/user/pass/1.ts` must not appear in any log line (ffmpeg debug args, refresh errors, logo download warnings); logs show `http://host/…`. (Task 6 and Task 8 tests.)
2. **A refresh that "succeeds" with junk** — a provider login page (HTML, HTTP 200) or an empty playlist must not replace 300 good channels with 0; expect "The playlist isn't an M3U file" / "The playlist has no channels" and the old data kept. (Task 2 and Task 6 tests.)
3. **Two people starting a 1-stream provider at once** — both requests pass the limit check before either session exists; expect exactly one to start and the other to get the 409 sentence. (Task 8 test.)
4. **Favourites across a reordered or renamed playlist** — a refresh where the provider reorders channels and renames one must keep each favourite on the same channel (keyed by `tvg-id`/URL, not position or name). (Task 1 test.)
5. **Programme boundaries** — at exactly 19:30 the 19:00–19:30 programme is not "now" (end exclusive), a guide entry with no offset is UTC, and `guideShift` applies once. (Task 1 and Task 4 tests.)

---

### Task 1: Migration 15 and the live store

**Files:**
- Modify: `src/db.js` (append migration 15)
- Create: `src/live/store.js`
- Test: `test/live-store.test.js`

**Interfaces:**
- Produces `class LiveStore { constructor(db) }` with:
  - `replaceChannels(source: string, channels: Channel[]) → { added, updated, removed }` — upsert by `(source, key)` keeping `id`; delete rows of `source` whose key is absent; `sort` = array index.
  - `replaceProgrammes(source, programmes: Programme[], { from: ms, to: ms }) → { stored, unmatched: string[] /*channel names with no programmes*/ }` — maps `guideId` → channel ids of `source` (a guide id may feed several channels), deletes that source's programmes overlapping `[from, to)` and inserts those overlapping it, in one transaction.
  - `channels({ sources: string[], groups?: Set<string>|null /*Kids allow-list; null = all*/, group?: string, favouritesOf?: number /*profileId*/ }) → ChannelRow[]` ordered by favourite position (when `favouritesOf`) else `number, sort`.
  - `channel(id) → ChannelRow|null`, `groups({ sources, groups }) → string[]` (playlist order of first appearance).
  - `nowNext(channelIds: number[], at: ms) → Map<channelId, { now: Programme|null, next: Programme|null }>` — `now` = `start <= at < end`.
  - `guide(channelIds, from, to) → Map<channelId, Programme[]>` — programmes with `end > from AND start < to`, ordered by start.
  - `programme(id) → Programme & { channelId }|null`; `searchProgrammes(q, { channelIds, from, to, limit })`.
  - `favourites(profileId) → number[]`, `setFavourites(profileId, ids)`, `toggleFavourite(profileId, channelId, on)`.
  - `kidsGroups(profileId) → Array<{ source, grp }>`, `setKidsGroups(profileId, rows)`.
  - `recordRefresh(sourceId, { ok: boolean, channels?, programmes?, unmatched?, warning?, error? })`, `sourceStatus(sourceId)`.
  - `prune(before: ms, after: ms)` — deletes programmes ending before `before` or starting after `after`.
  - `ChannelRow = { id, source, key, number, name, groups: string[], logo, radio: boolean, guideId, catchup: object|null, hidden }`; `Programme = { id, channelId, start, end, title, subtitle, description, categories: string[], episode, image }`.

- [ ] **Step 1: Write the failing tests** in `test/live-store.test.js` using `openDb(':memory:')` (as `test/migrations.test.js` does):
  - `replaceChannels keeps ids and favourites across a reorder and a rename` — insert keys a,b,c; favourite b for profile 1; replace with c,b(renamed "B2"),a; assert b's id unchanged, `favourites(1)` still `[idB]`, b's name "B2", sort order c,b,a.
  - `replaceChannels removes channels gone from the playlist (their programmes and favourites cascade)`.
  - `replaceProgrammes replaces only the window and maps one guide id to two channels`.
  - `nowNext: end is exclusive` — programmes 19:00–19:30 and 19:30–20:00; at 19:30 `now` is the second, `next` null.
  - `guide returns programmes overlapping the window, ordered`.
  - `channels honours a Kids group allow-list (a channel in any allowed group shows) and favourites order`.
  - `prune drops programmes outside the window`.
  - `recordRefresh keeps last_ok when a later refresh fails`.
- [ ] **Step 2: Run** `node --test test/live-store.test.js` — Expected: FAIL (`Cannot find module '../src/live/store.js'`).
- [ ] **Step 3: Append migration 15** to `src/db.js` with the five tables exactly as the spec's §1 lists, plus `CREATE INDEX live_programmes_channel_start ON live_programmes(channel_id, start)`, `CREATE INDEX live_programmes_start ON live_programmes(start)`. Groups/categories/catchup are JSON text.
- [ ] **Step 4: Implement `LiveStore`** in `src/live/store.js`. Kids filter: a channel shows when any of its groups is in the allow-list (`groups` holds `"<source>\u0000<grp>"` keys). Hidden channels are excluded from `channels()` and `groups()`.
- [ ] **Step 5: Run** `node --test test/live-store.test.js test/migrations.test.js` — Expected: PASS. Then `npm test` — Expected: all pass.

### Task 2: The hook and the refresher

**Files:**
- Modify: `src/plugins.js` (`registerLiveSource`, `liveSources` map, owner cleanup, `listLiveSources()`, `getLiveSource(id)`)
- Create: `src/live/refresh.js`
- Modify: `src/app.js` (construct `core.live = { store, refresher }`, start/stop the refresher with the app)
- Test: `test/live-refresh.test.js`

**Interfaces:**
- Consumes: `LiveStore` (Task 1).
- Produces:
  - `api.registerLiveSource({ id, name, refresh(ctx), stream(key, ctx), catchup(key, programme, { from }, ctx), settingsSummary?(), refreshHours?: () => number, maxStreams?: () => number|Infinity })` — throws "A live source needs an id, refresh() and stream()" when those are missing. Registered as `"<pluginId>/<id>"` with `owner`.
  - `plugins.listLiveSources() → Array<{ key, name, pluginId, source }>`; `plugins.getLiveSource(key)`; `plugins.onLiveSourcesChanged(fn)` called when one registers or unloads.
  - `class LiveRefresher { constructor({ store, plugins, log, now = Date.now, tickMs = 60_000 }) ; start(); stop(); refresh(sourceKey, { reason }) → Promise<{ ok, error? }>; refreshAll(); due(sourceKey, now) → boolean }`.
  - `refresh()` ctx = `{ signal /*AbortSignal.timeout(120_000)*/, log }`. The refresher validates: `channels` is an array; **zero channels when the store already has some → treated as failure "The playlist has no channels"** (old data kept); each channel needs `key` and `name`. Window = `[now − max(maxCatchupDays, 1) days, now + 7 days]`; programmes outside it are dropped before `replaceProgrammes`; then `store.prune(windowStart, windowEnd)`; `recordRefresh` with counts and `unmatched` length. `due()`: never refreshed, or `refreshHours()` (default 6) elapsed since the last attempt, or the last programme ends < 24 h from now. A failed refresh retries after 15 min, not on every tick. One refresh per source at a time (an in-flight promise is returned to a second caller). A plugin config change (`hooks` event `plugin:config` for that plugin) and a new registration trigger an immediate refresh.
- [ ] **Step 1: Write the failing tests** in `test/live-refresh.test.js` with a fake `plugins` object and an in-memory store:
  - `a first refresh stores channels and programmes and records counts`.
  - `a refresh returning no channels keeps the old ones and records "The playlist has no channels"`.
  - `a thrown refresh keeps the old data, records the error, and retries after 15 minutes, not every tick`.
  - `programmes outside the window are dropped`.
  - `due(): 6 hours by default, sooner when the guide runs out within 24 h`.
  - `two refresh() calls share one run`.
  - `registerLiveSource rejects a source without stream()` (against a real `PluginManager.createApi` with a stub core, as `test/api.test.js` does for routes) and `unloading the plugin removes its live source`.
- [ ] **Step 2: Run** `node --test test/live-refresh.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the hook in `src/plugins.js` (mirroring `registerSource`, cleanup line in `unload`), `LiveRefresher` in `src/live/refresh.js` (a `setInterval(tick, tickMs).unref()`), and wire it in `src/app.js` after plugins load (`core.live.refresher.start()`; `stop()` on app stop).
- [ ] **Step 4: Run** `node --test test/live-refresh.test.js` — Expected: PASS; `npm test` — Expected: all pass.

### Task 3: M3U parsing

**Files:**
- Create: `plugins/iptv-simple/plugin.json`, `plugins/iptv-simple/m3u.js`
- Create: `test/fixtures/iptv/*.m3u` (small hand-written fixtures)
- Test: `test/iptv-m3u.test.js`

**Interfaces:**
- Produces `parseM3u(text: string, { startNumber = 1, numbering = 'playlist' } = {}) → { header: { guideUrls: string[], catchup?, catchupDays?, catchupSource?, shift? }, channels: M3uChannel[], warnings: string[] }`.
- `M3uChannel = { key, number, name, tvgId?, tvgName?, logo?, groups: string[], radio: boolean, shift?: number, url, headers: Record<string,string>, mime?: string, catchup?: { mode, days?, source?, correction? } }`.
- Throws `Error('The playlist isn't an M3U file')` when no `#EXTINF` lines and no URL lines exist, or the text starts with `<` (an HTML page).
- [ ] **Step 1: Write `plugin.json`**: `{ "id": "iptv-simple", "name": "IPTV Simple", "version": "1.0.0", "description": "Live TV from an M3U playlist and an XMLTV guide — a paid IPTV provider, free channel lists, or a tuner such as HDHomeRun or Tvheadend. Channel groups, catch-up and radio.", "author": "Atomix", "main": "index.js", "settings": [...] }` with the settings of spec §2: `playlist` (text), `guide` (text), `userAgent` (text, default ""), `refreshHours` (select 1/6/12/24, default 6), `numbering` (select playlist|order), `startNumber` (number, 1), `guideShift` (number, 0), `logosPath` (text), `maxStreams` (select `auto`|1|2|3|4|`unlimited`, default `auto` = 1 for a URL playlist, unlimited for a file), `catchupDays` (number, 7). Labels: "Playlist (URL or file on this server)", "Guide (URL or file; empty = the playlist's own)", "User agent", "Refresh every", "Channel numbers", "Start numbering at", "Guide time shift (hours)", "Logos folder or URL", "Streams at once", "Catch-up days when the playlist doesn't say".
- [ ] **Step 2: Write the failing tests** in `test/iptv-m3u.test.js`:
  - `header attributes: url-tvg and x-tvg-url lists, catchup, catchup-days, catchup-source, tvg-shift`.
  - `every #EXTINF attribute, double and single quotes` — `tvg-id`, `tvg-name`, `tvg-logo`, `tvg-chno`, `channel-number`, `group-title="News;Local"` → `['News','Local']`, `radio="true"`, `tvg-shift`, `catchup`, `catchup-days`, `catchup-source`, `catchup-correction`.
  - `#EXTGRP adds a group; #EXTVLCOPT sets User-Agent and Referer; url|User-Agent=A%20B&Referer=x sets headers and strips the suffix`.
  - `#KODIPROP mimetype is a hint; other KODIPROP lines are ignored`.
  - `numbering: tvg-chno wins, others continue after the highest; numbering=order ignores tvg-chno; startNumber`.
  - `duplicate URLs collapse with a warning; empty names take tvg-name else "Channel N"`.
  - `key is tvg-id when unique, else a 16-hex hash of the URL` — and two channels sharing a `tvg-id` both get URL-hash keys.
  - `BOM, CRLF, blank lines, missing #EXTM3U (warning)`.
  - `an HTML page throws "The playlist isn't an M3U file"`.
  - `20 000 channels parse in under 1 s` (generated in the test).
- [ ] **Step 3: Run** `node --test test/iptv-m3u.test.js` — Expected: FAIL (module missing).
- [ ] **Step 4: Implement `parseM3u`** in `plugins/iptv-simple/m3u.js`: line-based; attribute regex `([\w-]+)=("[^"]*"|'[^']*'|[^\s,]+)` on the part before the first comma that is outside quotes; pending `#EXTGRP`/`#EXTVLCOPT`/`#KODIPROP` state applies to the next URL line and resets.
- [ ] **Step 5: Run** — Expected: PASS.

### Task 4: XMLTV streaming reader

**Files:**
- Create: `plugins/iptv-simple/xmltv.js`
- Create: `test/fixtures/iptv/guide.xml`
- Test: `test/iptv-xmltv.test.js`

**Interfaces:**
- Produces:
  - `parseXmltvTime(text: string, shiftHours = 0) → ms|null` — `YYYYMMDDhhmmss` with optional `±hhmm`; no offset = UTC.
  - `async parseXmltv(input: AsyncIterable<Buffer|string> | string | Buffer, { shiftHours = 0 } = {}) → { channels: Map<string, string[]>, programmes: XmlProgramme[] }` where `XmlProgramme = { guideId, start, end, title, subtitle?, description?, categories: string[], episode?, image? }`.
  - `async function* decodeGuide(stream: AsyncIterable<Buffer>) → AsyncIterable<Buffer>` — sniffs the first bytes: `1f 8b` → gunzip; `fd 37 7a 58 5a 00` (xz) or `50 4b 03 04` (zip) → throws "This guide is compressed as .xz/.zip — Atomix can read plain or .gz XMLTV"; otherwise passes through.
  - Errors: no `<tv>` root → "The guide file isn't XMLTV"; malformed → "The guide file isn't valid XMLTV (line N)".
- [ ] **Step 1: Write the failing tests**:
  - `parseXmltvTime: +1300, -0500, no offset is UTC, shift adds hours once`.
  - `channels with several display-names; programmes with title, sub-title, desc, categories, icon`.
  - `episode-num: xmltv_ns "1.4." → "S2 E5", ".4." → "E5", onscreen preferred when present`.
  - `a programme without stop ends at the next one on its channel; the last one without stop is dropped`.
  - `entities, numeric references and CDATA in titles`.
  - `gzip by magic bytes (file named .xml); xz and zip refused with the sentence`.
  - `streamed in 1 KB chunks gives the same result as one string`.
  - `a 50 MB synthetic guide streams with heap growth under 64 MB` (measure `process.memoryUsage().heapUsed` before/after, programmes collected only as a count via an `onProgramme` callback option: add `onProgramme?: (p) => void` — when given, programmes are not accumulated).
  - `malformed XML reports the line; a non-XMLTV root says "The guide file isn't XMLTV"`.
- [ ] **Step 2: Run** `node --test test/iptv-xmltv.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** in `plugins/iptv-simple/xmltv.js`: a chunk-fed tokenizer (states: text, tag open, attribute, comment, CDATA, PI/doctype) that keeps only the current element path and the current programme/channel being built; line counter for errors. Times through `parseXmltvTime`.
- [ ] **Step 4: Run** — Expected: PASS.

### Task 5: Catch-up URLs and guide matching

**Files:**
- Create: `plugins/iptv-simple/catchup.js`, `plugins/iptv-simple/match.js`
- Test: `test/iptv-catchup.test.js`, `test/iptv-match.test.js`

**Interfaces:**
- Produces:
  - `catchupUrl(channel: M3uChannel, { start: ms, end: ms, now: ms, from = 0 /*s*/ , defaults = {} }) → string` — modes `default`, `append`, `shift`/`timeshift`, `flussonic`/`flussonic-hls`/`flussonic-ts`/`fs`, `xc`/`xtream`; `catchup-correction` hours added to start/end; throws "This channel has no catch-up" for none/unknown.
  - `fillTemplate(template: string, { start, end, now }) → string` — every token of spec §2.
  - `catchupWindowDays(channel, header, settingDays) → number`.
  - `normaliseName(s) → string`; `matchGuide(channels: M3uChannel[], guideChannels: Map<id, names[]>) → Map<channelKey, guideId>` per spec §2.
- [ ] **Step 1: Write the failing tests** (fixed `start = Date.UTC(2026,9,10,6,0,0)` (19:00 NZDT), `end = start + 30 min`, `now = start + 2 h`):
  - `default: "http://h/c.ts?s={utc}&e={utcend}&d={duration}"` → `?s=1791612000&e=1791613800&d=1800`.
  - `tokens {Y}{m}{d}{H}{M}{S}, {lutc}, {duration:60}, {offset:60}, ${start}, ${end}, ${timestamp}, {utc:Y-m-d H:M:S}`.
  - `append: liveUrl + "?utc={utc}&lutc={lutc}"`.
  - `shift: adds ?utc=…&lutc=…, or &… when the URL has a query`.
  - `flussonic HLS: http://h/ch1/index.m3u8 → http://h/ch1/index-1791612000-1800.m3u8; TS: mpegts → archive-1791612000-1800.ts`.
  - `xtream: http://h:8080/live/u/p/42.ts → http://h:8080/timeshift/u/p/30/2026-10-10:06-00/42.ts` (UTC date, minutes rounded up).
  - `from shifts start and shortens duration`; `correction +1 h`.
  - `catchupWindowDays: channel, else header, else setting`.
  - Matching: `tvg-id exact, then case-insensitive`; `name against display names: "TVNZ 1 HD" ↔ "TVNZ1"`, `"Māori TV" ↔ "Maori TV"`; `unmatched channels stay out of the map`.
- [ ] **Step 2: Run** `node --test test/iptv-catchup.test.js test/iptv-match.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** both modules (accents stripped with `normalize('NFD').replace(/\p{M}/gu, '')`).
- [ ] **Step 4: Run** — Expected: PASS.

### Task 6: The plugin's `index.js`

**Files:**
- Create: `plugins/iptv-simple/index.js`, `plugins/iptv-simple/fetch.js`
- Modify: `src/plugins.js` (plugin api gains `fetchFollowing` and `redactUrl`), `src/http/net.js` (`redactUrl`)
- Test: `test/iptv-plugin.test.js`

**Interfaces:**
- Consumes: `parseM3u` (T3), `parseXmltv`/`decodeGuide` (T4), `catchupUrl`/`matchGuide`/`catchupWindowDays` (T5), `api.registerLiveSource` (T2).
- Produces:
  - `redactUrl(url: string) → string` in `src/http/net.js` — `scheme://host[:port]/…` (no userinfo, path or query). Exposed as `api.redactUrl`.
  - `openInput(location: string, { userAgent, signal, maxBytes = 200 * 1024 * 1024, what: 'playlist'|'guide' }, api) → AsyncIterable<Buffer>` in `fetch.js` — URL via `api.fetchFollowing` (30 s timeout); file path must be absolute and a regular file (`fs.createReadStream`). Errors (exact copy): HTTP status → "The playlist didn't answer (HTTP 403) — check the address and that your subscription is active" (guide: "The guide didn't answer (HTTP 404)"); timeout → "The playlist took too long to answer" / "The guide took too long to answer"; over the cap → "The playlist is larger than 200 MB"; a relative path → "Use a full file path (for example D:\\TV\\playlist.m3u)"; missing file → "There's no file at that path". No error message contains the URL beyond `redactUrl`.
  - `setup(api)` registers live source `{ id: 'playlist', name: 'IPTV Simple', refresh, stream, catchup, settingsSummary, refreshHours, maxStreams }`:
    - `refresh(ctx)`: playlist → `parseM3u`; guide location = setting else `header.guideUrls[0]`; guide → `decodeGuide` → `parseXmltv` with `shiftHours`; `matchGuide`; channels mapped to the hook's `Channel` (`logo` resolved against `logosPath` when it's a bare name; `catchup` with resolved days); `programmes` mapped from guide ids to the matched channels' `guideId` (= the guide id itself). The plugin keeps `{ key → { url, headers, mime, catchup, shift } }` in memory and in `api.storage` (`channels`) so `stream()` works after a restart before the next refresh. A guide failure returns channels with `warnings: ['The guide didn't answer (HTTP 404)']` (channels still update).
    - `stream(key)` → `{ url, headers: { 'User-Agent': ua, ...channel.headers }, mime }`; unknown key → `HttpError(404, 'This channel no longer exists.')`.
    - `catchup(key, programme, { from })` → `{ url: catchupUrl(...), headers, duration: (programme.end - programme.start) / 1000 - from }`.
    - `settingsSummary()` → "312 channels in 14 groups · guide to Sat 6 pm · 12 channels without guide" (day/time in the server's locale short form; "no guide" when none).
    - `maxStreams()` → `auto` resolves to 1 for an `http(s)` playlist, `Infinity` for a file.
- [ ] **Step 1: Write the failing tests** with a `fakeApi` (as `test/internet-archive.test.js`) whose `fetchFollowing` is backed by a `fakeServer` from `test/helpers.js` serving fixtures:
  - `refresh returns channels with groups, numbers, logos and programmes matched to them`.
  - `the guide comes from url-tvg when the setting is empty`.
  - `a 403 playlist rejects with the exact sentence and no path or credentials in it` (playlist URL `http://127.0.0.1:<port>/get.php?username=u&password=secretpw`) — assert `!/secretpw|username/.test(err.message)`.
  - `an HTML login page with HTTP 200 rejects with "The playlist isn't an M3U file"`.
  - `a guide failure still returns channels, with the warning`.
  - `stream() adds the user agent and the playlist's headers; an unknown key is 404`.
  - `stream() works after a restart from storage, before any refresh`.
  - `catchup() builds the URL for an xtream channel and the duration from "from"`.
  - `settingsSummary counts groups and unmatched channels`.
  - `redactUrl keeps only scheme, host and port`.
  - `a relative file path is refused; an absolute file path is read`.
- [ ] **Step 2: Run** `node --test test/iptv-plugin.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `redactUrl`, the two api additions, `fetch.js` and `index.js`. `refreshHours` reads the setting; `api.onConfigChange` triggers nothing itself (the refresher listens, T2).
- [ ] **Step 4: Run** — Expected: PASS; `npm test` — Expected: all pass.

### Task 7: Live routes

**Files:**
- Create: `src/api/live.js`
- Modify: `src/app.js` (register the routes; the `/api/profiles/:id/live-groups` pair lives in `src/api/live.js`, admin-guarded)
- Test: `test/live-api.test.js`

**Interfaces:**
- Consumes: `LiveStore` (T1), `plugins.listLiveSources/getLiveSource`, `core.live.refresher` (T2), `core.images` (`ImageCache.download(url, headers)` and `resolve()`), `sendFile` from `src/http/static.js`.
- Produces the routes of spec §4 (except the two `…/play` routes, Task 8), with:
  - `liveViewer(ctx) → { sources: string[], groups: Set|null }` — `sources` = registered source keys; Kids → their `kidsGroups` (empty set → Live TV off); others → `null`.
  - JSON shapes exactly as spec §4. `logo` = `/api/live/channels/<id>/logo` when the channel has one, else null; programme `image` = `/api/live/programmes/<id>/image` when set.
  - `GET /api/live/status` → `{ enabled: sources.length > 0 && visible channel count > 0, sources: [{ id, name, channels, lastOk, summary, error? /*admin*/, unmatched? /*admin: first 20 names*/ }] }`.
  - `GET /api/live/guide` clamps `to − from` to 6 h and `channels` to 200 ids; invalid → 400 "Choose a time window".
  - Logo/image routes download through `images.download` (headers: the source's user agent) and serve with `cacheControl: 'private, max-age=604800'`; 404 when none or the download failed.
  - Admin: `POST /api/live/sources/:id/refresh` → `{ ok, error? }` (`:id` URL-encoded `plugin/source`); `GET/PUT /api/profiles/:id/live-groups` → `[{ source, group }]`, PUT only for a Kids profile of the same account ("Live TV groups are for Kids profiles").
- [ ] **Step 1: Write the failing tests** in `test/live-api.test.js` with `startAtomix()` and a test plugin folder (`test/fixtures/live-plugin/` registering a source with canned channels/programmes — `ATOMIX_PLUGINS_DIR` pointed at a temp dir containing it):
  - `status is disabled until a source has channels; enabled after the first refresh`.
  - `channels carry now/next, favourite and logo URLs; groups in playlist order`.
  - `favourites: toggle, order with PUT, favourites=1 filter`.
  - `guide window: overlapping programmes; more than 6 h is clamped; bad input is 400`.
  - `programme details include canWatchLive/canStartOver/canCatchup by time and catch-up days`.
  - `Kids: nothing until groups are ticked; then only those channels and their programmes; a channel in two groups shows once`.
  - `admin-only: refresh, live-groups and source errors are refused or absent for a viewer`.
  - `no response contains the provider URL, a header value or the logo's host` — walk every route's JSON for the canned stream URL host and header value.
  - `the logo route proxies and caches the image (one upstream request for two calls)`.
- [ ] **Step 2: Run** `node --test test/live-api.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/api/live.js` and register it.
- [ ] **Step 4: Run** — Expected: PASS; `npm test` — Expected: all pass.

### Task 8: Live and catch-up playback

**Files:**
- Create: `src/live/stream.js`
- Modify: `src/stream/playback.js` (`source.live`, restart-on-exit, live arg builder, redacted input in logs), `src/stream/ffheaders.js` (`liveInputArgs`), `src/library/probe.js` (`probe(ffprobePath, file, { headers, live })`), `src/api/live.js` (the two play routes), `src/remote/progress.js` / progress route guard (no progress for `live:` items)
- Test: `test/live-stream.test.js`

**Interfaces:**
- Consumes: T1 store, T2 `getLiveSource(key).stream/catchup/maxStreams`, `playback.create` (existing: `{ user, profile, item, caps, source, start, quality, replaces, clientIp }`).
- Produces:
  - `class LiveStreams { constructor({ store, plugins, playback, config, log }) }` with `startLive({ user, profile, viewer, channelId, caps, quality, replaces, audioOnly = false, clientIp }) → { session, url, channel, programme }` and `startCatchup({ …, programmeId, from = 0 }) → { session, url, channel, programme, duration }`; `openOn(sourceKey) → sessions[]`.
  - Stream limit with a **per-source reservation**: the count is open live/catch-up sessions of the source + in-flight starts, excluding `replaces`; reservations are taken synchronously before any `await`, released when the session exists or the start fails. Over → `HttpError(409, 'Your provider allows N stream(s) at a time — stop the other one first')` ("1 stream" singular, "2 streams" plural) with `err.details = { holders: [{ profile, channel }] }` (non-admins get `[{ profile: 'Someone else in your household', channel: null }]` for other accounts' sessions).
  - `replaces` is stopped **before** `source.stream()` is called.
  - Synthetic item: `{ id: 'live:<channelId>' | 'catchup:<programmeId>', kind: 'live'|'catchup', title, path: null, media: <probe summary>, duration: null | seconds }`.
  - `probe(ffprobePath, url, { headers, live: true })` adds `-rw_timeout 8000000 -analyzeduration 5000000 -probesize 5000000` and the header args; a probe failure → `HttpError(502, "This channel isn't answering right now (the provider closed the connection)")`, an ffprobe timeout → "This channel took too long to answer", no video and no audio stream → "This channel isn't a video stream".
  - `playback.create` with `source: { file: url, remote: true, live: true|false, headers }`: for `live`, `decide()` never yields `direct`; input args from `liveInputArgs(headers)` = header args + `-reconnect_on_network_error 1 -rw_timeout 15000000`; no `-ss`, no `-t`, no `-readrate`; HLS output with `-hls_list_size 6 -hls_flags delete_segments+independent_segments`; session fields `live: true`, `duration: null`. Catch-up uses `live: false` with the URL and `duration`.
  - `audioOnly`: `-vn`; audio copied when the codec is mp3/aac/opus, else AAC 192k; delivery as the music player's existing audio session.
  - Restart-on-exit for live: an ffmpeg exit with non-zero code while the session is open restarts it (same args) up to 3 times within 2 min (`session.restarts`), emitting `playback:notice` `{ sessionId, text: 'Lost the channel — trying again' }`; the 4th ends the session with `error: 'This channel stopped sending video.'` (visible in the session status the player polls).
  - Logs: the debug ffmpeg line replaces the input URL after `-i` with `redactUrl(url)` (both live and catch-up, and connected servers' URLs too).
  - Routes: `POST /api/live/channels/:id/play` and `POST /api/live/programmes/:id/play` → `{ sessionId, mode, delivery, url, live, duration, channel, programme, reasons, quality }` (the same field names `/api/items/:id/playback` uses).
  - Progress: `POST /api/items/live:…/progress` and `catchup:…` → 204 with nothing written (the player may still call it).
- [ ] **Step 1: Write the failing tests** in `test/live-stream.test.js` (`hasFfmpeg` skip) with a `fakeServer` that serves an MPEG-TS file generated by `makeVideo(… .ts)` repeatedly (`/live/u/p/1.ts`, and `/timeshift/…` for catch-up), and a fake live source:
  - `startLive remuxes an H.264/AAC stream (mode remux) and the stream URL is Atomix's own`.
  - `the provider URL is redacted in the debug log` (capture `log.debug`; assert `!/\/live\/u\/p\//.test(line)` and `/http:\/\/127\.0\.0\.1:\d+\/…/` present).
  - `a 1-stream source refuses a second viewer with the exact sentence and holders`.
  - `two simultaneous starts on a 1-stream source: exactly one succeeds` (`Promise.allSettled` of two `startLive` calls).
  - `zapping with replaces stops the old session before stream() is asked for the new URL` (the fake source records call order against `playback.stop`).
  - `an ffmpeg exit restarts the session up to 3 times, then ends it with "This channel stopped sending video."` (fake server closes the connection immediately after the first response).
  - `a dead channel answers 502 "This channel isn't answering right now (the provider closed the connection)"`.
  - `startCatchup builds a finite session with the programme's length minus from`.
  - `audioOnly sessions copy AAC and drop video`.
  - `live sessions count toward the per-account limit of 4`.
  - `progress for a live: id writes nothing`.
- [ ] **Step 2: Run** `node --test test/live-stream.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/live/stream.js`, the playback/probe/ffheaders changes and the play routes.
- [ ] **Step 4: Run** `node --test test/live-stream.test.js test/playback.test.js test/passover-ffmpeg.test.js` — Expected: PASS; `npm test` — Expected: all pass (≈ 472 + the new files).
- [ ] **Step 5: Devtools mock** — create `/home/claude/devtools/mock-iptv.mjs` (port 9919, cloud only): `/playlist.m3u` (12 channels in 4 groups, numbers, two radio stations, catch-up on three channels in `default`, `shift` and `xc` styles, one channel with a `|User-Agent=` suffix), `/guide.xml.gz` (programmes every 30 min from now − 2 days to now + 2 days, built at start), `/live/<id>.ts` (an endless MPEG-TS from `ffmpeg -re -f lavfi testsrc2 …` piped per request, a clock overlay and a tone), `/hls/<id>/index.m3u8` (an ffmpeg HLS live output), `/timeshift/…` and `?utc=` catch-up (a finite TS whose overlay shows the requested start time), radio `/radio/<id>.mp3`, `/__mode?m=ok|403|slow|drop|limit`. Add it to `restart-dev.sh`. Smoke: `curl -s :9919/playlist.m3u | head -3` shows `#EXTM3U url-tvg=…`.

---

**Plan B (next file)** covers: the menu entry, `#/live` channels page, `#/live/guide`, the programme sheet, the player's live and catch-up modes, radio in the music player, casting live/catch-up (`castManager.start({ liveChannelId | catchupProgrammeId })`, the Remote's live mode), the "On now" home row, search "On TV", the plugin page's refresh summary, Household → Kids "Live TV groups", the dashboard error, `live-ui.mjs`, docs (README, ARCHITECTURE, PLUGINS.md) and v0.16.0.
