# Atomix tidy-up — plan A (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every server-side deferred minor in the spec's Plan A (relay, IPTV Simple, Live TV core, casting, libraries, sign-in, playback, remote, extras), each with a test that fails first.

**Architecture:** Fixes stay in the files that own the behaviour today (paths below come from the item map). One migration (17) adds `live_channels.missing_since` and `live_sources.unmatched_names`. Browser-side halves of three items (the Settings guide card's folded radio list, the "Remove missing titles" menu entry, `setServerCertificate`/init data in eme.js) are Plan B; this plan produces the API they use.

**Tech Stack:** Node ≥ 22.13 (node:http, node:sqlite, node:test, fetch, node:dns/promises), no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-tidyup-design.md` (Plan A section; item ids as there). Item map with file:lines: the subagent table in the session (summarised in each task's Files).

## Global Constraints

- No dependencies. Migrations append: 17 is this plan's. Older themes untouched by this plan.
- Sentences exactly: "This channel's stream couldn't be read" · "Your provider allows N stream(s) at a time — another profile on your account is using it" · "Stopped on <TV name>." · "Capped at {cap}p (software conversion)" · "Remove N titles whose files are gone?" (Plan B shows it; the API returns N).
- Values: 32 provider origins per encrypted session; UTCTiming cache 60 s; missing channels deleted after 7 days; images ≤ 10 MB; guideShift −24…24; guide fetch 30 s to headers + 30 s idle; probe reuse 10 min; keyframe search 30 s then 60 s; lyrics count cache 60 s; reporter entries pruned after 1 h.
- Credentials = Authorization, Cookie, Proxy-Authorization (the existing `CREDENTIALS` set in `src/live/drm.js`).

## Review Focus

1. **A playlist that briefly loses channels and gets them back** (a provider glitch): ids, favourites and numbers must return, and hidden channels must not be playable or zappable meanwhile (Task 5 test "a channel back within 7 days keeps its id and favourite").
2. **An expiring manifest token that the fresh `stream()` also can't fix** — must end in one 502, not a loop (Task 2 test "a second refusal after the fresh address is the 502").
3. **`trustProxy: 2` with a client-supplied X-Forwarded-For longer than the real chain** — the Nth from the right is used, never a client-controlled leftmost entry (Task 8 test).
4. **A guide where every channel is radio** — the summary must not say "0 TV channels without guide" as if something were wrong; it says nothing about the guide gap (Task 5 test).
5. **Probe reuse after the channel's stream changed format** (provider switches codec) — a failed start with a reused probe retries once with a fresh probe (Task 6 test).

---

### Task 1: Relay segments, headers and limits

**Files:** Modify `src/live/drm.js` (`serveSegment` ~476-530, `rewriteManifest` `opaque` ~129, header building ~490-504), `src/http/router.js` (`readBody` ~118-135). Test: `test/live-drm-relay.test.js`, `test/passover-server.test.js`.

**Interfaces:** Produces `segmentTarget(base: string, rest: string, search: string) → URL` (exported from `src/live/drm.js`).

- [ ] **Step 1: Failing tests** (live-drm-relay):
  - `segmentTarget: a colon in the first path part and a double slash stay paths` — `segmentTarget('https://o.example', 'a:b/seg.m4s', '?x=1').href === 'https://o.example/a:b/seg.m4s?x=1'`; `('https://o.example', '/x//seg.m4s', '')` → `'https://o.example//x//seg.m4s'`; the origin always equals the base.
  - `segments: the provider is asked for identity encoding; an encoded answer has no content-length` — fake CDN route records `accept-encoding` (`=== 'identity'`) and answers `content-encoding: gzip` with a gzip body: the relayed body equals the decoded bytes and has no `content-length`.
  - `segments: a provider 404 reaches the browser as 502 "couldn't be read"`; a 206 still passes as 206.
  - `stream headers' credentials go only to the manifest's origin` — session streamHeaders `{ Authorization: 'Bearer x', 'X-Token': 'hdrsecret' }`; a segment on the second origin (localhost) sees `x-token` but no `authorization`; one on the manifest's origin sees both.
  - `more than 32 provider origins → the manifest is refused` — a manifest with 33 distinct BaseURL hosts → `GET manifest` 502.
  - passover-server: `a chunked body over the cap is answered 413, not reset` — POST a JSON route with `transfer-encoding: chunked` and 2 MB → status 413, body `{error:'Request body too large'}`.
- [ ] **Step 2: Run** `node --test test/live-drm-relay.test.js test/passover-server.test.js` — Expected: the new tests FAIL (400 / reset / passthrough).
- [ ] **Step 3: Implement** `segmentTarget` (`const u = new URL(base); u.pathname = '/' + rest; u.search = search`, so `rest` is never resolved as a relative address); drop the `rest.startsWith('/')` refusal; upstream `accept-encoding: identity`, don't forward `content-length` when `content-encoding` is present; non-2xx except 206 → `HttpError(502, UNREADABLE)` (cancel the body); `opaque()` throws `Error('manifest too big')` when `session.bases.length` would exceed 32; stream headers: strip CREDENTIALS unless `new URL(base).origin === new URL(s.manifestUrl).origin`. `readBody`: on overflow stop collecting, `req.resume()`, reject `HttpError(413, 'Request body too large')`, and set `Connection: close` on the reply (as the 408 path does).
- [ ] **Step 4: Run** the same command — Expected: PASS, and the whole files green.
- [ ] **Step 5: Ledger line** (Dallas commits on the PC).

### Task 2: Relay manifests: fresh addresses, the provider's clock, inherited lists

**Files:** Modify `src/live/drm.js` (`start`, `serveManifest` ~454-470, `rewriteManifest`, `serveTime` ~599). Test: `test/live-drm-relay.test.js`.

**Interfaces:** Session gains `source` (the live source object, for `stream()`), `channelKey`, `utc: { scheme, value } | null`, `clock: { at, offset } | null`.

- [ ] **Step 1: Failing tests:**
  - `an expired manifest address is renewed once from the playlist` — the fake provider answers 403 for `?token=old`; the test source's `stream()` returns `?token=new` the second time; `GET manifest` → 200 and the session's `manifestUrl` ends `token=new`.
  - `a second refusal after the fresh address is the 502` — both tokens 403 → 502 "This channel's stream couldn't be read"; `stream()` called exactly twice in total.
  - `time: the provider's own clock when the manifest names one` — manifest UTCTiming `http-iso` → `${up.url}/time` answering `2030-01-01T00:00:00Z`; `GET …/time` text starts `2030-01-01T00:00:0`; a second call within 60 s doesn't hit the provider (counter); `urn:mpeg:dash:utc:direct:2014` value `2031-…` is answered as given (moved on by elapsed time); an unreadable provider clock → Atomix's clock (within 5 s of now).
  - `AdaptationSet-level SegmentList is inherited into each Representation` — AS-level `<SegmentList><SegmentURL media="s1.m4s"/></SegmentList>` with two reps → both reps carry `SegmentURL media="/api/live/drm/<sid>/r/0/…/s1.m4s"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement:** in `serveManifest`, on a provider 401/403/410 call `await s.source.stream(s.channelKey, { log })` once, update `manifestUrl`, `manifestHeaders`, `streamHeaders`, `licence`, reset `checkUrl`, retry; a second failure throws the existing 502. `rewriteManifest` records the first UTCTiming `{ scheme, value }` on the session (resolved absolute for http schemes) before replacing it. `serveTime`: `direct` → the value plus time since read; `http-iso`/`http-xsdate` → fetch through `this.checkFor(s)` (5 s timeout), keep `{ at, offset }` 60 s; anything else or a failure → `this.now()`. Inherit Period/AS `SegmentList`/`SegmentBase` into reps without their own before the per-rep rewrite.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Ledger line.**

### Task 3: Names that resolve to link-local are refused everywhere Atomix fetches

**Files:** Modify `src/http/net.js` (new export), `src/live/drm.js` (`relayCheck`), `src/library/images.js:12`, `src/api/servers.js:142`, `src/cast/devices.js:107`, `plugins/iptv-simple/fetch.js:20-22`. Test: `test/live-drm-relay.test.js`, `test/passover-fixes.test.js`.

**Interfaces:** Produces `checkResolved(url: string, { lookup }?) → Promise<void>` in `src/http/net.js` (throws `{ code: 'EPRIVATE' }` when the literal host is private per `isPrivateTarget` or any resolved address is 169.254/16, fe80::/10, 0.0.0.0 or `::`).

- [ ] **Step 1: Failing tests:** `relayCheck: a home-network manifest still can't reach a name resolving to link-local` (manifest `http://tuner.lan:5004/…`, fake lookup `meta.lan → 169.254.169.254` → rejects; `tuner.lan → 192.168.1.5` → allowed); passover-fixes: `checkResolved refuses names resolving to link-local or unspecified` (fake lookup), and `the image cache refuses an image whose host resolves to 169.254.169.254` (ImageCache with injected lookup → no fetch made).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `checkResolved`; `relayCheck` calls it on every hop before the local-manifest shortcut; the four other fetch paths pass `check: (u) => checkResolved(u, { lookup })` to `fetchFollowing` (each class/function takes an injectable `lookup` defaulting to `dns.promises.lookup`).
- [ ] **Step 4: Run** `node --test test/live-drm-relay.test.js test/passover-fixes.test.js test/remote-*.test.js test/cast-*.test.js test/iptv-*.test.js` — Expected: PASS.
- [ ] **Step 5: Ledger line.**

### Task 4: IPTV Simple

**Files:** Modify `plugins/iptv-simple/drm.js` (`inlineKeys` ~49), `m3u.js` (KODIPROP ~137-149, keys ~196-203), `index.js` (guideShift ~76, `onProgramme` ~56-94, `stream()`), `fetch.js` (~15-44); `src/live/drm.js` (params appended); `src/api/live.js` (`playEncrypted` reply). Test: `test/iptv-drm.test.js`, `test/iptv-m3u.test.js`, `test/iptv-plugin.test.js`, `test/live-drm-relay.test.js`.

**Interfaces:** `stream()` reply gains `manifestParams`, `streamParams` (strings without `?`), and `drm.serverCertificate`, `drm.initData` (base64 or null). The play reply gains `serverCertificate` and `initData` (base64 or null) for Plan B's eme.js.

- [ ] **Step 1: Failing tests:**
  - iptv-drm: `ClearKey keys in JWK form` — `parseLicenceKey('clearkey', '{"keys":[{"kty":"oct","kid":"p-YcNz4hkDPCEJH6YHvzuA","k":"dqbGXF6nYgRr10mi5jLMuw"}]}')` deep-equals `{ keys: [{ kid: 'a7e61c373e219033c21091fa607bf3b8', key: '76a6c65c5ea762046bd749a2e632ccbb' }] }`.
  - iptv-m3u: `stream_params, manifest_params, license_data and server_certificate are read` — the entry's `drm.serverCertificate === 'Q0VSVA=='`, `drm.initData === 'SU5JVA=='`, `manifestParams === 'a=1'`, `streamParams === 'b=2'`; `a second channel with the same tvg-id doesn't take the first one's key` (first keeps `tvg:<id>`, second gets the url hash).
  - iptv-plugin: `guideShift is clamped to −24…24 and nonsense is 0` (50 → 24, −99 → −24, 'x' → 0, by the programme times); `a slow guide that keeps sending isn't cut off` (injected `timeouts: { headers: 300, idle: 300 }` ms: a guide trickling a chunk every 100 ms for 1 s succeeds; one that stalls 600 ms mid-body fails with the existing "took too long" error); `programmes for guide channels no playlist channel uses aren't kept` (the refresh's `programmes` has none for the unmatched guide id).
  - live-drm-relay: `manifest and stream params are added to the provider addresses` (fake records the query: manifest `?a=1`, segment `?tk=segsecret&b=2`); the play reply carries `serverCertificate`/`initData` and no provider host.
- [ ] **Step 2: Run** `node --test test/iptv-*.test.js test/live-drm-relay.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as the tests read: JWK keys (base64url → hex); KODIPROP keys `stream_params`, `manifest_params`, `license_data`, `server_certificate`; duplicate tvg-id → url hash for later ones only; `guideShift = Number.isFinite(n) ? Math.max(-24, Math.min(24, n)) : 0`; fetch: `AbortSignal.timeout(30 s)` until headers, then an idle timer reset per chunk (30 s) — both injectable for tests; programmes filtered while read against the guide ids matched by the playlist's channels (channels come first in XMLTV); relay appends `manifestParams` to manifest fetches and `streamParams` to segment targets (`&` or `?`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Ledger line.**

### Task 5: Live TV core: TV/radio guide counts, stored names, missing channels (migration 17)

**Files:** Modify `src/db.js` (migration 17), `src/live/store.js` (`replaceChannels` ~80-85, `replaceProgrammes`, `recordRefresh` ~286, `status`, every channel query), `src/live/refresh.js` (~99-124), `src/api/live.js` (~84-101). Test: `test/live-store.test.js`, `test/live-refresh.test.js`, `test/live-api.test.js`, `test/migrations.test.js`.

**Interfaces:** Migration 17: `ALTER TABLE live_channels ADD COLUMN missing_since INTEGER; ALTER TABLE live_sources ADD COLUMN unmatched_names TEXT;`. `replaceProgrammes` returns `unmatched: { tv: string[], radio: string[] }`. `/api/live/status` source rows: `unmatched` (TV names, ≤ 50), `unmatchedRadio: { count, names (≤ 50) }`, summary "… · 8 TV channels without guide" (omitted when 0).

- [ ] **Step 1: Failing tests:**
  - migrations: m17 adds both columns.
  - live-store: `a channel missing from a refresh is hidden, not deleted` (absent from `channels()`, `guide`, search, `nowNext`, Home cards; `visibleChannel` 404); `a channel back within 7 days keeps its id and favourite`; `a channel missing for more than 7 days is deleted` (store with `now` injected).
  - live-refresh: `unmatched names are counted apart for TV and radio and survive a restart` (new refresher on the same db returns the names); `a guide where every unmatched channel is radio says nothing about a guide gap` (summary has no "without guide").
  - live-api: status shows `unmatched` TV names and `unmatchedRadio.count`; the summary reads "… · 1 TV channel without guide" for one.
- [ ] **Step 2: Run** `node --test test/live-store.test.js test/live-refresh.test.js test/live-api.test.js test/migrations.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement:** `replaceChannels` sets `missing_since = now` (if NULL) for absent rows, clears it for present ones, deletes rows with `missing_since < now − 7 days`; every channel query adds `AND missing_since IS NULL`; unmatched split by the channel's `radio` column; `recordRefresh` stores `unmatched_names` JSON and the TV count in `unmatched`; refresher reads names from the store (drop the in-memory map); summary "N TV channel(s) without guide".
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Ledger line.**

### Task 6: Live streams, limits and the live API

**Files:** Modify `src/live/stream.js` (`reserve` ~29-46, start ~95-100), `src/api/live.js` (status ~84-93), `src/library/images.js` (~51-68), `src/plugins.js` (~314-324), `src/live/refresh.js` (~15-18), `src/stream/playback.js` (`activeProcesses` ~336, `checkCapacity` ~473). Test: `test/live-stream.test.js`, `test/live-api.test.js`, `test/live-refresh.test.js`.

**Interfaces:** `LiveStreams` gains `probeCache: Map<channelKey, { at, info }>` (10 min). `plugins` `config` event carries `{ changed: string[] }`; a live source declares `refreshKeys` (IPTV Simple: playlist, guide, userAgent, numbering, startNumber, guideShift, logosPath, catchupDays).

- [ ] **Step 1: Failing tests:**
  - live-stream: `replaces naming another account's session still counts it`; `a 409 names holders only to the same profile or an admin's non-Kids profile` (Kids and another profile get "Your provider allows 1 stream at a time — another profile on your account is using it"); `a stream refused by another profile isn't preceded by stopping the caller's own streams` (the caller's open stream stays open after the 409); `a channel's probe is reused for 10 minutes` (fake source counts connections: two starts within 10 min → 1 probe; after 10 min → 2); `a start that fails with a reused probe retries once with a fresh one`; `copied live radio doesn't count toward the conversion cap` (`maxTranscodes: 1`, one radio copy open, a conversion still starts).
  - live-api: `a Kids profile's status counts only its channels`; `an image over 10 MB is refused` (fake server, content-length 11 MB → 404/502 and nothing cached; a streamed 11 MB without length → refused).
  - live-refresh: `changing Streams at once doesn't refresh; changing the guide does`.
- [ ] **Step 2: Run** `node --test test/live-stream.test.js test/live-api.test.js test/live-refresh.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as the tests read; the 409 sentence exactly as the Global Constraints; `reserve` checks `open − own + reserved >= max` before stopping anything; probe cache keyed by source+channel key; images: content-length > 10 MB → refuse, streamed size capped at 10 MB.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Ledger line.**

### Task 7: Casting

**Files:** Modify `src/cast/sessions.js` (~200-206, ~422-453), `src/cast/dlna.js` (`seek` ~214-224, start ~192-197). Test: `test/cast-live.test.js`, `test/cast-dlna.test.js`, `test/cast-sessions.test.js`.

- [ ] **Step 1: Failing tests:** cast-live `Stop on a DLNA TV's own remote during a live cast says "Stopped on Living room TV."` (mock DLNA reports STOPPED); cast-dlna `Seek faults 701 and 602 at the start fall back to a converted stream` (mock answers 701, then 602 in a second run → `fallback` path taken, start succeeds); cast-sessions `a DLNA start without libass carries the subtitle notice` (the session's `notice` equals the existing libass sentence; `GET /api/cast/sessions/current` returns it).
- [ ] **Step 2: Run** `node --test test/cast-*.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as the tests read.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Ledger line.**

### Task 8: Libraries, sign-in, playback, remote, extras

**Files:** Modify `src/api/account.js` (`needsCode` ~62), `src/auth.js` (`clientIp` ~63-69), `src/config.js` (trustProxy number), `src/library/scanner.js` (~207-214, `scanLibrary` option `prune`), `src/api/libraries.js` (or the admin libraries route file) new route, `src/stream/playback.js` (~154-160, `decide` ~90-100), `src/stream/keyframes.js:12`, `src/collections.js` (~49-55, ~140), `src/remote/progress.js` (~10-75), `src/extras/store.js` (~17-18, ~96-100, ~182), `src/extras/jobs.js` (~32-45). Test: `test/passover-server.test.js`, `test/passover-library.test.js`, `test/passover-ffmpeg.test.js`, `test/passover-keyframes.test.js`, `test/collections.test.js`, `test/remote-jellyfin.test.js`, `test/extras-store.test.js`, `test/extras-items-api.test.js`.

**Interfaces:** `POST /api/admin/libraries/:id/remove-missing` (admin): with `{ dryRun: true }` answers `{ count }`; without, prunes and answers `{ removed }`. `trustProxy` accepts `true` | integer ≥ 1 (env `TRUST_PROXY=2`).

- [ ] **Step 1: Failing tests:**
  - passover-server: `the setup code is required unless the request is loopback, addressed to localhost and unproxied` (Host `atomix.example` on loopback → code required; `trustProxy: true` → required); `trustProxy: 2 takes the second address from the right` (`X-Forwarded-For: 6.6.6.6, 1.2.3.4, 10.0.0.1` → rate-limit bucket `1.2.3.4`; a longer client-forged chain doesn't change it).
  - passover-library: `Remove missing titles prunes a library whose folder is empty` (dry run count 3, then removed 3, items gone).
  - passover-ffmpeg: `the software cap uses the displayed height of a rotated video` (coded 1920×1080 with rotation 90 is 1920 tall on screen: with a 1080 cap the ffmpeg args now contain a scale filter, where today they don't); `a binding software cap is named in reasons` ("Capped at 720p (software conversion)").
  - passover-keyframes: `a 20-s GOP is found by looking 30 s back` and `a 45-s GOP by the 60-s retry`.
  - collections: `detaching the last member deletes an emptied TMDB collection`; `a detached film no longer shows as missing in its old collection`.
  - remote-jellyfin: `the reporter forgets a session after it stops, even if a report arrives late` (map size 0; entries over 1 h pruned).
  - extras-store: `the lyrics catch-up doesn't scan again while nothing is pending until the next scan`; `the Settings lyrics count is cached for 60 s`.
  - extras-items-api: `a missing ffprobe leaves songs unchecked for lyrics`.
- [ ] **Step 2: Run** the listed files — Expected: FAIL.
- [ ] **Step 3: Implement** as the tests read.
- [ ] **Step 4: Run** the listed files, then `npm test` — Expected: PASS, whole suite green.
- [ ] **Step 5: Ledger line; version stays 0.17.1 until Plan C (v0.18.0 is set once, at the end of the round).**
