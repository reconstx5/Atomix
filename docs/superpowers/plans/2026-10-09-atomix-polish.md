# Atomix v0.14.0 — the casting polish and the QoL leftovers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ten casting leftovers from the v0.13 review and the four QoL groups Dallas chose (episode cards saying what's left, remote-friendly lists, smoother player bits, library tidy-ups), test-first, with no schema change.

**Architecture:** Server changes stay inside the files that own each behaviour (`src/remote/progress.js`, `src/cast/sessions.js`, `src/cast/dlna.js`, `src/api/cast.js`, `src/app.js`, `src/library/scanner.js`, `src/collections.js`, `src/lyrics.js`, `src/library/probe.js`, `src/tasks.js` + `src/extras/`). Browser changes are in `public/js/cast.js`, `components.js`, `scrub.js`, `seekpreview.js`, `views/player.js`, `views/remote.js`, `views/item.js`, `views/lists.js`, `views/nowplaying.js`, `music.js` and the two CSS files. Each task has its own node:test or Playwright coverage; a new `devtools/qol-ui.mjs` covers the player/list items.

**Tech Stack:** Node ≥ 22.13 (node:http, node:sqlite, node:test), plain ES-module browser JS, Playwright for the browser checks (dev server `restart-dev.sh`, mocks on :9911–:9918).

**Spec:** `docs/superpowers/specs/2026-10-09-atomix-polish-design.md`

## Global Constraints

- Node ≥ 22.13, zero npm dependencies, plain ES-module browser JS, no build step. Orbit first with a TV remote; older themes change only where this spec changes content (the episode captions).
- Version `0.14.0`. **No migration.**
- Nothing new leaves the server. Tokens and secrets never reach a browser or a device.
- Copy, exactly as written: "Watched", "<n> min left", "+30 s" / "−30 s" / "+60 s" / "−60 s", "Play this song", "This ffmpeg can't draw subtitles onto video (it needs libass)", "This cast link has ended.", "Atomix lost touch with <device>."

## Review Focus

1. **A watched report behind a hung server.** A viewer finishes a remote title while the server hangs; a later "paused at 0" report from the same session must not replace the pending watched one — the server still gets the scrobble. Pinned in Task 1.
2. **A DLNA TV that refuses Seek, resumed mid-film.** The TV must end up playing from the resume point (converted), not from 0, and the old (native) stream must be stopped. Pinned in Task 2.
3. **A non-admin casting from a VPS.** With no home-network address, a viewer's picker must still say "Casting needs Atomix on the same home network as your TV" even though `baseUrl` is withheld from them. Pinned in Task 3.
4. **A show whose last episode is deleted while an extra stays.** The show must leave the grid on the next scan and come back when an episode returns. Pinned in Task 7.
5. **A film TMDB moves out of its series.** After a refresh the film's "Part of" row is gone and the series' "N of M" no longer counts it. Pinned in Task 7.

---

### Task 1: Progress reports per viewer

**Files:**
- Modify: `src/remote/progress.js`
- Test: `test/remote-play.test.js`

**Interfaces:**
- Produces: the reporter's `last` and `waiting` maps keyed by `sessionId || item.id`; a pending job carries `watched` and is not replaced by a non-watched run.

- [ ] **Step 1: Failing tests** in `test/remote-play.test.js`:
  - `two sessions on the same remote title each get their own 10 s window and pending report`: two playback sessions on `ids.film`; with `everyMs = 10000`, a progress POST for session A then one for B within a second both reach the server (two `/Sessions/Playing/Progress` calls).
  - `a pending watched report is not replaced by a later plain one` (Review Focus 1): hang the server, POST position 3.9/4 (watched), then position 0.5 for the same session, release; the sent sequence contains the `PlayedItems`/watched call and no Progress with `PositionTicks` for 0.5.
