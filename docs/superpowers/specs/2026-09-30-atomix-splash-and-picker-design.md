# Atomix: the splash screen and "Who's watching?" (v0.7.1)

Design, 30 September 2026. Approved by Dallas in conversation; this document is the record.

## What this is

Two behaviours Atomix gets from the way Netflix works on a TV:

1. **An animated splash** plays when Atomix is opened: the Orbit concept (the logo draws itself, then lifts away).
2. **"Who's watching?" comes back** on every fresh open of Atomix and again after it has sat untouched for a while (30 minutes by default; an admin can change it). A profile with a PIN always asks for it.

Nothing about accounts, sessions or the server-side profile changes. The browser decides when to ask again; the server keeps enforcing PINs and library access as it does now.

## Words used here

- **A fresh open**: a new browser tab, a TV's browser starting, or the installed web app launching. Reloading a tab that already had a profile is *not* a fresh open.
- **The note**: a small record each tab keeps in `sessionStorage` (which the browser clears when the tab closes): `{ profileId, lastActive }`.
- **Activity**: a key press, pointer move, click, tap or scroll anywhere on the page, or video or music playing.
- **Idle**: the time since the last activity, counted only while nothing is playing.

## 1. The gate: what a page load shows

A new module, `public/js/gate.js`, decides at boot and whenever the picker might be needed. Its decision is a pure function, tested in Node:

```
gateDecision({ note, now, idleMinutes, needsPicker })
  → 'splash+picker' | 'splash' | 'picker' | 'nothing'
```

- **No note** (a fresh open): `'splash+picker'` when the account needs a picker, else `'splash'`.
- **A note, fresh** (idle < idleMinutes, or idleMinutes is 0): `'nothing'`: no splash, no picker; the page goes where the address says.
- **A note, stale** (idle ≥ idleMinutes): `'picker'`, no splash.

`needsPicker` is true when the account has more than one profile, or its only profile has a PIN (the same rule the server uses today to decide `profileRequired`; the client reads `state.status.profileRequired` and the profile list it already fetches).

How it applies:

- **Boot.** `app.js` asks the gate before its first `render()`. For `'splash+picker'` and `'picker'` it clears `state.profile` on the client only (the server session keeps its profile), so the existing render rule shows the picker route. For `'nothing'` it renders as today.
- **Picking a profile** (`onProfileSelected`) writes the note with the chosen profile and `lastActive = now`. This is the only place the note is created.
- **The idle timer.** Once a profile is on, the gate listens for activity (`keydown`, `pointermove`, `pointerdown`, `wheel`, `touchstart`, and `scroll` on the window and `main`, all passive) and updates `note.lastActive`, no more than once every 5 seconds. A `setInterval` every 30 seconds asks `gateDecision`; on `'picker'`, if nothing is playing, it clears `state.profile` on the client, remembers the current address, and renders the picker. Picking any profile (the same one included) goes back to that address, which wins over the usual jump to Home; on a player page the remembered address is the show's or movie's page, so the video isn't restarted.
- **Playing counts as activity.** `player.js` and `music.js` already know when they are playing; the gate treats "playing" as continuous activity, so the picker never appears during a film, and the idle clock starts from the end of playback.
- **Sign-out and a 401** clear the note.
- **Reload during the splash or picker:** the note doesn't exist yet, so the splash plays again. That is expected.

The server's `/api/status` gains `pickerIdleMinutes` (from settings; default 30; 0 means never), which the gate uses as `idleMinutes`.

**Two screens on one account** each keep their own note, so switching profiles on the TV does not touch the phone.

## 2. The splash

`public/js/splash.js` draws the Orbit animation and controls its life:

- **Before anything else shows.** `index.html` gets `<div id="splash" class="splash" hidden>`; `app.css` styles it as a fixed, full-screen layer over everything (`z-index` above dialogs and the player) in the theme's background colour, so nothing shows behind it. The app fetches `/api/status` first (one quick request; the page is still empty), and unhides the layer only when someone is signed in and the gate's decision includes `'splash'`. The session cookie is HttpOnly, so the page can't know it's signed in any sooner.
- **What plays** (about 2.5 s, the approved concept A):
  1. the two orbits draw themselves in (stroke-dashoffset), the second 0.15 s after the first;
  2. the electron appears at its resting spot and makes one lap of its orbit (SVG `animateMotion` on the same ellipse as the logo), starting at 0.45 s;
  3. the play button pops into the middle at 0.85 s with a soft ring of light that fades;
  4. the name (the server name, "Atomix" by default) rises under the mark at 1.25 s;
  5. at 1.95 s the mark shrinks upward and the name fades, and at 2.45 s the layer fades out (0.4 s).
  The mark is drawn from `MARK` in `dom.js` (the same paths as the logo and loader), in `var(--accent)` for the orbits and the play button and `var(--tint)`/`--accent` for the electron, over the theme's `--bg`. The name is set in the theme's title face. Sizes scale with the screen (the mark is about 18% of the width on a TV, capped on a desktop, and about 34% on a phone).
