# Atomix Round 21 — Plan B (recording and the scheduler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record programmes and series from the guide through the channel's tuner, into a "Recordings" TV library, with clash handling, padding, restart recovery and the disk floor — server and API only (the guide buttons, the Recordings page and the settings card are Plan C).

**Architecture:** `src/live/recordings.js` keeps the two tables; `src/live/recorder.js` copies a tuner's pieces for a time window and joins them (no conversion) into `.mkv` + `.nfo`; `src/live/scheduler.js` ticks every 15 s, starts and ends recordings, applies series rules after each guide refresh, and decides clashes through `LiveStreams`. Routes in `src/api/recordings.js`.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, `fs.statfs`), ffmpeg, `node:test`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-atomix-dvr-timeshift-design.md` (sections 3 and 4). Builds on Plan A (`TunerPool`, `LiveStreams` tuner holders).

## Global Constraints

- Encrypted channels and radio are never recorded (the API refuses: 400 "Encrypted channels can't be recorded" / "Radio can't be recorded").
- Padding defaults: start 1 min early (`recordPre`, 0–30), end 3 min late (`recordPost`, 0–60). Recordings folder default `<data>/recordings` (`recordingsDir`). Disk floor 5 GB, fixed. Scheduler tick 15 s. Series look-ahead 7 days.
- File names: `<Show>/<Show> - S01E02 - <Episode title>.mkv`, else `<Show>/<Show> - 2026-10-11 20-30.mkv`; part 2 after a restart: `… (part 2).mkv`; Windows-safe (`<>:"/\|?*` removed, trailing dots/spaces trimmed).
- Sentences, exactly: "Couldn't record: every stream is recording"; "Stopped to record <title>"; "The recordings folder is full"; "This channel no longer exists."; "Has a gap"; "Your provider allows N stream(s) at a time — this overlaps M other recording(s)"; "Delete <title>? The file is removed." (Plan C shows it).
- Kids never schedule, list or see recordings through these routes (403 "Kids profiles can't record").

## Review Focus

1. **A recording whose channel someone is already watching** — no second provider connection; the recording starts from the buffer when its padded start is still in it (Task 2 test).
2. **Atomix restarted in the middle of a recording** — on start it resumes as part 2 and the first part is kept as it was (Task 3 test).
3. **Two series rules matching the same programme, or a guide refresh repeating a programme with a new id** — one recording, not two (Task 4 test).
4. **A recording that starts while the only stream is held by two viewers of another channel** — both are stopped with "Stopped to record <title>", the recording runs (Task 3 test).
5. **A recording cancelled while it records** — the tuner hold is released, what was recorded is kept as done ("stopped early"), and no ffmpeg is left (Task 3 test).

---

### Task 1: Tables, the repeat flag, and the store

**Files:**
- Modify: `src/db.js` (migration 18), `plugins/iptv-simple/xmltv.js` (`<previously-shown>` → `repeat: true`), `src/live/store.js` (`replaceProgrammes` stores `repeat`; `programmeRow` returns it)
- Create: `src/live/recordings.js`
- Test: `test/live-recordings.test.js`, `test/migrations.test.js`, `test/iptv-xmltv.test.js`

**Interfaces:**
- Produces: `class Recordings(db)` with `add(row) → id`, `get(id)`, `update(id, fields)`, `list({ status } = {})`, `due(now)` (scheduled with `start - pre*60000 <= now`), `ending(now)` (recording with `end + post*60000 <= now`), `overlapping(source, from, to, exceptId)`, `exists({ ruleId, source, channelKey, start, season, episode, title, episodeTitle })`; `rules()`, `addRule(row)`, `updateRule(id, fields)`, `deleteRule(id)`; parse helper `episodeNumbers(text) → { season, episode } | null` (`"S2 E5"`/`"S2E5"` → 2, 5).

