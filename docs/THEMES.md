# Making an Atomix theme

Themes live in `themes/<folder>/` and are picked per person in **Settings → Profile** (admins set the default in
**Settings → Server**). The default is **Orbit**: the artwork fills the screen behind the page, with a glass
menu floating beside it. **Arctic** (inspired by the Arctic family of Kodi skins) and **Arctic Side** are still there, with
Midnight, Harbour, Daylight and Obsidian. Copy `themes/orbit` as a starting point for the Orbit layout,
`themes/arctic` for a menu bar, or `themes/midnight` for a simpler one. Changes to a theme's CSS show up on
refresh — no restart needed. New theme folders appear after a page reload.

```
themes/
  sunset/
    theme.json
    theme.css
```

## theme.json

```json
{
  "name": "Sunset",
  "description": "Warm purples and a gold accent.",
  "author": "You",
  "layout": "top",
  "colorScheme": "dark",
  "preview": { "background": "#1a1024", "surface": "#2a1a38", "accent": "#ffb347" }
}
```

- `layout`: `"orbit"` (a full-screen page over its artwork, a glass menu in a rail on the left, a dock on phones), `"top"` (menu bar)
  or `"side"` (Kodi-style side menu). Phones get a bottom tab bar in the top and side layouts.
- `colorScheme`: `"dark"` or `"light"` — sets native form controls and scrollbars.
- `preview`: colours for the little preview card in the theme picker.
- `stylesheet` (optional): CSS file name if it isn't `theme.css`.

## theme.css

Set these custom properties on `:root`. Everything in the app is built from them:

| Property | Used for |
| --- | --- |
| `--bg` | page background (also the fade under artwork) |
| `--bg-2` | inputs, inset areas |
| `--surface` | cards, panels, dialogs |
| `--surface-2` | secondary buttons, hover states |
| `--border` | hairlines around panels and inputs |
| `--text`, `--text-dim` | main and secondary text |
| `--accent`, `--accent-text` | highlight colour and the text drawn on it |
| `--danger`, `--success` | errors and confirmations |
| `--radius`, `--radius-lg` | corner rounding |
| `--poster-w` | poster width in rows and grids (phones use 70% of it) |
| `--nav-bg` | menu background (can be a gradient) |
| `--shadow` | card and dialog shadow |
| `--font`, `--font-display` | body and heading fonts. Atomix ships **Roboto Condensed** (Latin and Latin Extended, SIL Open Font License) so `"Roboto Condensed"` works offline; for anything else add `@font-face` with files in your theme folder |
| `--font-title` | typeface for big titles when there is no clear logo. Atomix also ships **League Gothic** (SIL OFL) for this |
| `--header-h` | height of the top menu bar |
| `--backdrop-dim` | how much of the page colour is laid over the full-screen artwork behind the pages (a percentage; the Arctic themes use 18–24%). `--backdrop-blur`, `--backdrop-opacity` and `--backdrop-saturate` were removed in v0.15.0 — the artwork is shown crisp at full opacity; a theme that wants a frosted look styles `.backdrop` itself (`filter: blur(12px)`) |

The Arctic themes also define `--panel` (glassy panel colour), `--focus` / `--focus-text` (the white used for
whatever has keyboard or remote focus) and `--halo` (the glow around it). Other themes can use these names too.

### The artwork's colour: `--tint`

Whenever the artwork behind the page changes, Atomix works out the colour it would cast into a dark room and
sets `--tint` on the page (a vivid colour, adjusted so it shows on a dark background and dark text on it stays
readable). It changes smoothly between titles. Arctic uses it for the glow behind the page, focus halos, progress
bars and the main button. Set `--tint-default` for pages or artwork without a colour of their own; a person's
chosen accent colour replaces that default. Artwork served from another site can't be read, so it keeps the default.

## Token layers (v0.29)

Colours come in three layers, all defined in `public/css/tokens.css` (loaded before `app.css`, `orbit.css` and your theme):

1. **Ramps** (yours): `--n-1` … `--n-12` for neutrals and `--a-1` … `--a-12` for the accent. Steps follow Radix: 1-2 page,
   3-5 component backgrounds, 6-8 borders, 9-10 solid fills, 11 low-contrast text, 12 high-contrast text. Dark themes run
   dark to light, Daylight runs light to dark.
