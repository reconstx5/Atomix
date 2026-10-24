# Atomix Round 27 — v0.25.0: Orbit's Live TV and library screens

Approved in conversation with Dallas on 21 Oct 2026. He picked direction **A** for both screens from the mockups page ("Orbit Live TV and Library"), then said "looks good" to each of the three sections.

## Intent

Dallas asked: "Update the ui look of the tv tab screen and the screen of the library screen. Do some research of different looks and things you can update to make the look of it feel modern, responsive but having it still retain the feel of orbit."

He confirmed the scope:
- the **tv tab** is **Live TV**, the channel list at `#/live`;
- the **library screens** are **Movies and TV Shows**;
- Music, Podcasts, Audiobooks, Books and Comics keep their pages.

Research, sent with sources:
- YouTube TV's 2026 Live guide: logo bubbles, a now bar that fills, and a preview card (reviewers missed the auto-preview);
- Pluto TV opening on rows;
- tvOS 26 returning to tall glassy poster tiles;
- Infuse's A–Z jump bar and filter panel;
- the Plex backlash over grid-only libraries.

The audit of today's screens found:
- **Live TV:** full-width rows show 8 channels per screen at 1080p, with flat colour blocks, "Next" far right, a "…" outside each row, and nothing visual about what's on.
- **Library:** the title competes with five same-sized controls; small libraries leave the screen empty; phones spend a third of the screen on controls before the first poster; there is no A–Z jump.

Success:
- Both screens look and move like Orbit's Home: a spotlight following the remote, artwork behind, glass and the white focus pill.
- Everything works with a remote, mouse, touch and screen reader at TV, laptop, tablet and phone sizes.
- Older themes stay pixel-identical.

## Global constraints

- Node ≥ 22.13; plain ES-module browser JS with no build step; **no dependencies**; no copied icons or skins.
- Older themes stay pixel-identical: `node /home/claude/devtools/oldthemes-compare.mjs compare` → "all pages match". Every change is Orbit-only (`isOrbit()` in the views, `body[data-layout="orbit"]` or `themes/orbit/theme.css` in CSS).
- No server changes are planned: `/api/live/channels` already sends each programme's `image`, `description`, times and recording marks, and the library routes already send what the cards need.
- Kids profiles keep their rules: no Record, their channel groups only, their titles only.
- Every control works with a remote (D-pad, Select, Back), a mouse, touch and a screen reader; text and focus keep the contrast Orbit's checks already measure.

## 1. Live TV (Orbit)

