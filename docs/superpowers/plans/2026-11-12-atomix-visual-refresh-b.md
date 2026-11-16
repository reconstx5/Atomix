# Visual refresh — Plan B (choices and polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Profiles can choose how much glass they see, turn on OLED black / High contrast / Large text over any theme,
pin and order their libraries in the menu, and every theme gets the shared polish pieces (logo box, metadata chips,
badges, progress track, watched mark, skeletons).

**Architecture:** One pure module `public/js/appearance-rules.js` decides every choice from prefs + device facts (Node
tested); `app.js` turns the decisions into `html` attributes (`data-glass`, `data-oled`, `data-contrast`) and
`--text-scale`; CSS in `tokens.css` / `orbit.css` / themes reacts to those attributes through tokens. Pinned libraries
reorder the existing nav builders (`shell.js` Orbit, `app.js` other layouts). Shared pieces extend `components.js`
(and its Preact twin `ui/cards.js`) plus a media summary field on the server.

**Tech Stack:** CSS custom properties, Preact/htm + `h()` DOM helpers, Node `node:test`, Playwright devtools checks.

**Spec:** `docs/superpowers/specs/2026-11-12-atomix-visual-refresh-design.md` (section B). Builds on Plan A
(`docs/superpowers/plans/2026-11-12-atomix-visual-refresh-a.md`, merged d0ba82e).

## Global Constraints

- Everything from Plan A still holds: token checks pass for every theme **and every mode**, no unguarded
  `color-mix()`/`oklch()` (test/old-browsers.test.js), TV floor, two-cue focus, motion rules (rings/shadows never
  transition, only transform/opacity tween, `html.nav-held` stops tweens).
- Prefs are per profile, saved through `PATCH` prefs → `cleanPrefs` in `src/api/account.js`; unknown/invalid values are
  dropped, never stored. Absent pref = today's behaviour.
- Glass: `glass` ∈ 'clear' | 'tinted' | 'solid'. `--glass-alpha` Clear .12, Tinted .55, Solid .92; `--glass-blur` Clear
  16px, Tinted 16px, Solid 0. Default Tinted on desktop/phone; Solid on TV-size screens (`(min-width:1600px) and
  (orientation:landscape)`) and where `backdrop-filter` is unsupported; `prefers-reduced-transparency: reduce` forces
  Solid. Existing `reduceEffects: true` reads as 'solid'. Paragraph panels never below alpha .66. No glass on scrolling rows.
- Modes: `oled` boolean, `contrast` 'more' | 'normal' (unset = follow `prefers-contrast: more`), `textScale` 1 | 1.15 | 1.3.
- `pinnedLibraries`: ordered list of library ids (max 50, positive ints, unknown ids ignored at render); absent = today.
- Copy is plain English sentences. Kids profiles get every choice here (none is unsafe); stream caps untouched.
- Every visual change gets before/after pictures; test first; no new dependencies.

## Review Focus

1. A profile saved with `reduceEffects: true` before this change opens in Solid glass and its Settings shows "Solid".
2. A pinned library that is later deleted, or that a Kids profile may not see (`libraryAccess`), never shows and never breaks
   the menu order.
3. Large text 1.3 on a phone (390×844) and on Orbit TV: no horizontal scroll, row cards still usable, dialogs fit.
4. OLED + High contrast + Daylight together: still readable (token checks cover combined modes).
5. Old TV browser (no `backdrop-filter`, no `:has()`): Glass Clear/Tinted fall back to Solid colours, nothing transparent.

---

### Task 1: Appearance rules and prefs

**Files:** Create `public/js/appearance-rules.js`; modify `src/api/account.js` (`PREF_KEYS`, `cleanPrefs`). Tests:
`test/appearance-rules.test.js`, `test/appearance-prefs.test.js`.

**Produces:**
- `glassMode(prefs, env) → 'clear'|'tinted'|'solid'` with `env = { tv, backdropFilter, reducedTransparency }`.
- `contrastMode(prefs, env) → 'more'|'normal'` with `env.prefersMore`.
- `textScale(prefs) → 1|1.15|1.3`.
- `orderLibraries(libraries, pinned) → { pinned: Library[], rest: Library[] }` (pinned in pref order, only ids present
  in `libraries`; `pinned` absent/empty → `{ pinned: libraries, rest: [] }`).
- `movePinned(pinned, id, dir) → number[]` (`dir` ∈ -1 | 1 | 'pin' | 'unpin'; pin appends, unpin removes).
- Server prefs: `glass` (oneOf), `oled` boolean, `contrast` (oneOf 'more'|'normal'), `textScale` (oneOf 1, 1.15, 1.3),
  `pinnedLibraries` (new type `'ids'`: array → unique positive ints, max 50; anything else dropped).

