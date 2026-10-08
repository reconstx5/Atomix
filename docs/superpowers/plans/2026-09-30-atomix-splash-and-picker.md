# Atomix splash and "Who's watching?" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Atomix is opened fresh, an animated Orbit splash plays and "Who's watching?" follows; the picker returns after the idle time an admin sets, and a PIN'd profile always asks.

**Architecture:** A per-tab note in `sessionStorage` (`{ profileId, lastActive }`) is the only new state. A pure `gateDecision()` in `public/js/gate.js` turns the note, the clock, the idle setting and "does this account need a picker" into one of four outcomes; `app.js` asks it at boot and a 30-second timer asks it while a profile is on. The splash (`public/js/splash.js`) is a fixed layer in `index.html` from the first paint that draws the logo's own `MARK` paths and ends at the later of its animation or the boot. The server only gains one setting, `pickerIdleMinutes`, exposed on `/api/status`.

**Tech Stack:** Node ≥ 22.13 (node:http, node:sqlite, node:test), plain ES-module browser JS, no build step. Browser checks with Playwright from `/home/claude/devtools` (cloud only), signed in against the dev server on :8787 (`/home/claude/devtools/restart-dev.sh` restarts it; never `pkill -f`).

**Spec:** `docs/superpowers/specs/2026-09-30-atomix-splash-and-picker-design.md`

## Global Constraints

- Node ≥ 22.13; zero npm dependencies; plain ES-module browser JS with no build step.
- The splash plays in every theme, in that theme's colours; nothing here is Orbit-only, and the six older themes' pages must be pixel-identical once the splash has gone.
- The server session and PIN checks do not change; picking a profile still calls `POST /api/profiles/:id/select`, and a profile with a PIN always asks.
- The idle setting `pickerIdleMinutes` takes only `0, 15, 30, 60, 240` (default 30; 0 = never); anything else becomes 30.
- Activity: `keydown`, `pointermove`, `pointerdown`, `wheel`, `touchstart`, `scroll` (passive), written to the note at most once every 5 s; video or music playing counts as continuous activity.
- The splash: about 2.5 s; ends at the later of the animation or the boot; any key (except modifier keys), click or tap ends it in ≤ 300 ms and does not reach the page; under Reduce motion it is a fade-in and fade-out of the finished logo, gone within 1.2 s; never on the sign-in or setup screens; `aria-hidden` and `inert` behind it.
- Copy: the setting is "Ask who's watching after" with "15 minutes", "30 minutes", "1 hour", "4 hours", "Never" and the hint "How long Atomix can sit untouched before it asks again. Playing a video or music counts as being there."
- Version 0.7.1. No commits in the cloud copy (Dallas commits on his PC).

## Review Focus

1. **The picker returns while a dialog is open** (the intro editor, Fix match, a PIN box). A reasonable person expects the dialog to close and the picker to show, not a picker under a dialog. Test in Task 4.
2. **The idle time is changed while tabs are open.** The gate must use the new value at its next tick without a reload. Test in Task 5 (the browser check re-reads `/api/status` on each tick).
3. **`sessionStorage` is unavailable** (Safari private mode used to throw; a locked-down TV browser may refuse). The app must still work: treat it as a fresh open every load. Unit-tested in Task 2 (`readNote` never throws), in the browser in Task 4.
4. **Two profiles, one PIN'd, one not, and the PIN box is cancelled after idle.** The picker must stay on screen (not a blank page), and Back must not escape it. Test in Task 4.
5. **The splash on a slow server.** If the boot's later requests take seconds, the finished logo waits with the electron circling and the page appears when ready; the splash never ends on a blank page. Test in Task 3 (a routed 4 s delay on everything after `/api/status`).

---

## Files

New:

| File | Responsibility |
| --- | --- |
| `public/js/gate.js` | The note, `gateDecision()`, the activity listeners, the idle tick, `markPlaying()` |
| `public/js/splash.js` | Builds the Orbit animation into `#splash`, `showSplash()`, `endSplash()`, the skip keys |
| `test/gate.test.js` | Node tests for `gateDecision` |
| `/home/claude/devtools/gate-ui.mjs` | The browser checks |

Modified: `public/index.html`, `public/css/app.css`, `public/js/app.js`, `public/js/views/profiles.js`, `public/js/views/player.js`, `public/js/music.js`, `public/js/views/settings.js`, `src/settings.js`, `src/api/account.js`, `src/api/admin.js`, `test/api.test.js`, `docs/ARCHITECTURE.md`, `README.md`, `package.json`, `/home/claude/devtools/orbit-lib.mjs`.

## How to run things

- Unit and API tests: `cd /home/claude/nodeflix && npm test` (165 pass before this plan starts). One file: `node --test test/gate.test.js`.
- Dev server: `/home/claude/devtools/restart-dev.sh` (restart after server-side changes; the browser reloads client files itself).
- Browser checks: `node /home/claude/devtools/gate-ui.mjs [section...]`; helpers in `orbit-lib.mjs` (`open, signIn, check, failed, api, setPrefs, go, press, active, rect, style`).
- The dev account: user `dallas` / `password123`, profiles `dallas` (PIN 4321) and `Mia` (kids, no PIN).

---

## Stage 1 — The setting and the decision

### Task 1: The `pickerIdleMinutes` setting

**Files:**
- Modify: `src/settings.js` (`SETTING_DEFAULTS`, `publicView`)
- Modify: `src/api/account.js` (`/api/status`)
- Modify: `src/api/admin.js` (the PUT clamp)
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `GET /api/status` → `pickerIdleMinutes: number` (one of 0, 15, 30, 60, 240; default 30). `PUT /api/admin/settings { pickerIdleMinutes }` accepts those five and turns anything else into 30.

- [ ] **Step 1: Write the failing test**

In `test/api.test.js`, inside `test('settings hide secrets and themes are listed', …)`, append before the closing `});`:

```js
  // "Ask who's watching after": 30 minutes by default; only the five choices are kept.
  assert.equal((await call('GET', '/api/status')).data.pickerIdleMinutes, 30);
  for (const v of [0, 15, 30, 60, 240]) {
    await call('PUT', '/api/admin/settings', { pickerIdleMinutes: v });
    assert.equal((await call('GET', '/api/status')).data.pickerIdleMinutes, v, String(v));
  }
  for (const bad of [7, -1, 'soon', null]) {
    await call('PUT', '/api/admin/settings', { pickerIdleMinutes: bad });
    assert.equal((await call('GET', '/api/status')).data.pickerIdleMinutes, 30, String(bad));
  }
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /home/claude/nodeflix && node --test test/api.test.js 2>&1 | grep -E "^not ok|pickerIdleMinutes|# (pass|fail)"`
Expected: `not ok` for "settings hide secrets and themes are listed" with `undefined !== 30`.

- [ ] **Step 3: The setting**

In `src/settings.js`, after `loginMessage: '',` add:

```js
  pickerIdleMinutes: 30, // "Who's watching?" comes back after this long untouched (0 = never)
```

and change `publicView()` to:

```js
  publicView() {
    const s = this.all();
    return { serverName: s.serverName, defaultTheme: s.defaultTheme, defaultQuality: s.defaultQuality, pickerIdleMinutes: s.pickerIdleMinutes };
  }
```

In `src/api/account.js`, in the `/api/status` object after `defaultQuality: s.defaultQuality,` add:

```js
        pickerIdleMinutes: s.pickerIdleMinutes,
```

