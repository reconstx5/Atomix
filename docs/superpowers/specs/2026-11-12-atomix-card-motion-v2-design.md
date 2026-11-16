# Card motion v2 — design (v0.28)

Dallas, 12 Nov 2026: "I want to improve the movie/TV show card animations." Picked all four areas — selecting,
live preview on rest, opening a title, rows and loading — because the cards "feel plain or cheap". Approved the
design in chat ("looks good"), with Atomix-made preview clips.

Builds on "Capture" (v0.28, `CLAUDE.md` → Motion): `html[data-motion]` full | reduce | none, the settle spring
(`--ease-settle`), the focus orbit + press ring, depth-aware screen changes with a poster morph
(`public/js/transitions.js`), and card motion (`public/js/card-motion.js`). Follow the `web-animation` skill.

## Goals

1. A selected film/episode/show card feels alive and premium, and moving fast with the remote stays instant.
2. A card that is rested on plays a short silent clip of the title once, then returns to its poster.
3. Opening a title feels like the card becoming the page; Back returns into the same card.
4. Rows never flash grey or jump while loading; the first screen arrives with a quick ripple.

## Not in scope

- Music, book, Live TV channel and person cards (unchanged).
- YouTube trailers in cards (an iframe per card is too heavy); local trailer files are used.
- Sound in card previews.
- Older themes' resting look (pixel-identical at rest); their motion may improve only where it shares the same CSS.

## 1. Selecting a card

Applies to `.card` film/episode/show cards (poster and landscape) in every layout; Orbit is the reference.

- **Lift:** focus/hover scales the card's inner art (never the layout box): posters `--focus-scale-poster: 1.06`,
  wide cards `--focus-scale-wide: 1.03`, with `translateY(-4px)`; hover (fine pointers only) is subtler: 1.04 / 1.02.
  `--ease-settle` over `--dur-focus` (≤ 220 ms). First/last card in a row scale from the inner edge
  (`transform-origin`).
- **Glow:** a pseudo-element under the art carries a blurred shadow tinted with the poster's colour (`--tint`, the
  dominant colour from section 4) painted once; only its `opacity` animates (0 → 1). No `box-shadow` animation.
- **Neighbours dim:** in a row that has a selected card, the other cards go to `opacity: 0.78` over `--dur-fast`
  (full motion only; reduce/none: no dimming). Never dims the card under the pointer.
- **Info rises in:** under the selected card (poster rows), a one-line meta strip — year · rating · runtime or
  "S2 · E4" — fades and rises 6 px in, 160 ms ease-out, 80 ms after the lift starts. Text exists in the DOM at rest
  (visually hidden until selected) so screen readers and the no-motion tier read the same thing; reduce: fade only;
  none: shown instantly.
- **Sheen:** the first time a given card is selected in a page visit, a soft diagonal highlight crosses the art once
  (a gradient pseudo-element, `translateX`, 450 ms, ease-out, opacity ≤ 0.18). Full motion only; never on a held key.
- **Held arrow (`html.nav-held`)** and `data-motion="none"`: the ring/outline appears instantly; no lift, glow, dim,
  sheen or info tween (info strip shown instantly).
- The focus ring/outline appears on the same frame as the key press (unchanged rule).

## 2. Live preview on rest

### Clips (server)

- A new background job `clip` (beside `previews`, `thumb`, `intros` in `src/tasks.js`) makes one preview clip per
  film/episode: **5 s, 640 px wide (360p-ish), H.264 Main, yuv420p, no audio, `+faststart` MP4, ~300–600 KB**, in
  `data/previews/<item>/clip.mp4`. Start point: 35 % into the title (skipping intros/credits: the intro/recap
  markers if known), at a keyframe-friendly `-ss` before `-i`. HDR → tone-mapped with the existing HDR filter or
  skipped when this ffmpeg can't. Local trailer files (`extra_kind = 'trailer'`) are used instead of the film when
  present: 5 s from 15 % in.
- Runs at low priority like previews, after previews and intros for the same title; respects the existing
  `previewsEnabled` switch and library opt-outs, and a new admin setting **"Make preview clips for cards"**
  (Settings → Server, on). Remote (connected-server) titles: no clip. Removed/changed files: the clip is redone
  (size/mtime like previews).
- `GET /api/items/:id/clip` → the MP4 (Range, cached a day, `Content-Type: video/mp4`), 404 when none; access
  follows the item's visibility (Kids rules). The previews manifest (`/api/items/:id/previews`) gains
  `clip: true|false` so the card knows without a 404.

### Playing (browser, `public/js/card-motion.js`)

- Rest time before playing: **1200 ms** (card stays focused/hovered, no held key). When `clip` is true: create one
  muted `<video playsinline muted preload="auto" disablepictureinpicture>` inside the art, `object-fit: cover`;
  fade it in (200 ms) on its first `playing` event only (never a black frame); play once (no loop); at the end or
  after 5 s, fade back to the poster (250 ms) and remove the element. Only one card plays at a time.
