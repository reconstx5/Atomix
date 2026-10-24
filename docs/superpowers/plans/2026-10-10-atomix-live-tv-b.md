# Atomix Live TV — plan B (pages, player, radio, casting, search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything a person sees and touches in Live TV: the menu entry, the channel list, the guide, programme details, the player's live and catch-up modes, radio in the music player, casting a channel, the "On now" home row, search's "On TV", and the admin's refresh summary and Kids groups — then v0.16.0.

**Architecture:** Plain ES-module views on the routes plan A built (`/api/live/*`). A small client module `public/js/live.js` holds the shared pieces (fetching, channel order for zapping, programme captions). The player gains a third start-up branch beside items and add-on sources; the music player gains `playLive()`; the cast manager gains live/catch-up starts through `core.live.streams`. Browser checks live in `devtools/live-ui.mjs` against the mock provider (`mock-iptv.mjs`, :9919).

**Tech Stack:** Plain browser JS (no build), the existing components (`components.js`, `dom.js`, `nav.js` spatial navigation, `announce()`, `sliderText()`, `rowActions()`, `openSheet()`), Playwright in devtools.

**Spec:** `docs/superpowers/specs/2026-10-10-atomix-live-tv-design.md` (§3 radio/casting, §4 pages, §5 browser tests). Plan A: `docs/superpowers/plans/2026-10-10-atomix-live-tv-a.md` and its rulings (`scratchpad/note/v0160-progress-a.md`).

## Global Constraints

- No dependencies, no build step; Orbit and the classic themes both get every page; the older themes' existing pages stay pixel-identical (`oldthemes-compare.mjs compare` → "all pages match").
- Remote-first: every control reachable with arrows/Enter/Back; 24-px targets; `announce()` for changes a screen-reader user needs; nothing in the guide is a live region.
- Provider URLs never reach the browser (the client only uses `/api/live/*` and session URLs).
- Kids see Live TV only when groups are ticked; admin-only controls only for `canAdmin()`.
- Copy fixed by the spec: menu "Live TV"; empty "Live TV isn't set up yet" (admins: "Add a playlist in Settings → Plugins → IPTV Simple"); "No guide information"; buttons "Watch live", "Start over", "Play", "Close"; "Add to favourites" / "Remove from favourites"; "Guide for this channel"; "Cast to…"; "Lost the channel — trying again"; Household "Live TV groups"; home row "On now"; search section "On TV".
- From plan A's review (now requirements): the player always sends `replaces` when zapping and stops its stream on `pagehide` (already in place for items); a live MP4 stream that ends is re-requested by the player (the server allows 3 drops in 2 min); the ping reply's `notice` is shown and its `error` ends playback with that sentence; the cast route checks visibility with `core.live.routes.visibleChannel`.

## Review Focus

1. **Zapping fast with a remote** — PageDown pressed five times quickly must end on the fifth channel with one stream open (earlier starts cancelled or replaced, none left running; on a 1-stream provider no 409 from your own zaps). (Task 4 test.)
2. **A programme ending while you watch** — at the programme's end time the title, the bar and Info move to the next programme without a reload; a channel with no guide shows its name and "No guide information". (Task 4 test.)
3. **The guide on a TV remote** — Left/Right across a 2-hour programme moves one programme, Up/Down keeps the time column, Earlier from "now" keeps focus on a cell in the same channel; nothing focusable is off-screen without scrolling into view. (Task 3 test.)
4. **Kids profile** — the menu entry, home row, search section and guide are all absent with no ticked groups, and show only the ticked groups' channels when there are. (Tasks 1, 7 tests.)
5. **Phones** — the channel list, the guide's list mode and the live player fit 360 px with no sideways scroll; the Orbit dock still fits (Live TV sits with Add-ons beside the profile picture on phones). (Tasks 1–4 tests.)

---

### Task 1: Client module, routes and the menu entry

**Files:**
- Create: `public/js/live.js`
- Modify: `public/js/app.js` (routes, `state.live`, `liveAllowed()`, classic menu entry), `public/js/shell.js` (Orbit entry + phone tool icon), `public/js/dom.js` (icons `live`, `radio`, `guide`, `rewind-badge`)
- Create: `/home/claude/devtools/live-ui.mjs` (sections `menu`, later tasks add theirs)