- [ ] **Step 1: Write failing tests:** `migration 18 adds live_recordings, live_series_rules and live_programmes.repeat`; `xmltv: <previously-shown/> marks a programme as a repeat`; `episodeNumbers reads "S2 E5" and "S2E5"`; `due and ending honour the padding`; `exists finds a programme already recorded or scheduled by episode, by title + episode title, or by channel + start`.
- [ ] **Step 2: Run** `node --test test/live-recordings.test.js test/migrations.test.js test/iptv-xmltv.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 2: The recorder

**Files:**
- Create: `src/live/recorder.js`
- Test: `test/live-recorder.test.js` (real ffmpeg, the endless provider from `test/helpers-live.js`, a real `TunerPool`)

**Interfaces:**
- Consumes: Plan A `Tuner` (`runs`, `dir`, `on('piece')`), `TunerPool.acquire/release`.
- Produces:
  - `safeName(text) → string`; `recordingPath({ recordingsDir, title, season, episode, episodeTitle, start, part }) → string`; `nfoFor(rec, channelName) → string` (`<episodedetails>` with title, showtitle, season, episode, plot, aired `YYYY-MM-DD`, studio = channel name).
  - `class Recorder({ tuner, from, to, workDir, ffmpegPath, now })` — `start()` copies, as they appear, every piece whose wall-clock span (`run.start + t … + d`) overlaps `[from, to)` (pieces already in the buffer included) into `workDir/run-<n>/`; `gapSeconds()` (missing time inside the window, counting time between runs); `finish(outFile) → Promise<{ file, gapSeconds }>` joins each run's `init + pieces` and concatenates the runs with ffmpeg's concat demuxer `-c copy` into `outFile` (the `.mkv`), then removes `workDir`; `abort()` removes `workDir`.
  - `class DirectRecorder({ url, headers, workDir, ffmpegPath })` — for an unbuffered channel: its own ffmpeg `-c copy -f mpegts` from the provider (`liveInputArgs`), same `finish/abort`.

- [ ] **Step 1: Write failing tests:**
  - `safeName and recordingPath: Windows-safe names, episode or date forms, part 2` — `'What? <Now>: Live|'` → `'What Now Live'`; `S1E2` form; date form `Show - 2026-10-11 20-30.mkv` (local time); `(part 2)`.
  - `nfoFor writes an episodedetails with the guide's fields`.
  - `a recording copies the buffer's pieces for its window and joins them into a playable mkv` — tuner on the endless provider; window `[now − 6 s, now + 8 s]` (starts inside the buffer); `finish` → the file exists, `ffprobe` duration ≈ 14 s (± 5), codecs h264/aac, `gapSeconds` 0, workDir gone.
  - `a drop inside the window: the mkv spans both runs and the gap is counted` — `/__drop` mid-window → duration ≈ window minus the gap, `gapSeconds` > 0.
  - `DirectRecorder records an unbuffered channel straight from the provider`.