- When `clip` is false: today's still-frame flip.
- Stops at once on: focus/pointer leaving, any key press, scroll, route change, page hidden.
- **Off when:** motion is not `full`; `navigator.connection?.saveData` is true or effectiveType is '2g'/'slow-2g';
  Kids profiles; the new profile pref **"Play previews on cards"** (Settings → Profile, on by default, `cardPreviews`
  boolean) is off; the page is hidden.
- WCAG 2.2.2: a clip plays once and is ≤ 5 s, so no pause control is needed.

## 3. Opening a title

- Where view transitions exist (`document.startViewTransition`): the clicked card's art and the title page's
  backdrop/poster share a `view-transition-name` set just before the transition and cleared after
  `transition.finished`; the title text also morphs (card title ↔ page title) when both are present. The title
  page's data is fetched before the transition starts (the page is frozen during the update). `object-fit: cover`
  on the transition images.
- After the morph, the page's first-screen blocks (buttons, meta, plot, first row) appear in turn: fade + 8 px
  rise, 20 ms apart, the whole sequence ≤ 200 ms. Further content just appears.
- **Back** reverses: the page backdrop shrinks into the same card, and that card is focused (keyboard/remote) with
  its row scrolled as before (existing restore logic).
- Reduce: crossfade only (no morph, no rise). None / no view transitions: instant swap (existing fallback).
- Never from a held key; never while another transition runs (existing guard).

## 4. Rows and loading

- **Dominant colour:** each image route can return a small colour hint. The server computes a dominant colour per
  artwork (from the existing thumbnail copies, an 8×8 average with saturation boost) and stores it in
  `items.colors` JSON `{ poster, backdrop }` (migration 32), filled lazily by the thumbnail job and on first
  request; card data from list/home/search APIs carry `tint: '#rrggbb'` (poster or backdrop per card style).
- The art box always has its final size (no layout shift) and paints `--tint` (fallback: the theme's card colour)
  until the image has decoded; then the image fades in over 180 ms (`img.decode()` first). Cached images (complete at
  mount) show instantly with no fade.
- **First-screen ripple:** when a page with rows first mounts (not on Back, not on re-render), the cards visible in
  the first screenful fade + rise 8 px, 20 ms apart, total ≤ 300 ms. Cards off-screen appear without animation.
  Full motion only; reduce: fade only, no stagger; none: nothing.
- **Row scrolling:** a single arrow press scrolls the row smoothly (`scrollTo` with smooth behaviour, existing
  keep-left rule); a held key (`event.repeat` / `nav-held`) scrolls instantly. (Verify the current behaviour first;
  change only what differs.)

## Tokens (in `public/css/app.css` `:root`, retuned per `data-motion`)

`--focus-scale-poster`, `--focus-scale-wide`, `--hover-scale-poster`, `--hover-scale-wide`, `--lift`, `--dim-others`,
`--info-rise`, `--ripple-step` (20ms), `--ripple-rise` (8px), `--fade-in-art` (180ms). Reduce: scales 1, lift 0,
rise 0, dim 1, fades kept. None: all durations 0.

## Performance rules

Only `transform` and `opacity` animate. No `will-change` in static CSS (set during the lift only). One video element
at a time; its `src` is removed when it stops. No reads of layout inside key handlers per card. Held keys skip every
tween. TVs (old Chromium) get the no-animation path, which must look finished.

## Testing

- Node: the clip job (args: 5 s, 640 px, no audio, faststart, start point from markers, trailer preferred; skips
  remote titles; redone when the file changes; obeys the switches); `/api/items/:id/clip` (Range, 404, Kids); the
  previews manifest's `clip` flag; dominant colour (a solid red poster → `#ff0000`-ish; stored once; carried as
  `tint`); migration 32; the new pref and setting.
- Browser (Playwright, dev server, Orbit + one older theme, desktop and phone): selected card lifts/glows/dims
  neighbours and shows its info strip; held arrow → no tweens (computed transition time 0); the sheen runs once per
  card per page; a rested card plays its clip within ~1.5 s, never shows a black frame, stops on move, returns to the
  poster; no clip → still-frame flip; reduce/none tiers; data-saver off; Kids off; pref off; opening a title morphs
  and Back focuses the same card; tint placeholder before decode, no layout shift (CLS 0 on Home); first-screen
  ripple only on first mount.
- `devtools/fixed-compare.mjs`: older themes pixel-identical **at rest**.
- Performance: a Performance trace while arrowing along a row shows no layout/paint on the moving cards.

## Risks

- Clip generation adds background CPU/disk (≈ 0.5 MB per title); it runs at low priority and can be switched off.
- iOS Safari autoplay: muted `playsinline` video autoplays; on Low Power Mode it may not — then the still-frame flip
  is used (detected when `play()` rejects).
- Real TVs: the full tier may be too heavy; they usually run the reduce/none tiers via the existing motion detection.
