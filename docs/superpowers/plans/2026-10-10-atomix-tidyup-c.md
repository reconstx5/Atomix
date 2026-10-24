# Atomix Round 20 — Plan C (older polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last deferred minors from v0.14–v0.15: shared components, the Orbit theme, lists, and the intro editor.

**Architecture:** Small changes in `public/js/components.js`, `public/js/lists.js`, `public/js/dom.js`, a few views, and `themes/orbit/theme.css`. Pure helpers get Node tests; view and CSS behaviour is checked in the Playwright devtools suites; older themes are guarded by the pixel compare.

**Tech Stack:** Plain ES modules and CSS; `node:test`; Playwright devtools in `/home/claude/devtools`. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-tidyup-design.md` (Plan C section).

## Global Constraints

- No dependencies. Older themes stay pixel-identical: `node /home/claude/devtools/oldthemes-compare.mjs compare` → "all pages match". Only 15B-5 and 15B-8 change Orbit's look on purpose.
- The logo keeps its own colours on Orbit (`--logo-b` no longer follows the accent) — Dallas's choice.
- Accessible name of the watchlist button: exactly "Watchlist"; the state is `aria-pressed`.
- `formatClock(42.97, { tenths: true }) === '0:43.0'`.

## Review Focus

1. **A window resized across 720 px with a row's actions open** — the open sheet or focused button isn't lost; the other form takes over on the next interaction (Task 1 check "row actions follow the window").
2. **An empty music library that gains songs after a scan** — Shuffle all becomes enabled without a reload of the app (Task 1 check).
3. **The intro editor opened and saved with nothing changed on an automatic intro** — no request is sent, the intro stays automatic (Task 3 check).
4. **Orbit at 800 px on a 1× monitor vs a 2× laptop** — large text only on the 2× one (Task 2 check).
5. **`formatClock` near minute and hour boundaries (59.96 s, 3599.96 s)** — rolls over to 1:00.0 / 1:00:00.0, never "0:60.0" (Task 3 test).

---

### Task 1: Components and lists (15B-1, 15B-4, 15B-10, 15B-11)

**Files:**
- Modify: `public/js/components.js` (`rowActions` 389-395), `public/css/app.css` (`.row-actions` / `.row-actions-compact` visibility), `public/js/lists.js` (`watchlistButton` 7-33), `public/js/views/library.js` (Shuffle all 185-205), `public/js/views/lists.js` (`sec()` 43-44), `public/js/views/settings.js` (empties at the "No libraries yet", "No servers connected.", "No collections yet.", "Nobody is watching right now.", "No devices found…", "Nothing matches." lines)
- Test (browser): `a11y-ui.mjs names`, `lists-ui.mjs title lists`, `music-ui.mjs`, `live-ui.mjs admin` (its `edit()` already handles both forms)

**Interfaces:**
- Produces: `rowActions(title, items)` returns one element holding both forms: `.row-actions-wide` (buttons) and `.row-actions-compact` (the `moreButton`); CSS shows wide above 720 px on non-Orbit layouts, compact otherwise (`html[data-layout="orbit"]` or `@media (max-width: 720px)`).

- [ ] **Step 1: Write failing browser checks:** `row actions follow the window` (Settings → Profiles at 1280 px shows the wide buttons; resize to 600 px without reload → the "More options for …" button is the visible one); `the watchlist button's name stays "Watchlist"; aria-pressed carries the state` (toggle twice, name constant, pressed true/false); `Shuffle all is disabled for an empty music library` (a new music library over an empty temp folder: the button has `disabled`, clicking shows no toast; after copying a song in and scanning, reopening the library shows it enabled); `list and settings empties use the empty state` (My Watchlist empty, Settings → Libraries with a fresh data dir is not available → check Collections / Servers panels: an `.empty-state` element, no bare `p` with the old sentence).
- [ ] **Step 2: Run** `node /home/claude/devtools/a11y-ui.mjs names`, `lists-ui.mjs title lists`, `music-ui.mjs` — Expected: the new checks FAIL.
- [ ] **Step 3: Implement:** `rowActions` renders both forms (wide buttons keep their `aria-label`s); CSS hides the one not in use (`display: none`, so it isn't focusable or read); `watchlistButton` sets `aria-label: 'Watchlist'` once and only updates `aria-pressed` and `title`; Shuffle all is `disabled` when the library's first page has no items (the toast branch goes); the listed empties become `emptyState({ title, text })` with the same sentence as text.
- [ ] **Step 4: Run** the same suites plus `live-ui.mjs admin` and `oldthemes-compare.mjs compare` — Expected: ALL PASS and "all pages match".

### Task 2: Orbit theme (15B-5, 15B-6/7, 15B-8)

**Files:**
- Modify: `themes/orbit/theme.css` (large-text media query 111-120; `--bg-rgb` at 70 and its uses 222-230, 302-314, 490, 588-602; `.picker-profile` 529; `.brand` 259)
- Test (browser): `orbit-sizes.mjs` (new check in `fixes`), `orbit-ui.mjs foundations`, `orbit-a11y.mjs`

- [ ] **Step 1: Write failing checks** in `orbit-sizes.mjs fixes`: `800 px at 1× keeps the normal text size; 800 px at 2× gets the large text` (compare `--t-body` computed value under `open({ width: 800, height: 600, deviceScaleFactor: 1 })` vs `2`); `the logo keeps its own colours whatever the accent` (set accent to a strong red, the brand's `--logo-b` computed value equals the theme's default logo colour); `no --bg-rgb is left in the Orbit theme` (fetch `/themes/orbit/theme.css`, no `--bg-rgb` and no `#05050c` outside the `--bg` definition).
- [ ] **Step 2: Run** `node /home/claude/devtools/orbit-sizes.mjs fixes` — Expected: the 3 checks FAIL.
- [ ] **Step 3: Implement:** add `and (min-resolution: 1.5dppx)` to the 600–999 px large-text query; replace each `rgba(var(--bg-rgb), a)` with `color-mix(in srgb, var(--bg) <a×100>%, transparent)` and drop `--bg-rgb`; `.picker-profile`'s ring uses `var(--bg)`; `.brand { --logo-b: <the theme's own logo colour> }` instead of `var(--tint)`.
- [ ] **Step 4: Run** `orbit-sizes.mjs`, `orbit-ui.mjs`, `orbit-a11y.mjs`, `oldthemes-compare.mjs compare` — Expected: ALL PASS; "all pages match".

### Task 3: Clock text and the intro editor (14-4/5)

**Files:**
- Modify: `public/js/dom.js` (`formatClock` 169-178), `public/js/views/item.js` (`introDialog` 173-219)
- Create: `test/dom.test.js`
- Test (browser): `qol-ui.mjs intro`

- [ ] **Step 1: Write failing tests:** `test/dom.test.js` — `formatClock rounds to tenths before splitting`: `formatClock(42.97, {tenths:true}) === '0:43.0'`, `(59.96) → '1:00.0'`, `(3599.96) → '1:00:00.0'`, `(12.34) → '0:12.3'`, without tenths `(42.97) → '0:42'` unchanged; qol-ui intro: `saving the intro editor unchanged sends nothing and keeps the automatic intro` (count PUTs to `/markers/intro` with `page.on('request')`; source stays automatic).
- [ ] **Step 2: Run** `node --test test/dom.test.js` and `qol-ui.mjs intro` — Expected: FAIL.
- [ ] **Step 3: Implement:** `formatClock` rounds `seconds` to tenths first when `tenths` is set, then splits; `introDialog` compares the parsed start/end (and the season tick) with what it opened with and closes without a request when nothing changed.
- [ ] **Step 4: Run** `node --test test/dom.test.js` and `qol-ui.mjs` — Expected: PASS.
