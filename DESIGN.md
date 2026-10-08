---
name: Atomix
description: A self-hosted media hub whose default look, Orbit, puts the artwork on the whole screen and floats the controls over it as glass.
colors:
  tint-ice: "#8fe9ff"
  deep-space: "#05050c"
  deep-space-inset: "#0b0b16"
  page-shade: "rgba(4, 4, 14, 0.92)"
  text: "#ffffff"
  text-soft: "rgba(255, 255, 255, 0.86)"
  text-dim: "rgba(255, 255, 255, 0.66)"
  selection-white: "#ffffff"
  selection-ink: "#0b0b16"
  glass-clear: "rgba(255, 255, 255, 0.14)"
  glass-strong: "rgba(255, 255, 255, 0.22)"
  glass-edge: "rgba(255, 255, 255, 0.24)"
  glass-tinted: "rgba(28, 28, 42, 0.58)"
  glass-panel: "rgba(20, 20, 34, 0.62)"
  glass-solid: "rgba(24, 24, 36, 0.94)"
  danger-coral: "#ff7a86"
  success-mint: "#62e3ae"
  rating-gold: "#ffd166"
typography:
  display:
    fontFamily: "Sora, system-ui, 'Segoe UI', sans-serif"
    fontSize: "calc(116 * var(--px))"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "Sora, system-ui, 'Segoe UI', sans-serif"
    fontSize: "calc(56 * var(--px))"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Sora, system-ui, 'Segoe UI', sans-serif"
    fontSize: "max(12px, calc(26 * var(--px)))"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Sora, system-ui, 'Segoe UI', sans-serif"
    fontSize: "max(12px, calc(22 * var(--px)))"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  label:
    fontFamily: "Sora, system-ui, 'Segoe UI', sans-serif"
    fontSize: "max(12px, calc(20 * var(--px)))"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "Sora, system-ui, 'Segoe UI', sans-serif"
    fontSize: "max(12px, calc(16 * var(--px)))"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  tag: "calc(7 * var(--px))"
  card: "calc(18 * var(--px))"
  panel: "calc(32 * var(--px))"
  dialog: "calc(38 * var(--px))"
  menu: "calc(44 * var(--px))"
  pill: "999px"
spacing:
  card-gap: "calc(24 * var(--px))"
  row-gap: "calc(30 * var(--px))"
  panel-pad: "calc(34 * var(--px))"
  gutter: "calc(96 * var(--px))"
  gutter-phone: "20px"
components:
  button:
    backgroundColor: "{colors.glass-clear}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 calc(34 * var(--px)) 0 calc(28 * var(--px))"
    height: "max(44px, calc(66 * var(--px)))"
  button-primary:
    backgroundColor: "{colors.glass-strong}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
  button-focus:
    backgroundColor: "{colors.selection-white}"
    textColor: "{colors.selection-ink}"
    rounded: "{rounded.pill}"
  input:
    backgroundColor: "rgba(255, 255, 255, 0.1)"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "0 calc(24 * var(--px))"
    height: "max(44px, calc(60 * var(--px)))"
  chip:
    backgroundColor: "rgba(255, 255, 255, 0.12)"
    textColor: "{colors.text}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "calc(4 * var(--px)) calc(14 * var(--px))"
  card-art:
    backgroundColor: "rgba(255, 255, 255, 0.06)"
    rounded: "{rounded.card}"
    width: "calc(196 * var(--px))"
  panel:
    backgroundColor: "{colors.glass-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  dialog:
    backgroundColor: "{colors.glass-tinted}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    width: "min(calc(720 * var(--px)), calc(100vw - 32px))"
  player-bar:
    backgroundColor: "{colors.glass-tinted}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    padding: "calc(26 * var(--px)) calc(34 * var(--px)) calc(22 * var(--px))"
  player-button:
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    size: "max(42px, calc(64 * var(--px)))"
  player-button-play:
    backgroundColor: "{colors.selection-white}"
    textColor: "{colors.selection-ink}"
    rounded: "{rounded.pill}"
  player-menu:
    backgroundColor: "rgba(24, 24, 38, 0.66)"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    padding: "calc(36 * var(--px)) calc(26 * var(--px))"
    width: "calc(560 * var(--px))"
  mini-player:
    backgroundColor: "{colors.glass-tinted}"
    textColor: "{colors.text}"
    rounded: "calc(30 * var(--px))"
    padding: "calc(14 * var(--px))"
    width: "calc(460 * var(--px))"
  up-next:
    backgroundColor: "{colors.glass-tinted}"
    textColor: "{colors.text}"
    rounded: "calc(36 * var(--px))"
    padding: "calc(18 * var(--px)) calc(18 * var(--px)) calc(26 * var(--px))"
    width: "calc(520 * var(--px))"
  menu:
    backgroundColor: "{colors.glass-tinted}"
    textColor: "rgba(255, 255, 255, 0.82)"
    rounded: "{rounded.menu}"
    width: "calc(88 * var(--px))"
  menu-item-focus:
    backgroundColor: "{colors.selection-white}"
    textColor: "{colors.selection-ink}"
    rounded: "{rounded.pill}"