- [ ] Failing tests: `glassMode({reduceEffects:true},{})` → 'solid'; `glassMode({},{tv:true})` → 'solid';
  `glassMode({glass:'clear'},{reducedTransparency:true})` → 'solid'; `glassMode({},{backdropFilter:false})` → 'solid';
  `glassMode({},{backdropFilter:true})` → 'tinted'; `glassMode({glass:'clear'},{tv:true,backdropFilter:true})` → 'clear'
  (an explicit choice beats the TV default); contrast unset + prefersMore → 'more', `contrast:'normal'` + prefersMore → 'normal';
  textScale 1.3 → 1.3, 2 → 1; orderLibraries with pinned `[3,1,99]` over libs 1..4 → pinned [3,1], rest [2,4];
  movePinned up/down/pin/unpin at the edges. Server: PATCH prefs with `{glass:'foggy'}` stores nothing,
  `{pinnedLibraries:[2,'2',-1,'x',3]}` stores `[2,3]`, `{textScale:1.15}` stored, `{pinnedLibraries:null}` clears.
- [ ] RED → implement → GREEN; commit.

### Task 2: Glass setting

**Files:** `public/js/app.js` (apply `data-glass`; keep `html.reduce-effects` set exactly when glass is 'solid', so
card-motion and the old CSS keep working), `public/css/tokens.css` (`--glass-alpha`, `--glass-blur` per
`[data-glass]`, panel floor `--glass-panel-floor: .66`), `themes/orbit/theme.css` (its glass tokens per mode: Clear =
today's values, Tinted = clear surfaces raised to the tinted alpha, Solid = today's reduce-effects block; paragraph
panels `max(alpha, .66)`), other themes' blurred bars use `--glass-blur`, `views/settings.js` (a "Glass" choice of three,
roving radios like the existing ones, hint "How see-through menus and panels are. Solid is easiest to read and fastest on
TVs.", replacing the Reduce effects switch). Check: `devtools/glass-check.mjs`.

**Consumes:** `glassMode` (Task 1). Env from `matchMedia('(min-width:1600px) and (orientation:landscape)')`,
`CSS.supports('backdrop-filter','blur(1px)') || CSS.supports('-webkit-backdrop-filter','blur(1px)')`,
`matchMedia('(prefers-reduced-transparency: reduce)')`; re-evaluated on change.

- [ ] Failing check: in Orbit at 1366×768, the menu's computed background alpha / backdrop-filter match each mode
  (clear ≈ today, tinted ≥ .55, solid ≥ .92 and `none`); Details/side panels ≥ .66 in Clear; at 1920×1080 with no pref the
  mode is solid; a profile with `reduceEffects:true` shows Solid selected; no element inside `.row`/`.grid` has a
  backdrop-filter in any mode; every theme renders all three modes with text-token checks passing (extend
  `test/theme-tokens.test.js` with `context.attrs['data-glass']` for Orbit's Tinted and Solid).
- [ ] RED → implement → GREEN; before/after pictures (Orbit Home + title, 3 modes) in `devtools/out/visual-b/task-2/`; commit.

### Task 3: OLED, High contrast, Large text

**Files:** `public/js/app.js` (`data-oled`, `data-contrast`, `--text-scale`), `public/css/tokens.css`
(`html[data-oled]`: `--n-1` #000, `--n-2`/`--n-3` one and two steps up, hairline `--border-subtle` on cards and panels,
Orbit environment layer hidden; `html[data-contrast="more"]`: opaque surfaces, 2px `currentColor` borders on controls
and cards, `--text-low: var(--text-high)` and `--text-dim: var(--text)`, `--focus-width` 4px; `html { font-size:
calc(100% * var(--text-scale, 1)) }` for the rem-based themes), `themes/orbit/theme.css` (`--t-*` × `--text-scale`),
`views/settings.js` (two switches "True black (for OLED screens)" and "More contrast", a "Text size" choice Normal /
Large / Largest). `@media (forced-colors: active)`: no background images behind text (backdrop and scrim hidden).
Check: `devtools/modes-check.mjs`; tokens: `test/theme-tokens.test.js`.

**Consumes:** `contrastMode`, `textScale` (Task 1); env `matchMedia('(prefers-contrast: more)')`.

- [ ] Failing tests: token checks pass for every theme × {oled, contrast more, both} (via `context.attrs`); OLED `--app-bg`
  resolves to #000 in every theme; contrast-more `--text-low` equals `--text-high`.
- [ ] Failing check: computed body background #000 with OLED; a card and a button have a ≥2px border with More contrast;
  `.card-title` font-size × 1.3 vs normal (±1px) in Midnight and Orbit; with Large text 1.3 at 390×844 and 1920×1080 no
  horizontal scroll on Home, a library, a title page, Settings; emulated `forcedColors:'active'` hides `.backdrop`/`.scrim`.
- [ ] RED → implement → GREEN; before/after pictures; commit.

### Task 4: Pinned libraries

**Files:** `public/js/shell.js` (Orbit rail and dock: pinned libraries in order; unpinned under "More libraries", an entry
that opens the existing More panel with them), `public/js/app.js` (`renderNav` for top/side layouts: same split, "More"
entry opening a sheet of the rest), a library entry's context menu (`contextmenu` event = long-press / menu key / right
click) and a "…" button shown on hover (`@media (hover:hover) and (pointer:fine)`) both open `openSheet` with Pin / Unpin
/ Move up / Move down, `views/settings.js` (section "Menu": each library a row with a Pin switch and Move up / Move down
buttons, remote-friendly; a sentence "Pinned libraries show in the menu in this order. The rest are under More.").
Re-render the nav after a change without a reload. Check: `devtools/pinned-check.mjs`.