- [ ] **Step 2: Run** `node --test test/live-recorder.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 3: The scheduler — start, stop, clashes, restart, disk

**Files:**
- Create: `src/live/scheduler.js`
- Modify: `src/live/stream.js` (`holderInfo` for recording holders; `takeSlotFor(source, recording) → { ok: true } | { ok: false, error }`), `src/settings.js` (`recordingsDir: ''` = default, `recordPre: 1`, `recordPost: 3`, validated), `src/app.js` (construct, start after the refresher, `stop()`), `src/config.js` (`recordingsDir` default `<data>/recordings`)
- Test: `test/live-scheduler.test.js` (fake clock; fake tuner pool and fake recorder factory injected; one real-ffmpeg end-to-end test with startAtomix)

**Interfaces:**
- Consumes: Task 1 `Recordings`, Task 2 recorders, Plan A `LiveStreams`/`TunerPool`.
- Produces: `class Scheduler({ store, recordings, streams, tuners, plugins, settings, config, scanner, db, log, now, makeRecorder, freeBytes })` — `tick()` (exported for tests), `start()`/`stop()` (15-s interval, unref), `schedule({ profile, programme, channel }) → { recording, clash: string|null }`, `cancel(id)` (scheduled → cancelled; recording → stopped early and finished as done), `recover()` (run once at start: `recording` rows still inside their window resume as part 2, others are finished from what exists or failed "Has a gap" when nothing), `afterRefresh(sourceKey)` (series, Task 4).
  - A recording holder is `{ id: 'rec:<id>', kind: 'recording', title, info: { id, userId, profileId, username: 'Recording', createdAt, live } }`.
  - `takeSlotFor`: if the source has a free slot (tuners counted once; idle ones closed) → ok; else stop the newest **viewer** holder(s) on other channels of that source until there is room (each viewer gets "Stopped to record <title>" as its ended sentence); if only recordings hold the slots → `{ ok: false, error: "Couldn't record: every stream is recording" }`.
  - Ending: `finish` → `done` with `path`, `gap_seconds`; the Recordings library (a TV library over `recordingsDir`, created on first use if none points there) is scanned; the `.nfo` is written beside the file.
  - Disk: `freeBytes(dir) → number` (default via `fs.statfsSync`); below 5 GB a due recording fails "The recordings folder is full"; a running one is finished early with the same `error` kept on a `done` row.

- [ ] **Step 1: Write failing tests** (fake clock unless noted):
  - `a due recording starts at start − pre and ends at end + post` (tick before → nothing; at `start − 60 s` → `recording` with a tuner hold; at `end + 180 s` → `done`, recorder finished, hold released).
  - `a channel someone is watching: the recording shares its tuner` (no new acquire key).
  - `no free slot: the newest viewers on other channels are stopped with "Stopped to record <title>"` (two viewers on one other channel, max 1).
  - `only recordings hold the slots: it fails "Couldn't record: every stream is recording"`.
  - `cancelling while recording keeps what was recorded and releases the hold`.
  - `restarted mid-recording: recover() resumes it as part 2`.
  - `under 5 GB free: a due recording fails "The recordings folder is full"`.
  - `a removed source fails its scheduled recordings "This channel no longer exists."`.
  - `schedule() warns about overlaps beyond the limit` — exact sentence for max 1 with one other recording.
  - `end to end (real ffmpeg): a 15-s recording lands in the Recordings library as an episode` (startAtomix + endless provider; tick driven by a short window; the library exists, a scan found 1 episode, the file has a `.nfo`).
- [ ] **Step 2: Run** `node --test test/live-scheduler.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test test/live-scheduler.test.js test/live-stream.test.js test/live-tuner*.test.js` — Expected: PASS.

### Task 4: Series rules

**Files:**
- Modify: `src/live/scheduler.js` (`afterRefresh`, keep-last-N after a finish), `src/live/refresh.js` (call `onRefreshed(sourceKey)` after a successful refresh)
- Test: `test/live-scheduler.test.js`

**Interfaces:**
- Produces: rule `{ id, profileId, source, channelKey|null, title, newOnly, keep: 0|5|10 }`; `afterRefresh` schedules matching programmes starting in the next 7 days (title case-insensitive and trimmed; on the rule's channel, or any channel of the source when null; not radio or encrypted; `newOnly` skips `repeat`), skipping any `exists(...)`; after a recording of a rule finishes, a `keep` of N deletes that rule's oldest done recordings (file, `.nfo`, item) beyond N.

- [ ] **Step 1: Write failing tests:** `a series rule schedules its programmes after a guide refresh, once`; `any-channel rules match every channel of the source`; `new episodes only skips repeats`; `two rules matching one programme schedule it once; a refreshed programme with a new id isn't scheduled again`; `keep 5 deletes the oldest finished recordings of the rule`.
- [ ] **Step 2: Run** `node --test test/live-scheduler.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same and `node --test test/live-refresh.test.js` — Expected: PASS.

### Task 5: The recordings API

**Files:**
- Create: `src/api/recordings.js`, registered in `src/app.js`
- Modify: `src/api/live.js` (`shapeProgramme` gains `recording: 'scheduled'|'recording'|null` and `repeat`), `src/api/admin.js` (Dashboard `nextRecordings`, `tuners[].recording`)
- Test: `test/live-recordings-api.test.js`

**Interfaces:**
- Produces:
  - `POST /api/live/programmes/:id/record` `{ series?: boolean, anyChannel?: boolean, newOnly?: boolean, keep?: 0|5|10 }` → `{ recording, rule, clash }`; 400 for encrypted/radio, 403 for Kids, 404 for a programme the viewer can't see.
  - `GET /api/live/recordings` → `{ scheduled, recording, done, failed, rules }` (each row with `profile` name, `channel`, `title`, `start`, `end`, `gapSeconds`, `error`, `itemId`, `clash`).
  - `POST /api/live/recordings/:id/stop`; `DELETE /api/live/recordings/:id` (scheduled → cancelled; done → file, `.nfo` and item removed); `PATCH /api/live/rules/:id` `{ keep, newOnly, channelKey|null }`; `DELETE /api/live/rules/:id` (Stop series: future scheduled ones of the rule are cancelled).
  - Settings: `recordingsDir` (absolute, writable, else 400 "Atomix can't write to that folder"), `recordPre`, `recordPost` via the existing admin settings route.

- [ ] **Step 1: Write failing tests:** `record a programme, list it as scheduled, cancel it`; `record series makes a rule and schedules its episodes`; `encrypted and radio channels can't be recorded; Kids get 403`; `the guide marks scheduled programmes`; `deleting a done recording removes its file and item`; `an unwritable recordings folder is refused`.
- [ ] **Step 2: Run** `node --test test/live-recordings-api.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: all PASS.