---

# Design System: Atomix

## Overview

**Creative North Star: "The Artwork Is the Screen"**

Orbit, Atomix's default theme, hands the whole screen to the title's artwork. The page fills it edge to edge, a scrim darkens the left and bottom so text can sit on it, and every control floats above as glass. Nothing is a box drawn on a background; the background is the film, the show or the album.

The feel is cinematic and calm. Controls stay out of the artwork's way and never compete with it. Colour comes from the artwork itself: the accent is a tint worked out from the art on screen, so the interface shifts with what is being browsed. White is reserved for one job, marking where the remote is.

Orbit is the normative system. The other six shipped themes (Arctic, Arctic Side, Midnight, Harbour, Daylight, Obsidian) are alternate skins of the same token contract documented in `docs/THEMES.md`: they set the same custom properties (`--bg`, `--surface`, `--accent`, `--radius`, `--font` and so on) and use a top or side menu layout instead of Orbit's rail.

**Key Characteristics:**
- Full-screen artwork behind every page, faded to near-black at the left and bottom.
- Glass surfaces in two kinds: clear over artwork, tinted for menus, bars and dialogs.
- An accent that follows the artwork's colour.
- White means selected. Nothing else is solid white at rest except Play.
- One typeface, Sora, at sizes drawn for a 1080p TV and scaled to every screen.
- Pills and large radii throughout; no hard corners.

## Colors

A near-black, slightly blue stage with white text, translucent white and indigo glass, and a single accent borrowed from the artwork.

### Primary
- **Artwork Tint** (`--tint`, computed in `public/js/tint.js`): the accent. It is the colour the current artwork would cast into a dark room, adjusted to show on a dark background. Used for progress bars, the current-page dot in the menu, checked switches, the playing song, eyebrow text and small icons.
- **Ice** (`tint-ice`): the fallback tint when there is no artwork or its colour can't be read. A profile's own accent colour replaces it as the fallback.

### Neutral
- **Deep Space** (`deep-space`): the page background and the gap inside the focus ring.
- **Deep Space Inset** (`deep-space-inset`): inset areas, and the ink colour for text on white or on the accent (`selection-ink`).
- **Page Shade** (`page-shade`): the scrim over artwork, strongest at the left edge and the bottom.
- **White, Soft White, Dim White** (`text`, `text-soft`, `text-dim`): main text, secondary text and meta lines, tertiary labels.
- **Clear Glass** (`glass-clear`, `glass-strong`, `glass-edge`): buttons and fields that sit on artwork; strong is the primary button; edge is the 1px inner line.
- **Tinted Glass** (`glass-tinted`, `glass-panel`): the menu, dialogs, player bar and mini-player; panel is the unblurred version for groups that scroll.
- **Solid Glass** (`glass-solid`): what every glass colour becomes under Reduce effects, reduced transparency, or no `backdrop-filter` support.

### Tertiary
- **Coral** (`danger-coral`): errors and destructive actions.
- **Mint** (`success-mint`): confirmations.
- **Gold** (`rating-gold`): star ratings and the Kids chip.