**Consumes:** `orderLibraries`, `movePinned` (Task 1). Libraries come from `state.libraries` (already filtered by the
profile's `libraryAccess`), so hidden or deleted ids never render.

- [ ] Failing check: with `pinnedLibraries` [lib 3, lib 1] the Orbit rail, the phone dock (first three entries) and Arctic
  Side's list show lib 3 then lib 1 and the rest only under More; a pinned id that does not exist is ignored; Move up in
  Settings changes the rail order immediately; the sheet's Pin/Unpin works; with no pref the menus match BASE markup.
- [ ] RED → implement → GREEN; commit.

### Task 5: Shared polish pieces

**Files:** `src/api/serialize.js` (`mediaSummary` adds `hdrFormat` 'Dolby Vision' | 'HDR10' | 'HLG' | null from
`video.dolbyVision` / `colour.transfer` (smpte2084 → HDR10, arib-std-b67 → HLG), and `atmos` true when an audio track's
`profile` or `title` mentions Atmos), `public/js/components.js` + `public/js/ui/cards.js` (twins):
- `mediaChips(item) → Node|null`: outlined chips from media info, in order 4K, Dolby Vision/HDR10/HLG, Atmos, 5.1/7.1,
  Subtitles; replaces the HDR text in `mediaFlags` on the title page and spotlight (codec words stay in Details).
- Logo box: `.logo-box` fixed height (title page `clamp(64px, 15% of hero height, 160px)`, spotlight token), max width
  40 %, `object-fit: contain`, left/bottom aligned, drop shadow; the typed title sits in the same box until the logo loads
  and stays if it fails — no layout shift.
- Badges: top-left, `--surface-3` + `--text-high`, short words ("12 unwatched" stays a number with that label, "New" for a
  show/podcast with `newCount`); only badges Atomix computes today.
- Progress track: 3px (4px TV), flush with the card's bottom edge, track `--n-6`, fill `--accent-solid`.
- Watched mark: a tick in a small disc, top-right.
- Skeletons: `skeleton(kind)` shaped like the page (Home: a hero block + two rows of poster shapes; library: a grid;
  title: hero + text bars); the router shows it instead of the spinner only after 1 s of waiting; shimmer white .06,
  none under reduce motion and on TV.
Tests: `test/serialize-media.test.js` (or the existing serialize test), `devtools/polish-check.mjs`.

- [ ] Failing tests: summary of a DV file → `hdrFormat 'Dolby Vision'`; smpte2084 → 'HDR10'; arib → 'HLG'; SDR → null;
  E-AC-3 with profile "Dolby Digital Plus + Dolby Atmos" → `atmos: true`.
- [ ] Failing check: title page with the logo request delayed 2 s has CLS 0 (PerformanceObserver layout-shift) and shows
  the typed title meanwhile; chips present for a 4K HDR dev item; progress track height 3px desktop / 4px TV and flush
  (bottom edge = card art bottom); watched disc visible; with the item API delayed 600 ms no skeleton appears, delayed
  2 s a skeleton appears after ~1 s and the spinner never shows; no shimmer animation under reduce motion or at TV size.
- [ ] RED → implement → GREEN in every theme; before/after pictures; commit.

### Task 6: Release

- [ ] Full suite in 6 groups; all devtools checks (Plan A's plus glass-check, modes-check, pinned-check, polish-check).
- [ ] CLAUDE.md "Visual refresh B" section; docs/THEMES.md (modes and glass tokens a theme can use).
- [ ] Before/after gallery of Plan B (artifact page, same style as Plan A's).
- [ ] Final whole-branch review on the most capable model, one fix pass, merge, deliver to D:\Nodeflix (hash-check first).
