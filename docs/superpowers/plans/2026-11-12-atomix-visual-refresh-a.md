# Visual refresh — Plan A (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every theme shares one token system with automatic contrast checks, readable TV text sizes, a two-cue focus ring, a tested scrim for text on artwork, and an accent picker with a readability clamp.

**Architecture:** Each theme file defines 12-step OKLCH neutral and accent ramps (with hex fallbacks); `public/css/tokens.css` maps them to semantic and component tokens and keeps the old token names as aliases. A Node APCA module checks every theme's text tokens. TV sizes, focus and the scrim are token-driven CSS shared by all layouts. The accent picker reuses `public/js/tint.js`.

**Tech Stack:** CSS custom properties, OKLCH (with hex fallbacks), Node `node:test`, Preact/htm, Playwright devtools checks.

**Spec:** `docs/superpowers/specs/2026-11-12-atomix-visual-refresh-design.md` (section A)

## Global Constraints

- Dallas approved changing every theme's look ("Yes, improve them all"); the old "pixel-identical" rule is lifted for this work only, and each visual change gets before/after pictures (devtools/fixed-compare.mjs captures). Motion rules (Capture / card motion v2) still hold: focus rings never transition; only transform/opacity animate.
- Back-compat: old token names (`--bg --bg-2 --surface --surface-2 --border --text --text-dim --accent --accent-text --radius --radius-lg --shadow --nav-bg --font --font-display`, Orbit `--t-*`) keep working; a user theme folder that defines only old names loads and looks as before.
- Every OKLCH value has a hex fallback declaration immediately before it (old TV browsers).
- APCA thresholds: `--text-high` Lc ≥ 75, `--text-low` Lc ≥ 60 on `--app-bg` and each `--surface-*`; `--on-accent` on `--accent-solid` Lc ≥ 60; `--focus-ring` vs `--app-bg` WCAG ≥ 3:1.
- TV (≥ 1600 px wide landscape) floors at 1080p: caption ≥ 20 px, metadata/card titles ≥ 24 px (Orbit card 22), body 24–28 px; metadata weight ≥ 500.
- Focus: outline ring `--focus-width` 3 px (4 px TV) + lift or fill; 1 px contrasting halo; never colour alone.
- Accent clamp: dark themes OKLCH L 70–80 %, C 0.10–0.15; Daylight L 45–55 %; `--on-accent` black or white by APCA.
- Test first; no new dependencies.

## Review Focus

