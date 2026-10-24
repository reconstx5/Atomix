# Atomix v0.15.0 passover — Plan A (server and video) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the server-side and ffmpeg findings of the passover audit: no token leaks on redirects, a setup code that holds behind a proxy, capped and de-duplicated ffmpeg work, no accidental library wipes, faster hot paths, and a transcoder that shows HDR correctly, keeps dialogue audible, starts in a second and seeks honestly.

**Architecture:** Changes stay inside the existing modules: `src/remote/provider.js` (redirect policy), `src/auth.js`/`src/api/account.js` (client IP, setup code), `src/stream/subtitles.js` + `src/extras/*` (extraction as a job), `src/library/scanner.js` (prune guard), `src/db.js` (migration 14), `src/picks.js`, `src/stream/playback.js` (`decide`, `buildFfmpegArgs`, capacity, keyframe lookup), `src/library/probe.js` (summary fields, tool detection). No new modules except `src/stream/keyframes.js`.

**Tech Stack:** Node ≥ 22.13, node:http, node:sqlite, node:test, ffmpeg/ffprobe via `spawn`. Zero dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-atomix-passover-design.md` (§1 and §2).

## Global Constraints

- Node ≥ 22.13; no dependencies; plain `spawn(bin, argv)` (no shell).
- Tokens travel in headers, never in browser-visible URLs (`?cast=` excepted). No route returns `servers.secret`/`extra`.
- Nothing leaves the server except plex.tv, connected servers, local cast devices, LRCLIB, the YouTube embed.
- Kids profiles never see unrated/adult content or admin data; admin-only routes stay admin-only.
- Error copy is sentence case, plain words, as in the spec (verbatim strings below).
- Full suite: `cd /home/claude/nodeflix && npm test` (≈3 min; redirect to a file). Per-file: `node --test test/<file>`.

## Review Focus

1. **A connected server behind a redirecting load balancer.** A same-origin 302 (http→https on the same host counts as another origin: scheme differs) must fail with the "didn't answer" shape, not hang or loop; the viewer's library stays as it was. Pinned in Task 1.
2. **A library on a USB drive that is unplugged, then plugged back in.** Scan with the drive out: nothing pruned, a warning shows; scan with it back: the warning clears and nothing is re-added as new (progress intact). Pinned in Task 3.
3. **A film whose probe predates v0.15.0** (no `rotation`/`dolbyVision`/`defaultAudio` fields). `decide`/`buildFfmpegArgs`/previews/intros must treat the missing fields as "none"/0 and not throw. Pinned in Task 5.
4. **An HDR film on a Chromecast with an ffmpeg that has neither zscale nor libplacebo.** The viewer gets the 422 sentence in the player and the cast pill, not a grey picture or a hang. Pinned in Task 6.
5. **A remux seek near the end of the file** (within 10 s of the end, or at exactly a keyframe). The keyframe lookup returns a time ≤ start and never a time past the end; ffprobe failure falls back to the requested start. Pinned in Task 7.

---

### Task 1: Redirect policy, setup code behind a proxy, rate-limit hop, body timeout

**Files:**
- Modify: `src/remote/provider.js:53-60` (`request`), `src/remote/plextv.js:95-114` (`chooseConnection`)
- Modify: `src/auth.js:63-69` (`clientIp`)
- Modify: `src/api/account.js:62, 103` (`needsCode`, code compare)
- Modify: `src/http/router.js:112-127` (`readBody`)
- Test: `test/remote-provider.test.js` (new), `test/api.test.js` (existing — add the sign-in/rate-limit and setup-code cases)

**Interfaces:**
- Consumes: `fetchFollowing(url, { headers, method, signal, sameOriginOnly, max })` (provider.js:27).
- Produces: `auth.clientIp(req)` unchanged signature; `needsCode(req)` semantics per spec; `readBody(req, limit, { timeoutMs = 30000 })`.

- [ ] **Step 1: Write the failing tests**

`test/remote-provider.test.js`:
```js
test('a connected server that redirects to another origin never sees the token there', async () => {
  // server A: 302 → http://127.0.0.1:<B>/x ; server B records headers
  // provider.request(serverA, '/api/x', { headers: { 'X-Emby-Authorization': 'secret' } })
  assert.rejects(..., (e) => e.status === 502 && /didn't answer/.test(e.message));
  assert.equal(seenByB.length, 0);
});
test('a same-origin redirect is followed with the headers', ...); // A: 302 → /y on A; /y sees the header; result ok
```
`test/api.test.js` additions:
```js
test('with trustProxy the client IP is the last forwarded hop', () => { // '1.1.1.1, 10.0.0.2' → '10.0.0.2'
test('a 30 s body timeout rejects a slow body with 408', ...); // readBody(req, 1e6, { timeoutMs: 50 }) with a req that never ends
```
`test/api.test.js` (setup) additions:
```js
test('first-run setup from loopback behind a proxy header needs the code', ...); // socket 127.0.0.1 + x-forwarded-for → setupCodeRequired true, POST without code → 403
test('the setup code compare is constant-time and case-insensitive', ...); // wrong length → 403, right code lower-case → 200
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/remote-provider.test.js test/api.test.js`
Expected: FAIL — token seen by B; first hop returned; no timeout; setup succeeds without code.

- [ ] **Step 3: Implement**

`provider.js` `request()`: replace the `fetch(url, {..., redirect: 'follow'})` call with `fetchFollowing(url, { method, headers: {...}, body, signal, sameOriginOnly: true })` (extend `fetchFollowing` to accept `body` and pass it only on the first hop and on 307/308); map `ECROSSORIGIN`/`EREDIRECT` to the existing 502 "<server> didn't answer" path. `plextv.js` `chooseConnection`: `fetch(..., { redirect: 'manual' })`; a 3xx counts as a failed try. `auth.clientIp`: `.split(',').at(-1).trim()`. `account.js`: `const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']; const needsCode = (req) => !isLoopback(req.socket.remoteAddress) || PROXY_HEADERS.some((h) => req.headers[h]);` and compare with `crypto.timingSafeEqual` after upper-casing and length check. `readBody(req, limit, { timeoutMs = 30000 } = {})`: a timer that rejects `HttpError(408, 'Request body took too long')` and destroys the socket; cleared on end/error.

- [ ] **Step 4: Run the tests**

Run: `node --test test/remote-provider.test.js test/api.test.js test/remote-api.test.js test/plextv.test.js`
Expected: PASS.

- [ ] **Step 5: Ledger** `Task 1: complete` with the command and result.

---

### Task 2: Subtitle extraction — validated, de-duplicated, capped, and a background job

**Files:**
- Modify: `src/stream/subtitles.js:155-196` (`getSubtitleVtt` embedded branch)
- Modify: `src/api/library.js` (the `e<N>.vtt` route; 404 on a bad index)
- Modify: `src/stream/playback.js:236-244, 318-322` (`activeProcesses()`, `checkCapacity` counts every `proc`; export a `pool` the extraction uses)
- Modify: `src/extras/store.js` (`nextSubtitleItem(only)`, `pendingCounts().subtitles`), `src/extras/jobs.js` (`subtitles(item, ctx)`), `src/tasks.js:125-145, 165` (job `subtitles` after `lyrics`; idle gating includes pending lyrics/subtitles)
- Modify: `src/api/playback.js:37` (4-session cap per user)
- Test: `test/subtitles-embedded.test.js` (new), `test/tasks.test.js`, `test/playback.test.js`

**Interfaces:**
- Produces: `playback.activeProcesses()` → number of sessions with a live `proc`; `playback.extractionSlot()` → `{ release() }` or throws `HttpError(503, 'Busy converting other videos; try again in a moment.')`; `store.nextSubtitleItem(only)` → an item row with `media.subtitles` text entries and no `tags.subtitlesExtracted`; `jobs.subtitles(item)` writes the cache files and sets `tags.subtitlesExtracted: true`.
- Consumes: `TaskRunner.next()` pick order (intros → previews → thumb → lyrics → subtitles).

- [ ] **Step 1: Write the failing tests**

`test/subtitles-embedded.test.js` (uses the dev media file with an embedded text subtitle from `test/helpers`; skip when ffmpeg is missing):
```js
test('e<N>.vtt 404s for an index the probe does not list', ...); // GET /api/items/:id/subtitles/e99.vtt → 404
test('two concurrent requests for the same embedded track run one ffmpeg', ...); // count spawns via a counting ffmpegPath shim → 1
test('extraction over the transcode cap answers 503 with the busy sentence', ...);
test('the subtitles job writes the cache and marks the item', ...); // jobs.subtitles(item) → cache file exists, tags.subtitlesExtracted true
```
`test/tasks.test.js`: expected status shape gains `queued.subtitles: 0`; `next()` returns a `subtitles` task when lyrics are done; the runner does not idle when previews/intros are off but subtitles are pending.
`test/playback.test.js`: `checkCapacity` throws when `maxTranscodes` remux sessions have a `proc`; a user's 5th `create` → 429 `'Too many streams open on this account.'`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/subtitles-embedded.test.js test/tasks.test.js test/playback.test.js`
Expected: FAIL (route 200s with empty VTT / spawns twice / no 503 / no job / shape mismatch).

- [ ] **Step 3: Implement**

`getSubtitleVtt`: validate `index` against `item.media.subtitles` (text ones) → `null` (route 404s); module-level `inflight = new Map()` keyed by cacheFile returning the same promise; take `playback.extractionSlot()` around `run()`. `playback.extractionSlot()`: if `activeProcesses() + this.extractions >= max` throw 503; else `this.extractions++` and return `{ release }`. `checkCapacity`: `if (this.activeProcesses() >= max) throw 503 (existing sentence)` for every mode that spawns (`mode !== 'direct'`). `store.nextSubtitleItem`: `SELECT ... WHERE kind IN ('movie','episode') AND json_extract(media,'$.subtitles') IS NOT NULL AND json_extract(tags,'$.subtitlesExtracted') IS NULL AND path NOT LIKE 'remote:%'` with a JSON check for at least one text codec. `jobs.subtitles`: for each text sub call `getSubtitleVtt`; then `UPDATE items SET tags = json_set(tags,'$.subtitlesExtracted',true)`. `tasks.js`: pick `subtitles` after `lyrics`; idle only when `!previewsEnabled && !introDetection && pendingCounts().lyrics === 0 && pendingCounts().subtitles === 0`; `pendingCounts()` gains `subtitles`; Settings background line (plan B keeps copy) reads "N titles waiting for a subtitle check". `api/playback.js`: count live sessions for `ctx.user.id`; ≥ 4 → `HttpError(429, 'Too many streams open on this account.')`.

- [ ] **Step 4: Run the tests** — Expected: PASS for the three files plus `test/extras-items-api.test.js`.
- [ ] **Step 5: Ledger** `Task 2: complete`.

---

### Task 3: Prune guard, migration 14, `nextUpFor`, DLNA poll overlap

**Files:**
- Modify: `src/library/scanner.js:190-205, 239` (empty-root guard, `status.warning`)
- Modify: `src/db.js:377-390` (migration 14), `src/library/queries.js:198-230` (`nextUpFor(viewer, showId)`), `src/api/library.js:287`
- Modify: `src/cast/dlna.js:200-205` (`refresh` skips when in flight)
- Test: `test/extras-scan.test.js` (add the prune-guard case), `test/migrations.test.js` (add), `test/api.test.js` (add nextUpFor), `test/cast-dlna.test.js` (add)

**Interfaces:**
- Produces: `scanner.status.warning: string | null`; `queries.nextUpFor(viewer, showId)` → episode row or null (same shape as `nextUp` rows); migration 14 indexes `progress_item`, `sessions_profile`.

- [ ] **Step 1: Write the failing tests**

```js
test('a root that is a directory but yields no files keeps its titles and warns', ...); // mkdir root, scan → items; move files out → scan → items still there, status.warning matches /looks empty/; move back → scan → warning null, item ids unchanged
test('migration 14 adds the progress and sessions indexes', ...); // EXPLAIN QUERY PLAN DELETE FROM progress WHERE item_id = ? → /progress_item/
test('nextUpFor finds the next episode of one show with two queries', ...); // compare with nextUp(viewer, 50).find(...)
test('a DLNA refresh in flight is not stacked by the next tick', ...); // fake TV delays GetTransportInfo 800 ms, pollMs 100 → ≤ 2 SOAP calls in 1 s
```

- [ ] **Step 2: Run to verify failure** — Run the four files. Expected: FAIL (items pruned; no index; nextUpFor undefined; 8+ SOAP calls).
- [ ] **Step 3: Implement**

scanner: after `walk`, `if (files.length === 0 && this.db.get('SELECT 1 FROM items WHERE library_id = ? AND path LIKE ? LIMIT 1', lib.id, root + '%')) { reachable.splice(reachable.indexOf(root), 1); warnings.push(`${root} looks empty — not removing its titles`); log.warn(...) }`; `this.status.warning = warnings.join('; ') || null` at scan end. db.js: append `CREATE INDEX IF NOT EXISTS progress_item ON progress(item_id); CREATE INDEX IF NOT EXISTS sessions_profile ON sessions(profile_id);` as migration 14 with a comment. queries: `nextUpFor` = the `last` + `next` queries of `nextUp` for one `show_id`. dlna: `if (this.refreshing) return; this.refreshing = true; try { ... } finally { this.refreshing = false; }`.

- [ ] **Step 4: Run the tests** — Expected: PASS (+ `test/cast-sessions.test.js`).
- [ ] **Step 5: Ledger** `Task 3: complete`.

---

### Task 4: Picks, capacity for remux, static caching, kids/admin leaks, URL refusal, settings enums

**Files:**
- Modify: `src/picks.js:54-57` (column list, profile cache), `src/app.js:98` (remove the lists hook), `src/app.js:194-200` (Cache-Control split)
- Modify: `src/api/account.js:73-77`, `src/api/library.js:179`, `src/api/lists.js:82-90`
- Modify: `src/api/servers.js` (`normaliseUrl`, `isSelf`), `src/cast/devices.js:336-341` (`httpUrl`), shared helper `isPrivateTarget(url)` in `src/http/net.js` (new, ~20 lines)
- Modify: `src/api/admin.js:76-110` (enum validation), `src/settings.js` (`maxSoftwareHeight: 1080` default — used in Task 6)
- Test: `test/picks.test.js`, `test/api.test.js` (static caching, /api/status, /api/scan/status, settings enums), `test/lists-api.test.js` (collection image), `test/remote-api.test.js` (server URL refusal), `test/cast-discovery.test.js` (DLNA address refusal)

**Interfaces:**
- Produces: `isPrivateTarget(urlString)` → true for loopback, link-local (169.254/16, fe80::/10), `0.0.0.0`, `::`; `settings.maxSoftwareHeight` (number, one of 720/1080/1440/2160).

- [ ] **Step 1: Write the failing tests**

```js
test('candidates select only the scoring columns', ...); // spy db.all → SQL has no "i.*"
test('a playlist change does not clear the picks cache', ...);
test('index.html is no-cache and assets are max-age=3600', ...); // GET /index.html, GET /js/app.js
test('/api/status omits servers for a kids profile on an admin account', ...);
test('/api/scan/status is a stub for viewers', ...); // non-admin → { running } only
test('a kid cannot fetch the poster of a collection they cannot see', ...); // 404
test('adding a server or DLNA device at a loopback/link-local address is refused', ...); // 400 'That address points at this server or a private network.'
test('settings reject an unknown hwAccel, x264Preset or a relative vaapiDevice', ...); // 400
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL on each.
- [ ] **Step 3: Implement** per spec §1 (verbatim sentences: `'That address points at this server or a private network.'`, `maxSoftwareHeight` validated to the four values).
- [ ] **Step 4: Run the tests** — Expected: PASS; then `npm test > scratch/t4.log` → all pass.
- [ ] **Step 5: Ledger** `Task 4: complete`.

---

### Task 5: Probe additions and their consumers

**Files:**
- Modify: `src/library/probe.js:5-30` (`run` overflow), `:41-75` (`detectTools`: `filters.libplacebo`, `ffmpeg.major`), `:88-95` (`-show_chapters`), `:140-170` (summary fields)
- Modify: `src/extras/intros.js:26-38` (chapters from summary; `defaultAudio`), `src/extras/previews.js:5-44` (rotation-aware plan; `scale` before tonemap; `-hwaccel auto`), `src/library/scanner.js:516` (MJPEG copy)
- Test: `test/probe.test.js` (new, fixture JSON), `test/previews.test.js`, `test/intros.test.js`

**Interfaces:**
- Produces: summary `video.bitDepth` (from pix_fmt suffix), `video.rotation` (0|90|180|270), `video.dolbyVision: { profile } | null`, `video.colour: { transfer, primaries, matrix }`, `chapters: [{ start, end, title }]`, `defaultAudio: number`; `tools.filters.libplacebo`, `tools.ffmpeg.major`.
- Consumes (Task 6/7): `video.colour`, `video.dolbyVision`, `defaultAudio`, `tools.ffmpeg.major`.

- [ ] **Step 1: Write the failing tests**

```js
test('summary reads 12-bit depth, rotation, Dolby Vision and chapters from ffprobe JSON', ...); // fixture with yuv420p12le, side_data rotation -90, DOVI dv_profile 5, two chapters
test('a pre-0.15 summary without the new fields is treated as none', ...); // Review Focus 3: planPreviews / intros / decide with old shape → no throw
test('run() rejects with EOVERFLOW instead of truncating', ...);
test('previews put scale before the tonemap chain and add -hwaccel auto', ...); // argv order
test('portrait sources get portrait tiles', ...); // rotation 90 → height > width in plan
test('intro fingerprints map the default audio track', ...); // -map 0:a:<defaultAudio>
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §2 "Probe additions" and "Previews / misc". `bitDepth = Number((/(\d+)(le|be)?$/.exec(pix_fmt)||[])[1]) || Number(bits_per_raw_sample) || 8`; `rotation` from `side_data_list.find(s => s.rotation != null)` normalised `((r % 360) + 360) % 360`; `dolbyVision` from `side_data_type === 'DOVI configuration record'`; `colour` from `color_transfer/color_primaries/color_space`; chapters from `-show_chapters` (`start_time`, `end_time`, `tags.title`); `defaultAudio` index into `audio[]`. `detectTools`: `libplacebo: /\slibplacebo\s/.test(out)`, `major: Number(version.split('.')[0]) || 0` (gyan "2025-..." builds → parse `n` from `ffmpeg version N-...` else treat as ≥ 5 when the string starts with a year ≥ 2022).

- [ ] **Step 4: Run the tests** — Expected: PASS (+ `test/library.test.js`, `test/music*.test.js`).
- [ ] **Step 5: Ledger** `Task 5: complete`.

---

### Task 6: `buildFfmpegArgs` — HDR, Dolby Vision, hardware HLS, audio, starts, CPU cap

**Files:**
- Modify: `src/stream/playback.js:42-106` (`decide`: DV5, audio index validation, audio copy in transcode), `:107-202` (`buildFfmpegArgs`), `:224-244` (tools → `plan.tools`), `:245-308` (`create`: 422/400 sentences)
- Modify: `src/settings.js` (`maxSoftwareHeight` default from `os.cpus().length < 6 ? 720 : 1080`), `src/api/admin.js` (validation — Task 4 added it)
- Test: `test/playback.test.js` (unit, fake plans), `test/playback-args.test.js` (new)

**Interfaces:**
- Consumes: `plan.media.video.{hdr, colour, dolbyVision, fps}`, `plan.media.audio[].channels`, `plan.tools.filters.{zscale,libplacebo}`, `plan.tools.ffmpeg.major`, `settings.maxSoftwareHeight`.
- Produces: argv per spec §2; `decide()` throws `HttpError(422, "This ffmpeg can't convert HDR video (it needs zscale or libplacebo).")` and `HttpError(400, "That audio track doesn't exist.")`.

- [ ] **Step 1: Write the failing tests** (`test/playback-args.test.js`, pure argv assertions)

```js
test('HDR → non-HDR sink with zscale: scale first, tonemap chain with explicit input tags, bt709 output flags', ...);
test('…without zscale but with libplacebo: the libplacebo filter', ...);
test('…with neither: 422 with the HDR sentence', ...); // Review Focus 4
test('Dolby Vision profile 5 needs libplacebo', ...);
test('5.1 → stereo uses the pan matrix and a limiter, not -ac 2', ...);
test('AAC stereo the sink can play is copied even when video is transcoded', ...);
test('an audio index the probe does not list → 400', ...);
test('-map 0:a:N has no ? suffix', ...);
test('nvenc HLS gets -forced-idr 1 and -g; qsv -forced_idr 1; libvpx -row-mt 1', ...);
test('-level is 5.1 above 1080p, 4.2 above 30 fps, else 4.1', ...);
test('software transcodes are capped at maxSoftwareHeight', ...);
test('progressive mp4 adds -frag_duration 500000', ...);
test('HLS uses 2 s segments, 2 s forced keyframes, hls_init_time 1 and -readrate 1.5 on ffmpeg ≥ 5', ...); // and no -readrate on major 4
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §2 ("HDR", "Hardware HLS", "Audio", "Starts and seeks", "CPU cap"). Pass `tools` into the plan in `create()` (`plan.tools = this.tools()`), so `buildFfmpegArgs(plan, settings, output)` stays pure. Keep `-readrate 1.5` before `-i` and only for `output.type === 'hls'`.
- [ ] **Step 4: Run the tests** — `node --test test/playback-args.test.js test/playback.test.js test/cast-sessions.test.js test/remote-play.test.js` → PASS; then the full suite to a file.
- [ ] **Step 5: Ledger** `Task 6: complete`.

---

### Task 7: Honest remux seeks, libass warm-up and fonts, `.ass` burn-in, cp1252, HLS stall check

**Files:**
- Create: `src/stream/keyframes.js` (`keyframeAtOrBefore(ffprobePath, file, start, { headers })`)
- Modify: `src/stream/playback.js` (`create()`: remux with `start > 0` → adjust `session.start`; `serveHls` proc check), `src/app.js` (startup warm-up), `src/stream/playback.js:136` (`fontsdir`), `src/cast/sessions.js:284-294` (`.ass` sidecar path), `src/stream/subtitles.js:128-150` (`toVtt` cp1252 retry)
- Test: `test/keyframes.test.js` (new, generates a 2-GOP file with ffmpeg; skip without ffmpeg), `test/playback.test.js`, `test/cast-sessions.test.js`, `test/subtitles-online.test.js` (toVtt lives beside it — or a new `test/subtitles.test.js`)

**Interfaces:**
- Produces: `keyframeAtOrBefore(...)` → `number` (seconds, ≤ start, ≥ 0) or `null` on any failure; `playback.create()` returns `start` = the keyframe for remux; `fontsDir()` → OS fonts path.

- [ ] **Step 1: Write the failing tests**

```js
test('keyframeAtOrBefore returns the last keyframe at or before start', ...); // 2 s GOPs: start 5.0 → 4.0; start 4.0 → 4.0
test('…near the end and on ffprobe failure', ...); // Review Focus 5: start past duration → ≤ duration; bad path → null
test('a remux session that starts mid-file reports the keyframe time as start', ...); // create(start: 5) → start 4 (fake keyframes)
test('the startup warm-up runs the subtitles filter once in the background', ...); // fake ffmpegPath records one lavfi invocation
test('the burn-in filter names the OS fonts folder with the colon escaped', ...); // Windows → fontsdir=C\:/Windows/Fonts
test('an .ass sidecar is burned as .ass', ...); // cast-sessions: Samsung TV + .ass → filename ends .ass
test('toVtt retries a cp1252 .ass with -sub_charenc', ...);
test('serveHls reports a dead encoder instead of waiting for a segment', ...);
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §2 "Starts and seeks" (remux branch) and "Subtitles". ffprobe argv: `['-v','error','-select_streams','v:0','-read_intervals',`${Math.max(0,start-10)}%${start}`,'-show_entries','packet=pts_time,flags','-of','csv=p=0', file]`; parse lines `pts,flags`, keep `flags` containing `K`, take the max `pts ≤ start`. Warm-up in `app.js` after `detectTools`, `setTimeout(..., 0)`, never awaited; the `.vtt` is written into `transcodeDir/warm.vtt`.
- [ ] **Step 4: Run the tests** — PASS; full suite to a file → all pass.
- [ ] **Step 5: Ledger** `Task 7: complete`.

---

### Task 8: Plan A review

- [ ] Build the review package (diff of every changed file vs `scratchpad/passover-sdd/base/`), spec §1–§2, this plan's Review Focus verbatim, and the ledger's `Ruling:` lines; dispatch the fresh **sonnet** reviewer; re-grade; one TDD fix pass; ledger `Final:` lines. No delivery yet — plan B follows under the same spec and the PC gets v0.15.0 once.
