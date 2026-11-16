# Visual refresh — design (v0.29)

Dallas, 12 Nov 2026: "Do a deep-research on UI designs and add visual improvements to the Orbit theme and others."
Research: `reports/Media app UI design 2026.md` (project doc `claude/media-app-ui-design-2026.md`). He picked **all P1
items, accessibility modes, pinnable libraries and shared polish pieces**, and **"Yes, improve them all"** — the old
rule "older themes stay pixel-identical" is lifted for this work (each theme gets before/after pictures). Design
approved in chat ("looks good").

Three plans, delivered in turn: **A foundation**, **B choices and polish**, **C each theme + gallery**.

## Principles

- Premium is decided by the floors: readable text at 10 feet, text that stays readable over any artwork, focus visible
  on any artwork, layouts that don't shift.
- Glass on chrome, never under paragraphs; the user can turn it down.
- Every theme is the same token interface; themes differ only in values (and Orbit/Arctic-side layout).
- Back-compat: existing token names (`--bg`, `--bg-2`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-dim`,
  `--accent`, `--accent-text`, `--radius`, `--radius-lg`, `--shadow`, `--nav-bg`, `--font`, `--font-display`, Orbit's
  `--t-*`) keep working as aliases so a user's copied theme folder still loads.

## A. Foundation

### A1. Token layers
- **Primitives** (per theme, in the theme file): a 12-step neutral ramp `--n-1 … --n-12` and a 12-step accent ramp
  `--a-1 … --a-12`, written in OKLCH with a hex fallback line before each OKLCH line (old TV browsers). Step roles
  follow Radix: 1–2 app backgrounds, 3–5 component backgrounds/states, 6–8 borders, 9–10 solid fills, 11 low-contrast
  text, 12 high-contrast text.
- **Semantic** (defined once in `public/css/tokens.css` from the primitives; a theme may override):
  `--app-bg` (n-1), `--surface-1/2/3` (n-2/3/4), `--border-subtle` (n-6), `--border-strong` (n-8), `--text-high`
  (n-12), `--text-low` (n-11), `--accent-solid` (a-9), `--accent-hover` (a-10), `--on-accent` (computed ink),
  `--focus-ring` (theme choice), `--danger`, `--success`.
- **Component**: `--card-radius`, `--poster-aspect` (2/3), `--wide-aspect` (16/9), `--row-gap`, `--glass-alpha`,
  `--glass-blur`, `--scrim-*`, the radius scale `--r-xs/sm/md/lg/xl/full` = 4/8/12/16/24/999 px, the focus ring
  `--focus-width`, `--focus-offset`.
- **Aliases** map the old names onto the semantic ones (`--bg: var(--app-bg)` etc.) in `tokens.css`, after the theme's
  own values so a legacy theme that sets only old names still wins (old names are read as the semantic values when a
  theme defines no ramps — see "legacy theme" below).
- **Legacy theme**: a theme folder that defines no `--n-*` ramp keeps working exactly as today (its old tokens are used
  directly); the token checks only apply to Atomix's own themes.

### A2. Token checks (Node tests, `test/theme-tokens.test.js`)
- Every built-in theme defines the full semantic set (directly or via its ramps), for each mode it supports.
- **Contrast** (APCA, implemented in `src/themes/apca.js` from the published APCA-W3 0.1.9 constants): `--text-high` on
  `--app-bg` and every `--surface-*` Lc ≥ 75; `--text-low` Lc ≥ 60; `--on-accent` on `--accent-solid` Lc ≥ 60;
  `--focus-ring` against `--app-bg` WCAG ≥ 3:1. Orbit's glass: the text tokens against the Solid and Tinted glass
  fallbacks composited on its darkest and lightest environment tint.
- **No new raw colours** in component CSS: a baseline count of hex/rgb literals in `public/css/*.css` outside token
  blocks is recorded; the test fails if it grows.

### A3. TV type floor
- TV = the existing Orbit TV breakpoint (wide landscape ≥ 1600 px) and, for other layouts, `min-width: 1600px` and
  `(pointer: coarse) or (hover: none)` is not required — width is the signal (same as today's TV sizing).
- At 1080p TV: caption ≥ 20 px, card titles/metadata ≥ 24 px, body ≥ 24–28 px, weights ≥ 400 (metadata ≥ 500). Orbit:
  `--t-caption` 16→20, `--t-meta` 20→24, `--t-body` 22→26, `--t-card` 19→22 (× `--px`). Other themes get a TV size block
  with the same floors. Laptops and phones keep their current sizes unless below 12 px.

### A4. Focus
- One focus style per theme with **two cues**: an outline-based ring (survives forced colours) of `--focus-width`
  (3 px desktop, 4 px TV) at `--focus-offset`, plus the existing lift or a fill change. Ring colour `--focus-ring`
  (white on dark themes, near-black on Daylight) with a 1 px dark/light halo so it reads on any artwork.
- Rows reserve `(scale − 1) × card width ÷ 2` of gutter so a lifted card never covers its neighbour or the heading.
- Never colour alone; never transitions (Capture rule).

### A5. Text over artwork
- One scrim recipe in `tokens.css`: the 13-stop eased black gradient (Andreas Larsen), plus a radial edge falloff, used
  by every spotlight, detail header, landscape-card caption and Live TV card. Height ≥ text block + 25 %.
- Test (browser check): text over a pure white backdrop reaches WCAG ≥ 4.5:1 (synopsis APCA Lc ≥ 75 target).

### A6. Accent for every theme
- The accent picker (today Orbit-only? — the existing chosen-accent logic in `public/js/tint.js`, `app.js:270`) is
  offered in every theme: 10 curated swatches + "Custom…" hex entry.
- Clamp: on dark themes the accent is moved to OKLCH L 70–80 %, C 0.10–0.15 (hue kept); on Daylight L 45–55 %.
  `--on-accent` = black or white by APCA. Non-text accent uses meet 3:1 on `--app-bg`. The accent ramp `--a-*` is
  regenerated from the chosen hue.

## B. Choices and polish

### B1. Glass setting (Orbit)
- Settings → Appearance "Glass": **Clear / Tinted / Solid**, profile pref `glass` ('clear'|'tinted'|'solid'), replacing
  the "Reduce effects" switch (existing `reduceEffects: true` reads as 'solid'). Tokens `--glass-alpha` (Clear .12,
  Tinted .55, Solid .92) and `--glass-blur` (Clear 16 px, Tinted 16 px, Solid 0).
- Defaults: Tinted on desktop/phone; **Solid on TV-size screens** and where `backdrop-filter` is unsupported;
  `prefers-reduced-transparency` forces Solid.
- Paragraph panels (Details, side panels, Up next) never go below Tinted alpha (floor .66) even in Clear.
- Glass budget: at most menu, player bar, side panel, mini-player; no glass on scrolling rows.

### B2. Modes over any theme (Settings → Appearance, profile prefs)
- **OLED black** (`oled`): `--app-bg` #000, surfaces one/two steps up, 1 px `--border-subtle` hairlines on cards and
  panels; Orbit's environment layer off.
- **High contrast** (`contrast: 'more'`): opaque surfaces, 2 px `currentColor` borders on controls and cards,
  `--text-low` = `--text-high`, focus ring 4 px everywhere; turned on automatically by `prefers-contrast: more`
  (profile can override); `forced-colors: active` respected (system colours, no backgrounds images behind text).
- **Large text** (`textScale`: 1 | 1.15 | 1.3): a multiplier on every type token.
- Implemented as `html[data-oled]`, `[data-contrast="more"]`, `--text-scale` set by `app.js` from prefs.

### B3. Pinned libraries
- Profile pref `pinnedLibraries`: ordered list of library ids (absent = today's behaviour: all libraries in their order).
- Orbit's rail, the phone dock (first three) and Arctic Side's list show pinned libraries in order, the rest under
  "More". Settings → Appearance → "Menu": tick to pin, Move up/down (remote-friendly), and a "…" on a menu entry
  (Pin / Unpin / Move up / Move down).

### B4. Shared polish pieces (`public/js/ui/media.js` + `components.js` twins)
- **Logo box**: fixed height (detail ≈ 15 % of hero height, max 40 % width), `object-fit: contain`, left/bottom
  aligned, drop shadow; typed title in the same box until/unless the logo loads.
- **Metadata line**: year · certificate · runtime or seasons · genres; then outlined chips from media info: 4K, HDR10,
  Dolby Vision, HDR10+, Atmos, 5.1/7.1, Subtitles.
- **Badges**: "New season", "New episode", "N unwatched", "Leaving soon" not used (no data) — only badges Atomix can
  compute. Short words, top-left of the card, `--surface-3` with `--text-high`.
- **Progress track**: 3 px (4 px TV) flush with the card's bottom edge, track `--n-6`, fill `--accent-solid`.
- **Watched mark**: corner tick in a small disc.
- **Skeletons**: shaped like the real page (card ratios, title bars), shown only after 1 s; shimmer 0.06 white, off
  under reduce motion and on TV.

## C. Each theme

- **Orbit**: off-white text (`oklch(94% .005 <hue>)`) so the white focus ring is the brightest thing; environment tint
  clamped to L ≤ 20 %, C ≤ 0.04; ~6 posters per TV row with the next peeking; video-safe player chrome (shadow on
  icons/clock).
- **Arctic / Arctic Side**: flat dark surfaces from the ramp, clear logos where a large title shows, full-bleed fanart
  behind the focused item with the eased scrim; League Gothic for titles only, body in a regular-width sans 400–500;
  tokens `--button-shape` (square|pill). Rebuilt from scratch — no Arctic assets, fonts or XML (CC BY-NC-SA).
- **Midnight**: the no-blur low-power reference — surfaces L ≈ 8/11/14/17/20/24 % with a slight hue, elevation by
  lighter surfaces + 1 px top highlight, text at steps 11/12.
- **Obsidian**: the OLED theme (true #000 option on by default in this theme), hairline borders, text L ≈ 90 %, a loud
  flat focus ring.
- **Daylight**: off-white canvas L ≈ 96–97 %, darker accent steps, dark ink for light accents, dark scrims kept on
  artwork, shadows for elevation; on TV-size screens the canvas dims to L ≈ 90 %.
- **Harbour**: growth always paired with the ring at key-press; gutters from the growth factor; growth capped so ≥ 5
  posters stay visible per TV row; grown-card content uses the shared pieces.
- **Gallery**: before/after screenshots of every theme on desktop 1920×1080, TV 1920×1080 at 10-foot sizes, and phone
  390×844 (Home, a library, a title page, Live TV, Settings) published as a private artifact page.

## Not in scope
- Layout/palette separation for every theme (P2, later). Artwork-driven accent (P3). Seasonal themes.
- New layouts. Motion (done in Capture and card motion v2).

## Testing (all plans)
- Node: token checks (A2) for every theme and mode; APCA unit tests against published reference pairs; prefs.
- Browser: focus ring present and ≥ 3:1 on every theme; scrim over white; TV type floor (computed sizes); Glass modes;
  OLED / contrast / large text; pinned libraries order across rail, dock, Arctic Side; logo box no layout shift (CLS 0);
  skeleton timing.
- Before/after gallery reviewed by Dallas.

## Risks
- Every theme changes look: Dallas approved; the gallery is the review.
- OKLCH not supported on old TV browsers: every OKLCH value has a hex fallback line before it.
- Font sizes up on TV may reduce how much fits; rows keep ~6 posters by design and checks.
