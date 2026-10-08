# Atomix: Orbit on desktops, tablets and phones (v0.8.0)

Design, 1 October 2026. Approved by Dallas in conversation from a survey of the live pages at five sizes and a CSS
prototype; this document is the record. It amends the Orbit spec (`2026-09-29-atomix-orbit-ui-design.md`):
where the two disagree, this one wins.

## What this is

Dallas judged Orbit on his desktop (1917 × 992), a phone and a tablet and found it "weird": the rounded floating
window around the content, the first Home row cut off at the window's bottom edge, and Settings squashed on a
phone. He chose:

1. **No window, anywhere.** The page fills the screen edge to edge on every size; the floating menu pill, the mark and
   the clock stay. (A desktop browser at 1917 px is indistinguishable from a 1080p TV by width, so the TV gets the
   same look.)
2. **Settings on narrow screens** lays its sections out as **a row of chips across the top** that you can swipe, with
   the chosen panel full width underneath.

## Words used here

- **Wide**: `(min-width: 1000px) and (orientation: landscape)` — TVs, desktops, laptops, tablets held sideways.
  This is `FRAME_QUERY` in `orbit-rules.js` and stays the split between the two Orbit layouts.
- **Narrow**: everything else — phones, and tablets held upright.
- **The rail**: the strip on the left of a wide screen where the menu pill floats. Its width is what `--win-l` is
  today (168 × `--px` on TVs; laptops go from 100 px to 112 px, which nudges the pill and the mark 6 px right);
  the variable is what positions the mark and the menu.
- **`--px`**: Orbit's scale unit, unchanged (1 px on a 1080p TV, never under 0.72 px on laptops, 0.4 px narrow).

## 1. The shell on wide screens (`public/css/orbit.css`)

- **`main`** stays a fixed, scrolling box (that is what Orbit's row-focus scrolling and `pageScroller()` rely on)
  but with `inset: 0` and no rounding. Its **left padding is the rail**: `calc(var(--win-l) - var(--gutter) +
  16 * var(--px))`, so the page's text edge sits at `--win-l + 16 × --px` from the screen edge (184 px at
  1080p, 128 px on a laptop) and is never closer than 40 px to the pill's right edge (56 px at 1080p, 40 on a
  laptop). Rows that bleed
  (`margin: 0 calc(-1 * var(--gutter))`) start at the rail's edge on the left and run to the screen edge on the
  right. `--win-t/r/b` become 0; `--win-radius` is removed.
- **The backdrop** (the crisp artwork under the page) is `inset: 0` with no rounding, and keeps its gradients
  exactly as now.
- **The environment** (the artwork stretched behind everything) is hidden behind pages (`body[data-view="page"]`)
  on wide screens, since no screen shows round the page any more. It **stays** where it is the whole background:
  the sign-in screen, first-run setup and "Who's watching?" (those checks in `orbit-ui.mjs` still hold).
  Narrow screens never had it.
- **The clock/profile cluster** keeps its offsets from the screen corner (36 × `--px` down, 52 × `--px` in);
  they were measured from the window before. **The mini-player pill** likewise sits 40 × `--px` from the right
  and 36 × `--px` from the bottom. Toasts are unchanged (they were never tied to the window).
- The `orbit-in` page animation, the scroll paddings, the menu's behaviour, the glass and the type are unchanged.

## 2. Home on short windows (wide screens)

The spotlight's height becomes `clamp(360 × --px, 100vh − 440 × --px, 600 × --px)` instead of a fixed
600 × `--px` (compact: unchanged at 340 × `--px`). At 1080p the clamp yields 600 and nothing changes; on
Dallas's 992 px-tall desktop it yields about 552, leaving 440 × `--px` for the rows, enough for a poster row
(heading, ring room, a 196 × 294 card and its caption) to show whole with the next row's heading peeking in
below. The spotlight's type scales as it does today (it is set in `--px`, not in the spotlight's height).

## 3. Settings on narrow screens