**Interfaces:**
- Produces `public/js/live.js`:
  - `liveStatus({ fresh } = {}) → Promise<{ enabled, sources }>` (cached per page load; `fresh` re-reads).
  - `channels({ group, favourites } = {}) → Promise<Channel[]>`, `groups()`, `guide(from, to, channelIds)`, `programme(id)`, `setFavourite(id, on)`, `search(q)`.
  - `programmeTimes(p) → "7:00 – 7:30 PM"`, `programmeProgress(p, now) → 0..1`, `programmeState(p, now, channel) → 'now'|'aired'|'catchup'|'upcoming'`, `channelLabel(c) → "7 TVNZ 1"`.
  - `zapOrder() → number[]` (channel ids in the order last shown on the Channels page — the group filter in force — else all), `neighbour(id, dir) → id`.
  - `playChannel(channel)` → navigates to `#/live/play/<id>` (TV) or calls `music.playLive(channel)` (radio).
- Routes: `/live` (channels, nav `live`), `/live/guide`, `/live/play/(\d+)` (player, fullscreen, params `{ live }`), `/live/catchup/(\d+)` (player, fullscreen, params `{ catchup }`).
- `liveAllowed()` in app.js: `state.live?.enabled === true` (fetched with status at sign-in and profile switch).
- Menu: classic — after Lists, `navLink('live', '#/live', 'Live TV', 'live')`; Orbit — `entry('live', '#/live', 'Live TV', 'live', 'orbit-extra')` after Lists, and on phones an `orbit-tool` icon beside Add-ons.
- [ ] **Step 1: Write the failing checks** in `live-ui.mjs` section `menu` (signs in with `orbit-lib.signIn`; before the run, `PUT /api/admin/plugins/iptv-simple/config { playlist: 'http://127.0.0.1:9919/playlist.m3u' }` and a refresh): "Live TV is in the menu after Lists (Orbit and Midnight)"; "a Kids profile with no ticked groups has no Live TV entry"; "at 360 px the Orbit dock has no Live TV entry and the top bar has its icon; no sideways scroll". Node: `test/live-client.test.js` for `programmeTimes`, `programmeProgress`, `programmeState`, `neighbour` (wraps at both ends).
- [ ] **Step 2: Run** `node live-ui.mjs menu` and `node --test test/live-client.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** both — Expected: PASS; plus `node oldthemes-compare.mjs compare` → "all pages match" (the classic menu gains an entry only when Live TV is enabled; the comparison data dir has no live source).

### Task 2: The Channels page

**Files:**
- Create: `public/js/views/live.js`, CSS in `public/css/app.css` (`.live-*`) and `themes/orbit/theme.css`
- Modify: `devtools/live-ui.mjs` (section `channels`)

**Interfaces:**
- Consumes Task 1's module. Uses `rowActions(title, items)` for "…", `emptyState()`, `announce()`.
- Page: heading "Live TV", a "Guide" button (to `#/live/guide`), group chips (`role="radiogroup"` via `rovingRadios`): "Favourites" (only when any), "All", then groups. Rows are buttons named "7, TVNZ 1, now 1 News until 7:30 PM" (or "…, No guide information") with logo (or initials), number, name, now title + bar + "until 7:30 PM", "Next: 7:30 The Chase". Enter plays (`playChannel`). "…": Add to favourites / Remove from favourites, Guide for this channel (`#/live/guide?channel=<id>`), Cast to… (Task 6). Digits typed anywhere on the page collect for 1.5 s (or until Enter) and play that number; a small overlay shows the digits. Now/next refresh each minute and at the earliest programme end.
- Empty: no source → "Live TV isn't set up yet" (+ admins: "Add a playlist in Settings → Plugins → IPTV Simple" with a button to `#/settings/plugins`).
- [ ] **Step 1: Write the failing checks** (`channels`): rows show number/name/now/next and the accessible name; chips filter (Movies → only its channels); Favourites chip appears after "Add to favourites" and lists that channel; typing "8" plays channel 8 (URL `#/live/play/<id>`); a channel without guide says "No guide information"; at 360 px no sideways scroll; no console errors.
- [ ] **Step 2: Run** `node live-ui.mjs channels` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `node orbit-sizes.mjs`, `node a11y-ui.mjs names` still pass.