In `src/api/admin.js`, after the `scanIntervalMinutes` clamp line in the PUT handler add:

```js
      if (body.pickerIdleMinutes !== undefined) body.pickerIdleMinutes = [0, 15, 30, 60, 240].includes(Number(body.pickerIdleMinutes)) ? Number(body.pickerIdleMinutes) : 30;
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd /home/claude/nodeflix && node --test test/api.test.js 2>&1 | grep -E "^not ok|# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Checkpoint**

`npm test` → `# fail 0`. Files: `src/settings.js`, `src/api/account.js`, `src/api/admin.js`, `test/api.test.js`. Restart the dev server (`/home/claude/devtools/restart-dev.sh`).

---

### Task 2: `gate.js`: the note and the decision

**Files:**
- Create: `public/js/gate.js`
- Test: `test/gate.test.js`

**Interfaces:**
- Produces (all exported from `public/js/gate.js`):
  - `gateDecision({ note, now, idleMinutes, needsPicker })` → `'splash+picker' | 'splash' | 'picker' | 'nothing'`. `note` is `{ profileId: number, lastActive: number } | null`.
  - `readNote()` → note or null (never throws; a broken or missing `sessionStorage` reads as null).
  - `writeNote(profileId, now = Date.now())`, `touchNote(now = Date.now())` (updates `lastActive`, at most once per 5 s), `clearNote()`. All swallow storage errors.
  - `NOTE_KEY = 'atomix-gate'`.

- [ ] **Step 1: Write the failing tests**

`test/gate.test.js`:

```js
// The gate decides what a page load shows (public/js/gate.js): the splash and the picker on a
// fresh open, nothing on a reload, the picker again after the idle time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateDecision } from '../public/js/gate.js';

const MIN = 60_000;
const now = 1_700_000_000_000;

test('a fresh open (no note) plays the splash, then the picker when the account needs one', () => {
  assert.equal(gateDecision({ note: null, now, idleMinutes: 30, needsPicker: true }), 'splash+picker');
  assert.equal(gateDecision({ note: null, now, idleMinutes: 30, needsPicker: false }), 'splash');
});

test('a fresh note (a reload) shows nothing extra', () => {
  const note = { profileId: 1, lastActive: now - 29 * MIN };
  assert.equal(gateDecision({ note, now, idleMinutes: 30, needsPicker: true }), 'nothing');
});

test('a stale note brings the picker back, without the splash', () => {
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 30 * MIN }, now, idleMinutes: 30, needsPicker: true }), 'picker', 'exactly the limit counts as stale');
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 5 * 60 * MIN }, now, idleMinutes: 30, needsPicker: true }), 'picker');
});

test('with nothing to pick, a stale note shows nothing', () => {
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 60 * MIN }, now, idleMinutes: 30, needsPicker: false }), 'nothing');
});

test('an idle time of 0 means never', () => {
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: now - 9999 * MIN }, now, idleMinutes: 0, needsPicker: true }), 'nothing');
});

test('a note without a usable time is treated as a fresh open', () => {
  assert.equal(gateDecision({ note: { profileId: 1 }, now, idleMinutes: 30, needsPicker: true }), 'splash+picker');
  assert.equal(gateDecision({ note: { profileId: 1, lastActive: 'yesterday' }, now, idleMinutes: 30, needsPicker: true }), 'splash+picker');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/claude/nodeflix && node --test test/gate.test.js 2>&1 | grep -E "Cannot find|^not ok|# (pass|fail)"`
Expected: a module-not-found error for `../public/js/gate.js` (`# fail 1`).

- [ ] **Step 3: Write `gate.js`**

`public/js/gate.js`:

```js
// The gate: what a page load shows. Each tab keeps a note in sessionStorage (which the browser clears
// when the tab closes) saying which profile it is on and when it was last touched. No note means a fresh
// open (the splash, then "Who's watching?"); a fresh note means a reload (nothing extra); a stale note
// means the picker comes back. Playing video or music counts as being there.
export const NOTE_KEY = 'atomix-gate';
const TOUCH_EVERY = 5_000;

/** Pure: the four outcomes. `note` is { profileId, lastActive } or null; idleMinutes 0 means never. */
export function gateDecision({ note, now, idleMinutes, needsPicker }) {
  const last = Number(note?.lastActive);
  if (!note || !Number.isFinite(last)) return needsPicker ? 'splash+picker' : 'splash';
  if (!idleMinutes || now - last < idleMinutes * 60_000) return 'nothing';
  return needsPicker ? 'picker' : 'nothing';
}

// ---- The note (storage may be missing or refuse: then every load is a fresh open) ----
function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
export function readNote() {
  try {
    const raw = storage()?.getItem(NOTE_KEY);
    if (!raw) return null;
    const note = JSON.parse(raw);
    return note && typeof note === 'object' ? note : null;
  } catch {
    return null;
  }
}
function saveNote(note) {
  try {
    storage()?.setItem(NOTE_KEY, JSON.stringify(note));
  } catch {
    /* no storage: the next load is a fresh open, which is fine */
  }
}
export function writeNote(profileId, now = Date.now()) {
  saveNote({ profileId, lastActive: now });
}
let lastTouch = 0;
export function touchNote(now = Date.now()) {
  if (now - lastTouch < TOUCH_EVERY) return;
  lastTouch = now;
  const note = readNote();
  if (note) saveNote({ ...note, lastActive: now });
}
export function clearNote() {
  try {
    storage()?.removeItem(NOTE_KEY);
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `cd /home/claude/nodeflix && node --test test/gate.test.js 2>&1 | grep -E "^not ok|# (pass|fail)"`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Checkpoint**

`npm test` → `# fail 0` (171 tests). Files: `public/js/gate.js`, `test/gate.test.js`.

---

## Stage 2 — The splash

### Task 3: The splash layer

**Files:**
- Create: `public/js/splash.js`
- Modify: `public/index.html` (the layer), `public/css/app.css` (append the splash styles)
- Modify: `public/js/app.js` (show it at boot when there is no note; end it when the boot is done)
- Modify: `/home/claude/devtools/orbit-lib.mjs` (`signIn` gets past the splash), create `/home/claude/devtools/gate-ui.mjs`

**Interfaces:**
- Consumes: `MARK` from `public/js/dom.js` (`orbits: string[2]`, `nucleus: string`, `electron: { cx, cy, r }`); `readNote()` from Task 2.
- Produces: `showSplash({ name })` (builds the animation into `#splash`, unhides it, returns a promise that resolves when the animation has run its course or was skipped), `endSplash()` (fades it out; safe to call twice), `splashDone()` → Promise that resolves once the layer is gone. `html.splash-on` while it shows.

- [ ] **Step 1: Write the failing browser checks**

`/home/claude/devtools/gate-ui.mjs`:

```js
// The splash and "Who's watching?" (v0.7.1). Dev server: restart-dev.sh.
//   node /home/claude/devtools/gate-ui.mjs [splash|gate|setting|themes]
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
import { check, failed, api, setPrefs } from './orbit-lib.mjs';

const only = process.argv.slice(2);
const run = (name) => !only.length || only.includes(name);
const base = 'http://127.0.0.1:8787';
const browser = await pw.chromium.launch();
const errors = [];

/** A fresh context: no cookie, no note. Signs in and stops at whatever the gate shows. */
async function freshTab({ reducedMotion = 'no-preference', width = 1920, height = 1080 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Content Security Policy/.test(m.text()) && errors.push(m.text()));
  await page.goto(base);
  await page.fill('input[name=username]', 'dallas');
  await page.fill('input[name=password]', 'password123');
  await page.keyboard.press('Enter');
  return { context, page };
}
const pickDallas = async (page) => {
  await page.click('.picker-profile:has-text("dallas")');
  await page.waitForSelector('dialog[open] .pin-input');
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.home-view');
};
const splashShown = (page) => page.evaluate(() => { const s = document.getElementById('splash'); return Boolean(s && !s.hidden && getComputedStyle(s).display !== 'none'); });

if (run('splash')) {
  // Signing in is a fresh open: the splash plays, the app boots behind it, the picker is ready when it ends.
  const { page, context } = await freshTab();
  const t0 = Date.now();
  await page.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  check('a fresh open shows the splash at once', await splashShown(page));
  const parts = await page.evaluate(() => ({ orbits: document.querySelectorAll('#splash .splash-orbit').length, motion: Boolean(document.querySelector('#splash animateMotion')), inert: document.querySelector('main').inert, hidden: document.getElementById('splash').getAttribute('aria-hidden') }));
  check('…drawn from the logo: two orbits, an electron on a path, the page inert and hidden behind it', parts.orbits === 2 && parts.motion && parts.inert && parts.hidden === 'true', JSON.stringify(parts));
  await page.waitForSelector('#splash[hidden]', { timeout: 5000 });
  const took = Date.now() - t0;
  check('the splash ends by itself in about 2.5 s', took >= 2000 && took <= 4000, `${took} ms`);
  check('…on the picker, with a profile ready for OK', (await page.$('.picker-grid')) !== null && (await page.evaluate(() => document.activeElement?.classList.contains('picker-profile'))));
  check('…and the page is usable again', await page.evaluate(() => !document.querySelector('main').inert));
  await page.screenshot({ path: '/tmp/shots/orbit/gate-picker.png' });
  await pickDallas(page);
  // A reload with a note: no splash, straight to the page.
  await page.goto(`${base}/#/library/1`);
  await page.reload();
  await page.waitForSelector('.library-results');
  check('a reload shows no splash', !(await splashShown(page)) && (await page.evaluate(() => document.getElementById('splash').hidden)));
  check('…and no picker', (await page.$('.picker-grid')) === null);
  // A new tab in the same context (same cookie, no note): the splash and the picker again.
  const tab2 = await context.newPage();
  await tab2.goto(base);
  await tab2.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  check('a new tab on the same account is a fresh open', await splashShown(tab2));
  await tab2.waitForSelector('.picker-grid', { timeout: 6000 });
  await tab2.close();
  // A key press skips it and never reaches the page.
  const { page: p3 } = await freshTab();
  await p3.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  await p3.waitForTimeout(300);
  const before = Date.now();
  await p3.keyboard.press('ArrowDown');
  await p3.waitForSelector('#splash[hidden]', { timeout: 1500 });
  check('a key press ends the splash within 300 ms', Date.now() - before <= 600, `${Date.now() - before} ms`);
  check("…and doesn't move the page's focus", await p3.evaluate(() => document.activeElement?.classList.contains('picker-profile') && document.activeElement === document.querySelector('.picker-profile')));
  await p3.context().close();
  // A slow server: the finished logo waits, the page never shows blank.
  const { page: p4 } = await freshTab();
  await p4.context().close();
  const slow = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const p5 = await slow.newPage();
  // Status answers quickly (the splash needs it to know you're signed in); the rest of the boot is slow.
  await p5.route('**/api/{themes,libraries,profiles,home}', async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue(); });
  await p5.goto(base);
  await p5.fill('input[name=username]', 'dallas');
  await p5.fill('input[name=password]', 'password123');
  await p5.keyboard.press('Enter');
  await p5.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  await p5.waitForTimeout(3000);
  check('slow server: the splash is still up after 3 s, electron circling', (await splashShown(p5)) && (await p5.evaluate(() => Boolean(document.querySelector('#splash .splash-wait')))));
  await p5.waitForSelector('#splash[hidden]', { timeout: 8000 });
  check('…and ends on the picker once the server answers', (await p5.$('.picker-grid')) !== null);
  await slow.close();
  // Reduce motion (the system setting): a short fade of the finished logo.
  const { page: p6 } = await freshTab({ reducedMotion: 'reduce' });
  await p6.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  const t6 = Date.now();
  check('reduced motion: no drawing or lap', await p6.evaluate(() => !document.querySelector('#splash animateMotion') && document.documentElement.classList.contains('splash-still')));
  await p6.waitForSelector('#splash[hidden]', { timeout: 3000 });
  check('…and gone within 1.2 s', Date.now() - t6 <= 1500, `${Date.now() - t6} ms`);
  await p6.context().close();
  await context.close();
}

// ---- more sections are added above this line by later tasks ----

