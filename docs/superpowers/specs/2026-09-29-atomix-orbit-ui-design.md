# Atomix "Orbit" look — design

Date: 29 September 2026. Status: approved in conversation, section by section; this write-up is for review.
Mockups: the "Atomix redesign" canvas (claude.ai artifact), boards named below. The artwork on the boards is
placeholder art drawn for the mockups.

## Why

Dallas wants a look that defines Atomix rather than echoing Kodi's Arctic skins. His references: Arctic Horizon 2,
two SlothUI streaming shots, Netflix, and a Netflix-on-Vision-Pro concept video. What they share, and what Orbit
keeps: the artwork is the screen, controls float on it as glass, titles are big and bold, buttons are pills, rows of
wide cards carry progress bars.

**Success:** on a TV with a remote, Atomix is recognisable at a glance (a floating window over its own artwork, a
floating glass menu), every screen is reachable with arrows, OK and Back, it stays smooth on a modest TV browser,
and nothing existing is lost: the six current themes, all features, and the tests.

## Decisions (from Dallas)

1. Design for a **TV with a remote first**; laptop and phone adapt.
2. Direction **A. Orbit** (Vision Pro-led), chosen over B. Pulse and C. Horizon.
3. Menu **floating on the left**, growing to show names when selected (board "Orbit menu 2").
4. Foundations as on the "Orbit foundations" board: Sora, white for selection, accent from the artwork, two kinds of
   glass, a Reduce effects switch, shapes and timings below.
5. Sections 2 to 7 approved as presented (summarised below).

Not in scope: new features (watchlists, trailers, collections), new pages, a light version of Orbit, or changes to
the older themes' looks.

## 1. Foundations

- **Type:** Sora (Google Fonts, SIL OFL) for everything, shipped in `public/fonts/` (latin and latin-ext woff2,
  weights 400/500/600/700, plus the licence). Roboto Condensed and League Gothic stay for the older themes.
  A film's clear logo replaces the typed title wherever a title is shown large (as today).
  TV scale at 1080p: display 116/700 (−0.045em), page title 56–100/700, section 26/600, body 22/400, meta 20/500,
  caption 16/500. The same scale shrinks for laptops (0.72×) and phones (0.4×, with a 16px minimum).
- **Colour:** deep space `#05050C` behind everything; window shade `#04040E` at 92% for the darkest scrim; text white,
  soft text 86% white, captions 66% white. **White means "the remote is here".** The accent is `--tint`, the
  colour taken from the artwork (existing `tint.js`/`backdrop.js`); without artwork it falls back to the profile's
  accent colour, else ice blue `#8FE9FF`. The accent is used for progress bars, the small line above a title, the
  current-page dot in the menu, the season underline, switch tracks and glows. Never for the selection itself.
- **Glass:** *clear glass* for buttons (`rgba(255,255,255,.14)`, blur 24px, saturate 1.6, 1px inner hairline at 24%);
  *tinted glass* for the menu, panels, dialogs, control bars (`rgba(28,28,42,.5–.66)`, blur 30–40px, hairline 16%,
  top highlight 22%, soft shadow). **Reduce effects** (new profile setting) and browsers without `backdrop-filter`
  get solid equivalents (`rgba(24,24,36,.94)`), no blur anywhere.
- **Selection:** the item grows (buttons 1.05, cards 1.08, avatars 1.1) and gets a white ring with a dark gap
  (`0 0 0 5px <background>, 0 0 0 9px #fff`) plus a lift shadow. Menu and list rows turn into a white pill with dark
  text. Keyboard focus looks the same (it is the same thing on a TV).
- **Shape:** window radius 44 (TV), 32 (laptop); cards 18; buttons and pills fully round; tags 7.
- **Motion:** selection 180ms ease-out; artwork cross-fade 600ms; page change slides the window content 24px and
  fades, 240ms; menu growing 220ms. Reduced motion (system setting or profile): no scaling, sliding or cross-fades.

## 2. The window, the menu and the remote

Boards: "Orbit menu 2" (resting), "TV: the menu open", "Laptop", "Phone".

- **Layout (TV and laptop: landscape and at least 1000px wide):** a full-screen *environment* (the current artwork, blurred and
  darkened), the *window* (rounded, inset 40px top/right/bottom and 168px left on TV; 20/100 on laptop) holding the
  page with the crisp artwork, and the *menu* floating left of the window, vertically centred. The Atomix mark sits
  above the menu. Clock and profile picture float top-right inside the window (profile picture opens the picker).
