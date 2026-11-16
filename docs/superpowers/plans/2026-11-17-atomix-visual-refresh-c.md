# Visual refresh — Plan C (each theme + gallery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each built-in theme gets its own look from spec section C: Orbit, Arctic, Arctic Side, Midnight, Obsidian,
Daylight and Harbour. Dallas reviews every theme in a before/after gallery: 7 themes × 3 screen sizes × 5 pages.

**Architecture:** Section C becomes a table of per-theme rules (`test/theme-rules.test.js`). The table is checked
through the existing token resolver (`src/themes/tokens.js`) and one shared OKLCH helper. This means every theme
retune starts as a failing Node test. Ramps are still made by `devtools/ramp.mjs` from per-theme anchors, which now use
the browser's OKLCH maths in `public/js/tint.js` instead of a second copy. The few things a theme can do that are not
colours (True black by default, artwork tint, the backdrop following focus) become flags in `theme.json`. `app.js` reads
those flags once; nothing new checks theme names in code. Layout facts that need a browser (posters per TV row, player
chrome over white video) go in one Playwright check, `devtools/theme-check.mjs`. The gallery is captured with
`fixed-compare.mjs` (frozen data, a fixed clock and ART=1) before Task 2 and again after the last theme task.

**Tech Stack:** CSS custom properties (hex with `oklch()` inside `@supports`), Preact/htm, Node `node:test`,
Playwright devtools checks (Chromium installed outside the repo), Python Pillow for the gallery's JPEGs.

**Spec:** `docs/superpowers/specs/2026-11-12-atomix-visual-refresh-design.md`, section C (and "Testing", "Risks").
Builds on Plans A and B (`docs/superpowers/plans/2026-11-12-atomix-visual-refresh-a.md`, `…-b.md`) and on
`docs/HANDOFF-2026-11.md` ("Decisions taken on Dallas's behalf").

## Global Constraints

- No dependencies, no build step, Node ≥ 22.13. Playwright and Pillow are dev tools outside the repo.
- Everything from Plans A and B still holds:
  - Token checks pass for every theme in both `modern` and `legacy` and in every mode combination.
  - APCA minimums: `--text-high` and `--text` ≥ Lc 75, `--text-low` and `--text-dim` ≥ Lc 60, on every surface.
  - No unguarded `color-mix()` or `oklch()`: test/old-browsers.test.js, with a baseline that may only shrink.
  - Raw-colour baseline (`test/fixtures/raw-colours.json`) must not grow.
  - TV floor: nothing under 20 px at `(min-width: 1600px) and (orientation: landscape)`.
  - Two-cue focus: the ring is ≥ 3 px (4 px on TV) and ≥ 3:1. Rings and shadows never transition.
  - Motion tiers apply, and `html.nav-held` stops tweens.
- Ramp anchors live in `devtools/ramp.mjs` `THEMES`. A theme's `--n-*` / `--a-*` blocks are always pasted from
  `node devtools/ramp.mjs <theme>`, never hand-edited, and every ramp step has a hex value plus the same colour in
  `oklch()`.
- When a step mentions "L", it means OKLCH lightness, except Midnight's surfaces (see Task 3).
- Old token names keep working, so a user's copied theme folder still loads (the "old-names-only theme" test).
- Standing decisions are not reopened:
  - Daylight keeps its light canvas-colour wash over the hero and title page, with dark scrims on cards. Section C's
    "dark scrims kept on artwork" is read as the cards.
  - Orbit keeps its floating progress track, and Arctic its artwork-colour fill.
  - True black is offered on dark themes only.
- Arctic and Arctic Side are rebuilt from scratch. They use no Arctic Horizon assets, fonts or XML (CC BY-NC-SA). The
  only fonts are the ones already in `public/fonts/` under OFL.
- Messages shown to users are plain-English sentences. Kids rules and stream caps are untouched.
- Dallas commits. Each task ends with the files staged for review, not with a commit, unless he says otherwise.

## Guidance folded into this plan

This plan was written with four skills Dallas asked for on 17 Nov.