check('no console errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
```

In `/home/claude/devtools/orbit-lib.mjs`, change `signIn` so every existing suite gets past the splash:

```js
export async function signIn(page) {
  await page.goto(base);
  await page.fill('input[name=username]', 'dallas');
  await page.fill('input[name=password]', 'password123');
  await page.keyboard.press('Enter');
  // A fresh tab plays the splash first (v0.7.1); a key ends it.
  await page.waitForSelector('.picker-grid, #splash:not([hidden])');
  if (await page.$('#splash:not([hidden])')) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#splash[hidden]');
  }
  await page.waitForSelector('.picker-grid');
  await page.click('.picker-profile:has-text("dallas")');
  await page.waitForSelector('dialog[open] .pin-input');
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.home-view');
  await page.evaluate(() => document.fonts.ready);
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `mkdir -p /tmp/shots/orbit && node /home/claude/devtools/gate-ui.mjs splash 2>&1 | tail -5`
Expected: a timeout waiting for `#splash:not([hidden])` (there is no `#splash` yet), exit 1.

- [ ] **Step 3: The layer and its styles**

In `public/index.html`, right after `<a class="skip-link" href="#main">Skip to content</a>` add:

```html
  <div id="splash" class="splash" aria-hidden="true" hidden></div>
```

Append to `public/css/app.css`:

```css
/* ---------- The splash: the logo draws itself when Atomix is opened (splash.js) ---------- */
.splash { position: fixed; inset: 0; z-index: 300; display: grid; place-items: center; background: var(--bg); color: var(--accent); transition: opacity 0.4s ease; }
.splash.is-leaving { opacity: 0; pointer-events: none; }
.splash-inner { display: grid; justify-items: center; gap: clamp(10px, 2.2vw, 40px); transform: translateY(-4vh); }
.splash-mark { width: clamp(120px, 18vw, 340px); overflow: visible; }
@media (max-width: 720px) { .splash-mark { width: 34vw; } }
.splash-orbit { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: splash-draw 0.9s cubic-bezier(0.3, 0.7, 0.2, 1) 0.2s forwards; }
.splash-orbit.two { animation-delay: 0.35s; }
.splash-nucleus { fill: currentColor; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; transform-box: fill-box; transform-origin: 40% 50%; opacity: 0; transform: scale(0.3); animation: splash-pop 0.5s cubic-bezier(0.2, 1.4, 0.4, 1) 0.85s forwards; }
.splash-electron { fill: var(--tint, var(--accent)); }
.splash-park { animation: splash-hide 0.01s linear 0.45s forwards; }
.splash-flare { fill: currentColor; opacity: 0; animation: splash-flare 0.9s ease-out 0.9s forwards; }
.splash-name { font-family: var(--font-title, var(--font)); font-weight: 700; font-size: clamp(22px, 4.2vw, 80px); letter-spacing: -0.03em; color: var(--text); opacity: 0; animation: splash-rise 0.6s ease-out 1.25s forwards; }
/* Leaving: the mark lifts away and the name fades before the layer goes. */
.splash.is-ending .splash-mark { animation: splash-leave 0.6s cubic-bezier(0.6, 0, 0.3, 1) forwards; }
.splash.is-ending .splash-name { animation: splash-name-leave 0.45s ease-in forwards; }
/* Waiting for a slow server: the electron keeps circling (a class the script adds after the lap). */
.splash-wait .splash-electron { animation: none; }
/* Reduce motion: the finished mark, a fade in and out. */
html.splash-still .splash-orbit, html.splash-still .splash-nucleus, html.splash-still .splash-name, html.splash-still .splash-park { animation: none; opacity: 1; stroke-dashoffset: 0; transform: none; }
html.splash-still .splash-flare { display: none; }
html.splash-still .splash-inner { animation: splash-fade-in 0.5s ease-out forwards; }
html.splash-still .splash.is-ending .splash-mark, html.splash-still .splash.is-ending .splash-name { animation: none; }
@keyframes splash-draw { to { stroke-dashoffset: 0; } }
@keyframes splash-pop { 0% { opacity: 0; transform: scale(0.3); } 60% { opacity: 1; } 100% { opacity: 1; transform: scale(1); } }
@keyframes splash-flare { 0% { opacity: 0; r: 0; } 30% { opacity: 0.55; } 100% { opacity: 0; r: 14; } }
@keyframes splash-rise { from { opacity: 0; transform: translateY(1.4em); } to { opacity: 1; transform: translateY(0); } }
@keyframes splash-leave { to { transform: translateY(-140%) scale(0.32); opacity: 0; } }
@keyframes splash-name-leave { to { opacity: 0; transform: translateY(-0.6em); } }
@keyframes splash-hide { to { opacity: 0; } }
@keyframes splash-fade-in { from { opacity: 0; } to { opacity: 1; } }
```

- [ ] **Step 4: `splash.js`**

`public/js/splash.js`:

```js
// The splash: the Atomix mark draws itself (the two orbits sketch in, the electron makes a lap, the play
// button pops in), the name rises, then it all lifts away. Built from the logo's own paths (MARK) in the
// theme's colours. It never blocks: the app boots behind it and it ends at the later of the animation or
// the boot. Any key, click or tap ends it early. Under Reduce motion it is a short fade of the finished mark.
import { MARK } from './dom.js';

const ANIMATION_MS = 2450; // the last thing (the name) has settled
const STILL_MS = 700; // reduced motion: fade in, hold a moment
const SKIP_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);
// The electron's orbit: MARK's ellipse (12.6 × 4.6, tilted -45°), starting at its resting spot top-right.
const LAP = 'M28.6 16A12.6 4.6 0 1 1 3.4 16A12.6 4.6 0 1 1 28.6 16';

let layer = null;
let finished = null; // resolves when the animation has run or was skipped
let gone = null; // resolves when the layer is hidden again
let resolveFinished;
let resolveGone;

const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

function build(name, still) {
  const { cx, cy, r } = MARK.electron;
  const electron = still
    ? `<circle class="splash-electron" cx="${cx}" cy="${cy}" r="${r}"/>`
    : `<g transform="rotate(-45 16 16)"><g transform="translate(28.6 16)"><circle class="splash-electron splash-park" r="${r}"/></g>
        <circle class="splash-electron" r="${r}" opacity="0"><set attributeName="opacity" to="1" begin="0.45s" fill="freeze"/>
        <animateMotion path="${LAP}" begin="0.45s" dur="1.3s" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.25 1"/></circle></g>`;
  return `<div class="splash-inner"><svg class="splash-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path class="splash-orbit one" pathLength="1" d="${MARK.orbits[0]}"/>
      <path class="splash-orbit two" pathLength="1" d="${MARK.orbits[1]}"/>
      ${still ? '' : '<circle class="splash-flare" cx="16.8" cy="16" r="0"/>'}
      <path class="splash-nucleus" d="${MARK.nucleus}"/>
      ${electron}
    </svg><div class="splash-name"></div></div>`;
}

/** Show the splash. Resolves when its animation has run its course (or a key ended it). */
export function showSplash({ name = 'Atomix' } = {}) {
  layer = document.getElementById('splash');
  if (!layer || finished) return finished || Promise.resolve();
  const still = stillMotion();
  document.documentElement.classList.toggle('splash-still', still);
  document.documentElement.classList.add('splash-on');
  layer.innerHTML = build(name, still);
  layer.querySelector('.splash-name').textContent = name;
  layer.hidden = false;
  for (const el of document.querySelectorAll('body > :not(#splash)')) el.inert = true;
  finished = new Promise((r) => (resolveFinished = r));
  gone = new Promise((r) => (resolveGone = r));
  const timer = setTimeout(resolveFinished, still ? STILL_MS : ANIMATION_MS);
  // Once the lap is over, keep the electron circling in case the boot is slow.
  const wait = setTimeout(() => {
    if (!layer.hidden && !still) {
      layer.classList.add('splash-wait');
      layer.querySelector('animateMotion')?.setAttribute('repeatCount', 'indefinite');
      layer.querySelector('animateMotion')?.beginElement();
    }
  }, 1800);
  const skip = (e) => {
    if (e.type === 'keydown' && SKIP_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    clearTimeout(wait);
    resolveFinished();
    endSplash({ quick: true });
  };
  window.addEventListener('keydown', skip, { capture: true });
  window.addEventListener('pointerdown', skip, { capture: true });
  finished.then(() => {
    window.removeEventListener('keydown', skip, { capture: true });
    window.removeEventListener('pointerdown', skip, { capture: true });
    clearTimeout(wait);
  });
  return finished;
}

/** Fade the splash out (the mark lifts away first unless `quick`). Safe to call more than once. */
export function endSplash({ quick = false } = {}) {
  if (!layer || layer.hidden || layer.classList.contains('is-ending')) return gone || Promise.resolve();
  const still = document.documentElement.classList.contains('splash-still');
  layer.classList.add('is-ending');
  const lift = quick || still ? 0 : 500;
  setTimeout(() => {
    layer.classList.add('is-leaving');
    setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
      layer.classList.remove('is-ending', 'is-leaving', 'splash-wait');
      for (const el of document.querySelectorAll('body > [inert]')) el.inert = false;
      document.documentElement.classList.remove('splash-on', 'splash-still');
      resolveGone?.();
    }, quick ? 200 : 400);
  }, lift);
  return gone;
}