### Task 3: The guide and the programme sheet

**Files:**
- Create: `public/js/views/guide.js`, CSS (`.guide-*`)
- Modify: `devtools/live-ui.mjs` (section `guide`)

**Interfaces:**
- Consumes `guide(from, to, ids)` (6-h windows; the view loads ±3 h around what it shows), `programme(id)`.
- Layout: a sticky channel column and a time ruler (30-min marks), 2½ h visible at 1920 px (`--guide-hour` width), a "Now" line, Earlier/Later (±2 h), a day select (catch-up start … +7 days), the group chips. Grid `role="grid"`, rows `role="row"`, cells `role="gridcell"` containing one button per programme; programme buttons named "TVNZ 1, 7:00 to 7:30 PM, 1 News, on now|aired|upcoming|catch-up available". Arrow keys handled by the view (not the spatial nav): Left/Right = previous/next programme in the row (scrolling the window when needed), Up/Down = the programme covering the same time in the row above/below. Rows render 50 at a time as the page scrolls. Aired programmes on catch-up channels show the rewind badge; other aired ones dim. `?channel=<id>` scrolls to and focuses that channel.
- Programme sheet (`openSheet`/dialog): title, episode, channel, day + times, categories, description, image; buttons from the route's `canWatchLive` / `canStartOver` / `canCatchup`: Watch live → `#/live/play/<channel>`, Start over / Play → `#/live/catchup/<programme>`, upcoming → Close.
- Phones (≤ 720 px): a channel select and a day select over a list of that channel's programmes; same sheet.
- [ ] **Step 1: Write the failing checks** (`guide`): grid and cell names; Right then Left returns to the same cell; Down keeps the time column (Review Focus 3); Earlier keeps focus in the same channel; catch-up badge on aired programmes of catch-up channels only; Enter on an aired catch-up programme opens the sheet with "Play", on now with "Watch live" + "Start over", upcoming with only "Close"; `?channel=` focuses that row; phone list at 360 px with no sideways scroll; no live regions inside the grid.
- [ ] **Step 2: Run** `node live-ui.mjs guide` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.

### Task 4: The player's live and catch-up modes

**Files:**
- Modify: `public/js/views/player.js`, CSS (`.live-badge`, `.player-channels`), `devtools/live-ui.mjs` (section `player`)
- Test: `test/live-client.test.js` (`zapQueue` logic)