2. **Old names** (`--bg`, `--bg-2`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-dim`, `--accent`): taken from the
   ramps when you define them (`--bg` = n-1, `--surface` = n-3, `--text` = n-12, `--accent` = a-9 ...).
3. **Semantic names** (`--app-bg`, `--surface-1/2/3`, `--border-subtle/-strong`, `--text-high`, `--text-low`, `--accent-solid`,
   `--accent-hover`, `--on-accent`, `--focus-ring`): from the ramps, falling back to the old names. Use these in new CSS.

Old names never point at semantic names, so nothing can loop.

### Making a theme

Pick one of two routes.

- **Old names only** (simplest): set `--bg`, `--bg-2`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-dim`,
  `--accent`, `--accent-text` as in the table below and no ramps. The semantic names follow your values, and the focus
  ring stays your accent colour. Atomix does not check the contrast of these themes, so check it yourself.
- **Ramps** (what the built-in themes do): define `--n-1..12` and `--a-1..12` in hex in `:root`, then the same colours
  as `oklch()` inside `@supports (color: oklch(0% 0 0)) { :root { ... } }` (browsers without oklch, such as older TVs,
  keep the hex; never put oklch next to the hex, a custom property does not fall back). Print both blocks with
  `node devtools/ramp.mjs <theme>` after adding your anchors to its `THEMES` table (`n` anchors for steps 1-4, 11, 12 and the
  accent for a-9; the steps between are interpolated in OKLCH), or `node devtools/ramp.mjs --table` to see every theme.

What `test/theme-tokens.test.js` needs from a built-in theme (add it to the test's `THEMES` list): every semantic token
resolves (in modern and legacy browsers), an oklch value for every hex step, no var() cycle, and APCA contrast (Lc) on
`--app-bg` and the surfaces of at least 75 for `--text-high`, 60 for body text (`--text-low`) and 60 for `--on-accent` on
`--accent-solid`, and 3:1 (WCAG) for `--focus-ring` on `--app-bg`. Run it with `node --test test/theme-tokens.test.js`.
With the dev server up, `devtools/type-floor.mjs`, `focus-check.mjs`, `scrim-check.mjs` and `accent-check.mjs` check
type sizes, focus rings, text on artwork and the accent picker in every theme.

Other tokens a theme can set: `--scrim-colour` (the colour of the page scrim over artwork; black unless the page is light),
`--focus-ring` (pin `#fff` on a dark theme). Type sizes on TVs (1600 px and wider, landscape) have a floor of 20 px for
captions and 24 px for body, metadata and card titles; Orbit's `--t-*` scale is floored in the same block.

A person's accent (Settings → Appearance: 10 swatches, Theme default or a custom hex) is moved into your theme's band in
OKLCH (dark L 70-80 %, light L 45-55 %, C 0.10-0.15), its `--a-*` ramp is regenerated, and the text on it is black or white by APCA.
So a theme's own `--a-*` only matters for the default.

### Modes and choices over any theme (v0.29)
Profiles can turn these on in Settings → Appearance; they work through tokens, so a theme gets them for free:
- `html[data-glass="clear"|"tinted"|"solid"]` and `--glass-alpha` / `--glass-blur` (.12 / 16 px, .58 / 34 px, .92 / 0).
  Paragraph panels never go below `--glass-panel-floor` (.66).
- `:root[data-oled]` (dark themes only): `--n-1`, `--n-2`, `--app-bg`, `--bg`, `--bg-2` are #000; panels, dialogs and card
  art get a 1 px `--border-subtle` edge; the environment layer is hidden.
- `:root[data-contrast="more"]`: `--text-low` = `--text-high`, `--text-dim` = `--text`, a 4 px focus ring, 2 px
  `currentColor` edges on buttons, pills, chips, fields and card art, Solid glass.
- `--text-scale` (1, 1.15, 1.3): the root font size on rem-based themes; Orbit multiplies its `--t-*` tokens.
- Forced colours (Windows High Contrast): the backdrop, scrim and environment are hidden.
A theme that sets colours outside the ramps should check them with `node --test test/theme-tokens.test.js` (it runs
every theme with More contrast and, for dark themes, OLED).

## The orbit layout

Themes with `"layout": "orbit"` get Orbit's structure from `public/css/orbit.css`; their `theme.css` only gives the
look. What the structure provides:

- **The page** (`main`): a fixed, full-screen box the page scrolls inside; its left padding (`--rail-pad`) keeps the menu's rail clear.
  - TVs (landscape, 1600 px and wider): inset 40/40/40/168 px, radius 44.
  - Laptops (landscape, 1000–1599 px): 20/20/20/100 px, radius 32.
  - Phones and portrait screens: no window.

  `.backdrop` (the crisp artwork) fills the window.
- **The environment** (`.environment`): the same artwork all round the window. It is drawn into a 64 × 36 canvas and
  stretched, so it looks blurred without a full-screen blur. Style its shade with `.environment::after`.
- **The menu** (`.orbit-menu`, entries `.nav-link[data-nav]`):
  - It floats in the rail on the left and grows to show names while the remote is in it (`html.menu-open`) or under a mouse.
  - `[aria-current="page"]` marks the page you're on.
  - On phones it is a dock at the bottom, and Add-ons and Settings move to `.orbit-tool` buttons in the corner.
- **The cluster** (`.orbit-cluster`): the clock and the profile picture, at the screen's top-right.
- **Sizes** are written as `calc(N * var(--px))`, where `--px` is 1px at 1920 px wide, 0.72px at least, and 0.4px on phones.
  The rail's width is `--win-l` (168 × `--px` on TVs, 112px on laptops, 0 on phones).
- **Glass** (Settings → Appearance: Clear, Tinted or Solid; v0.29) sets `html[data-glass]`. Solid switches every
  `backdrop-filter` off; it is the default on TV-size screens, in browsers without blur and with the system's "reduce
  transparency" or More contrast. `html.reduce-effects` is set only when the profile chose Solid (or had the old Reduce
  effects switch on): card motion stops its sheen and preview clips then.
  `themes/orbit` also turns its glass solid; use the same `--glass-*` names if you want that for free.

`themes/orbit/theme.css` documents its tokens:
- glass: `--glass-clear`, `--glass-tinted`, `--glass-panel`, `--glass-cluster` (the clock's pill), `--blur-clear`, `--blur-tinted`;
- selection: `--ring`, `--lift`, `--grow-btn`, `--grow-card`, `--grow-avatar`;
- type: `--t-display` … `--t-caption`.

The accent is `--tint`, the colour of the artwork.

## What the layout gives you

- **Artwork behind every page.** Home and library pages change it to follow the focused title; detail pages show the
  title's own fanart. It fades to `--bg` on the left and bottom so text stays readable.
- **A spotlight on the home screen** with the focused title's name, info line, genres, plot and buttons. On screens
  at least 721 px wide and 560 px tall it stays fixed while the rows scroll underneath (TV style); on phones it is part
  of the page.
- **A clock and the date** in the top bar (top-right corner in side-menu layouts).
- **Clear logos.** When a title has a `clearlogo.png` / `logo.png` (or one from TMDB), the spotlight and detail page
  show it instead of the typed title. Style it with `.spot-logo` and `.detail-logo`.

Handy selectors: `.spotlight`, `.spot-title`, `.spot-logo`, `.spot-overview`, `.home-rows`, `.row-title`, `.card-art`,
`.meta-line`, `.media-flags`, `.ends-at`, `.backdrop`, `.nav-clock`, `.loader`, `.mini` (music player),
`.seek-preview`, `.seek-preview-img`, `.seek-preview-time` (the seek-bar preview; the picture's width is `--preview-width`),
`.skip-intro`, `.skip-intro-bar` (its width follows `--left`, 1 → 0 as the intro plays) and `.intro-line` (admins, episode pages).

In Orbit also: `.orbit-menu`, `.orbit-cluster`, `.environment`, `.episode-row`, `.episode-story`, `.details-panel`,
`.upnext-art`, `.upnext-ring` (its fill follows `--left`) and `.home-view.is-compact` (Home below the first row).

You can also override any selector from `public/css/app.css`, for example:

```css
/* Bigger focus zoom for a TV */
.card:focus-visible .card-art { transform: scale(1.1); }

/* Square posters */
.art { border-radius: 0; }
```

Keep text contrast at least 4.5:1 against `--bg` and `--surface` so everything stays readable (the built-in themes are held to APCA, see above).
People can override your accent with their own colour in their profile.
