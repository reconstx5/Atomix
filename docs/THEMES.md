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
| `--backdrop-dim`, `--backdrop-blur`, `--backdrop-opacity`, `--backdrop-saturate` | how the full-screen artwork behind the pages is shown (e.g. `--backdrop-blur: 12px` for a frosted look) |

The Arctic themes also define `--panel` (glassy panel colour), `--focus` / `--focus-text` (the white used for
whatever has keyboard or remote focus) and `--halo` (the glow around it). Other themes can use these names too.

### The artwork's colour: `--tint`

Whenever the artwork behind the page changes, Atomix works out the colour it would cast into a dark room and
sets `--tint` on the page (a vivid colour, adjusted so it shows on a dark background and dark text on it stays
readable). It changes smoothly between titles. Arctic uses it for the glow behind the page, focus halos, progress
bars and the main button. Set `--tint-default` for pages or artwork without a colour of their own; a person's
chosen accent colour replaces that default. Artwork served from another site can't be read, so it keeps the default.

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
- **Reduce effects** (a profile setting) sets `html.reduce-effects`, and every `backdrop-filter` is switched off.
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

Keep text contrast at least 4.5:1 against `--bg` and `--surface` so everything stays readable.
People can override your `--accent` with their own colour in their profile.
