# Orbit on desktops, tablets and phones (v0.8.0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit loses its rounded floating window on every size, Home's first row always fits, and Settings works on phones and upright tablets.

**Architecture:** All CSS: `public/css/orbit.css` (Orbit's structure) and `themes/orbit/theme.css` (its look; two Settings rules become wide-only). `main` stays the fixed scroll box but with `inset: 0` and a left padding that keeps the rail clear. The checks live in a rewritten `devtools/orbit-sizes.mjs` (five sizes) plus edits to `devtools/orbit-ui.mjs` where it measured the window.

**Tech Stack:** Plain CSS (no build step); Playwright at `/home/claude/.npm-global/lib/node_modules/playwright/index.js` against the dev server on :8787 (`/home/claude/devtools/restart-dev.sh`); Node ≥ 22.13 for `npm test`.

**Spec:** `docs/superpowers/specs/2026-10-01-atomix-orbit-sizes-design.md`

## Global Constraints

- Wide = `(min-width: 1000px) and (orientation: landscape)` (`FRAME_QUERY`); narrow = everything else. `--px` unchanged.
- The rail: `--win-l` stays 168 × `--px` on TVs (≥1600px) and becomes **112px** on laptops (1000–1599px). The page's text edge is `--win-l + 16 × --px` from the screen edge; ≥ 40 px right of the pill.
- Only Orbit changes: the six older themes must stay pixel-identical (`oldthemes-compare.mjs compare` → "all pages match").
- No git in the cloud copy; Dallas commits on his PC. "Commit" steps below mean: note the task done in the ledger.
- Never `pkill -f`; the dev server restarts with `restart-dev.sh`.
- The environment stays on the sign-in, setup and "Who's watching?" screens.

## Review Focus

1. A 1000–1200 px laptop with a tall browser (e.g. 1024 × 1300 portrait-ish but landscape by ratio): the spotlight clamp's lower bound (360 × `--px`) must still leave the hero's buttons visible — Task 3 checks the Play button is inside the spotlight at 1024 × 768.
2. A phone with the mini-player pill showing: the Save button and the dock and the pill must not overlap — Task 5 checks Save's box is above both the dock's and the pill's.
3. Wide screens with the menu open (`html.menu-open`) and the page dimmed: the rail padding must not move when the menu grows to 300 × `--px` — Task 2 checks `main`'s padding-left is the same before and after opening the menu.
4. A library with many posters at tablet-landscape: the last column must not run under the right screen edge — Task 5 checks every card's `right` ≤ `innerWidth`.
5. Reduce effects / no `backdrop-filter`: with no window there is no frame to soften; the backdrop's gradients alone must keep the hero text readable — Task 2 checks the spotlight title's contrast (via `contrastOf`) ≥ 3:1 on Home at 1920 × 1080 with `reduceEffects: true`.

---

### Task 1: The sizes harness, red

**Files:**
- Rewrite: `/home/claude/devtools/orbit-sizes.mjs` (replaces the v0.7.0 picture script; also absorbs `orbit-survey.mjs` and `orbit-proto.mjs`, which are deleted in Task 6)

**Interfaces:**
- Produces: `node /home/claude/devtools/orbit-sizes.mjs [shell|home|settings|dock]` printing `PASS`/`FAIL` lines and exiting 1 on any FAIL; pictures in `/tmp/shots/sizes/<size>-<page>.png`. Helpers `at(size)`, `pageAt(size, hash, sel)`, `rectOf(page, sel)`.

- [ ] **Step 1: Write the harness with the `shell` section's checks (they fail today)**

```js
// Orbit at every size (v0.8.0): desktop, laptop, tablet both ways, phone. Dev server: restart-dev.sh.
//   node /home/claude/devtools/orbit-sizes.mjs [shell|home|settings|dock]
import { open, signIn, go, check, failed, setPrefs, contrastOf } from './orbit-lib.mjs';

const SIZES = { desktop: [1917, 992], laptop: [1280, 800], 'tablet-land': [1024, 768], 'tablet-port': [820, 1180], phone: [390, 844] };
const WIDE = ['desktop', 'laptop', 'tablet-land'];
const only = process.argv.slice(2);
const run = (name) => !only.length || only.includes(name);
const rectOf = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null; }, sel);
const errors = [];

/** One browser per size; signs in as dallas. */
async function at(size) {
  const [width, height] = SIZES[size];
  const o = await open({ width, height });
  o.page.on('pageerror', (e) => errors.push(`${size}: ${e.message}`));
  await signIn(o.page);
  return o;
}
async function pageAt(page, size, name, hash, sel) {
  await go(page, hash, sel);
  await page.screenshot({ path: `/tmp/shots/sizes/${size}-${name}.png` });
  const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth <= innerWidth, main: (document.getElementById('main')?.scrollWidth || 0) <= (document.getElementById('main')?.clientWidth || 0) + 1 }));
  check(`${size} ${name}: no sideways overflow`, over.doc && over.main, JSON.stringify(over));
}

if (run('shell')) {
  for (const size of WIDE) {
    const { browser, page } = await at(size);
    await pageAt(page, size, 'home', '#/', '.home-view');
    await page.waitForTimeout(600);
    const [w, h] = SIZES[size];
    const main = await rectOf(page, 'main');
    check(`${size}: the page fills the screen`, main.x === 0 && main.y === 0 && main.w === w && main.h === h, JSON.stringify(main));
    check(`${size}: no round corners`, (await page.evaluate(() => getComputedStyle(document.querySelector('main')).borderTopLeftRadius)) === '0px');
    const back = await rectOf(page, '.backdrop');
    check(`${size}: the artwork fills the screen too`, back.x === 0 && back.y === 0 && back.w === w && back.h === h, JSON.stringify(back));
    check(`${size}: no environment behind a page`, (await page.evaluate(() => getComputedStyle(document.querySelector('.environment')).display)) === 'none');
    const menu = await rectOf(page, '.orbit-menu');
    const text = await rectOf(page, '.spot-title');
    check(`${size}: the text edge clears the menu pill by 40 px`, text.x - menu.right >= 40, `pill right ${menu.right}, text x ${text.x}`);
    // Opening the menu (the remote's Left from the leftmost control) must not move the page.
    const padBefore = await page.evaluate(() => getComputedStyle(document.querySelector('main')).paddingLeft);
    await page.evaluate(() => document.documentElement.classList.add('menu-open'));
    await page.waitForTimeout(300);
    check(`${size}: an open menu does not shift the page`, (await page.evaluate(() => getComputedStyle(document.querySelector('main')).paddingLeft)) === padBefore);
    await page.evaluate(() => document.documentElement.classList.remove('menu-open'));
    await pageAt(page, size, 'library', '#/library/1', '.library-results');
    await pageAt(page, size, 'show', '#/item/4', '.episode-row');
    await browser.close();
  }
  // The environment is still the glow behind "Who's watching?".
  const { browser, page } = await at('desktop');
  await page.goto('http://127.0.0.1:8787/#/profiles');
  await page.waitForSelector('.picker-grid');
  check('desktop: the environment still glows behind the picker', (await page.evaluate(() => getComputedStyle(document.querySelector('.environment')).display)) === 'block');
  // Reduce effects: no glass anywhere, and the hero title still reads on the bare artwork.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '#/', '.home-view');
  await setPrefs(page, { reduceEffects: true });
  await go(page, '#/', '.spot-title');
  const ratio = await contrastOf(page, '.spot-title');
  check('reduce effects: the hero title reads on the bare artwork (≥ 3:1)', ratio != null && ratio >= 3, String(ratio));
  await setPrefs(page, { reduceEffects: null });
  await browser.close();
}

// ---- more sections are added above this line by later tasks ----

check('no page errors', errors.length === 0, errors.join(' | '));
process.exit(failed() ? 1 : 0);
```

- [ ] **Step 2: Run it and read the failures**

Run: `mkdir -p /tmp/shots/sizes && cd /home/claude/nodeflix && (curl -s -o /dev/null http://127.0.0.1:8787/api/health || /home/claude/devtools/restart-dev.sh) && node /home/claude/devtools/orbit-sizes.mjs shell 2>&1 | grep -v '^PASS'`
Expected: FAIL for "the page fills the screen" (main at 168/40 on desktop), "no round corners" (44px / 32px), "the artwork fills the screen too", "no environment behind a page" (display block) on all three wide sizes; the picker and reduce-effects checks may PASS or FAIL (they are pinned in Task 2).

- [ ] **Step 3: Commit (ledger)**

`Task 1: complete (harness written, shell section red as expected)`

---

### Task 2: The shell without a window

**Files:**
- Modify: `public/css/orbit.css:19-45` (window vars, `main`, `.backdrop`), `:47-52` (environment), `:99-102` (cluster), `:224-229` (mini)
- Modify: `/home/claude/devtools/orbit-ui.mjs:62-70, 100-124, 153-155` (window checks)

**Interfaces:**
- Consumes: Task 1's `orbit-sizes.mjs shell`.
- Produces: `--win-l` = 168 × `--px` (TV) / 112px (laptop); `main { inset: 0; padding-left: calc(var(--win-l) - var(--gutter) + 16 * var(--px)) }` on wide screens; `--win-radius`, `--win-t/r/b` removed.

- [ ] **Step 1: Replace the window block in `orbit.css`**

Replace lines 19–43 (from `/* ---------- The window` through the closing `}` of the backdrop rule) with:

```css
/* ---------- The rail: the page fills the screen; the menu floats in a rail on the left (TVs 168, laptops 112) ---------- */
html[data-layout="orbit"] {
  --win-l: 0px; /* the rail's width; 0 on phones and portrait screens (their menu is a dock) */
  --menu-w: calc(88 * var(--px));
  --menu-open-w: calc(300 * var(--px));
}
@media (min-width: 1000px) and (orientation: landscape) {
  html[data-layout="orbit"] { --win-l: 112px; }
}
@media (min-width: 1600px) and (orientation: landscape) {
  html[data-layout="orbit"] { --win-l: calc(168 * var(--px)); }
}
body[data-layout="orbit"] { --gutter: calc(96 * var(--px)); --header-h: 0px; }
@media (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"][data-view="page"] { overflow: hidden; }
  /* main is still the scroll box (rows keep their selected card in view with scroll-padding); its left padding
     keeps the rail clear, so the page's text edge is --win-l + 16px from the screen edge. */
  body[data-layout="orbit"][data-view="page"] main {
    position: fixed; inset: 0; padding-left: calc(var(--win-l) - var(--gutter) + 16 * var(--px));
    min-height: 0; overflow: hidden auto; overscroll-behavior: contain; scrollbar-width: none;
    scroll-padding: calc(128 * var(--px)) 0 calc(48 * var(--px));
  }
  body[data-layout="orbit"][data-view="page"] main::-webkit-scrollbar { display: none; }
  /* The crisp artwork fills the screen, under the page. */
  body[data-layout="orbit"][data-view="page"] .backdrop { inset: 0; }
  /* Nothing shows round the page any more; the environment stays for the sign-in and profile screens. */
  html[data-layout="orbit"] body[data-view="page"] .environment { display: none; }
}
```

- [ ] **Step 2: Fix the cluster and the mini-player offsets (they used `--win-t/r/b`)**

In `orbit.css` line ~100: `top: calc(var(--win-t) + 36 * var(--px)); right: calc(var(--win-r) + 52 * var(--px));` → `top: calc(36 * var(--px)); right: calc(52 * var(--px));`.
Line ~225: `right: calc(var(--win-r) + 40 * var(--px)); bottom: calc(var(--win-b) + 36 * var(--px));` → `right: calc(40 * var(--px)); bottom: calc(36 * var(--px));`.
Then `grep -n "win-t\|win-r\|win-b\|win-radius" public/css/orbit.css themes/orbit/theme.css` must print nothing.

- [ ] **Step 3: Run the sizes harness**

Run: `node /home/claude/devtools/orbit-sizes.mjs shell 2>&1 | grep -v '^PASS'`
Expected: nothing but the count line, i.e. no FAIL. If "the text edge clears the menu pill" fails on laptop, the rail is too narrow: check `--win-l` is 112px there (pill spans 24.5–87.5, text at 128).

- [ ] **Step 4: Update `orbit-ui.mjs`'s window checks**

Line 66: `check('the page floats in a window', …)` → `check('the page fills the screen', win.x === 0 && win.y === 0 && win.w === 1920 && win.h === 1080, JSON.stringify(win));`
Line 67: `'…with round corners' … === '44px'` → `check('…with no rounding', (await style(page, 'main', 'borderTopLeftRadius')) === '0px');`
Line 68: keep (`the artwork fills the window` — the backdrop rect equals main's, still true) but rename to `'the artwork fills the screen'`.
Line 69: `check('the environment shows the artwork, blurred', …)` → `check('no environment behind a page', (await style(page, '.environment', 'display')) === 'none');`
Line 70 (`the menu rests beside the window`): unchanged (menu.x === 40, w 88).
Line 103: `check('no artwork: the environment is empty', …)` → delete the line (the environment is hidden behind pages now).
Line 104: rename `'no artwork: the window is still a solid panel'` → `'no artwork: the page is still a solid panel'` (same assertion).
Line 118: `check('laptop: a slimmer frame', lap.x === 100 …)` → `check('laptop: the page fills the screen', lap.x === 0 && lap.y === 0 && lap.w === 1280 && lap.h === 800, JSON.stringify(lap));`
Line 119: `'laptop: smaller corners' … '32px'` → `const lapMenu = await rect(page, '.orbit-menu'); check('laptop: the menu sits in a 112px rail', Math.abs(lapMenu.x - 24.3) < 1, JSON.stringify(lapMenu));` (`--px` is 0.72 at 1280 wide → the menu is 63.36 wide → x = (112 − 63.36) / 2 = 24.32).
Lines 153–155: unchanged (`main` is still `position: fixed`; `env` is only recorded).
Line 602 and 623: unchanged (the environment still shows on the picker and sign-in).

- [ ] **Step 5: Run orbit-ui's shell section and then the whole suite**

Run: `node /home/claude/devtools/orbit-ui.mjs shell 2>&1 | grep -v '^PASS'` then `node /home/claude/devtools/orbit-ui.mjs > /tmp/orbit-ui.log 2>&1; grep -c '^PASS' /tmp/orbit-ui.log; grep '^FAIL' /tmp/orbit-ui.log`
Expected: shell section clean; whole suite 158 PASS (159 minus the deleted line 103), 0 FAIL. A FAIL in a title check that reads `main`'s rect (lines 301, 381) means the rail padding changed the text's right edge — read the assertion; those compare against `main`'s right, which is now the screen's right, so they should hold.

- [ ] **Step 6: Commit (ledger)**

`Task 2: complete (orbit-sizes shell green; orbit-ui 158/158)`

---

### Task 3: Home's spotlight on short windows

**Files:**
- Modify: `public/css/orbit.css:145-147` (the `--spot-h` rules)
- Modify: `/home/claude/devtools/orbit-sizes.mjs` (add the `home` section)

- [ ] **Step 1: Add the `home` section to the harness (red)**

Insert above `// ---- more sections are added above this line ----`:

```js
if (run('home')) {
  // A desktop browser is shorter than a TV: the spotlight gives up height so the first row is whole.
  for (const size of ['desktop', 'tablet-land']) {
    const { browser, page } = await at(size);
    await pageAt(page, size, 'home-rows', '#/', '.home-view .row');
    const r = await page.evaluate(() => {
      const main = document.querySelector('main').getBoundingClientRect();
      const first = document.querySelector('.home-rows .row');
      const card = first.querySelector('.card');
      const meta = card.querySelector('.card-meta') || card;
      const cr = card.getBoundingClientRect(); const mr = meta.getBoundingClientRect();
      const heading = first.querySelector('h2, .row-title')?.getBoundingClientRect();
      const second = document.querySelectorAll('.home-rows .row')[1]?.querySelector('h2, .row-title')?.getBoundingClientRect();
      const play = document.querySelector('.spot-actions .btn')?.getBoundingClientRect();
      const spot = document.querySelector('.spotlight').getBoundingClientRect();
      return { cardIn: cr.bottom <= main.bottom && mr.bottom <= main.bottom, headingIn: heading && heading.top >= 0, secondPeeks: !second || second.top < main.bottom, playIn: play && play.bottom <= spot.bottom, spotH: spot.height };
    });
    check(`${size}: the first row is whole (cards and captions inside the page)`, r.cardIn && r.headingIn, JSON.stringify(r));
    check(`${size}: the next row's heading peeks in below`, r.secondPeeks, JSON.stringify(r));
    check(`${size}: the hero's buttons stay inside the spotlight`, r.playIn, JSON.stringify(r));
    await browser.close();
  }
  // At 1080p nothing changes: the spotlight is still 600px.
  const { browser, page } = await at('desktop');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '#/', '.home-view');
  const h = await page.evaluate(() => document.querySelector('.spotlight').getBoundingClientRect().height);
  check('1080p: the spotlight is still 600px', Math.abs(h - 600) < 1, String(h));
  await browser.close();
}
```

If the first row's cards are `.card` with a `.card-meta` caption and the heading is `h2` — confirm with `grep -n "class: 'row\|row-title\|card-meta" public/js/views/home.js public/js/components.js | head` before running, and adjust the selectors to what the DOM has.

- [ ] **Step 2: Run it**

Run: `node /home/claude/devtools/orbit-sizes.mjs home 2>&1 | grep -v '^PASS'`
Expected: FAIL "desktop: the first row is whole" (the poster/wide card's caption bottom is past `main`'s bottom at 992 tall); 1080p PASS.

- [ ] **Step 3: Clamp the spotlight**

`orbit.css` line 146: `--spot-h: calc(600 * var(--px));` → `--spot-h: clamp(calc(360 * var(--px)), calc(100vh - 440 * var(--px)), calc(600 * var(--px)));` (the compact rule on line 147 stays `calc(340 * var(--px))`).

- [ ] **Step 4: Run it again**

Run: `node /home/claude/devtools/orbit-sizes.mjs home 2>&1 | grep -v '^PASS'`
Expected: no FAIL. If "the hero's buttons stay inside the spotlight" fails at tablet-land (768 tall → clamp gives 360 × 0.72 = 259px… no: `--px` at 1024 wide is 0.72 (the floor), so the clamp's floor is 259px and `100vh − 440 × 0.72` = 451px → 451), the spotlight is 451px there and the buttons fit; if they don't, raise the floor to `calc(420 * var(--px))` and record the ruling.

- [ ] **Step 5: Commit (ledger)**

`Task 3: complete (orbit-sizes home green)`

---

### Task 4: Settings on narrow screens

**Files:**
- Modify: `themes/orbit/theme.css:433-439` (scope to wide), `:443` (theme grid)
- Modify: `public/css/orbit.css:110-132` (add narrow Settings rules)
- Modify: `/home/claude/devtools/orbit-sizes.mjs` (add the `settings` section)

- [ ] **Step 1: Add the `settings` section (red)**

```js
if (run('settings')) {
  for (const size of ['phone', 'tablet-port']) {
    const { browser, page } = await at(size);
    await pageAt(page, size, 'settings-server', '#/settings/server', 'form .panel');
    const tabs = await page.$$eval('.settings-tab', (els) => els.map((e) => e.getBoundingClientRect().top));
    check(`${size}: the settings sections are a row of chips`, tabs.length >= 5 && tabs.every((t) => Math.abs(t - tabs[0]) < 1), JSON.stringify(tabs));
    const panel = await rectOf(page, '.settings-content');
    check(`${size}: the panel is full width`, panel.w >= SIZES[size][0] - 48, JSON.stringify(panel));
    const save = await rectOf(page, '.sticky-actions .btn');
    const dock = await rectOf(page, '.orbit-menu');
    check(`${size}: Save sits above the dock`, save && dock && save.bottom <= dock.y, JSON.stringify({ save, dock }));
    await pageAt(page, size, 'settings-profile', '#/settings', '.theme-grid');
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.theme-grid')).gridTemplateColumns.split(' ').length);
    check(`${size}: theme cards ${size === 'phone' ? '2' : '3 or more'} across`, size === 'phone' ? cols === 2 : cols >= 3, String(cols));
    await browser.close();
  }
  // Wide screens keep the side list.
  const { browser, page } = await at('laptop');
  await pageAt(page, 'laptop', 'settings-server', '#/settings/server', 'form .panel');
  const tabs = await page.$$eval('.settings-tab', (els) => els.map((e) => e.getBoundingClientRect().left));
  check('laptop: the settings sections are still a side list', tabs.every((l) => Math.abs(l - tabs[0]) < 1));
  await browser.close();
}
```

- [ ] **Step 2: Run it**

Run: `node /home/claude/devtools/orbit-sizes.mjs settings 2>&1 | grep -v '^PASS'`
Expected: FAIL on phone and tablet-port for the chip row (tabs stacked), full width (panel ~200px), Save above the dock, and the theme columns (3 / 7); laptop PASS.

- [ ] **Step 3: Scope Orbit's Settings rules to wide screens**

In `themes/orbit/theme.css`, wrap lines 433–434 (`.settings-layout { grid-template-columns: … }` and `.settings-tabs { gap …; top: 0; }`) in `@media (min-width: 1000px) and (orientation: landscape) { … }`. Lines 435–439 (`.settings-tab` looks, `.settings-content` max-width) stay global. Change line 443 to:

```css
.theme-grid { grid-template-columns: repeat(auto-fill, minmax(max(150px, calc(230 * var(--px))), 1fr)); gap: calc(18 * var(--px)); }
```

(`230 × 0.4px` = 92px narrow, so the `max(150px, …)` gives 2 columns at 390 − 40 px and 4 at 820 − 40 px.)

- [ ] **Step 4: Add the narrow Settings rules to `orbit.css`**

Inside the narrow block (after line 131, before its closing `}`):

```css
  /* Settings: the sections are a row of chips you can swipe, the panel is full width, Save clears the dock. */
  body[data-layout="orbit"] .settings-layout { grid-template-columns: 1fr; gap: 16px; }
  body[data-layout="orbit"] .settings-tabs { position: static; flex-direction: row; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 calc(-1 * var(--gutter)); padding: 4px var(--gutter); }
  body[data-layout="orbit"] .settings-tabs::-webkit-scrollbar { display: none; }
  body[data-layout="orbit"] .settings-tab { flex: none; min-height: 40px; padding: 0 14px; }
  body[data-layout="orbit"] .settings-tab[aria-current="page"] { box-shadow: none; }
  body[data-layout="orbit"] .settings-content { max-width: none; }
  body[data-layout="orbit"] .sticky-actions { bottom: calc(96px + env(safe-area-inset-bottom)); }