### Named Rules
**The White Is the Remote Rule.** Solid white with ink text marks the focused control. The accent never marks the selection.

**The Borrowed Accent Rule.** The accent is the artwork's colour, not a brand colour. Do not hard-code a hue where `--accent` belongs.

## Typography

**Display Font:** Sora (with system-ui, Segoe UI, sans-serif)
**Body Font:** Sora (same stack)

**Character:** One geometric sans carries everything from 116px titles to 16px captions, separated by weight (400 to 700) and tight negative tracking at large sizes. The files ship with Atomix (`public/fonts/`, SIL OFL), so it works offline.

### Hierarchy
- **Display** (700, 116 × `--px`, line-height 1.08, tracking -0.045em): the Home spotlight title, clamped to two lines. Detail-page titles use the same treatment at 100 × `--px`.
- **Headline** (700, 56 × `--px`, line-height 1, tracking -0.035em): page titles (`h1`).
- **Title** (600, 26 × `--px`, tracking -0.015em): row and section headings (`h2`).
- **Body** (400, 22 × `--px`, line-height 1.5): descriptions, buttons (at 600), menu and list items (at 500 to 600). Long text is capped near 75ch.
- **Label** (600, 20 × `--px`): field labels, meta lines (at 500), eyebrows.
- **Caption** (400, 16 × `--px`): card subtitles, hints, chips (at 600).

Sizes are written as `calc(N * var(--px))`, where N is the size on a 1080p TV. On phones and portrait screens body, label and caption are a fixed 16px and larger roles have a 16px floor; elsewhere small roles have a 12px floor.

### Named Rules
**The Sentence Case Rule.** Orbit removes uppercase and letter-spacing from eyebrows, badges, table heads and menu titles. Hierarchy comes from size and weight.

**The Whole Descender Rule.** Clamped large titles use line-height 1.08 with 0.06em of bottom padding so Sora's descenders are never cut.

## Layout

Every size derives from `--px`: 1px at 1920px wide, `clamp(0.72px, 100vw / 1920, 2px)`, and a fixed 0.4px on phones and portrait screens. Layouts are drawn at 1920 × 1080 and scale as a whole.

- **TVs and laptops (landscape, 1000px and wider):** the page is a fixed full-screen box that scrolls inside itself. A rail on the left holds the menu (112px wide on laptops, 168 × `--px` at 1600px and wider). The page gutter is 96 × `--px`. The clock and profile picture sit in a pill at the top right.
- **Phones and portrait screens:** no rail. The menu becomes a dock at the bottom, Add-ons and Settings move to corner buttons, the gutter is 20px, and Settings sections become a horizontal chip row.
- **Home:** a spotlight (title or clear logo, meta line, genres, two lines of plot, buttons) stays fixed while rows scroll beneath it on screens at least 1000px wide. Past the first row it compacts to a smaller title and one line of plot.
- **Rows and grids:** horizontal rows of cards with a 24 × `--px` gap and 30 × `--px` between rows. Posters are 196 × `--px` wide, landscape cards 336, squares 220 (116px, 240px and 132px on phones).
- **Content widths:** spotlight and detail text cap at 1100 × `--px`; settings content at 1200 × `--px`.

Touch and remote targets are never smaller than 44px, whatever `--px` is.

## Elevation & Depth

Depth is layered glass over artwork, with shadows used for lift rather than outline. Three layers: the artwork and its scrim; page content, including unblurred glass panels that scroll; and floating glass (menu, clock pill, dialogs, player bar, mini-player, toasts) with blur and a deep drop shadow.

### Shadow Vocabulary
- **Card rest** (`0 14px 30px rgba(0,0,0,0.45)`, as `--shadow`): under every card's artwork.
- **Lift** (`0 20px 44px rgba(0,0,0,0.55)`, as `--lift`): added to a hovered or focused card or button.
- **Glass float** (`0 24px 60px rgba(0,0,0,0.55)`, as `--glass-shadow`): under the menu; dialogs and the player bar go deeper (`0 30px 80px`).
- **Glass edge** (`inset 0 0 0 1px` in `glass-edge` or 16% white, plus `inset 0 1px 0` 22% white on floating glass): the line and top highlight that define a glass surface instead of a border.
- **Focus ring** (`0 0 0 5px` Deep Space, then `0 0 0 9px` white, as `--ring`): a white ring with a dark gap.