/** Resolves once the splash has gone (at once when it never showed). */
export const splashDone = () => gone || Promise.resolve();
```

- [ ] **Step 5: Boot with the splash**

In `public/js/app.js`:

- Add the imports:

```js
import { readNote } from './gate.js';
import { showSplash, endSplash, splashDone } from './splash.js';
```

- In `boot()`, replace the block from `try {` / `[state.status, state.themes] = await Promise.all(…)` through `render();` at the end of the function with:

```js
  try {
    [state.status, state.themes] = await Promise.all([api.get('/api/status'), api.get('/api/themes')]);
  } catch (err) {
    main.append(h('div', { class: 'empty-state' }, h('h1', {}, "Can't reach the Atomix server"), h('p', {}, err.message)));
    return;
  }
  // A fresh open (no note in this tab) plays the splash while the rest of the boot happens behind it. Only when
  // signed in: the sign-in screen is not a moment for it. (The session cookie is HttpOnly, so this waits for
  // /api/status, which is one quick request; `main` is empty until then, so nothing shows before the splash.)
  const splashing = Boolean(state.status.user) && !readNote();
  const splash = splashing ? showSplash({ name: state.status.serverName || 'Atomix' }) : null;
  state.user = state.status.user;
  state.profile = state.status.profile;
  music.setProfile(state.profile);
  applyTheme();
  setTitle();
  if (state.user) {
    document.body.classList.add('signed-in');
    if (state.profile) {
      try {
        await refreshLibraries();
      } catch {
        /* handled by the 401/428 handlers */
      }
    }
  }
  window.addEventListener('hashchange', render);
  await render();
  if (splash) {
    await splash;
    await endSplash();
    // Focus goes where it would have gone without the splash (the picker's profile, Home's Play).
    if (isKeyboardMode()) focusFirst(main);
  }
```

  `render()` is already `async`; `boot()` now awaits it once so the page is there when the splash ends.

- [ ] **Step 6: Run the checks to see them pass**

Run: `node /home/claude/devtools/gate-ui.mjs splash 2>&1 | grep -E "PASS|FAIL"`
Expected: every line `PASS`, including `a reload shows no splash` (Task 2's `readNote()` is null until Task 4 writes the note, so this one FAILS for now: expected, and it is what Task 4 turns green. Everything else passes).

Then look at `/tmp/shots/orbit/gate-picker.png` with the Read tool: the picker, no splash remnants.

- [ ] **Step 7: The other suites still sign in**

Run: `node /home/claude/devtools/orbit-ui.mjs foundations shell 2>&1 | grep -c FAIL` → `0`.

- [ ] **Step 8: Checkpoint**

`npm test` → `# fail 0`. Files: `public/js/splash.js`, `public/index.html`, `public/css/app.css`, `public/js/app.js`, devtools `gate-ui.mjs`, `orbit-lib.mjs`.

---

## Stage 3 — The gate in the app

### Task 4: The note, the picker after idle, and playing as activity

**Files:**
- Modify: `public/js/gate.js` (activity listeners, the tick, `markPlaying`, `startGate`)
- Modify: `public/js/app.js` (boot decision, `onProfileSelected` writes the note and returns to the remembered address, sign-out/401 clear it)
- Modify: `public/js/views/profiles.js` (no change to the picker itself; the return address is handled in `app.js`)
- Modify: `public/js/views/player.js`, `public/js/music.js` (report playing)
- Modify: `/home/claude/devtools/gate-ui.mjs` (add the `gate` section)

**Interfaces:**
- Consumes: Task 2's note functions and `gateDecision`; `state.status.pickerIdleMinutes` (Task 1); `music.playing` (getter, `public/js/music.js`); the player's `<video>`.
- Produces (from `gate.js`):
  - `startGate({ idleMinutes, needsPicker, onPicker })`: installs the activity listeners and a 30 s tick; calls `onPicker()` once when the decision is `'picker'` and nothing is playing; `stopGate()` removes them.
  - `markPlaying(on: boolean)`: while any player says `true`, the note is touched every tick and the picker never appears. Counted, so video and music can overlap.
  - `setGateIdle(minutes)`: the tick uses the new value (for a changed setting).
  - `returnTo` (module state via `rememberReturn(hash)` / `takeReturn()`): the address to go back to after the picker.

- [ ] **Step 1: Write the failing checks**

In `gate-ui.mjs`, insert above the marker line:

```js
if (run('gate')) {
  const { page, context } = await freshTab();
  await page.waitForSelector('.picker-grid', { timeout: 6000 });
  await pickDallas(page);
  const note = await page.evaluate(() => JSON.parse(sessionStorage.getItem('atomix-gate') || 'null'));
  check('picking a profile writes the note', note && typeof note.profileId === 'number' && typeof note.lastActive === 'number', JSON.stringify(note));
  // A fake clock from here on: nothing is playing, so 30 minutes untouched brings the picker back.
  await page.clock.install({ time: Date.now() });
  await page.goto(`${base}/#/library/1`);
  await page.waitForSelector('.library-results');
  await page.clock.fastForward('29:00');
  await page.waitForTimeout(200);
  check('29 minutes: still on the page', (await page.$('.picker-grid')) === null);
  await page.mouse.move(600, 400); // activity resets the clock
  await page.clock.fastForward('20:00');
  await page.waitForTimeout(200);
  check('activity at 29 min: 20 more minutes is still not idle', (await page.$('.picker-grid')) === null);
  await page.clock.fastForward('31:00');
  await page.waitForSelector('.picker-grid', { timeout: 3000 });
  check('30 minutes untouched: the picker is back, without the splash', !(await splashShown(page)));
  check('…with the app still signed in', await page.evaluate(() => document.body.classList.contains('signed-in')));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  check('…and Back does not leave it', (await page.$('.picker-grid')) !== null);
  await page.click('.picker-profile:has-text("dallas")');
  await page.waitForSelector('dialog[open] .pin-input');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('cancelling the PIN keeps the picker on screen', (await page.$('.picker-grid')) !== null && (await page.$('dialog[open]')) === null);
  await pickDallas(page).catch(() => {}); // pickDallas waits for .home-view; here we expect the library instead
  await page.waitForSelector('.library-results', { timeout: 5000 });
  check('picking the same profile returns to where you were', /#\/library\/1$/.test(page.url()), page.url());
  // A PIN'd profile asks every time; a video playing holds the picker off.
  const show = await api(page, 'GET', '/api/items/4');
  await page.goto(`${base}/#/play/${show.nextEpisode.id}`);
  await page.waitForSelector('.player video');
  await page.waitForFunction(() => { const v = document.querySelector('.player video'); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 15000 });
  await page.clock.fastForward('45:00');
  await page.waitForTimeout(300);
  check('a playing video keeps the picker away', (await page.$('.picker-grid')) === null && (await page.evaluate(() => Boolean(document.querySelector('.player video')))));
  await page.evaluate(() => document.querySelector('.player video').pause());
  await page.clock.fastForward('31:00');
  await page.waitForSelector('.picker-grid', { timeout: 3000 });
  check('paused for 30 minutes: the picker comes back', true);
  await page.click('.picker-profile:has-text("dallas")');
  check('a PIN\'d profile asks for its PIN again', (await page.waitForSelector('dialog[open] .pin-input', { timeout: 2000 }).catch(() => null)) !== null);
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.detail-info', { timeout: 5000 });
  check("…and goes back to the show's page, not into the video", /#\/item\/4/.test(page.url()), page.url());
  // A dialog open when the picker is due: it closes, the picker shows on top of nothing.
  await page.goto(`${base}/#/settings/profile`);
  await page.waitForSelector('.theme-grid');
  await page.evaluate(async () => (await import('/js/components.js')).confirmDialog('A question', 'Still here?'));
  await page.waitForSelector('dialog[open]');
  await page.clock.fastForward('31:00');
  await page.waitForSelector('.picker-grid', { timeout: 3000 });
  check('a dialog left open is closed when the picker returns', (await page.$('dialog[open]')) === null);
  await pickDallas(page).catch(() => {});
  await page.waitForSelector('.theme-grid', { timeout: 5000 });
  // Music counts too.
  await page.goto(`${base}/#/item/15`);
  await page.waitForSelector('.tracks');
  await page.click('.detail-info .btn-primary');
  await page.waitForSelector('.mini:not([hidden])');
  await page.clock.fastForward('40:00');
  await page.waitForTimeout(300);
  check('music playing keeps the picker away', (await page.$('.picker-grid')) === null);
  await page.evaluate(async () => (await import('/js/music.js')).music.stop());
  // Signing out clears the note, so the next sign-in is a fresh open.
  await page.evaluate(async () => (await import('/js/app.js')).signOut());
  await page.waitForSelector('.auth-card');
  check('signing out clears the note', await page.evaluate(() => sessionStorage.getItem('atomix-gate') === null));
  // Without sessionStorage at all, every load is a fresh open and nothing breaks.
  const noStore = await context.newPage();
  await noStore.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } }));
  await noStore.goto(base);
  await noStore.fill('input[name=username]', 'dallas');
  await noStore.fill('input[name=password]', 'password123');
  await noStore.keyboard.press('Enter');
  await noStore.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  await noStore.keyboard.press('Escape');
  await noStore.waitForSelector('.picker-grid', { timeout: 5000 });
  await pickDallas(noStore);
  check('no sessionStorage: the app still works (every load is a fresh open)', (await noStore.$('.home-view')) !== null);
  await context.close();
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `node /home/claude/devtools/gate-ui.mjs gate 2>&1 | grep -E "PASS|FAIL|Error" | head`
Expected: `FAIL picking a profile writes the note` (null), then a timeout waiting for `.picker-grid` after 30 minutes.