- [ ] **Step 2: Run** `node --test test/remote-play.test.js`. Expected: FAIL (one Progress call; the watched call missing).
- [ ] **Step 3: Implement** in `src/remote/progress.js`: `const slotKey = (item, sessionId) => `${sessionId || `item${item.id}`}``; `last` keyed by `slotKey`; `enqueue(item, what, run, { coalesce, watched })` keeps `job.watched` and, when `coalesce && waiting.has(slot)`, replaces `job.run` only if `!job.watched || watched`; `playback:stop` deletes `last` for its session.
- [ ] **Step 4: Run** the file and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 1: complete`.

### Task 2: DLNA no-seek resume, the stale poll, links first, the mid-cast subtitle

**Files:**
- Modify: `src/cast/dlna.js`, `src/cast/sessions.js`
- Test: `test/cast-dlna.test.js`, `test/cast-sessions.test.js`, `test/helpers-cast.js` (a `fakeChromecast` option to count LOAD track lists; `fakeDlna` is enough as it is)

**Interfaces:**
- Produces: `DlnaDevice.generation` (number, bumped per `load`); `CastManager.play` returns after a converted restart when a DLNA start seek was refused; `CastManager.end` revokes links first; `command('subtitle')` restarts on a Chromecast when the track is not loaded; `s.subtitleId`/`s.audioIndex` set after success.

- [ ] **Step 1: Failing tests:**
  - `cast-dlna`: `a poll started before a load does not mark the new title taken` — start a `refresh({ media: true })` while the fake delays `GetMediaInfo` (add `state.mediaDelay`), call `load()` with a new URL, await both; `status().idleReason` is null.
  - `cast-sessions`: `resuming on a DLNA TV that can't seek restarts converted from the resume point` (Review Focus 2): `tv.noSeek()`, progress 45 s saved, start the film; the TV's last `SetAVTransportURI` is a `/api/stream/` URL whose playback session has `start === 45`, and the earlier direct-file playback session is gone from `playback.sessions`.
  - `cast-sessions`: `ending a cast revokes its links before the TV is told to stop` — with `cc.state.statusDelay = 300` (the STOP answer waits), call stop and fetch the loaded URL at once: 401.
  - `cast-sessions`: `a subtitle downloaded after the cast started is picked by a restart on a Chromecast` — start the film, write a new `.en2.srt` beside it and call `core.cast.manager.subtitlesChanged(itemId)` (Task 3 adds the route call; here the method), then `subtitle { id }` for the new track: one more LOAD whose tracks include it and `activeTrackIds` names it; `current().subtitleId` is that id.
  - `cast-sessions`: `a failed subtitle restart keeps the previous choice` — `cc.failNextLoad()` then `subtitle { id: text.id }`: 502, `subtitleId` unchanged (null).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §2.2–2.5. In `play()`: after `load()`, `if (s.kind === 'dlna' && start > 0 && s.driver.seekSupported === false && ps.mode === 'direct') return this.play(s, item, { start, forceTranscode: true })` (and skip the native attempt when `seekSupported` is already false). In `end()`: move `revokeCast` to right after `s.ended = true`. In `command('subtitle')`: compute `next` then `await` the device/restart, assign `s.subtitleId = want` only after; a Chromecast with `sub.kind === 'text'` and no `s.tracks` match restarts. `audio` likewise sets `s.audioIndex` after the restart.