1. A user-made theme folder copied from an old Midnight (only old token names): loads and looks as before.
2. An old TV browser without OKLCH support: every surface and text colour still set (hex fallbacks) — nothing transparent or black-on-black.
3. A very light or very dark custom accent (e.g. #ffff00, #101010): clamped, readable button text, visible focus.
4. Forced-colours mode (Windows High Contrast): the focus ring is still visible (outline-based).
5. Orbit on a 1366 × 768 laptop: the TV type floor does not apply (sizes unchanged there).

---

### Task 1: APCA and the token checker

**Files:** Create `src/themes/apca.js` (`apcaContrast(textRgb, bgRgb) → Lc`, `wcagRatio(a, b)`, `parseColor(str) → {r,g,b,a}` incl. hex, rgb(a), oklch()), `src/themes/tokens.js` (`readThemeTokens(cssText) → Map`, resolves `var()` chains within a file + tokens.css, composites alpha on a given background). Test: `test/apca.test.js`.

- [ ] Failing tests: APCA reference pairs from the APCA-W3 0.1.9 README (e.g. #888 on #fff ≈ Lc 63.1, #fff on #888 ≈ Lc −68.5, #000 on #fff ≈ 106.0, #fff on #000 ≈ −107.9 — use the published values; assert within ±0.5); WCAG #777/#fff ≈ 4.48; `parseColor('oklch(94% 0.005 260)')` ≈ known sRGB; `readThemeTokens` resolves `--a: var(--b)`, falls back through `var(--x, #123)`, composites `rgba(255,255,255,.12)` on #000.
- [ ] RED → implement → GREEN.

### Task 2: Token layers in every theme

**Files:** Create `public/css/tokens.css` (semantic + component tokens + old-name aliases + radius scale + focus tokens), link it in `public/index.html` before the theme stylesheet (check how theme CSS is injected in `app.js applyTheme` and the shell file list in `src/api/shell.js`); modify all seven `themes/*/theme.css` to define `--n-1..12` and `--a-1..12` (OKLCH + hex fallbacks) chosen so the semantic results are close to today's colours (this task restructures; Plan C retunes). Test: `test/theme-tokens.test.js`.

- [ ] Failing tests: for each built-in theme, every semantic token resolves; APCA thresholds from Global Constraints hold (for Orbit also against Tinted glass `rgba(… , .55)` composited on its darkest and lightest environment tint — read these from orbit.css/backdrop values); a fixture "legacy" theme (old names only) resolves `--bg/--text` to its own values; baseline count of raw colour literals outside token blocks in `public/css/*.css` recorded in `test/fixtures/raw-colours.json` and must not grow.
- [ ] RED → implement (fix any theme that fails contrast by moving the failing token one ramp step; record each change in the report) → GREEN.
- [ ] devtools/fixed-compare.mjs (ART=1, PAGES '#/,#/library/1,#/item/1,#/live,#/settings') before/after; report differences per theme with screenshots kept under devtools/out/visual-a/.

### Task 3: TV type floor

**Files:** `themes/orbit/theme.css` (`--t-caption` 20, `--t-meta` 24, `--t-body` 26, `--t-card` 22 × `--px`), `public/css/tokens.css` / `public/css/app.css` (a `@media (min-width: 1600px) and (orientation: landscape)` block raising every other theme's small text to the floors), metadata weight ≥ 500. Test: browser check `devtools/type-floor.mjs`.

- [ ] Failing check: at 1920×1080 on Home, a library, a title page, Live TV and Settings, in every theme, no visible text element computes below 20 px; metadata/card titles ≥ 22/24 px per Global Constraints; at 1366×768 Orbit sizes unchanged from before (compare to a recorded baseline).
- [ ] RED → implement → GREEN; Orbit rows still show ≥ 5.5 posters per TV row (assert).

### Task 4: Focus with two cues

**Files:** `public/css/tokens.css` (`--focus-ring`, `--focus-width`, `--focus-offset`, halo), `public/css/app.css` + each theme (replace box-shadow-only focus with outline ring + existing lift/fill; Harbour keeps its growth plus the ring), row gutters from the growth factor. Test: `devtools/focus-check.mjs`.

- [ ] Failing check: in every theme, a focused card, button, chip, menu entry and settings toggle shows an outline (computed `outline-style` not none, width ≥ 3 px desktop / 4 px TV) with ≥ 3:1 against the page background; with `forced-colors: active` emulated the ring remains; a lifted card's box doesn't overlap its neighbour's box; no transition on outline.
- [ ] RED → implement → GREEN.

### Task 5: Scrim for text on artwork

**Files:** `public/css/tokens.css` (`--scrim-bottom` 13-stop eased gradient, `--scrim-left`, radial edge), apply in spotlight/hero (Orbit, Arctic, others), detail header, landscape card captions, Live TV cards. Test: `devtools/scrim-check.mjs`.

- [ ] Failing check: with every backdrop/poster replaced by a pure white image (page.route), the spotlight synopsis, title and metadata, the detail-page metadata and the landscape card captions reach WCAG ≥ 4.5:1 (sample the pixels behind the text's bounding box after render) in every theme.
- [ ] RED → implement → GREEN.

### Task 6: Accent for every theme, clamped

**Files:** `public/js/tint.js` (`clampAccent(hex, scheme) → hex`, `accentRamp(hex, scheme) → 12 steps`, `onAccent(hex) → '#000'|'#fff'` via APCA), `public/js/app.js` (apply for every theme: set `--a-1..12`, `--accent-solid`, `--on-accent`), Settings → Appearance accent picker shown for every theme with 10 swatches + "Custom…" hex field (validation sentence "Enter a colour like #3a7bff."). Test: `test/accent-clamp.test.js`, `devtools/accent-check.mjs`.

- [ ] Failing tests: `clampAccent('#ffff00','dark')` lands in L 70–80 %, C ≤ 0.15, hue ≈ 110; `clampAccent('#101010','dark')` lands in L 70–80 %; Daylight clamps to L 45–55 %; `onAccent` gives Lc ≥ 60; browser: picking a custom hex in Midnight, Daylight and Orbit changes buttons and the focus ring stays ≥ 3:1.
- [ ] RED → implement → GREEN.

### Task 7: Release

- [ ] Full suite in 6 groups; all devtools checks (type-floor, focus-check, scrim-check, accent-check, card-select, card-open, card-load, iphone-channels); CLAUDE.md: replace the "pixel-identical" constraint with "every theme passes the token checks; visual changes get before/after pictures"; docs/THEMES.md: the token layers and how to make a theme.
- [ ] Before/after gallery of Plan A's changes for Dallas (artifact page).
- [ ] Final whole-branch review, one fix wave, deliver to D:\Nodeflix (hash-check first).
