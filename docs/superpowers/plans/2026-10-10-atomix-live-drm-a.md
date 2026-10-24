# Atomix encrypted Live TV — plan A (server, relay, pure player logic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything an encrypted (Widevine/ClearKey DASH) channel needs except the browser engine: IPTV Simple keeps the DRM lines, channels are marked encrypted, pressing play opens an encrypted session, Atomix relays the manifest, segments and licence without exposing the provider, and the pure DASH logic (XML, manifest, live timeline, quality choice) is written and Node-tested.

**Architecture:** The plugin parses `#KODIPROP` DRM lines into `drm: { system, licence }` kept in its own storage and returned by `stream()`. Migration 16 adds `live_channels.drm`. `src/live/drm.js` (`LiveDrm`) owns encrypted sessions (reservation through `LiveStreams.reserve`, ping, reap, stop) and the relay (manifest rewrite to opaque `/api/live/drm/:sid/r/<n>/` bases, same-host segment proxy, licence forwarding per Kodi's `license_key` grammar, ClearKey JWK answers). The play route replies `delivery: 'drm'` for encrypted channels. `public/js/dash/{xml,mpd,timeline,abr}.js` are pure ES modules imported by the server (the rewrite reuses `xml.js`) and tested in Node.

**Tech Stack:** Node ≥ 22.13 (node:http, node:sqlite, node:test, fetch), plain ES modules, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-live-drm-design.md`. Context: Round 18's Live TV plans (`…/plans/2026-10-10-atomix-live-tv-a.md`, `-b.md`) and their ledgers (`scratchpad/note/v0160-progress-{a,b}.md`).

## Global Constraints

- No dependencies; the browser modules are plain ES modules with no build step and no DOM use in `xml/mpd/timeline/abr`.
- Provider addresses, headers, licence URLs and ClearKey keys never appear in any reply to the browser except that a ClearKey licence answer necessarily carries the requested keys; the rewritten manifest contains no provider host.
- Relay: http(s) only; segments only to the same host as the base they resolve against; every hop through `fetchFollowing(url, { check: isPrivateTarget-based check })`; manifest 2 MB / 15 s, segment 64 MB / 20 s to first byte, licence body 64 KB / 10 s.
- Kids and visibility exactly as for plain channels (`core.live.routes.visibleChannel`); every `/api/live/drm/:sid/*` route answers 404 unless the session belongs to the caller's user and profile.
- Encrypted sessions count toward the source's `maxStreams` (same-profile rule included) and the per-account cap of 4 (`MAX_SESSIONS_PER_USER`, 429 "Too many streams open on this account.").
- Sentences fixed by the spec: "The provider refused this channel's licence" (403), "The licence server isn't answering" (502), "The playlist doesn't have the key for this channel" (403), "This channel's stream couldn't be read" (502), "This channel is encrypted, so it can't be cast" (400).

## Review Focus

1. **A manifest that names other hosts** — BaseURLs or absolute segment URLs on a CDN different from the manifest's host: each becomes its own opaque base and segments are allowed to that host only (Task 6 test).
2. **Live timelines with gaps and repeats** — `SegmentTimeline` with `r="-1"`, explicit `t` jumps, and `startNumber` with `$Time$` templates: the window and URLs must match what a real packager publishes (Task 4 tests).
3. **The licence answer formats** — JSON field responses (`JBlicense`), base64 bodies, templated requests: wrong decoding gives a silent black screen in the browser, so each form is pinned (Task 6 tests).
4. **Sessions that outlive the page** — a closed tab must not hold the provider's only stream beyond 2 minutes, and a new press from the same profile replaces it at once (Task 5 tests).
5. **Hostile manifests** — DOCTYPE/entity declarations, 50 000 nested elements, a 3 MB body: refused with "This channel's stream couldn't be read", never a hang (Task 3 tests).

---

### Task 1: IPTV Simple keeps the DRM lines

**Files:**
- Create: `plugins/iptv-simple/drm.js`
- Modify: `plugins/iptv-simple/m3u.js`, `plugins/iptv-simple/index.js`
- Test: `test/iptv-drm.test.js`, `test/fixtures/iptv/drm.m3u`

**Interfaces:**
- Produces `plugins/iptv-simple/drm.js`:
  - `parseLicenceKey(system, text) → { url, headers, body, response } | { keys: [{ kid, key }] } | null` — `url|headers|post|response`; headers `Name=Value&…` (URL-decoded); `body` one of `{ kind: 'raw' }`, `{ kind: 'template', text }` (placeholders `R{SSM}`, `b{SSM}`, `B{SSM}`); `response` one of `{ kind: 'raw' }`, `{ kind: 'base64' }`, `{ kind: 'json', path, base64 }`. ClearKey `kid:key[,kid:key]` or `{"kid":"key"}` → `keys` (lowercase hex, 32 chars, else null).
  - `systemName(v) → 'widevine' | 'clearkey' | null` (`com.widevine.alpha`, `widevine`, `org.w3.clearkey`, `clearkey`).
  - `parseHeaderList(text) → { [name]: value }`.
- `parseM3u` entries gain `drm: { system, licence } | null`, `manifestHeaders`, `streamHeaders` (from `license_type`+`license_key`, or `drm_legacy=<system>|<url>|<headers>`, `manifest_headers=`, `stream_headers=`).
- `index.js`: storage entry keeps `drm`, `manifestHeaders`, `streamHeaders`; `refresh()` channels carry `drm: <system name> | null`; `stream(key)` → `{ url, headers, mime, drm, manifestHeaders, streamHeaders }` (`headers` = user agent + entry headers + `streamHeaders`).

- [ ] **Step 1: Write the failing tests** in `test/iptv-drm.test.js`:
  - `parseLicenceKey('widevine', 'https://lic.example/wv')` → `{ url: 'https://lic.example/wv', headers: {}, body: { kind: 'raw' }, response: { kind: 'raw' } }`.
  - `'https://lic.example/wv|User-Agent=Foo%20Bar&X-Token=abc|R{SSM}|'` → headers `{ 'User-Agent': 'Foo Bar', 'X-Token': 'abc' }`, raw/raw.
  - `'https://l/x||{"challenge":"b{SSM}"}|JBlicense'` → body `{ kind: 'template', text: '{"challenge":"b{SSM}"}' }`, response `{ kind: 'json', path: 'license', base64: true }`; `'…|||B'` → response base64; `'…|||Jdata.lic'` → json path `data.lic`, base64 false.
  - ClearKey `'a7e61c373e219033c21091fa607bf3b8:76a6c65c5ea762046bd749a2e632ccbb'` and `'{"a7e61c373e219033c21091fa607bf3b8":"76a6c65c5ea762046bd749a2e632ccbb"}'` → one key; `'zz:yy'` → null.
  - `parseM3u` on `drm.m3u`: the user's TVNZ 2 entry (`manifest_type=mpd`, `license_type=com.widevine.alpha`, `license_key=https://c.mjh.nz/tvnz-2-wv`) → `drm.system 'widevine'`, mime `application/dash+xml`; a `drm_legacy=org.w3.clearkey|https://l/ck|X-A=1` entry; a `stream_headers=Referer=https%3A%2F%2Fa.example%2F` entry; a plain entry → `drm: null`.
  - plugin: after `refresh()` the TVNZ 2 channel has `drm: 'widevine'`; `stream(key)` returns `drm.licence.url` and no DRM data appears in `refresh()`'s channel objects other than the system name.
- [ ] **Step 2: Run** `node --test test/iptv-drm.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `drm.js` and the `m3u.js` / `index.js` changes.
- [ ] **Step 4: Run** `node --test test/iptv-drm.test.js test/iptv-m3u.test.js test/iptv-plugin.test.js` — Expected: PASS.

### Task 2: Channels marked encrypted (migration 16)

**Files:**
- Modify: `src/db.js` (migration 16), `src/live/store.js`, `src/api/live.js` (`shapeChannel`), `src/live/refresh.js` (passes `drm`)
- Test: `test/migrations.test.js`, `test/live-store.test.js`, `test/live-api.test.js`, `test/fixtures/live-plugins/live-test/index.js`

**Interfaces:**
- Migration 16: `ALTER TABLE live_channels ADD COLUMN drm TEXT` (NULL = plain).
- `LiveStore.replaceChannels` writes `drm` (`'widevine'|'clearkey'|null`, anything else stored as NULL); `channel(id)`/`channels()` rows include `drm`.
- `shapeChannel(c)` gains `drm`.
- Test plugin: channel `five` (`drm: 'clearkey'`, DASH) whose `stream()` returns `{ url: <base>/dash/five.mpd, mime: 'application/dash+xml', drm: { system: 'clearkey', licence: { keys: [...] } } }` and channel `six` (`drm: 'widevine'`, licence URL `<base>/lic/six`).

- [ ] **Step 1: Write the failing tests**: migration 16 adds the column to an existing v15 database; `replaceChannels` keeps `drm` and normalises unknown values to null; `GET /api/live/channels` shows `drm: 'clearkey'` for Five and `null` for One.
- [ ] **Step 2: Run** `node --test test/migrations.test.js test/live-store.test.js test/live-api.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS (the existing live tests updated for the two new fixture channels where they count channels).

### Task 3: `xml.js` and `mpd.js`

**Files:**
- Create: `public/js/dash/xml.js`, `public/js/dash/mpd.js`
- Test: `test/dash-mpd.test.js`, `test/fixtures/dash/*.mpd` (number template live, timeline live, VOD static, multi-period, nested BaseURLs, Widevine+ClearKey ContentProtection)

**Interfaces:**
- `parseXml(text, { maxBytes = 2_000_000, maxDepth = 64, maxNodes = 20_000 }) → { name, attrs, children, text }` (root); throws `Error('bad xml')` on DOCTYPE/ENTITY, unclosed/mismatched tags, or limits; `serializeXml(node) → string` (round-trips attributes and text, escapes `&<>"`).
- `parseDuration('PT1H2M3.5S') → 3723.5` (seconds; `P1D` days; null for empty).
- `parseMpd(text, manifestUrl) → Mpd` with the spec §3 shape; `systemOf(schemeIdUri)`; `resolveBase(parts[])`.

- [ ] **Step 1: Write the failing tests**: each fixture parses to the expected `type`, times (ms since epoch for `availabilityStartTime`), periods (start from `start` or the previous period's end), adaptation sets split video/audio by `contentType`/`mimeType`, representation fields, `template` merged from AdaptationSet into Representation with Representation overriding, `timeline` entries `{ t, d, r }` with `r=-1` kept, `contentProtection` with `system: 'widevine'` + `pssh` base64 and `system: 'cenc'` + `kid` (lowercase hex without dashes), BaseURL resolution across four levels; `serializeXml(parseXml(x))` round-trips the fixtures' attributes; DOCTYPE, 65-deep nesting, 20 001 nodes and 2 000 001 bytes each throw.
- [ ] **Step 2: Run** `node --test test/dash-mpd.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.

### Task 4: `timeline.js` and `abr.js`

**Files:**
- Create: `public/js/dash/timeline.js`, `public/js/dash/abr.js`
- Test: `test/dash-timeline.test.js`, `test/dash-abr.test.js`

**Interfaces:**
- `fillTemplate(tpl, { RepresentationID, Bandwidth, Number, Time })` — `$Name$`, `$Name%05d$`, `$$`.
- `segmentsAt(rep, period, mpd, nowMs) → { init: url, segments: [{ number, time, start, end, url }] }` — times in seconds on the presentation timeline; dynamic: within `[now − timeShiftBufferDepth, now]` relative to `availabilityStartTime + period.start` (segments whose end ≤ now); static: all.
- `liveEdge(mpd, segments) → seconds` = last end − max(3 × segment duration, suggestedPresentationDelay).
- `clockOffset(serverIso, localMs) → ms`.
- `pickRepresentation(reps, { throughputBps, bufferedSec, maxHeight, current }) → rep` (spec §3 rules).

- [ ] **Step 1: Write the failing tests**: `$Number$` live with `duration=2`, `startNumber=100`, AST = now − 3600 s, depth 60 s → 30 segments, numbers 1885…1899… (exact values computed in the test from the formula `startNumber + floor((now − AST − periodStart)/duration) − 1` as the newest complete); `presentationTimeOffset` shifts `$Time$` values; timeline `S t=0 d=2000 r=-1` with timescale 1000 repeats to now; an explicit later `t` makes a gap that is respected; `%05d` padding; static VOD lists every segment; `clockOffset` sign; ABR: first pick, upswitch only with ≥ 10 s buffer, immediate downswitch under 4 s, `maxHeight` cap rounding up to the nearest level.
- [ ] **Step 2: Run** `node --test test/dash-timeline.test.js test/dash-abr.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.

### Task 5: Encrypted sessions and the play route

**Files:**
- Create: `src/live/drm.js`
- Modify: `src/live/stream.js` (`openOn` counts encrypted sessions; `startLive` hands DRM channels to `LiveDrm`), `src/app.js` (`core.live.drm`), `src/api/live.js` (play route reply), `src/stream/playback.js` (account cap counts encrypted sessions via a hook), `src/api/admin.js` (dashboard lists them), `src/api/cast.js` (refuses encrypted channels)
- Test: `test/live-drm.test.js`

**Interfaces:**
- `class LiveDrm({ streams, playback, plugins, log })`: `start({ user, profile, channel, source, stream, replaces, isAdmin, clientIp }) → { session, reply }`; `sessions: Map`; `get(id, user, profile)` (404 otherwise); `ping(id, user, profile) → { ok, error? }`; `stop(id, reason)`; `reap()` (2 min); `list()` for the dashboard (`{ id, user, itemId: 'live:<id>', title, mode: 'encrypted', delivery: 'drm', position: 0, paused: false, startedAt, clientIp }`); `countFor(userId)`.
- `LiveStreams.openOn(key)` returns playback live sessions plus encrypted sessions (objects with `id, userId, profileId, createdAt, live: { sourceKey, channelName }`); stopping an encrypted one through the same-profile rule calls `drm.stop`.
- Play reply for an encrypted channel: `{ sessionId, delivery: 'drm', keySystem: 'com.widevine.alpha'|'org.w3.clearkey', manifest: '/api/live/drm/<sid>/manifest.mpd', licence: '/api/live/drm/<sid>/licence', live: true, duration: null, start: 0, channel, programme, next }`.
- Routes: `POST /api/live/drm/:sid/ping`, `POST /api/live/drm/:sid/stop`.

- [ ] **Step 1: Write the failing tests** (live-test fixture, a fake provider serving the fixture manifests): play Five → `delivery: 'drm'`, `keySystem 'org.w3.clearkey'`, no provider host or key anywhere in the JSON; Dashboard lists it as `mode: 'encrypted'`; on a 1-stream source a second profile gets 409 with holders, the same profile replaces it; `replaces` stops a plain session and vice versa; the account cap counts it (4 plain + 1 encrypted → 429); ping keeps it, no ping for 2 min (reaper with a fake clock) ends it and the next ping says `{ ok: false, error: 'This channel stopped.' }`; another user's/profile's ping/stop → 404; a Kids profile without groups → 404; a manifest that isn't XML → 502 "This channel's stream couldn't be read"; cast route with `liveChannelId` of Five → 400 "This channel is encrypted, so it can't be cast".
- [ ] **Step 2: Run** `node --test test/live-drm.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/live-drm.test.js test/live-stream.test.js test/live-api.test.js test/cast-live.test.js` — Expected: PASS.

### Task 6: The relay — manifest, segments, licence, time

**Files:**
- Modify: `src/live/drm.js`, `src/api/live.js` (routes)
- Test: `test/live-drm-relay.test.js`

**Interfaces:**
- `rewriteManifest(text, manifestUrl, session) → string` (uses `parseXml`/`serializeXml`; pushes each resolved base into `session.bases`, reusing indexes for equal URLs; maps absolute template/SegmentURL/Initialization/Location URLs; replaces UTCTiming `value` with `/api/live/drm/<sid>/time` and scheme `urn:mpeg:dash:utc:http-iso:2014`).
- `GET /api/live/drm/:sid/manifest.mpd` (`application/dash+xml`), `GET /api/live/drm/:sid/r/:n/*`, `POST /api/live/drm/:sid/licence`, `GET /api/live/drm/:sid/time` (ISO, `text/plain`).
- `buildLicenceRequest(licence, challenge: Buffer) → { body: Buffer|string, contentType }`; `readLicenceResponse(licence, res: { buffer, text }) → Buffer`; `clearKeyAnswer(keys, requestJson) → { keys: [{ kty: 'oct', kid, k }], type: 'temporary' }` (base64url).

- [ ] **Step 1: Write the failing tests**: rewritten manifest has no provider host in any attribute or text (walk every node), BaseURLs on two different hosts become `r/0/` and `r/1/`, a relative SegmentTemplate stays relative under its base, UTCTiming points at `/time`; `GET r/0/seg_1_5.m4s` streams the provider's bytes with content-type; `r/0/../../other-host` and `r/0/https://evil.example/x` are refused (only the base's host), `r/9/x` → 404, a base resolving to `127.0.0.1` when the provider was public → refused; Range passes through (206); licence raw → provider receives the exact challenge bytes and the browser gets the exact answer; template `{"challenge":"b{SSM}"}` → provider receives JSON with the base64 challenge, `JBlicense` answer decoded; `B` response decoded; licence headers sent; provider 403 → 403 "The provider refused this channel's licence"; provider down → 502 "The licence server isn't answering"; ClearKey keys: `{"kids":["p-YcNz4hkDPCEJH6YHvzuA"],"type":"temporary"}` → JWK with the key in base64url, an unknown kid → 403 "The playlist doesn't have the key for this channel"; 64 KB+1 body → 413; every route 404 for another profile.
- [ ] **Step 2: Run** `node --test test/live-drm-relay.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/live-drm-relay.test.js test/live-drm.test.js` and the whole `npm test` (in groups if needed) — Expected: PASS.
