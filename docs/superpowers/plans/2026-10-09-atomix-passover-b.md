# Atomix v0.15.0 passover — Plan B (accessibility, layout, CSS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the UI findings of the passover audit: screen readers that hear the right thing once, contrast and sizes that meet AA, phone and TV layouts that don't clip, copy that uses one word per thing, and a stylesheet built from tokens and a handful of shared components instead of 200 literals.

**Architecture:** Browser-only changes in `public/js` and the stylesheets (`public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css`, `themes/*/theme.css`). One new shared helper (`announce()` in components.js), one new helper module (`public/js/motion.js` for `reduceMotion()`), no server changes except copy returned by the API where the UI reads it. Verification is Playwright (`devtools/*.mjs`), the a11y-enforcer scripts on the changed tokens, and node tests for pure helpers.

**Tech Stack:** Plain ES-module browser JS, CSS custom properties, Playwright in `/home/claude/devtools` (dev server `restart-dev.sh`), node:test.

**Spec:** `docs/superpowers/specs/2026-10-09-atomix-passover-design.md` (§3 and §4).

## Global Constraints

- No build step, no dependencies; every change is a plain file edit.
- Older themes (Midnight, Arctic, Arctic Side, Daylight, Harbour, Obsidian) stay pixel-identical to the v0.14.0 screenshots except where §3 names a token change (field/toggle edges, `.toast-error`, slider rails, 24 px range height).
- Copy is sentence case; one word per thing: "movie(s)", "collection(s)", "Queue", "Enable casting", "Household".
- Devtools suites that must stay green: orbit-ui, orbit-sizes (re-baselined once, deliberately), orbit-a11y, gate-ui, extras-ui, extras-lyrics-ui, lists-ui, rebrand-ui, music-kbd, profiles-ui, dialogs, servers-ui, cast-ui, qol-ui, plus the new a11y-ui.
- Re-run the audit scripts after Task 7: `python3 -I scratchpad/passover/consistency/hardcoded.py` and `deadcss.py` — counts in the ledger before/after.

## Review Focus