All pixel values above are multiplied by `--px`.

### Named Rules
**The No Blur While Scrolling Rule.** Anything inside a scrolling row, list or settings group is tinted but not blurred. Blur is for surfaces that stay still.

**The Dim, Don't Blur Rule.** The page behind a dialog is dimmed (55% Page Shade), never blurred; a full-screen blur is too slow for a TV.

**The Solid Fallback Rule.** Every glass surface must still read when its colour becomes Solid Glass and its blur becomes none.

## Shapes

Everything is rounded, and most controls are full pills. Buttons, fields, menu items, list rows, toasts and tabs use 999px. Card artwork is 18 × `--px`; panels and settings groups 32; dialogs 38; the menu 44. Small tags and media flags are 7 × `--px` with a 1.5px inset line instead of a fill. Avatars and icon wells are circles.

Surfaces have no CSS borders. Edges are drawn with inset box-shadows so they sit inside the shape and survive the pill radius.

## Components

Controls are cinematic and calm: quiet glass at rest, out of the artwork's way, and unmistakable only when selected.

### Buttons
- **Shape:** full pill (999px), at least 44px and 66 × `--px` tall, padded 28 left and 34 right.
- **Default:** Clear Glass with a 1px inner edge and blur, white text at weight 600.
- **Primary:** Strong Glass. It is not accent-coloured.
- **Hover / Active:** background rises to 24% white (30% for primary); pressing scales to 0.97.
- **Focus:** solid white with ink text, grows to 1.05, gains the ring and lift, over 180ms.
- **Danger:** coral at 26% fill with white text. **Icon:** a 66 × `--px` circle. **Small:** 48 × `--px` tall.
- **Play:** the player's play button and Skip intro are solid white at rest.

### Chips
- **Style:** 12% white pill, caption size at weight 600. The Kids chip is Gold with ink text.
- **Media flags:** outlined tags (7 × `--px` radius, 1.5px inset line at 40% white), no fill.

### Cards / Containers
- **Corner Style:** 18 × `--px` on artwork.
- **Background:** 6% white behind artwork while it loads.
- **Shadow Strategy:** Card rest; hover scales to 1.04 with Lift; focus scales to 1.08 with the ring and Lift.
- **Progress:** a 5 × `--px` bar inset 14 from the sides and 12 from the bottom, in the accent on 28% white.
- **Panels:** Panel Glass, 32 × `--px` radius, 34 × `--px` padding, 1px inner line at 12% white, no blur.

### Inputs / Fields
- **Style:** pill, 10% white fill with a 1px inner edge, at least 44px and 60 × `--px` tall. Textareas use a 20 × `--px` radius.
- **Focus:** the white ring. No colour change.
- **Switches:** an 18% white track; checked is the accent with an ink knob.
- **Error:** message text in a light coral (`#ffb3ba`).

### Navigation
- **Menu:** a Tinted Glass column (88 × `--px` wide, 44 radius) centred in the left rail, icons only. It widens to 300 × `--px` and shows names while the remote is in it or a mouse is over it.
- **States:** items are 82% white at weight 600; hover 14% white fill; the current page gets a 12% fill and an accent dot; focus is a solid white pill with ink text.
- **Phones:** the same items in a dock at the bottom.
- **Cluster:** clock and profile picture in a Tinted Glass pill at the top right.

### Dialogs
- **Surface:** Tinted Glass with blur, the glass edge and top highlight, and the deepest shadow (`0 30px 80px` at 60% black). Radius 38 × `--px`; up to 720 × `--px` wide, 1000 for the wide variant, always 32px clear of the screen edges.
- **Structure:** a head (title at 32 × `--px`, weight 700), a scrolling body in Body type, and right-aligned actions with no divider line above them.
- **Behind it:** the page is dimmed with 55% Page Shade and not blurred.
- **Sheets:** the "…" menu is a narrower dialog (480 × `--px`) holding a column of 64 × `--px` pill items at weight 500. Hover is a 12% white fill; focus is the white pill with ink text.

