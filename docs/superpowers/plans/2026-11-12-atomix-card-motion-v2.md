# Card motion v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Film/episode/show cards feel premium: a richer selection, a short silent clip on rest, the card growing into the title page, and rows that load without grey flashes.

**Architecture:** A new background `clip` job makes a 5-second, 640-px, silent H.264 clip per title (trailer file first); cards fetch it through `/api/items/:id/clip`. A dominant colour per artwork (migration 32) becomes each card's `tint` placeholder and glow. Selection, ripple and opening are CSS tokens retuned by `html[data-motion]`, with small JS in `card-motion.js` and `transitions.js`.

**Tech Stack:** Node ≥ 22.13 (`node:test`, `node:sqlite`), ffmpeg, Preact 11 + htm (vendored), CSS view transitions. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-12-atomix-card-motion-v2-design.md`

## Global Constraints

- Follow the `web-animation` skill: only `transform`/`opacity` animate; no `transition: all`; no `will-change` in static CSS; focus ring/outline appears on the same frame and never transitions; hover effects behind `@media (hover: hover) and (pointer: fine)`; a held arrow (`html.nav-held`) skips every tween.
- Three tiers on `html[data-motion]`: full (everything) · reduce (fades only: no scale, lift, rise, dim, sheen, morph, clip) · none (instant).
- Older themes pixel-identical **at rest** (`devtools/fixed-compare.mjs`).
- Clip: 5 s, 640 px wide, H.264 Main, yuv420p, no audio, `+faststart`, `data/previews/<item>/clip.mp4`; start 35 % in (after the intro/recap marker when known); trailer file (extra_kind 'trailer') preferred, from 15 % in; no clip for remote titles.
- Card preview: rest 1200 ms; muted, playsinline, once, ≤ 5 s; shown only after its first `playing`; off for reduce/none, data-saver/2g, Kids, profile pref `cardPreviews` false, hidden page; one at a time.
- Settings copy: admin "Make preview clips for cards" (Settings → Server, on); profile "Play previews on cards" (Settings → Profile, on).
- Numbers: focus scale poster 1.06 / wide 1.03, hover 1.04 / 1.02, lift −4 px, neighbour dim 0.78, info rise 6 px 160 ms (+80 ms delay), sheen 450 ms opacity ≤ 0.18 once per card per page, ripple 20 ms steps ≤ 300 ms total with 8 px rise, art fade-in 180 ms, opening stagger 20 ms ≤ 200 ms.
- Kids rules and per-account stream caps keep working; clips follow item visibility.
- Test first (RED → GREEN) for every task.

## Review Focus

1. Arrowing quickly along a row (held key): no tween, no clip request, no sheen — the focus ring keeps up.
2. A clip that fails to load or `play()` rejects (iOS Low Power Mode, a 404): the still-frame flip or the poster, never a black box.
3. Back from a title page whose card is no longer in view (row scrolled, page re-rendered): focus and scroll restore without a broken morph.
4. A card whose image is already cached: shows instantly (no fade, no tint flash).
5. Old TV browsers (no view transitions, no `@property`): the no-animation path looks finished.

---

### Task 1: Preview clips on the server

**Files:**
- Create: `src/extras/clips.js` (`clipArgs({ file, start, duration, width, hdrFilter })`, `clipStart(item, markers, isTrailer)`, `makeClip(...)`)
- Modify: `src/extras/store.js` (`nextClipItem`, `CLIP_PENDING`, `pendingCounts.clips`), `src/extras/jobs.js` (`clip(item)`), `src/tasks.js` (job order: after previews/intros/thumbs, before lyrics; label "Preview clip"), `src/settings.js` (`cardClips: true`), Settings → Server UI (switch "Make preview clips for cards"), `src/api/items.js` or wherever `/api/items/:id/previews` lives (manifest `clip: boolean`; `GET /api/items/:id/clip` with Range, 404, visibility), `src/api/account.js` (profile pref `cardPreviews: 'boolean'`), Settings → Profile UI ("Play previews on cards")
- Test: `test/clips.test.js`

**Interfaces:**
- Produces: `GET /api/items/:id/clip` (video/mp4, Range, `Cache-Control: private, max-age=86400`); previews manifest `{ …, clip: boolean }`; status `prefs.cardPreviews` (default true).

- [ ] **Step 1: Failing tests:** `clipArgs` contains `-ss <start> -i <file> -t 5 -an -vf scale=640:-2,format=yuv420p -c:v libx264 -profile:v main -movflags +faststart`; `clipStart` = 35 % of duration, or just after an intro/recap marker end when that is later and still < duration − 5; trailer → 15 %; a remote item is never picked; the job writes `clip.mp4` for a real 20 s test film (helpers `makeVideo`) under 5.5 s long, no audio stream, ≤ 640 px wide; `/api/items/:id/previews` says `clip: true`; `GET …/clip` → 200 `video/mp4`, Range 206; Kids profile on an 18 film → 404/403 as the film itself; `cardClips: false` → nothing made; a changed file (mtime) → redone; profile pref `cardPreviews` round-trips.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** PASS; `node --test test/clips.test.js test/extras-*.test.js test/tasks.test.js test/passover-subtitles.test.js` pass.

### Task 2: Dominant colours

**Files:**
- Modify: `src/db.js` (migration 32: `ALTER TABLE items ADD COLUMN colors TEXT`), `src/library/thumbs.js` (or the artwork copy path: compute an 8×8 average with a mild saturation boost via ffmpeg `scale=8:8` raw RGB, store `{ poster, backdrop }`), the item/list serialisers used by Home, libraries, lists, search (`tint` per card: poster colour for poster cards, backdrop for landscape)
- Create: `src/library/colors.js` (`dominantColor(rgbBuffer) → '#rrggbb'`, `colorOfImage(ffmpegPath, file)`)
- Test: `test/colors.test.js`

**Interfaces:**
- Produces: card data `tint: '#rrggbb' | null`.

- [ ] **Step 1: Failing tests:** `dominantColor` of a solid red 8×8 buffer → `#ff0000`-ish (each channel within 8); of a grey → unchanged grey (no boost on grey); a real generated red poster through `colorOfImage` → red; after a scan + artwork request the item has `colors.poster`; `/api/home` and `/api/libraries/:id/items` cards carry `tint`; an item without artwork → `tint: null`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (lazy: first artwork copy computes it; never blocks a request — returns null until stored). **Step 4:** PASS; library/home tests pass.