1. **A screen-reader user who pauses on the seek bar for a minute.** They hear the time once on focus, then at most every 10 s; pressing Right announces the new time at once. Pinned in Task 1.
2. **A phone at 360 px wide** (narrower than the audit's 390). The player controls still fit, the dock still fits with no label, the toast sits above the dock, the settings strip shows its fade. Pinned in Task 4.
3. **An older theme after the token refactor.** Midnight and Arctic screenshots are byte-identical to the v0.14.0 baselines apart from the five named token changes. Pinned in Task 6.
4. **A viewer with a dark chosen accent (#101040).** Everything that used the accent as text is still readable (luminance clamped), and the primary button's ink flips correctly. Pinned in Task 3.
5. **The music queue from the mini-player, the TV page and the phone page.** All three say "Queue", the list excludes the song that is playing, and "Add to queue" still works from an album. Pinned in Task 5.

---

### Task 1: Live regions and the seek bars

**Files:**
- Modify: `public/js/components.js` (`announce()`, `toast()` routing, boot-time regions), `public/js/app.js` (boot: create regions; announce the title after render), `public/index.html` (none — regions are created in JS at boot so templates stay unchanged)
- Modify: `public/js/views/player.js:36,119-130,260-271,312,674-708` (notice role/persistence, seek throttle, Up next sentence), `public/js/music.js:598-608,551` (seek throttle, volume text), `public/js/views/remote.js:39,221-234,49` (status change-only, seek throttle, volume text), `public/js/views/nowplaying.js:27,36` (seek scale + text, volume text), `public/js/cast.js:267-304` (pill live + change-only), `public/js/views/search.js:13`, `public/js/views/settings.js:1295` (summary live nodes)
- Create: `devtools/a11y-ui.mjs` (sections `live|seek|names|contrast|pin|menus`)
- Test: node `test/announce.test.js` (jsdom-free: the helper is DOM-light; test the throttle helper `sliderText(el, text, { force })` exported from components.js)

**Interfaces:**
- Produces: `announce(text, { assertive = false })`; `sliderText(input, text, { force = false })` (writes `aria-valuetext` when `force`, when the input has focus and 10 s passed since the last write, or when the input is not focused — never more often while focused); `toast(message, { type })` routes `type: 'error'` through the alert region too.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing checks** — `devtools/a11y-ui.mjs live|seek`: (a) focus the playing player's seek bar, count `aria-valuetext` mutations over 5 s via a MutationObserver → ≤ 2; press ArrowRight → one more write within 200 ms; (b) `#live-polite` text after `go('#/library/1')` matches the page title; after `toast('x', {type:'error'})` `#live-alert` text is "x"; after a notice appears `.player-notice` has `role="status"`; after Up next shows `#live-polite` reads /^Up next: .* Starting in 10 seconds$/; cast pill `.cast-pill-text` has `aria-live="polite"`, and ten polls change its text node ≤ 1 time; Remote `[role=status]` text node identity unchanged across 2 s; Now Playing seek `max` equals the duration in seconds and `aria-valuetext` reads "0:12 of 3:40" shape; every volume slider has `aria-valuetext` ending in "%". Node: `sliderText` throttle logic with a fake clock.
- [ ] **Step 2: Run them** — Expected: FAIL on each (writes 4×/s, no regions, no role, 0–1000 scale).
- [ ] **Step 3: Implement** per spec §3 "Sliders" and "Announcements". Regions: `<div id="live-polite" class="sr-only" role="status" aria-live="polite" aria-atomic="true">` and `#live-alert role="alert"` appended in `boot()`; `.sr-only` in app.css (clip pattern). `announce` clears then sets on the next frame so repeats speak.
- [ ] **Step 4: Run** — a11y-ui live/seek PASS; orbit-a11y, cast-ui, music-kbd, qol-ui green.
- [ ] **Step 5: Ledger** `Task 1: complete`.

---

### Task 2: Names, roles and structure

**Files:**
- Modify: `public/js/views/nowplaying.js:106-112,24,26,157` (lyric buttons, play name, repeat label, `aria-current` on the playing row in `music.js` track rows too), `public/js/components.js:56,69,119,445-447,359-366` (card label state, "More options for", dialog ids), `public/js/views/item.js:239,273,500-521,541` (episode labels, tabs wiring, "This film"), `public/js/views/player.js:57-63,537-564,589-650,653,687` (menu ARIA, online search as a labelled panel, subtitles button name, h2s), `public/js/views/settings.js:80-96,190-197,975` (roving radios, `scope`), `public/js/components.js:225,246,325` (logo alt, `emptyState({ level })`), `public/js/app.js:124-130` (accent clamp via `tint.js`'s clamp), `public/js/motion.js` (new: `reduceMotion()`), `public/js/components.js:137`, `public/js/nav.js:218`, `public/css/app.css:606`
- Test: `test/cards.test.js` (labels), `devtools/a11y-ui.mjs names`

**Interfaces:**
- Produces: `cardLabel(item, progress)` in components.js → `"<title> (<year>), watched" | ", <n> unwatched" | ", <n> min left"`; `openDialog` ids `dlg-title-<n>`; `reduceMotion()`.

- [ ] **Step 1: Failing checks** — cards.test: `cardLabel` for the three states and the plain case. a11y-ui names: lyric lines are `button[aria-label^="Jump to: "]` inside `li`; the playing row has `aria-current="true"`; Now Playing play button label flips Play/Pause after a click; two stacked dialogs (library dialog → Browse…) have distinct `aria-labelledby` targets and the top one resolves to its own title; the player menu has `aria-labelledby`, a `[role=separator]`, "Find subtitles online…" is `[role=menuitem]`, the openers have `aria-haspopup="menu"` and `aria-expanded` toggles; the online search panel is `[role=dialog][aria-label]` and not inside `[role=menu]`; `.more` buttons on a playlist read "More options for <title>"; `.spot-logo` alt is ""; player overlays have no `h3` without an `h2`; season tabs: `aria-controls` points at the panel id and Left/Right move the selection; a dark chosen accent (#101040) yields a computed `--accent` with relative luminance ≥ 0.30; the "This film" card has `tabindex="-1"` and `aria-current`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per spec §3 "Names and roles" and "Reduce motion".
- [ ] **Step 4: Run** — PASS; lists-ui, extras-lyrics-ui, dialogs, orbit-a11y green.
- [ ] **Step 5: Ledger** `Task 2: complete`.

---

### Task 3: Contrast, sizes, zoom, the PIN error, the server switches

**Files:**
- Modify: `public/css/app.css:185-188,213,496,523,752,1193,1203` (edges, toast-error, rails, 24 px ranges), `themes/orbit/theme.css:154-162,172` (Orbit edges), `public/css/app.css` + `orbit.css` (player top scrim; control glass alpha), `public/css/orbit.css:11-17` (`--px` zoom-aware, rem floors), `public/js/views/profiles.js` or `gate.js` (PIN inline error), `public/js/views/settings.js` (five checkboxes → `toggle()`), `public/js/tint.js` (export the clamp)
- Test: `devtools/a11y-ui.mjs contrast|pin`; `python3 -I <a11y-enforcer>/scripts/contrast.py` on the new token pairs (ratios in the ledger); orbit-sizes re-baseline

- [ ] **Step 1: Failing checks** — contrast.py pairs: app.css input border on `#12151c` ≥ 3:1; Orbit input edge on `#05050c` ≥ 3:1; `.toast-error` text ≥ 4.5:1; rails ≥ 3:1. a11y-ui contrast: every `input[type=range]` bounding height ≥ 24; `.player-top` has a scrim element/gradient (computed background-image not "none"); Settings → Server has five `[role=switch]` named "Convert video when needed", "Seek-bar previews", "Find TV intros", "Online trailers", "Online lyrics"; at 200 % zoom (emulate `deviceScaleFactor` 2 with viewport 960 wide) Orbit body font-size ≥ 1.8 × the 100 % value. pin: wrong PIN → `.form-error[role=alert]` inside the dialog reads "Wrong PIN.", the field is empty, focused, `aria-invalid="true"`, no toast.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per spec §3 "Contrast", "Zoom", "Server checkboxes", "PIN".
- [ ] **Step 4: Run** — PASS; orbit-sizes re-baselined (the ledger records which pages moved and why); orbit-a11y green; older-theme screenshots differ only on the named tokens.
- [ ] **Step 5: Ledger** `Task 3: complete`.

---

### Task 4: Phone and TV layout

**Files:**
- Modify: `public/css/app.css:543` + `public/js/views/player.js` (control row wrap < 480 px; "…" sheet with Quality/Cast/Full screen), `public/css/orbit.css:84-102` (dock label off ≤ 390 px), `themes/orbit/theme.css:520` + `public/css/app.css:500,736,792` (toasts above dock/mini), `public/css/app.css:421` + `orbit.css:147` (settings strip fade masks), `public/css/orbit.css:176` (`scroll-snap` on `.home-rows`, `scroll-margin-top` on row headings), `public/css/app.css` settings form bottom padding + `.hint { min-height: 2.6em }`
- Test: `devtools/orbit-sizes.mjs` additions at 390 and 360 px

- [ ] **Step 1: Failing checks** — orbit-sizes phone (390 and 360): every `.player-controls button` right edge ≤ viewport width; `.orbit-menu` scrollWidth ≤ clientWidth and no `.nav-label` visible on the current entry; a toast's bottom ≤ dock top − 8; `.settings-tabs` has a mask-image; on TV after ArrowDown to the second row the first row heading's box is either fully above the rows viewport or fully inside it (not sliced: top ≥ rows.top or bottom ≤ rows.top); Settings → Server: the last field's bottom ≤ Save bar top; General panel inputs share a top within 2 px.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per spec §3 "Phone and TV layout".
- [ ] **Step 4: Run** — PASS at 390 and 360; orbit-ui, orbit-sizes (desktop/laptop/tablet unchanged) green.
- [ ] **Step 5: Ledger** `Task 4: complete`.

---

### Task 5: Empty states and copy

**Files:**
- Modify: `public/js/components.js:324` (`emptyState({ icon, title, text, action, level })`), `public/js/views/lists.js:36-38`, `public/js/views/search.js`, `public/js/views/home.js`, `public/js/lists.js:9,21`, `public/js/views/library.js:179`, `public/js/music.js:549,681,726`, `public/js/views/nowplaying.js:68`, `public/js/views/settings.js:37,1292` (Household, Enable casting), `public/js/app.js:354` + the three not-found throws (`src/api/library.js`, `src/api/lists.js` messages: "This title no longer exists." / "This library no longer exists." / "This collection no longer exists."), `public/js/views/player.js:224` (badge "Direct play"/"Converting"/"Remuxing" + info icon), `public/js/views/remote.js` (+30 s), `public/js/views/player.js:548` (online-off hint), toasts (trailing stops; "Collection saved" success)
- Test: `devtools/qol-ui.mjs copy` section; `test/api.test.js` not-found messages

- [ ] **Step 1: Failing checks** — qol-ui copy: Lists page has a "Browse Movies" button in the empty Watchlist state and the playlist hint reads "Use Add to playlist… on any title's menu to make one."; Collections hint reads "Collections appear here as your movies are matched."; search no-results shows "Open Add-ons" (admin); the Watchlist button's `aria-label` is "Add to watchlist"; the mini-player queue button and the TV heading read "Queue" and the list excludes the playing song; Settings tab "Household"; switch "Enable casting"; `#/item/99999` shows "This title no longer exists." with a single "Go home"; the badge reads "Direct play"; Remote forward button is "Forward 30 seconds"; with the online-subtitles plugin off the subtitles menu shows the Settings → Plugins hint for admins. api.test: `GET /api/items/99999` → 404 `"This title no longer exists."`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per spec §3 "Empty states and copy".
- [ ] **Step 4: Run** — PASS; lists-ui, music-kbd, extras-ui, rebrand-ui green (update their expectations where the copy changed, noting each in the ledger).
- [ ] **Step 5: Ledger** `Task 5: complete`.

---

### Task 6: Tokens and file responsibilities

**Files:**
- Modify: `themes/orbit/theme.css` (new tokens; literal replacement), `public/css/app.css` (classic tokens; literal replacement), `public/css/orbit.css` (colour out, Orbit-only rules in), `themes/daylight/theme.css:24` (dead rule), `public/js/dom.js` (icons: −bell/globe/palette, +cloud)
- Test: `python3 -I scratchpad/passover/consistency/hardcoded.py` and `deadcss.py` (before/after counts); every browser suite; older-theme screenshots

- [ ] **Step 1: Record the baseline** — run both scripts; copy the per-file counts into the ledger; take `orbit-ui`/`rebrand-ui` screenshots as the pre-refactor reference (they are frozen already).
- [ ] **Step 2: Implement** per spec §4 "Orbit tokens", "Classic tokens", "File responsibilities", and the dead-CSS list. Pure value-preserving replacements: no computed pixel may change on the older themes.
- [ ] **Step 3: Verify** — scripts again (targets: Orbit hex ≤ 20, `#ffffff`/`#0b0b16` literals 0, dead selectors 0); rebrand-ui and orbit-ui green; `devtools/orbit-sizes.mjs` green without re-baseline. Expected: counts in the ledger; Review Focus 3 holds.
- [ ] **Step 4: Ledger** `Task 6: complete`.

---

### Task 7: Component consolidation

**Files:**
- Modify: `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css` (`.icon-btn`, `.range`, `.option-row`, `.float-pill`, one spinner), `public/js/components.js` (`spinner({ inline })`, `TOASTS`, `emptyState` as the only empty state, `landscapeCard` for episode rows), `public/js/views/item.js` (`moreItems(item)`; episode rows via `landscapeCard`), `public/js/views/settings.js`, `public/js/views/lists.js` (row actions pattern), `public/js/music.js`, `public/js/cast.js`, `public/js/views/remote.js`, `public/js/views/player.js`, `public/js/views/nowplaying.js` (class renames with the old names kept as aliases on the elements)
- Test: every browser suite; `test/cards.test.js` (episode row = landscapeCard markup)

- [ ] **Step 1: Failing checks** — cards.test: `episodeRow(ep)` markup equals `landscapeCard(ep, { episode: true })` markup. a11y-ui: the detail page under Midnight shows "Cast to…" and "From the start" in its "…" sheet (today Orbit-only). orbit-sizes: `.range` inputs 24 px in every theme.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per spec §4 "Components", "Row actions and detail actions", "Polish" (weights, type literals, `.btn-sm`, `btn-secondary`). Keep old class names on elements as aliases for this release so devtools selectors keep working; CSS targets the new names.
- [ ] **Step 4: Run** — all browser suites green; Orbit re-baselined once (ledger lists the pages); scripts re-run (counts).
- [ ] **Step 5: Ledger** `Task 7: complete`.

---

### Task 8: Docs, version, review, delivery

- [ ] `package.json` → 0.15.0; README "Added in v0.15.0" (plans A+B); `docs/ARCHITECTURE.md` notes: the `subtitles` job, `keyframes.js`, `warmup.js`, `net.js`, `announce()`, the token sets, `moreItems()`; the Settings background line copy.
- [ ] Fresh **sonnet** review of plan B (diff vs the post-A snapshot, spec §3–§4, this Review Focus verbatim, rulings); re-grade; one TDD fix pass; ledger `Final:` lines.
- [ ] Delivery: hash-check every PC file against the v0.14.0 snapshot; `device_commit_files` all changed files (A + B); PC `npm test`; project note (`claude/build-status.md`: Round 17 / v0.15.0, Added in v0.15.0, Not yet verified: HDR on a real TV, nvenc/qsv IDR, libass warm-up time on Windows, NVDA/VoiceOver; deferred minors from both reviews); pictures `v0150-desktop.png`/`v0150-phone.png`; final message with every ruling and deferred minor; ledger to `scratchpad/note/`, workspace deleted.
