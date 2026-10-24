# Atomix Round 21 — Plan A (the tuner and pause/rewind) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One provider connection per plain Live TV channel feeds a shared 30-minute buffer; viewers watch from it with pause, rewind and a Live button.

**Architecture:** A `TunerPool` (`src/live/tuner.js`) runs one ffmpeg per channel that copies the provider stream into fragmented-MP4 HLS pieces (one folder per run, so a restart never overwrites the buffer). Atomix builds its own **dynamic DASH manifest** from the runs' playlists (`src/live/timeshift.js`, pure), served at `/api/live/tuner/:sid/…` and played by the existing `DashPlayer` in a clear (no-DRM) mode. Viewers whose browser can't play the codecs get a per-viewer conversion that reads the tuner's local playlist. `LiveStreams` counts a tuner once toward the provider's limit.

**Tech Stack:** Node ≥ 22.13, ffmpeg (≥ 5), `node:test`, Playwright devtools. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-atomix-dvr-timeshift-design.md` (sections 1, 2 and the Dashboard data of 4; its Dashboard view is Plan C's). Plans B (recording, scheduler) and C (guide actions, Recordings page, settings UI) follow.

## Global Constraints

- No dependencies. Provider URLs, headers and tokens never reach the browser. Encrypted channels never go through a tuner.
- Buffer: 30 minutes (450 pieces of 4 s), in `<data>/timeshift/<tunerId>/run-<n>/`, wiped at startup. A tuner closes 30 s after its last holder. Drops: 3 restarts in 2 minutes.
- "Unbuffered" when the codecs have no fMP4 tag in `codecTags`, or no piece appears within 10 s.
- Sentences, exactly: "Rewind isn't available on this channel"; "You were paused too long — playing from the earliest point kept"; "This channel stopped sending video."; "Lost the channel — trying again".
- Older themes pixel-identical: `node /home/claude/devtools/oldthemes-compare.mjs compare` → "all pages match".

## Deviation from the spec's wording (ruled before Task 1)

The spec names ffmpeg's `-f dash` output. ffmpeg 6.1 refuses `-c copy` from MPEG-TS into its DASH muxer without per-codec tags, and on every exit rewrites its manifest as `type="static"` (which stops the player for good) and reuses piece names on restart. The tuner therefore writes **HLS fMP4 pieces per run** (`-tag:v`/`-tag:a` per codec, `-bsf:a aac_adtstoasc` for AAC, `omit_endlist`), and Atomix builds the browser's DASH manifest itself. What the browser sees is the spec's: a dynamic DASH manifest over a 30-minute window, a period per run.

## Review Focus

1. **A second viewer joins, the first leaves, the second leaves** — one tuner throughout, closed 30 s after the second leaves, reused if someone returns within 30 s (Task 2 test).
2. **The provider drops mid-watch** — a new run starts, the manifest gains a period, the player plays across the break without "This channel stopped" (Task 2 and Task 6 checks).
3. **Another account, or a Kids profile of the same account, asking for a tuner session's manifest or pieces** — 404, never a piece (Task 4 test).
4. **Paused for longer than 30 minutes** — resumes at the oldest point with the notice, not at live and not stuck (Task 5 test with a fake clock).
5. **Fast zapping between two plain channels on a 1-stream provider** — the old channel's hold is released before the new tuner reserves, so no 409 (Task 3 test).

---

### Task 1: The buffer's pieces and the manifest (pure)

**Files:**
- Create: `src/live/timeshift.js`
- Test: `test/live-timeshift.test.js`

**Interfaces:**
- Produces:
  - `codecTags(media) → { v: string|null, a: string|null } | null` — `h264→avc1, hevc→hvc1, av1→av01, vp9→vp09`; `aac→mp4a, mp3→mp4a, ac3→ac-3, eac3→ec-3, opus→Opus`; null when a present stream has no tag (unbuffered).
  - `tunerArgs({ url, headers, media, dir, run, inputArgs }) → string[]` — `inputArgs` is the caller's `liveInputArgs(headers)`; then `-i url -map 0:v:0? -map 0:a:0? -c copy -tag:v … -tag:a … [-bsf:a aac_adtstoasc when aac] -f hls -hls_time 4 -hls_list_size 450 -hls_segment_type fmp4 -hls_fmp4_init_filename init-<run>.mp4 -hls_segment_filename <dir>/run-<run>/seg-<run>-%06d.m4s -hls_flags delete_segments+program_date_time+omit_endlist+independent_segments -master_pl_name master.m3u8 <dir>/run-<run>/index.m3u8` (audio only when `media.video` is null).
  - `parsePlaylist(text) → { init: string|null, segments: [{ uri, seq, duration, pdt }] }` (`pdt` ms since epoch; `seq` from `EXT-X-MEDIA-SEQUENCE` + index).
  - `parseCodecs(masterText) → string|null` (the `CODECS="…"` value).
  - `buildManifest({ runs, origin, now, windowSec = 1800, piecePath, timeUrl }) → string` — `runs`: `[{ run, start (ms, the run's first piece's pdt), codecs, audioOnly, pieces: [{ seq, t (ms from the run's first piece), d (ms) }] }]`; output `type="dynamic"`, `availabilityStartTime` = `origin` (ISO), `timeShiftBufferDepth="PT1800S"`, `minimumUpdatePeriod="PT4S"`, `suggestedPresentationDelay="PT8S"`, `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="<timeUrl>"/>`; one `<Period id="r<run>" start="PT<(start-origin)/1000>S">` per run with pieces inside `[now - windowSec, now]`; one AdaptationSet (`video/mp4`, or `audio/mp4` when `audioOnly`) with `codecs`, a Representation, and `SegmentTemplate timescale="1000" initialization="<piecePath>init-<run>.mp4" media="<piecePath>seg-<run>-$Number%06d$.m4s" startNumber="<first seq>"` + `SegmentTimeline` of `<S t d/>`.

- [ ] **Step 1: Write failing tests** in `test/live-timeshift.test.js`:
  - `codecTags: the fMP4 tags, null for a codec fMP4 can't carry` — `{video:{codec:'h264'},audio:[{codec:'aac'}]}` → `{v:'avc1',a:'mp4a'}`; `mpeg2video` → null; radio `{video:null,audio:[{codec:'mp3'}]}` → `{v:null,a:'mp4a'}`.
  - `tunerArgs copies with the tags, the AAC filter, a run folder and the 30-min window` — includes `-c copy`, `-tag:v avc1`, `-bsf:a aac_adtstoasc`, `-hls_list_size 450`, `-hls_time 4`, `…/run-2/seg-2-%06d.m4s`, `omit_endlist`; the provider URL appears only after `-i`.
  - `parsePlaylist reads init, sequence numbers, durations and program dates` — the fixture from the plan's probe (MEDIA-SEQUENCE 2, four 2 s pieces) → seq 2..5, pdt parsed with its `+1300` offset.
  - `buildManifest: a dynamic manifest, a period per run, only pieces in the window, no provider address` — two runs, pieces older than 30 min dropped, `Period` starts from the origin, `startNumber` = first kept seq, `t` values kept; no `http` other than `timeUrl`.
- [ ] **Step 2: Run** `node --test test/live-timeshift.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/live/timeshift.js` (string building with escaping; no XML library).
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 2: The tuner and the pool (real ffmpeg)

**Files:**
- Create: `src/live/tuner.js`
- Modify: `src/config.js` (`timeshiftDir: <data>/timeshift`, in the mkdir list), `src/app.js` (construct `core.live.tuners`, wipe `timeshiftDir` at start, `close()` in `stop()`)
- Create: `test/helpers-live.js` (`endlessProvider()` — a fakeServer whose `/live/<n>.ts` spawns `ffmpeg -re -f lavfi testsrc2 … sine … libx264 -g 48 aac -f mpegts pipe:1` until the request closes; `/__drop` makes the next stream end after 3 s; returns `{ url, requests, close }`)
- Test: `test/live-tuner.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `class TunerPool({ config, log, now = Date.now, idleMs = 30_000, firstPieceMs = 10_000 })`
  - `pool.acquire({ key, url, headers, media, label }, holder) → Promise<Tuner>` (`key` = `"source\0channel"`; one tuner per key; `holder` = `{ id, kind: 'viewer'|'recording' }`); rejects with `Object.assign(new Error('unbuffered'), { unbuffered: true })` when unbuffered (and frees the key).
  - `pool.release(holderId)`; `pool.get(key)`; `pool.list() → [{ key, label, holders: [{id, kind}], since }]`; `pool.close()`.
  - `Tuner`: `id`, `key`, `dir`, `origin` (ms), `holders: Map`, `runs: [{ run, start, codecs, audioOnly, pieces }]`, `manifest({ now, piecePath, timeUrl }) → string`, `localPlaylist() → string` (the current run's `index.m3u8` path), `piecePath(name) → string|null` (null unless `name` matches `^(init|seg)-\d+(-\d{6})?\.(mp4|m4s)$` and exists in a run folder), `on('ended', fn)`, `on('run', fn)`.
  - The tuner reads its run's `index.m3u8` (and `master.m3u8` for codecs) on a 1 s poll, appending new pieces to `runs[i].pieces` with `t` from the running sum of durations.

- [ ] **Step 1: Write failing tests** in `test/live-tuner.test.js` (endless provider; small `idleMs`/`firstPieceMs` where noted):
  - `two holders share one tuner and one provider connection` — acquire twice for the same key → same `Tuner`, `provider.requests` count 1.
  - `the tuner closes after its last holder leaves, and is reused if someone returns in time` — `idleMs: 300`; release both → after 150 ms acquire again → same id, still 1 request; release → after 600 ms `pool.get(key)` is undefined and its folder is gone.
  - `pieces appear and the manifest is dynamic with them` — after ~10 s, `tuner.manifest(...)` contains `type="dynamic"` and at least 2 `<S`.
  - `a provider drop starts run 2; the manifest gains a second period; the old pieces stay` — `/__drop`; wait; two `<Period`, run-1 folder still holds its pieces.
  - `three drops in two minutes end the tuner for every holder` — `ended` emitted with "This channel stopped sending video.".
  - `a codec without an fMP4 tag is unbuffered at once` (media `mpeg2video`) and `no piece within the limit is unbuffered` (`firstPieceMs: 1500`, a provider that sends nothing).
  - `startup wipes leftover timeshift folders` (create one, construct the app pieces, it's gone).
- [ ] **Step 2: Run** `node --test test/live-tuner.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `TunerPool`/`Tuner` (spawn with `config.ffmpegPath`, `tunerArgs` from Task 1 with `liveInputArgs(headers)`; restart into `run-<n+1>` after 1 s on an unexpected exit while held; SIGKILL and `rm -r` on close).
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 3: Counting and sharing in LiveStreams

**Files:**
- Modify: `src/live/stream.js` (`openOn`, `reserve`, `stopReplaced`, `startLive`), `src/live/drm.js` (register through the new hook lists instead of the single slots), `src/stream/playback.js` (`externalSessions` → a list)
- Test: `test/live-stream.test.js` (the `fakeStreams` harness gains a fake pool)

**Interfaces:**
- Consumes: Task 2's `TunerPool`.
- Produces:
  - Hook lists: `streams.openSources: Array<(sourceKey) => object[]>`, `streams.stoppers: Array<(id, reason) => boolean>`, `playback.externalLists: Array<(userId) => object[]>` (LiveDrm and the tuner viewers both push into them).
  - `openOn(sourceKey)` counts each **tuner** of that source once (as an object carrying the newest viewer holder's `id, userId, profileId, username, createdAt, live`), plus per-viewer playback sessions that aren't on a tuner, plus DRM sessions.
  - `startLive(...)` returns `{ session, url, media, delivery }` where `delivery` is `'dash'` (a tuner viewer), `'hls'`/`'progressive'` (converted from the buffer, or unbuffered), and the session for `'dash'` is a **tuner viewer** `{ id, userId, profileId, username, tunerKey, createdAt, lastSeen, live: { kind: 'live', sourceKey, channelId, channelName }, rewind: true }` kept in `streams.viewers: Map`.
  - `streams.viewerGet(id, user, profile)` (404 "No such stream." unless both match), `streams.viewerPing(id, user, profile)`, `streams.viewerStop(id, reason)`; idle viewers reaped after 2 minutes; stopping releases the tuner hold.
  - Radio always takes the conversion-from-buffer path (audio only; the mini player's `<audio>` plays it as today).
  - Decision: a channel is played from the tuner as `'dash'` when `playback.decide(...)` for the viewer's caps gives `mode: 'remux'` and the tuner isn't unbuffered; `'transcode'` → a conversion reading `tuner.localPlaylist()`; unbuffered → the pre-0.19 path (direct to the provider, counted as its own stream, `reasons` gets "Rewind isn't available on this channel").

- [ ] **Step 1: Write failing tests** (fakes; no ffmpeg):
  - `two viewers on one channel count as one stream` — max 1; userA and userB start channel one → both succeed, `openOn` length 1.
  - `a viewer on another channel still needs its own slot` — max 1; second channel → 409.
  - `zapping releases the old hold before the new tuner reserves (1-stream provider)` — userA on one, then start two with `replaces` = the first viewer id → succeeds, the old tuner has no holders.
  - `a viewer whose browser can't play the codecs gets a conversion from the buffer` — caps without hevc, media hevc → `delivery` `'hls'`/`'progressive'` and `playback.create` called with `source.file` = the tuner's local playlist and `live.kind` `'buffer'`.
  - `an unbuffered channel falls back to the provider and says so` — pool rejects unbuffered → `create` gets the provider URL and `reasons` includes "Rewind isn't available on this channel".
  - `radio plays from the tuner through a conversion (the music player's audio element can't play DASH)` — a radio channel → `create` gets `audioOnly: true`, `source.file` = the local playlist, `live.kind` `'buffer'`; two listeners still one tuner.
  - `viewer sessions count toward the account's 4` — four tuner viewers → the fifth start is 429 ("Too many streams open on this account.").
- [ ] **Step 2: Run** `node --test test/live-stream.test.js` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as in Interfaces; update `LiveDrm`'s constructor to push into the lists.
- [ ] **Step 4: Run** `node --test test/live-stream.test.js test/live-drm-relay.test.js test/live-api.test.js` — Expected: PASS.

### Task 4: Routes, and converting from the buffer

**Files:**
- Modify: `src/api/live.js` (play reply; `/api/live/tuner/:sid/manifest.mpd`, `/api/live/tuner/:sid/p/:file`, `/api/live/tuner/:sid/time`, `/ping`, `/stop`; Dashboard data), `src/stream/playback.js` (`buildFfmpegArgs`/`buildAudioArgs` for `live.kind === 'buffer'`), `public/js/live.js` (`sessionPath` for `'dash'` → `/api/live/tuner/${id}`)
- Test: `test/live-tuner-api.test.js` (startAtomix + endless provider + the live-test plugin with `LIVE_TEST_BASE`), `test/passover-ffmpeg.test.js`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - Play reply for a tuner viewer: `{ sessionId, delivery: 'dash', mode: 'remux', manifest: '/api/live/tuner/<id>/manifest.mpd', timeUrl: '/api/live/tuner/<id>/time', rewind: true, live: true, duration: null, start: 0, quality: 'original', reasons, channel, programme, next }`.
  - Play body `behind` (seconds, 0–1800) for a converted viewer: the conversion starts that far back (`-live_start_index -<ceil(behind/4)>`); the reply carries `behind`.
  - Buffer input args: `-protocol_whitelist file,crypto -live_start_index <n> -i <local index.m3u8>` (never `liveInputArgs`/`NETWORK_ONLY`, no `-ss`).
  - Dashboard: `/api/admin/dashboard` gains `tuners: pool.list()` shaped `[{ channel, viewers: [username], recording: null }]`.

- [ ] **Step 1: Write failing tests:**
  - `live-tuner-api`: `a plain channel plays from the tuner: a dash reply, a manifest with no provider address, pieces served` — play → `delivery 'dash'`; GET manifest → 200 `application/dash+xml`, `type="dynamic"`, no provider host; GET the first piece named in it → 200 `video/mp4`.
  - `another account or another profile gets 404 for the manifest and pieces` — guest client and the Kids profile → 404 on manifest, piece and ping.
  - `piece names outside the pattern are refused` — `p/..%2Fconfig.json`, `p/seg-1-000001.m4s.tmp` → 404.
  - `stop releases the hold; the dashboard lists the tuner while held` — dashboard `tuners` has the channel with the viewer's name; after stop and `idleMs`, it's gone.
  - `passover-ffmpeg`: `a conversion from the buffer reads the local playlist, rewound, with file-only protocols` — `buildFfmpegArgs` for `live: {kind:'buffer'}`, `behind: 60` → contains `-live_start_index -15`, `-protocol_whitelist file,crypto`, the local path after `-i`, no `-user_agent`, no `-ss`.
- [ ] **Step 2: Run** `node --test test/live-tuner-api.test.js test/passover-ffmpeg.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the routes (owner check via `streams.viewerGet`; pieces with `sendFile(..., { cacheControl: 'no-store' })` for the manifest, `max-age=60` for pieces; the time route like `LiveDrm.serveTime`) and the args.
- [ ] **Step 4: Run** `node --test test/live-*.test.js test/passover-ffmpeg.test.js test/api.test.js` — Expected: PASS.

### Task 5: DashPlayer — clear mode, seeking, the window's edge

**Files:**
- Modify: `public/js/dash/player.js` (`open` keys block; new `seek(t)`; `watch` behind-window branch; `destroy`)
- Test: `test/dash-player.test.js`

**Interfaces:**
- Produces:
  - DashPlayer with no `keySystem` = clear: no `setupKeys`; `this.keys = { close: () => Promise.resolve() }`.
  - `player.seek(t: number)` — clamps to the seekable window `[segs[0].start, liveStart]`, moves every track's `cursor` to `t` and bumps `gen` for tracks without that range buffered, sets `video.currentTime`.
  - `player.window() → { start, live, end } | null` (presentation seconds of the window's first piece, the live point, and the last piece's end) for the view's seek bar.
  - Option `onNotice(sentence)`: when the playhead falls behind the window's start (paused too long), the player seeks to the oldest piece + 1 s and calls `onNotice('You were paused too long — playing from the earliest point kept')` — no longer a jump to live.
  - `trim` keeps `KEEP_BEHIND` behind the playhead as now (rewinding re-fetches).

- [ ] **Step 1: Write failing tests** (the stubbed-player style of the existing refresh tests):
  - `a clear player opens without a key system` — `keySystem` undefined, stubbed `loadManifest`/MediaSource → `setupKeys` not called (spy via an injected option or by asserting `player.keys.close` exists and no `requestMediaKeySystemAccess` stub was touched).
  - `seek moves the cursors into the window and clamps outside it` — window 0–1800: `seek(600)` → cursors 600, `gen` bumped; `seek(-50)` → window start; `seek(5000)` → live point.
  - `paused past the window's start resumes at the oldest point with the notice` — playhead before `segs[0].start` on a tick → `currentTime` = start + 1 and `onNotice` called once with the sentence.
- [ ] **Step 2: Run** `node --test test/dash-player.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/dash-*.test.js` — Expected: PASS.

### Task 6: The player view — pause, rewind, Live

**Files:**
- Modify: `public/js/views/player.js` (`applyLive`, a `playTuner(res)` beside `playEncrypted` sharing its engine code, the live seek bar, `backBtn`/`fwdBtn` in live mode, keys, a Live button, the behind readout, title/programme at the playhead), `public/css/app.css` (the Live button and readout; nothing an older theme's existing pages show changes)
- Modify (devtools): `/home/claude/devtools/live-ui.mjs` — new section `rewind`; update the `player` section's read-only-bar checks (a ruling records each changed check)
- Test (browser): `live-ui.mjs rewind player drm`

**Interfaces:**
- Consumes: Task 4's reply, Task 5's `seek`/`window`/`onNotice`.
- Produces (view behaviour): for `delivery 'dash'` and `'drm'` sessions the seek bar spans `player.window()`; Back 10 s / Forward 30 s and ←/→ (when the bar or nothing has focus) call `seek`; Space/k pause; a **Live** button (`aria-label "Go to live"`, visible only when more than 10 s behind) and pressing the LIVE badge jump to `window().live`; behind live, `timeCur` reads `−m:ss`; the title and programme line follow `Date.now() - behindMs`; channel up/down starts the new channel live. For a converted session (`'hls'`/`'progressive'` from the buffer) Back/Forward restart the session with `behind` (Task 4); an unbuffered one keeps today's read-only bar and shows "Rewind isn't available on this channel" once as a notice.

- [ ] **Step 1: Write failing browser checks** in `live-ui.mjs` section `rewind` (dev server + mock-iptv `/live/u/p/<n>.ts`):
  - `a plain channel plays from the tuner (dash) with a seek bar over the window`;
  - `pause holds the picture, play resumes behind live, the readout says how far behind`;
  - `Back 10 s goes back ~10 s; Live returns to the live point and hides the Live button`;
  - `←/→ step within the window`;
  - `channel down starts the next channel live (no −m:ss)`;
  - `two tabs on one channel open one provider stream` (mock request count, or the Dashboard's `tuners` with two viewers);
  - `a provider drop (mock drop) keeps playing across the break`;
  - `an encrypted channel gets the same seek bar over the provider's window`.
- [ ] **Step 2: Run** `node /home/claude/devtools/live-ui.mjs rewind` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node /home/claude/devtools/live-ui.mjs` (all sections), `node /home/claude/devtools/a11y-ui.mjs`, `node /home/claude/devtools/oldthemes-compare.mjs compare`, and `npm test` — Expected: ALL PASS, "all pages match", npm green.