- **Spotlight**, at the top of the page like Home's. It shows the channel the remote is on and follows focus (and mouse hover) across the cards. It starts on the first favourite, or else the first channel in the shown group.
  - **Background:** the current programme's picture fills the page background (the backdrop layer). When there is none, the channel logo sits large on a tint drawn from the logo, or from a hue picked from the channel's name.
  - **Top line:** the logo, a red **LIVE** tag, and "Channel N · Group".
  - **Programme:** the title (with the subtitle or episode when known); a line with the start time, a progress bar and "N min left"; and up to two lines of description.
  - **Buttons:**
    - **Watch live**;
    - **Record** / **Recording** / **Cancel recording**, using today's recording actions, and not shown for Kids profiles;
    - **Favourite** (★, pressed when on);
    - **Guide** (that channel's guide);
    - **Cast to…** (when casting is on, and not for radio or encrypted channels).
  - These replace each row's "…".
  - **No guide:** "No guide information", with Watch live and Favourite.
- **Group chips**, between the spotlight and the cards: Favourites (when there are any), All, then the groups. Their behaviour is unchanged, including the arrow keys moving within the chips.
- **Channel cards** are glass 16:9 cards: four across at TV widths, three on laptops, two on phones and upright tablets.
  - **Picture:** the programme picture, or the logo on its tint.
  - **Badges:** the logo in a small glass bubble top-left, the channel number top-right, and the red recording dot and encrypted lock as today.
  - **Text:** the programme title, a thin progress line, and "Next 2:00 PM · Coast".
  - **Radio stations:** the logo large on its tint, with a small Radio tag.
  - **No guide:** a channel without guide data says "No guide information".
  - **Accessible name:** each card keeps today's row name, e.g. "7, TVNZ 1, now 1 News until 7:30 PM".
- **Remote:**
  - Select on a card plays it (the player, or the music player for radio, as today).
  - Up from the first row of cards goes to the chips, and Up again to the spotlight's buttons; Down goes back.
  - Typing a channel number still jumps and plays.
  - Back works as it does today.
- **Scrolling:** on TV and laptop widths the cards scroll under the fixed spotlight, which shrinks to a compact form once the remote leaves the first row (Home's pattern).
- **Phone:** the spotlight is a short banner (logo, title, progress, Watch live) above one swipeable chip row and two cards across.
- **Big lists** (Dallas's playlist has about 450 channels, mostly radio):
  - card pictures load lazily at their shown size;
  - off-screen cards skip rendering work (`content-visibility`);
  - the page never scrolls sideways.
- **Unchanged:**
  - the Guide and Recordings pages and the player;
  - now/next moving on at the earliest programme end (and each minute for the bars);
  - favourites, Kids groups, zap order and the empty state when Live TV isn't set up.

## 2. Movies and TV Shows (Orbit)

- **Spotlight**, at the top, using the same `spotlight()` component as Home. It follows the poster the remote is on.
  - **Background:** the title's backdrop fills the background.
  - **Title:** the logo, or the title.
  - **Meta line:** year · seasons (shows) or runtime (films) · genres.
  - **Overview:** one line of it.
  - **Buttons:** **Play** or **Resume S1 · E3** (with the resume bar), **More info**, and Trailer when there is one.
  - **First title:** the library title most recently watched and not finished, else the first poster.
  - **Scrolling:** it shrinks to the compact form once the remote leaves the first row.
- **Header:**
  - **Text:** the library name, and "42 shows · 3 in progress" (the in-progress part only when there are any).
  - **One glass control bar** in place of today's five controls:
    - **Sort** pill, "A–Z ▾": a sheet with A–Z, Recently added, Release year, Rating, Shuffle;
    - **Genre** pill, "All genres ▾": a sheet of the library's genres, shown when there are genres;
    - **Unwatched**, a toggle pill with `aria-pressed`;
    - **Search** pill: opens the filter box in place, focused; Escape or an empty box closes it;
    - **"…"**: **Collections** (Movies) and **Scan** (admins).
  - The sheets are Orbit's existing menu sheets (Up/Down/Select, Back closes).
- **Posters:**
  - a subtle glass edge highlight;
  - today's watched tick and unwatched-episode count;
  - a progress line along the bottom for a film or show in progress.
- **A–Z rail**, on the right.
  - **When:** shown when sorted A–Z with 20 or more titles and no search typed.
  - **Letters:** only letters with titles, plus # for titles starting with a digit or a symbol. Leading "The"/"A"/"An" are ignored, as the sort already does via `sort_title`.
  - **Picking a letter** scrolls to that letter's first title and selects it.
  - **While scrolling,** the rail marks the current letter.
  - **Remote:** the rail is reached with Right from the last poster in a row; Up/Down move between letters; Select jumps; Left returns to the grid.
  - **Screen readers:** the rail is a labelled list of "Jump to D" buttons.
- **Empty states:** "Nothing matches" (now with a Clear filters button) and the empty-library message keep their wording.
- **Phone:**
  - the spotlight is a short banner (title, meta, Play);
  - the control bar is one swipeable chip row, and search opens a full-width box;
  - three posters across;
  - the A–Z rail is a thin strip at the right edge.
- **Unchanged:**
  - the URL keeps sort, genre, unwatched and search (Back returns to the same view);
  - the Collections view;
  - the backdrop following focus;
  - Kids rules;
  - the other library types.

## Verification

- Unit suite in groups, including on the PC.
- New Node tests for the pure rules:
  - the rail's letters and the "#" group;
  - where a letter jumps;
  - the card's "Next" line and "N min left";
  - the spotlight's first title;
  - the channel tint from a name.
- New `devtools/v025-ui.mjs` sections, `live` and `library`, at 1920×1080, 1280×720, 1024×768, 820×1180 and 400×860:
  - the spotlight follows the remote;
  - Up/Down between cards, chips and spotlight;
  - typed channel numbers;
  - the menus with a remote;
  - the rail jumps;
  - no sideways scroll;
  - contrast on glass and cards;
  - Kids sees no Record;
  - radio and no-guide channels;
  - no console errors.
- `live-ui`, `lists-ui`, `a11y-ui`, `v022-ui`, `v023-ui`, `v024-ui` and `settings-check` stay green. A check written for the old layout is updated, with a ledgered ruling.
- `oldthemes-compare`: "all pages match".
- A fresh review and one fix pass per plan.
- Pictures (`devtools/v025-shots.mjs`): both screens at 1080p and on a phone, before and after, to `D:\Nodeflix\Claude outputs\v0.25.0\`.

**Not yet verified (listed in build status):**
- real TV browsers with the A–Z rail and a long channel wall;
- Dallas's real ~450-channel playlist;
- whether his real guide (i.mjh.nz) carries programme pictures; without them every card shows the logo on its tint.

## Plans

- **A:** Live TV.
- **B:** Movies and TV Shows, and v0.25.0.

Native (inline) execution, as before.