- [ ] **Step 3: The gate's listeners and tick**

Append to `public/js/gate.js`:

```js
// ---- Activity, playing, and the tick ----
const ACTIVITY = ['keydown', 'pointermove', 'pointerdown', 'wheel', 'touchstart', 'scroll'];
const TICK_MS = 30_000;
let playing = 0;
let tick = null;
let idle = 30;
let picker = null;
let shown = false;
let returnTo = null;
const onActivity = () => touchNote();

/** Video or music is playing (counted, so both may overlap): the note is kept fresh and the picker held off. */
export function markPlaying(on) {
  playing = Math.max(0, playing + (on ? 1 : -1));
  if (on) touchNote();
}
export const isPlaying = () => playing > 0;

/** The address to go back to after the picker, and taking it (once). */
export function rememberReturn(hash) {
  returnTo = hash;
}
export function takeReturn() {
  const r = returnTo;
  returnTo = null;
  return r;
}

export function setGateIdle(minutes) {
  idle = Number(minutes) || 0;
}

/** Watch for idle time once a profile is on. `onPicker()` is called once when it is time to ask again. */
export function startGate({ idleMinutes, needsPicker, onPicker }) {
  stopGate();
  idle = Number(idleMinutes) || 0;
  picker = onPicker;
  shown = false;
  for (const ev of ACTIVITY) window.addEventListener(ev, onActivity, { passive: true, capture: true });
  tick = setInterval(() => {
    if (playing) return touchNote(Date.now(), { force: true }); // never stale while something plays
    if (shown) return;
    if (gateDecision({ note: readNote(), now: Date.now(), idleMinutes: idle, needsPicker }) === 'picker') {
      shown = true;
      picker?.();
    }
  }, TICK_MS);
}
export function stopGate() {
  for (const ev of ACTIVITY) window.removeEventListener(ev, onActivity, { capture: true });
  clearInterval(tick);
  tick = null;
}
```

  Change `touchNote` (from Task 2) so the tick can force a write past the 5 s limit:

```js
export function touchNote(now = Date.now(), { force = false } = {}) {
  if (!force && now - lastTouch < TOUCH_EVERY) return;
  lastTouch = now;
  const note = readNote();
  if (note) saveNote({ ...note, lastActive: now });
}
```

- [ ] **Step 4: Wire it into the app**

In `public/js/app.js`:

- Extend the imports:

```js
import { readNote, writeNote, clearNote, gateDecision, startGate, stopGate, rememberReturn, takeReturn, setGateIdle } from './gate.js';
```

- Add, after `export const isOrbit = …`:

```js
/** "Who's watching?" is needed when there is more than one profile or the only one has a PIN. */
const needsPicker = () => Boolean(state.status?.profileRequired) || state.status?.profileCount > 1 || Boolean(state.status?.profilePinned);
```

  and in `src/api/account.js`'s `/api/status`, after `profileRequired`, add what that needs:

```js
        profileCount: row ? core.profiles.list(row.id).length : 0,
        profilePinned: row ? core.profiles.list(row.id).some((p) => p.pin_hash) : false,
```

- Add a function that shows the picker over the current page:

```js
/** The picker comes back (after idle time): remember where we were, drop the client's profile, render. */
function askWhoIsWatching() {
  if (!state.user || !state.profile) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
  const { path } = parseHash();
  // From the player, go back to the title's page rather than restarting the video.
  const back = /^\/play\//.test(path) ? state.playingItemHash || '#/' : location.hash || '#/';
  rememberReturn(back);
  state.profile = null;
  music.setProfile(null);
  render();
}
```

  `state.playingItemHash` is set by the player (Step 5) to `#/item/<showId or movieId>`.

- In `boot()`, after `state.profile = state.status.profile;` and before `music.setProfile(state.profile);`, add:

```js
  // The gate: a fresh open or a stale note means "Who's watching?" first, even though the server session
  // still has a profile. The server keeps enforcing PINs; this only decides what this tab shows.
  if (state.user && state.profile) {
    const decision = gateDecision({ note: readNote(), now: Date.now(), idleMinutes: state.status.pickerIdleMinutes, needsPicker: needsPicker() });
    if (decision === 'splash+picker' || decision === 'picker') {
      rememberReturn(location.hash || '#/');
      state.profile = null;
    } else if (decision === 'splash' || (decision === 'nothing' && !readNote())) {
      writeNote(state.profile.id); // one PIN-less profile: it is the note from now on
    }
  }
```

- In `onProfileSelected`, replace the last three lines with:

```js
  writeNote(profile.id);
  startGate({ idleMinutes: state.status?.pickerIdleMinutes ?? 30, needsPicker: needsPicker(), onPicker: askWhoIsWatching });
  const back = takeReturn();
  const { path } = parseHash();
  if (back && back !== '#/profiles') navigate(back, { replace: true });
  else if (path === '/profiles') navigate('#/', { replace: true });
  else render();
```

- Also start the gate when the boot lands on a page with a profile already (decision `'nothing'` or `'splash'`): in `boot()`, right before `window.addEventListener('hashchange', render);`:

```js
  if (state.user && state.profile) startGate({ idleMinutes: state.status.pickerIdleMinutes, needsPicker: needsPicker(), onPicker: askWhoIsWatching });
```

- In `signOut()` and in the `setUnauthorizedHandler` callback, add `clearNote(); stopGate();` after `state.profile = null;`.

- In `render()`, the picker route already wins while `state.profile` is null. Make Back stay on it: in `onBackKey` (the `initNavigation({ onBack })` handler), add at the top:

```js
  if (!state.profile && state.user) return; // "Who's watching?" is not a page to go back from
```

- The Settings → Server save (Task 5) will call `setGateIdle(state.status.pickerIdleMinutes)`; export nothing more.