- **Menu contents:** Home, then one entry per library (icon by type, the library's name), Search, Add-ons, a divider,
  Settings. Kids profiles: no Add-ons or Settings (as today). The current page has a small accent dot; the remote's
  position is the white pill.
- **Remote:** Left from the leftmost control of a page (spatial navigation finds nothing further left) enters the
  menu, which grows to 300px with names and dims the page slightly. Up/Down move; OK opens that page; Right or Back
  closes it and returns focus to where it was. Back on a page goes to the previous page (as now); on Home, Back first
  scrolls to the top, then opens the menu. Back is only taken over inside Atomix's pages (not in text fields).
- **Environment cost:** drawn from a small copy of the artwork (the image scaled into a small layer and scaled up,
  so the blur is computed at low resolution), not a full-screen blur. Cross-fades with the artwork.
- **Phone and portrait tablets (narrower than 1000px, or taller than wide):** no window frame; artwork at the top of the page; the menu becomes a floating
  glass dock at the bottom (Home, Movies, TV, Music, Search; the selected one shows its name); Add-ons and Settings
  move under the profile picture.
- **Player:** full screen, no frame (section 5).

## 3. Home

Boards: "Orbit menu 2" (top of Home), "Home, moved down into the rows".

- The top area shows the selected card's artwork, colour, title or logo, details, format tags and description, after
  a 300ms pause so fast scrolling doesn't flicker (existing follow-focus behaviour).
- At the top: big title, Play and More info. Past the first row the top area shrinks (smaller title, no buttons,
  one-line description) so two rows fit; moving back up restores it.
- Card shapes: *wide* 16:9 (Continue watching, Next up, episodes) with a progress bar inside the bottom edge and a
  caption below (title, "S1 E4, 23 min left"); *poster* 2:3 for movies and shows, no caption (details are at the
  top); *square* for albums with album and artist below.
- Rows are unchanged: Continue watching, Next up, Recently added per library, add-on rows. The selected card stays
  near the left as the row scrolls. OK opens the item's page.

## 4. Show, movie and album pages

Boards: "Show page", "Album page, with music playing".

- **Show:** title or logo, details, tags, description. Buttons: the main one continues ("Resume S1 E4" / "Play S1 E1"),
  From the start, Mark watched, and a round "…" button holding Refresh info, Fix match, Download and (episodes)
  Edit intro. Admin-only actions stay admin-only. Seasons as round buttons, the viewed one underlined in the accent.
  Episodes as a row of wide cards (tick when watched, progress when started); the selected episode's description
  shows below the row with an "Episode details" button reached with Down. OK on an episode plays it. File details
  (video, audio, subtitles) in a glass panel further down.
- **Movie:** as the show page without seasons; the Details panel below the buttons.
- **Episode page:** as the movie page, with the show's name above the title (as today) and the intro line for admins.
- **Album:** large cover left; the page's colours come from the cover. Play, Shuffle, Add to queue. Songs in a glass
  list; the selected song is a white pill, the playing song is in the accent with a small moving-bars icon.
- **Artist:** name at the top, albums as square covers.
- **Mini-player:** a floating glass pill bottom-right on every page while music plays: cover, title, artist,
  progress, play/pause. Selecting it opens the full controls it has today (previous, next, shuffle, repeat, seek,
  queue).

## 5. Player

Boards: "Player: controls up, seeking", "Skip intro and Up next", "Subtitles panel".

- Any key shows the controls; they hide after a few seconds (as today). Title and year top-left, clock top-right.
- A floating tinted-glass bar at the bottom: time played, seek bar (accent fill, lighter band for what's loaded),
  time left; below, Pause (white circle), −10, +30, "Ends at …", and on the right Subtitles, Audio, Quality,
  Playback info, plus Next episode for episodes.
- Remote seeking as today (held arrows speed up, OK jumps); the preview picture and target time float above the
  marker with the step, e.g. "+30 s".
- **Skip intro:** white pill bottom-right with a thin accent line showing how much intro is left; takes focus as
  today. The "Skipped intro · Watch it" notice uses the same styling.
- **Up next:** glass card bottom-right: next episode picture, "Up next", number and title, show and length, "Play now"
  with a countdown ring, **"Keep watching"** (renamed from "Cancel"), "Starting in 8 s".
- **Menus** (subtitles, audio, quality, Find subtitles online) open as a tall glass panel from the right; the video
  keeps playing; Back closes it. Replaces the small pop-up menus.

## 6. Library, profiles, settings and the rest

Boards: "A library: Movies", "Who is watching?", "Settings: your profile".

- **Library:** name and count at the top; the existing controls as glass buttons (sort, Unwatched, genre, filter);
  posters with titles underneath (a grid needs names); the top of the page takes the selected poster's colour.
- **Who's watching:** round profile pictures over a soft glow; lock for PIN profiles, Kids tag; Manage profiles and
  Sign out as glass buttons. PIN entry: a glass panel with four large boxes.
- **Settings:** the existing sections listed on the left inside the window; options in glass groups; switches and
  pick-lists sized for the remote. Theme preview cards (from each theme's `preview` colours); Orbit is the default.
  New switch **Reduce effects**, next to Reduce motion.
- **Also restyled (no board):** Search (big glass search field, results in rows by type), Add-ons (like a library),
  sign-in and first-time setup (glass card over the deep-space background), dialogs (glass panels, round buttons),
  empty states and messages (short, say what to do next), toasts, loader (the mark, as today).

## 7. How it's built

**Approach: a third layout, "orbit", plus a new theme `themes/orbit/`.** Themes already declare `layout: top|side`;
Orbit adds `orbit`. Structure (window, environment, floating menu, dock, side panels) lives in `public/css/app.css`
under `body[data-layout="orbit"]`; the look (colours, glass, type) in `themes/orbit/theme.css`. Older themes keep
their layouts and look unchanged. Rejected: restyling everything as Orbit (changes every old theme, breaks
third-party themes) and a separate client (duplicate work).

Changes by area:

- `src/themes.js`: accept `layout: "orbit"`. `src/db.js` migration 8: a stored server default theme `arctic` becomes
  `orbit` (a theme picked for a profile stays). `src/settings.js`: default theme `orbit`. `src/api/account.js`:
  pref `reduceEffects: boolean`.
- `themes/orbit/`: `theme.json` (name Orbit, layout orbit, dark, preview colours) and `theme.css`.
- `public/fonts/`: Sora woff2 files and `OFL-sora.txt`.
- `public/js/app.js`: builds the orbit shell (environment layer, window, menu with names, mark, clock/profile
  cluster) when the theme's layout is orbit; `html.reduce-effects` from the pref; Back on Home as in section 2.
- `public/js/nav.js`: Left at the left edge enters the menu; Right/Back leave it and restore focus.
- `public/js/backdrop.js`: feeds the environment layer from the same artwork (small, scaled up), cross-fading
  with it.
- `public/js/views/home.js` / `components.js`: compact top area past the first row; card shapes as in section 3.
- `public/js/views/item.js`: episode row, "…" menu (new small glass menu component), Episode details button,
  season buttons, Details panel.
- `public/js/views/player.js`: control bar layout, side panel for menus, Skip intro progress line, Up next card and
  "Keep watching".
- `public/js/music.js`: floating mini-player pill with the full controls on selection.
- `public/js/views/settings.js`: theme preview cards, Reduce effects switch; `profiles.js`, `auth.js`,
  `library.js`, `search.js`, `addons.js`: restyle through shared classes (little markup change).
- Docs: `docs/THEMES.md` (the orbit layout and its selectors), `README.md`, `docs/ARCHITECTURE.md`.

**Accessibility:** text contrast 4.5:1 on its real background (scrims are sized for that); selection ring 3:1
against both the artwork and the window; everything reachable by keyboard and remote; icon-only buttons labelled
(names show on selection); reduced motion and Reduce effects honoured; `prefers-reduced-transparency` where the
browser supports it.

**Performance:** blur only on the few floating surfaces, never on scrolling rows; the environment at low
resolution; no layout work during selection (transform and opacity only); Reduce effects as the safety valve.

**Testing:**

- Unit/API (node:test): migration 8, `layout: orbit` accepted, `reduceEffects` pref saved and validated; the full
  suite (151 today) stays green.
- Browser checks (Playwright, dev server): menu enter/leave with Left/Right/Back and focus restored; Back on Home;
  compact top area; "…" menu; episode row plays; player side panel opens and Back closes it; Keep watching; mini-player
  pill; Reduce effects removes all `backdrop-filter`; reduced motion removes scaling; contrast and ring checks on the
  new screens; no console errors. Existing checks (`regress.mjs`, `extras-ui.mjs`, `rebrand-ui.mjs`) updated for the
  new markup.
- Older themes: screenshots of each before and after at TV size; they must match.
- Screenshots for Dallas at TV, laptop and phone sizes.
- Not testable here: a real TV browser and remote, glass smoothness on a slow TV.

**Delivery:** v0.7.0, built and checked in stages: (1) foundations, fonts, theme and migration; (2) shell: window,
environment, menu and remote; (3) Home; (4) detail pages; (5) player and mini-player; (6) settings and remaining
screens; (7) accessibility and performance pass, docs, screenshots.

## Risks

- Blur cost on low-end TV browsers: mitigated by the low-resolution environment, few glass surfaces and Reduce
  effects, but unmeasured on real hardware.
- The left-edge rule for entering the menu depends on spatial navigation finding nothing further left; pages with a
  control near the left edge but not the leftmost (for example a scrolled row) need care.
- Sora's width is larger than the condensed faces; long titles need clamping and ellipsis.