### Player bar
- **Surface:** a Tinted Glass bar floating over the video, inset 48 × `--px` from the sides and 40 from the bottom, radius 38 × `--px`. On phones it is inset 10px with a 26px radius.
- **Seek bar:** a 5px track at 22% white, filled in the accent up to the playhead, with a lighter buffered range and a 16px white thumb. Times use tabular numerals at Label size. Scrubbing shows a preview picture above the bar with a white 2px outline and a time pill.
- **Buttons:** round, at least 42px and 64 × `--px`, transparent at rest with white icons; hover is a 14% white fill; focus is solid white with ink and the ring. Play is solid white at rest.
- **Top:** the title (30 × `--px`, weight 700), a subtitle line and the clock sit on a black-to-clear gradient, not on glass.

### Player menu
- **Surface:** a side panel for subtitles, audio and quality, fixed 48 × `--px` from the top, right and bottom, 560 × `--px` wide, radius 38. It uses a denser glass (66% fill, 40px blur) because it sits over moving video. On phones it becomes a bottom sheet up to 70% of the height.
- **Items:** 64 × `--px` pills at weight 500. The chosen item is white at weight 600 with an accent tick; small details sit in an outlined tag. Focus is the white pill.
- **Skip intro:** a solid white pill above the bar with a thin accent line along its bottom edge that shortens as the intro plays.

### Mini-player
- **Surface:** a Tinted Glass pill floating at the bottom right while music plays (460 × `--px` wide, radius 30, 14 padding): cover, title, artist and a white Play button, with a thin accent progress line along the bottom.
- **Expanded:** with the remote or a mouse on it, it grows to 560 × `--px` and stacks the full controls (previous, next, seek, volume, Up next) under the title.
- **Buttons:** 52 × `--px` circles at 86% white; Play is 56 × `--px` and near-solid white. Focus is solid white with the ring.
- **Phones:** it spans the width, 12px from the sides, above the dock.

### Up next
- **Surface:** a Tinted Glass card at the lower right of the player near the end of an episode (520 × `--px` wide, radius 36), with the next episode's picture (radius 22) on top.
- **Content:** an accent eyebrow, the title at 26 × `--px` weight 700, a meta line in Soft White, and two buttons.
- **Countdown:** a thin accent ring on the Play now button empties as the seconds run out. Under reduced motion it steps once a second instead of sweeping.

### Spotlight
The Home page's signature. The focused title's clear logo, or its name in Display type, sits lower left over the artwork with a meta line, genres, two lines of plot and the action buttons. It changes as focus moves along the rows, and the artwork and tint change with it.

## Do's and Don'ts

### Do:
- **Do** write sizes as `calc(N * var(--px))` with N taken at 1920 × 1080, and give anything tappable a `max(44px, …)` floor.
- **Do** use `var(--accent)` for progress, current state and small highlights so they follow the artwork.
- **Do** mark focus with solid white, ink text and `var(--ring)`; add `var(--lift)` and a small scale on cards and buttons.
- **Do** draw surface edges with inset box-shadows rather than borders.
- **Do** build glass from the `--glass-*` and `--blur-*` tokens so Reduce effects and reduced transparency work without extra code.
- **Do** keep text at 4.5:1 or better against what is behind it, including over white artwork.
- **Do** honour `prefers-reduced-motion` and `html.reduce-motion`: nothing grows.

### Don't:
- **Don't** use the accent to show what is selected. White does that.
- **Don't** put `backdrop-filter` on anything that scrolls, or blur the whole page behind a dialog.
- **Don't** add uppercase, tracked-out labels in Orbit.
- **Don't** hard-code an accent hue, or assume the accent is Ice.
- **Don't** cover the artwork with opaque full-width bars or boxed page backgrounds.
- **Don't** add a second typeface to Orbit, or load fonts from a network.
- **Don't** add a dependency or a build step to produce styles; the stylesheets are plain CSS, edited and refreshed.