- **`ui-taste` (Uizze), polish playbook.**
  - This is refinement, not redesign. Each theme keeps its identity and only section C's changes are made.
  - The incumbent before pictures from Task 1 are the constrained target. No concept images are generated, because
    there is no authorised image tool and the spec is already approved.
  - Classify drift before fixing it, at the narrowest level: a missing token, a one-off implementation, a conceptual
    mismatch, or a local defect. Do not create a token for a single exception.
  - Judge contrast on the rendered background, not on token names; that is what scrim-check and theme-check do.
  - Exercise the focus, hover, selected and held-arrow states, not only rest.
  - Make one correction pass, then one targeted follow-up pass, not an open-ended loop.
  - The gallery ships with a `visual-evidence.json` receipt (Task 9).
- **`improve-codebase-architecture`, from its review of the theme system.**
  - Folded in:
    - Section C as a per-theme rules table (Task 1).
    - One OKLCH implementation shared by ramp.mjs and the tests (Task 1).
    - Theme capabilities as `theme.json` flags instead of name checks (Task 2, which also fixes Arctic Side missing
      from Settings' tint hint).
  - Left for later:
    - The remaining `isOrbit()` checks (7 places).
    - One TV-query owner.
    - A shared devtools `shoot()`.
    - Splitting orbit.css into layout and paint (spec: out of scope).
- **`vercel-react-best-practices`.** The few JS changes follow the relevant rules:
  - Interaction logic lives in the event handler, not in state plus an effect (`followFocus`).
  - There is one delegated listener per row container.
  - Repeated colour maths uses a module-level cache (`envTint`).
  - Styles are written in a batch and never read between writes.
  - The Next.js and server rules don't apply: Atomix uses Preact with no build.
- **`thermo-nuclear-code-quality-review`.** Not used: `cursor/plugins` has no skill with that name (the command
  listed the available skills instead).

## Review Focus

1. **A user theme folder (old names only, no `theme.json` flags).** It still loads with today's colours, no True black,
   and no focus-follow backdrop. The new flags default to off.
2. **Obsidian with True black switched off by the profile (`oled: false`).** It must stay off. Only an *absent* pref
   takes the theme's default. Switching to Daylight then back keeps the choice.
3. **Arctic on Home with a remote's held arrow.** The backdrop must not change on every card passed. It changes once,
   about 350 ms after the arrow is let go, and never for a card without artwork.
4. **Orbit with a very saturated or very bright poster.** The environment behind the sign-in, picker and music pages
   stays at L ≤ 20 % and C ≤ 0.04. A greyscale poster or a cross-origin poster that can't be read gives the theme's own
   colour.
5. **Daylight on a TV-size screen.** The canvas dims to L ≈ 90 % and every text token still passes APCA on the dimmed
   surfaces, including focus rings over the player's black.

---

### Task 1: Rules table, one OKLCH, before pictures

**Files:**
- Create `test/theme-rules.test.js` and `test/helpers/theme-resolve.js`.
- Modify `test/theme-tokens.test.js`: its `baseCss`, `chainOf`, `resolve` and `tokensOf` move to the helper and are
  imported from there.
- Modify `devtools/ramp.mjs`: import `toOklch` and `oklchToHex` from `public/js/tint.js` and delete its own copies.
- Modify `devtools/fixed-compare.mjs`: add a `SIZES` env var.
- Modify `test/accent-clamp.test.js`: drop any check that only compared the two OKLCH copies.

**Interfaces:**
- Produces from `test/helpers/theme-resolve.js`:
  - `THEMES`: read from `themes/*/theme.json`, sorted.
  - `MODES = ['modern', 'legacy']`.
  - `TV_MEDIA = '(min-width: 1600px) and (orientation: landscape)'`.
  - `tokensOf(theme, supports, { attrs, classes, media }) → Map`.
  - `colourOf(map, name) → {r, g, b, a}`: composites alpha on `--app-bg`.
  - `lchOf(map, name) → { L, C, H }`: via `toOklch` from tint.js. L is 0..1.
- Produces from `test/theme-rules.test.js`: `RULES = { [theme]: [{ name, token, media?, attrs?, check(lch, map) }] }`.
  Each later task adds its own rows. The file loops `RULES × MODES` and gives a clear message for each failure.
- `fixed-compare.mjs`: `SIZES=desk,tv,phone` where `desk` = 1440×900, `tv` = 1920×1080, `phone` = 390×844 (mobile +
  touch). The default stays today's `desk` 1917×992 plus `phone`, so old commands still behave the same.

Desktop is 1440×900 and not the spec's 1920×1080: in Atomix, 1920×1080 landscape *is* the TV size (`TV_QUERY`), so two
1920 captures would be identical.

- [ ] Move the helpers, then run `node --test test/theme-tokens.test.js`. It must pass unchanged, with the same number
  of tests as before the move.
- [ ] Write `test/theme-rules.test.js` with one seed row that passes today: `orbit --focus-ring` is `#ffffff`. Also add
  a test that `THEMES` equals the 7 built-in folder names.
- [ ] Switch ramp.mjs to tint.js's OKLCH. `node devtools/ramp.mjs --table` must print the same hex for every theme as
  before; diff the output saved before the change.
- [ ] Capture the before pictures on the current tree. You need the dev server (`npm run dev`, user `dallas`) and
  `node devtools/mock-iptv.mjs serve --plain`:
  `ART=1 SIZES=desk,tv,phone PAGES='#/,#/library/1,#/item/1,#/live,#/settings' node devtools/fixed-compare.mjs record devtools/out/visual-c/before`.
  Expect 105 PNG files plus `fixtures.json`.
- [ ] Run `node --test test/theme-tokens.test.js test/theme-rules.test.js test/accent-clamp.test.js test/apca.test.js`.
  All must pass.

### Task 2: Theme flags in theme.json

**Files:**
- Modify `src/themes.js`, which builds the theme list sent to the browser.
- Modify `public/js/appearance-rules.js` and `public/js/app.js` (`applyTheme`, `applyAppearance`).
- Modify `public/js/views/settings.js`: line ~200 hard-codes `['orbit','arctic']`.
- Modify `themes/{obsidian,orbit,arctic,arctic-side}/theme.json`.
- Modify `docs/THEMES.md` (theme.json fields).
- Tests: `test/appearance-rules.test.js`, and the existing themes-list test or a new `test/theme-flags.test.js`.

**Interfaces:**
- `theme.json` gains optional booleans. They are absent or false by default, and `src/themes.js` passes only booleans
  through:
  - `oled`: True black is on unless the profile says otherwise.
  - `artworkTint`: the accent glow and fills follow the artwork, as in Orbit and Arctic today.
  - `backdropFollowsFocus`: Task 6.
- In `appearance-rules.js`, `oledMode(prefs = {}, theme = {}) → boolean`:
  - `scheme === 'light'` → false.
  - A boolean `prefs.oled` → that value.
  - Otherwise → `theme.oled === true`.
  - `theme` is `{ colorScheme, oled }`.
- `app.js`: `applyAppearance(prefs, theme)` takes the theme object instead of a scheme string and uses `oledMode`.
  `applyTheme` sets `html.dataset.artworkTint` and `html.dataset.followFocus` from the flags. Settings' tint hint reads
  `theme.artworkTint`, so Arctic Side gets the hint too.
- The Settings True black switch shows `oledMode(...)`, the effective state. Turning it off saves `oled: false`.

- [ ] Write the failing tests for `oledMode`:
  - `oledMode({}, {colorScheme:'dark', oled:true})` → true.
  - `oledMode({oled:false}, {colorScheme:'dark', oled:true})` → false.
  - `oledMode({oled:true}, {colorScheme:'light'})` → false.
  - `oledMode({}, {colorScheme:'dark'})` → false.
  - `src/themes.js` drops `"oled": "yes"` and keeps `true`.
- [ ] RED, then implement, then GREEN.
- [ ] Set `"oled": true` in Obsidian, and `"artworkTint": true` in Orbit, Arctic and Arctic Side. Run
  `node devtools/modes-check.mjs`; it must pass. Check Obsidian by hand with a fresh profile: html has `data-oled`.

### Task 3: Midnight, the no-blur low-power reference

**Files:**
- Modify `devtools/ramp.mjs` (Midnight anchors) and `themes/midnight/theme.css`.
- Modify `public/css/tokens.css`: add a `--surface-edge` token, default `none`.
- Modify `public/css/app.css`, so that `.panel`, `.dialog`, `.details-panel` and `.player-menu` add
  `box-shadow: var(--surface-edge)` to whatever shadow they have.
- Test: `test/theme-rules.test.js` rows.

Spec "L ≈ 8/11/14/17/20/24 %" is HSL lightness. Today's Midnight surfaces are HSL 6/9/13/18 %. In OKLCH, 8 % would be
darker than today and almost black. The anchors at hue 225 and saturation 24 % are:
`n-1 #101219`, `n-2 #151923`, `n-3 #1b1f2c`, `n-4 #212636`, `n-5 #272d3f`, `n-6 #2f364c`.

- [ ] Add the rules rows, then run them and watch them fail:
  - `n-1..n-6` within ±1 per channel of those hexes.
  - OKLCH L strictly increasing, and C between 0.01 and 0.04 (a slight hue).
  - `--text-high` is `n-12` and `--text-low` is `n-11`.
  - `--glass-blur` resolves to `0px`.
  - `--nav-bg` alpha is 1.
  - `--surface-edge` is not `none`.
- [ ] Put these anchors in ramp.mjs. Steps 7–10 stay interpolated, and n-11 and n-12 stay as they are. Then:
  - Paste the ramp blocks.
  - Set `--nav-bg: var(--n-2)` and `--glass-blur: 0px`.
  - Set `--surface-edge: inset 0 1px 0 rgba(255, 255, 255, 0.06)`. This counts as a raw colour: update the baseline
    only if the test says so, and say why in the report.
- [ ] Run the rules rows and theme-tokens.test.js; both must be GREEN, including the APCA checks on the new surfaces.
- [ ] Browser check: in Midnight, computed `backdrop-filter` is `none` on `.app-header`, `.panel` and `.dialog`. This
  goes in the theme-check script from Task 7; until then, check by hand in DevTools.

### Task 4: Obsidian, the OLED theme

**Files:**
- Modify `devtools/ramp.mjs` (Obsidian anchors) and `themes/obsidian/theme.css`.
- Test: rules rows.

- [ ] Add the rules rows (RED):
  - `--text-high` has L between 0.89 and 0.91.
  - `--app-bg` is `#000000`, with or without `data-oled`.
  - `--border-subtle` is a hairline: in the theme's CSS, `.card-art::after` and `.panel` borders are `1px`, and the
    colour has alpha ≤ 0.12 or is a ramp step with L ≤ 0.30.
  - `--focus-ring` is `--accent-solid` and has ≥ 3:1 WCAG on `#000`.
  - `--focus-halo` is `transparent`.
  - Obsidian's theme.css hides card motion's glow:
    `:is(.row-scroller, .grid) > :is(.poster-card, .landscape-card:not(.live-card))::before { display: none; }`
    (app.css ~1795). The `--card-lift` movement stays. Check it through `map.decls`.
- [ ] Implement:
  - Anchor `n-12 → oklch(90% 0.006 290)` as hex, and re-paste the ramps.
  - Set `--focus-ring: var(--accent-solid)` and remove the `#ffffff` pin.
  - Set `--focus-halo: transparent` and `--focus-width: 4px` (5 px on TV in the TV block).
  - Hide the glow.
  - The "loud flat" ring is the violet accent at full strength with no glow.
- [ ] GREEN. Run `node devtools/focus-check.mjs` with `THEMES=obsidian`; it must pass (≥ 3:1, width ≥ 4 px).

### Task 5: Daylight

**Files:**
- Modify `devtools/ramp.mjs` (Daylight anchors and accent) and `themes/daylight/theme.css`.
- Test: rules rows, including `media: TV_MEDIA`.

- [ ] Add the rules rows (RED):
  - `--app-bg` has L between 0.96 and 0.97.
  - At `TV_MEDIA`, `--app-bg` has L between 0.89 and 0.91 and `--surface-1` ≤ 0.95.
  - `--accent-solid` has L between 0.45 and 0.55 (darker steps).
  - `--on-accent` gives Lc ≥ 60 on `--accent-solid`.
  - `--surface-1`'s elevation comes from `--shadow` (not `none`), with no `--surface-edge`.
  - Every APCA check at `TV_MEDIA` passes as well.
- [ ] Implement:
  - Anchor `n-1` at oklch 96.5 %. `#f4f5f8` is about 96.9 %, so keep it if the row passes.
  - Use `--accent: var(--a-10)` / `--accent-solid: var(--a-10)` when `a-9` is lighter than 0.55.
  - Add a TV block that re-points `--app-bg`, `--bg`, `--n-1` and `--n-2` to the oklch-90 % hex. This needs a hex line
    first and oklch inside `@supports`.
  - Set `--focus-halo` so the ring passes 3:1 on the player's black (Plan A deferred minor). The halo is
    `rgba(255,255,255,.9)` at 1 px wider.
- [ ] GREEN. Run `node devtools/scrim-check.mjs` with `THEMES=daylight` and `ART=white` and `ART=black`; both must pass.

### Task 6: Arctic and Arctic Side

**Files:**
- Modify `themes/arctic/theme.css`, `themes/arctic-side/theme.css` and both `theme.json` (`backdropFollowsFocus`).
- Modify `public/css/tokens.css`: add `--button-radius`, default `var(--r-md)`.
- Modify `public/css/app.css`: `.btn`, `.pill` and `.season-tab` use `border-radius: var(--button-radius)`.
- Create `public/js/focus-backdrop.js`.
- Wire it from `public/js/views/home.js` and `public/js/views/library-shelf.js`.
- Tests: rules rows and `devtools/theme-check.mjs` (Task 7 adds the script; write this check into it here).

**Interfaces:**
- Consumes `html.dataset.followFocus` (Task 2) and `setBackdrop(url)` / `artFor(item)` (existing).
- Produces `followFocus(rowsEl, { itemOf(cardEl) → item|null, delay = 350 }) → () => void`, the cleanup function:
  - It attaches one delegated `focusin` listener on `rowsEl`.
  - Each focus restarts a single timer.
  - It does nothing while `html.nav-held` is set; the timer restarts on the `keyup` that clears it.
  - It does nothing when `html.dataset.followFocus` is unset or `data-motion="none"`.
  - When the timer fires, it calls `setBackdrop(artFor(item))` only if the item has a backdrop.
  - Cleanup removes the listener and clears the timer.
  - Do this in the event handler with a timer, not as state plus an effect. Views call it once from their existing
    mount effect and return the cleanup.

`--button-shape` (square|pill) from the spec becomes `--button-radius`, a length. CSS can't branch on a keyword
without style queries, and old TV browsers don't have those. A user theme sets `999px` for pills or `var(--r-sm)` for
square buttons.

- [ ] Add the rules rows (RED):
  - Arctic and Arctic Side `--surface-1` and `--surface-2` have alpha 1 (flat), and their `.panel`, `.search-box` and
    `.addon-tile` have no `backdrop-filter` declaration in the theme CSS (parse `map.decls`).
  - `--font` does not contain `Condensed` or `Narrow`.
  - `--font-title` starts with `"League Gothic"`.
  - `--button-radius` is `999px` in both.
  - Any `url(` in either theme.css points into `/fonts/` with an `OFL` licence file present.
- [ ] Implement the CSS:
  - `.panel`, `.search-box` and `.addon-tile` get `background: var(--surface-1)` and lose the blur and `--panel` alpha.
  - `--font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
  - Body, meta and card text use weight 400–500 (`.meta-line`, `.card-sub`, `.eyebrow`, `.row-title`: 500). Buttons
    and menu entries stay 600, and titles stay League Gothic 400.
  - Large titles show the clear logo when there is one. The spotlight already does this (`has-logo`); make the title
    page's `.logo-box` from Plan B win over the League Gothic `.detail-title` in Arctic.
- [ ] Add a check to theme-check.mjs, `follow-focus`. In Arctic on Home at 1920×1080 with ART=1:
  - Focus card 3. After 500 ms, the backdrop `src` is that card's art.
  - Hold ArrowRight for 1.2 s (`html.nav-held`). During the hold the backdrop `src` changes at most once (the release).
  - In Midnight, focusing cards never changes it.
  Run it and watch it fail.
- [ ] Implement `followFocus` and wire it into Home and library rows. Then GREEN.
- [ ] Run `node --test test/theme-tokens.test.js test/theme-rules.test.js test/old-browsers.test.js`, then
  `node devtools/type-floor.mjs` and `node devtools/focus-check.mjs` with `THEMES=arctic,arctic-side`. All must pass.

### Task 7: Orbit, plus the theme-check script

**Files:**
- Modify `devtools/ramp.mjs` (Orbit `n-12`) and `themes/orbit/theme.css`.
- Modify `public/css/orbit.css`: poster width and `.environment`.
- Modify `public/js/tint.js`: add `envTint`.
- Modify `public/js/backdrop.js`: `setTint` also sets `--env-tint`.
- Create `devtools/theme-check.mjs`, which owns `follow-focus` (Task 6), `rows`, `player-chrome` and `no-blur`. It uses
  `devtools/lib.mjs` to log in.
- Tests: `test/accent-clamp.test.js` (`envTint`) and rules rows.

**Interfaces:**
- `envTint(colour) → hex|null` in tint.js:
  - It clamps OKLCH L to ≤ 0.20 and C to ≤ 0.04 and keeps the hue.
  - null or unparsable input → null.
  - Cache the results in a module-level `Map` capped at 200, like backdrop's `tintCache`.
- `setTint(colour)` sets `--env-tint` to `envTint(colour)`, or removes it when that is null.
- `.environment` paints `var(--env-tint, var(--bg))` under its existing vignette, in place of
  `color-mix(var(--tint) 20%)`.
- theme-check.mjs run: `node devtools/theme-check.mjs [check…]`. Env: `THEMES`, `BASE`, `SHOTS=<dir>`. Exit 1 on any
  failure, with one line per failure.

- [ ] Write the failing tests:
  - `envTint('#ff0000')`: L ≤ 0.20, C ≤ 0.04, hue within 5° of red's.
  - `envTint('#ffffff')`: L ≤ 0.20 and C ≈ 0.
  - `envTint(null)` → null.
  - Orbit rules rows: `--text-high` and `--text` are L between 0.935 and 0.945 and C ≤ 0.01. `--focus-ring` stays
    `#ffffff`, so it is the brightest token.
  - `theme-check rows`, Orbit at 1920×1080 and at 1366×768: the first poster row shows between 6.0 and 6.6 posters, so
    the 7th peeks. Count the cards whose left edge is inside the row's visible box, plus the fraction of the last one.
  - `theme-check player-chrome`, Orbit: open the player, then inject a style that hides the `video` and makes the player's
    background `#fff`. That gives the worst case, a white frame. The `.player-clock` text and the top-bar icons
    have a non-`none` `text-shadow` or `filter`. The clock's pixels against the sampled white reach ≥ 3:1.
- [ ] Implement:
  - Anchor Orbit `n-12` at `oklch(94% 0.005 <Orbit neutral hue>)` as hex. Re-point `--text` to `var(--n-12)` where it
    is pinned `#fff`, and keep `--focus-ring: #ffffff`.
  - Set `--poster-w` to `calc(256 * var(--px))`, as a starting value; tune it until `rows` reports 6.0–6.6. Phones
    keep 116 px, and `--wide-w` is unchanged.
  - Add `--chrome-shadow: 0 1px 2px rgba(0,0,0,.7), 0 0 12px rgba(0,0,0,.45)` on `.player-top` icons, the title and
    the clock (`text-shadow`, or `filter: drop-shadow` on SVG).
  - Do `envTint`.
- [ ] GREEN. Run `rows` for Harbour too, to record its count for Task 8.
- [ ] Add `no-blur` (Midnight, Task 3) to the script and run it.

### Task 8: Harbour

**Files:**
- Modify `themes/harbour/theme.css`.
- Possibly modify `public/css/app.css`, but only if Harbour's grown card hides Plan B's badges or progress track.
- Tests: rules rows and theme-check `rows` and `grown`.

- [ ] Add the rules rows (RED):
  - `--focus-grow` is between 1.04 and 1.08 (the cap).
  - The `.card:hover` scale in theme.css uses `var(--focus-grow)`, not a literal.
- [ ] Add theme-check checks:
  - `rows`, Harbour at 1920×1080: ≥ 5.0 posters fully visible.
  - `grown`: the focused card has an outline (the ring) in the same frame as its scale; read both after a single
    `keydown`. Its badge and progress track stay inside the card's box.
  - No row neighbour overlaps the grown card's box.
- [ ] Implement:
  - Hover becomes `scale(var(--focus-grow))`.
  - Gutters come only from app.css's growth-based gap. Remove any Harbour-specific gap literals.
  - If the 5-poster check fails, lower `--poster-w` on TV in the TV block. Report the value you chose.
- [ ] GREEN. Run `node devtools/focus-check.mjs` and `node devtools/card-select.mjs` with `THEMES=harbour`.

### Task 9: Gallery, docs, release

**Files:**
- Create `devtools/gallery.mjs`.
- Modify `docs/THEMES.md` (one paragraph per theme on what makes it itself; the new tokens `--surface-edge`,
  `--button-radius`, `--env-tint` and `--chrome-shadow`; the `theme.json` flags).
- Modify `CLAUDE.md`: add a "Visual refresh C" section in the style of A/B, and move "Next" on.
- Modify `docs/HANDOFF-2026-11.md` (Next).

**Interfaces:**
- `node devtools/gallery.mjs <before-dir> <after-dir> <out-dir>`:
  - It writes `<out-dir>/index.html` plus `<out-dir>/img/<theme>-<size>-<page>-{before,after}.jpg`.
  - It uses Pillow: JPEG quality 72, desk and TV scaled to 1280 px wide, phone at 390.
  - The page has a theme picker and size tabs. Each page shows a before/after slider (`<input type=range>` clipping
    the after image). There are no external scripts, and it follows the artifact-design skill.
- [ ] Capture the after pictures:
  `ART=1 SIZES=desk,tv,phone PAGES='#/,#/library/1,#/item/1,#/live,#/settings' node devtools/fixed-compare.mjs replay devtools/out/visual-c/after devtools/out/visual-c/before`.
  Then run `node devtools/gallery.mjs devtools/out/visual-c/before devtools/out/visual-c/after devtools/out/visual-c/gallery`.
  Expect 210 JPEGs.
- [ ] Write the receipt `devtools/out/visual-c/gallery/visual-evidence.json` with gallery.mjs, using the ui-taste
  receipt shape (`schemaVersion: "uizze.visual-evidence.v1"`, `platform: "web"`, `comparison: "existing-system"`). It
  holds:
  - `sources`: every changed theme, CSS and JS file, with its SHA-256.
  - One check per theme × size × page: the Chromium viewport, the state (ART=1, frozen fixtures and clock,
    `reducedMotion: reduce`) and both JPEGs with their SHA-256.
  - `unresolved`: the real-hardware items (TV timings, Safari, old TV browsers).
  If the ui-taste helper is still installed, run `node <skill>/scripts/verify-visual-evidence.mjs <receipt>`. Then look
  at every after picture yourself. Note blank, half-loaded or wrong-size shots and recapture them.
- [ ] Publish the gallery as a private artifact. Publish `index.html` with the JPEGs through `files`; 210 + 1 files is
  under 255 and under 64 MB. Send Dallas the link.
- [ ] Run the full suite in 6 groups, with live-tuner tests alone. Run each devtools check one at a time:
  `type-floor`, `focus-check`, `scrim-check` (`ART=white` and `ART=black`), `accent-check`, `glass-check`,
  `modes-check`, `pinned-check`, `polish-check`, `card-select`, `card-open`, `card-load`, and `theme-check` (all).
  Known exceptions: `home-fn` (3 failures with the mock IPTV row) and `subsonic-browse` (`<replayGain>`).
- [ ] Docs updates, then one fresh whole-change review and one fix pass. Dallas reviews the gallery and decides on the
  commit.
