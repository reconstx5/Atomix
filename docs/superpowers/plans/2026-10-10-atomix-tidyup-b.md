# Atomix Round 20 — Plan B (browser) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the browser-side deferred minors (encrypted player, Live TV pages, guide, accessibility) and surface Plan A's new server data (certificate/init data, radio-without-guide list, Remove missing titles, cast notices).

**Architecture:** Plain ES-module browser code in `public/js`. Pure logic is tested with `node --test` (pulled into small exported helpers where it isn't already); view behaviour is checked in the Playwright devtools suites against the dev server on :8787 and the IPTV mock on :9919.

**Tech Stack:** Node ≥ 22.13 (`node:test`), browser MSE/EME, Playwright devtools in `/home/claude/devtools`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-tidyup-design.md` (Plan B section; plus the Settings guide card and Remove missing titles from Plan A's data).

## Global Constraints

- No dependencies. Older themes stay pixel-identical: `node /home/claude/devtools/oldthemes-compare.mjs compare` → "all pages match".
- Provider URLs, headers and tokens never reach the browser; Kids never see admin data.
- New sentences exactly: "This programme has ended"; "Your sign-in has expired — sign in again"; "This channel's stream couldn't be read"; "Encrypted"; ", encrypted"; "Radio without guide (N)"; "Remove missing titles"; "Remove N titles whose files are gone?".
- Browser suites run with `/home/claude/devtools/restart-dev.sh` first; never `pkill -f`.

## Review Focus

1. **Zapping fast between a plain and an encrypted channel** — only the last-asked channel plays; no stray error, Play button or second engine (Task 3 live-ui check "plain ↔ encrypted zap with PageUp/PageDown").
2. **A manifest that turns static mid-play (the programme ends on a dynamic stream)** — the refresh loop stops and "This programme has ended" shows once (Task 1 test `refresh stops once the manifest is static`).
3. **A Kids profile saved by an admin who can't see one source's groups (source has no groups yet)** — that source's stored ticks survive (Task 5 test).
4. **The phone-width player (< 480 px) closing Quality via Escape** — focus lands on "More controls", never on a hidden button (Task 3 a11y check).
5. **A licence answer of 401 during a long session** — the sentence names sign-in, and it isn't retried as an unreadable stream (Task 2 test).

---

### Task 1: DashPlayer engine (17B-1…9)

**Files:**
- Modify: `public/js/dash/player.js` (append 236-251, trim 253-262, fetchSegment 264-278, pump ~290-310, refreshLoop 351-377, watch 395-417, get 112-122)
- Test: `test/dash-player.test.js` (new fake SourceBuffer/fetch helpers at the top of the new tests)

**Interfaces:**
- Produces: `export function sbQueue(sb)` → `{ run(fn) }` (fn gets the SourceBuffer, awaited one at a time, each waiting for `updateend`/`error` with listeners removed after); `export function stallNudge(mpdType, currentTime, segs)` → seconds to seek to (static: `currentTime + 0.1`; dynamic: `liveStart(segs)`); DashPlayer option `onEnded()`; `onLevels(levels)` called again after a refresh that changes video levels; `fetchSegment(url, { kind })`.

- [ ] **Step 1: Write failing tests** in `test/dash-player.test.js`:
  - `sbQueue runs append, remove and changeType one at a time and leaves no listeners behind` — fake SB (EventTarget with `updating`, `appendBuffer`, `remove`, `changeType`, a listener counter); queue 3 ops concurrently; assert ops never overlap and listener count is 0 after.
  - `a static stall nudges forward 0.1 s; a dynamic stall jumps to the live point` — `stallNudge('static', 12, segs) === 12.1`; `stallNudge('dynamic', 12, segs) === liveStart(segs)`.
  - `get() refuses after destroy and refuses another origin` — DashPlayer with injected `fetch` spy, `location` stubbed to `http://atomix.test`; `get('http://evil.example/x')` rejects with `"This channel's stream couldn't be read"` and fetch not called; after `destroy()` `get('/x')` rejects, fetch not called.
  - `only video segments feed the throughput estimate` — `fetchSegment(url, {kind:'audio'})` leaves `throughput` unchanged; `{kind:'video'}` changes it.
  - `refresh stops once the manifest is static and calls onEnded at the end` — injected fetch answers dynamic then static manifest; assert refresh fetch count stops growing and `onEnded` called once after `finish`.
  - `a refresh that changes the video levels calls onLevels again` — two manifests with different video Representations; `onLevels` called twice with different lists; same levels → not called again.
- [ ] **Step 2: Run** `node --test test/dash-player.test.js` — Expected: the 6 new tests FAIL (not exported / wrong behaviour).
- [ ] **Step 3: Implement** in `public/js/dash/player.js`: one `sbQueue` per track (`t.q`); `append`, `trim`, `changeType` and `timestampOffset` go through `t.q.run`; `get` checks `this.destroyed` and `new URL(url, location.href).origin === location.origin`; the stall branch seeks to `stallNudge(...)`; `fetchSegment` takes `kind` (video only updates `throughput`); `refreshLoop` returns once `mpd.type !== 'dynamic'`; `finish()` calls `this.onEnded?.()` once; refresh compares the video level list (`bandwidth,width,height` per rep) and calls `onLevels` on a change.
- [ ] **Step 4: Run** `node --test test/dash-player.test.js test/dash-timeline.test.js test/dash-mpd.test.js test/dash-abr.test.js` — Expected: all PASS.

### Task 2: Keys, certificate, init data, licence sentences (17B-16 + Plan A data)

**Files:**
- Modify: `public/js/dash/eme.js` (`licenceError` 59-62; `setupKeys` 85-163), `public/js/dash/player.js` (`SENTENCES` 22; `open()` 172-178 passes the two new options)
- Test: `test/dash-eme.test.js` (extend `fakeEme` keys with `setServerCertificate`, recorded in `log`)

**Interfaces:**
- Produces: `setupKeys(video, { …, serverCertificate = null, initData = null })` (both base64); DashPlayer options `serverCertificate`, `initData`; `licenceError(404) === "This channel's stream couldn't be read"`, `licenceError(401) === 'Your sign-in has expired — sign in again'`.

- [ ] **Step 1: Write failing tests:** `licence 404 is unreadable and 401 names sign-in` (and `sentenceOf` keeps the 401 sentence); `the server certificate is set before the first licence request` (log order: `setServerCertificate` before the first fetch); `playlist init data opens a session when the manifest carries none` (contentProtection without pssh, `initData: PSSH` → `generateRequest('cenc', bytes)` called once, without an `encrypted` event); `manifest init data wins over the playlist's`.
- [ ] **Step 2: Run** `node --test test/dash-eme.test.js` — Expected: 4 FAIL.
- [ ] **Step 3: Implement:** `fromBase64` both values; `await keys.setServerCertificate(cert)` after `createMediaKeys` when given (a rejection → `onError(UNREADABLE)`); when `initDataFor(...)` is empty and `initData` given, open the session with it at setup; add 401 sentence to `SENTENCES`; the view passes `res.serverCertificate`, `res.initData` (Task 3).
- [ ] **Step 4: Run** `node --test test/dash-*.test.js` — Expected: all PASS.

### Task 3: Player view — encrypted zaps, notices, menus (17B-10…13, 16B-1…3, 15B-2/3/9, 17B-17)

**Files:**
- Modify: `public/js/views/player.js` (MODE_LABEL 27; setNotice 163-181; closeMenu 611-620; menu empties 631-632; checkProgramme 901-908; applyLive 944-947; playEncrypted 974-1003; zap 1026-1030; cleanup 1389-1412; `ended` listener 505-506), `public/js/live.js` (`zapQueue` 89-123: add `cancel()`)
- Modify (devtools): `/home/claude/devtools/live-ui.mjs` (drm: plain ↔ encrypted zap with PageUp/PageDown; static end; Info heading), `/home/claude/devtools/mock-iptv.mjs` (mode `static`: the DASH channel answers a static 10-s manifest; modes `lic404`, `lic401`)
- Test: `test/live-client.test.js`; browser: `live-ui.mjs drm player`, `qol-ui.mjs notice`, `a11y-ui.mjs menus`

**Interfaces:**
- Consumes: Task 1 `onEnded`, `onLevels` re-calls; Task 2 options.
- Produces: `zapQueue(...).cancel()` — clears the timer, resolves a pending `request` with `null`, and calls `onStale` for anything in flight.

- [ ] **Step 1: Write failing Node test** `zapQueue.cancel drops a pending zap and stops one in flight` (pending request resolves `null`, `startChannel` never called for it; an in-flight result goes to `onStale`).
- [ ] **Step 2: Write failing browser checks** in live-ui.mjs: `Info heading reads Encrypted`; `plain ↔ encrypted zap with PageUp/PageDown plays the last channel, no error or Play button` (PageDown/PageUp ×4 quickly across a plain and an encrypted neighbour, then the badge and channel name match the last); `a static manifest's end shows "This programme has ended" with the controls` (mock `static`); `licence 401 shows "Your sign-in has expired — sign in again"` (mock `lic401`); `the next programme isn't "now" before it starts`; `channel up before the list loads does nothing` (delay `/api/live/channels` with `page.route`); in qol-ui notice: `a replaced notice isn't hidden by the old one's dismiss`; in a11y-ui menus: `Escape from Quality at 400 px returns focus to More controls` and `menu empty lines are role=none items with aria-disabled`.
- [ ] **Step 3: Run** `node --test test/live-client.test.js` and `node /home/claude/devtools/live-ui.mjs drm player`, `qol-ui.mjs notice`, `a11y-ui.mjs menus` — Expected: the new checks FAIL.
- [ ] **Step 4: Implement:** `MODE_LABEL.encrypted = 'Encrypted'`; `onError` returns early when `zapTarget != null && zapTarget !== res.channel.id`; `play().catch(e => …)` ignores `AbortError` and a `session !== res`; a failed engine import stops the session (`api.post(stop)`, `session = {...res, sessionId: null}`) before `showError`; `onEnded` → `showError('This programme has ended')` with controls shown; `checkProgramme` needs `tvNext.start <= Date.now()`; `zap()` returns when `!channelList.length`; cleanup calls `zaps.cancel()`; `setNotice` keeps an `AbortController` and aborts the previous one; `closeMenu` focuses `opener.offsetParent ? opener : moreBtn`; menu empties become `h('div', { role: 'none', class: 'menu-empty' }, h('span', { role: 'menuitem', 'aria-disabled': 'true', tabindex: '-1' }, text))`; an open Quality menu redraws on `onLevels`; pass `serverCertificate`/`initData`.
- [ ] **Step 5: Run** the same commands — Expected: all PASS; then `node /home/claude/devtools/live-ui.mjs` (all sections) PASS.

### Task 4: Live TV pages and guide (17B-14/15, 16B-4, 16B-8)

**Files:**
- Modify: `public/js/views/live.js` (`lockBadge` 18; Channels `load`/`schedule`/cleanup 117-175), `public/js/views/guide.js` (labels 154, 166; phone picker 283, 311; `moreRows` 193-199, `drawRows`/`moveTo`)
- Test (browser): `live-ui.mjs drm guide channels`

- [ ] **Step 1: Write failing checks:** `the lock has visually hidden text "Encrypted"`; `guide programme buttons and empty cells of an encrypted channel end ", encrypted"` (label contains it); `the phone guide's channel picker names encrypted channels`; `more rows for a window that moved are dropped` (route-delay one `/api/live/guide` answer, press Later, assert no duplicated row/old-window cells); `leaving Channels stops its reload timer` (count `/api/live/channels` requests 70 s after leaving with a fake clock via `page.clock`).
- [ ] **Step 2: Run** `node /home/claude/devtools/live-ui.mjs drm guide channels` — Expected: new checks FAIL.
- [ ] **Step 3: Implement:** `lockBadge` appends `h('span', { class: 'visually-hidden' }, 'Encrypted')`; guide labels and picker options add `c.drm ? ', encrypted' : ''` (picker visible text unchanged, `aria-label` gains it); `moreRows` captures a `gen` bumped by `drawRows(reset)`/`moveTo` and returns if it changed after `await ensure`; Channels page sets `destroyed = true` in cleanup and `schedule()` returns when destroyed.
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 5: Kids Live TV ticks keep unseen sources (16B-6)

**Files:**
- Modify: `src/api/live.js` (PUT `/api/profiles/:id/live-groups` 359-372), `src/live/store.js` (`setKidsGroups` 289-294), `public/js/views/settings.js` (`liveGroupsField` 258-288, save 242)
- Test: `test/live-api.test.js`; browser `live-ui.mjs admin`

**Interfaces:**
- Produces: PUT body `{ sources: [key…], groups: [{source, group}…] }` (an array body stays accepted = all sources); `store.setKidsGroups(profileId, rows, { sources = null })` deletes only rows of `sources` when given.

- [ ] **Step 1: Write failing test** `saving a Kids profile's ticks for one source keeps another source's` (store ticks for A and B; PUT `{sources:['A'], groups:[{source:'A',group:'News'}]}`; GET shows B's ticks unchanged).
- [ ] **Step 2: Run** `node --test test/live-api.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; the field's `value()` returns `{ sources: shown.map(s => s.key), groups }`.
- [ ] **Step 4: Run** `node --test test/live-api.test.js test/live-store.test.js` and `live-ui.mjs admin` — Expected: PASS.

### Task 6: Settings and cast additions (radio fold, Remove missing titles, cast notice)

**Files:**
- Modify: `public/js/views/settings.js` (`liveSourceBlock` 1217-1251; `librariesTab` 953-995), `public/js/cast.js` (`pick` 200-219), `public/js/views/remote.js` (`draw` status 233), `public/js/views/player.js` (`castToTv` 1257-1271)
- Modify (devtools): `/home/claude/devtools/qol-ui.mjs` (new section `libraries`)
- Test (browser): `live-ui.mjs admin cast`, `qol-ui.mjs libraries`

- [ ] **Step 1: Write failing checks:** `the guide card lists TV channels without guide, then a folded "Radio without guide (N)"`; `a library's "…" offers Remove missing titles; the in-page confirmation reads "Remove N titles whose files are gone?" and Remove deletes them` (dev data: add a library over a temp folder, scan, delete one file, open the menu; Cancel leaves the count); `a DLNA start that dropped the subtitle shows the notice on the Remote` (mock cast TV without libass, choose a subtitle).
- [ ] **Step 2: Run** `live-ui.mjs admin cast`, `qol-ui.mjs libraries` — Expected: FAIL.
- [ ] **Step 3: Implement:** `liveSourceBlock` keeps the TV `details` and adds `h('details', {}, h('summary', {}, `Radio without guide (${r.count})`), …names)` when `r.count`; each library row gains `moreButton(lib.name, [{ label: 'Remove missing titles', run }])` where `run` posts `{dryRun:true}`, then replaces the row's actions with an inline confirmation (`Remove ${count} titles whose files are gone?`, buttons Remove / Cancel; count 0 → "No missing titles" toast) and posts `{}`; `pick()` passes `r.notice` to `toast`, and the Remote's status line shows `s.notice` when there's nothing else to say.
- [ ] **Step 4: Run** the same and `node /home/claude/devtools/oldthemes-compare.mjs compare` — Expected: PASS and "all pages match".