- [ ] **Step 4: Run** the files and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 2: complete`.

### Task 3: The deleted profile, admin-only address, cached session fields, the .vtt and libass

**Files:**
- Modify: `src/app.js` (cast-link block), `src/api/cast.js`, `src/cast/sessions.js`, `src/api/library.js` (the subtitle download route), `src/library/probe.js` (`detectTools`), `src/api/admin.js` (nothing new: `tools` already reaches the dashboard)
- Test: `test/cast-links.test.js`, `test/cast-sessions.test.js`, `test/cast-discovery.test.js` is untouched

**Interfaces:**
- Produces: `GET /api/cast/devices` → `baseUrl` null and `refresh` ignored for non-admins; `CastManager.subtitlesChanged(itemId)`; `core.tools.filters.subtitles: boolean`; session fields `s.subtitles`, `s.previews`, `s.queueTitles`.

- [ ] **Step 1: Failing tests:**
  - `cast-links`: `a link whose profile was deleted is refused` — issue a link with the kid profile's id, delete the profile, fetch: 401 "This cast link has ended.".
  - `cast-sessions`: `a cast whose profile is deleted ends as lost` — start as Jo, delete Jo's profile, `cc.tick(1)`: within 2 s the manager has no session for the device, the device was told STOP, and the fake's loaded URL answers 401.
  - `cast-sessions`: `non-admins get no address and no network refresh; reachable is still answered` (Review Focus 3): as sam, `GET /api/cast/devices?refresh=1` → `baseUrl === null`, `typeof reachable === 'boolean'`, and the manager's discovery count unchanged (spy `core.cast.devices.discover`).
  - `cast-sessions`: `current reads the subtitle list from the session; a download refreshes it` — stub `listSubtitles` calls via a counter on `core.cast.manager.subtitleReads`; two polls add 0; `subtitlesChanged` adds 1 and the new track appears.
  - `cast-sessions`: `a start that fails before its stream exists leaves no .vtt behind; cast-subs is emptied at startup` — transcoding off → start with a text subtitle on the DLNA TV → 422; `transcodeDir/cast-subs` is empty. Then write a stray file there, build a new `CastManager(core)`: empty.
  - `cast-sessions`: `without libass a text subtitle on a DLNA TV is refused with the libass message` — `core.tools.filters.subtitles = false`; `subtitle { id: text.id }` → 400 "This ffmpeg can't draw subtitles onto video (it needs libass)"; no new `SetAVTransportURI`. A start with `subtitle` set loads without it and `subtitleId` is null.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §2.6–2.8, 2.10. `detectTools`: `filters.subtitles = /\ssubtitles\s/.test(out)`. `play()`: `if (burnTextFile && !this.core.tools.filters?.subtitles) { if (commanded) throw new HttpError(400, LIBASS); burnTextFile = null; s.subtitleId = null; }` (pass `{ commanded }` from `restart`); wrap the section after `writeSubtitle` so a throw before `playback.create` returns unlinks the file. `toJson` uses `s.subtitles`/`s.previews`/`s.queueTitles` set in `play()`/`start()`; `subtitlesChanged(itemId)` re-reads for sessions on that item. `src/api/library.js` download route: `core.cast?.manager?.subtitlesChanged(row.id)`. `src/app.js`: `if (link.profileId && !ctx.profile) throw new HttpError(401, 'This cast link has ended.')`. `onStatus`: `if (!this.core.profiles.get(s.userId, s.profileId) && s.profileId) return this.end(s, 'lost', ...)` (checked at most every 10 s with the save).
- [ ] **Step 4: Run** the files and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 3: complete`.

### Task 4: The browser's cast side

**Files:**
- Modify: `public/js/cast.js`, `public/js/music.js`
- Test: `devtools/cast-ui.mjs` (new checks in `picker` and a new `polling` section)

**Interfaces:**
- Consumes: Task 3's `baseUrl` rule.
- Produces: `refreshCast` with one in-flight promise and `again`; **Find devices again** admin-only; `music.setProfile` volume fallback.

- [ ] **Step 1: Failing browser checks:**
  - `picker`: sign in as `sam` (a viewer; create via API if absent): the picker lists devices, has no **Find devices again**, and `GET /api/cast/devices` answers `baseUrl: null`.
  - `polling`: on Home with a live cast, call `setFastPoll(true)` three times and `refreshCast()` twice from the page; count `/api/cast/sessions/current` requests over 6 s: ≤ 7 (one per second, not two chains).
  - `polling`: set `musicVolume: 0.3` on dallas, switch to Mia (no pref): the `audio.volume` equals the device's `VOLUME_KEY` value (set it to 0.8 first).
- [ ] **Step 2: Run** `node /home/claude/devtools/cast-ui.mjs picker polling`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §2.7 and §2.9.
- [ ] **Step 4: Run** cast-ui (all) ×2. Expected: ALL PASS.
- [ ] **Step 5: Ledger** `Task 4: complete`.

