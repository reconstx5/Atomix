# Atomix Round 21 — Plan C (Record in the guide, the Recordings page, settings, Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The browser side of recording: Record / Record series / Cancel recording / Stop series in a programme's sheet, the red dot in the guide and the channel rows, the Recordings page, Settings → Live TV → Recording, and the Dashboard's "Tuners in use" and "Next recordings".

**Architecture:** Plain ES-module views on Plan B's routes (`src/api/recordings.js`). One new view, `public/js/views/recordings.js` (route `#/live/recordings`); the sheet in `views/guide.js`; marks in `views/guide.js` and `views/live.js`; a new admin Settings tab `live` holding the Recording card; two Dashboard sections. Browser checks go in `devtools/live-ui.mjs` (a new `recordings` section), plus `a11y-ui.mjs` and the old-themes compare.

**Tech Stack:** Plain HTML/CSS/JS (no framework, no dependencies), Node's `node:test` for the server bits, Playwright devtools for the UI.

**Spec:** `docs/superpowers/specs/2026-10-11-atomix-dvr-timeshift-design.md` (sections 3 and 4). Builds on Plan B.

## Global Constraints

- Copy, exactly: "Record", "Record series", "Cancel recording", "Stop series", "Recording scheduled" / "Recording" (visually hidden beside the red dot), "Delete <title>? The file is removed.", "Has a gap (N min missing)" (N rounded up, at least 1), "Stopped to record <title>" (already the player's ended sentence), "Your provider allows N stream(s) at a time — this overlaps M other recording(s)" (from the API, shown as it comes).
- Encrypted channels and radio offer no Record actions (`canRecord` false); Kids profiles never see the actions, the dot, the Recordings link or page (the page shows "Kids profiles can't record" from the 403 and nothing else).
- Older themes stay pixel-identical: `oldthemes-compare.mjs compare` → "all pages match" (no recording is scheduled on those pages).
- TV-remote friendly: every new control reachable by arrows/Tab/Enter; the delete confirmation is in the page (no browser dialogs); focus returns to a sensible place after each action.
- No provider address, header or token in any page or response.

## Review Focus

1. **A programme recorded, then the guide refreshed** — the dot stays (marks match channel + start, not programme id) (Task 1 test).
2. **Cancel recording on a programme of a series** — only that airing is cancelled; the series rule and its other airings stay; "Stop series" is the one that ends the rule (Task 1 test).
3. **Stop on a recording that is starting or finishing** — the page shows it moving to Done (or Failed) without a stuck spinner; a second press does nothing harmful (Task 2 UI check).
4. **A Kids profile opening `#/live/recordings` by its address** — no list, no actions, the sentence only (Task 2 UI check).
5. **Delete on a done recording reached by keyboard** — the in-page confirm takes focus, Cancel returns focus to the row's Delete, OK removes the row and moves focus to the next row (or the section heading) (Task 2 UI check).

---

### Task 1: The programme sheet's Record actions and the red dot

**Files:**
- Modify: `src/api/live.js` (programme details gain `recordingId` (the scheduled/recording airing's id or null) and `ruleId` (a rule whose title and channel match, or null) — grown-ups only), `public/js/live.js` (client calls `recordProgramme(id, opts)`, `cancelRecording(id)`, `stopSeries(ruleId)`), `public/js/views/guide.js` (`openProgramme` actions; the dot in cells), `public/js/views/live.js` (the dot on a row's now/next), `public/css/app.css` (`.rec-dot`)
- Test: `test/live-recordings-api.test.js` (server bits), `devtools/live-ui.mjs` section `recordings` (UI)

**Interfaces:**
- Consumes: Plan B routes `POST /api/live/programmes/:id/record`, `DELETE /api/live/recordings/:id`, `DELETE /api/live/rules/:id`; programme fields `recording`, `repeat`, `canRecord`.
- Produces: `recDot(p) → Element|null` exported from `views/live.js` (red dot + visually hidden "Recording scheduled"/"Recording"), used by the guide, the channel rows and the Recordings page.

- [ ] **Step 1: Write failing tests:**
  - Node: `the programme sheet names its recording and its series` — after Record series on a programme, `GET /api/live/programmes/:id` → `recordingId` = that recording, `ruleId` = the rule; after a guide refresh (new programme ids) the new programme at the same start still has `recording: 'scheduled'` and the same `recordingId`; `DELETE /api/live/recordings/:recordingId` leaves the rule and its other airings scheduled.
  - UI (`live-ui.mjs recordings`): sheet of an upcoming programme on channel 1 shows "Record" and "Record series"; on channel 14 (Secure One, encrypted) and on radio (RNZ National), neither; pressing Record closes the sheet, toasts "Recording scheduled", and the guide cell shows `.rec-dot` with hidden text "Recording scheduled"; reopening shows "Cancel recording"; "Record series" opens the choices (This channel / Any channel, "New episodes only" ticked, Keep: All / Last 5 / Last 10) and, on Record, every matching cell gets a dot; the sheet then offers "Stop series"; a clash toast shows the API's sentence; a Kids profile's sheet has none of these.
- [ ] **Step 2: Run** `node --test test/live-recordings-api.test.js` and `node devtools/live-ui.mjs recordings` — Expected: FAIL.
- [ ] **Step 3: Implement.** The series choices are a second `openDialog` (radio group, checkbox, select). After any action the guide redraws the affected channel rows only.
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 2: The Recordings page

**Files:**
- Create: `public/js/views/recordings.js`
- Modify: `public/js/app.js` (route `/live/recordings`, nav `live`), `public/js/views/live.js` (header button "Recordings", grown-ups only), `public/css/app.css`
- Test: `devtools/live-ui.mjs` section `recordings`, `devtools/a11y-ui.mjs` (the page in its pages list)

**Interfaces:**
- Consumes: `GET /api/live/recordings`, `POST /api/live/recordings/:id/stop`, `DELETE /api/live/recordings/:id`, `PATCH /api/live/rules/:id`, `DELETE /api/live/rules/:id`; `recDot` from Task 1.
- Produces: `render(el)` for the route.

Sections, in order, each an `h2` with a count and an empty sentence when empty: **Recording now** (title, channel, "until 9:03 PM", who scheduled it, **Stop**), **Scheduled** (date and time, channel, who, a clash mark — warning icon + the clash sentence as text, **Cancel**), **Done** (title, "S1 E2 · Pilot" or the date, channel, "Has a gap (N min missing)" when `gapSeconds > 0`, the `error` when set ("Stopped early" / "The recordings folder is full"), **Play** → `#/item/<itemId>` (hidden when no item yet: "Adding to the library…"), **Delete** with the in-page confirm), **Failed** (title, date, the sentence, **Remove**), **Series rules** (title, "This channel: One" or "Any channel", upcoming count, Keep select, "New episodes only" checkbox — each change PATCHes at once and toasts "Saved" — and **Stop series**). The page re-reads every 15 s while open (a recording finishing moves on its own) and after every action.

- [ ] **Step 1: Write failing UI checks** (`live-ui.mjs recordings`): with one scheduled, one recording (a 1-minute programme made through the API on the mock's channel 13), one done (made by the mock flow finishing) and one failed row: each section lists its row; Stop moves the row to Done within 20 s; Delete → the confirm "Delete <title>? The file is removed." takes focus; Cancel returns focus to Delete; OK removes the row and focus lands on the next row's first control or the section heading; a rule's Keep change persists after reload; Stop series empties the rule's scheduled rows; a Kids profile at `#/live/recordings` sees only "Kids profiles can't record"; the a11y check of the page is clean.
- [ ] **Step 2: Run** `node devtools/live-ui.mjs recordings` and `node devtools/a11y-ui.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS.

### Task 3: Settings → Live TV → Recording, and the Dashboard

**Files:**
- Modify: `public/js/views/settings.js` (TABS gains `{ id: 'live', label: 'Live TV', icon: 'live', admin: true }`, shown only when Live TV has a source; its Recording card: Recordings folder text field with the default shown as placeholder `<data>/recordings`, Start early (number 0–30, minutes), End late (0–60), Save → `PUT /api/admin/settings`, errors in the card; the Dashboard's sections "Tuners in use" (table: Channel, Watching, Recording) and "Next recordings" (title, channel, day and time; link "All recordings" → `#/live/recordings`)), `src/api/admin.js` (settings response includes the effective default `recordingsDirDefault`)
- Test: `test/live-recordings-api.test.js`, `devtools/live-ui.mjs` section `recordings`, `devtools/settings-check.mjs`

**Interfaces:**
- Consumes: `GET/PUT /api/admin/settings` (Plan B validation), Dashboard `tuners`, `nextRecordings`.

- [ ] **Step 1: Write failing tests:** Node `the settings say where recordings go by default` (`recordingsDirDefault` = `<data>/recordings`); UI: the Live TV tab's card saves a folder and padding (reload shows them), a relative folder shows "Atomix can't write to that folder" in the card; the Dashboard shows a tuner row "One · dallas · recording <title>" while a recording runs on a watched channel, and the next 3 scheduled recordings.
- [ ] **Step 2: Run** `node --test test/live-recordings-api.test.js`, `node devtools/live-ui.mjs recordings`, `node devtools/settings-check.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then the whole set: `npm test`, `node devtools/live-ui.mjs`, `node devtools/a11y-ui.mjs`, `node devtools/oldthemes-compare.mjs compare` — Expected: all PASS, "all pages match".