```

- [ ] **Step 5: Run it again**

Run: `node /home/claude/devtools/orbit-sizes.mjs settings 2>&1 | grep -v '^PASS'`
Expected: no FAIL. If "Save sits above the dock" still fails, the sticky bottom needs the dock's real height: measure `.orbit-menu` (48px links + 16px padding + 14px offset = 78px) and set `bottom: calc(92px + env(safe-area-inset-bottom))`; record the ruling.

- [ ] **Step 6: Commit (ledger)**

`Task 4: complete (orbit-sizes settings green)`

---

### Task 5: Room for the dock, the library grid

**Files:**
- Modify: `public/css/orbit.css:113` (main's bottom padding narrow), `:135-141` (grid gap)
- Modify: `/home/claude/devtools/orbit-sizes.mjs` (add the `dock` section)

- [ ] **Step 1: Add the `dock` section (red)**

```js
if (run('dock')) {
  const { browser, page } = await at('phone');
  for (const [name, hash, sel] of [['library', '#/library/1', '.library-results'], ['show', '#/item/4', '.episode-row'], ['settings-server', '#/settings/server', 'form .panel']]) {
    await pageAt(page, 'phone', `dock-${name}`, hash, sel);
    const r = await page.evaluate(() => {
      const els = [...document.querySelectorAll('main a[href], main button, main input, main select')].filter((e) => !e.disabled && e.getBoundingClientRect().height > 0);
      const last = els[els.length - 1];
      last.scrollIntoView({ block: 'end' });
      const lr = last.getBoundingClientRect(); const dock = document.querySelector('.orbit-menu').getBoundingClientRect();
      return { lastBottom: lr.bottom, dockTop: dock.y, clear: lr.bottom <= dock.y };
    });
    check(`phone ${name}: the last control can be scrolled clear of the dock`, r.clear, JSON.stringify(r));
  }
  // With the mini-player showing, Save sits above the pill as well as the dock.
  await go(page, '#/item/15', '.tracks');
  await page.click('.detail-info .btn-primary');
  await page.waitForSelector('.mini:not([hidden])');
  await page.evaluate(() => { location.hash = '#/settings/server'; });
  await page.waitForSelector('form .panel');
  await page.waitForTimeout(400);
  const save = await rectOf(page, '.sticky-actions .btn'); const mini = await rectOf(page, '.mini');
  check('phone with music playing: Save sits above the mini-player pill', save.bottom <= mini.y, JSON.stringify({ save, mini }));
  await page.evaluate(async () => (await import('/js/music.js')).music.stop());
  await browser.close();
  // Tablet-landscape library: the posters keep to the gutter and none runs under the right edge.
  const t = await at('tablet-land');
  await pageAt(t.page, 'tablet-land', 'grid', '#/library/1', '.grid-poster .card');
  const g = await t.page.evaluate(() => { const cards = [...document.querySelectorAll('.grid-poster .card')].map((c) => c.getBoundingClientRect()); const gap = parseFloat(getComputedStyle(document.querySelector('.grid-poster')).columnGap); return { inside: cards.every((c) => c.right <= innerWidth), gap }; });
  check('tablet-land: every poster is inside the screen', g.inside, JSON.stringify(g));
  check('tablet-land: the poster grid gap is 20 × --px', Math.abs(g.gap - 20 * 0.72) < 0.6, String(g.gap));
  await t.browser.close();
}
```

- [ ] **Step 2: Run it**

Run: `node /home/claude/devtools/orbit-sizes.mjs dock 2>&1 | grep -v '^PASS'`
Expected: FAIL on the grid gap (it is the theme's 24 × `--px` = 17.28); the dock clearance checks may pass already at 96px on some pages — read which fail; "Save above the mini-player pill" likely fails (the pill sits at 80px + dock).

- [ ] **Step 3: The CSS**

`orbit.css` line 113: `padding-bottom: calc(96px + env(safe-area-inset-bottom));` → `calc(110px + env(safe-area-inset-bottom))`.
In the narrow block, after the `.sticky-actions` rule from Task 4, add: `html.has-mini body[data-layout="orbit"] .sticky-actions { bottom: calc(190px + env(safe-area-inset-bottom)); }`.
After line 141 (`.grid-landscape`), add: `body[data-layout="orbit"] :is(.grid-poster, .grid-square, .grid-landscape) { column-gap: calc(20 * var(--px)); }`.

- [ ] **Step 4: Run it again, then the older-theme comparison (the grid gap must be Orbit-only)**

Run: `node /home/claude/devtools/orbit-sizes.mjs dock 2>&1 | grep -v '^PASS'` then `node /home/claude/devtools/oldthemes-compare.mjs compare 2>&1 | tail -2`
Expected: no FAIL; "all pages match".

- [ ] **Step 5: Commit (ledger)**

`Task 5: complete (orbit-sizes dock green; older themes match)`

---

### Task 6: Docs, version, verification and delivery

**Files:**
- Modify: `package.json` (0.8.0), `README.md:17`, `themes/orbit/theme.json:3`, `docs/ARCHITECTURE.md` (the Orbit paragraph)
- Delete: `/home/claude/devtools/orbit-survey.mjs`, `/home/claude/devtools/orbit-proto.mjs`

- [ ] **Step 1: Words**

README line 17: "Your artwork fills the screen and the page floats over it in a rounded window, with a glass menu beside it that grows when the remote reaches it." → "Your artwork fills the screen behind the page, with a glass menu floating beside it that grows when the remote reaches it."
`themes/orbit/theme.json` description: "The default. Your artwork fills the screen and the page floats over it in a rounded window, with a glass menu beside it. Made for a TV and a remote." → "The default. Your artwork fills the screen behind the page, with a glass menu floating beside it. Made for a TV and a remote."
`docs/ARCHITECTURE.md`: find the Orbit paragraph (`grep -n "orbit" docs/ARCHITECTURE.md`) and replace any sentence describing the rounded window / `main` inset with: "`main` is a fixed, full-screen scroll box whose left padding keeps the menu's rail clear (168 × `--px` on TVs, 112 px on laptops); the artwork fills the screen beneath it. Phones and portrait screens use the document scroll and a dock." Also note: "Home's spotlight gives up height on short windows (a desktop browser) so the first row is always whole; on narrow screens Settings' sections are a swipeable chip row."
`package.json`: `"version": "0.8.0"`.
The theme-card description check in `orbit-ui.mjs` (grep `"rounded window"` there) — if any check quotes the old description, update it to the new one.

- [ ] **Step 2: Full verification**

Run, in order, saving logs under the scratchpad:
`npm test 2>&1 | grep -E '^# (pass|fail)'` → 174 pass, 0 fail.
`node /home/claude/devtools/orbit-sizes.mjs > sizes.log 2>&1; grep -c ^PASS sizes.log; grep ^FAIL sizes.log` → 0 FAIL (twice).
`node /home/claude/devtools/orbit-ui.mjs > ui.log 2>&1; grep -c ^PASS ui.log; grep ^FAIL ui.log` → 158, 0.
`node /home/claude/devtools/orbit-a11y.mjs > a11y.log 2>&1; grep -c ^PASS a11y.log; grep ^FAIL a11y.log` → 53, 0.
`node /home/claude/devtools/oldthemes-compare.mjs compare | tail -1` → all pages match.
`node /home/claude/devtools/gate-ui.mjs > gate.log 2>&1; grep -c ^PASS gate.log` → 60 (the splash pictures the themes section compares are Home in Arctic, unaffected).
Expected: every line as stated. Anything else is a defect to debug (superpowers:systematic-debugging), not a number to adjust.

- [ ] **Step 3: Pictures for Dallas**

The sizes harness saved `/tmp/shots/sizes/*.png`; build two contact sheets with PIL as in the survey (desktop + laptop + tablet-land Home/library/show; phone + tablet-port Settings) into `/mnt/user-data/outputs/orbit-progress/v080-wide.png` and `v080-narrow.png`, and look at both before sending.

- [ ] **Step 4: Delivery**

Hash the PC copies of every changed file against the pre-task snapshot (as in v0.7.2: `tr -d '\r' | sha256sum` on the PC vs `sha256sum` here); if all match, copy the changed files to `/mnt/user-data/outputs/Atomix/<path>` and commit them to `D:\Nodeflix` with `device_commit_files`; run `npm test` on the PC (174/174). Update the project note `claude/build-status.md` (Round 10 / v0.8.0). Delete `orbit-survey.mjs` and `orbit-proto.mjs`.

- [ ] **Step 5: Commit (ledger)**

`Task 6: complete (delivered; PC npm test 174/174)`