### Task 5: Episode captions, the ring, "+30 s", notice buttons, intro tenths

**Files:**
- Modify: `public/js/components.js` (`episodeCaption`, `wideCaption`), `public/js/views/item.js` (season row, intro editor), `public/js/scrub.js`, `public/js/seekpreview.js`, `public/js/views/player.js`, `public/js/views/remote.js`, `public/css/app.css`, `public/css/orbit.css`, `public/js/dom.js` (`formatClock` with tenths)
- Test: `test/scrub.test.js`, `test/cards.test.js` (if it holds caption tests; else a new `test/captions.test.js` importing `components.js` under a DOM shim as `cards.test.js` does), `devtools/qol-ui.mjs` (new)

**Interfaces:**
- Produces: `episodeCaption(ep) → 'Watched' | '<n> min left' | runtime`; `Scrubber.press` returns the target and sets `scrubber.lastStep` (10/30/60); `seekPreview(track).setStep(text|null)`; `formatClock(seconds, { tenths })`.

- [ ] **Step 1: Failing tests:**
  - `scrub.test.js`: `press reports the step it used` — three quick presses: `lastStep` 10, then after 1.5 s held 30, after 4 s 60.
  - captions: `episodeCaption says Watched, N min left, or the running time` — `{ progress: { watched: 1 } }` → "Watched"; `{ progress: { position: 600, duration: 2000 } }` → "24 min left"; `{ progress: { position: 10 }, runtime: 42 }` → "42 min".
  - `qol-ui.mjs` sections: `captions` (a show's season row has "Watched" on E1 after marking it and "… min left" on E2 after a progress POST; Home's Continue watching card says the same), `ring` (the Up next card's ring has a running animation; with Reduce motion on, `animation-play-state` is `paused` and `--left` steps), `scrub` (hold Right 1.6 s: the bubble shows "+30 s"; on the Remote too), `notice` (start a converted film: "Watch it"? — use the intro notice: with an intro at 0:00 and auto-skip on, "Watch it" is reachable with Up from the controls), `intro` (the editor shows `0:42.5` after saving start `0:42.5`; the API stores 42.5).
- [ ] **Step 2: Run** `node --test test/scrub.test.js` and `node /home/claude/devtools/qol-ui.mjs captions ring scrub notice intro`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3 (first five bullets). Ring: `@property --left { syntax: '<number>'; inherits: false; initial-value: 1 }` and `.upnext.is-live .upnext-ring { animation: upnext-sweep 10s linear forwards }`, `html.reduce-motion .upnext-ring { animation-play-state: paused }` (the JS keeps setting `--left` per second as today; the animation overrides it while running).
- [ ] **Step 4: Run** the tests, qol-ui, orbit-ui and orbit-sizes. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 5: complete`.

### Task 6: Remote-friendly lists and the Lyrics entry

**Files:**
- Modify: `public/js/views/lists.js`, `public/js/music.js` (the song menu's Lyrics entry), `public/js/views/nowplaying.js`, `public/js/app.js` (the `#/now-playing` route passes `query`)
- Test: `devtools/qol-ui.mjs` (`lists`, `lyrics` sections), `devtools/lists-ui.mjs` and `music-kbd.mjs` must still pass

- [ ] **Step 1: Failing browser checks:**
  - `lists`: on a 3-item playlist, "Move down" on item 1 with the remote leaves focus on that item (now second); "Remove" on item 2 leaves focus on the item that took its place; Play keeps its own focus only when the list empties.
  - `lyrics`: play album A, open song B's menu → Lyrics: `#/now-playing?song=<B>`, the page shows B's title and a **Play this song** button, the mini-player still shows A playing; pressing the button plays B.
- [ ] **Step 2: Run** `node /home/claude/devtools/qol-ui.mjs lists lyrics`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3 (last bullet).
- [ ] **Step 4: Run** qol-ui, lists-ui, music-kbd, extras-lyrics-ui. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 6: complete`.

### Task 7: Library tidy-ups

**Files:**
- Modify: `src/library/scanner.js` (`prune`, `upsertItem`), `src/extras/store.js` (`nextLyricsItem`, `pendingCounts.lyrics`), `src/extras/jobs.js` (`lyrics` job), `src/tasks.js` (pick `lyrics` after thumbs), `src/collections.js` (`upsertTmdb`, detach when dropped), `src/library/metadata.js` (`applyEnrichment`: detach when TMDB no longer lists the film)
- Test: `test/extras-scan.test.js` or `test/music.test.js` (show prune; lyrics catch-up and re-tag reset), `test/collections.test.js`, `test/lists-api.test.js`

- [ ] **Step 1: Failing tests:**
  - `a show left with only extras leaves the library and returns with an episode` (Review Focus 4): delete the only episode file, scan → the show row is gone and so is its extra; restore the file, scan → the show is back.
  - `songs probed before 0.10 get their embedded lyrics once` — store a track's `media` without a `tags.lyrics`/`lyricsChecked` key, run the task runner's next job: `tags.lyrics` set (the file has USLT) and `lyricsChecked` true; the next pick is null; `pendingCounts().lyrics` 1 → 0.
  - `a re-tagged song's stored "no lyrics" is retried` — save `none` for the track, change its mtime/size, scan: the `lyrics` row is gone.
  - `collections.test.js`: `TMDB's parts and artwork update a non-manual collection; the name stays` — upsert with 3 parts, then with 4 and a new poster: parts 4, poster new, name as renamed.
  - `lists-api.test.js` (Review Focus 5): `a film TMDB drops from its series is detached` — refresh with the mock answering no `belongs_to_collection`: the film's page has no `collection`, the series' `owned` drops by one.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §4. `nextLyricsItem`: `kind = 'track' AND path NOT LIKE 'remote:%' AND media IS NOT NULL AND json_extract(media, '$.tags.lyrics') IS NULL AND json_extract(media, '$.tags.lyricsChecked') IS NULL`. The `lyrics` job re-probes with `probe()` and writes `media.tags` (`lyrics` when found, `lyricsChecked: true` always; a failed probe also marks checked). `upsertItem`: on a size/mtime change for a track, `DELETE FROM lyrics WHERE item_id = ? AND source IN ('none', 'tags')`.
- [ ] **Step 4: Run** the files and `npm test`. Expected: PASS.
- [ ] **Step 5: Ledger** `Task 7: complete`.

### Task 8: Pictures, docs, version, verification, delivery, review

- [ ] **Step 1: Pictures.** `devtools/v014-shots.mjs`: a season row with captions, the Up next card mid-sweep, the intro editor with tenths, a playlist page after a move. Build `orbit-progress/v0140-desktop.png` and `v0140-phone.png`; look and fix.
- [ ] **Step 2: Older themes.** `oldthemes-compare.mjs compare`; re-baseline the pages the captions change and ledger them.
- [ ] **Step 3: Docs and version.** README: the episode caption and the Lyrics/Play this song note under Music; ARCHITECTURE: the reporter keys, cached session fields, the libass check, the lyrics catch-up job, the show prune, collection updates; `package.json` 0.14.0.
- [ ] **Step 4: Full verification.** `npm test` (≥ 390); cast-ui ×2, qol-ui ×2, servers-ui, orbit-ui, orbit-sizes, orbit-a11y, gate-ui, extras-ui, extras-lyrics-ui, lists-ui, rebrand-ui, music-kbd, profiles-ui, dialogs; the older themes.
- [ ] **Step 5: Delivery.** Hash-check against the v0.13.0 snapshot; deliver; PC `npm test`; project note (Round 16 / v0.14.0; the "Not yet verified" list gains: the no-seek DLNA resume on a real TV, libass on Dallas's Windows ffmpeg build).
- [ ] **Step 6: Review and wrap-up.** Ledger `Task 8: complete`; fresh sonnet review with the Review Focus and the rulings; one fix pass; re-deliver; final message; copy the ledger to `scratchpad/note/`, delete the workspace.
