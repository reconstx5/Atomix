# Atomix (NodeFlix) — notes for Claude Code

Atomix is a self-hosted media hub in the spirit of Kodi: films, TV, music and Live TV
(IPTV), served by a Node server to browsers, phones (installable web app) and TVs
(casting). It runs on a home PC or on its own server/VPS. Owner: Dallas (GitHub reconstx5).

## Hard constraints
- Node >= 22.13 (uses built-in `node:sqlite`) plus ffmpeg. On Windows, when ffmpeg isn't on PATH yet
  (winget's PATH change only reaches new windows), `src/windows-tools.js` finds it in the winget/Scoop/Chocolatey folders.
- No `npm install`, no bundler, no build step. Do not add dependencies.
- Front end is Preact 11 + htm vendored in `public/js/vendor`; screens import through
  `public/js/ui.js` (see CONTRIBUTING.md, "How to write an Atomix screen").
- No DRM circumvention. Encrypted channels are only relayed to the device's own
  EME/FairPlay; keys are never extracted.
- Provider addresses, keys and tokens never reach browsers, TVs or logs.
- Every theme passes the token checks (test/theme-tokens.test.js); visual changes get before/after pictures.
- Kids profile rules and per-account stream caps must keep working.

## Layout
- `src/` server (`src/app.js` routes; `src/live/` Live TV + HLS relay; `src/cast/` casting
  and cast tokens; `src/tls/` HTTPS setup)
- `public/js/` web app (`views/` screens, `dash/` DASH/EME/FairPlay helpers)
- `plugins/`, `themes/`, `test/`
- Docs: `docs/ARCHITECTURE.md`, `THEMES.md`, `PLUGINS.md`, `CONTRIBUTING.md`
- Design specs and plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`

## Commands
- Run: `npm start` (Windows: `start-windows.bat`); dev: `npm run dev`
- Tests: `npm test` (= `node --test test/*.test.js`, ~1540 tests; run it in a few groups, a single run can exceed 10 minutes). Live-tuner tests are slow;
  run them on their own if the full run times out.
- Reset a password: `npm run reset-password`

## How we work
- Test first: write the failing test, watch it fail, then fix (RED -> GREEN), then full suite.
- Bigger features: brainstorm -> spec -> plan -> execute, then one fresh review and one fix pass.
- Messages shown to users are plain-English sentences that say what happened and what to do.
- Git: Dallas decides when to commit and push. Remote: https://github.com/reconstx5/Atomix.git
  Commits are authored as reconstx5 (the repo's git config) with **no co-author line** (Dallas, 17 Nov 2026).

## Current state (17 Nov 2026) — start here
- Everything is committed on `main` and pushed to GitHub: v0.28 and v0.29 (iPhone playback fixes, card motion v2,
  batch 3, multi-DRM, visual refresh A and B) are commit c4cdb6d, and Plan C follows it. The sections below that still
  say "uncommitted" date from before that commit. Dallas decides when to commit; suggest committing before large new work.
- Work moved to Claude Code on this PC on 17 Nov. The handoff (what was done, decisions, deferred minors, what's next)
  is `docs/HANDOFF-2026-11.md`. The design research is `Claude outputs/Media app UI design 2026.md`.
- Visual refresh **Plan C is done and merged into `main`** (17 Nov, a fast-forward from c4cdb6d; branch deleted). The title page on Preact is built on branch `title-page-preact` (18 Nov, not merged); next the Jellyfin API.
  Plans A, B and C: `docs/superpowers/plans/`.
- Still to verify on real hardware: iPhone FairPlay and films on iPhone, Chromecast with encrypted channels, PlayReady
  on Edge/Xbox, TV timings for motion, Safari view transitions.

## Motion ("Capture", v0.28 work, committed d7c36b4)
- Follow the `web-animation` skill for any animation work.
- One attribute decides how much moves: `html[data-motion]` = full | reduce | none (`public/js/motion.js`, rules in
  `public/js/motion-rules.js`, tested in `test/motion-rules.test.js`). `html.reduce-motion` is still set when not full.
- Signatures: the settle spring (`--ease-settle`, scale only), the focus orbit + press ring, and depth-aware screen
  changes with a poster morph (`public/js/transitions.js`, CSS at the end of `public/css/app.css`).
- Focus rings and shadows never transition; only transform/opacity tween. Hover effects sit behind
  `@media (hover: hover) and (pointer: fine)`. A held arrow (`html.nav-held`) stops all tweens.
- Not yet checked on real hardware: timings on a TV, view transitions on a long page, Safari.

### Card motion v2 (v0.28, uncommitted)
- Files: `src/extras/clips.js` (the 5 s silent preview clip, job `clip`), `src/library/colors.js` (dominant colour of
  an item's artwork), `public/js/card-motion.js` + `card-motion-rules.js` (selection, sheen, live preview, gates),
  `public/js/transitions.js` (card-to-page morph, Back restore, first-screen ripple), tokens at the top of
  `public/css/app.css` (`--card-lift`, `--dim-others`, `--fade-in-art`, `--ripple-step`, ...) and a "Card motion v2"
  section at its end.
- Migrations: 32 rebuilds `media_jobs` so it accepts `'clip'` (job names are CHECK-constrained); 33 adds
  `items.colors`. Cards carry `tint` (poster colour) and `tintWide` (backdrop colour), null until computed.
- Settings: admin `cardClips` ("Make preview clips for cards", Settings -> Server) and the profile `cardPreviews`
  ("Play previews on cards", Settings -> Appearance, after the Glass choice; unset = on).
- Rules that matter:
  - The card colour is `--card-tint`, never `--tint` (Arctic paints progress bars with `--tint`, and it is a
    registered page-wide property). Lift is `--card-lift` (Orbit's `--lift` is a shadow).
  - Tiers: full gets lift, glow, dim, sheen, clips, the morph and the ripple; reduce keeps opacity-only fades (no
    scale, dim, sheen, clip, stagger or rise); none is instant. Resting pixels stay identical in every theme.
  - `html.nav-held` (a held arrow) means no clip request, no sheen, no transition, no morph, no smooth scroll.
  - One preview video at a time, muted, shown only after its first `playing`, dropped (src released) when focus
    moves, any key is pressed or the page hides; no clip, a failed play() or a clip not playing 2.5 s after its src
    is set falls back to the still-frame flip (8 pictures × 620 ms, within 5 s). `previewMode()` in
    card-motion-rules.js decides: the pref off, saveData or a 2g connection → no preview at all (no clip, no flip,
    no manifest or sheet request); Kids → the flip only. A held arrow let go rests on the card it landed on.
  - Opening a title waits (inside the 300 ms budget, never longer) for the page's backdrop picture
    (`backdropReady()` in backdrop.js); not there in time → the morph goes into the page poster or a plain fade.
  - Card colours (`noteColor`) are worked out only for films, shows, episodes and seasons, with ffmpeg at nice 10.
  - Back restores the card (focus first, then scroll positions) per page address; a card off screen or gone gets a
    plain fade and no morph. The morph never waits more than 300 ms for the page.
- Checks (`devtools/`): `card-select.mjs`, `card-clip.mjs`, `card-open.mjs`, `card-load.mjs`, and
  `ART=1 PAGES='#/,#/library/1,#/item/1' node devtools/fixed-compare.mjs` for older themes at rest with artwork. `card-clip`'s Kids
  check is a client stub (`state.profile.kids`); the server's Kids 404 is tested in `test/clips.test.js`.
  `home-fn.mjs` has 3 known failures while the mock IPTV "On now" row is first on Home.
- Still needs real devices: timings on a TV; Safari and iPhone (muted inline autoplay, view transitions, image
  decode before the morph); how long clip generation takes on a large library.

## Open issue: films and TV won't play on iPhone (fix delivered, waiting on a real iPhone)
- iPhone Safari at the Tailscale Serve address failed every film with "The stream stopped unexpectedly…".
- v0.28 fix for the likely cause (Safari's media player fetching without the sign-in cookie): players on Apple
  devices (`needsMediaLink()` in `public/js/caps.js`) send `mediaLink: true`; the playback and Live TV play routes
  answer with a private link in the address (`?cast=`, the cast-link machinery in `src/cast/tokens.js`, ended
  with the playback). Tests: `test/media-links.test.js`.
- The `[media]` console lines (`src/app.js`) now say `media link: yes/no`; the player shows "Details: …" under
  an error. Remove the diagnostics once a real iPhone plays.

## Preact screens
- Done: Live TV, libraries, search, genre/person (v0.26); Home and Lists (`views/home.js`, `views/lists.js`, v0.28); the title page
  (`views/item.js` + `item-show.js` + `item-music.js`, pieces in `ui/detail.js`, rules in `item-rules.js`; branch `title-page-preact`).
  Books, podcasts and audiobooks are still their older modules, handed the data by the title page's `load()`.
- Next: Guide/Recordings, music, books, Settings, the player.
- Title-page checks (dev server, `BASE=http://localhost:8797`): `item-fn.mjs` (behaviour, made-up titles from
  `item-fixtures.mjs`; run `item-users.mjs` once for guest and its Kids profile), `item-blocks.mjs` (pieces vs older helpers).
- Check a move with `devtools/compare.mjs` (markup and pixels, every theme, desktop and phone).

## Browser checks
The devtools checks need Playwright with Chromium, which is not a project dependency (no npm installs in the repo):
install it outside the repo if you want to run them on this PC. They expect a dev Atomix on http://localhost:8787 with
user `dallas` / `atomix-dev-1` (`devtools/make-dev.sh`; on Windows run its steps by hand or use WSL). Run one check at
a time: they change the same profile's prefs.
`devtools/` (v0.28): `make-dev.sh` makes a dev Atomix with test media; Playwright checks for Home, Lists, card motion,
scrolling, start times, and `compare.mjs` for before/after screen moves. See `devtools/README.md`. The older
suites and mock servers (mock IPTV, mock Chromecast) from earlier rounds were lost and aren't recreated yet.

## v0.28 batch 3 (delivered, uncommitted)
- Downloads auto-scan: `src/api/hooks.js` — Sonarr/Radarr/Lidarr webhook `POST /api/hooks/arr?key=` rescans the
  matching library; Settings → Server → Download apps; optional request address (Jellyseerr/Overseerr) on empty search.
- Skip recaps and credits: migration 30 (`markers.kind` 'recap', source 'community'); TheIntroDB v4 (`src/extras/community.js`,
  no key, tests point it at 127.0.0.1:9); credits found by end-of-episode audio; intro jobs carry `v` (`INTROS_VERSION`).
- Even volume: `src/library/loudness.js` (EBU R128, target -16 LUFS), "Volume check" job, Web Audio gain in `public/js/music.js`
  (not on iPhone/iPad). Gapless playback not done.
- Your own channels: `plugins/my-channels` (schedule rules -> 24/7 live channels, ffmpeg concat -> MPEG-TS, loopback-only route).
- Next: a Jellyfin-compatible API for Infuse, Streamyfin/Swiftfin and Finamp (needs real-device testing).

## Multi-DRM (v0.28, uncommitted)
- Spec/plan: `docs/superpowers/specs|plans/2026-11-11-atomix-multi-drm*`. A channel can offer several key systems; the
  device says what it has and the server picks one.
- Files: `plugins/iptv-simple/{drm,m3u,index}.js` (reads `#KODIPROP:inputstream.adaptive.drm={...}`, `atomix_url`,
  `atomix.app_url/app_name`), `src/live/drm.js` (`chooseSystem`, PlayReady unwrap, LA_URL rewrite), `src/live/stream.js`
  (`addressOf(..., { system })`), `src/cast/sessions.js`, `src/api/live.js`, migration 31 (`app_url`, `app_name`,
  `admin_app_url`, `admin_app_name`), `src/live/applinks.js`, `public/js/dash/{eme,support,playable}.js`, `public/js/ui/cant-play.js`.
- Rules that matter: `live_channels.drm` is a comma list, the API gives an array (old string still read). `keySystems`
  absent = first system; `[]` = 409 "This browser can't play any of this channel's protections." Single-system channels
  act as v0.27. Providers' licence addresses never reach a browser or TV: `mspr:pro` LA_URL is Atomix's for both. Channels
  a device can't play are hidden (switch per device; plain-http pages hide nothing except on iPhone/iPad); provider links
  are https only, admin > playlist > built-in TVNZ+, never for Kids.
- Not yet checked on real devices: PlayReady on Edge, Xbox and Chromecast (the real `PlayReadyKeyMessage` size/format);
  FairPlay + Widevine channel on an iPhone. Cloud checks: `devtools/iphone-channels.mjs` (iPhone view, hiding, card),
  `devtools/fixed-compare.mjs` (older themes unchanged).

## Visual refresh A (v0.29 work, uncommitted)
Files: `public/css/tokens.css` (loaded first), `app.css`, `orbit.css`, each `themes/<name>/theme.css`, `src/themes/apca.js`
and `src/themes/tokens.js` (APCA contrast and a small token reader for tests), `public/js/tint.js` (accent clamp),
`public/js/app.js` `applyAccent()`, `views/settings.js` (accent picker), `devtools/ramp.mjs` (prints a theme's ramps).
- Token layers: (1) per-theme ramps `--n-1..12` and `--a-1..12`; (2) the old names (`--bg`, `--text`, `--accent` ...) come
  from the ramps, with the old Midnight colours as defaults; (3) semantic names (`--app-bg`, `--surface-1/2/3`, `--text-high`,
  `--accent-solid`, `--on-accent` ...) come from the ramps and fall back to the old names. Old names never refer to semantic
  names, so there are no var() cycles. A theme with only old names (a user theme) still works and keeps its accent focus ring.
- oklch: the ramps are hex in `:root` and the same colours as `oklch()` inside `@supports (color: oklch(0% 0 0))`.
  Custom properties never fall back by themselves, so no oklch next to the hex.
- Scrim: `--scrim-stops` (the eased curve, written once), `--scrim-left/-bottom/-edge`, `--scrim-max`, `--scrim-colour`
  (black; Daylight's is its canvas). A `.scrim` layer sits above the backdrop; card scrims are black.
- Focus: `--focus-ring` (n-12; dark themes pin #fff), `--focus-halo`, `--focus-width` (3 px, 4 px on TV), `--focus-offset`,
  `--focus-halo-ring/-inset`. Neither the ring nor the halo transitions. Fixed gutter tokens `--focus-grow/-rise/-reach`.
- TV floor: `@media (min-width: 1600px) and (orientation: landscape)` in tokens.css sets `--fs-caption` 20, `--fs-meta`/`--fs-card`/
  `--fs-body` 24, `--fw-meta` 500. Nothing on a TV under 20 px. Orbit floors its own `--t-*` in the same block only.
- Accent clamp: a chosen colour is moved into the theme's band in OKLCH (dark L 70-80 %, Daylight 45-55 %, C 0.10-0.15, hue
  kept, a grey stays grey), its ramp is regenerated and the ink on it is black or white by APCA (Lc >= 60).
- Checks: `node --test test/theme-tokens.test.js test/apca.test.js test/accent-clamp.test.js`; devtools (dev server up):
  `type-floor`, `focus-check`, `scrim-check`, `accent-check`, `card-select`, `card-open`, `card-load`, `iphone-channels`.
  `iphone-channels` refuses a dev database that already holds IPTV Simple channels (run it on a copy of the data).
- Old TV browsers (no `color-mix()`/`oklch()`): a colour using them goes in `@supports`, after a ramp-step value
  (`test/old-browsers.test.js`, baseline of older uses in `test/fixtures/old-browser-colours.json`).

## Visual refresh B (v0.29 work, uncommitted)
Plan `docs/superpowers/plans/2026-11-12-atomix-visual-refresh-b.md`.
- `public/js/appearance-rules.js` (Node-tested): `glassMode`, `effectsReduced`, `contrastMode`, `textScale`,
  `orderLibraries`, `movePinned`. `app.js applyAppearance()` sets `html[data-glass|data-oled|data-contrast]` and
  `--text-scale`, and re-applies when the TV size, reduced transparency or prefers-contrast change.
- Profile prefs (`src/api/account.js cleanPrefs`, exported): `glass` (clear|tinted|solid), `oled`, `contrast`
  (more|normal; unset = the system), `textScale` (1|1.15|1.3), `pinnedLibraries` (unique positive ids, max 50).
  `reduceEffects: true` still reads as Solid.
- `html.reduce-effects` means the profile's own choice (card motion reads it); a default Solid (TV, no blur) keeps the
  sheen and clips. Blur-off CSS keys on `html[data-glass="solid"]`.
- Pinned libraries: Orbit's rail and phone dock (`shell.js`), the top/side menus (`app.js renderNav`) show pinned
  libraries in order and the rest under "More libraries"; a library entry's context menu (right click, long press, menu
  key) offers Pin/Unpin/Move; Settings → Menu. Empty or all-gone pins show every library.
- Shared pieces: `mediaChips` (4K, Dolby Vision/HDR10/HLG, Atmos, 5.1/7.1, Subtitles; server `mediaSummary` gives
  `hdrFormat` and `atmos`), the title page's `.logo-box` (no layout shift), badges top-left / watched disc top-right,
  a flush 3 px (4 px TV) progress track (Orbit keeps its floating one), `skeleton(kind)` after 1 s instead of the page
  spinner.
- Checks: `node --test test/appearance-rules.test.js test/appearance-prefs.test.js test/serialize-media.test.js
  test/theme-tokens.test.js`; devtools `glass-check`, `modes-check`, `pinned-check`, `polish-check` (run devtools checks
  one at a time: they share the dev profile's prefs).

## Visual refresh C (v0.29 work, merged into main)
Plan `docs/superpowers/plans/2026-11-17-atomix-visual-refresh-c.md`; each theme made itself (see `docs/THEMES.md`, "What each built-in theme is after Plan C").
- Files: `themes/*/theme.css` + `theme.json`, `public/css/tokens.css` (`--surface-edge`, `--button-radius`), `app.css`, `orbit.css`
  (`--poster-w` 256, `--grid-poster-w` 196), `public/js/tint.js` (`envTint`), `backdrop.js` (`--env-tint`, `focusSetsBackdrop`),
  `focus-backdrop.js` + `focus-backdrop-rules.js`, `devtools/theme-check.mjs`, `devtools/gallery.mjs` + `gallery-rules.mjs`.
- Rules that matter:
  - Midnight is the no-blur low-power reference. Obsidian: ring = accent, no halo, 1 px edges, `data-oled` default on. Daylight: TV canvas dimmed, wider halo.
  - Arctic and Arctic Side use no Arctic Horizon assets (CC BY-NC-SA); only OFL fonts in `public/fonts/`.
  - `--button-radius` reaches `.btn` in shared CSS (kind pills keep `--pill`; Arctic's own theme.css also uses it for `.season-tab`).
  - R8: with `html[data-follow-focus]` (theme.json `backdropFollowsFocus`) only `focus-backdrop.js` sets the backdrop on focus (gated: not
    `nav-held`, not motion none, no poster fallback); other themes keep the old spotlight/library/search paths.
  - Orbit rows 256 px (6.2 posters at 1080p), grids keep 196. Harbour hover uses `--focus-grow`.
  - theme.json is read when the server starts: restart the dev server after changing one.
- Checks: `node --test test/theme-rules.test.js test/theme-tokens.test.js test/gallery.test.js`. Browser (dev server, PowerShell on Windows):
  `BASE=http://localhost:8797 node devtools/theme-check.mjs [follow-focus|rows|player-chrome|no-blur|grown]`, `THEMES=arctic,midnight` narrows,
  `SHOTS=<dir>` keeps pictures. It refuses to run without BASE or against :8787 (the live server). Needs Playwright outside the repo.
  Gallery: `ART=1 SIZES=desk,tv,phone PAGES='#/,#/library/1,#/item/1,#/live,#/settings' node devtools/fixed-compare.mjs record <dir>`, then
  `node devtools/gallery.mjs <before> <after> <out>` (Pillow; `PYTHON` overrides `python`) writes `index.html` sliders and `visual-evidence.json`.
- Still needs real devices: TV timings and the focus ring on a TV, Safari/iPhone, old TV browsers (no `oklch`/`color-mix`), Daylight dimming on a real TV.
- glass/modes/pinned/polish-check used to PATCH prefs to a fixed :8787 while the page ran on BASE (fixed 97fce13); modes-check is ALL PASS now.
- Parked minors: `card-select` ignores
  `THEMES`; `sized.js` guesses 196 px for row posters; laptop widths 1000-1366 show about 5.8 Orbit posters, unchecked.