- [ ] **Step 5: Playing counts**

In `public/js/views/player.js`:

- Import: `import { markPlaying } from '../gate.js';` and, from app.js's import line, add `state`.
- After `video.addEventListener('play', updatePlayState);` add:

```js
  video.addEventListener('play', () => markPlaying(true));
  video.addEventListener('pause', () => markPlaying(false));
  video.addEventListener('ended', () => markPlaying(false));
```

- In `cleanupFn()`, add at the top: `if (!video.paused) markPlaying(false);` (leaving the player mid-play).
- Where the session's item is known (after `session` is loaded and `titleEl` is filled), set the return address: `state.playingItemHash = \`#/item/${session.show?.id || item.id}\`;` and in `cleanupFn()` `state.playingItemHash = null;`.

In `public/js/music.js`:

- Import: `import { markPlaying } from './gate.js';`
- In the existing `audio.addEventListener('play', …)` handler add `markPlaying(true);` and in the `'pause'` handler `markPlaying(false);`. Add `audio.addEventListener('ended', () => markPlaying(false));` next to them.

- [ ] **Step 6: Run the checks to see them pass**

Run: `node /home/claude/devtools/gate-ui.mjs gate splash 2>&1 | grep -E "PASS|FAIL"`
Expected: all `PASS`, now including `a reload shows no splash` from Task 3.

- [ ] **Step 7: Checkpoint**

`npm test` → `# fail 0`. `node /home/claude/devtools/orbit-ui.mjs 2>&1 | grep -c FAIL` → `0` (every section: the sign-in helper handles the splash; the gate's 30 s tick is idle in those runs). Files: `public/js/gate.js`, `public/js/app.js`, `public/js/views/player.js`, `public/js/music.js`, `src/api/account.js`, devtools `gate-ui.mjs`.

---

## Stage 4 — Settings, the older themes, docs, delivery

### Task 5: "Ask who's watching after" in Settings → Server

**Files:**
- Modify: `public/js/views/settings.js` (`serverTab`)
- Modify: `/home/claude/devtools/gate-ui.mjs` (add the `setting` section)

**Interfaces:**
- Consumes: `PUT /api/admin/settings { pickerIdleMinutes }` (Task 1); `setGateIdle()` (Task 4).

- [ ] **Step 1: Write the failing checks**

In `gate-ui.mjs`, above the marker:

```js
if (run('setting')) {
  const { page, context } = await freshTab();
  await page.waitForSelector('.picker-grid', { timeout: 6000 });
  await pickDallas(page);
  await page.goto(`${base}/#/settings/server`);
  await page.waitForSelector('.settings-content form');
  const sel = page.locator('select[name="pickerIdleMinutes"]');
  check('Settings → Server has "Ask who\'s watching after"', (await sel.count()) === 1 && /Ask who's watching after/.test(await page.textContent('.settings-content')));
  check('…with the five choices, 30 minutes chosen', (await sel.locator('option').allTextContents()).join('|') === '15 minutes|30 minutes|1 hour|4 hours|Never' && (await sel.inputValue()) === '30');
  check('…and a hint that playing counts', /Playing a video or music counts as being there/.test(await page.textContent('.settings-content')));
  await sel.selectOption('15');
  await page.click('.settings-content button[type=submit]');
  await page.waitForSelector('.toast');
  check('saving stores 15 minutes', (await api(page, 'GET', '/api/status')).pickerIdleMinutes === 15);
  // The running tab picks the new value up: 15 minutes untouched is now enough.
  await page.clock.install({ time: Date.now() });
  await page.goto(`${base}/#/`);
  await page.waitForSelector('.home-view');
  await page.clock.fastForward('16:00');
  await page.waitForSelector('.picker-grid', { timeout: 3000 });
  check('the new idle time applies without a reload', true);
  await pickDallas(page);
  await api(page, 'PUT', '/api/admin/settings', { pickerIdleMinutes: 30 });
  await context.close();
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `node /home/claude/devtools/gate-ui.mjs setting 2>&1 | grep -E "PASS|FAIL"`
Expected: `FAIL Settings → Server has …` (no such select).

- [ ] **Step 3: The control**

In `public/js/views/settings.js`, in `serverTab()`:

- After `const defaultQuality = select(…);` add:

```js
  const pickerIdle = select(
    [
      ['15', '15 minutes'],
      ['30', '30 minutes'],
      ['60', '1 hour'],
      ['240', '4 hours'],
      ['0', 'Never'],
    ],
    String(s.pickerIdleMinutes ?? 30),
  );
  pickerIdle.name = 'pickerIdleMinutes';
```

- In the first section of the form (the one with the server name and default theme), after the default theme field add:

```js
        field("Ask who's watching after", pickerIdle, 'How long Atomix can sit untouched before it asks again. Playing a video or music counts as being there.'),
```

- In the PUT body add `pickerIdleMinutes: Number(pickerIdle.value),` and after `state.status = await api.get('/api/status');` add `setGateIdle(state.status.pickerIdleMinutes);` with `setGateIdle` imported from `'../gate.js'`.

- [ ] **Step 4: Run the checks to see them pass**

Run: `node /home/claude/devtools/gate-ui.mjs setting 2>&1 | grep -E "PASS|FAIL"` → all `PASS`.

- [ ] **Step 5: Checkpoint**

`npm test` → `# fail 0`. `node /home/claude/devtools/settings-check.mjs 2>&1 | grep -c FAIL` → `0`. Files: `public/js/views/settings.js`, devtools `gate-ui.mjs`.

---

### Task 6: The older themes are unchanged; every suite still passes

**Files:**
- Modify: `/home/claude/devtools/gate-ui.mjs` (add the `themes` section)
- Modify, only for a real regression: the app file at fault

- [ ] **Step 1: Write the check**

In `gate-ui.mjs`, above the marker:

```js
if (run('themes')) {
  // In an older theme the splash plays in that theme's colours, and Home afterwards is what a load without the
  // splash shows (the layer leaves nothing behind).
  const { page, context } = await freshTab({ reducedMotion: 'reduce' });
  await page.waitForSelector('.picker-grid', { timeout: 6000 });
  await pickDallas(page);
  await setPrefs(page, { theme: 'arctic' });
  await page.evaluate(() => sessionStorage.removeItem('atomix-gate'));
  await page.goto(`${base}/#/`);
  await page.reload();
  await page.waitForSelector('#splash:not([hidden])', { timeout: 3000 });
  const colours = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('splash')); return { bg: s.backgroundColor, ink: s.color, layout: document.body.dataset.layout }; });
  check('Arctic: the splash uses Arctic\'s background and accent', colours.layout === 'top' && colours.bg !== 'rgba(0, 0, 0, 0)' && colours.ink !== 'rgb(255, 255, 255)', JSON.stringify(colours));
  await page.waitForSelector('#splash[hidden]', { timeout: 5000 });
  await page.waitForSelector('.picker-grid');
  await pickDallas(page);
  await page.mouse.move(1919, 1079);
  await page.waitForTimeout(1500);
  const withSplash = await page.screenshot();
  await page.reload();
  await page.waitForSelector('.home-view');
  await page.mouse.move(1919, 1079);
  await page.waitForTimeout(1500);
  const without = await page.screenshot();
  check('Arctic Home is identical after the splash and without it', Buffer.compare(withSplash, without) === 0);
  await setPrefs(page, { theme: null });
  await context.close();
}
```

  Home's hero is random, so if the two pictures differ, compare them with `/tmp/orbit-baseline/hero.json` pinned as `oldthemes-compare.mjs` does (a `page.route('**/api/home', …)` that replaces `hero`), and keep that route in the check.

- [ ] **Step 2: Run it**

Run: `node /home/claude/devtools/gate-ui.mjs themes 2>&1 | grep -E "PASS|FAIL"` → all `PASS`. On a FAIL of the identical-picture check, look at both pictures (save them to `/tmp/shots/orbit/`) and find what the splash left behind (an `inert`, a class on `html`, a stray element); fix it in `splash.js`.

- [ ] **Step 3: Every suite**

```bash
cd /home/claude/devtools
node oldthemes-compare.mjs compare 2>&1 | tail -1          # all pages match
for f in orbit-ui.mjs orbit-a11y.mjs regress.mjs extras-ui.mjs rebrand-ui.mjs music-ui.mjs music-kbd.mjs profiles-ui.mjs dialogs.mjs settings-check.mjs; do
  echo "=== $f"; node $f 2>&1 | grep -cE "^FAIL|TimeoutError"