### Task 3: Selecting a card

**Files:**
- Modify: `public/css/app.css` (tokens on `:root` + `[data-motion]` overrides; card lift/glow pseudo-element/dim/info strip/sheen), `themes/orbit/theme.css` / `public/css/orbit.css` where Orbit's card focus lives, `public/js/ui/cards.js` + `public/js/components.js` (card markup: glow layer, info strip text from existing fields, `style="--tint:…"`), `public/js/card-motion.js` (row `has-selected` class for neighbour dimming; sheen once per card per page)
- Test: `test/card-motion-rules.test.js` (pure helpers: info line text, sheen-once bookkeeping), browser check `devtools/card-select.mjs`

- [ ] **Step 1: Failing tests:** info line for a film "2019 · PG-13 · 1 h 52 m", an episode "S2 · E4 · 45 m", a show "2014 · 3 seasons"; sheen bookkeeping fires once per card id per page and resets on route change. Browser (Orbit + Arctic, desktop 1917×992 and phone 390×844): focused poster's art transform scale ≈ 1.06 and translateY −4; glow layer opacity 1; neighbours 0.78; info strip visible; `nav-held` → computed transition-duration 0 on art; reduce → scale 1, neighbours 1, info strip fades; none → instant; hover only with a fine pointer.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; `devtools/fixed-compare.mjs` older themes identical at rest.

### Task 4: Live preview in the card

**Files:**
- Modify: `public/js/card-motion.js` (rest 1200 ms; clip path with one `<video>`; fallback to the flip; stop conditions; gates), `public/css/app.css` (`.card-clip` layer)
- Test: `test/card-motion-gates.test.js` (pure `previewAllowed({ motion, saveData, effectiveType, kids, pref, hidden })`), browser check `devtools/card-clip.mjs`

**Interfaces:** Consumes `clip` flag and `/api/items/:id/clip` (Task 1), `prefs.cardPreviews`.

- [ ] **Step 1: Failing tests:** `previewAllowed` false for each gate; true for full/default. Browser: rest 1.3 s on a film with a clip → a `video.card-clip` appears, `currentTime > 0`, never visible before `playing`; move focus → video removed within 300 ms and its `src` cleared; held arrow → no `/clip` request at all; film without a clip → still-frame flip; `play()` rejected (stubbed) → flip; Kids profile and pref off → no video.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.

### Task 5: Opening a title

**Files:**
- Modify: `public/js/transitions.js` (shared names on card art ↔ title backdrop and card title ↔ page title, set just before, cleared after `finished`; data fetched before the transition; stagger class on the title page's first-screen blocks; Back reverses into the same card and focuses it), `public/js/views/item.js` (mark first-screen blocks), `public/css/app.css`
- Test: browser check `devtools/card-open.mjs`

- [ ] **Step 1: Failing checks:** opening a film from Home in full motion runs a view transition whose old/new snapshots include the named art (assert via `document.getAnimations()` on `::view-transition-*` or a test hook), the first-screen blocks get the stagger (≤ 200 ms total); Back focuses the same card (`document.activeElement` is that card) and its row's scrollLeft is restored; reduce → crossfade only (no named groups); no view transitions (stubbed away) → instant swap; card scrolled out of view before Back → no error, focus restored.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.

### Task 6: Rows and loading

**Files:**
- Modify: `public/js/ui/cards.js`, `public/js/components.js` (art box paints `--tint` until decoded; `img.decode()` then 180 ms fade; cached → no fade), `public/js/views/home.js`, `public/js/views/library.js` (first-mount ripple of the first screenful only; not on Back or re-render), `public/js/nav.js` or wherever row arrow scrolling lives (single press smooth, held instant — verify first, change only what differs), `public/css/app.css`
- Test: browser check `devtools/card-load.mjs`

- [ ] **Step 1: Failing checks:** with artwork requests delayed 800 ms, a card's art shows its tint colour (not grey) before the image, no layout shift (Home CLS 0 via PerformanceObserver), then the image fades in; a cached image appears with no fade; first visit to Home ripples the first screenful (computed animation delays 0, 20, 40 ms…), Back to Home doesn't; held arrow along a row scrolls with `behavior: 'instant'`, a single press smooth; reduce → fade only, none → nothing.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; `devtools/fixed-compare.mjs` identical at rest.

### Task 7: Release

**Files:** `CLAUDE.md` (Motion section), `devtools/README.md`, project doc `claude/round-30-v028.md`

- [ ] **Step 1:** full suite in 6 groups, all green (known timing tests rerun alone).
- [ ] **Step 2:** every devtools check above plus `skip-ui.mjs`, `iphone-channels.mjs`, `fixed-compare.mjs`; a Performance trace while arrowing a row shows no layout/paint on the moving cards.
- [ ] **Step 3:** one fresh whole-branch review; one fix wave.
- [ ] **Step 4:** deliver to `D:\Nodeflix` (hash-check PC files against the last delivery first; re-hash after).