Cause of today's squash: `themes/orbit/theme.css` sets `.settings-layout { grid-template-columns: 300px 1fr }`
with no media query, overriding `app.css`'s one-column rule under 860 px. Orbit's settings rules for the layout
and tabs become wide-only, and narrow screens get, in `orbit.css`:

- **Chips across the top**: `.settings-tabs` is a horizontal row (`flex-direction: row`, `overflow-x: auto`,
  no scrollbar), bleeding to the screen edges (`margin: 0 -20px; padding: 4px 20px`) so it can be swiped;
  each `.settings-tab` is a 40 px-tall pill that never shrinks; the current one is filled, as on wide screens
  (no underline). The row is not sticky.
- **The panel** is full width (`grid-template-columns: 1fr`, `max-width: none`).
- **Theme cards**: `.theme-grid` uses `minmax(150px, 1fr)` narrow, giving two across on a 390 px phone and four
  on an 820 px tablet; card text wraps as today.
- **Save**: `.sticky-actions` sticks at `bottom: calc(96px + env(safe-area-inset-bottom))` narrow, above the
  dock, instead of 16 px.

Wide screens keep the side list exactly as now.

## 4. Room for the dock, and the library grid

- Narrow: `main`'s bottom padding becomes `calc(110px + env(safe-area-inset-bottom))` (was 96), so the last
  control on any page clears the dock; with the mini-player the existing 190 px stands.
- Wide: nothing hides behind anything (the dock is narrow-only).
- The library grid (`.grid-poster`) keeps its auto-fill and card sizes; its gap on wide screens becomes
  `calc(20 * var(--px))`, so three posters at tablet-landscape sit a little closer together.

## 5. What doesn't change

The remote navigation and `orbit-rules.js`; the glass, fonts and `--px` sizes; the older six themes (compared
pixel by pixel before and after, as for every Orbit round); the player; the phone's Home, library and show
pages; the splash and "Who's watching?".

## 6. Testing

**Browser (`/home/claude/devtools`, Playwright, cloud only):**

- `orbit-sizes.mjs` (rewritten from today's survey script) runs at five sizes — desktop 1917 × 992, laptop
  1280 × 800, tablet 1024 × 768 and 820 × 1180, phone 390 × 844 — over Home, a library, a show, Settings →
  Profile and Settings → Server, and checks: no sideways overflow (`scrollWidth === innerWidth` for the document
  and `main`); wide: `main` and `.backdrop` have `inset: 0` and no radius, the environment is hidden behind the
  page and shown on the picker, the page's first text edge is ≥ 40 px right of the menu pill; desktop: the first
  Home row's cards are wholly inside `main` and the second row's heading is visible; narrow: the settings tabs
  are in a row (each tab's `top` equal), the panel spans the width, the theme grid has 2 columns on the phone
  and ≥ 3 on the tablet, and the Save button's box is above the dock's box; every page's last focusable element
  can be scrolled clear of the dock. It also saves the pictures for Dallas.
- `orbit-ui.mjs`: the checks that measured the window (radius, insets, the environment behind a page) are
  updated to the new values; everything else must still pass (159 checks today).
- `orbit-a11y.mjs` (53) and `oldthemes-compare.mjs` (30 pages identical) unchanged and green.

**Node:** none needed — this round is CSS; `orbit-rules.js` is untouched and its tests stand.

## Out of scope

Different phone pages, the player, the season-tab/episode layout, any theme other than Orbit, and the hero
title's size on desktops (it scales with `--px` as designed; revisit only if Dallas asks after seeing it without
the window).

## Files

Modified: `public/css/orbit.css` (the shell, Home spotlight clamp, narrow Settings, dock room, grid gap),
`themes/orbit/theme.css` (settings layout and tabs rules scoped to wide screens), `docs/ARCHITECTURE.md`,
`README.md` (if it mentions the window), `package.json` (0.8.0); devtools `orbit-sizes.mjs` (rewritten),
`orbit-ui.mjs` (updated window checks). Removed: devtools `orbit-survey.mjs` and `orbit-proto.mjs` (folded into
`orbit-sizes.mjs`).