done
```

Expected: `all pages match`, and `0` for every suite. `profiles-ui.mjs` and `dialogs.mjs` sign in with their own helpers (`pastPicker`), which wait for `.rows, .picker-grid`; the splash comes first now, so change those helpers to press `Escape` once when `#splash:not([hidden])` is present, exactly as `orbit-lib.mjs`'s `signIn` does. `oldthemes-compare.mjs` signs in the same way: add the same two lines.

- [ ] **Step 4: Checkpoint**

`npm test` → `# fail 0`. Files: devtools `gate-ui.mjs` (+ helper edits in `profiles-ui.mjs`, `dialogs.mjs`, `oldthemes-compare.mjs`), plus any app fix from Step 2 (listed in the summary).

---

### Task 7: Docs, version 0.7.1, delivery to Dallas's PC

**Files:**
- Modify: `package.json`, `docs/ARCHITECTURE.md`, `README.md`
- Deliver: every changed file (Tasks 1–6, plus this plan and the spec) to `D:\Nodeflix`

- [ ] **Step 1: Version**

`package.json`: `"version": "0.7.1",`. `rebrand-ui.mjs` reads the version from `package.json`, so it needs no change.

- [ ] **Step 2: `docs/ARCHITECTURE.md`**

In the "Web client" section, after the paragraph that ends "Orbit's pages scroll inside the window (`main`), not the document.", add:

```markdown
`gate.js` decides what a page load shows, the way a TV app does: each tab keeps a note in `sessionStorage`
(`{ profileId, lastActive }`). No note is a fresh open: `splash.js` plays the Orbit animation (the logo's own
paths, in the theme's colours) while the app boots behind it, then "Who's watching?" follows when the account has
more than one profile or a PIN. A fresh note (a reload) shows neither. Once a note is older than the server's
`pickerIdleMinutes` (Settings → Server, default 30; 0 = never) with nothing playing, the picker comes back over
the page and picking a profile returns to it. The server session is untouched: PINs and library access are
enforced there as before; the gate only decides what this tab shows. The decision is a pure function, tested in
`test/gate.test.js`.
```

- [ ] **Step 3: `README.md`**

In the "**Orbit look**" bullet list, add a sub-bullet after "Reduce effects":

```markdown
  - Opening Atomix plays a short animated splash, then asks **who's watching**; it asks again after the TV has sat untouched for a while (an admin sets how long), and a profile with a PIN always asks for it.
```

In Troubleshooting, add:

```markdown
- **"Who's watching?" keeps coming back** — it returns after the idle time in **Settings → Server → Ask who's watching after**; choose a longer time or Never. Playing a video or music counts as being there.
```

- [ ] **Step 4: Final verification**

```bash
cd /home/claude/nodeflix && npm test 2>&1 | tail -4
/home/claude/devtools/restart-dev.sh
node /home/claude/devtools/gate-ui.mjs 2>&1 | tail -3
node /home/claude/devtools/orbit-ui.mjs 2>&1 | tail -2
node /home/claude/devtools/oldthemes-compare.mjs compare 2>&1 | tail -1
```

Expected: `# fail 0`; `gate-ui` and `orbit-ui` no FAIL, exit 0; `all pages match`.

- [ ] **Step 5: A picture of the splash for Dallas**

```bash
cd /home/claude/devtools && cat > splash-shots.mjs <<'EOF'
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const b = await pw.chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
await page.goto('http://127.0.0.1:8787/');
await page.fill('input[name=username]', 'dallas');
await page.fill('input[name=password]', 'password123');
await page.keyboard.press('Enter');
await page.waitForSelector('#splash:not([hidden])');
for (const t of [400, 900, 1400, 2000]) { await page.waitForTimeout(t === 400 ? 400 : 500); await page.screenshot({ path: `/tmp/shots/orbit/splash-${t}.png` }); }
await b.close();
EOF
node splash-shots.mjs && ls /tmp/shots/orbit/splash-*.png
```

Look at each with the Read tool: the orbits drawing, the electron on its lap, the play button in, the name under the mark.

- [ ] **Step 6: Deliver to Dallas's PC (controller)**

1. Copy every changed or new repository file into `/mnt/user-data/outputs/Atomix/<same path>`.
2. Confirm none of those files changed on the PC since the last delivery (hash them with `device_bash`, compare with the pre-plan copies), then write them to `D:\Nodeflix\<same path>` with `device_commit_files`.
3. On the PC: `cd $HOME/mnt/Nodeflix && npm test 2>&1 | tail -4` → `# fail 0`.
4. `git --no-optional-locks status --short`. Don't commit.

- [ ] **Step 7: Project note and wrap-up (controller)**

- Update `claude/build-status.md`: a "Round 8 (30 Sep): splash and Who's watching (v0.7.1)" decision line with the four choices Dallas made (Orbit concept A; on open + after idle; 30 min admin-set; PIN every time; the browser remembers), and an "Added in v0.7.1" section.
- Send Dallas the splash pictures and the picker picture, with a short summary, the rulings and any deferred minors.

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 The gate (note, decision, boot, picking, idle timer, playing, sign-out, two screens) | Tasks 2, 4 |
| §2 The splash (first paint, the animation, never blocks, skipping, reduce motion, where not, accessibility, focus) | Task 3 |
| §3 The setting | Tasks 1, 5 |
| §4 Testing (Node, browser) | Tasks 1–6 |
| Out of scope | none needed |

**Interfaces checked:** `gateDecision` signature is the same in Tasks 2 and 4; `showSplash/endSplash/splashDone` in Tasks 3 and 4; `startGate/stopGate/markPlaying/setGateIdle/rememberReturn/takeReturn` in Tasks 4 and 5; `/api/status.pickerIdleMinutes` in Tasks 1, 4, 5; `profileCount`/`profilePinned` added to `/api/status` in Task 4 and used by `needsPicker()` there.

**One thing the plan decides that the spec left open:** `needsPicker()` needs the profile count and whether any has a PIN before the profile list is fetched, so Task 4 adds `profileCount` and `profilePinned` to `/api/status` (two cheap queries the server already knows how to do). The alternative, fetching `/api/profiles` at boot, would delay the first render.

**Checked by eye only:** the feel of the animation on a TV (pictures at four moments in Task 7), and the electron lap's easing.
