# Atomix encrypted Live TV — plan B (browser engine, Live TV player, pretend provider, v0.17.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypted channels play in the browser: a hand-rolled DASH + MSE + EME engine plays what plan A's relay serves, the Live TV player uses it for `delivery: 'drm'` replies (zapping, pings, quality, errors), the UI marks encrypted channels and hides Cast for them, and a pretend ClearKey provider lets the whole path be checked in a headless browser.

**Architecture:** `public/js/dash/eme.js` asks the browser's own key system for keys and relays licence messages to `/api/live/drm/:sid/licence`; `public/js/dash/player.js` (`DashPlayer`) drives one MediaSource with a SourceBuffer per video/audio track from plan A's pure modules (`mpd`, `timeline`, `abr`). Each module splits into small pure helpers (Node-tested) and a thin browser part (checked by `live-ui.mjs`). `devtools/mock-iptv.mjs` gains three ClearKey DASH channels from VP9/Opus segments encrypted once with MP4Box, looped with rewritten decode times.

**Tech Stack:** Plain ES modules in the browser (MSE, EME), Node ≥ 22.13 tests, Playwright Chromium for browser checks (no H.264, no Widevine: ClearKey with VP9/Opus), ffmpeg + MP4Box as cloud-only dev tools.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-live-drm-design.md` (§3 browser modules, §4 errors, §5 testing). Plan A: `docs/superpowers/plans/2026-10-10-atomix-live-drm-a.md` and its ledger (fix-pass `Final:` lines).

## Global Constraints

- No dependencies; no build step. `eme.js`/`player.js` may touch the DOM only through the `video` element passed in and `MediaSource`/`navigator.requestMediaKeySystemAccess`.
- The page only ever requests Atomix addresses (`/api/live/drm/<sid>/…`); nothing in the page names a provider host.
- No DRM circumvention: keys come only from the browser's own key system and the licence the provider (or the playlist's ClearKey keys, via Atomix) gives it. Widevine robustness `SW_SECURE_CRYPTO`.
- Error sentences exactly: "This browser can't play encrypted channels (it has no Widevine)", "The provider refused this channel's licence", "The licence server isn't answering", "The playlist doesn't have the key for this channel", "This channel's stream couldn't be read", "This channel's protection won't play in this browser", "This channel is encrypted, so it can't be cast".
- Buffer: keep 10–30 s ahead; remove more than 30 s behind the playhead; manifest re-read every `max(2 s, minimumUpdatePeriod)`; a stall over 4 s or a playhead behind the window jumps to the live edge; a segment fails → 3 retries, then skipped.
- Older themes pixel-identical (`oldthemes-compare.mjs compare` → "all pages match"); the lock badge and engine add no change to non-encrypted pages.
- Version `0.17.0` everywhere the version is shown (package.json, About, docs).

## Review Focus

1. **Zapping across engines** — encrypted → plain → encrypted in quick presses: exactly one session open at the end, the old MediaSource/MediaKeys freed, no `video.src` left pointing at a stopped session (Task 4 browser check + `zapQueue` stale-stop through the right route, Task 4 unit test).
2. **A live manifest that changes under the player** — refreshes that add segments, drop old ones, or change the representation list: the next segment is found by number/time, never re-appended or skipped silently (Task 2 `nextSegment` tests).
3. **The buffer near a quota** — `QuotaExceededError` on append: trim behind, retry once, never loop (Task 2 `trimRanges` test + engine code).
4. **Key failures** — a refused licence, a missing key, `output-restricted`: one sentence, playback stopped, the session stopped (Task 1 `licenceError` tests, Task 5 browser check for refusal).
5. **Clock skew** — a page clock minutes off the server's: the live edge from `/time` (`clockOffset`), not `Date.now()` (Task 2 `liveStart` test with a skewed clock).

---

### Task 1: `eme.js` — the browser's key system, licences relayed

**Files:**
- Create: `public/js/dash/eme.js`
- Test: `test/dash-eme.test.js`

**Interfaces:**
- Consumes: plan A's `parseMpd` output (`adaptationSets[].contentProtection: [{ system, kid, pssh }]`, `representations[].codecs/mimeType`).
- Produces (pure, exported): `keySystemConfigs(keySystem, { video: [{mimeType, codecs}], audio: [...] }) → MediaKeySystemConfiguration[]`; `initDataFor(keySystem, contentProtection) → [{ initDataType: 'cenc'|'keyids', initData: Uint8Array }]`; `licenceError(status, serverSentence) → string`; `keyStatusError(statuses) → string|null`.
- Produces (browser): `async setupKeys(video, { keySystem, licenceUrl, contentProtection, video: [...], audio: [...], fetch = globalThis.fetch }) → { close() }`, throwing `Error` with one of the sentences.

- [ ] **Step 1: Write the failing tests** (`test/dash-eme.test.js`)
  - `keySystemConfigs('com.widevine.alpha', { video: [{ mimeType: 'video/mp4', codecs: 'avc1.4d401f' }], audio: [{ mimeType: 'audio/mp4', codecs: 'mp4a.40.2' }] })` deep-equals `[{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.4d401f"', robustness: 'SW_SECURE_CRYPTO' }], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' }], persistentState: 'optional', distinctiveIdentifier: 'optional', sessionTypes: ['temporary'] }]`; ClearKey: `initDataTypes: ['keyids', 'cenc']`, no `robustness` keys; duplicate codecs listed once.
  - `initDataFor('com.widevine.alpha', [{ system: 'widevine', pssh: '<base64 box>' }, { system: 'cenc', kid: KID }])` → one `{ initDataType: 'cenc', initData }` whose bytes equal the decoded pssh; two identical pssh → one entry.
  - `initDataFor('org.w3.clearkey', [{ system: 'cenc', kid: 'a7e61c373e219033c21091fa607bf3b8' }])` → `{ initDataType: 'keyids', initData }` with `JSON.parse(text) === { kids: ['p-YcNz4hkDPCEJH6YHvzuA'] }` (base64url); none → `[]` (the `encrypted` event supplies it).
  - `licenceError(403, "The provider refused this channel's licence")` → that sentence; `licenceError(403, "The playlist doesn't have the key for this channel")` → that sentence; `licenceError(502)` → "The licence server isn't answering"; `licenceError(0)` (network) → same.
  - `keyStatusError(new Map([['k', 'output-restricted']]))` and `'internal-error'` → "This channel's protection won't play in this browser"; `'usable'` → `null`.
- [ ] **Step 2: Run** `node --test test/dash-eme.test.js` — Expected: FAIL, cannot find module `eme.js`.
- [ ] **Step 3: Implement** the pure helpers and `setupKeys`: `requestMediaKeySystemAccess(keySystem, keySystemConfigs(...))` (rejection → "This browser can't play encrypted channels (it has no Widevine)" for Widevine; "This channel's protection won't play in this browser" for ClearKey), `createMediaKeys`, `video.setMediaKeys`; one `createSession('temporary')` per `initDataFor` entry, plus `video` `encrypted` events (deduplicated by initData bytes); each session's `message` → `fetch(licenceUrl, { method: 'POST', body: message, headers: { 'content-type': 'application/octet-stream' }, credentials: 'same-origin' })` → non-OK: read `{error}` JSON → throw `licenceError` through an `onError` callback → `session.update(bytes)`; `keystatuseschange` → `keyStatusError`. `close()` closes sessions and calls `video.setMediaKeys(null)` (ignore its rejection).
- [ ] **Step 4: Run** `node --test test/dash-eme.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** (Dallas commits on his PC; here: ledger line).

### Task 2: `player.js` — `DashPlayer`

**Files:**
- Create: `public/js/dash/player.js`
- Test: `test/dash-player.test.js`

**Interfaces:**
- Consumes: `parseMpd`, `segmentsAt`, `liveEdge`, `clockOffset` (timeline.js), `pickRepresentation` (abr.js), `setupKeys` (Task 1).
- Produces (pure, exported): `nextSegment(segments, last) → segment|null` (`last` = `{ number, time }` of the last appended, or null); `trimRanges(buffered: [[start,end]...], currentTime, keepBehind = 30) → [[start,end]...]` (what to remove); `liveStart(mpd, segments, offsetMs) → seconds`; `periodToPlay(mpd) → period` (first with video).
- Produces (browser): `class DashPlayer` — `new DashPlayer(video, { manifest, licence, keySystem, timeUrl, onError(sentence), onLevels(levels: [{ id, height, bandwidth }]), onStall(bool) })`, `async start()`, `setLevel(id | 'auto')`, `get level()`, `destroy()`.

- [ ] **Step 1: Write the failing tests** (`test/dash-player.test.js`)
  - `nextSegment`: with `last = null` → `null` handled by caller (`liveStart`), so `nextSegment(segs, null)` → first segment; `last = { number: 5 }` and the list now `[4,5,6,7]` → 6; list refreshed to `[8,9]` (5 and 6–7 aged out) → 8 (jump, not stall); `$Time$` list (`number` undefined in comparison: matches on `time`) → the segment after `last.time`; nothing newer → `null`.
  - `trimRanges([[0, 100]], 80, 30)` → `[[0, 50]]`; `[[0, 20]]`, 15 → `[]`; two ranges `[[0,10],[40,100]]`, 90 → `[[0,10],[40,60]]`.
  - `liveStart(mpd, segs, offsetMs)`: equals `liveEdge(mpd, segs)` for static (0 from the first segment) and live; a skewed page clock (offset +120 000) gives the same start as an unskewed one when `segs` came from `segmentsAt(..., Date.now() + offset)` (assert both computed from the same corrected now).
  - `periodToPlay`: an audio-only first period and a video second → the second.
- [ ] **Step 2: Run** `node --test test/dash-player.test.js` — Expected: FAIL, cannot find module.
- [ ] **Step 3: Implement** the pure helpers, then `DashPlayer`:
  - `start()`: GET `timeUrl` once → `offset = clockOffset(text, Date.now())`; fetch + `parseMpd(manifest)`; `periodToPlay`; video reps from that period's video AdaptationSet, audio from the first audio set (prefer the browser's language); `onLevels`; `setupKeys` with the period's `contentProtection` (video set's, else audio's); `MediaSource` + `URL.createObjectURL`; on `sourceopen`: `addSourceBuffer(\`${mimeType}; codecs="${codecs}"\`)` per track; `sb.timestampOffset = period.start - (presentationTimeOffset / timescale)`; `mediaSource.duration = Infinity` for dynamic (`setLiveSeekableRange` when present); append init, then segments from `liveStart`; set `video.currentTime` to it.
  - The loop (per track, `requestAnimationFrame`-free `setTimeout` 250 ms): when buffered ahead < 30 s fetch `nextSegment` (an `AbortController` per fetch; `destroy()` aborts all); throughput = bytes/elapsed (EWMA 0.3) → `pickRepresentation(videoReps, { throughputBps, bufferedSec, maxHeight: video.clientHeight * devicePixelRatio, current })` unless a level is set; a switch appends the new rep's init first; append waits for `updateend`; `QuotaExceededError` → `remove(trimRanges(…, 10))` then retry once, else `onError(UNREADABLE)`.
  - Every `max(2, minimumUpdatePeriod)` s (dynamic): re-fetch + re-parse; keep current rep by id (gone → `pickRepresentation` afresh).
  - Every 5 s: `trimRanges` → `sb.remove`. Stall (`waiting` with no `currentTime` progress for 4 s) or `currentTime < first segment start` → seek to `liveStart`; `onStall(true/false)` around waits.
  - Segment failure: 3 retries (0.5, 1, 2 s), then skip to `nextSegment` after it; 4 consecutive skips → `onError("This channel's stream couldn't be read")`. Manifest re-read failing 3 times in a row → same.
  - `destroy()`: stop timers, abort fetches, `mediaSource.endOfStream()` guarded, `URL.revokeObjectURL`, `video.removeAttribute('src')`, `video.load()`, `keys.close()`.
- [ ] **Step 4: Run** `node --test test/dash-player.test.js test/dash-timeline.test.js test/dash-abr.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** (ledger line).

### Task 3: The pretend provider plays ClearKey DASH

**Files:**
- Create: `/home/claude/devtools/make-drm-media.mjs`, output `/home/claude/devtools/media/drm/` (init + 5 segments per track, 2 s each)
- Modify: `/home/claude/devtools/mock-iptv.mjs`
- Test: `/home/claude/devtools/drm-smoke.mjs` (a Playwright check of the mock alone, through a tiny page that uses `DashPlayer` directly)

**Interfaces:**
- Produces: playlist channels 14 "Secure One" (`license_type=org.w3.clearkey`, `license_key=<BASE>/lic/ck`), 15 "Secure Two" (`license_key=<KID>:<KEY>` inline), 16 "Secure Refused" (`license_key=<BASE>/lic/refuse`), group `Entertainment`, `manifest_type=mpd`; `/dash/<n>/live.mpd` dynamic, `availabilityStartTime` = mock start, `SegmentTemplate` `$Number$` duration 2 s, `timeShiftBufferDepth=PT30S`, `minimumUpdatePeriod=PT4S`, `cenc:default_KID`; `/dash/<n>/<track>/<k>.m4s` = file `((k-1) % 5) + 1` with its `tfdt` baseMediaDecodeTime set to `(k-1) × 2 × timescale` and `mfhd` sequence = k; `/lic/ck` answers the ClearKey JSON request with the JWK for KID; `/lic/refuse` → 403.
- Same KID/KEY as plan A's tests: `a7e61c373e219033c21091fa607bf3b8` / `76a6c65c5ea762046bd749a2e632ccbb`.

- [ ] **Step 1: Write the failing check** `drm-smoke.mjs`: open the dev server's `/` (logged in), import `/js/dash/player.js` in the page, play channel 14 through `POST /api/live/channels/<id>/play`, assert `video.currentTime` passes 12 s within 20 s (crosses the 10 s loop), no `error`, and every request URL the page made starts with the dev server's origin.
- [ ] **Step 2: Run** `node /home/claude/devtools/drm-smoke.mjs` — Expected: FAIL (channel 14 doesn't exist).
- [ ] **Step 3: Implement** `make-drm-media.mjs` (ffmpeg `testsrc2` + clock text 10 s, `libvpx-vp9` keyframe every 2 s, `libopus`, fragmented MP4; `MP4Box -crypt drm.xml` (cenc, KID/KEY above); `MP4Box -dash 2000 -rap -profile live -segment-name '$RepresentationID$/$Number$'`), then the mock routes; the `tfdt`/`mfhd` rewrite walks `moof` → `mfhd`/`traf` → `tfdt` boxes (32/64-bit by version) in a copy of the file bytes.
- [ ] **Step 4: Run** `node /home/claude/devtools/make-drm-media.mjs && bash /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/drm-smoke.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** (devtools are cloud-only: ledger line).

### Task 4: The Live TV player and UI use the engine

**Files:**
- Modify: `public/js/views/player.js`, `public/js/views/live.js`, `public/js/views/guide.js`, `public/css/*.css` (the theme files that style `.live-row`/guide cells — a `.live-lock` rule only), `public/js/live.js` (home of `zapQueue`)
- Test: `test/live-client.test.js` (the existing tests of `public/js/live.js`, extended), `/home/claude/devtools/live-ui.mjs` section `drm`

**Interfaces:**
- Consumes: `DashPlayer` (Task 2); play reply `{ delivery: 'drm', sessionId, manifest, licence, keySystem, … }` (plan A); `/api/live/drm/:sid/ping|stop|time`.
- Produces: `sessionPath(res) → '/api/live/drm/<sid>' | '/api/playback/<sid>'` exported from `public/js/live.js` and used for every ping/stop in the player (including `zapQueue`'s `onStale` and leaving the page).

- [ ] **Step 1: Write the failing tests**
  - `test/live-client.test.js`: `sessionPath({ sessionId: 'a', delivery: 'drm' })` → `/api/live/drm/a`; `{ sessionId: 'b', delivery: 'hls' }` → `/api/playback/b`.
  - `live-ui.mjs` section `drm` (runs against the dev server + mock): (1) the Live TV list shows a lock labelled "Encrypted" on Secure One/Two/Refused and on no other row; the guide row too; (2) pressing Secure One plays — `currentTime` advances 6 s, the mode badge reads "Encrypted", no error; (3) Cast is hidden in the controls and in the "…" sheet and on the row's menu ("Cast to…" absent); (4) Quality lists "Auto" plus the levels; (5) zap Secure One → TVNZ 2 → Secure Two with quick presses: plays, `GET /api/admin/dashboard` lists exactly one session for dallas; (6) Secure Refused shows "The provider refused this channel's licence" with Back; (7) every request the page made during the section went to the dev server's origin; (8) 390 px wide: controls fit, no horizontal scroll; (9) no console errors.
- [ ] **Step 2: Run** `node --test test/live-client.test.js` and `node /home/claude/devtools/live-ui.mjs drm` — Expected: FAIL (`sessionPath` missing; no lock; Secure One doesn't play).
- [ ] **Step 3: Implement**
  - `applyLive(res)`: if `res.delivery === 'drm'`: destroy any previous `DashPlayer`, `video.removeAttribute('src')`, mode badge `icon('lock')` + "Encrypted" (`dataset.mode = 'encrypted'`), `new DashPlayer(video, { manifest: res.manifest, licence: res.licence, keySystem: res.keySystem, timeUrl: \`${sessionPath(res)}/time\`, onError: (t) => { stopSession(); showError(t); }, onLevels, onStall: (on) => (spinnerEl.hidden = !on) })`, `start()`; else destroy any `DashPlayer` and set `video.src` as today. `reconnect()` returns false for drm sessions (the engine retries itself). Leaving the page / `destroyed` → `dash?.destroy()`.
  - Pings and stops: `sessionPath(session)` everywhere `/api/playback/${sid}/…` is used for TV sessions.
  - Quality menu for drm: "Auto" + each level (`${height}p`, sorted high → low) → `dash.setLevel`; the existing QUALITIES list otherwise.
  - Cast: `castBtn.hidden`, the "…" sheet entry and the row/Channels-overlay "Cast to…" hidden when the channel's `drm` is set.
  - Lock: `live.js` rows and `guide.js` channel cells append `h('span', { class: 'live-lock', title: 'Encrypted' }, icon('lock', { size: 14, label: 'Encrypted' }))` when `c.drm`; `rowName` appends ", encrypted".
- [ ] **Step 4: Run** `node --test test/live-client.test.js && node /home/claude/devtools/live-ui.mjs && node /home/claude/devtools/oldthemes-compare.mjs compare` — Expected: PASS, every live-ui section (old and `drm`) passing, "all pages match".
- [ ] **Step 5: Commit** (ledger line).

### Task 5: Docs, version 0.17.0, pictures

**Files:**
- Modify: `package.json`, `README.md`, `ARCHITECTURE.md`, `PLUGINS.md`, the About version source, `/home/claude/devtools/v017-shots.mjs` (new, from `v016-shots.mjs`)
- Test: `npm test` (whole suite), `rebrand-ui.mjs` (version shown), `live-ui.mjs`

- [ ] **Step 1:** Update `rebrand-ui.mjs`'s expected version to `0.17.0`; run it — Expected: FAIL (shows 0.16.0).
- [ ] **Step 2:** Bump the version; README "Live TV" gains an "Encrypted channels" paragraph (Widevine/ClearKey DASH from Kodi-style playlists, played by the browser's own key system; Chrome/Edge/Firefox, not Safari; can't be cast, recorded or played as radio); ARCHITECTURE gains `src/live/drm.js` and `public/js/dash/`; PLUGINS documents the `stream()` reply's `drm`, `manifestHeaders`, `streamHeaders`.
- [ ] **Step 3: Run** `bash /home/claude/devtools/restart-dev.sh && node /home/claude/devtools/rebrand-ui.mjs && npm test` — Expected: PASS, suite all green.
- [ ] **Step 4:** `v017-shots.mjs`: desktop and phone shots of an encrypted channel playing (lock badge, Quality menu open) → `v0170-desktop.png`, `v0170-phone.png` composite.
- [ ] **Step 5: Commit** (ledger line).