**Interfaces:**
- Consumes `POST /api/live/channels/:id/play` and `/api/live/programmes/:id/play` (reply: `sessionId, mode, delivery, url, live, duration, start, channel, programme, next`), ping replies `{ ok, notice?, error? }`.
- Live mode (`params.live`): title = channel name + programme title; a LIVE badge in place of the clock times; the seek bar is a read-only progress through the programme (`aria-readonly`, `aria-valuetext` "18 minutes into 1 News, 12 minutes left"); back/forward/next/up-next/intro/subtitle-download hidden; channel up/down buttons ("Previous channel", "Next channel") and keys PageUp/PageDown, `ChannelUp`/`ChannelDown`; Info (I) shows now/next; a "Channels" button opens the channel list over the video (Enter zaps, Back closes); programme title/bar refresh at the programme's end (timer) and every minute; `announce('TVNZ 2, The Chase')` on a zap. No progress posts.
- Zapping: `zap(id)` sends `replaces: session.sessionId`; rapid presses are coalesced — only the last requested channel starts once 400 ms pass without another press; a start that comes back after a newer one was requested is stopped at once (`zapQueue` helper: `request(id) → Promise<id|null>`).
- Drops: when the `<video>` ends or errors on a live session, re-request the same `url` (a new GET) up to 3 times; ping `notice` → `setNotice(notice)`; ping `error` → `showError(error)` with Back.
- Catch-up mode (`params.catchup`): a normal seek bar over the programme (`duration`, offset `start`); seeking calls the programme play route with `from` = the seek point and `replaces`; title = programme title + channel name; "Watch live" button in the top bar when the programme is still on.
- [ ] **Step 1: Write the failing checks** (`player`): LIVE badge, bar valuetext, PageDown zaps to the next channel in order and the stream URL changes, five fast PageDowns end on the fifth channel with exactly one session open (the admin dashboard's `sessions` list) (Review Focus 1); Channels overlay zaps; Info shows now/next; a programme change moves the title without a reload (Playwright's `page.clock` moved past the current programme's end) (Review Focus 2); `__mode?m=drop` shows "Lost the channel — trying again" and playback resumes; catch-up seek moves the picture and the time; no console errors; phone 360 px fits. Node: `zapQueue` coalesces and drops stale results.
- [ ] **Step 2: Run** `node live-ui.mjs player`, `node --test test/live-client.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `node a11y-ui.mjs seek`, `node qol-ui.mjs`, `node orbit-ui.mjs` still pass.

### Task 5: Radio in the music player

**Files:**
- Modify: `public/js/music.js` (`playLive`), `public/js/views/nowplaying.js`, `devtools/live-ui.mjs` (section `radio`)

**Interfaces:**
- `music.playLive(channel)` → `POST /api/live/channels/:id/play { audioOnly: true, replaces }`; the queue holds radio channels (current one and the others in `zapOrder()` among radio channels) as entries `{ live: true, channelId, title: programme title || channel name, artist: channel name, poster: channel logo }`; `next()`/`previous()` move between them; seeking, shuffle, repeat and lyrics are off; the mini-player and Now Playing show "Live" instead of times; the title follows the guide (refreshed at the programme's end and each minute); a dropped stream is re-requested (as Task 4); the music player's existing `pagehide` stop covers the session.
- [ ] **Step 1: Write the failing checks** (`radio`): pressing a radio row starts the mini-player with the station's logo and "Live"; Next moves to the other station; Now Playing has no seek bar and no lyrics; the video player is not opened.
- [ ] **Step 2: Run** `node live-ui.mjs radio` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `node music-kbd.mjs`, `node extras-lyrics-ui.mjs` still pass.

### Task 6: Casting live and catch-up

**Files:**
- Modify: `src/live/stream.js` (pass-through of `caps`, `castDevice`, `extraHeaders`, `keepUntilLoaded`, `clientIp: 'cast'`), `src/cast/sessions.js`, `src/api/cast.js`, `public/js/cast.js`, `public/js/views/remote.js`, `public/js/views/live.js` + `player.js` ("Cast to…")
- Test: `test/cast-live.test.js` (with `helpers-cast.js` mocks), `devtools/live-ui.mjs` (section `cast`)

**Interfaces:**
- `POST /api/cast/sessions { deviceId, liveChannelId }` or `{ deviceId, catchupProgrammeId, position }` — visibility through `core.live.routes.visibleChannel` (needs `ctx`; the route resolves the channel/programme and passes rows to the manager).
- Cast session for live: `s.live = { kind, channelId, programmeId?, sourceKey }`; `playStream` calls `core.live.streams.startLive/startCatchup` with the cast pass-throughs instead of `playback.create`; DLNA gets no duration for live; `recordProgress` is skipped for live/catch-up; commands `channelUp`/`channelDown` (live) zap with `keepUntilLoaded`; `seek` is refused for live (400 "You can't seek a live channel") and for catch-up restarts from the new point.
- Remote poll gains `live: { channel: { id, name, number, logo }, programme, next }` and the Remote shows LIVE, the programme, and Previous/Next channel buttons instead of the seek bar for live.
- [ ] **Step 1: Write the failing tests**: node `cast-live.test.js` — start live on the mock Chromecast (URL has `?cast=`, no provider URL in the load message), `channelDown` loads the next channel's stream and stops the old one, `seek` on live is 400, a Kids profile without groups gets 404, nothing is written to progress on stop; browser `cast`: "Cast to…" from a channel row → Remote shows LIVE and the programme; Next channel changes the TV's stream (mock control `/__state`).
- [ ] **Step 2: Run** `node --test test/cast-live.test.js`, `node live-ui.mjs cast` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `node --test test/cast-sessions.test.js test/cast-dlna.test.js`, `node cast-ui.mjs` still pass.

### Task 7: "On now" home row and search "On TV"

**Files:**
- Modify: `src/api/library.js` (`/api/home` adds the row), `public/js/views/home.js` / card rendering for `kind: 'live'` cards, `public/js/views/search.js`, `public/js/components.js` (`liveCard(channel)`), `devtools/live-ui.mjs` (section `home`)
- Test: `test/live-home.test.js`

**Interfaces:**
- `/api/home` row `{ id: 'live-now', title: 'On now', style: 'landscape', items: liveCards }` placed after Continue watching, only when the viewer sees channels: favourites in order, else the first 12 channels; card shape `{ kind: 'live', id: 'live:<channelId>', channelId, title: programme title || channel name, subtitle: channel name, image: programme image or channel logo URL, progress: 0..1, radio }`.
- `liveCard(card)` (landscape): image, title, channel, progress bar; Enter → `playChannel`.
- Search: after the library results, "On TV": channel buttons and programme buttons ("7:30 PM · TVNZ 1 · The Chase") opening the programme sheet (Task 3's `openProgramme(id)` exported from `guide.js`).
- [ ] **Step 1: Write the failing tests**: node `live-home.test.js` — row present for an adult with channels, favourites first, absent for Kids without groups, no provider URL in it; browser `home`: the row shows and Enter plays; search "chase" shows an "On TV" section whose programme opens the sheet; Kids profile search has no "On TV".
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `node orbit-ui.mjs home`, `node qol-ui.mjs copy` still pass.

### Task 8: Admin: refresh summary, Kids groups, dashboard

**Files:**
- Modify: `public/js/views/settings.js` (plugin card for a plugin with a live source; Household profile dialog; dashboard), `devtools/live-ui.mjs` (section `admin`)

**Interfaces:**
- Plugin card (Settings → Plugins) for a plugin owning a live source: under its settings, "Last refresh: <relative time> · <summary>" or the error sentence (danger), a warning line if any, "Channels without guide: <first 20 names>" (details/summary), and a "Refresh now" button → `POST /api/live/sources/:id/refresh` → toast "Refreshed — 12 channels" / the error.
- Household → editing a Kids profile: a "Live TV groups" fieldset with a checkbox per group per source (from `/api/live/groups` as admin) and the ticked ones from `GET /api/profiles/:id/live-groups`; saved with `PUT` when the dialog saves. Hidden when no live source has channels.
- Dashboard: a live source's error shows like the scan warning ("Live TV: <sentence>").
- [ ] **Step 1: Write the failing checks** (`admin`): the IPTV Simple card shows "12 channels in 5 groups" and Refresh now toasts; with `__mode?m=403` Refresh now shows the 403 sentence and the dashboard line; ticking "Kids" for Mia makes Kidz Zone and Cartoon Club (only) appear for Mia; the fieldset is absent for a grown-up profile.
- [ ] **Step 2: Run** `node live-ui.mjs admin` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `node profiles-ui.mjs`, `node extras-ui.mjs` still pass.

### Task 9: Docs, version and the whole check

**Files:**
- Modify: `package.json` (0.16.0), `README.md` ("Live TV": what it does, setting up IPTV Simple with a provider / free list / HDHomeRun / Tvheadend / a file, catch-up, Kids groups), `docs/ARCHITECTURE.md` (`src/live/*`, migration 15, the stream limit, `session.live`), `docs/PLUGINS.md` (`registerLiveSource` with `refresh/stream/catchup/settingsSummary/maxStreams/refreshHours/imageRoots`, `programmes: null` meaning "guide not read"), `src/plugins.js` comment for `imageRoots`
- Create: `/home/claude/devtools/v016-shots.mjs`
- [ ] **Step 1:** Write the docs and bump the version.
- [ ] **Step 2: Run everything:** `npm test`; every browser suite (a11y-ui, qol-ui, orbit-ui, orbit-a11y, cast-ui, orbit-sizes, extras-ui, gate-ui, lists-ui, extras-lyrics-ui, rebrand-ui, servers-ui, profiles-ui, dialogs, music-kbd, live-ui), each graded for `TimeoutError|Error:` as well as FAIL; `oldthemes-compare.mjs compare`. Expected: all green, "all pages match".