- **Never blocks.** The app boots behind it. The splash ends at the later of: the animation's end, or the boot finishing (status and themes loaded, the first page rendered). A slow server makes the finished logo wait with the electron circling until the page is ready.
- **Skipping.** Any key press (except modifier keys), click or tap ends it at once with a 0.2 s fade. The key or tap is not passed on to the page.
- **Reduce motion** (the profile setting or the system setting): the finished logo fades in and out over 0.5 s each with no drawing, lap or pop, and the layer is gone within 1.2 s.
- **Where it doesn't play:** the sign-in and setup screens (`!state.user`), and never more than once per fresh open. It plays in every theme in that theme's colours; it is not Orbit-only.
- **Accessibility:** the layer is `aria-hidden` and `inert` for the page behind it; a screen reader gets the page, not the animation. The page behind is not focusable until the splash has gone.
- **Focus.** When the splash ends, focus goes where it would have gone without it (the picker's first profile, or Home's main button), so a remote user can press OK straight away.

## 3. The setting

- `src/settings.js`: `pickerIdleMinutes: 30` in `SETTING_DEFAULTS`; `publicView()` includes it, and `/api/status` exposes it as `pickerIdleMinutes`.
- `src/api/admin.js` clamps it to one of `0, 15, 30, 60, 240` (anything else becomes 30).
- Settings → Server (`public/js/views/settings.js`, `serverTab`): a select labelled **Ask who's watching after** with the choices *15 minutes*, *30 minutes*, *1 hour*, *4 hours* and *Never*, with the hint "How long Atomix can sit untouched before it asks again. Playing a video or music counts as being there."
- No migration: settings not in the table take their default.

## 4. Testing

**Node (`node:test`):**

- `test/gate.test.js`: `gateDecision` for every branch in section 1, including `idleMinutes: 0` (never stale), a note exactly at the limit (stale), and `needsPicker: false` (`'splash'` on a fresh open, `'nothing'` when stale, because there is nothing to pick).
- `test/api.test.js` or `test/extras-settings.test.js`: `pickerIdleMinutes` in `/api/status`; the admin PUT accepts the five values and turns anything else into 30.

**Browser (`/home/claude/devtools/gate-ui.mjs`, Playwright, cloud only):**

1. A fresh context, signed in: the splash is visible at once, the app boots behind it, and the picker is on screen with focus on a profile when it ends (about 2.5 s; must be under 4 s).
2. Reload with a note: no splash, no picker; the page opens at the address.
3. A new tab in the same context (same cookie, no note): splash and picker again.
4. With the clock advanced past the idle time (`page.clock`) and nothing playing: the picker appears over Home; picking the same profile returns to the same address.
5. Same, but with a video playing: no picker; after the video ends and the idle time passes, the picker appears and picking a profile returns to the show's page.
6. A PIN'd profile asks for its PIN when picked after idle.
7. A key press during the splash ends it within 300 ms and does not reach the page.
8. Reduce motion (profile pref, and the system setting): no `animateMotion` runs and the splash is gone within 1.2 s.
9. The setting: an admin changes it to 15 minutes; `/api/status` reports 15; the picker appears after 15 minutes of clock.
10. The older themes: with `theme: 'arctic'`, the splash plays in Arctic's colours and Home afterwards is pixel-identical to a load without the splash (compare after the layer is gone).
11. No console errors.

The existing suites (`orbit-ui.mjs`, `regress.mjs`, and the rest) sign in through the picker already; they get a shared helper that waits for the splash to end (or sets a fresh note in `sessionStorage` before navigating, to skip it).

## Out of scope

- Remembering a profile across devices, or on the server.
- A sound with the splash.
- Different splashes per theme.
- Asking for the PIN on every page load (only on picking a profile, as today).

## Files

New: `public/js/gate.js`, `public/js/splash.js`, `test/gate.test.js`, devtools `gate-ui.mjs`.

Modified: `public/index.html`, `public/css/app.css` (the splash layer; theme-neutral), `public/js/app.js` (boot, `onProfileSelected`, sign-out and 401 handlers), `public/js/views/profiles.js` (return to the remembered address), `public/js/views/player.js` and `public/js/music.js` (report playing to the gate), `public/js/views/settings.js`, `src/settings.js`, `src/api/account.js`, `src/api/admin.js`, `test/api.test.js` (or `extras-settings.test.js`), `docs/ARCHITECTURE.md`, `README.md`, `package.json` (0.7.1), devtools `orbit-lib.mjs` and the sign-in helpers in the other suites.
