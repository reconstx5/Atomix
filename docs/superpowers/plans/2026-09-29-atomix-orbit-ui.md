# Atomix "Orbit" look (v0.7.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Atomix a look of its own, "Orbit": the page floats in a rounded window over its artwork, a glass menu floats beside it for the remote, Sora type, white for whatever the remote is on, glass controls. It becomes the default theme; the six older themes stay exactly as they are.

**Architecture:** A third layout, `orbit`, joins `top` and `side`. The structure (window, environment, floating menu, dock, side panel, where things sit and how big they are) lives in a new `public/css/orbit.css` scoped to `html[data-layout="orbit"]` / `body[data-layout="orbit"]`. The look (colours, glass, type, selection) lives in `themes/orbit/theme.css`. Client code branches on the layout only where the markup has to differ (the menu, the episode row, the "…" menu, a few player extras); everything else is CSS. Rules that need no page (menu keys, Back on Home, how artwork is cropped) sit in `public/js/orbit-rules.js` and are tested in Node.

**Tech Stack:** Node ≥ 22.13 with zero npm dependencies (node:http, node:sqlite, node:test); plain ES-module browser JavaScript with no build step; CSS custom properties; Playwright, installed in the cloud workspace only, for the browser checks in `/home/claude/devtools`.

**Spec:** `docs/superpowers/specs/2026-09-29-atomix-orbit-ui-design.md` (approved by Dallas). The mockups are the "Atomix redesign" canvas. Its board files are in the cloud workspace at `/tmp/claude-0/-home-claude/8bc10209-2aa9-5a8a-8d5c-99df538b4e2a/scratchpad/canvas/project/<Board>.dc.html`: `NavLeft` (resting menu), `ShellMenu` (menu open), `ShellLaptop`, `ShellPhone`, `Foundations`, `HomeRows`, `ShowPage`, `AlbumPage`, `PlayerScrub`, `PlayerMoments`, `PlayerSubs`, `LibraryGrid`, `Profiles`, `SettingsProfile`. Board sizes are pixels at 1920×1080. This plan writes them as `calc(N * var(--px))`, so the same numbers scale to laptops.

## Decisions this plan makes

These go beyond the spec. Tell Dallas about them at plan review.

1. **Where the structural CSS lives.** The spec puts it in `public/css/app.css`. This plan puts it in its own file, `public/css/orbit.css`, linked right after `app.css`. The effect is the same; `app.css` is already 928 lines.
2. **PIN entry** is one large glass field, not four boxes. PINs can be 4 to 8 digits (`src/profiles.js`), so four fixed boxes would not fit longer ones.
3. **Add-ons and Settings on phones** become two small round buttons beside the profile picture at the top. The spec says "under the profile picture"; a pop-up there would be a new component.
4. **Kids profiles** see the same menu entries as today: Add-ons only when the profile allows it, and the Settings entry labelled "Profile". The spec says "no Add-ons or Settings (as today)", but today's code does show Profile.
5. **Orbit-only changes.** Anything that would change how an older theme looks is Orbit-only: the "…" menu, the episode row, From the start on show pages, the player clock and "Ends at" in the control bar, and Up next's picture and ring.
   - Shared by all themes: the "Keep watching" rename, the Reduce effects switch, and the new hints under Reduce motion, Reduce effects and Skip intros in Settings.
   - Also shared: the remote's Back closes an open dialog, focus goes back to Subtitles/Audio/Quality when a player menu closes, and Right/Left move between the two Up next buttons.
6. **Laptop text** never goes below 12px. At 0.72× scale, a 16px caption would be 11.5px.
7. **Rows follow the selection.** Moving Left or Right along a row scrolls it so the selected card sits at the left (Orbit only). This is the spec's "the selected card stays near the left".

## Global Constraints

- Node ≥ 22.13. Zero npm dependencies. No build step. Plain ES modules in the browser.
- No Kodi code is copied, and the Arctic skins (CC BY-NC) are inspiration only.
- Sora (SIL OFL 1.1) ships in `public/fonts/` with its licence as `OFL-sora.txt`: latin and latin-ext, weights 400/500/600/700. No Google Fonts or other network fonts.
- **Colour:**
  - Backgrounds: deep space `#05050C` behind everything; window shade `#04040E` at 92% for the darkest scrim.
  - Text: white, soft text 86% white, captions 66% white.
  - Accent is `--tint`, falling back to the profile's accent colour, then to ice `#8FE9FF`. It is used for progress bars, the line above a title, the current-page dot, the season underline, switch tracks and glows, and never for the selection.
- **Glass:**
  - Clear glass: `rgba(255,255,255,.14)`, blur 24px, saturate 1.6, 1px inner hairline at 24%.
  - Tinted glass: `rgba(28,28,42,.5–.66)`, blur 30–40px, hairline 16%, top highlight 22%, soft shadow.
  - Reduce effects, and browsers without `backdrop-filter`, get `rgba(24,24,36,.94)` and no blur anywhere.
- **Selection** (white means "the remote is here"):
  - The item grows: buttons 1.05, cards 1.08, avatars 1.1.
  - It gets a ring `0 0 0 5px <background>, 0 0 0 9px #fff` plus a lift shadow.
  - Menu and list rows become a white pill with dark text.
- **Shape:** window radius 44 on TV and 32 on laptop; cards 18; buttons and pills fully round; tags 7.
- **Motion:** selection 180ms ease-out; artwork cross-fade 600ms; page change slides 24px and fades over 240ms; menu grows over 220ms. Reduced motion (system setting or profile) means no scaling, sliding or cross-fades.
- **Window:**
  - TV (landscape, ≥ 1600px wide): inset 40/40/40/168 px.
  - Laptop (landscape, 1000–1599px): inset 20/20/20/100 px.
  - Phone (< 1000px wide or portrait): no frame, and a dock instead of the menu.
- **Type at 1080p:** display 116/700 at −0.045em; page title 56–100/700; section 26/600; body 22/400; meta 20/500; caption 16/500. Laptop scale 0.72× (12px floor, decision 6); phone 0.4× with a 16px minimum.
- **Blur** only on floating surfaces: menu, clock cluster, dialogs and sheets, player bar, side panel, mini-player, toasts, and the few buttons on top of the artwork. Never on anything inside scrolling rows, grids, panels or lists.
- **Accessibility:** text contrast 4.5:1 on its real background; the selection ring 3:1 (the dark gap guarantees it); everything reachable with arrows, OK and Back; icon-only buttons labelled.
- **Copy:** sentence case, plain verbs, the app's own names ("All genres", "Starting in N s"). "Keep watching" replaces "Cancel" in Up next.
- **The six older themes look the same as before.** Task 1 takes the pictures and Task 15 compares them.
- **Processes:** never use `pkill -f`. Restart the dev server with `/home/claude/devtools/restart-dev.sh`, which kills by PID.
- **No git commits in the cloud copy.** `/home/claude/nodeflix` is not a repository; Dallas commits and pushes from `D:\Nodeflix` himself. Each task ends with a checkpoint, and the files reach his PC in Task 17.

## Review Focus

These are the inputs the spec implies but no feature test would naturally exercise, most likely to bite first. Each one has a check in the task named.

1. **Many libraries, or long library names.** The floating menu must stay on screen and scroll, and names must end in "…". Test in Task 5.
2. **A page with no artwork** (Settings, Search, a title without fanart). The window must still be a solid dark panel with readable text, and the environment empty rather than showing the last title. Test in Task 5.
3. **Left where it must not open the menu:** inside a text field (moves the cursor), on a slider (seeks), inside a dialog (stays in it), and from a card that has another card to its left (moves along the row). Tests in Tasks 6 and 12.
4. **Very long titles.** Sora is wider than the condensed faces, so the big title must stop at two lines and captions must end in "…" instead of breaking the window. Test in Task 7.
5. **Switching themes while running.** Orbit to an older theme and back from Settings, without a reload: the right menu is built, the window frame comes and goes, and nothing is left behind. Test in Task 5.

## Files

New:

| File | Responsibility |
| --- | --- |
| `public/js/orbit-rules.js` | Pure rules, no DOM: menu keys, menu steps, Back on Home, artwork crop, the frame media query |
| `public/js/shell.js` | Builds Orbit's navigation: the mark, the floating menu (a dock on phones), the clock and profile cluster |
| `public/css/orbit.css` | Orbit layout structure (sizes, positions) under `html/body[data-layout="orbit"]` |
| `themes/orbit/theme.json`, `themes/orbit/theme.css` | The Orbit theme: its look |
| `public/fonts/sora-latin-{400,500,600,700}.woff2`, `public/fonts/sora-latin-ext-{400,500,600,700}.woff2`, `public/fonts/OFL-sora.txt` | Sora and its licence |
| `test/orbit-rules.test.js` | Node tests for `orbit-rules.js` |
| `test/cards.test.js` | Node tests for wide-card captions |
| `/home/claude/devtools/orbit-lib.mjs`, `orbit-ui.mjs`, `orbit-a11y.mjs`, `cmp-server.mjs`, `oldthemes-compare.mjs` | Browser checks (cloud only, like the existing `regress.mjs`) |

Modified: `src/themes.js`, `src/db.js`, `src/settings.js`, `src/api/account.js`, `public/index.html`, `public/css/app.css`, `public/js/app.js`, `public/js/nav.js`, `public/js/backdrop.js`, `public/js/components.js`, `public/js/music.js`, `public/js/views/home.js`, `public/js/views/item.js`, `public/js/views/player.js`, `public/js/views/settings.js`, `test/themes.test.js`, `test/api.test.js`, `test/extras-settings.test.js`, `docs/THEMES.md`, `docs/ARCHITECTURE.md`, `README.md`, `package.json`, `/home/claude/devtools/extras-ui.mjs`.

## How to run things

- Unit and API tests: `cd /home/claude/nodeflix && npm test` (151 pass before this plan starts).
- Dev server: `/home/claude/devtools/restart-dev.sh`. It serves http://127.0.0.1:8787 with the data in `/tmp/nf-dev`. The account is `dallas` / `password123`, PIN `4321`.
  - Media: Movies (library 1), TV Shows (library 2) and Music (library 3).
  - Useful items: The Test Movie (id 3), Demo Show (id 4), Theme Show (id 28, which has intros and credits) and the album Night Ferry (id 15).
  - Restart it after any change under `src/` or `themes/*/theme.json`. Browser files only need a reload.
- Orbit browser checks: `node /home/claude/devtools/orbit-ui.mjs [section …]`. With no sections it runs all of them. Screenshots go to `/tmp/shots/orbit/`.

---

## Stage 1 — Foundations

### Task 1: Pictures of the six older themes, before anything changes

These are the "before" half of the promise that older themes don't change. They are taken from a frozen copy of the dev data, so later playback in the dev server can't change what's on screen.

**Files:**
- Create: `/home/claude/devtools/cmp-server.mjs`
- Create: `/home/claude/devtools/oldthemes-compare.mjs`
- Create (data): `/tmp/orbit-baseline-data/` (a copy of `/tmp/nf-dev`)

**Interfaces:**
- Produces: `node /home/claude/devtools/oldthemes-compare.mjs save|compare`.
  - `save` writes `/tmp/orbit-baseline/<theme>-<page>.png`.
  - `compare` writes `/tmp/orbit-cmp/<theme>-<page>.png` and a `-diff.png` next to any picture that differs, then exits 1 if any page differs by more than 0.2% of its pixels. Task 15 runs `compare`.

- [ ] **Step 1: Freeze a copy of the dev data**

```bash
rm -rf /tmp/orbit-baseline-data && mkdir -p /tmp/orbit-baseline-data
node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync('/tmp/nf-dev/atomix.db').exec(\"VACUUM INTO '/tmp/orbit-baseline-data/atomix.db'\")"
for d in images cache previews subtitles plugin-data; do [ -d /tmp/nf-dev/$d ] && cp -r /tmp/nf-dev/$d /tmp/orbit-baseline-data/; done
ls /tmp/orbit-baseline-data
```

Expected: `atomix.db` plus the artwork folders. `VACUUM INTO` makes a clean copy even while the dev server has the database open.

- [ ] **Step 2: Write the second-server launcher**

`/home/claude/devtools/cmp-server.mjs`:

```js
// A second Atomix for picture comparisons: its own data folder and port, no scans and no
// background jobs, so nothing on screen changes between runs.
//   node cmp-server.mjs <data folder> [port]
const [, , dataDir, port = '8788'] = process.argv;
process.env.ATOMIX_DATA_DIR = dataDir;
const { createApp } = await import('/home/claude/nodeflix/src/app.js');
const app = await createApp({ port: Number(port), host: '127.0.0.1', skipStartupScan: true, backgroundTasks: false, logLevel: 'error' });
await app.start();
console.log('ready');
```

- [ ] **Step 3: Write the comparison script**

`/home/claude/devtools/oldthemes-compare.mjs`:

```js
// The six older themes at TV size, from a frozen copy of the dev data (/tmp/orbit-baseline-data).
//   node oldthemes-compare.mjs save      → /tmp/orbit-baseline/<theme>-<page>.png (before Orbit)
//   node oldthemes-compare.mjs compare   → /tmp/orbit-cmp/…, plus <name>-diff.png where they differ
// Each run starts from a fresh copy of the frozen data on port 8788, with the clock fixed and
// the random "Something different" row switched off, so the only thing that can change is the code.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';

const mode = process.argv[2];
if (!['save', 'compare'].includes(mode)) throw new Error('usage: node oldthemes-compare.mjs save|compare');
const OUT = mode === 'save' ? '/tmp/orbit-baseline' : '/tmp/orbit-cmp';
const DATA = '/tmp/orbit-cmp-data';
fs.rmSync(DATA, { recursive: true, force: true });
fs.cpSync('/tmp/orbit-baseline-data', DATA, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['--disable-warning=ExperimentalWarning', '/home/claude/devtools/cmp-server.mjs', DATA, '8788'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('ready') && resolve());
  server.on('exit', (code) => reject(new Error(`comparison server exited (${code})`)));
});
const base = 'http://127.0.0.1:8788';
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-09-29T21:41:00'));
const api = (method, path, body) =>
  page.evaluate(async ([m, p, b]) => (await fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), [method, path, body]);

await page.goto(base);
await page.fill('input[name=username]', 'dallas');
await page.fill('input[name=password]', 'password123');
await page.keyboard.press('Enter');
await page.waitForSelector('.picker-grid');
await page.click('.picker-profile:has-text("dallas")');
await page.waitForSelector('dialog[open] .pin-input');
await page.keyboard.type('4321');
await page.keyboard.press('Enter');
await page.waitForSelector('.view');
await api('POST', '/api/admin/plugins/random-picks/enabled', { enabled: false });

const THEMES = ['arctic', 'arctic-side', 'midnight', 'harbour', 'daylight', 'obsidian'];
const PAGES = { home: '#/', movie: '#/item/3', show: '#/item/4', album: '#/item/15', library: '#/library/1' };
for (const theme of THEMES) {
  await api('PATCH', '/api/me', { prefs: { theme } });
  for (const [name, hash] of Object.entries(PAGES)) {
    await page.goto(`${base}/${hash}`);
    await page.reload();
    await page.waitForSelector('.view');
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(1919, 1079);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${theme}-${name}.png` });
  }
}

let failed = 0;
if (mode === 'compare') {
  for (const file of fs.readdirSync('/tmp/orbit-baseline').filter((f) => f.endsWith('.png'))) {
    const before = fs.readFileSync(`/tmp/orbit-baseline/${file}`).toString('base64');
    const after = fs.readFileSync(`${OUT}/${file}`).toString('base64');
    const result = await page.evaluate(async ([a, b]) => {
      const load = async (data) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return { c, ctx, px: ctx.getImageData(0, 0, c.width, c.height) };
      };
      const [x, y] = [await load(a), await load(b)];
      let diff = 0;
      const out = y.ctx.createImageData(y.c.width, y.c.height);
      for (let i = 0; i < x.px.data.length; i += 4) {
        const d = Math.max(...[0, 1, 2].map((k) => Math.abs(x.px.data[i + k] - y.px.data[i + k])));
        if (d > 16) diff++;
        out.data.set(d > 16 ? [255, 0, 80, 255] : [x.px.data[i] / 3, x.px.data[i + 1] / 3, x.px.data[i + 2] / 3, 255], i);
      }
      y.ctx.putImageData(out, 0, 0);
      return { share: diff / (x.px.data.length / 4), png: y.c.toDataURL('image/png').split(',')[1] };
    }, [before, after]);
    const ok = result.share <= 0.002;
    if (!ok) {
      failed++;
      fs.writeFileSync(`${OUT}/${file.replace('.png', '-diff.png')}`, Buffer.from(result.png, 'base64'));
    }
    console.log(`${ok ? 'SAME' : 'DIFF'} ${file} ${(result.share * 100).toFixed(3)}%`);
  }
}
await browser.close();
server.kill();
console.log(mode === 'save' ? `saved ${fs.readdirSync(OUT).length} pictures in ${OUT}` : failed ? `${failed} pages differ` : 'all pages match');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 4: Take the "before" pictures**

Run: `node /home/claude/devtools/oldthemes-compare.mjs save`
Expected: `saved 30 pictures in /tmp/orbit-baseline`

- [ ] **Step 5: Prove the method is stable (unchanged code must compare equal)**

Run: `node /home/claude/devtools/oldthemes-compare.mjs compare`
Expected: 30 lines of `SAME …` and `all pages match`. If a page differs with no code change, open its `-diff.png` and remove the cause (wait longer, or hide the moving thing) before going on. A comparison that isn't stable proves nothing later.

- [ ] **Step 6: Checkpoint**

Nothing in the repository changed. Note in the task summary that `/tmp/orbit-baseline/` exists (30 pictures).

---

### Task 2: Orbit on the server: layout, default, migration 8, Reduce effects, Sora

**Files:**
- Modify: `src/themes.js:27`
- Modify: `src/db.js:245-252` (add migration 8 after migration 7)
- Modify: `src/settings.js:6`
- Modify: `src/api/account.js:11-21`
- Modify: `public/js/app.js:42-43`
- Create: `themes/orbit/theme.json`, `themes/orbit/theme.css` (a stub for now; Task 3 fills it in)
- Create: `public/fonts/sora-latin-400.woff2` … `sora-latin-ext-700.woff2` (8 files), `public/fonts/OFL-sora.txt`
- Test: `test/themes.test.js`, `test/api.test.js:241-264`, `test/extras-settings.test.js`

**Interfaces:**
- Produces:
  - `GET /api/themes` lists `{ id: 'orbit', layout: 'orbit', … }`; any theme's `layout` is `'top' | 'side' | 'orbit'`.
  - `GET /api/status` gives `defaultTheme: 'orbit'` on a fresh install.
  - `PATCH /api/me { prefs: { reduceEffects: boolean | null } }` saves it (`null` clears it).
  - The fonts are served at `/fonts/sora-latin-<weight>.woff2`, `/fonts/sora-latin-ext-<weight>.woff2` and `/fonts/OFL-sora.txt`.

- [ ] **Step 1: Write the failing tests**

In `test/themes.test.js`:
- Change the top comment's first line to `// Default-theme upgrades (Midnight → Arctic in migration 4, Arctic → Orbit in migration 8)` and keep the second line.
- Change the first test's `const db = openDatabase(file);` to `const db = openDatabase(file, { upTo: 4 });`, so it keeps testing migration 4 alone.
- Add `import fs from 'node:fs';` and `import { Themes } from '../src/themes.js';` to the imports.
- Append these tests:

```js
test('migration 8: a server default of Arctic becomes Orbit; profile choices stay', () => {
  const file = path.join(tempDir(), 'v7.db');
  const old = openDatabase(file, { upTo: 7 });
  old.run(`INSERT INTO settings (key, value) VALUES ('defaultTheme', '"arctic"')`);
  old.run(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'u', 'x', 'admin', 1)`);
  old.run(`INSERT INTO profiles (id, user_id, name, is_primary, created_at, prefs) VALUES (1, 1, 'A', 1, 1, '{"theme":"arctic"}')`);
  old.close();
  const db = openDatabase(file);
  assert.equal(db.get('PRAGMA user_version').user_version, 8);
  assert.equal(JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'defaultTheme'`).value), 'orbit');
  assert.deepEqual(JSON.parse(db.get('SELECT prefs FROM profiles WHERE id = 1').prefs), { theme: 'arctic' }, 'someone who picked Arctic keeps it');
  db.close();
});

test('migration 8 leaves any other server default alone', () => {
  for (const theme of ['arctic-side', 'midnight']) {
    const file = path.join(tempDir(), `v7-${theme}.db`);
    const old = openDatabase(file, { upTo: 7 });
    old.run(`INSERT INTO settings (key, value) VALUES ('defaultTheme', ?)`, JSON.stringify(theme));
    old.close();
    const db = openDatabase(file);
    assert.equal(JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'defaultTheme'`).value), theme);
    db.close();
  }
});

test('themes can use the orbit layout; unknown layouts get the top menu', () => {
  const dir = tempDir();
  for (const [id, layout] of [['a', 'orbit'], ['b', 'side'], ['c', 'sideways'], ['d', undefined]]) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'theme.json'), JSON.stringify({ name: id, layout }));
  }
  const layouts = Object.fromEntries(new Themes({ themesDir: dir }).list().map((t) => [t.id, t.layout]));
  assert.deepEqual(layouts, { a: 'orbit', b: 'side', c: 'top', d: 'top' });
});
```

In `test/api.test.js`, replace lines 250–259 (from the `for (const id of ['arctic', …` line through the `OFL.txt` line) with:

```js
  for (const id of ['orbit', 'arctic', 'arctic-side', 'midnight', 'harbour', 'daylight', 'obsidian']) assert.ok(themes.includes(id), id);
  // Orbit is the default look: the page in a floating window with a glass menu (its own layout).
  assert.equal((await call('GET', '/api/status')).data.defaultTheme, 'orbit');
  assert.equal(themeList.find((t) => t.id === 'orbit').layout, 'orbit');
  assert.equal(themeList.find((t) => t.id === 'arctic').layout, 'top');
  assert.equal(themeList.find((t) => t.id === 'arctic-side').layout, 'side');
  // The typefaces ship with Atomix (no internet needed), with their licences alongside.
  for (const f of ['roboto-condensed-latin.woff2', 'sora-latin-400.woff2', 'sora-latin-ext-700.woff2']) {
    const font = await fetch(base + '/fonts/' + f);
    assert.equal(font.status, 200, f);
    assert.equal(font.headers.get('content-type'), 'font/woff2', f);
  }
  for (const f of ['OFL.txt', 'OFL-sora.txt']) assert.equal((await fetch(base + '/fonts/' + f)).status, 200, f);
```

In `test/extras-settings.test.js`, append:

```js
test('each profile can turn on Reduce effects', async () => {
  let r = await admin.patch('/api/me', { prefs: { reduceEffects: true } });
  assert.equal(r.data.profile.prefs.reduceEffects, true);
  r = await admin.patch('/api/me', { prefs: { reduceEffects: 0 } });
  assert.equal(r.data.profile.prefs.reduceEffects, false);
  r = await admin.patch('/api/me', { prefs: { reduceEffects: null } });
  assert.equal('reduceEffects' in r.data.profile.prefs, false, 'null clears it');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd /home/claude/nodeflix && npm test 2>&1 | tail -30`
Expected failures:
- `user_version` 7 ≠ 8, and `'arctic'` ≠ `'orbit'` (migration 8 test);
- `{ a: 'top' … }` (layout test);
- the api test on `'orbit'` missing;
- `reduceEffects` undefined.

Everything else passes.

- [ ] **Step 3: Implement the server side**

`src/themes.js` line 27:

```js
          layout: ['side', 'orbit'].includes(t.layout) ? t.layout : 'top',
```

`src/db.js`, after migration 7's string (before the closing `];` of `MIGRATIONS`):

```js
  // 8: the Orbit look replaces Arctic as the server default, as migration 4 did for Midnight.
  //    A theme a person picked for their own profile is left alone.
  `
  UPDATE settings SET value = '"orbit"' WHERE key = 'defaultTheme' AND value = '"arctic"';
  `,
```

`src/settings.js` line 6: `  defaultTheme: 'orbit',`

`src/api/account.js`, in `PREF_KEYS`, after `reduceMotion: 'boolean',`:

```js
  reduceEffects: 'boolean',
```

`public/js/app.js` lines 42–43:

```js
  const themeId = prefs.theme || state.status?.defaultTheme || 'orbit';
  const theme = state.themes.find((t) => t.id === themeId) || state.themes.find((t) => t.id === 'orbit') || state.themes[0];
```

- [ ] **Step 4: Add the theme and the fonts**

`themes/orbit/theme.json`:

```json
{
  "name": "Orbit",
  "description": "The default. Your artwork fills the screen and the page floats over it in a rounded window, with a glass menu beside it. Made for a TV and a remote.",
  "author": "Atomix",
  "layout": "orbit",
  "colorScheme": "dark",
  "preview": { "background": "#05050c", "surface": "#1c1c2a", "accent": "#8fe9ff" }
}
```

`themes/orbit/theme.css` (a stub; Task 3 replaces it):

```css
/* Orbit — Atomix's default look. Filled in by the v0.7.0 build (see docs/superpowers/plans/2026-09-29-atomix-orbit-ui.md). */
```

Fonts (from the `@fontsource/sora` 5.3.0 package already installed in `/home/claude/atomix-design`; the files are Google's Sora, SIL OFL 1.1):

```bash
SRC=/home/claude/atomix-design/node_modules/@fontsource/sora
for w in 400 500 600 700; do
  cp $SRC/files/sora-latin-$w-normal.woff2 /home/claude/nodeflix/public/fonts/sora-latin-$w.woff2
  cp $SRC/files/sora-latin-ext-$w-normal.woff2 /home/claude/nodeflix/public/fonts/sora-latin-ext-$w.woff2
done
cp $SRC/LICENSE /home/claude/nodeflix/public/fonts/OFL-sora.txt
head -3 /home/claude/nodeflix/public/fonts/OFL-sora.txt
ls -la /home/claude/nodeflix/public/fonts/sora-*
```

Expected: the licence starts with `Copyright 2019 The Sora Project Authors`, and there are 8 font files of about 10–14 KB each.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd /home/claude/nodeflix && npm test 2>&1 | tail -8`
Expected: `# pass 155`, `# fail 0`.

- [ ] **Step 6: Restart the dev server (migration 8 runs on the dev data)**

Run: `/home/claude/devtools/restart-dev.sh && curl -s http://127.0.0.1:8787/api/status | grep -o '"defaultTheme":"[a-z-]*"'`
Expected: `"defaultTheme":"orbit"`. The dev UI now uses the orbit layout with almost no styling; Tasks 3–7 fix that.

- [ ] **Step 7: Checkpoint**

`npm test` is green. Files changed:
- `src/themes.js`, `src/db.js`, `src/settings.js`, `src/api/account.js`, `public/js/app.js`
- `themes/orbit/*`, `public/fonts/sora-*`, `public/fonts/OFL-sora.txt`
- the three test files

---

### Task 3: Foundations in the browser: sizes, type, glass, selection, Reduce effects

**Files:**
- Create: `public/css/orbit.css` (sizes only for now; later tasks append sections)
- Modify: `public/index.html:12` (link `orbit.css`)
- Replace: `themes/orbit/theme.css` (fonts, tokens, type, buttons, inputs, switches, tags)
- Modify: `public/css/app.css` (append the Reduce effects rule and the switch hint)
- Modify: `public/js/app.js` (`applyTheme`, new export `isOrbit`)
- Modify: `public/js/components.js:396-400` (`toggle` takes a hint)
- Modify: `public/js/views/settings.js:5,157` (Reduce effects switch)
- Create: `/home/claude/devtools/orbit-lib.mjs`, `/home/claude/devtools/orbit-ui.mjs`

**Interfaces:**
- Consumes: Task 2's `layout: 'orbit'` theme and the `reduceEffects` pref.
- Produces:
  - `export const isOrbit = () => boolean` in `public/js/app.js`.
  - `html[data-layout]` mirrors `body[data-layout]`, and `html.reduce-effects` is set from the pref.
  - `toggle(label, checked, onChange, { hint } = {})` in `components.js`.
  - CSS tokens that later tasks use:
    - sizes: `--px` (1px at 1920 wide); type `--t-display --t-title --t-page --t-section --t-body --t-meta --t-caption`;
    - glass: `--glass-clear --glass-strong --glass-edge --glass-tinted --glass-tinted-edge --glass-highlight --glass-panel --glass-shadow --blur-clear --blur-tinted`;
    - selection and motion: `--ring --ring-gap --lift --select --grow-btn --grow-card --grow-avatar`; soft text `--text-soft`.
  - Browser-check helpers in `orbit-lib.mjs`: `open, signIn, check, failed, api, setPrefs, go, press, active, rect, style, blurred`.

- [ ] **Step 1: Write the browser-check helpers and the failing "foundations" checks**

`/home/claude/devtools/orbit-lib.mjs`:

```js
// Shared helpers for the Orbit browser checks (orbit-ui.mjs, orbit-a11y.mjs). Dev server: restart-dev.sh.
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';

export const base = 'http://127.0.0.1:8787';
let failures = 0;
export const failed = () => failures;
export function check(name, ok, extra = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` — ${extra}` : ''}`);
}

export async function open({ width = 1920, height = 1080, reducedMotion = 'no-preference' } = {}) {
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return { browser, context, page, errors };
}

/** Sign in as dallas (PIN 4321) and wait for Home. */
export async function signIn(page) {
  await page.goto(base);
  await page.fill('input[name=username]', 'dallas');
  await page.fill('input[name=password]', 'password123');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.picker-grid');
  await page.click('.picker-profile:has-text("dallas")');
  await page.waitForSelector('dialog[open] .pin-input');
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.home-view');
  await page.evaluate(() => document.fonts.ready);
}

export const api = (page, method, path, body) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.json().catch(() => null);
  }, [method, path, body]);
export const setPrefs = (page, prefs) => api(page, 'PATCH', '/api/me', { prefs });

/**
 * Open a route fresh (a full reload, so every check starts the same way: no keyboard mode yet, focus on
 * the page — the first arrow key then selects the page's first control) and wait for `selector`.
 * Anything that must survive between pages (music playing) has to stay on one page.
 */
export async function go(page, hash, selector) {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  await page.waitForSelector(selector);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}
export async function press(page, ...keys) {
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(160);
  }
}
export const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, cls: String(a?.className?.baseVal ?? a?.className ?? ''), text: a?.textContent?.trim().slice(0, 60), nav: a?.dataset?.nav || null, label: a?.getAttribute?.('aria-label') };
  });
export const rect = (page, sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);
export const style = (page, sel, prop, pseudo = null) =>
  page.evaluate(([s, p, ps]) => {
    const e = document.querySelector(s);
    return e ? getComputedStyle(e, ps)[p] : null;
  }, [sel, prop, pseudo]);
/** How many elements (or ::before/::after) on the page are blurred (backdrop-filter or a blur() filter). */
export const blurred = (page, within = 'body') =>
  page.evaluate((w) => {
    let n = 0;
    for (const el of document.querySelector(w).querySelectorAll('*')) {
      for (const p of [null, '::before', '::after']) {
        const s = getComputedStyle(el, p);
        const bf = s.backdropFilter || s.webkitBackdropFilter || 'none';
        if (bf !== 'none' || /blur\(/.test(s.filter)) n++;
      }
    }
    return n;
  }, within);
```

`/home/claude/devtools/orbit-ui.mjs`:

```js
// Browser checks for the Orbit look (v0.7.0). Needs the dev server: /home/claude/devtools/restart-dev.sh
//   node /home/claude/devtools/orbit-ui.mjs [section …]   (no sections = all of them)
import fs from 'node:fs';
import { open, signIn, check, failed, api, setPrefs, go, press, active, rect, style, blurred } from './orbit-lib.mjs';

fs.mkdirSync('/tmp/shots/orbit', { recursive: true });
const want = new Set(process.argv.slice(2));
const run = (name) => !want.size || want.has(name);
const { browser, page, errors } = await open();
await signIn(page);
await setPrefs(page, { theme: null, reduceEffects: null, reduceMotion: null });
await page.reload();
await page.waitForSelector('.home-view');

if (run('foundations')) {
  const layout = await page.evaluate(() => [document.documentElement.dataset.layout, document.body.dataset.layout].join());
  check('Orbit is the default look', layout === 'orbit,orbit', layout);
  check('Sora is loaded', await page.evaluate(() => document.fonts.check('600 22px Sora')));
  check('text is set in Sora', /^"?Sora/.test(await style(page, 'body', 'fontFamily')), await style(page, 'body', 'fontFamily'));
  check('body text is 22px at 1080p', (await style(page, 'html', 'fontSize')) === '22px', await style(page, 'html', 'fontSize'));
  // The remote on a button: it turns white, grows a little and gets a white ring with a dark gap.
  await press(page, 'ArrowUp');
  await page.waitForTimeout(250);
  const btn = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { cls: document.activeElement.className, bg: s.backgroundColor, shadow: s.boxShadow, transform: s.transform };
  });
  check('a selected button turns white', /btn/.test(btn.cls) && btn.bg === 'rgb(255, 255, 255)', JSON.stringify(btn));
  check('…with the white ring', /rgb\(255, 255, 255\) 0px 0px 0px 9px/.test(btn.shadow), btn.shadow);
  check('…and grows a little', /^matrix\(1\.05, 0, 0, 1\.05/.test(btn.transform), btn.transform);
  check('glass is blurred normally', (await blurred(page)) > 0);
  // Reduce effects: solid panels, no blur anywhere.
  await setPrefs(page, { reduceEffects: true });
  await page.reload();
  await page.waitForSelector('.home-view');
  await page.waitForTimeout(500);
  check('Reduce effects reaches the page', await page.evaluate(() => document.documentElement.classList.contains('reduce-effects')));
  check('Reduce effects: nothing is blurred', (await blurred(page)) === 0, String(await blurred(page)));
  check('Reduce effects: buttons turn solid', (await style(page, '.spot-actions .btn-secondary', 'backgroundColor')) === 'rgba(24, 24, 36, 0.94)', await style(page, '.spot-actions .btn-secondary', 'backgroundColor'));
  await setPrefs(page, { reduceEffects: null });
  // The switch in Settings → Profile.
  await go(page, '#/settings/profile', '.theme-grid');
  const sw = page.locator('.toggle:has-text("Reduce effects") input');
  check('Settings has a Reduce effects switch', (await sw.count()) === 1);
  check('…that says what it does', /TV feels slow/.test((await page.locator('.toggle:has-text("Reduce effects") .toggle-hint').textContent().catch(() => '')) || ''));
  await sw.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  check('…and pressing it saves', (await api(page, 'GET', '/api/status')).profile.prefs.reduceEffects === true);
  await setPrefs(page, { reduceEffects: null });
  // The type scale follows the screen.
  for (const [w, hgt, want] of [[1280, 800, 15.84], [390, 844, 16]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.waitForTimeout(200);
    const size = parseFloat(await style(page, 'html', 'fontSize'));
    check(`text scale at ${w}×${hgt}`, Math.abs(size - want) < 0.1, String(size));
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '#/', '.home-view');
}

// ---- more sections are added above this line by later tasks ----
check('no console errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs foundations`
Expected: FAIL for `Sora is loaded`, `text is set in Sora`, `body text is 22px`, the three button checks, the Reduce effects checks and the text scale checks. `Orbit is the default look` fails too: body is `orbit` but html has no `data-layout` yet.

- [ ] **Step 3: Add the structure file and link it**

`public/css/orbit.css`:

```css
/* Orbit layout — for themes with "layout": "orbit" (themes/orbit is the default).
   The page floats in a rounded window over its own artwork, a glass menu floats beside it, and phones
   get a dock at the bottom. This file is the structure: where things go and how big they are. The
   theme's theme.css gives the look (colours, glass, type, selection).

   Sizes come from the mockups at 1920×1080 and are written as N × --px, so they scale with the screen:
   --px is 1px on a 1080p TV and never less than 0.72px (laptops). Phones and portrait screens
   (narrower than 1000px, or taller than wide) have no window frame and use --px: 0.4px. */

/* ---------- Sizes ---------- */
html[data-layout="orbit"] {
  --px: clamp(0.72px, calc(100vw / 1920), 2px);
  font-size: max(12px, calc(22 * var(--px)));
}
@media not all and (min-width: 1000px) and (orientation: landscape) {
  html[data-layout="orbit"] { --px: 0.4px; font-size: 16px; }
}
```

`public/index.html`, after line 12 (`<link rel="stylesheet" href="/css/app.css">`):

```html
  <link rel="stylesheet" href="/css/orbit.css">
```

- [ ] **Step 4: Write the theme's foundations**

Replace `themes/orbit/theme.css` with:

```css
/* Orbit — Atomix's default look.

   The artwork is the screen. The page floats over it in a rounded window, the menu floats beside it as
   glass, and whatever the remote is on turns white. Drawn from Netflix on Apple Vision Pro, SlothUI and
   Arctic Horizon 2 — an original stylesheet; nothing is copied.

   Palette  Deep space #05050c · window shade #04040e (92%) · text white, 86% white and 66% white
            Accent: --tint, the colour of the artwork on screen (public/js/tint.js); the profile's own accent
            colour when there's no artwork, else ice #8fe9ff. The accent never marks the selection: white does.
   Glass    Clear (buttons on artwork): rgba(255,255,255,.14), blur 24px.
            Tinted (menu, bars, dialogs): rgba(28,28,42,.5–.66), blur 30–40px. Groups inside the window
            are tinted but not blurred (they scroll). Reduce effects: solid rgba(24,24,36,.94), no blur.
   Type     Sora 400–700 (SIL OFL, /fonts/OFL-sora.txt). At 1080p: display 116, page titles 56–100,
            sections 26, body 22, details 20, captions 16 — all N × --px (public/css/orbit.css). */

/* ---------- Sora, shipped with Atomix ---------- */
@font-face { font-family: "Sora"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/sora-latin-400.woff2") format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/sora-latin-500.woff2") format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/sora-latin-600.woff2") format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/sora-latin-700.woff2") format("woff2"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 400; font-display: swap; src: url("/fonts/sora-latin-ext-400.woff2") format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 500; font-display: swap; src: url("/fonts/sora-latin-ext-500.woff2") format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 600; font-display: swap; src: url("/fonts/sora-latin-ext-600.woff2") format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Sora"; font-style: normal; font-weight: 700; font-display: swap; src: url("/fonts/sora-latin-ext-700.woff2") format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }

/* ---------- Tokens ---------- */
:root {
  color-scheme: dark;
  --bg: #05050c;
  --bg-2: #0b0b16;
  --surface: rgba(28, 28, 42, 0.62);
  --surface-2: rgba(255, 255, 255, 0.14);
  --border: rgba(255, 255, 255, 0.16);
  --text: #ffffff;
  --text-soft: rgba(255, 255, 255, 0.86);
  --text-dim: rgba(255, 255, 255, 0.66);
  --tint-default: #8fe9ff;
  --accent: var(--tint);
  --accent-text: #0b0b16;
  --danger: #ff7a86;
  --success: #62e3ae;
  --radius: calc(18 * var(--px, 1px));
  --radius-lg: calc(32 * var(--px, 1px));
  --nav-bg: transparent;
  --shadow: 0 calc(14 * var(--px, 1px)) calc(30 * var(--px, 1px)) rgba(0, 0, 0, 0.45);
  --font: "Sora", system-ui, "Segoe UI", sans-serif;
  --font-display: var(--font);
  --font-title: var(--font);
  --header-h: 0px;
  --shade: rgba(4, 4, 14, 0.92);
  --glass-clear: rgba(255, 255, 255, 0.14);
  --glass-strong: rgba(255, 255, 255, 0.22);
  --glass-edge: rgba(255, 255, 255, 0.24);
  --glass-tinted: rgba(28, 28, 42, 0.58);
  --glass-tinted-edge: rgba(255, 255, 255, 0.16);
  --glass-highlight: rgba(255, 255, 255, 0.22);
  --glass-panel: rgba(20, 20, 34, 0.62);
  --glass-shadow: 0 calc(24 * var(--px, 1px)) calc(60 * var(--px, 1px)) rgba(0, 0, 0, 0.55);
  --blur-clear: blur(24px) saturate(1.6);
  --blur-tinted: blur(34px) saturate(1.6);
  --ring-gap: #05050c;
  --ring: 0 0 0 calc(5 * var(--px, 1px)) var(--ring-gap), 0 0 0 calc(9 * var(--px, 1px)) #ffffff;
  --lift: 0 calc(20 * var(--px, 1px)) calc(44 * var(--px, 1px)) rgba(0, 0, 0, 0.55);
  --select: 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
  --grow-btn: 1.05;
  --grow-card: 1.08;
  --grow-avatar: 1.1;
}
html[data-layout="orbit"] {
  --t-display: calc(116 * var(--px));
  --t-title: calc(76 * var(--px));
  --t-page: calc(56 * var(--px));
  --t-section: max(12px, calc(26 * var(--px)));
  --t-body: max(12px, calc(22 * var(--px)));
  --t-meta: max(12px, calc(20 * var(--px)));
  --t-caption: max(12px, calc(16 * var(--px)));
}
@media not all and (min-width: 1000px) and (orientation: landscape) {
  html[data-layout="orbit"] {
    --t-display: max(16px, calc(116 * var(--px)));
    --t-title: max(16px, calc(76 * var(--px)));
    --t-page: max(16px, calc(56 * var(--px)));
    --t-section: max(16px, calc(26 * var(--px)));
    --t-body: 16px;
    --t-meta: 16px;
    --t-caption: 16px;
  }
}
/* The accent follows the artwork even when a profile picked its own colour (that colour is the fallback). */
body { --accent: var(--tint); --accent-text: #0b0b16; font-weight: 400; letter-spacing: -0.005em; }
h1 { font-size: var(--t-page); font-weight: 700; letter-spacing: -0.035em; line-height: 1; }
h2 { font-size: var(--t-section); font-weight: 600; letter-spacing: -0.015em; }
h3 { font-size: var(--t-body); font-weight: 600; }

/* No motion: nothing grows. Reduce effects (and no glass support): solid panels, no blur. */
@media (prefers-reduced-motion: reduce) { :root { --grow-btn: 1; --grow-card: 1; --grow-avatar: 1; } }
html.reduce-motion { --grow-btn: 1; --grow-card: 1; --grow-avatar: 1; }
html.reduce-effects {
  --glass-clear: rgba(24, 24, 36, 0.94); --glass-strong: rgba(24, 24, 36, 0.94); --glass-tinted: rgba(24, 24, 36, 0.94); --glass-panel: rgba(24, 24, 36, 0.94);
  --blur-clear: none; --blur-tinted: none;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :root { --glass-clear: rgba(24, 24, 36, 0.94); --glass-strong: rgba(24, 24, 36, 0.94); --glass-tinted: rgba(24, 24, 36, 0.94); --glass-panel: rgba(24, 24, 36, 0.94); --blur-clear: none; --blur-tinted: none; }
}
@media (prefers-reduced-transparency: reduce) {
  :root { --glass-clear: rgba(24, 24, 36, 0.94); --glass-strong: rgba(24, 24, 36, 0.94); --glass-tinted: rgba(24, 24, 36, 0.94); --glass-panel: rgba(24, 24, 36, 0.94); --blur-clear: none; --blur-tinted: none; }
}

/* ---------- Selection: white means "the remote is here" ---------- */
:where(a, button, input, select, textarea, [tabindex]):focus-visible { outline: none; box-shadow: var(--ring); }

/* ---------- Buttons: clear glass pills; the selected one is white ---------- */
.btn {
  --btn-bg: var(--glass-clear);
  --btn-fg: #ffffff;
  min-height: max(44px, calc(66 * var(--px)));
  padding: 0 calc(34 * var(--px)) 0 calc(28 * var(--px));
  gap: calc(12 * var(--px));
  border: 0;
  border-radius: 999px;
  font-size: var(--t-body);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--glass-edge);
  -webkit-backdrop-filter: var(--blur-clear);
  backdrop-filter: var(--blur-clear);
  transition: transform var(--select), background-color var(--select), color var(--select), box-shadow var(--select);
}
.btn .icon { width: max(16px, calc(26 * var(--px))); height: max(16px, calc(26 * var(--px))); }
.btn:hover { background: rgba(255, 255, 255, 0.24); }
.btn:active { transform: scale(0.97); }
.btn-primary { --btn-bg: var(--glass-strong); --btn-fg: #ffffff; }
.btn-primary:hover { background: rgba(255, 255, 255, 0.3); }
.btn-ghost { --btn-bg: var(--glass-clear); }
.btn-ghost:hover { background: rgba(255, 255, 255, 0.24); }
.btn-danger { --btn-bg: rgba(255, 122, 134, 0.26); color: #ffffff; }
.btn-ghost.danger { color: #ffc2c8; }
.btn.active { box-shadow: inset 0 0 0 calc(2 * var(--px)) var(--accent); }
.btn-icon { width: max(44px, calc(66 * var(--px))); padding: 0; }
.btn-sm { min-height: max(36px, calc(48 * var(--px))); padding: 0 calc(20 * var(--px)); font-size: var(--t-meta); }
.btn:focus-visible, html.kbd .btn:focus-visible {
  background: #ffffff;
  color: #0b0b16;
  outline: none;
  transform: scale(var(--grow-btn));
  box-shadow: var(--ring), var(--lift);
}

/* ---------- Fields, switches, tags ---------- */
input:where(:not([type="checkbox"], [type="radio"], [type="range"], [type="color"])), select, textarea {
  min-height: max(44px, calc(60 * var(--px)));
  padding: 0 calc(24 * var(--px));
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  box-shadow: inset 0 0 0 1px var(--glass-edge);
  color: #ffffff;
  font-size: var(--t-body);
}
textarea { border-radius: calc(20 * var(--px)); padding: calc(14 * var(--px)) calc(20 * var(--px)); font-size: var(--t-meta); }
select option { background: #16162a; color: #ffffff; }
input::placeholder, textarea::placeholder { color: rgba(255, 255, 255, 0.5); }
:is(input, select, textarea):focus-visible { box-shadow: var(--ring); }
.field > label, .field-label { font-size: var(--t-meta); font-weight: 600; }
.hint { font-size: var(--t-caption); }
.toggle { --tw: max(40px, calc(64 * var(--px))); --th: max(24px, calc(38 * var(--px))); gap: calc(18 * var(--px)); min-height: max(44px, calc(64 * var(--px))); font-size: var(--t-body); font-weight: 500; }
.toggle input { width: var(--tw); height: var(--th); }
.toggle-track { width: var(--tw); height: var(--th); border: 0; background: rgba(255, 255, 255, 0.18); box-shadow: inset 0 0 0 1px var(--glass-edge); }
.toggle-track::after { top: 4px; left: 4px; width: calc(var(--th) - 8px); height: calc(var(--th) - 8px); background: #ffffff; }
.toggle input:checked + .toggle-track { background: var(--accent); box-shadow: none; }
.toggle input:checked + .toggle-track::after { transform: translateX(calc(var(--tw) - var(--th))); background: #0b0b16; }
.toggle input:focus-visible + .toggle-track { outline: none; box-shadow: var(--ring); }
.toggle-hint { font-size: var(--t-meta); }
.chip { padding: calc(4 * var(--px)) calc(14 * var(--px)); background: rgba(255, 255, 255, 0.12); font-size: var(--t-caption); font-weight: 600; }
.media-flags li { padding: calc(3 * var(--px)) calc(10 * var(--px)); border: 0; border-radius: calc(7 * var(--px)); box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.4); font-size: max(12px, calc(15 * var(--px))); font-weight: 600; }
.eyebrow { text-transform: none; letter-spacing: 0; font-size: var(--t-meta); font-weight: 600; color: var(--accent); margin-bottom: calc(12 * var(--px)); }
.meta-line { gap: calc(8 * var(--px)) calc(22 * var(--px)); font-size: var(--t-meta); font-weight: 500; color: var(--text-soft); }
.meta-line .rating { color: #ffd166; }
```

- [ ] **Step 5: Add the shared Reduce effects rule and the switch hint to `app.css`**

Append to `public/css/app.css`:

```css
/* ---------- Reduce effects (a profile setting): no blur anywhere, for slow TVs ---------- */
html.reduce-effects *, html.reduce-effects *::before, html.reduce-effects *::after { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
html.reduce-effects dialog::backdrop { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
html.reduce-effects .backdrop img { filter: none !important; }
html.reduce-effects .mini::before { display: none; }
/* A switch with a line saying what it does */
.toggle-text { display: flex; flex-direction: column; gap: 2px; }
.toggle-hint { color: var(--text-dim); font-weight: 400; font-size: 0.85rem; }
```

- [ ] **Step 6: Tell the page its layout and the Reduce effects choice**

`public/js/app.js`:
- After line 19 (the `addonsAllowed` line), add:

```js
/** The page uses the Orbit layout (floating window and menu). */
export const isOrbit = () => document.body.dataset.layout === 'orbit';
```

- In `applyTheme()`, replace `document.body.dataset.layout = theme?.layout || 'top';` with:

```js
  const layout = theme?.layout || 'top';
  const layoutChanged = document.body.dataset.layout !== layout;
  document.body.dataset.layout = layout;
  document.documentElement.dataset.layout = layout;
```

- After the `reduce-motion` toggle line, add:

```js
  document.documentElement.classList.toggle('reduce-effects', Boolean(prefs.reduceEffects));
```

- At the end of `applyTheme()`, after the theme-color lines, add:

```js
  // Orbit and the older layouts build different menus.
  if (layoutChanged && navEl) renderNav();
```

`public/js/components.js`, replace `toggle()` (lines 396–400) with:

```js
/** A switch. `hint` adds a line under the label saying what it does. */
export function toggle(label, checked, onChange, { hint } = {}) {
  const id = `t-${Math.random().toString(36).slice(2, 9)}`;
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked, 'aria-describedby': hint ? `${id}-hint` : null, onChange: (e) => onChange?.(e.target.checked) });
  const text = hint ? h('span', { class: 'toggle-text' }, h('span', {}, label), h('span', { class: 'toggle-hint', id: `${id}-hint` }, hint)) : h('span', {}, label);
  return h('label', { class: 'toggle', for: id }, input, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), text);
}
```

`public/js/views/settings.js`, line 157 (the `section('Appearance', …)` line) becomes:

```js
    section(
      'Appearance',
      themeGrid,
      h('div', { class: 'inline-fields' }, field('Accent colour', accent), resetAccent),
      toggle('Reduce motion', prefs.reduceMotion, (v) => save(() => updatePrefs({ reduceMotion: v }))),
      toggle('Reduce effects', prefs.reduceEffects, (v) => save(() => updatePrefs({ reduceEffects: v })), { hint: 'Solid panels instead of glass and blur. Try this if your TV feels slow.' }),
    ),
```

- [ ] **Step 7: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs foundations`
Expected: every line is `PASS`, including `no console errors`, and the exit code is 0.

- [ ] **Step 8: Checkpoint**

Run `cd /home/claude/nodeflix && npm test 2>&1 | tail -3`; expect `# fail 0`. Files changed:
- `public/css/orbit.css`, `public/index.html`, `themes/orbit/theme.css`, `public/css/app.css`
- `public/js/app.js`, `public/js/components.js`, `public/js/views/settings.js`
- devtools: `orbit-lib.mjs`, `orbit-ui.mjs`

---

## Stage 2 — The window, the menu and the remote

### Task 4: Pure rules for Orbit (`orbit-rules.js`)

**Files:**
- Create: `public/js/orbit-rules.js`
- Test: `test/orbit-rules.test.js`

**Interfaces:**
- Produces (all pure, no DOM):
  - `FRAME_QUERY: string`, which is `'(min-width: 1000px) and (orientation: landscape)'`.
  - `menuKey({ key: 'up'|'down'|'left'|'right'|'back', inMenu: boolean, leftTarget?: 'page'|'menu'|'none' }) → 'enter'|'leave'|'move'|'stay'|null`.
  - `menuStep(count: number, index: number, key: 'up'|'down') → number`, which is `-1` when `count` is 0.
  - `homeBack({ hasMenu: boolean, onHome: boolean, atTop: boolean }) → 'top'|'menu'|'back'`.
  - `sameLine(a: {top,bottom}, b: {top,bottom}) → boolean`.
  - `coverRect(sw, sh, dw, dh, focusX = 0.5, focusY = 0.25) → { sx, sy, sw, sh } | null`.

- [ ] **Step 1: Write the failing tests**

`test/orbit-rules.test.js`:

```js
// Rules for the Orbit layout that need no page (public/js/orbit-rules.js): what the remote's
// keys do with the floating menu, what Back does on Home, and how artwork is cropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuKey, menuStep, homeBack, sameLine, coverRect, FRAME_QUERY } from '../public/js/orbit-rules.js';

test('Left enters the menu when nothing is to the left on the same line', () => {
  assert.equal(menuKey({ key: 'left', inMenu: false, leftTarget: 'none' }), 'enter');
  assert.equal(menuKey({ key: 'left', inMenu: false, leftTarget: 'menu' }), 'enter', 'landing on a menu entry counts as reaching the edge');
  assert.equal(menuKey({ key: 'left', inMenu: false, leftTarget: 'page' }), null, 'a card to the left: normal navigation');
  for (const key of ['up', 'down', 'right', 'back']) assert.equal(menuKey({ key, inMenu: false, leftTarget: 'none' }), null, key);
});

test('inside the menu: Up and Down move, Right and Back leave, Left stays put', () => {
  assert.equal(menuKey({ key: 'up', inMenu: true }), 'move');
  assert.equal(menuKey({ key: 'down', inMenu: true }), 'move');
  assert.equal(menuKey({ key: 'right', inMenu: true }), 'leave');
  assert.equal(menuKey({ key: 'back', inMenu: true }), 'leave');
  assert.equal(menuKey({ key: 'left', inMenu: true }), 'stay');
});

test('Up and Down in the menu stop at the ends', () => {
  assert.equal(menuStep(5, 0, 'up'), 0);
  assert.equal(menuStep(5, 0, 'down'), 1);
  assert.equal(menuStep(5, 4, 'down'), 4);
  assert.equal(menuStep(5, -1, 'down'), 0, 'from nowhere, Down starts at the top');
  assert.equal(menuStep(5, -1, 'up'), 0);
  assert.equal(menuStep(0, 0, 'down'), -1, 'an empty menu has nowhere to go');
});

test('Back on Orbit Home goes to the top first, then opens the menu', () => {
  assert.equal(homeBack({ hasMenu: true, onHome: true, atTop: false }), 'top');
  assert.equal(homeBack({ hasMenu: true, onHome: true, atTop: true }), 'menu');
  assert.equal(homeBack({ hasMenu: true, onHome: false, atTop: true }), 'back', 'other pages go back as before');
  assert.equal(homeBack({ hasMenu: false, onHome: true, atTop: false }), 'back', 'layouts without the floating menu: as before');
});

test('"on the same line" means the boxes overlap from top to bottom', () => {
  assert.equal(sameLine({ top: 0, bottom: 100 }, { top: 50, bottom: 150 }), true);
  assert.equal(sameLine({ top: 0, bottom: 100 }, { top: 100, bottom: 200 }), false, 'touching is not overlapping');
  assert.equal(sameLine({ top: 300, bottom: 400 }, { top: 0, bottom: 90 }), false);
});

test('the environment crops artwork like object-fit: cover', () => {
  assert.deepEqual(coverRect(1920, 1080, 64, 36), { sx: 0, sy: 0, sw: 1920, sh: 1080 }, 'same shape: all of it');
  // A poster (2:3) into a 16:9 box: the full width, a band a quarter of the way down (like the page's artwork).
  assert.deepEqual(coverRect(600, 900, 64, 36), { sx: 0, sy: (900 - 337.5) * 0.25, sw: 600, sh: 337.5 });
  // A very wide banner: the full height, centred.
  assert.deepEqual(coverRect(4000, 1000, 64, 36), { sx: (4000 - (1000 * 64) / 36) * 0.5, sy: 0, sw: (1000 * 64) / 36, sh: 1000 });
  assert.equal(coverRect(0, 900, 64, 36), null, 'an image that has not loaded');
});

test('the window frame needs a wide, landscape screen (the same query as public/css/orbit.css)', () => {
  assert.equal(FRAME_QUERY, '(min-width: 1000px) and (orientation: landscape)');
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd /home/claude/nodeflix && node --test test/orbit-rules.test.js 2>&1 | tail -5`
Expected: FAIL with `Cannot find module '…/public/js/orbit-rules.js'`.

- [ ] **Step 3: Write the rules**

`public/js/orbit-rules.js`:

```js
// Rules for the Orbit layout that need no page, so they are tested in Node (test/orbit-rules.test.js):
// what the remote's keys do with the floating menu, what Back does on Home, and how the environment
// crops artwork. nav.js, app.js and backdrop.js apply them.

/** Wide enough and landscape: the page sits in a floating window. Keep in step with public/css/orbit.css. */
export const FRAME_QUERY = '(min-width: 1000px) and (orientation: landscape)';

/**
 * What an arrow or Back does with the floating menu.
 * leftTarget (for Left outside the menu): what spatial navigation found to the left —
 * 'page' (a control on the same line), 'menu' (a menu entry) or 'none'.
 * @returns {'enter'|'leave'|'move'|'stay'|null} null: not the menu's business, navigate as usual
 */
export function menuKey({ key, inMenu, leftTarget = 'none' }) {
  if (inMenu) {
    if (key === 'up' || key === 'down') return 'move';
    if (key === 'right' || key === 'back') return 'leave';
    return 'stay';
  }
  if (key === 'left' && leftTarget !== 'page') return 'enter';
  return null;
}

/** The menu entry Up/Down goes to, stopping at the ends. -1 when there are none. */
export function menuStep(count, index, key) {
  if (!count) return -1;
  return Math.max(0, Math.min(count - 1, index + (key === 'down' ? 1 : -1)));
}

/** Back on Orbit's Home: to the top first, then into the menu. Other pages and layouts go back. */
export function homeBack({ hasMenu, onHome, atTop }) {
  if (!hasMenu || !onHome) return 'back';
  return atTop ? 'menu' : 'top';
}

/** Two boxes (anything with top/bottom) overlap vertically. */
export const sameLine = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;

/**
 * The part of a sw × sh picture that fills a dw × dh box, like object-fit: cover, with the
 * spare room split at focusX / focusY (0–1). Null until the picture has a size.
 */
export function coverRect(sw, sh, dw, dh, focusX = 0.5, focusY = 0.25) {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return null;
  const wider = sw / sh > dw / dh; // wider than the box: crop the sides
  const w = wider ? (sh * dw) / dh : sw;
  const h = wider ? sh : (sw * dh) / dw;
  return { sx: (sw - w) * focusX, sy: (sh - h) * focusY, sw: w, sh: h };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd /home/claude/nodeflix && node --test test/orbit-rules.test.js 2>&1 | tail -5` → `# pass 7`. Then `npm test 2>&1 | tail -3` → `# fail 0`.

- [ ] **Step 5: Checkpoint**

Files: `public/js/orbit-rules.js`, `test/orbit-rules.test.js`.

---

### Task 5: The shell: window, environment, floating menu, clock cluster, phone dock

**Files:**
- Create: `public/js/shell.js`
- Modify: `public/js/app.js` (imports, `renderNav`, `applyTheme`, scrolling, `boot`)
- Modify: `public/js/backdrop.js` (the environment layer)
- Modify: `public/css/app.css` (scope the phone rules away from Orbit; hide `.environment` by default)
- Modify: `public/css/orbit.css` (append the window, menu, cluster, environment and phone sections)
- Modify: `themes/orbit/theme.css` (append their look)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `shell` section)

**Interfaces:**
- Consumes:
  - `isOrbit()` and `applyTheme()` (Task 3), `coverRect` and `FRAME_QUERY` (Task 4);
  - `logoMark(size)` and `icon(name, {size})` from `dom.js`, `avatar(profile, size)` from `components.js`.
- Produces:
  - `renderOrbitNav(nav: HTMLElement, { serverName, libraries, profile, addons, settingsLabel, clock })` in `shell.js`.
  - The markup it builds (other tasks and tests rely on these names):
    - `a.brand` (with `.brand-name`) and `ul.orbit-menu`, whose `li > a.nav-link[data-nav]` entries are `home`, `lib-<id>`, `search`, `addons` and `settings`;
    - `li.orbit-extra` on the Add-ons, divider and Settings entries, and `li.orbit-divider`;
    - `div.orbit-cluster`, holding `a.orbit-tool` (phones only), `time.nav-clock` and `a.orbit-profile`.
  - `environmentLayer: HTMLElement` and `repaintEnvironment(): void` from `backdrop.js`.
  - In app.js, a module-private `pageScroller(): Element`: `main` on framed Orbit pages, otherwise `document.scrollingElement`.

- [ ] **Step 1: Write the failing "shell" checks**

In `orbit-ui.mjs`, insert above the line `// ---- more sections are added above this line by later tasks ----`:

```js
if (run('shell')) {
  await go(page, '#/', '.home-view');
  await page.waitForTimeout(900);
  const win = await rect(page, 'main');
  check('the page floats in a window', win.x === 168 && win.y === 40 && win.w === 1712 && win.h === 1000, JSON.stringify(win));
  check('…with round corners', (await style(page, 'main', 'borderTopLeftRadius')) === '44px', await style(page, 'main', 'borderTopLeftRadius'));
  check('the artwork fills the window', JSON.stringify(await rect(page, '.backdrop')) === JSON.stringify(win), JSON.stringify(await rect(page, '.backdrop')));
  check('the environment shows the artwork, blurred', await page.evaluate(() => Boolean(document.querySelector('.environment canvas.is-on'))));
  const menu = await rect(page, '.orbit-menu');
  check('the menu rests beside the window', menu.x === 40 && menu.w === 88 && Math.abs(menu.y + menu.h / 2 - 540) <= 2, JSON.stringify(menu));
  const mark = await rect(page, '.brand');
  check('the mark sits above the menu', mark.y + mark.h <= menu.y, JSON.stringify(mark));
  const entries = await page.$$eval('.orbit-menu .nav-link', (a) => a.map((x) => x.dataset.nav));
  check('menu: Home, the libraries, Search, Add-ons, Settings', entries[0] === 'home' && entries.slice(-3).join() === 'search,addons,settings' && entries.filter((n) => n.startsWith('lib-')).length === 3, entries.join());
  check('Home is marked as the current page', await page.evaluate(() => document.querySelector('.orbit-menu [aria-current="page"]')?.dataset.nav === 'home'));
  const cluster = await rect(page, '.orbit-cluster');
  check('clock and profile picture float top-right in the window', Math.abs(cluster.x + cluster.w - 1828) <= 2 && Math.abs(cluster.y - 76) <= 2, JSON.stringify(cluster));
  check('…the profile picture opens the picker', (await page.getAttribute('.orbit-cluster .orbit-profile', 'href')) === '#/profiles');
  // A mouse over the menu shows the names, without dimming the page.
  await page.mouse.move(80, 540);
  await page.waitForTimeout(400);
  check('hovering the menu grows it', (await rect(page, '.orbit-menu')).w === 300, JSON.stringify(await rect(page, '.orbit-menu')));
  check('…without dimming the page', (await style(page, '.app-header', 'opacity', '::before')) === '0');
  await page.mouse.move(1000, 600);
  await page.waitForTimeout(300);
  // A page without artwork: a plain dark window and an empty environment.
  await go(page, '#/settings/profile', '.theme-grid');
  await page.waitForTimeout(900);
  check('no artwork: the environment is empty', await page.evaluate(() => !document.querySelector('.environment canvas.is-on')));
  check('no artwork: the window is still a solid panel', (await style(page, '.backdrop', 'backgroundImage')) !== 'none');
  check('pages slide in', (await style(page, '.view', 'animationName')) === 'orbit-in');
  check('the page scrolls inside the window', await page.evaluate(() => {
    const m = document.querySelector('main');
    m.scrollTop = 200;
    return m.scrollTop > 0 && window.scrollY === 0;
  }));
  await page.screenshot({ path: '/tmp/shots/orbit/shell-settings-tv.png' });
  // Laptop
  await page.setViewportSize({ width: 1280, height: 800 });
  await go(page, '#/', '.home-view');
  const lap = await rect(page, 'main');
  check('laptop: a slimmer frame', lap.x === 100 && lap.y === 20 && lap.w === 1160 && lap.h === 760, JSON.stringify(lap));
  check('laptop: smaller corners', (await style(page, 'main', 'borderTopLeftRadius')) === '32px');
  await page.screenshot({ path: '/tmp/shots/orbit/shell-laptop.png' });
  // Phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  check('phone: no window frame', (await style(page, 'main', 'position')) === 'static');
  const dock = await rect(page, '.orbit-menu');
  check('phone: the menu is a dock at the bottom', dock.y + dock.h >= 844 - 40 && dock.w > dock.h, JSON.stringify(dock));
  const shown = await page.$$eval('.orbit-menu .nav-link', (a) => a.filter((x) => x.offsetParent).map((x) => [x.dataset.nav, getComputedStyle(x.querySelector('.nav-label')).display]));
  check('phone: the dock has Home, the libraries and Search', shown[0]?.[0] === 'home' && shown.some(([n]) => n === 'search') && !shown.some(([n]) => n === 'settings' || n === 'addons'), JSON.stringify(shown));
  check('phone: only the current entry shows its name', shown.filter(([, d]) => d !== 'none').map(([n]) => n).join() === 'home', JSON.stringify(shown));
  check('phone: Settings sits by the profile picture', await page.evaluate(() => [...document.querySelectorAll('.orbit-cluster .orbit-tool')].some((a) => a.getAttribute('href') === '#/settings' && a.offsetParent)));
  await page.screenshot({ path: '/tmp/shots/orbit/shell-phone.png' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await go(page, '#/', '.home-view');
  // Review focus 1: many libraries with long names. The menu stays on screen; names end in "…".
  const fit = await page.evaluate(async () => {
    const app = await import('/js/app.js');
    const real = app.state.libraries;
    app.state.libraries = Array.from({ length: 12 }, (_, i) => ({ id: 900 + i, name: `A library with a very long name, number ${i + 1}`, type: 'movies' }));
    app.renderNav();
    const m = document.querySelector('.orbit-menu').getBoundingClientRect();
    const label = getComputedStyle(document.querySelector('.orbit-menu [data-nav="lib-900"] .nav-label'));
    const scrolls = getComputedStyle(document.querySelector('.orbit-menu')).overflowY;
    app.state.libraries = real;
    app.renderNav();
    return { top: m.top, bottom: m.bottom, ellipsis: label.textOverflow, scrolls };
  });
  check('many libraries: the menu stays on screen', fit.top >= 0 && fit.bottom <= 1080 && fit.scrolls === 'auto', JSON.stringify(fit));
  check('many libraries: long names end in …', fit.ellipsis === 'ellipsis');
  // Review focus 5: switching to an older theme and back, without a reload.
  const swap = await page.evaluate(async () => {
    const app = await import('/js/app.js');
    await app.updatePrefs({ theme: 'midnight' });
    const old = { layout: document.documentElement.dataset.layout, classic: Boolean(document.querySelector('#nav .nav-links')), orbit: Boolean(document.querySelector('.orbit-menu')), main: getComputedStyle(document.querySelector('main')).position, env: getComputedStyle(document.querySelector('.environment')).display };
    await app.updatePrefs({ theme: null });
    return { old, back: Boolean(document.querySelector('.orbit-menu')) && document.body.dataset.layout === 'orbit' && getComputedStyle(document.querySelector('main')).position === 'fixed' };
  });
  check('switching to Midnight brings back its menu bar', swap.old.layout === 'top' && swap.old.classic && !swap.old.orbit && swap.old.main === 'static' && swap.old.env === 'none', JSON.stringify(swap.old));
  check('…and switching back rebuilds Orbit', swap.back);
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs shell`
Expected: FAIL on nearly every line. For example, `the page floats in a window` reports `{"x":0,"y":0,…}`, and `.orbit-menu` is missing.

- [ ] **Step 3: Write `shell.js`**

`public/js/shell.js`:

```js
// Orbit's shell: the Atomix mark, the floating glass menu (a dock on phones), and the clock and
// profile picture in the window's top-right corner. app.js calls renderOrbitNav() from renderNav()
// when the theme's layout is "orbit"; nav.js drives the menu with the remote.
import { h, icon, clear, logoMark } from './dom.js';
import { avatar } from './components.js';

const libraryIcon = (type) => (type === 'tv' ? 'tv' : type === 'music' ? 'music' : 'film');

function entry(id, href, label, iconName, extra = null) {
  return h('li', { class: extra }, h('a', { class: 'nav-link', href, dataset: { nav: id } }, icon(iconName, { size: 26 }), h('span', { class: 'nav-label' }, label)));
}

/**
 * Fill #nav with Orbit's menu.
 * @param {HTMLElement} nav
 * @param {{ serverName: string, libraries: {id: number, name: string, type: string}[], profile: object|null,
 *           addons: boolean, settingsLabel: string, clock: HTMLElement }} o
 */
export function renderOrbitNav(nav, o) {
  clear(nav).append(
    // Home is in the menu too, so the remote skips the mark (tabindex -1); a mouse can still click it.
    h('a', { class: 'brand', href: '#/', tabindex: '-1', 'aria-label': `${o.serverName} home` }, logoMark(48), h('span', { class: 'brand-name' }, o.serverName)),
    h(
      'ul',
      { class: 'orbit-menu', role: 'list' },
      entry('home', '#/', 'Home', 'home'),
      o.libraries.map((l) => entry(`lib-${l.id}`, `#/library/${l.id}`, l.name, libraryIcon(l.type))),
      entry('search', '#/search', 'Search', 'search'),
      o.addons ? entry('addons', '#/addons', 'Add-ons', 'addons', 'orbit-extra') : null,
      h('li', { class: 'orbit-divider orbit-extra', 'aria-hidden': 'true' }),
      entry('settings', '#/settings', o.settingsLabel, 'settings', 'orbit-extra'),
    ),
    h(
      'div',
      { class: 'orbit-cluster' },
      // Phones: Add-ons and Settings sit here, beside the profile picture, instead of in the dock.
      o.addons ? h('a', { class: 'orbit-tool', href: '#/addons', title: 'Add-ons', 'aria-label': 'Add-ons' }, icon('addons', { size: 22 })) : null,
      h('a', { class: 'orbit-tool', href: '#/settings', title: o.settingsLabel, 'aria-label': o.settingsLabel }, icon('settings', { size: 22 })),
      o.clock,
      o.profile ? h('a', { class: 'orbit-profile', href: '#/profiles', title: `Watching as ${o.profile.name}. Switch profile`, 'aria-label': `Switch profile (now ${o.profile.name})` }, avatar(o.profile, 40)) : null,
    ),
  );
}
```

- [ ] **Step 4: Feed the environment from the artwork**

In `public/js/backdrop.js`:
- Add `import { coverRect } from './orbit-rules.js';` below the `tint.js` import.
- After `export const backdropLayer = layer;`, add:

```js
// Orbit's "environment": the same artwork all round the window, drawn tiny (64 × 36) and stretched to
// the whole screen, so it looks blurred without a full-screen blur filter. Two canvases cross-fade.
const ENV_W = 64;
const ENV_H = 36;
const envLayer = h('div', { class: 'environment', 'aria-hidden': 'true' });
const envCanvases = [0, 1].map(() => h('canvas', { width: ENV_W, height: ENV_H }));
envLayer.append(...envCanvases);
let envFront = 0;
export const environmentLayer = envLayer;

function paintEnvironment(img) {
  if (document.documentElement.dataset.layout !== 'orbit' || !img?.naturalWidth) return;
  const canvas = envCanvases[1 - envFront];
  const ctx = canvas.getContext('2d');
  const r = coverRect(img.naturalWidth, img.naturalHeight, ENV_W, ENV_H);
  if (!ctx || !r) return;
  ctx.clearRect(0, 0, ENV_W, ENV_H);
  ctx.filter = 'blur(2px) saturate(1.5)'; // where supported; the stretch alone already blurs it
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, ENV_W, ENV_H);
  canvas.classList.add('is-on');
  envCanvases[envFront].classList.remove('is-on');
  envFront = 1 - envFront;
}
function clearEnvironment() {
  for (const c of envCanvases) c.classList.remove('is-on');
}
/** The layout just changed: paint (or clear) the environment for the artwork already showing. */
export function repaintEnvironment() {
  if (current && imgs[front].classList.contains('is-on')) paintEnvironment(imgs[front]);
  else clearEnvironment();
}
```

- In `setBackdrop()`, add `clearEnvironment();` in the `if (!url) { … }` branch, right after `setTint(null);`.
- In the same function, add `paintEnvironment(next);` in `next.onload`, right after `setTint(tintOf(next));`.

- [ ] **Step 5: Use the shell in `app.js`**

Imports at the top of `public/js/app.js`:

```js
import { backdropLayer, environmentLayer, repaintEnvironment, routeStart, routeEnd } from './backdrop.js';
import { renderOrbitNav } from './shell.js';
import { FRAME_QUERY } from './orbit-rules.js';
```

(The first line replaces the existing `backdrop.js` import.)

At the start of `renderNav()`, before `clear(navEl);`:

```js
  if (isOrbit()) {
    renderOrbitNav(navEl, {
      serverName: state.status?.serverName || 'Atomix',
      libraries: state.libraries,
      profile: state.profile,
      addons: addonsAllowed(),
      settingsLabel: canAdmin() ? 'Settings' : 'Profile',
      clock: clockEl,
    });
    highlightNav();
    return;
  }
```

In `applyTheme()`, change the line Task 3 added to:

```js
  if (layoutChanged && navEl) {
    renderNav();
    repaintEnvironment();
  }
```

Above `async function render()`, add:

```js
// On TVs and laptops Orbit's pages scroll inside the floating window, not the document.
const framed = matchMedia(FRAME_QUERY);
function pageScroller() {
  return isOrbit() && document.body.dataset.view === 'page' && framed.matches ? main : document.scrollingElement || document.documentElement;
}
```

In `render()`, replace `window.scrollTo(0, 0);` with `pageScroller().scrollTo(0, 0);`.

Replace `refreshView()` with:

```js
export function refreshView() {
  const y = pageScroller().scrollTop;
  return render().then(() => pageScroller().scrollTo(0, y));
}
```

In `boot()`, replace `document.body.prepend(backdropLayer);` with `document.body.prepend(environmentLayer, backdropLayer);`.

- [ ] **Step 6: Keep the older layouts' phone rules away from Orbit**

```bash
cd /home/claude/nodeflix
sed -i 's/body\[data-layout\]\([ .]\)/body:not([data-layout="orbit"])\1/g' public/css/app.css
grep -c 'body:not(\[data-layout="orbit"\])' public/css/app.css   # expect 8
grep -n 'body\[data-layout\][ .]' public/css/app.css             # expect nothing
```

Both selectors have the same specificity (0,1,1), so the older themes are unaffected.

Then append to `public/css/app.css`:

```css
/* Orbit's environment layer (public/js/backdrop.js); only the orbit layout shows it. */
.environment { display: none; }
```

- [ ] **Step 7: Append the shell structure to `public/css/orbit.css`**

```css
/* ---------- The window: TVs 40/40/40/168, laptops 20/20/20/100, phones none ---------- */
html[data-layout="orbit"] {
  --win-t: 0px; --win-r: 0px; --win-b: 0px; --win-l: 0px; --win-radius: 0px;
  --menu-w: calc(88 * var(--px));
  --menu-open-w: calc(300 * var(--px));
}
@media (min-width: 1000px) and (orientation: landscape) {
  html[data-layout="orbit"] { --win-t: 20px; --win-r: 20px; --win-b: 20px; --win-l: 100px; --win-radius: 32px; }
}
@media (min-width: 1600px) and (orientation: landscape) {
  html[data-layout="orbit"] { --win-t: calc(40 * var(--px)); --win-r: calc(40 * var(--px)); --win-b: calc(40 * var(--px)); --win-l: calc(168 * var(--px)); --win-radius: calc(44 * var(--px)); }
}
body[data-layout="orbit"] { --gutter: calc(96 * var(--px)); --header-h: 0px; }
@media (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"][data-view="page"] { overflow: hidden; }
  body[data-layout="orbit"][data-view="page"] main {
    position: fixed; inset: var(--win-t) var(--win-r) var(--win-b) var(--win-l);
    min-height: 0; overflow: hidden auto; overscroll-behavior: contain; scrollbar-width: none;
    border-radius: var(--win-radius);
    scroll-padding: calc(128 * var(--px)) 0 calc(48 * var(--px));
  }
  body[data-layout="orbit"][data-view="page"] main::-webkit-scrollbar { display: none; }
  /* The crisp artwork fills the window, under the page. */
  body[data-layout="orbit"][data-view="page"] .backdrop { inset: var(--win-t) var(--win-r) var(--win-b) var(--win-l); border-radius: var(--win-radius); }
}
body[data-layout="orbit"][data-view="page"] .view { padding: calc(128 * var(--px)) 0 calc(64 * var(--px)); animation: orbit-in 240ms var(--ease); }
@keyframes orbit-in { from { opacity: 0; transform: translateX(calc(24 * var(--px))); } to { opacity: 1; transform: none; } }

/* ---------- The environment: the artwork all round the window ---------- */
html[data-layout="orbit"] .environment { display: block; position: fixed; inset: 0; z-index: -2; overflow: hidden; pointer-events: none; }
html[data-layout="orbit"] body[data-view="player"] .environment { display: none; }
html[data-layout="orbit"] .environment canvas { position: absolute; inset: -4%; width: 108%; height: 108%; opacity: 0; transition: opacity 600ms var(--ease); }
html[data-layout="orbit"] .environment canvas.is-on { opacity: 1; }
html[data-layout="orbit"] .environment::after { content: ""; position: absolute; inset: 0; }

/* ---------- The mark, the floating menu and the clock ---------- */
body[data-layout="orbit"] .app-header { position: fixed; inset: 0; z-index: 40; pointer-events: none; }
body[data-layout="orbit"] .nav { display: block; height: 0; }
body[data-layout="orbit"] .nav > * { pointer-events: auto; }
/* While the remote is in the menu the page dims a little. */
body[data-layout="orbit"] .app-header::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 220ms var(--ease);
  background: linear-gradient(90deg, rgba(4, 4, 14, 0.6) 0%, rgba(4, 4, 14, 0.3) 22%, rgba(4, 4, 14, 0.28) 34%);
}
html.menu-open body[data-layout="orbit"] .app-header::before { opacity: 1; }
body[data-layout="orbit"] .brand {
  position: fixed; z-index: 2; top: calc(44 * var(--px)); left: calc((var(--win-l) - 48 * var(--px)) / 2);
  display: flex; align-items: center; gap: calc(14 * var(--px)); padding: 0;
}
body[data-layout="orbit"] .brand .logo-mark svg { width: calc(48 * var(--px)); height: calc(48 * var(--px)); }
body[data-layout="orbit"] .brand-name { display: none; font-size: calc(26 * var(--px)); font-weight: 600; }
html.menu-open body[data-layout="orbit"] .brand-name { display: inline; }
body[data-layout="orbit"] .orbit-menu {
  position: fixed; z-index: 2; top: 50%; left: calc((var(--win-l) - var(--menu-w)) / 2); transform: translateY(-50%);
  width: var(--menu-w); max-height: calc(100vh - 220 * var(--px)); overflow: hidden auto; scrollbar-width: none;
  display: flex; flex-direction: column; gap: calc(8 * var(--px)); margin: 0; padding: calc(12 * var(--px)); list-style: none;
  border-radius: calc(44 * var(--px));
  transition: width 220ms var(--ease), padding 220ms var(--ease);
}
body[data-layout="orbit"] .orbit-menu::-webkit-scrollbar { display: none; }
body[data-layout="orbit"] .orbit-menu > li { flex: none; }
body[data-layout="orbit"] .orbit-menu .nav-link {
  position: relative; height: max(44px, calc(64 * var(--px))); padding: 0 calc(19 * var(--px)); gap: calc(16 * var(--px));
  border-radius: 999px; font-size: var(--t-body); overflow: hidden;
}
body[data-layout="orbit"] .orbit-menu .nav-link .icon { flex: none; width: calc(26 * var(--px)); height: calc(26 * var(--px)); }
body[data-layout="orbit"] .orbit-menu .nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity 220ms var(--ease); }
/* Open (the remote is in it) or under a mouse: it grows and shows the names. */
html.menu-open body[data-layout="orbit"] .orbit-menu, body[data-layout="orbit"] .orbit-menu:hover { width: var(--menu-open-w); padding: calc(14 * var(--px)); }
html.menu-open body[data-layout="orbit"] .orbit-menu .nav-label, body[data-layout="orbit"] .orbit-menu:hover .nav-label { opacity: 1; }
body[data-layout="orbit"] .orbit-divider { height: 1px; margin: calc(6 * var(--px)) calc(16 * var(--px)); }
/* The page you're on: a small dot. */
body[data-layout="orbit"] .orbit-menu .nav-link[aria-current="page"]::after {
  content: ""; position: absolute; top: calc(10 * var(--px)); right: calc(8 * var(--px)); width: calc(8 * var(--px)); height: calc(8 * var(--px)); border-radius: 50%;
}
html.menu-open body[data-layout="orbit"] .orbit-menu .nav-link[aria-current="page"]::after,
body[data-layout="orbit"] .orbit-menu:hover .nav-link[aria-current="page"]::after { top: calc(50% - 4 * var(--px)); right: calc(22 * var(--px)); }
body[data-layout="orbit"] .orbit-cluster {
  position: fixed; z-index: 2; top: calc(var(--win-t) + 36 * var(--px)); right: calc(var(--win-r) + 52 * var(--px));
  display: flex; align-items: center; gap: calc(16 * var(--px)); height: max(44px, calc(56 * var(--px))); padding: 0 calc(8 * var(--px)) 0 calc(24 * var(--px)); border-radius: 999px;
}
body[data-layout="orbit"] .orbit-cluster .nav-clock { padding: 0; flex-direction: row; font-size: var(--t-meta); }
body[data-layout="orbit"] .orbit-cluster .nav-clock-date { display: none; }
body[data-layout="orbit"] .orbit-tool { display: none; }
body[data-layout="orbit"] .orbit-profile { display: grid; border-radius: 50%; }
body[data-layout="orbit"] .orbit-profile .avatar { width: max(32px, calc(40 * var(--px))); height: max(32px, calc(40 * var(--px))); border-radius: 50%; font-size: max(14px, calc(18 * var(--px))); }

/* ---------- Phones and portrait screens: no frame; the menu is a dock at the bottom ---------- */
@media not all and (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"] { --gutter: 20px; }
  body[data-layout="orbit"].signed-in main { padding-bottom: calc(96px + env(safe-area-inset-bottom)); }
  body[data-layout="orbit"][data-view="page"] .view { padding-top: calc(72px + env(safe-area-inset-top)); }
  body[data-layout="orbit"] .backdrop { inset: 0 0 auto 0; height: 64vh; }
  html[data-layout="orbit"] .environment canvas { display: none; }
  body[data-layout="orbit"] .brand, body[data-layout="orbit"] .app-header::before { display: none; }
  body[data-layout="orbit"] .orbit-menu {
    top: auto; bottom: calc(14px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%);
    width: max-content; max-width: calc(100vw - 24px); max-height: none; flex-direction: row; overflow: auto hidden; padding: 8px; gap: 4px; border-radius: 999px;
  }
  html.menu-open body[data-layout="orbit"] .orbit-menu, body[data-layout="orbit"] .orbit-menu:hover { width: max-content; padding: 8px; }
  body[data-layout="orbit"] .orbit-menu .nav-link { height: 48px; padding: 0 14px; gap: 8px; }
  body[data-layout="orbit"] .orbit-menu .nav-link .icon { width: 22px; height: 22px; }
  body[data-layout="orbit"] .orbit-menu .nav-label { display: none; opacity: 1; }
  body[data-layout="orbit"] .orbit-menu .nav-link[aria-current="page"] .nav-label { display: inline; }
  body[data-layout="orbit"] .orbit-menu .nav-link[aria-current="page"]::after { display: none; }
  body[data-layout="orbit"] .orbit-extra { display: none; }
  body[data-layout="orbit"] .orbit-cluster { top: calc(12px + env(safe-area-inset-top)); right: 12px; height: 48px; padding: 0 4px; gap: 4px; }
  body[data-layout="orbit"] .orbit-cluster .nav-clock { display: none; }
  body[data-layout="orbit"] .orbit-tool { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; }
}
```

- [ ] **Step 8: Append the shell's look to `themes/orbit/theme.css`**

```css
/* ---------- The window, and the environment around it ---------- */
.backdrop {
  background: radial-gradient(80% 70% at 85% 0%, color-mix(in srgb, var(--tint) 16%, transparent), transparent 70%), #0a0a18;
  box-shadow: 0 calc(50 * var(--px)) calc(120 * var(--px)) rgba(0, 0, 0, 0.65);
}
.backdrop img { object-position: 70% 30%; transform: none; filter: none; transition: opacity 600ms var(--ease); }
.backdrop::after {
  border-radius: inherit;
  background:
    linear-gradient(90deg, rgba(4, 4, 14, 0.92) 0%, rgba(4, 4, 14, 0.62) 34%, rgba(4, 4, 14, 0) 62%),
    linear-gradient(0deg, rgba(4, 4, 14, 0.96) 0%, rgba(4, 4, 14, 0.7) 28%, rgba(4, 4, 14, 0) 54%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.environment { background: radial-gradient(60% 55% at 50% 45%, color-mix(in srgb, var(--tint) 20%, transparent), transparent 75%), #05050c; }
.environment::after { background: radial-gradient(120% 90% at 50% 40%, rgba(5, 5, 12, 0) 40%, rgba(5, 5, 12, 0.75) 100%), rgba(5, 5, 12, 0.5); }
@media not all and (min-width: 1000px) and (orientation: landscape) {
  .backdrop { box-shadow: none; }
  .backdrop::after { background: linear-gradient(0deg, #05050c 0%, rgba(5, 5, 12, 0.55) 45%, rgba(5, 5, 12, 0.1) 80%); box-shadow: none; }
}

/* ---------- Menu and clock: tinted and clear glass ---------- */
.orbit-menu {
  background: var(--glass-tinted);
  -webkit-backdrop-filter: var(--blur-tinted);
  backdrop-filter: var(--blur-tinted);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 var(--glass-highlight), var(--glass-shadow);
}
.orbit-menu .nav-link { color: rgba(255, 255, 255, 0.82); font-weight: 600; transition: background-color var(--select), color var(--select); }
.orbit-menu .nav-link:hover { color: #ffffff; background: rgba(255, 255, 255, 0.14); }
.orbit-menu .nav-link[aria-current="page"] { color: #ffffff; background: rgba(255, 255, 255, 0.12); }
.orbit-menu .nav-link[aria-current="page"] .icon { color: inherit; }
.orbit-menu .nav-link[aria-current="page"]::after { background: var(--accent); }
.orbit-menu .nav-link:focus-visible { color: #0b0b16; background: #ffffff; box-shadow: 0 calc(10 * var(--px)) calc(30 * var(--px)) rgba(0, 0, 0, 0.35); }
.orbit-divider { background: rgba(255, 255, 255, 0.12); }
.orbit-cluster {
  background: var(--glass-clear);
  -webkit-backdrop-filter: var(--blur-clear);
  backdrop-filter: var(--blur-clear);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  color: #ffffff;
}
.orbit-cluster .nav-clock { color: #ffffff; font-weight: 500; }
.orbit-tool { color: #ffffff; }
.orbit-profile:focus-visible, .orbit-tool:focus-visible { box-shadow: var(--ring); }
.brand { --logo-a: #8fe9ff; --logo-b: var(--tint); color: #ffffff; }
```

- [ ] **Step 9: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs foundations shell`
Expected: all `PASS`. Look at `/tmp/shots/orbit/shell-settings-tv.png`, `shell-laptop.png` and `shell-phone.png` with the Read tool; the window, menu and cluster should match the `NavLeft`, `ShellLaptop` and `ShellPhone` boards.

- [ ] **Step 10: Checkpoint**

`npm test` green. Files changed:
- JS: `public/js/shell.js`, `public/js/app.js`, `public/js/backdrop.js`
- CSS: `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css`
- devtools: `orbit-ui.mjs`

---

### Task 6: The remote and the menu; Back on Home

**Files:**
- Modify: `public/js/nav.js` (menu handling, Back closes dialogs, rows keep the selection at the left)
- Modify: `public/js/app.js` (configure navigation per layout; Back on Home)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `remote` section)

**Interfaces:**
- Consumes:
  - `menuKey`, `menuStep`, `sameLine`, `homeBack`, `FRAME_QUERY` (Task 4);
  - `ul.orbit-menu` (Task 5), and `pageScroller()` and `framed` in app.js (Task 5).
- Produces (`nav.js` exports):
  - `configureNavigation({ menu?: HTMLElement|null, rowAlign?: 'nearest'|'start' })`;
  - `openMenu(from?: Element) → boolean`, `closeMenu()`, `menuIsOpen() → boolean`.
  - `html.menu-open` while the remote is in the menu.

- [ ] **Step 1: Write the failing "remote" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('remote')) {
  const menuOpen = () => page.evaluate(() => document.documentElement.classList.contains('menu-open'));
  await go(page, '#/', '.home-view');
  await press(page, 'ArrowUp');
  let a = await active(page);
  check('the remote starts on the main button', /btn-primary/.test(a.cls), JSON.stringify(a));
  const start = a.text;
  await press(page, 'ArrowLeft');
  await page.waitForTimeout(300);
  a = await active(page);
  check('Left from the leftmost button enters the menu, on the current page', a.nav === 'home', JSON.stringify(a));
  check('…the menu grows to show names', (await menuOpen()) && (await rect(page, '.orbit-menu')).w === 300, JSON.stringify(await rect(page, '.orbit-menu')));
  check('…and the page dims', (await style(page, '.app-header', 'opacity', '::before')) === '1');
  await press(page, 'ArrowDown');
  a = await active(page);
  check('Down moves to the next entry', Boolean(a.nav?.startsWith('lib-')), JSON.stringify(a));
  await press(page, 'ArrowUp', 'ArrowUp');
  check('Up stops at the top', (await active(page)).nav === 'home');
  await press(page, 'ArrowLeft');
  check('Left in the menu stays put', (await active(page)).nav === 'home' && (await menuOpen()));
  await press(page, 'ArrowRight');
  a = await active(page);
  check('Right leaves the menu and puts the remote back', a.text === start && !(await menuOpen()), JSON.stringify(a));
  await press(page, 'ArrowLeft', 'Backspace');
  check('Back leaves the menu too', (await active(page)).text === start && !(await menuOpen()));
  await press(page, 'ArrowLeft', 'ArrowDown', 'Enter');
  await page.waitForSelector('.library-results');
  await page.waitForTimeout(500);
  check('OK opens that page', /#\/library\/\d+/.test(page.url()), page.url());
  check('…and the menu closes', !(await menuOpen()));
  // Inside a row, Left goes to the previous card (review focus 3).
  await go(page, '#/', '.home-view');
  await press(page, 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowRight');
  const before = await active(page);
  await press(page, 'ArrowLeft');
  a = await active(page);
  check('Left inside a row moves to the previous card', /card/.test(a.cls) && a.text !== before.text && !(await menuOpen()), JSON.stringify([before, a]));
  // Back on Home: to the top first, then into the menu.
  await press(page, 'Backspace');
  a = await active(page);
  check('Back on Home first goes back to the top', /btn-primary/.test(a.cls), JSON.stringify(a));
  await press(page, 'Backspace');
  check('…then opens the menu', (await active(page)).nav === 'home' && (await menuOpen()));
  await press(page, 'ArrowRight');
  // Rows scroll so the selected card stays at the left. The dev rows are short, so make one long.
  await page.evaluate(() => {
    const s = document.querySelector('.row-square');
    const cards = [...s.children];
    for (let i = 0; i < 4; i++) for (const c of cards) s.append(c.cloneNode(true));
    s.querySelector('.card').focus();
  });
  await press(page, 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight');
  await page.waitForTimeout(700);
  const pos = await page.evaluate(() => {
    const s = document.querySelector('.row-square');
    return { scrolled: Math.round(s.scrollLeft), left: Math.round(document.activeElement.getBoundingClientRect().left - s.getBoundingClientRect().left) };
  });
  check('rows scroll so the selected card stays at the left', pos.scrolled > 0 && pos.left < 200, JSON.stringify(pos));
  // Left must not open the menu in a text field or a dialog (review focus 3).
  await go(page, '#/search', '.search-box');
  await page.focus('.search-input');
  await page.keyboard.type('te');
  await press(page, 'ArrowLeft');
  check('Left in a text field moves the cursor, not into the menu', /search-input/.test((await active(page)).cls) && !(await menuOpen()));
  await page.evaluate(() => {
    import('/js/components.js').then((c) => c.confirmDialog('A question', 'Stay here?'));
  });
  await page.waitForSelector('dialog[open]');
  await press(page, 'Tab', 'ArrowLeft');
  check('Left inside a dialog stays in the dialog', (await page.evaluate(() => document.querySelector('dialog[open]').contains(document.activeElement))) && !(await menuOpen()));
  await press(page, 'Backspace');
  check("the remote's Back closes a dialog", !(await page.$('dialog[open]')));
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs remote`
Expected: FAIL from `Left from the leftmost button enters the menu`. Spatial navigation today moves to a menu entry but doesn't open the menu, and focus doesn't go back on Right. `Back on Home first goes back to the top` fails too (Back goes to the previous page), and so does `the remote's Back closes a dialog`.

- [ ] **Step 3: Teach `nav.js` about the menu**

At the top of `public/js/nav.js`, after the comment block, add:

```js
import { menuKey, menuStep, sameLine, FRAME_QUERY } from './orbit-rules.js';
```

After `focusFirst()` (before `initNavigation`), add:

```js
// ---- Orbit's floating menu ----
// Left from the leftmost control enters it (it grows to show names), Up/Down move, OK opens,
// Right or Back leave and put the remote back where it was. Phones use it as a dock instead.
const BACK_KEYS = ['BrowserBack', 'GoBack', 'Backspace'];
const framed = matchMedia(FRAME_QUERY);
let menuEl = null;
let rowInline = 'nearest';
let returnTo = null;

/** Layout-specific behaviour: Orbit's menu list (null for layouts without one) and how rows follow the selection. */
export function configureNavigation({ menu = null, rowAlign = 'nearest' } = {}) {
  if (menuEl && menuEl !== menu) document.documentElement.classList.remove('menu-open');
  menuEl = menu;
  rowInline = rowAlign;
}
const floatingMenu = () => (menuEl?.isConnected && framed.matches ? menuEl : null);
const menuItems = () => [...(floatingMenu()?.querySelectorAll(FOCUSABLE) || [])].filter(visible);
export const menuIsOpen = () => document.documentElement.classList.contains('menu-open');

/** Put the remote in the menu, on the page you're on. Remembers where it came from. */
export function openMenu(from = document.activeElement) {
  const items = menuItems();
  if (!items.length) return false;
  if (from && from !== document.body && !menuEl.contains(from)) returnTo = from;
  document.documentElement.classList.add('menu-open');
  (items.find((a) => a.getAttribute('aria-current') === 'page') || items[0]).focus({ preventScroll: true });
  return true;
}

/** Leave the menu and put the remote back where it was. */
export function closeMenu() {
  document.documentElement.classList.remove('menu-open');
  const target = returnTo;
  returnTo = null;
  if (target?.isConnected && visible(target)) target.focus({ preventScroll: true });
  else focusFirst(document.querySelector('main') || document);
}

/** An arrow or Back press that involves the menu. Returns true when it was used. */
function menuKeys(e, key, active) {
  const menu = floatingMenu();
  if (!menu || scopeRoot() !== document) return false;
  const inMenu = menu.contains(active);
  let leftTarget = 'none';
  if (!inMenu) {
    if (key !== 'left' || !active?.matches?.(FOCUSABLE)) return false;
    const next = findNext(active, 'left', document);
    if (next) leftTarget = menu.contains(next) ? 'menu' : sameLine(active.getBoundingClientRect(), next.getBoundingClientRect()) ? 'page' : 'none';
  }
  const action = menuKey({ key, inMenu, leftTarget });
  if (!action || (action === 'enter' && !openMenu(active))) return false;
  if (action === 'move') {
    const items = menuItems();
    const next = items[menuStep(items.length, items.indexOf(active), key)];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }
  if (action === 'leave') closeMenu();
  e.preventDefault();
  return true;
}
```

Replace the whole `initNavigation()` function with:

```js
export function initNavigation({ onBack }) {
  window.addEventListener('pointerdown', () => {
    keyboardMode = false;
    document.documentElement.classList.remove('kbd');
  }, { passive: true });
  // Clicking or tabbing somewhere else closes the menu.
  document.addEventListener('focusin', (e) => {
    if (menuIsOpen() && !menuEl?.contains(e.target)) {
      document.documentElement.classList.remove('menu-open');
      returnTo = null;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (dir || e.key === 'Tab') {
      keyboardMode = true;
      document.documentElement.classList.add('kbd');
    }
    if (document.body.dataset.view === 'player') return; // the player handles its own keys
    const active = document.activeElement;

    if (dir) {
      if (isTyping(active) && (dir === 'left' || dir === 'right' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
      if (active?.type === 'range' && (dir === 'left' || dir === 'right')) return; // sliders use left/right; up/down leaves them
      if (menuKeys(e, dir, active)) return;
      const root = scopeRoot();
      if (!active || active === document.body || active.id === 'main' || !active.matches(FOCUSABLE) || !root.contains(active)) {
        e.preventDefault();
        focusFirst(root === document ? document.querySelector('main') || document : root);
        return;
      }
      const next = findNext(active, dir, root);
      if (next) {
        e.preventDefault();
        next.focus({ preventScroll: true });
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Orbit: moving along a row scrolls it so the selected card stays at the left.
        const inline = rowInline === 'start' && (dir === 'left' || dir === 'right') && next.closest('.row-scroller') ? 'start' : 'nearest';
        next.scrollIntoView({ block: 'nearest', inline, behavior: reduce ? 'auto' : 'smooth' });
      }
      return;
    }

    const back = BACK_KEYS.includes(e.key);
    if ((back || e.key === 'Escape') && menuIsOpen() && !isTyping(active) && menuKeys(e, 'back', active)) return;
    if (back && !isTyping(active)) {
      e.preventDefault();
      // The remote's Back closes a dialog first, as Esc does.
      const dialogs = document.querySelectorAll('dialog[open]');
      if (dialogs.length) dialogs[dialogs.length - 1].close('cancel');
      else onBack();
    }
  });
}
```

- [ ] **Step 4: Configure it per layout, and do Back on Home, in `app.js`**

- Imports: change the `nav.js` import to

```js
import { initNavigation, focusFirst, isKeyboardMode, configureNavigation, openMenu } from './nav.js';
```

  and the `orbit-rules.js` import to `import { FRAME_QUERY, homeBack } from './orbit-rules.js';`.
- In `renderNav()`'s Orbit branch, add after `renderOrbitNav(…);`:

```js
    configureNavigation({ menu: navEl.querySelector('.orbit-menu'), rowAlign: 'start' });
```

- On the line after the Orbit branch's closing `}` (before `clear(navEl);`), add `configureNavigation();`.
- Below `pageScroller()`, add:

```js
/** Back (the remote's Back, Backspace), once dialogs and the menu have had their turn. */
function onBackKey() {
  const onHome = parseHash().path === '/';
  const row = document.activeElement?.closest?.('.home-rows .row');
  const atTop = !row || row === main.querySelector('.home-rows .row');
  const action = homeBack({ hasMenu: isOrbit() && framed.matches, onHome, atTop });
  if (action === 'menu') openMenu();
  else if (action === 'top') {
    main.querySelector('.home-rows')?.scrollTo({ top: 0 });
    pageScroller().scrollTo(0, 0);
    focusFirst(main);
  } else goBack();
}
```

- In `boot()`, replace `initNavigation({ onBack: () => goBack() });` with `initNavigation({ onBack: onBackKey });`.

- [ ] **Step 5: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs foundations shell remote`
Expected: all `PASS`.

- [ ] **Step 6: Make sure the older layouts still navigate as before**

Run: `node /home/claude/devtools/regress.mjs 2>&1 | tail -15`
Expected: the checks that don't depend on Orbit markup still pass. Note the failures here; Task 16 goes through them. Anything about arrow keys in Midnight or Daylight must pass now; if it doesn't, fix it before moving on.

- [ ] **Step 7: Checkpoint, and show Dallas (controller)**

`npm test` green. Files: `public/js/nav.js`, `public/js/app.js`, devtools `orbit-ui.mjs`.

Stage 2 is done. Run `node /home/claude/devtools/orbit-ui.mjs shell`, then send Dallas these pictures with SendUserFile and one line:
- `/tmp/shots/orbit/shell-settings-tv.png`, `shell-laptop.png`, `shell-phone.png`;
- a TV picture of Home with the menu open: in the `remote` section, add `await page.screenshot({ path: '/tmp/shots/orbit/menu-open-tv.png' })` right after the `…and the page dims` check, and rerun `remote`.

Carry on. If he replies with changes, fold them in before Stage 3.

---

## Stage 3 — Home

### Task 7: Home: the top area, compact past the first row, card shapes and captions

**Files:**
- Modify: `public/js/views/home.js` (the `is-compact` class)
- Modify: `public/js/components.js` (`wideCaption`, used by `landscapeCard`)
- Modify: `public/css/app.css` (hide the Orbit caption in older themes)
- Modify: `public/css/orbit.css` (Home heights, card sizes)
- Modify: `themes/orbit/theme.css` (top area, rows, cards)
- Create: `test/cards.test.js`
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `home` section)

**Interfaces:**
- Consumes: `episodeLabel`, `formatRuntime` from `dom.js`; the tokens from Task 3.
- Produces:
  - `export function wideCaption(item) → { title: string, sub: string, left: string }` in `components.js`.
  - Wide cards carry `span.card-sub` (the classic caption) and `span.card-sub.card-sub-orbit` (the "time left" caption).
  - `.home-view.is-compact` while the remote is below the first row.
  - CSS variables `--poster-w`, `--wide-w` and `--square-w` on Orbit's body.

- [ ] **Step 1: Write the failing unit test**

`test/cards.test.js`:

```js
// Captions under wide cards (public/js/components.js). Older themes show "S1 · E4 · Title";
// Orbit shows how much is left ("S1 · E4, 23m left"), since the top area already names the episode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wideCaption } from '../public/js/components.js';

test('wide cards: the classic caption and the time-left caption', () => {
  const ep = { kind: 'episode', showTitle: 'Night Harbour', title: 'The Quiet Tide', season: 1, episode: 4, duration: 2880, progress: { position: 1500, duration: 2880, watched: false } };
  assert.deepEqual(wideCaption(ep), { title: 'Night Harbour', sub: 'S1 · E4 · The Quiet Tide', left: 'S1 · E4, 23m left' });
  const movie = { kind: 'movie', title: 'Northlight', year: 2022, duration: 6660, progress: { position: 1980, duration: 6660, watched: false } };
  assert.deepEqual(wideCaption(movie), { title: 'Northlight', sub: '2022', left: '1h 18m left' });
});

test('not started or already watched: no time left', () => {
  assert.deepEqual(wideCaption({ kind: 'movie', title: 'New', year: 2024 }), { title: 'New', sub: '2024', left: '2024' });
  assert.equal(wideCaption({ kind: 'episode', showTitle: 'S', title: 'Pilot', season: 2, episode: 1, duration: 600, progress: { position: 590, watched: true } }).left, 'S2 · E1');
  assert.equal(wideCaption({ kind: 'movie', title: 'Barely', year: 2020, duration: 600, progress: { position: 12 } }).left, '2020', 'under 30 seconds is not started');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd /home/claude/nodeflix && node --test test/cards.test.js 2>&1 | tail -4`
Expected: FAIL. `wideCaption` is not exported (`SyntaxError: … does not provide an export named 'wideCaption'`).

- [ ] **Step 3: Write `wideCaption` and use it in `landscapeCard`**

In `public/js/components.js`, above `landscapeCard`:

```js
/** Captions for a wide card: the classic line, and Orbit's "S1 · E4, 23m left" (its top area names the episode). */
export function wideCaption(item) {
  const isEp = item.kind === 'episode';
  const label = isEp ? episodeLabel(item) : '';
  const title = isEp ? item.showTitle || item.title : item.title;
  const sub = isEp ? `${label} · ${item.title}` : String(item.year || '');
  const p = item.progress;
  const dur = p?.duration || item.duration;
  const left = p && !p.watched && p.position > 30 && dur ? `${formatRuntime(Math.max(1, (dur - p.position) / 60))} left` : '';
  return { title, sub, left: isEp ? [label, left].filter(Boolean).join(', ') : left || sub };
}
```

In `landscapeCard`:
- Replace the two lines `const title = …` and `const sub = …` with `const cap = wideCaption(item);` and `const title = cap.title;`.
- Replace its `card-meta` line with:

```js
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, title), cap.sub ? h('span', { class: 'card-sub' }, cap.sub) : null, cap.left ? h('span', { class: 'card-sub card-sub-orbit' }, cap.left) : null),
```

Append to `public/css/app.css`:

```css
/* Orbit's "time left" caption on wide cards; older themes keep their own. */
.card-sub-orbit { display: none; }
```

Run: `node --test test/cards.test.js 2>&1 | tail -4` → `# pass 2`.

- [ ] **Step 4: Write the failing "home" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('home')) {
  const compact = () => page.evaluate(() => document.querySelector('.home-view').classList.contains('is-compact'));
  await go(page, '#/', '.home-view');
  await press(page, 'ArrowUp');
  const title = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.spot-title')); return { size: s.fontSize, weight: s.fontWeight }; });
  check('Home: a big, bold title', title.size === '116px' && title.weight === '700', JSON.stringify(title));
  check('Home: the main button is ready at the top', (await page.locator('.spot-actions .btn:visible').count()) >= 1);
  await press(page, 'ArrowDown');
  check('first row: the top area stays full', !(await compact()));
  await press(page, 'ArrowDown');
  await page.waitForTimeout(300);
  const small = await page.evaluate(() => ({ size: getComputedStyle(document.querySelector('.spot-title')).fontSize, buttons: getComputedStyle(document.querySelector('.spot-actions')).display }));
  check('past the first row the top area shrinks', (await compact()) && small.size === '76px' && small.buttons === 'none', JSON.stringify(small));
  const room = await page.evaluate(() => ({ rows: document.querySelector('.home-rows').getBoundingClientRect().height, poster: document.querySelector('.row-poster .card-art').getBoundingClientRect().height }));
  check('…making room for two rows', room.rows >= room.poster * 2, JSON.stringify(room));
  await press(page, 'ArrowUp', 'ArrowUp');
  check('moving back up restores it', !(await compact()));
  const wide = await page.evaluate(() => {
    const c = document.querySelector('.row-landscape .card');
    if (!c) return null;
    const r = c.querySelector('.card-art').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), caption: [...c.querySelectorAll('.card-meta > *')].filter((e) => e.offsetParent).map((e) => e.textContent) };
  });
  check('wide cards are 16:9 with a two-line caption', wide && wide.w === 336 && wide.h === 189 && wide.caption.length === 2, JSON.stringify(wide));
  check('…saying how much is left', Boolean(wide && /left$|^S\d/.test(wide.caption[1])), JSON.stringify(wide));
  const poster = await page.evaluate(() => {
    const c = document.querySelector('.row-poster .card');
    const r = c.querySelector('.card-art').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), meta: getComputedStyle(c.querySelector('.card-meta')).display };
  });
  check('posters are 2:3 with no caption on Home', poster.w === 196 && poster.h === 294 && poster.meta === 'none', JSON.stringify(poster));
  check('albums show the album and artist', await page.evaluate(() => getComputedStyle(document.querySelector('.row-square .card-meta')).display !== 'none'));
  await page.evaluate(() => document.querySelector('.row-poster .card').focus());
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => { const s = getComputedStyle(document.activeElement.querySelector('.card-art')); return { t: s.transform, sh: s.boxShadow }; });
  check('a selected card grows', /^matrix\(1\.08, 0, 0, 1\.08/.test(sel.t), sel.t);
  check('…with the white ring', /rgb\(255, 255, 255\) 0px 0px 0px 9px/.test(sel.sh), sel.sh);
  check('nothing inside the rows is blurred', (await blurred(page, '.home-rows')) === 0, String(await blurred(page, '.home-rows')));
  await page.screenshot({ path: '/tmp/shots/orbit/home-tv.png' });
  // Review focus 4: a very long title stops at two lines and stays inside the window.
  const long = await page.evaluate(() => {
    const t = document.querySelector('.spot-title');
    const old = t.textContent;
    document.querySelector('.spot-inner').classList.remove('has-logo');
    t.textContent = 'The Extraordinarily Long and Winding Title of a Film That Nobody Can Say in One Breath';
    const lh = parseFloat(getComputedStyle(t).lineHeight);
    const r = t.getBoundingClientRect();
    const win = document.querySelector('main').getBoundingClientRect();
    t.textContent = old;
    return { h: r.height, lh, inside: r.right <= win.right && r.top >= win.top };
  });
  check('long titles stop at two lines, inside the window', long.h <= long.lh * 2 + 2 && long.inside, JSON.stringify(long));
}
```

- [ ] **Step 5: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs home`
Expected: FAIL on the title size, `past the first row the top area shrinks`, the card sizes, the white ring on cards, and `nothing inside the rows is blurred` (`.card-play` and `.badge-watched` blur today).

- [ ] **Step 6: Make the top area shrink past the first row**

In `public/js/views/home.js`, after `el.append(h('div', { class: 'home-rows' }, rows));`:

```js
  // Orbit: past the first row the top area gets smaller so two rows fit; moving back up restores it.
  // (Other themes have no styles for .is-compact.)
  const rowEls = [...rows.querySelectorAll(':scope > .row')];
  el.addEventListener('focusin', (e) => el.classList.toggle('is-compact', rowEls.indexOf(e.target.closest?.('.row')) > 0));
```

- [ ] **Step 7: Append the Home structure to `public/css/orbit.css`**

```css
/* ---------- Home and rows ---------- */
body[data-layout="orbit"] { --poster-w: calc(196 * var(--px)); --card-w: var(--poster-w); --wide-w: calc(336 * var(--px)); --square-w: calc(220 * var(--px)); }
body[data-layout="orbit"] .row-poster { grid-auto-columns: var(--poster-w); }
body[data-layout="orbit"] .row-landscape { grid-auto-columns: var(--wide-w); }
body[data-layout="orbit"] .row-square { grid-auto-columns: var(--square-w); }
body[data-layout="orbit"] .grid-poster { grid-template-columns: repeat(auto-fill, minmax(var(--poster-w), 1fr)); }
body[data-layout="orbit"] .grid-square { grid-template-columns: repeat(auto-fill, minmax(var(--square-w), 1fr)); }
body[data-layout="orbit"] .grid-landscape { grid-template-columns: repeat(auto-fill, minmax(var(--wide-w), 1fr)); }
body[data-layout="orbit"] .rows { gap: calc(30 * var(--px)); padding-top: 0; }
/* Room above and below for a selected card: it grows 8% and gets a 9px ring. */
body[data-layout="orbit"] .row-scroller { gap: calc(24 * var(--px)); padding-top: calc(22 * var(--px)); padding-bottom: calc(24 * var(--px)); }
@media (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"][data-view="page"] .home-view:not(.no-spotlight) { --spot-h: calc(600 * var(--px)); height: 100%; padding: 0; }
  body[data-layout="orbit"][data-view="page"] .home-view.is-compact:not(.no-spotlight) { --spot-h: calc(340 * var(--px)); }
  body[data-layout="orbit"] .home-view:not(.no-spotlight) .spotlight { padding: calc(96 * var(--px)) var(--gutter) calc(16 * var(--px)); }
  body[data-layout="orbit"] .home-view:not(.no-spotlight) .home-rows { -webkit-mask-image: none; mask-image: none; scroll-padding: calc(8 * var(--px)) 0 calc(24 * var(--px)); padding-bottom: calc(48 * var(--px)); }
  body[data-layout="orbit"] .home-view:not(.no-spotlight) .row-square .card-meta { display: flex; }
}
@media not all and (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"] { --poster-w: 116px; --wide-w: 240px; --square-w: 132px; }
  body[data-layout="orbit"] .home-view:not(.no-spotlight) { height: auto; display: block; overflow: visible; }
  body[data-layout="orbit"] .home-view:not(.no-spotlight) .home-rows { overflow: visible; -webkit-mask-image: none; mask-image: none; }
}
```

- [ ] **Step 8: Append the Home look to `themes/orbit/theme.css`**

```css
/* ---------- Home: the top area ---------- */
.spot-inner { max-width: calc(1100 * var(--px)); }
.spot-title { font-size: var(--t-display); font-weight: 700; line-height: 0.95; letter-spacing: -0.045em; margin: 0 0 calc(24 * var(--px)); -webkit-line-clamp: 2; }
.spot-logo { max-width: calc(620 * var(--px)); max-height: calc(170 * var(--px)); margin-bottom: calc(22 * var(--px)); }
.spot-inner.has-logo .spot-title.is-episode { font-size: calc(40 * var(--px)); }
.spot-meta .meta-line { margin-bottom: calc(16 * var(--px)); }
.spot-genres { font-size: var(--t-meta); font-weight: 500; color: var(--text-soft); margin-bottom: calc(12 * var(--px)); }
.spot-overview { font-size: var(--t-body); line-height: 1.5; color: rgba(230, 233, 255, 0.8); max-width: calc(760 * var(--px)); -webkit-line-clamp: 2; margin-bottom: 0; }
.spot-resume { margin: calc(16 * var(--px)) 0 0; font-size: var(--t-meta); color: var(--text-soft); }
.spot-resume-track { width: calc(220 * var(--px)); height: calc(5 * var(--px)); background: rgba(255, 255, 255, 0.28); }
.spot-resume-track span { background: var(--accent); }
.spot-actions { margin-top: calc(30 * var(--px)); gap: calc(18 * var(--px)); }
/* Past the first row: a smaller title, no buttons, one line of story. */
.home-view.is-compact .spot-title { font-size: var(--t-title); line-height: 1; letter-spacing: -0.04em; -webkit-line-clamp: 1; margin-bottom: calc(18 * var(--px)); }
.home-view.is-compact .spot-logo { max-height: calc(96 * var(--px)); }
.home-view.is-compact .spot-overview { -webkit-line-clamp: 1; }
.home-view.is-compact :is(.spot-actions, .spot-genres, .spot-resume) { display: none; }

/* ---------- Rows and cards ---------- */
.row-title { font-size: var(--t-section); font-weight: 600; margin-bottom: 0; }
.row-title-link .icon { color: var(--accent); }
.art, .card-art { border-radius: calc(18 * var(--px)); }
.art { background: rgba(255, 255, 255, 0.06); }
.card { gap: 0; }
.card-art { box-shadow: 0 calc(14 * var(--px)) calc(30 * var(--px)) rgba(0, 0, 0, 0.45); transition: transform var(--select), box-shadow var(--select); }
.card:hover .card-art { transform: scale(1.04); box-shadow: var(--lift); }
.card:focus-visible { box-shadow: none; }
.card:focus-visible .card-art, html.kbd .card:focus-visible .card-art { transform: scale(var(--grow-card)); box-shadow: var(--ring), var(--lift); }
.card-meta { gap: calc(4 * var(--px)); padding: calc(14 * var(--px)) 0 0; }
.card-title { font-size: max(12px, calc(19 * var(--px))); font-weight: 600; }
.card-sub { font-size: var(--t-caption); color: rgba(226, 230, 255, 0.66); }
.landscape-card .card-sub:not(.card-sub-orbit) { display: none; }
.landscape-card .card-sub-orbit { display: block; }
.progress { left: calc(14 * var(--px)); right: calc(14 * var(--px)); bottom: calc(12 * var(--px)); height: max(3px, calc(5 * var(--px))); background: rgba(255, 255, 255, 0.28); }
.progress span { background: var(--accent); }
.badge { background: #ffffff; color: #0b0b16; }
/* Nothing in a scrolling row is blurred: glass there would be redrawn on every scroll. */
.badge-watched { background: rgba(255, 255, 255, 0.9); color: #0b0b16; -webkit-backdrop-filter: none; backdrop-filter: none; }
.card-play { background: rgba(4, 4, 14, 0.55); -webkit-backdrop-filter: none; backdrop-filter: none; }
.card-tag { border-radius: calc(7 * var(--px)); background: rgba(4, 4, 14, 0.7); font-size: var(--t-caption); }
```

- [ ] **Step 9: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs home remote` and `cd /home/claude/nodeflix && npm test 2>&1 | tail -3`
Expected: all `PASS`; `# fail 0`. Compare `/tmp/shots/orbit/home-tv.png` with the `NavLeft` and `HomeRows` boards.

- [ ] **Step 10: Checkpoint, and show Dallas (controller)**

Files changed:
- `public/js/views/home.js`, `public/js/components.js`
- `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css`
- `test/cards.test.js`, devtools `orbit-ui.mjs`

Stage 3 is done. Send Dallas `/tmp/shots/orbit/home-tv.png` plus a compact-state picture, taken by adding `await page.screenshot({ path: '/tmp/shots/orbit/home-compact-tv.png' })` right after the `…making room for two rows` check. Carry on.

---

## Stage 4 — Show, movie and album pages

### Task 8: The "…" menu (a small glass sheet) on detail pages

**Files:**
- Modify: `public/js/components.js` (`openSheet`, `moreButton`)
- Modify: `public/js/music.js:745-773` (`trackMenu` uses `openSheet`)
- Modify: `public/js/views/item.js` (Orbit's actions; the intro line's Edit button)
- Modify: `themes/orbit/theme.css` (dialogs and sheets)
- Modify: `/home/claude/devtools/extras-ui.mjs` (the intro editor moved into "…" in Orbit)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `more` section)

**Interfaces:**
- Consumes: `openDialog`, `button` (components.js); `isOrbit`, `canAdmin`, `isKidsProfile` (app.js).
- Produces:
  - `openSheet(title: string, items: ({label, icon, onSelect} | {label, icon, href, download?})[]) → Promise<string>`. Falsy items are skipped, the first item gets the focus, and choosing one closes the sheet.
  - `moreButton(title: string, items) → HTMLButtonElement`: a round button with `aria-label="More"` and `aria-haspopup="dialog"`.
  - `introLine(item, markers, { edit = true } = {})` in `item.js`.

- [ ] **Step 1: Write the failing "more" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('more')) {
  await go(page, '#/item/3', '.detail-info');
  const more = page.locator('.detail-info .actions button[aria-label="More"]');
  check('a movie has a round … button', (await more.count()) === 1);
  check('…and no loose admin buttons', (await page.locator('.detail-info .actions :text("Refresh info")').count()) === 0);
  await press(page, 'ArrowUp');
  await more.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open] .sheet');
  const items = await page.$$eval('dialog[open] .sheet-item', (a) => a.map((x) => x.textContent.trim()));
  check('… holds Refresh info, Fix match and Download', items.join() === 'Refresh info,Fix match,Download', items.join());
  check('…with the first one selected', (await active(page)).text === 'Refresh info');
  const sheet = await rect(page, 'dialog[open]');
  check('…in a small glass panel', sheet.w <= 520 && (await style(page, 'dialog[open]', 'backdropFilter')) !== 'none', JSON.stringify(sheet));
  await page.screenshot({ path: '/tmp/shots/orbit/more-menu-tv.png' });
  await press(page, 'Backspace');
  check('Back closes it and the remote is on … again', (await active(page)).label === 'More' && !(await page.$('dialog[open]')));
  const ep = (await api(page, 'GET', '/api/items/4')).nextEpisode;
  await go(page, `#/item/${ep.id}`, '.detail-info');
  await page.click('.detail-info button[aria-label="More"]');
  await page.waitForSelector('dialog[open] .sheet');
  check("an episode's … also has Edit intro", (await page.locator('dialog[open] .sheet-item:has-text("Edit intro")').count()) === 1);
  check('…and the intro line has no Edit button of its own', (await page.locator('.intro-line button').count()) === 0);
  await press(page, 'Escape');
  await go(page, '#/item/15', '.tracks');
  await page.click('.detail-info button[aria-label="More"]');
  await page.waitForSelector('dialog[open] .sheet');
  check("an album's … has Refresh info", (await page.locator('dialog[open] .sheet-item:has-text("Refresh info")').count()) === 1);
  await press(page, 'Escape');
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs more`
Expected: FAIL on `a movie has a round … button` (count 0); the later steps time out waiting for `.sheet`. That is the red state. Stop the run with Ctrl-C if it hangs longer than 30 s.

- [ ] **Step 3: Add `openSheet` and `moreButton`**

In `public/js/components.js`, after `confirmDialog()`:

```js
/**
 * A short list of actions in a small panel: the "…" menu, a song's menu. Items are
 * { label, icon, onSelect } or, for links, { label, icon, href, download }. Falsy items are skipped;
 * the first one has the focus, and choosing one closes the panel.
 */
export function openSheet(title, items) {
  const entry = (it, i) => {
    const content = [icon(it.icon, { size: 22 }), h('span', {}, it.label)];
    const close = (e) => e.currentTarget.closest('dialog')?.close('done');
    if (it.href) return h('a', { class: 'sheet-item', href: it.href, download: it.download || null, 'data-autofocus': i === 0 || null, onClick: close }, content);
    return h('button', { type: 'button', class: 'sheet-item', 'data-autofocus': i === 0 || null, onClick: (e) => (close(e), it.onSelect()) }, content);
  };
  return openDialog({ title, body: h('div', { class: 'sheet' }, items.filter(Boolean).map(entry)), actions: [] });
}

/** A round "…" button that opens `items` in a sheet (see openSheet). */
export function moreButton(title, items) {
  return button('', { icon: 'more', title: 'More', onClick: () => openSheet(title, items), attrs: { 'aria-haspopup': 'dialog' } });
}
```

In `public/js/music.js`, add `openSheet` to the import from `./components.js`, and replace `trackMenu()` with:

```js
function trackMenu(t) {
  openSheet(t.title, [
    { label: 'Play now', icon: 'play', onSelect: () => music.playTracks([t], 0) },
    { label: 'Play next', icon: 'queue', onSelect: () => music.playNext([t]) },
    { label: 'Add to queue', icon: 'plus', onSelect: () => music.addToQueue([t]) },
    t.parentId ? { label: 'Go to album', icon: 'album', onSelect: () => (location.hash = `#/item/${t.parentId}?track=${t.id}`) } : null,
    t.showId ? { label: 'Go to artist', icon: 'user', onSelect: () => (location.hash = `#/item/${t.showId}`) } : null,
  ]);
}
```

If `openDialog` is no longer used anywhere else in `music.js` (check with `grep -n openDialog public/js/music.js`), remove it from that import.

- [ ] **Step 4: Put the less-used actions in "…" on Orbit's detail pages**

In `public/js/views/item.js`:
- Add `moreButton` to the `components.js` import, `followFocus` to the `backdrop.js` import (Task 9 uses it), and `isOrbit` to the `app.js` import.
- Replace `introLine` with:

```js
/** Admins: where this episode's intro is, and (older themes) a way to fix it. Orbit keeps Edit intro in "…". */
function introLine(item, markers, { edit = true } = {}) {
  const m = markers?.intro;
  const text = !m ? 'Intro not found yet' : m.none ? 'No intro' : `Intro ${formatClock(m.start)}–${formatClock(m.end)} · ${INTRO_SOURCE[m.source] || ''}`;
  return h('p', { class: 'intro-line muted' }, h('span', {}, text), edit ? button('Edit', { icon: 'edit', variant: 'ghost', onClick: () => introDialog(item, m) }) : null);
}
```

- After `adminMenu()`, add:

```js
/** Orbit's round "…" button: the less-used actions (Refresh info, Fix match, Download, Edit intro). */
function moreItems(item, markers) {
  const items = [];
  if (canAdmin()) {
    items.push({
      label: 'Refresh info',
      icon: 'refresh',
      onSelect: async () => {
        toast('Refreshing metadata…');
        await api.post(`/api/items/${item.id}/refresh`, {});
        refreshView();
      },
    });
    if (item.kind === 'movie' || item.kind === 'show') items.push({ label: 'Fix match', icon: 'edit', onSelect: () => identifyDialog(item) });
  }
  if ((item.kind === 'movie' || item.kind === 'episode') && !isKidsProfile()) items.push({ label: 'Download', icon: 'download', href: `/api/items/${item.id}/download`, download: true });
  if (item.kind === 'episode' && markers !== undefined) items.push({ label: 'Edit intro', icon: 'edit', onSelect: () => introDialog(item, markers?.intro) });
  return items;
}
```

- In `renderAlbum()` and `renderArtist()`, replace

```js
  const admin = adminMenu(item);
  if (admin) actions.push(...admin);
```

  with

```js
  if (isOrbit()) {
    const more = moreItems(item);
    if (more.length) actions.push(moreButton(item.title, more));
  } else {
    const admin = adminMenu(item);
    if (admin) actions.push(...admin);
  }
```

- In `render()`, replace everything from `actions.push(watchedButton(item));` to `if (admin) actions.push(...admin);` with:

```js
  actions.push(watchedButton(item));
  if (isOrbit()) {
    const more = moreItems(item, data.markers);
    if (more.length) actions.push(moreButton(item.title, more));
  } else {
    if (item.kind !== 'show' && !isKidsProfile()) {
      actions.push(button('', { icon: 'download', variant: 'ghost', href: `/api/items/${item.id}/download`, title: 'Download file', attrs: { download: '' } }));
    }
    const admin = adminMenu(item);
    if (admin) actions.push(...admin);
  }
```

- In the same function, change `data.markers !== undefined ? introLine(item, data.markers) : null,` to `data.markers !== undefined ? introLine(item, data.markers, { edit: !isOrbit() }) : null,`.

- [ ] **Step 5: Append dialogs and sheets to `themes/orbit/theme.css`**

```css
/* ---------- Dialogs and the "…" menu: tinted glass ---------- */
.dialog {
  width: min(calc(720 * var(--px)), calc(100vw - 32px));
  border: 0; border-radius: calc(38 * var(--px)); color: #ffffff;
  background: var(--glass-tinted); -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 var(--glass-highlight), 0 calc(30 * var(--px)) calc(80 * var(--px)) rgba(0, 0, 0, 0.6);
}
.dialog-wide { width: min(calc(1000 * var(--px)), calc(100vw - 32px)); }
/* The page behind a dialog is dimmed, not blurred (a full-screen blur is too slow for a TV). */
.dialog::backdrop { background: rgba(4, 4, 14, 0.55); -webkit-backdrop-filter: none; backdrop-filter: none; }
.dialog-head { padding: calc(30 * var(--px)) calc(24 * var(--px)) calc(8 * var(--px)) calc(36 * var(--px)); }
.dialog-head h2 { font-size: calc(32 * var(--px)); font-weight: 700; letter-spacing: -0.02em; }
.dialog-body { padding: calc(12 * var(--px)) calc(36 * var(--px)) calc(24 * var(--px)); font-size: var(--t-body); }
.dialog-actions { border-top: 0; padding: calc(8 * var(--px)) calc(36 * var(--px)) calc(32 * var(--px)); gap: calc(14 * var(--px)); }
.dialog:has(.sheet) { width: min(calc(480 * var(--px)), calc(100vw - 32px)); }
.sheet { gap: calc(6 * var(--px)); min-width: 0; }
.sheet-item { min-height: max(44px, calc(64 * var(--px))); padding: 0 calc(22 * var(--px)); gap: calc(16 * var(--px)); border-radius: 999px; font-size: var(--t-body); font-weight: 500; color: rgba(255, 255, 255, 0.86); text-decoration: none; }
.sheet-item .icon { width: calc(24 * var(--px)); height: calc(24 * var(--px)); }
.sheet-item:hover { background: rgba(255, 255, 255, 0.12); color: #ffffff; }
.sheet-item:focus-visible { background: #ffffff; color: #0b0b16; box-shadow: 0 calc(12 * var(--px)) calc(30 * var(--px)) rgba(0, 0, 0, 0.4); }
```

- [ ] **Step 6: Point `extras-ui.mjs` at the new place for the intro editor**

```bash
cd /home/claude/devtools
python3 - <<'EOF'
p = 'extras-ui.mjs'
s = open(p).read()
helper = """// 7. The admin intro line and dialog.
// The intro editor: Orbit keeps it in the "…" menu; older themes have an Edit button on the intro line.
const openIntroEditor = async () => {
  if (await page.$('.intro-line button')) return page.click('.intro-line button');
  await page.click('.detail-info button[aria-label="More"]');
  await page.click('dialog[open] .sheet-item:has-text("Edit intro")');
};"""
assert s.count('// 7. The admin intro line and dialog.') == 1
s = s.replace('// 7. The admin intro line and dialog.', helper)
assert s.count("await page.click('.intro-line button');") == 2
s = s.replace("await page.click('.intro-line button');", 'await openIntroEditor();')
open(p, 'w').write(s)
EOF
grep -n "openIntroEditor" extras-ui.mjs
```

Expected: three lines: the definition and two uses.

- [ ] **Step 7: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs more` → all `PASS`.
Run: `node /home/claude/devtools/extras-ui.mjs 2>&1 | grep -E "intro|FAIL"`. Every intro-editor line should pass. An Up next "Cancel" failure is expected until Task 11.

- [ ] **Step 8: Checkpoint**

`npm test` green. Files changed:
- `public/js/components.js`, `public/js/music.js`, `public/js/views/item.js`, `themes/orbit/theme.css`
- devtools: `extras-ui.mjs`, `orbit-ui.mjs`

---

### Task 9: Show, movie, episode, album and artist pages

**Files:**
- Modify: `public/js/views/item.js` (episode row, From the start, the Details panel class)
- Modify: `public/css/orbit.css` (detail page structure)
- Modify: `themes/orbit/theme.css` (detail page look, seasons, episode cards, song list)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `detail` section)

**Interfaces:**
- Consumes:
  - `followFocus(root, lookup, onItem)` from `backdrop.js`;
  - `art`, `button`, `isOrbit`, `resumeInfo`, `formatRuntime`;
  - `.row-scroller` sizing (Task 7).
- Produces: `div.episode-browser`, which contains:
  - `div.row-scroller.row-landscape.episode-row` of `a.card.episode-card` links to `#/play/<id>`;
  - `div.episode-about`, holding `p.episode-story` and an `a.btn` "Episode details" linking to `#/item/<id>`.

  Also `section.details-panel`, the movie or episode file details.

- [ ] **Step 1: Write the failing "detail" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('detail')) {
  await go(page, '#/item/4', '.episode-row');
  check('show page: no poster, a big title', (await style(page, '.detail-poster', 'display')) === 'none' && (await style(page, '.detail-title', 'fontSize')) === '100px', await style(page, '.detail-title', 'fontSize'));
  check('seasons are round buttons', parseFloat(await style(page, '.season-tab', 'borderTopLeftRadius')) >= 20);
  check('…the one you are viewing is underlined in the accent', /inset/.test(await style(page, '.season-tab[aria-selected="true"]', 'boxShadow')));
  const shape = await page.evaluate(() => { const r = document.querySelector('.episode-card .card-art').getBoundingClientRect(); return { w: Math.round(r.width), ratio: r.width / r.height }; });
  check('episodes are a row of wide cards', shape.w === 320 && Math.abs(shape.ratio - 16 / 9) < 0.02, JSON.stringify(shape));
  const n = (await api(page, 'GET', '/api/items/4')).nextEpisode;
  const resumable = Boolean(n?.progress && !n.progress.watched && n.progress.position > 30);
  check('From the start shows when the next episode is half-watched', (await page.locator('.detail-info .actions :text("From the start")').count()) === (resumable ? 1 : 0));
  await press(page, 'ArrowUp');
  await page.evaluate(() => document.querySelectorAll('.episode-card')[1]?.focus());
  await page.waitForTimeout(400);
  const story = await page.textContent('.episode-story');
  const label = await page.evaluate(() => document.querySelectorAll('.episode-card')[1]?.getAttribute('aria-label') || '');
  check("the selected episode's story shows under the row", story.startsWith(label.replace(/^Play episode \d+: /, '') + '.'), `${story} / ${label}`);
  await press(page, 'ArrowDown');
  const a = await active(page);
  check('Down reaches Episode details', a.text === 'Episode details', JSON.stringify(a));
  check('…which opens that episode', /#\/item\/\d+$/.test(await page.evaluate(() => document.activeElement.getAttribute('href'))));
  await page.screenshot({ path: '/tmp/shots/orbit/show-tv.png' });
  await press(page, 'ArrowUp', 'Enter');
  await page.waitForSelector('.player video', { timeout: 15000 });
  check('OK on an episode plays it', /#\/play\/\d+/.test(page.url()), page.url());
  await go(page, '#/item/3', '.detail-info');
  check('movie: the file details sit in a glass panel', (await style(page, '.details-panel', 'backgroundColor')) !== 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: '/tmp/shots/orbit/movie-tv.png' });
  await go(page, '#/item/15', '.tracks');
  check('album: a big cover on the left', (await rect(page, '.detail-poster')).w === 400);
  check('album: songs in a glass list', (await style(page, '.tracks', 'backgroundColor')) !== 'rgba(0, 0, 0, 0)');
  await press(page, 'ArrowUp');
  await page.evaluate(() => document.querySelector('.track-main').focus());
  await page.waitForTimeout(250);
  check('album: the selected song is a white pill', (await style(page, '.track-main:focus', 'backgroundColor')) === 'rgb(255, 255, 255)');
  check('album: the window shows the cover softly, not a sharp copy', await page.evaluate(() => [...document.querySelectorAll('.backdrop img')].every((i) => getComputedStyle(i).opacity === '0')));
  await page.screenshot({ path: '/tmp/shots/orbit/album-tv.png' });
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs detail`
Expected: it times out waiting for `.episode-row`, since the show page still renders the episode list. That is the red state.

- [ ] **Step 3: Build the episode row and From the start**

In `public/js/views/item.js`, after `episodeList()`:

```js
/**
 * Orbit: a season's episodes as a row of wide cards. The selected episode's story shows under the
 * row, next to an Episode details button that Down reaches. OK on a card plays that episode.
 */
function episodeRow(episodes) {
  if (!episodes.length) return h('p', { class: 'muted' }, 'No episodes found.');
  const cards = h('div', { class: 'row-scroller row-landscape episode-row' });
  const byCard = new WeakMap();
  for (const ep of episodes) {
    const r = resumeInfo(ep);
    const length = r?.left ? `${formatRuntime(r.left / 60)} left` : formatRuntime(ep.runtime || (ep.duration ? ep.duration / 60 : null));
    const card = h(
      'a',
      { class: `card episode-card${ep.progress?.watched ? ' is-watched' : ''}`, href: `#/play/${ep.id}`, 'aria-label': `Play episode ${ep.episode}: ${ep.title}` },
      h(
        'div',
        { class: 'card-art' },
        art(ep.poster, ep.title, { kind: 'landscape' }),
        ep.progress?.watched ? h('span', { class: 'badge badge-watched' }, icon('check', { size: 14, label: 'Watched' })) : null,
        r && ep.duration ? h('div', { class: 'progress' }, h('span', { style: { width: `${Math.min(100, (r.position / ep.duration) * 100)}%` } })) : null,
      ),
      h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, `${ep.episode}. ${ep.title}`), length ? h('span', { class: 'card-sub' }, length) : null),
    );
    byCard.set(card, ep);
    cards.append(card);
  }
  const story = h('p', { class: 'episode-story' });
  const first = episodes.find((e) => resumeInfo(e)) || episodes.find((e) => !e.progress?.watched) || episodes[0];
  const details = button('Episode details', { icon: 'info', variant: 'ghost', href: `#/item/${first.id}` });
  const show = (ep) => {
    clear(story).append(h('strong', {}, `${ep.title}.`), ep.overview ? ` ${ep.overview}` : '');
    details.href = `#/item/${ep.id}`;
    details.setAttribute('aria-label', `Episode details: ${ep.episode}. ${ep.title}`);
  };
  show(first);
  followFocus(cards, (card) => byCard.get(card), show);
  return h('div', { class: 'episode-browser' }, cards, h('div', { class: 'episode-about' }, story, details));
}
```

In `selectSeason()`, change `panel.append(episodeList(sd.episodes || []));` to:

```js
      panel.append(isOrbit() ? episodeRow(sd.episodes || []) : episodeList(sd.episodes || []));
```

In `render()`, in the `item.kind === 'show' && data.nextEpisode` branch, after the `actions.push(button(\`${nr ? 'Resume' : 'Play'} …\`))` line:

```js
    if (nr && isOrbit()) actions.push(button('From the start', { icon: 'replay', variant: 'ghost', href: `#/play/${n.id}?t=0` }));
```

In `mediaDetails()`, change `h('section', { class: 'detail-section' }, h('h2', {}, 'Details'), …` to `h('section', { class: 'detail-section details-panel' }, h('h2', {}, 'Details'), …`. Older themes have no styles for `.details-panel`.

- [ ] **Step 4: Append the detail page structure to `public/css/orbit.css`**

```css
/* ---------- Show, movie, episode, album and artist pages ---------- */
body[data-layout="orbit"] .detail-header { min-height: 0; margin-top: 0; padding-top: 0; }
body[data-layout="orbit"] .detail-inner { display: block; padding: 0 var(--gutter) calc(36 * var(--px)); }
body[data-layout="orbit"] .detail-header:not(.music-header) .detail-poster { display: none; }
body[data-layout="orbit"] .detail-info { max-width: calc(1100 * var(--px)); }
body[data-layout="orbit"] .music-header .detail-inner { display: flex; align-items: flex-end; gap: calc(56 * var(--px)); }
body[data-layout="orbit"] .music-header .detail-poster { flex: none; width: calc(400 * var(--px)); }
body[data-layout="orbit"] .detail-body { padding: 0 var(--gutter); gap: calc(36 * var(--px)); }
body[data-layout="orbit"] .detail-body-flush { padding: 0; }
body[data-layout="orbit"] .season-tabs { gap: calc(10 * var(--px)); padding: calc(14 * var(--px)); margin: 0 calc(-14 * var(--px)); overflow: auto hidden; scrollbar-width: none; }
body[data-layout="orbit"] .episode-browser .row-scroller { margin: 0 calc(-1 * var(--gutter)); }
body[data-layout="orbit"] .episode-row { grid-auto-columns: calc(320 * var(--px)); }
body[data-layout="orbit"] .episode-about { display: flex; align-items: center; gap: calc(28 * var(--px)); max-width: calc(1200 * var(--px)); margin-top: calc(8 * var(--px)); }
body[data-layout="orbit"] .episode-about .btn { flex: none; }
body[data-layout="orbit"] .tracks { max-width: calc(1080 * var(--px)); }
/* Music pages: the window shows the cover softly (the environment through a light shade), not a sharp copy. */
body[data-layout="orbit"]:has(.music-header) .backdrop { background: rgba(8, 8, 20, 0.3); }
body[data-layout="orbit"]:has(.music-header) .backdrop img { opacity: 0 !important; }
@media not all and (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"] .music-header .detail-inner { flex-direction: column; align-items: flex-start; gap: 20px; }
  body[data-layout="orbit"] .music-header .detail-poster { width: 200px; }
  body[data-layout="orbit"] .episode-row { grid-auto-columns: 240px; }
  body[data-layout="orbit"] .episode-about { flex-direction: column; align-items: flex-start; }
}
```

- [ ] **Step 5: Append the detail page look to `themes/orbit/theme.css`**

```css
/* ---------- Show, movie and album pages ---------- */
.detail-info h1, .detail-title { font-size: calc(100 * var(--px)); font-weight: 700; line-height: 0.95; letter-spacing: -0.045em; margin-bottom: calc(24 * var(--px)); }
.music-header .detail-title { font-size: calc(96 * var(--px)); }
.detail-logo { max-width: calc(640 * var(--px)); max-height: calc(170 * var(--px)); margin-bottom: calc(24 * var(--px)); }
.detail-info .meta-line { margin-bottom: calc(18 * var(--px)); }
.genres { gap: calc(8 * var(--px)); margin-bottom: calc(18 * var(--px)); }
.tagline { font-style: normal; font-size: var(--t-meta); color: var(--text-soft); }
.overview { font-size: var(--t-body); line-height: 1.5; color: rgba(230, 233, 255, 0.82); max-width: calc(800 * var(--px)); }
.detail-info .actions { margin-top: calc(30 * var(--px)); gap: calc(16 * var(--px)); }
.intro-line { font-size: var(--t-meta); margin-top: calc(18 * var(--px)); }
.detail-poster.is-square .art { border-radius: calc(26 * var(--px)); box-shadow: 0 calc(40 * var(--px)) calc(90 * var(--px)) rgba(0, 0, 0, 0.6); }
.detail-poster.is-round .art { border-radius: 50%; }
.detail-section h2 { font-size: var(--t-section); }
/* Seasons: round buttons; the one you're viewing is underlined in the accent. */
.season-tab {
  min-height: max(40px, calc(48 * var(--px))); padding: 0 calc(22 * var(--px)); border: 0; background: transparent;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); color: var(--text-soft); font-size: max(12px, calc(18 * var(--px))); font-weight: 600;
  transition: transform var(--select), background-color var(--select), color var(--select);
}
.season-tab:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
.season-tab[aria-selected="true"], .view-tabs .season-tab[aria-pressed="true"] { background: rgba(255, 255, 255, 0.18); color: #ffffff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28), inset 0 calc(-3 * var(--px)) 0 var(--accent); }
.season-tab:focus-visible, .view-tabs .season-tab:focus-visible { background: #ffffff; color: #0b0b16; transform: scale(var(--grow-btn)); box-shadow: var(--ring); }
.episode-card .card-title { font-size: max(12px, calc(18 * var(--px))); }
.episode-card.is-watched .card-title { color: var(--text-soft); }
.episode-card .badge-watched { top: calc(12 * var(--px)); right: calc(12 * var(--px)); width: calc(30 * var(--px)); height: calc(30 * var(--px)); min-width: 0; }
.episode-story { flex: 1; margin: 0; font-size: max(12px, calc(19 * var(--px))); line-height: 1.5; color: rgba(230, 233, 255, 0.78); max-width: 75ch; }
.episode-story strong { color: #ffffff; font-weight: 600; }
.details-panel { max-width: calc(1100 * var(--px)); padding: calc(30 * var(--px)) calc(34 * var(--px)); border-radius: calc(32 * var(--px)); background: var(--glass-panel); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.details-list { gap: calc(10 * var(--px)) calc(28 * var(--px)); font-size: var(--t-meta); }
.details-list dt { color: var(--text-dim); font-weight: 500; }
/* Songs: a glass list. The selected song is a white pill; the playing one is in the accent. */
.music-header ~ .detail-body .tracks { padding: calc(12 * var(--px)); border-radius: calc(28 * var(--px)); background: var(--glass-panel); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.track-row { border-radius: 999px; }
.track-row:hover, .track-row:focus-within { background: rgba(255, 255, 255, 0.08); }
.track-main { min-height: max(44px, calc(58 * var(--px))); padding: 0 calc(22 * var(--px)); gap: calc(22 * var(--px)); border-radius: 999px; font-size: max(12px, calc(19 * var(--px))); }
.track-row.is-current .track-title, .track-row.is-current .track-time { color: var(--accent); }
.track-main:focus-visible { background: #ffffff; color: #0b0b16; box-shadow: 0 calc(12 * var(--px)) calc(30 * var(--px)) rgba(0, 0, 0, 0.4); }
.track-main:focus-visible :is(.track-title, .track-sub, .track-time, .track-num, .track-num .icon) { color: #0b0b16; }
.track-main:focus-visible :is(.track-sub, .track-time) { opacity: 0.7; }
.track-eq i { background: var(--accent); }
.disc-head { text-transform: none; letter-spacing: 0; font-size: var(--t-meta); font-weight: 600; }
```

- [ ] **Step 6: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs detail more`
Expected: all `PASS`. Compare `show-tv.png` with the `ShowPage` board and `album-tv.png` with `AlbumPage`.

- [ ] **Step 7: Checkpoint, and show Dallas (controller)**

`npm test` green. Files changed: `public/js/views/item.js`, `public/css/orbit.css`, `themes/orbit/theme.css`, and devtools `orbit-ui.mjs`.

Stage 4 is done. Send Dallas `show-tv.png`, `movie-tv.png`, `album-tv.png` and `more-menu-tv.png`, then carry on.

---

## Stage 5 — Player and mini-player

### Task 10: The player: glass control bar, clock, side panel for menus, Skip intro

**Files:**
- Modify: `public/js/views/player.js` (Orbit extras, menu divider, focus back to the menu's button)
- Modify: `public/css/orbit.css` (player structure)
- Modify: `themes/orbit/theme.css` (player look)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `player` section)

**Interfaces:**
- Consumes: `isOrbit()` (app.js).
- Produces:
  - `button.pbtn.pbtn-play` (the play/pause button, all themes; no styles outside Orbit);
  - `time.player-clock` in `.player-top` (Orbit only);
  - `.player-ends` inside the left `.control-group` (Orbit only);
  - `div.menu-sep` before "Find subtitles online…".
  - When a player menu closes, focus returns to the button that opened it.

- [ ] **Step 1: Write the failing "player" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('player')) {
  const ep = (await api(page, 'GET', '/api/items/4')).nextEpisode.id;
  await go(page, `#/play/${ep}`, '.player video');
  await page.waitForFunction(() => document.querySelector('.player video')?.readyState >= 2, null, { timeout: 20000 });
  await press(page, 'ArrowUp');
  await page.waitForTimeout(300);
  const bar = await rect(page, '.player-controls');
  check('the controls float in a glass bar', bar.x === 48 && 1920 - (bar.x + bar.w) === 48 && 1080 - (bar.y + bar.h) === 40, JSON.stringify(bar));
  check('…with glass behind them', (await style(page, '.player-controls', 'backdropFilter', '::before')) !== 'none');
  check('the clock sits top-right', /\d/.test((await page.textContent('.player-top .player-clock').catch(() => '')) || ''));
  check('"Ends at" sits beside the play buttons', Boolean(await page.$('.player-controls .player-ends')));
  check('Pause/Play is a white circle', (await style(page, '.pbtn-play', 'backgroundColor')) === 'rgb(255, 255, 255)');
  await page.focus('button[aria-label="Subtitles (C)"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.player-menu:not([hidden])');
  await page.waitForTimeout(300);
  const panel = await rect(page, '.player-menu');
  check('menus open as a tall glass panel on the right', panel.y === 48 && 1080 - (panel.y + panel.h) === 48 && 1920 - (panel.x + panel.w) === 48 && panel.w === 560, JSON.stringify(panel));
  check('…while the video keeps playing', await page.evaluate(() => !document.querySelector('.player video').paused));
  check('…with the selected row as a white pill', (await style(page, '.player-menu .menu-item:focus', 'backgroundColor')) === 'rgb(255, 255, 255)');
  await page.screenshot({ path: '/tmp/shots/orbit/player-subtitles-tv.png' });
  await press(page, 'Backspace');
  check('Back closes it', await page.evaluate(() => document.querySelector('.player-menu').hidden));
  check('…and the remote is back on Subtitles', (await active(page)).label === 'Subtitles (C)');
  // Skip intro: a white pill with a thin accent line (shown by hand here; extras-ui.mjs checks the real thing).
  const skip = await page.evaluate(() => {
    const b = document.querySelector('.skip-intro');
    b.hidden = false;
    const out = { bg: getComputedStyle(b).backgroundColor, bar: getComputedStyle(b.querySelector('.skip-intro-bar')).backgroundColor };
    b.hidden = true;
    return out;
  });
  check('Skip intro is a white pill with an accent line', skip.bg === 'rgb(255, 255, 255)' && skip.bar !== 'rgba(0, 0, 0, 0)', JSON.stringify(skip));
  await press(page, 'ArrowUp');
  await page.screenshot({ path: '/tmp/shots/orbit/player-tv.png' });
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs player`
Expected: FAIL on the bar position, the clock, "Ends at", the white circle, the panel position, the white pill and Skip intro. `Back closes it` passes already. `…and the remote is back on Subtitles` fails.

- [ ] **Step 3: Player markup**

In `public/js/views/player.js`:
- Add `isOrbit` to the `app.js` import.
- Change `const playBtn = ctlBtn('play', 'Play (Space)', () => togglePlay());` to:

```js
  const playBtn = ctlBtn('play', 'Play (Space)', () => togglePlay(), { class: 'pbtn pbtn-play' });
```

- Replace the `const controls = h(…);` block, the `endsEl` line and the `top` line (lines 61–75) with:

```js
  const playGroup = h('div', { class: 'control-group' }, playBtn, backBtn, fwdBtn, h('div', { class: 'volume-wrap' }, muteBtn, volume));
  const controls = h(
    'div',
    { class: 'player-controls' },
    h('div', { class: 'seek-wrap' }, timeCur, seekTrack, timeEnd),
    h('div', { class: 'control-row' }, playGroup, h('div', { class: 'control-group' }, modeBadge, nextBtn, subsBtn, audioBtn, qualityBtn, fsBtn)),
    menu,
  );
  // Like a TV media centre: when will this finish if I keep watching?
  const endsEl = h('div', { class: 'player-ends', 'aria-live': 'off' });
  const top = h('div', { class: 'player-top' }, h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Back', title: 'Back (Esc)', onClick: () => leave() }, icon('back', { size: 26 })), titleEl, endsEl);
  // Orbit: the clock top-right, and "Ends at" beside the play buttons.
  const clockEl = h('time', { class: 'player-clock' });
  const tickClock = () => (clockEl.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  let clockTimer = null;
  if (isOrbit()) {
    playGroup.append(endsEl);
    top.append(clockEl);
    tickClock();
    clockTimer = setInterval(tickClock, 15000);
  }
```

- In `cleanupFn()`, after `clearInterval(upNextTimer);`, add `clearInterval(clockTimer);`.
- Replace `closeMenu()` with:

```js
  const menuOpeners = { subs: subsBtn, audio: audioBtn, quality: qualityBtn };
  function closeMenu() {
    const refocus = menu.contains(document.activeElement);
    const opener = menuOpeners[openMenu];
    menu.hidden = true;
    openMenu = null;
    showControls();
    if (refocus) opener?.focus({ preventScroll: true });
  }
```

- In `toggleMenu('subs')`, change the line that appends "Find subtitles online…" so a divider goes before it:

```js
        menu.append(h('div', { class: 'menu-sep', 'aria-hidden': 'true' }), h('button', { type: 'button', class: 'menu-item menu-action', onClick: () => searchOnline() }, h('span', { class: 'menu-check' }, icon('search', { size: 16 })), h('span', {}, 'Find subtitles online…')));
```

The empty divider has no size in older themes, so they look the same.

- [ ] **Step 4: Append the player structure to `public/css/orbit.css`**

```css
/* ---------- Player: a floating control bar; menus open as a tall panel on the right ---------- */
body[data-layout="orbit"] .player-top { padding: calc(40 * var(--px)) calc(56 * var(--px)) calc(90 * var(--px)); gap: calc(18 * var(--px)); }
body[data-layout="orbit"] .player-clock { margin-left: auto; }
body[data-layout="orbit"] .player-controls {
  left: calc(48 * var(--px)); right: calc(48 * var(--px)); bottom: calc(40 * var(--px));
  padding: calc(26 * var(--px)) calc(34 * var(--px)) calc(22 * var(--px)); border-radius: calc(38 * var(--px)); background: none;
}
body[data-layout="orbit"] .player-controls::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none; }
body[data-layout="orbit"] .control-row { margin-top: calc(14 * var(--px)); }
body[data-layout="orbit"] .control-group { gap: calc(10 * var(--px)); }
body[data-layout="orbit"] .player-controls .player-ends { margin-left: calc(14 * var(--px)); }
body[data-layout="orbit"] .pbtn { width: max(42px, calc(64 * var(--px))); height: max(42px, calc(64 * var(--px))); }
body[data-layout="orbit"] .pbtn .icon { width: calc(28 * var(--px)); height: calc(28 * var(--px)); min-width: 20px; min-height: 20px; }
body[data-layout="orbit"] .player-menu {
  position: fixed; top: calc(48 * var(--px)); right: calc(48 * var(--px)); bottom: calc(48 * var(--px)); left: auto;
  width: calc(560 * var(--px)); max-width: calc(100vw - 32px); max-height: none; margin: 0;
  display: flex; flex-direction: column; gap: calc(6 * var(--px)); overflow-y: auto;
  padding: calc(36 * var(--px)) calc(26 * var(--px)); border-radius: calc(38 * var(--px));
}
body[data-layout="orbit"] .player-menu[hidden] { display: none; }
body[data-layout="orbit"] .skip-intro, body[data-layout="orbit"] .upnext, body[data-layout="orbit"] .player-notice { right: calc(56 * var(--px)); }
body[data-layout="orbit"] .skip-intro { bottom: calc(240 * var(--px)); }
body[data-layout="orbit"] .player[data-controls="hidden"] .skip-intro { bottom: calc(56 * var(--px)); }
body[data-layout="orbit"] .player-notice { top: auto; left: auto; bottom: calc(240 * var(--px)); transform: none; }
body[data-layout="orbit"] .player[data-controls="visible"] .subtitle-layer { bottom: max(8%, calc(260 * var(--px))); }
@media not all and (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"] .player-controls { left: 10px; right: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); padding: 14px 14px 10px; border-radius: 26px; }
  body[data-layout="orbit"] .player-menu { top: auto; left: 10px; right: 10px; bottom: 10px; width: auto; max-height: 70vh; border-radius: 26px; }
}
```

The panel stays inside `.player-controls` in the DOM so the player's own key handling keeps working. It is `position: fixed` against the screen, because `.player-controls` has no transform while it is visible, and the glass sits on a `::before` so it doesn't trap the panel either.

- [ ] **Step 5: Append the player look to `themes/orbit/theme.css`**

```css
/* ---------- Player ---------- */
.player-top { background: linear-gradient(180deg, rgba(0, 0, 0, 0.6), transparent); }
.player-title h1 { font-size: calc(30 * var(--px)); font-weight: 700; letter-spacing: -0.02em; }
.player-title p { font-size: var(--t-meta); font-weight: 500; color: var(--text-soft); }
.player-clock { font-size: var(--t-meta); font-weight: 500; color: #ffffff; font-variant-numeric: tabular-nums; }
.player-controls::before {
  background: var(--glass-tinted); -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 var(--glass-highlight), 0 calc(30 * var(--px)) calc(80 * var(--px)) rgba(0, 0, 0, 0.5);
}
.seek-wrap .time { font-size: var(--t-meta); font-weight: 500; }
.player-ends { font-size: var(--t-meta); font-weight: 500; color: var(--text-soft); }
.pbtn:hover { background: rgba(255, 255, 255, 0.14); }
.pbtn:focus-visible { outline: none; background: #ffffff; color: #0b0b16; box-shadow: var(--ring); }
.pbtn-play { background: #ffffff; color: #0b0b16; }
.pbtn-play:hover { background: #ffffff; transform: scale(1.04); }
.mode-badge { border: 0; box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.4); padding: calc(6 * var(--px)) calc(14 * var(--px)); font-size: var(--t-caption); letter-spacing: 0; text-transform: none; font-weight: 600; }
.mode-badge:focus-visible { background: #ffffff; color: #0b0b16; box-shadow: var(--ring); }
.player-menu {
  background: rgba(24, 24, 38, 0.66); -webkit-backdrop-filter: blur(40px) saturate(1.6); backdrop-filter: blur(40px) saturate(1.6);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 var(--glass-highlight), 0 calc(30 * var(--px)) calc(80 * var(--px)) rgba(0, 0, 0, 0.6);
}
html.reduce-effects .player-menu { background: rgba(24, 24, 36, 0.94); }
.menu-title { margin: 0 calc(18 * var(--px)) calc(18 * var(--px)); font-size: calc(32 * var(--px)); font-weight: 700; letter-spacing: -0.02em; text-transform: none; color: #ffffff; }
.menu-empty { margin: 0 calc(18 * var(--px)); font-size: var(--t-meta); }
.menu-item { min-height: max(44px, calc(64 * var(--px))); padding: 0 calc(22 * var(--px)); grid-template-columns: calc(24 * var(--px)) 1fr auto; gap: calc(16 * var(--px)); border-radius: 999px; font-size: max(12px, calc(21 * var(--px))); font-weight: 500; color: rgba(255, 255, 255, 0.86); }
.menu-item[aria-checked="true"] { color: #ffffff; font-weight: 600; }
.menu-item[aria-checked="true"] .menu-check { color: var(--accent); }
.menu-item small { padding: calc(3 * var(--px)) calc(10 * var(--px)); border-radius: calc(7 * var(--px)); box-shadow: inset 0 0 0 1.5px currentColor; font-size: max(11px, calc(14 * var(--px))); font-weight: 600; color: inherit; opacity: 0.8; }
.menu-item:hover { background: rgba(255, 255, 255, 0.12); }
.menu-item:focus-visible { background: #ffffff; color: #0b0b16; box-shadow: 0 calc(12 * var(--px)) calc(30 * var(--px)) rgba(0, 0, 0, 0.4); }
.menu-item:focus-visible .menu-check { color: #0b0b16; }
.menu-action { color: #ffffff; font-weight: 600; }
.menu-sep { height: 1px; margin: calc(12 * var(--px)) calc(22 * var(--px)); background: rgba(255, 255, 255, 0.12); flex: none; }
/* Skip intro (and the "Skipped intro · Watch it" notice): a white pill; the thin line shows how much intro is left. */
.skip-intro { min-height: max(44px, calc(66 * var(--px))); padding: 0 calc(34 * var(--px)); background: #ffffff; color: #0b0b16; font-size: var(--t-body); font-weight: 600; box-shadow: var(--lift); transition: transform var(--select), box-shadow var(--select); }
.skip-intro:hover { background: #ffffff; }
.skip-intro:focus-visible { outline: none; transform: scale(var(--grow-btn)); box-shadow: var(--ring), var(--lift); }
.skip-intro-bar { height: max(3px, calc(4 * var(--px))); background: var(--accent); }
.player-notice { padding: calc(10 * var(--px)) calc(10 * var(--px)) calc(10 * var(--px)) calc(28 * var(--px)); background: #ffffff; color: #0b0b16; -webkit-backdrop-filter: none; backdrop-filter: none; font-size: var(--t-body); font-weight: 600; box-shadow: var(--lift); }
.player-notice .btn { --btn-bg: #0b0b16; --btn-fg: #ffffff; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none; }
.player-notice .btn:focus-visible { background: #0b0b16; color: #ffffff; box-shadow: 0 0 0 calc(4 * var(--px)) #ffffff, 0 0 0 calc(8 * var(--px)) #0b0b16; }
.player-info { border-radius: calc(32 * var(--px)); background: var(--glass-tinted); -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted); font-size: var(--t-meta); }
.player-bigplay { background: #ffffff; color: #0b0b16; }
```

- [ ] **Step 6: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs player`
Expected: all `PASS`. Compare `player-tv.png` with `PlayerScrub`, and `player-subtitles-tv.png` with `PlayerSubs`.
Run: `node /home/claude/devtools/extras-ui.mjs 2>&1 | grep -E "PASS|FAIL" | head -30`. The seek-preview, skip-intro and auto-skip lines must pass. The Up next "Cancel" line fails until Task 11.

- [ ] **Step 7: Checkpoint**

`npm test` green. Files changed: `public/js/views/player.js`, `public/css/orbit.css`, `themes/orbit/theme.css`, and devtools `orbit-ui.mjs`.

---

### Task 11: Up next: a glass card, a countdown ring, "Keep watching"

**Files:**
- Modify: `public/js/views/player.js` (`startUpNext`; Left/Right between the Up next buttons)
- Modify: `public/css/app.css` (hide the new Up next parts in older themes)
- Modify: `public/css/orbit.css`, `themes/orbit/theme.css`
- Modify: `/home/claude/devtools/extras-ui.mjs` (the button is now "Keep watching")
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `upnext` section)

**Interfaces:**
- Consumes: `art()` (components.js), `formatRuntime`/`append` (dom.js); `session.next` (a serialised episode: `poster`, `title`, `season`, `episode`, `runtime`, `duration`) and `session.show.title`.
- Produces: in `.upnext`:
  - `div.upnext-art`, `p.eyebrow` "Up next", `h3`, `p.upnext-meta` (show and length) and `p.muted` "Starting in N s";
  - the buttons "Play now" (holding `span.upnext-ring`, whose `--left` goes from 1 to 0) and "Keep watching".

- [ ] **Step 1: Write the failing "upnext" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('upnext')) {
  // Theme Show's second episode has an "End Credits" chapter at 1:20 (see make-extras-media.mjs).
  const show = await api(page, 'GET', '/api/items/28');
  const season = show.seasons.find((s) => s.season > 0) || show.seasons[0];
  const eps = (await api(page, 'GET', `/api/items/${season.id}`)).episodes;
  await go(page, `#/play/${eps[1].id}?t=77`, '.player video');
  const shown = await page.waitForSelector('.upnext:not([hidden])', { timeout: 20000 }).then(() => true, () => false);
  check('Up next appears at the credits', shown);
  const card = await page.evaluate(() => {
    const u = document.querySelector('.upnext');
    return { art: Boolean(u.querySelector('.upnext-art')?.offsetParent), text: u.textContent, ring: getComputedStyle(u.querySelector('.upnext-ring')).display, focused: document.activeElement.textContent.trim() };
  });
  check("…a glass card with the next episode's picture", card.art, JSON.stringify(card));
  check('…its number and title, the show and the length', /S\d+ · E\d+ · /.test(card.text) && /Theme Show/.test(card.text), card.text);
  check('…Play now with a countdown ring, Keep watching, Starting in', card.ring !== 'none' && /Play now/.test(card.text) && /Keep watching/.test(card.text) && /Starting in \d+ s/.test(card.text), JSON.stringify(card));
  check('…with the remote on Play now', card.focused === 'Play now', card.focused);
  await page.waitForTimeout(1300);
  check('the ring counts down', await page.evaluate(() => parseFloat(document.querySelector('.upnext-ring').style.getPropertyValue('--left')) < 1));
  await page.screenshot({ path: '/tmp/shots/orbit/upnext-tv.png' });
  await press(page, 'ArrowRight');
  check('Right moves to Keep watching', (await active(page)).text === 'Keep watching');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check('Keep watching lets the credits play on', await page.evaluate(() => document.querySelector('.upnext').hidden && !document.querySelector('.player video').paused));
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs upnext`
Expected: `Up next appears at the credits` passes. The picture, ring and "Keep watching" checks FAIL, and so does `Right moves to Keep watching`.

- [ ] **Step 3: The Up next card**

In `public/js/views/player.js`:
- Add `formatRuntime` to the `dom.js` import and `art` to the `components.js` import.
- Replace `startUpNext()` with:

```js
  function startUpNext() {
    upNextCancelled = false;
    const next = session.next;
    let left = 10;
    const count = h('span', { class: 'upnext-count' }, String(left));
    // Orbit also shows the episode's picture, the show and its length, and a ring round Play now that
    // empties as the countdown runs (older themes hide those three).
    const ring = h('span', { class: 'upnext-ring', 'aria-hidden': 'true', style: { '--left': '1' } });
    const length = formatRuntime(next.runtime || (next.duration ? next.duration / 60 : null));
    append(clear(upNext), [
      next.poster ? h('div', { class: 'upnext-art' }, art(next.poster, next.title, { kind: 'landscape', eager: true })) : null,
      h('p', { class: 'eyebrow' }, 'Up next'),
      h('h3', {}, `${episodeLabel(next)} · ${next.title}`),
      h('p', { class: 'upnext-meta muted' }, [session.show?.title, length].filter(Boolean).join(', ')),
      h('p', { class: 'muted' }, 'Starting in ', count, ' s'),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => playNext(), 'data-autofocus': true }, ring, icon('play'), h('span', {}, 'Play now')),
        h('button', { class: 'btn btn-secondary', type: 'button', onClick: cancelUpNext }, 'Keep watching'),
      ),
    ]);
    upNext.hidden = false;
    upNext.querySelector('[data-autofocus]').focus();
    upNextTimer = setInterval(() => {
      left--;
      count.textContent = String(left);
      ring.style.setProperty('--left', String(Math.max(0, left) / 10));
      if (left <= 0) playNext();
    }, 1000);
  }
```

- In `onKey()`, in the `if (onButton) {` block under `case 'ArrowRight':`, replace

```js
          const buttons = [...root.querySelectorAll('.player-controls button:not([hidden]), .player-top button')].filter((b) => b.offsetParent);
```

  with

```js
          // Along the control buttons, or between the two Up next buttons.
          const pool = upNext.contains(active) ? upNext.querySelectorAll('button') : root.querySelectorAll('.player-controls button:not([hidden]), .player-top button');
          const buttons = [...pool].filter((b) => b.offsetParent);
```

Append to `public/css/app.css`:

```css
/* Up next's picture, details line and countdown ring are Orbit's; older themes keep their card. */
.upnext-art, .upnext-meta, .upnext-ring { display: none; }
```

Append to `public/css/orbit.css`:

```css
/* ---------- Up next ---------- */
body[data-layout="orbit"] .upnext { bottom: calc(240 * var(--px)); width: calc(520 * var(--px)); max-width: calc(100vw - 32px); padding: calc(18 * var(--px)) calc(18 * var(--px)) calc(26 * var(--px)); }
body[data-layout="orbit"] .upnext-art { display: block; margin: 0 0 calc(18 * var(--px)); }
body[data-layout="orbit"] .upnext-meta { display: block; }
body[data-layout="orbit"] .upnext .btn-primary { position: relative; }
body[data-layout="orbit"] .upnext-ring { display: block; position: absolute; left: calc(21 * var(--px)); top: 50%; width: calc(40 * var(--px)); height: calc(40 * var(--px)); margin-top: calc(-20 * var(--px)); border-radius: 50%; pointer-events: none; }
@media not all and (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"] .upnext { left: 10px; right: 10px; width: auto; bottom: 150px; }
}
```

Append to `themes/orbit/theme.css`:

```css
/* ---------- Up next: a glass card; the ring round Play now empties as the countdown runs ---------- */
.upnext {
  border-radius: calc(36 * var(--px));
  background: var(--glass-tinted); -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 var(--glass-highlight), 0 calc(30 * var(--px)) calc(80 * var(--px)) rgba(0, 0, 0, 0.6);
}
.upnext-art .art { border-radius: calc(22 * var(--px)); }
.upnext .eyebrow { margin: 0 calc(8 * var(--px)) calc(6 * var(--px)); }
.upnext h3 { margin: 0 calc(8 * var(--px)) calc(6 * var(--px)); font-size: calc(26 * var(--px)); font-weight: 700; letter-spacing: -0.015em; }
.upnext-meta, .upnext .muted { margin: 0 calc(8 * var(--px)) calc(6 * var(--px)); font-size: var(--t-meta); color: var(--text-soft); }
.upnext .muted:last-of-type { margin-bottom: calc(18 * var(--px)); }
.upnext-count { color: #ffffff; }
.upnext .actions { padding: 0 calc(8 * var(--px)); gap: calc(14 * var(--px)); }
.upnext-ring {
  background: conic-gradient(var(--accent) calc(var(--left, 1) * 1turn), rgba(11, 11, 22, 0.16) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  transition: background 1s linear;
}
```

- [ ] **Step 4: Rename the button in `extras-ui.mjs`**

```bash
cd /home/claude/devtools
sed -i 's/\.upnext button:has-text("Cancel")/.upnext button:has-text("Keep watching")/; s/cancelling Up next lets the credits play on/Keep watching lets the credits play on/' extras-ui.mjs
grep -n 'Keep watching' extras-ui.mjs
```

Expected: two lines.

- [ ] **Step 5: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs upnext player` → all `PASS`.
Run: `node /home/claude/devtools/extras-ui.mjs 2>&1 | grep -E "FAIL|Keep watching"` → only the `PASS Keep watching…` line, and no `FAIL`.

- [ ] **Step 6: Checkpoint**

`npm test` green. Files changed:
- `public/js/views/player.js`, `public/css/app.css`, `public/css/orbit.css`, `themes/orbit/theme.css`
- devtools: `extras-ui.mjs`, `orbit-ui.mjs`

---

### Task 12: The mini-player as a floating pill

**Files:**
- Modify: `public/css/orbit.css`, `themes/orbit/theme.css` (CSS only; the markup in `music.js` stays)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `mini` section)

**Interfaces:**
- Consumes: the mini-player markup from `public/js/music.js`:
  - `section.mini` holding `.mini-line > span`, `.mini-now` (`.mini-art`, `.mini-title`, `.mini-sub`), `.mini-center` (`.mini-buttons`: shuffle, prev, `.mbtn-play`, next, repeat; `.mini-seek`) and `.mini-side` (queue, mute, volume, close).
- Produces: collapsed, the pill shows the cover, title, artist, a progress line and play/pause. It expands to the full controls while it has the remote (`:focus-within`) or a mouse (`:hover`).

- [ ] **Step 1: Write the failing "mini" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('mini')) {
  const vis = () => page.evaluate(() => {
    const n = (s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent).length;
    return { buttons: n('.mini .mbtn'), title: n('.mini-title'), seek: n('.mini-seek-range'), w: Math.round(document.querySelector('.mini').getBoundingClientRect().width) };
  });
  await go(page, '#/item/15', '.tracks');
  await page.click('.detail-info .btn-primary');
  await page.waitForSelector('.mini:not([hidden])');
  await page.waitForTimeout(800);
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(900, 400);
  await page.waitForTimeout(400);
  const pill = await rect(page, '.mini');
  check('music playing: a glass pill bottom-right', pill.w === 460 && 1920 - (pill.x + pill.w) === 80 && 1080 - (pill.y + pill.h) === 76, JSON.stringify(pill));
  const small = await vis();
  check('…showing the cover, title, artist and play/pause only', small.buttons === 1 && small.title === 1 && small.seek === 0, JSON.stringify(small));
  check('…with a progress line', (await style(page, '.mini-line', 'display')) === 'block');
  await page.screenshot({ path: '/tmp/shots/orbit/mini-pill-tv.png' });
  await press(page, 'ArrowUp');
  await page.focus('.mini .mbtn-play');
  await page.waitForTimeout(350);
  const big = await vis();
  check('selecting it opens the full controls', big.buttons >= 6 && big.seek === 1 && big.w === 560, JSON.stringify(big));
  await press(page, 'ArrowRight');
  check('…which the remote moves through', (await active(page)).label === 'Next');
  await page.screenshot({ path: '/tmp/shots/orbit/mini-open-tv.png' });
  await page.focus('.mini-seek-range');
  await press(page, 'ArrowLeft');
  check('Left on a slider seeks; it does not open the menu', /mini-seek-range/.test((await active(page)).cls) && !(await page.evaluate(() => document.documentElement.classList.contains('menu-open'))));
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(350);
  check('leaving it folds it back into a pill', (await rect(page, '.mini')).w === 460);
  await page.evaluate(async () => (await import('/js/music.js')).music.stop());
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs mini`
Expected: FAIL on the pill size and position (today it is a full-width bar), `…play/pause only`, the progress line, and the expanded width.

- [ ] **Step 3: Append the pill's structure to `public/css/orbit.css`**

```css
/* ---------- Mini-player: a floating pill; with the remote (or a mouse) on it, the full controls ---------- */
body[data-layout="orbit"] .mini {
  left: auto; right: calc(var(--win-r) + 40 * var(--px)); bottom: calc(var(--win-b) + 36 * var(--px));
  width: calc(460 * var(--px)); height: auto; min-height: calc(96 * var(--px));
  grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "now center"; gap: calc(16 * var(--px));
  padding: calc(14 * var(--px)); border: 0; border-radius: calc(30 * var(--px)); overflow: visible;
}
body[data-layout="orbit"] .mini-now { grid-area: now; min-width: 0; }
body[data-layout="orbit"] .mini-center { grid-area: center; }
body[data-layout="orbit"] .mini:not(:focus-within, :hover) :is(.mini-seek, .mini-side, .mini-buttons > :not(.mbtn-play)) { display: none; }
body[data-layout="orbit"] .mini:is(:focus-within, :hover) { width: calc(560 * var(--px)); grid-template-columns: minmax(0, 1fr); grid-template-areas: "now" "center" "side"; row-gap: calc(12 * var(--px)); padding: calc(20 * var(--px)); }
body[data-layout="orbit"] .mini:is(:focus-within, :hover) .mini-side { grid-area: side; justify-content: center; }
body[data-layout="orbit"] .mini-line { display: block; position: absolute; top: auto; left: calc(98 * var(--px)); right: calc(86 * var(--px)); bottom: calc(24 * var(--px)); height: max(3px, calc(4 * var(--px))); border-radius: 2px; overflow: hidden; }
body[data-layout="orbit"] .mini:is(:focus-within, :hover) .mini-line { display: none; }
/* Room at the bottom of the page so the pill never covers the last row. */
html.has-mini body[data-layout="orbit"].signed-in main { padding-bottom: 0; }
html.has-mini body[data-layout="orbit"] :is(.view:not(.home-view), .home-rows) { padding-bottom: calc(150 * var(--px)); }
@media not all and (min-width: 1000px) and (orientation: landscape) {
  body[data-layout="orbit"] .mini { left: 12px !important; right: 12px; bottom: calc(80px + env(safe-area-inset-bottom)); width: auto; }
  body[data-layout="orbit"] .mini:is(:focus-within, :hover) { width: auto; }
  html.has-mini body[data-layout="orbit"].signed-in main { padding-bottom: calc(190px + env(safe-area-inset-bottom)); }
}
```

- [ ] **Step 4: Append the pill's look to `themes/orbit/theme.css`**

```css
/* ---------- Mini-player ---------- */
.mini {
  background: var(--glass-tinted); -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 calc(20 * var(--px)) calc(50 * var(--px)) rgba(0, 0, 0, 0.5);
}
.mini::before { display: none; }
.mini-art { width: max(44px, calc(68 * var(--px))); }
.mini-art .art { border-radius: calc(16 * var(--px)); }
.mini-title { font-size: max(13px, calc(18 * var(--px))); font-weight: 600; }
.mini-title:focus-visible { outline: none; box-shadow: var(--ring); border-radius: 8px; }
.mini-sub { font-size: var(--t-caption); color: rgba(226, 230, 255, 0.66); }
.mini-line { background: rgba(255, 255, 255, 0.2); }
.mini-line span { background: var(--accent); }
.mini-time { font-size: var(--t-caption); }
.mbtn { width: max(36px, calc(52 * var(--px))); height: max(36px, calc(52 * var(--px))); color: rgba(255, 255, 255, 0.86); }
.mbtn-play { width: max(40px, calc(56 * var(--px))); height: max(40px, calc(56 * var(--px))); background: rgba(255, 255, 255, 0.92); color: #0b0b16; }
.mbtn-play:hover { background: #ffffff; color: #0b0b16; }
.mbtn:focus-visible { outline: none; background: #ffffff; color: #0b0b16; box-shadow: var(--ring); }
```

- [ ] **Step 5: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs mini home` → all `PASS`. Compare `mini-pill-tv.png` with the pill on the `AlbumPage` board.

- [ ] **Step 6: Checkpoint, and show Dallas (controller)**

`npm test` green. Files: `public/css/orbit.css`, `themes/orbit/theme.css`, devtools `orbit-ui.mjs`.

Stage 5 is done. Send Dallas `player-tv.png`, `player-subtitles-tv.png`, `upnext-tv.png` and `mini-open-tv.png`, then carry on.

---

## Stage 6 — Settings and the remaining screens

### Task 13: Settings: sections on the left, glass groups, theme cards, the hints

**Files:**
- Modify: `public/js/views/settings.js` (theme order, hints)
- Modify: `public/css/app.css` (Orbit's preview swatch, shown in every theme's picker)
- Modify: `themes/orbit/theme.css` (settings look)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `settings` section)

**Interfaces:**
- Consumes: `toggle(…, { hint })` (Task 3), `isOrbit()`.
- Produces: the theme picker lists the server's default theme first; `span.sw-nav.sw-orbit` gets a swatch.

- [ ] **Step 1: Write the failing "settings" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('settings')) {
  await go(page, '#/settings/profile', '.theme-grid');
  const names = await page.$$eval('.theme-card .theme-name', (a) => a.map((x) => x.textContent));
  check('Orbit is listed first, as the default', names[0] === 'Orbit' && names.length === 7, names.join());
  check('every theme has a preview card', (await page.locator('.theme-card .theme-swatch').count()) === 7);
  check("Orbit's preview shows its floating menu", (await page.locator('.theme-card .sw-orbit').count()) === 1 && (await style(page, '.sw-orbit', 'borderTopLeftRadius')) !== '0px');
  check('options sit in glass groups', (await style(page, '.panel', 'borderTopLeftRadius')) === '32px');
  const tab = await page.evaluate(() => document.querySelector('.settings-tab').getBoundingClientRect().height);
  check('the sections are listed on the left, sized for the remote', tab >= 60, String(tab));
  for (const [label, hint] of [['Reduce motion', 'Nothing grows'], ['Reduce effects', 'TV feels slow'], ['Skip intros automatically', 'Watch it']]) {
    const text = await page.locator(`.toggle:has-text("${label}") .toggle-hint`).textContent().catch(() => '');
    check(`"${label}" says what it does`, (text || '').includes(hint), text);
  }
  check('Accent colour says when it is used', /no artwork/.test(await page.textContent('.panel')));
  await page.screenshot({ path: '/tmp/shots/orbit/settings-tv.png' });
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs settings`
Expected: FAIL on the theme order (Arctic comes first today), the Orbit preview, the glass groups, the tab height, the Reduce motion and Skip intros hints, and the Accent colour line.

- [ ] **Step 3: Settings markup**

In `public/js/views/settings.js`:
- Add `isOrbit` to the `app.js` import.
- In `profileTab()`, replace `const themes = state.themes;` with:

```js
  // The server's default theme first (Orbit, normally); the rest as the server lists them.
  const themes = [...state.themes].sort((a, b) => (b.id === state.status.defaultTheme) - (a.id === state.status.defaultTheme));
```

- In the Appearance section:
  - Change `field('Accent colour', accent)` to `field('Accent colour', accent, isOrbit() ? 'Used when a title has no artwork to take its colour from.' : undefined)`.
  - Give the Reduce motion toggle `{ hint: 'Nothing grows or slides.' }` as its fourth argument.
- In the Playback section, give the Skip intros toggle a hint:

```js
      toggle('Skip intros automatically', prefs.skipIntros === true, (v) => save(() => updatePrefs({ skipIntros: v })), { hint: 'You can still choose Watch it when it skips.' }),
```

Append to `public/css/app.css` (every theme's picker shows Orbit's card):

```css
/* Orbit's preview: a floating pill of a menu beside a rounded window. */
.sw-nav.sw-orbit { inset: 22% auto 22% 5%; width: 9%; border-radius: 99px; }
.sw-nav.sw-orbit::after { left: 50%; top: 12%; width: 5px; height: 5px; margin-left: -2.5px; border-radius: 50%; }
.theme-swatch:has(.sw-orbit) { padding: 12px 10px 12px 22%; background: radial-gradient(90% 90% at 70% 30%, color-mix(in srgb, var(--sw-accent) 22%, transparent), transparent 70%), var(--sw-bg); }
.theme-swatch:has(.sw-orbit)::before { content: ""; position: absolute; inset: 8% 5% 8% 17%; border-radius: 12% / 20%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22); }
```

- [ ] **Step 4: Append the settings look to `themes/orbit/theme.css`**

```css
/* ---------- Settings: sections on the left, options in glass groups ---------- */
.page-head { padding: 0 var(--gutter) calc(26 * var(--px)); gap: calc(20 * var(--px)); }
.page-head h1 { font-size: var(--t-page); }
.page-head .count { font-size: var(--t-meta); color: var(--text-dim); margin-top: calc(8 * var(--px)); }
.settings-layout { grid-template-columns: calc(300 * var(--px)) minmax(0, 1fr); gap: calc(40 * var(--px)); }
.settings-tabs { gap: calc(6 * var(--px)); top: 0; }
.settings-tab { min-height: max(44px, calc(64 * var(--px))); padding: 0 calc(22 * var(--px)); gap: calc(14 * var(--px)); border-radius: 999px; font-size: var(--t-body); font-weight: 600; color: rgba(255, 255, 255, 0.82); }
.settings-tab:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
.settings-tab[aria-current="page"] { background: rgba(255, 255, 255, 0.12); color: #ffffff; box-shadow: none; }
.settings-tab:focus-visible { background: #ffffff; color: #0b0b16; box-shadow: 0 calc(10 * var(--px)) calc(30 * var(--px)) rgba(0, 0, 0, 0.35); }
.settings-content { max-width: calc(1200 * var(--px)); }
.panel { padding: calc(34 * var(--px)); margin-bottom: calc(24 * var(--px)); border: 0; border-radius: calc(32 * var(--px)); background: var(--glass-panel); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
.panel .panel { background: rgba(255, 255, 255, 0.05); }
.panel > h2 { font-size: var(--t-section); margin-bottom: calc(22 * var(--px)); }
.theme-grid { grid-template-columns: repeat(auto-fill, minmax(calc(230 * var(--px)), 1fr)); gap: calc(18 * var(--px)); }
.theme-card { position: relative; padding: calc(14 * var(--px)); gap: calc(6 * var(--px)); border: 0; border-radius: calc(24 * var(--px)); background: rgba(255, 255, 255, 0.06); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); transition: transform var(--select), box-shadow var(--select); }
/* The theme in use: a white edge and an accent dot (the accent never marks the selection itself). */
.theme-card[aria-checked="true"] { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.7); }
.theme-card[aria-checked="true"]::after { content: ""; position: absolute; top: calc(22 * var(--px)); right: calc(22 * var(--px)); width: calc(12 * var(--px)); height: calc(12 * var(--px)); border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(4, 4, 14, 0.6); }
.theme-card:focus-visible { transform: scale(var(--grow-btn)); box-shadow: var(--ring), var(--lift); }
.theme-swatch { border-radius: calc(14 * var(--px)); }
.theme-name { font-size: var(--t-body); font-weight: 600; }
.theme-desc { font-size: var(--t-caption); }
.stat, .notice { border: 0; border-radius: calc(24 * var(--px)); background: var(--glass-panel); }
.table th { text-transform: none; letter-spacing: 0; font-size: var(--t-caption); }
.table td { font-size: var(--t-meta); }
.path-list li, .folder-item { border-radius: 999px; }
.library-picker { border-color: rgba(255, 255, 255, 0.16); border-radius: calc(20 * var(--px)); }
.avatar { border-radius: 50%; }
.avatar-choice { border-radius: 50%; }
```

- [ ] **Step 5: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs settings foundations` → all `PASS`. Compare `settings-tv.png` with the `SettingsProfile` board.

- [ ] **Step 6: Checkpoint**

`npm test` green. Files: `public/js/views/settings.js`, `public/css/app.css`, `themes/orbit/theme.css`, devtools `orbit-ui.mjs`.

---

### Task 14: Library, search, add-ons, Who's watching, PIN, sign-in, messages

**Files:**
- Modify: `themes/orbit/theme.css` (CSS only; these screens already use shared classes)
- Modify: `/home/claude/devtools/orbit-ui.mjs` (add the `screens` section)

**Interfaces:**
- Consumes: the existing markup:
  - library, search and add-ons: `.page-head`, `.toolbar` (`select`, `input[type=search]`, `label.check`), `.library-results .grid`, `.search-box`, `.addon-tile`;
  - profiles and PIN: `.picker-page`, `.picker-profile .avatar`, `.picker-actions .btn`, `.pin-input`;
  - sign-in and messages: `.auth-page`, `.auth-card`, `.toast`, `.empty-state`.
- Produces: no new names.

- [ ] **Step 1: Write the failing "screens" checks**

In `orbit-ui.mjs`, insert above the marker line:

```js
if (run('screens')) {
  await go(page, '#/library/1', '.library-results .grid');
  check('library: its name and how many', /Movies/.test(await page.textContent('.page-head h1')) && /\d+ movies?/.test(await page.textContent('.page-head .count')));
  check('library: the controls are glass pills', parseFloat(await style(page, '.toolbar select', 'borderTopLeftRadius')) >= 28 && parseFloat(await style(page, '.toolbar .check', 'borderTopLeftRadius')) >= 28);
  check('library: posters have their names underneath', await page.evaluate(() => getComputedStyle(document.querySelector('.library-results .card-meta')).display !== 'none'));
  await page.screenshot({ path: '/tmp/shots/orbit/library-tv.png' });
  await go(page, '#/search', '.search-box');
  check('search: a big glass search field', (await rect(page, '.search-box')).h >= 80);
  await go(page, '#/addons', '.page-head');
  await page.screenshot({ path: '/tmp/shots/orbit/addons-tv.png' });
  await go(page, '#/profiles', '.picker-grid');
  check("Who's watching: round pictures", (await style(page, '.picker-profile .avatar', 'borderTopLeftRadius')) === '50%');
  check("Who's watching: a soft glow behind, not a flat colour", (await style(page, '.picker-page', 'backgroundColor')) === 'rgba(0, 0, 0, 0)' && (await style(page, '.environment', 'display')) === 'block');
  await press(page, 'ArrowRight');
  await page.waitForTimeout(300);
  check("Who's watching: the selected picture grows, with the white ring", /^matrix\(1\.1, 0, 0, 1\.1/.test((await style(page, '.picker-profile:focus .avatar', 'transform')) || ''));
  check("Who's watching: Manage profiles and Sign out", (await page.locator('.picker-actions .btn').count()) === 2);
  await page.screenshot({ path: '/tmp/shots/orbit/profiles-tv.png' });
  await page.click('.picker-profile:has-text("dallas")');
  await page.waitForSelector('dialog[open] .pin-input');
  check('PIN entry: a large glass field', parseFloat(await style(page, '.pin-input', 'fontSize')) >= 40);
  await page.screenshot({ path: '/tmp/shots/orbit/pin-tv.png' });
  await page.keyboard.type('4321');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.home-view');
  await page.evaluate(async () => (await import('/js/components.js')).toast('Saved', { type: 'success' }));
  check('messages are glass pills', parseFloat(await style(page, '.toast', 'borderTopLeftRadius')) > 20);
  // Sign-in, in a fresh browser with no session.
  const guest = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await guest.goto('http://127.0.0.1:8787/');
  await guest.waitForSelector('.auth-card');
  await guest.waitForTimeout(500);
  const auth = await guest.evaluate(() => ({ glass: getComputedStyle(document.querySelector('.auth-card')).backdropFilter, env: getComputedStyle(document.querySelector('.environment')).display }));
  check('sign-in: a glass card over deep space', auth.glass !== 'none' && auth.env === 'block', JSON.stringify(auth));
  await guest.screenshot({ path: '/tmp/shots/orbit/signin-tv.png' });
  await guest.close();
}
```

- [ ] **Step 2: Run the checks to see them fail**

Run: `node /home/claude/devtools/orbit-ui.mjs screens`
Expected: FAIL on the pill controls, the search field height, the picker background, the avatar growth, the PIN size, the toast shape and the sign-in card.

- [ ] **Step 3: Append the look for these screens to `themes/orbit/theme.css`**

```css
/* ---------- Library, search and add-ons ---------- */
.toolbar { gap: calc(14 * var(--px)); }
.toolbar select, .toolbar input[type="search"] { width: auto; min-width: calc(220 * var(--px)); background: var(--glass-clear); }
.toolbar .check { min-height: max(44px, calc(60 * var(--px))); padding: 0 calc(24 * var(--px)); border-radius: 999px; background: var(--glass-clear); box-shadow: inset 0 0 0 1px var(--glass-edge); font-size: var(--t-body); font-weight: 500; }
.toolbar .check:focus-within { box-shadow: var(--ring); }
.check input[type="checkbox"] { width: max(16px, calc(22 * var(--px))); height: max(16px, calc(22 * var(--px))); accent-color: var(--accent); }
.grid { gap: calc(36 * var(--px)) calc(24 * var(--px)); }
.view-tabs-wrap { padding: 0 var(--gutter) calc(20 * var(--px)); }
.search-box { width: min(calc(1100 * var(--px)), 100%); min-height: max(56px, calc(84 * var(--px))); padding: 0 calc(30 * var(--px)); gap: calc(18 * var(--px)); border: 0; background: var(--glass-clear); box-shadow: inset 0 0 0 1px var(--glass-edge); }
.search-box:focus-within { box-shadow: var(--ring); }
.search-box .icon { width: calc(30 * var(--px)); height: calc(30 * var(--px)); min-width: 20px; min-height: 20px; }
.search-box .search-input { font-size: max(16px, calc(30 * var(--px))) !important; min-height: max(56px, calc(84 * var(--px))) !important; box-shadow: none !important; }
.search-section h2 { font-size: var(--t-section); }
.addon-tile { padding: calc(26 * var(--px)); border: 0; border-radius: calc(26 * var(--px)); background: var(--glass-panel); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); transition: transform var(--select), box-shadow var(--select); }
.addon-tile:hover { transform: scale(1.03); }
.addon-tile:focus-visible, html.kbd .addon-tile:focus-visible { transform: scale(var(--grow-btn)); box-shadow: var(--ring), var(--lift); }
.addon-icon { width: calc(72 * var(--px)); height: calc(72 * var(--px)); border-radius: 50%; background: rgba(255, 255, 255, 0.1); color: var(--accent); }
.load-more { padding: calc(36 * var(--px)); }

/* ---------- Who's watching, and the PIN ---------- */
.picker-page { background: transparent; gap: calc(40 * var(--px)); }
.picker-brand { color: #ffffff; font-size: var(--t-meta); }
.picker-page h1 { font-size: calc(60 * var(--px)); letter-spacing: -0.04em; }
.picker-grid { gap: calc(64 * var(--px)); }
.picker-profile { gap: calc(22 * var(--px)); color: var(--text-soft); }
.picker-profile .avatar { width: max(96px, calc(180 * var(--px))); height: max(96px, calc(180 * var(--px))); border-radius: 50%; font-size: max(40px, calc(76 * var(--px))); box-shadow: 0 calc(20 * var(--px)) calc(40 * var(--px)) rgba(0, 0, 0, 0.45); transition: transform var(--select), box-shadow var(--select); }
.picker-profile:hover .avatar, .picker-profile:focus-visible .avatar { transform: scale(var(--grow-avatar)); box-shadow: 0 0 0 calc(6 * var(--px)) #05050c, 0 0 0 calc(11 * var(--px)) #ffffff, 0 calc(30 * var(--px)) calc(60 * var(--px)) rgba(0, 0, 0, 0.6); }
.picker-profile:focus-visible { color: #ffffff; box-shadow: none; }
.picker-name { font-size: max(16px, calc(26 * var(--px))); font-weight: 600; }
.chip-kids { background: #ffd166; color: #0b0b16; }
.picker-actions { gap: calc(16 * var(--px)); }
/* PINs are 4 to 8 digits, so one large field rather than four boxes. */
.pin-input { min-height: max(64px, calc(96 * var(--px))) !important; border-radius: calc(24 * var(--px)) !important; font-size: max(32px, calc(48 * var(--px))) !important; letter-spacing: 0.6em; text-align: center; }

/* ---------- Sign-in and first-time setup ---------- */
.auth-page { background: transparent; }
.auth-card {
  width: min(calc(600 * var(--px)), 100%); padding: calc(48 * var(--px)); border: 0; border-radius: calc(40 * var(--px));
  background: var(--glass-tinted); -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted);
  box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), inset 0 1px 0 var(--glass-highlight), 0 calc(30 * var(--px)) calc(80 * var(--px)) rgba(0, 0, 0, 0.6);
}
.auth-card-wide { width: min(calc(760 * var(--px)), 100%); }
.auth-brand { font-size: calc(30 * var(--px)); font-weight: 700; }
.auth-card h1 { font-size: calc(44 * var(--px)); }

/* ---------- Messages, empty pages, errors ---------- */
.toasts { bottom: calc(40 * var(--px) + 24px); }
.toast { padding: calc(18 * var(--px)) calc(30 * var(--px)); border-radius: 999px; background: rgba(24, 24, 38, 0.9); color: #ffffff; -webkit-backdrop-filter: var(--blur-tinted); backdrop-filter: var(--blur-tinted); box-shadow: inset 0 0 0 1px var(--glass-tinted-edge), var(--lift); font-size: var(--t-body); font-weight: 600; }
.toast-error { background: rgba(150, 28, 48, 0.94); }
.toast-success { background: rgba(14, 92, 64, 0.94); color: #ffffff; }
.empty-state { max-width: calc(760 * var(--px)); }
.empty-state :is(h1, h2) { font-size: var(--t-page); }
.empty-state p { font-size: var(--t-body); color: var(--text-soft); }
.empty-state .empty-icon { width: calc(110 * var(--px)); height: calc(110 * var(--px)); border-radius: 50%; background: var(--glass-clear); color: var(--accent); }
.form-error { color: #ffb3ba; }
```

- [ ] **Step 4: Run the checks to see them pass**

Run: `node /home/claude/devtools/orbit-ui.mjs` (every section) → all `PASS`, exit code 0.

- [ ] **Step 5: Checkpoint, and show Dallas (controller)**

`npm test` green. Files: `themes/orbit/theme.css`, devtools `orbit-ui.mjs`.

Stage 6 is done. Send Dallas `library-tv.png`, `profiles-tv.png`, `settings-tv.png` and `signin-tv.png`, then carry on.

---

## Stage 7 — Accessibility, performance, older themes, docs

### Task 15: Accessibility and performance pass; the older themes are unchanged

**Files:**
- Modify: `/home/claude/devtools/orbit-lib.mjs` (add `contrastOf`)
- Create: `/home/claude/devtools/orbit-a11y.mjs`
- Modify, only where a check fails: `themes/orbit/theme.css` (scrim or glass alpha, text tone)

**Interfaces:**
- Produces: `contrastOf(page, selector) → Promise<number|null>` in `orbit-lib.mjs`. It gives the contrast ratio of the element's text against the pixels actually behind it on screen.

- [ ] **Step 1: Add the contrast helper**

Append to `/home/claude/devtools/orbit-lib.mjs`:

```js
/**
 * Contrast of an element's text against what is really behind it on screen. The element is
 * screenshotted; the 60% of its pixels least like the text are taken as the background, and the
 * one of those closest to the text (the worst case) is compared with the text colour blended by its
 * own transparency. Returns the ratio, or null when the element isn't on screen.
 */
export async function contrastOf(page, selector) {
  const el = await page.$(selector);
  if (!el) return null;
  const box = await el.boundingBox();
  if (!box || box.width < 2 || box.height < 2) return null;
  const color = await el.evaluate((e) => getComputedStyle(e).color);
  const png = await page.screenshot({ clip: box });
  return page.evaluate(async ([data, color]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r, g, b, a = 1] = color.match(/[\d.]+/g).map(Number);
    const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = (R, G, B) => 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B);
    const textLum = lum(r, g, b);
    const pixels = [];
    for (let i = 0; i < px.length; i += 4) pixels.push([px[i], px[i + 1], px[i + 2], lum(px[i], px[i + 1], px[i + 2])]);
    pixels.sort((p, q) => Math.abs(q[3] - textLum) - Math.abs(p[3] - textLum)); // least like the text first
    const bg = pixels[Math.min(pixels.length - 1, Math.floor(pixels.length * 0.6))];
    const eff = lum(r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a));
    return Math.round(((Math.max(eff, bg[3]) + 0.05) / (Math.min(eff, bg[3]) + 0.05)) * 100) / 100;
  }, [png.toString('base64'), color]);
}
```

- [ ] **Step 2: Write the checks**

`/home/claude/devtools/orbit-a11y.mjs`:

```js
// Orbit accessibility and performance pass (v0.7.0). Dev server: restart-dev.sh.
//   node /home/claude/devtools/orbit-a11y.mjs
// Text contrast on its real background, the selection ring, reduced motion, Reduce effects, and blur only on
// floating surfaces. Large text (24px, or 18.66px bold) needs 3:1, everything else 4.5:1.
import { open, signIn, check, failed, api, setPrefs, go, press, style, blurred, contrastOf } from './orbit-lib.mjs';

const { browser, page, errors } = await open();
await signIn(page);
await setPrefs(page, { theme: null, reduceEffects: null, reduceMotion: null });

async function contrast(sel, where) {
  const ratio = await contrastOf(page, sel);
  if (ratio == null) return check(`${where}: ${sel} is on screen`, false, 'not found or not visible');
  const large = await page.evaluate((s) => {
    const cs = getComputedStyle(document.querySelector(s));
    const size = parseFloat(cs.fontSize);
    return size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
  }, sel);
  const need = large ? 3 : 4.5;
  check(`${where}: ${sel} ${ratio}:1 (needs ${need})`, ratio >= need, String(ratio));
}

const SCREENS = [
  ['#/', '.home-view', ['.spot-overview', '.spot-meta .meta-line', '.row-title', '.row-landscape .card-sub-orbit', '.row-square .card-sub', '.orbit-cluster .nav-clock']],
  ['#/item/4', '.episode-row', ['.overview', '.detail-info .meta-line', '.episode-story', '.episode-card .card-sub', '.season-tab:not([aria-selected="true"])']],
  ['#/item/3', '.detail-info', ['.overview', '.details-list dt', '.details-list dd']],
  ['#/item/15', '.tracks', ['.detail-info .meta-line', '.track-title', '.track-time']],
  ['#/library/1', '.library-results .grid', ['.page-head .count', '.library-results .card-title']],
  ['#/settings/profile', '.theme-grid', ['.panel > h2', '.toggle-hint', '.theme-desc', '.field > label']],
  ['#/profiles', '.picker-grid', ['.picker-page h1', '.picker-name']],
];
for (const [hash, wait, targets] of SCREENS) {
  await go(page, hash, wait);
  await page.waitForTimeout(1200); // artwork and its colour have arrived
  for (const t of targets) await contrast(t, hash);
  if (hash === '#/profiles') {
    await page.click('.picker-profile:has-text("dallas")');
    await page.waitForSelector('dialog[open] .pin-input');
    await page.keyboard.type('4321');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.home-view');
  }
}
// The menu, open.
await go(page, '#/', '.home-view');
await press(page, 'ArrowUp', 'ArrowLeft');
await page.waitForTimeout(400);
await contrast('.orbit-menu .nav-link[data-nav="search"] .nav-label', 'menu open');
const pill = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.backgroundColor, s.color]; });
check('menu: the selected entry is a white pill with dark text', pill[0] === 'rgb(255, 255, 255)' && pill[1] === 'rgb(11, 11, 22)', pill.join(' / '));
await press(page, 'ArrowRight');
// The selection ring: white, with a dark gap, so it shows on any artwork (3:1 guaranteed by the gap).
const rings = [];
for (const [hash, wait, sel] of [['#/', '.home-view', '.spot-actions .btn-primary'], ['#/', '.home-view', '.row-poster .card'], ['#/item/4', '.episode-row', '.season-tab'], ['#/item/4', '.episode-row', '.episode-card']]) {
  await go(page, hash, wait);
  await press(page, 'ArrowUp');
  await page.evaluate((s) => document.querySelector(s).focus(), sel);
  await page.waitForTimeout(250);
  rings.push([sel, await page.evaluate((s) => { const e = document.querySelector(s); return getComputedStyle(e.matches('.card') ? e.querySelector('.card-art') : e).boxShadow; }, sel)]);
}
for (const [sel, shadow] of rings) check(`ring on ${sel}: dark gap, then white`, /rgb\(5, 5, 12\) 0px 0px 0px 5px, rgb\(255, 255, 255\) 0px 0px 0px 9px/.test(shadow), shadow);
// The player's side panel and the mini-player.
const ep = (await api(page, 'GET', '/api/items/4')).nextEpisode.id;
await go(page, `#/play/${ep}`, '.player video');
await page.waitForFunction(() => document.querySelector('.player video')?.readyState >= 2, null, { timeout: 20000 });
await press(page, 'ArrowUp');
await contrast('.player-title p', 'player');
await contrast('.seek-wrap .time', 'player');
await page.focus('button[aria-label="Subtitles (C)"]');
await page.keyboard.press('Enter');
await page.waitForSelector('.player-menu:not([hidden])');
await page.waitForTimeout(300);
await contrast('.player-menu .menu-title', 'subtitles panel');
await contrast('.player-menu .menu-item:not(:focus) > span:nth-child(2)', 'subtitles panel');
check('Reduce effects is off: the panel is glass', (await blurred(page, '.player')) > 0);
await go(page, '#/item/15', '.tracks');
await page.click('.detail-info .btn-primary');
await page.waitForSelector('.mini:not([hidden])');
await page.waitForTimeout(800);
await contrast('.mini-sub', 'mini-player');
await page.evaluate(async () => (await import('/js/music.js')).music.stop());

// Performance: blur only on the floating surfaces, never inside what scrolls.
await go(page, '#/', '.home-view');
check('Home: nothing in the rows is blurred', (await blurred(page, '.home-rows')) === 0);
check('Home: only a handful of blurred surfaces', (await blurred(page)) <= 8, String(await blurred(page)));
for (const [hash, wait, inner] of [['#/library/1', '.library-results .grid', '.library-results'], ['#/item/4', '.episode-row', '.detail-body'], ['#/settings/profile', '.theme-grid', '.settings-content']]) {
  await go(page, hash, wait);
  check(`${hash}: nothing scrolling is blurred`, (await blurred(page, inner)) === 0, String(await blurred(page, inner)));
}
// Reduce effects: no blur anywhere, on any screen.
await setPrefs(page, { reduceEffects: true });
for (const [hash, wait] of [['#/', '.home-view'], ['#/item/4', '.episode-row'], ['#/settings/profile', '.theme-grid']]) {
  await go(page, hash, wait);
  check(`Reduce effects: ${hash} has no blur`, (await blurred(page)) === 0, String(await blurred(page)));
}
await setPrefs(page, { reduceEffects: null });
// Reduced motion, from the system and from the profile: nothing grows or slides.
for (const how of ['system', 'profile']) {
  const ctx = how === 'system' ? await open({ reducedMotion: 'reduce' }) : { page };
  if (how === 'system') await signIn(ctx.page);
  else await setPrefs(page, { reduceMotion: true });
  await go(ctx.page, '#/', '.home-view');
  await press(ctx.page, 'ArrowUp', 'ArrowDown');
  await ctx.page.waitForTimeout(250);
  const m = await ctx.page.evaluate(() => ({
    card: getComputedStyle(document.activeElement.querySelector('.card-art') || document.activeElement).transform,
    page: parseFloat(getComputedStyle(document.querySelector('.view')).animationDuration),
    menu: parseFloat(getComputedStyle(document.querySelector('.orbit-menu')).transitionDuration),
  }));
  check(`reduced motion (${how}): a selected card doesn't grow`, /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(m.card), m.card);
  check(`reduced motion (${how}): pages and the menu don't slide`, m.page < 0.01 && m.menu < 0.01, JSON.stringify(m));
  if (how === 'system') await ctx.browser.close();
  else await setPrefs(page, { reduceMotion: null });
}
check('no console errors', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
```

- [ ] **Step 3: Run the pass**

Run: `node /home/claude/devtools/orbit-a11y.mjs`
Expected: all `PASS`. For every `FAIL`:
- **Contrast:** darken the surface behind that text in `themes/orbit/theme.css`:
  - for text on the window artwork, raise the first stop of the matching gradient in `.backdrop::after`;
  - for text on glass, raise `--glass-tinted` or `--glass-panel`.

  Go up 0.04 in alpha at a time. If the surface already matches the spec's upper value, raise the text instead, from 66% to 86% white, or from 86% to white. Rerun after each change, and note every change in the task summary.
- **Ring:** find the rule that replaces `box-shadow` on that element's `:focus-visible` and give it `var(--ring)`.
- **Blur inside a scroller:** set `-webkit-backdrop-filter: none; backdrop-filter: none` on that element in `theme.css`.
- **Reduced motion:** use `scale(var(--grow-…))` on that element instead of a fixed scale.

- [ ] **Step 4: The older themes must look as they did**

Run: `node /home/claude/devtools/oldthemes-compare.mjs compare`
Expected: 30 × `SAME` and `all pages match`. For a `DIFF`, open `/tmp/orbit-cmp/<name>-diff.png` (the differing pixels are marked) and find the rule that leaked. Usually it is a selector not scoped to `[data-layout="orbit"]` in `public/css/orbit.css`, a change to shared markup, or a new rule in `public/css/app.css`. Scope or revert it, and rerun until all 30 match.

- [ ] **Step 5: Everything still passes**

Run: `node /home/claude/devtools/orbit-ui.mjs && cd /home/claude/nodeflix && npm test 2>&1 | tail -3` → all `PASS`, `# fail 0`.

- [ ] **Step 6: Checkpoint**

Files: devtools `orbit-lib.mjs`, `orbit-a11y.mjs`, plus any `theme.css` changes from Step 3 (listed in the summary with their before and after values).

---

### Task 16: The existing browser checks, updated for the new markup

**Files:**
- Modify, as needed: `/home/claude/devtools/regress.mjs`, `/home/claude/devtools/rebrand-ui.mjs`, `/home/claude/devtools/extras-ui.mjs` (the last was already changed in Tasks 8 and 11)
- Modify, only for a real regression: the app file at fault

- [ ] **Step 1: Run the three suites the spec names, plus the other UI checks**

```bash
cd /home/claude/devtools
for f in regress.mjs extras-ui.mjs rebrand-ui.mjs music-ui.mjs music-kbd.mjs profiles-ui.mjs dialogs.mjs settings-check.mjs; do
  echo "=== $f"; node $f 2>&1 | grep -E "FAIL|Error|errors" | head -20
done
```

Expected: few or no `FAIL` lines. They now run on Orbit, the new default.

- [ ] **Step 2: Sort each failure into one of two kinds, and fix it**

- **The check relied on the older layout's markup or position** (a menu bar across the top, a full-width mini-player bar, a button's old place). Make that part theme-aware by running it with `await api(page, 'PATCH', '/api/me', { prefs: { theme: 'arctic' } })` before and `{ theme: null }` after, or point it at the Orbit selector from this plan (for example `.orbit-menu .nav-link`, `.detail-info button[aria-label="More"]`). Write down which checks changed and why.
- **The check caught a real regression** (something no longer works in Orbit or in an older theme). Fix the app code, and add a line to `orbit-ui.mjs` in the matching section that fails without the fix.

Rerun that suite after each fix.

- [ ] **Step 3: Everything passes**

Rerun the loop from Step 1 → no `FAIL`. Then run `node /home/claude/devtools/orbit-ui.mjs`, `node /home/claude/devtools/orbit-a11y.mjs` and `cd /home/claude/nodeflix && npm test` → all green.

- [ ] **Step 4: Checkpoint**

List every changed check and every code fix in the task summary.

---

### Task 17: Docs, version 0.7.0, pictures for Dallas, delivery to his PC

**Files:**
- Modify: `package.json` (version), `docs/THEMES.md`, `docs/ARCHITECTURE.md`, `README.md`
- Deliver: every file changed in Tasks 2–16 to `D:\Nodeflix` (same paths), plus this plan
- Update: the project note `claude/build-status.md`

- [ ] **Step 1: Version**

`package.json`: `"version": "0.7.0",`

- [ ] **Step 2: `docs/THEMES.md`**

Replace the first paragraph, from "Themes live in" to "after a page reload.", with:

```markdown
Themes live in `themes/<folder>/` and are picked per person in **Settings → Profile** (admins set the default in
**Settings → Server**). The default is **Orbit**: the page floats in a rounded window over its artwork, with a glass
menu beside it. **Arctic** (inspired by the Arctic family of Kodi skins) and **Arctic Side** are still there, with
Midnight, Harbour, Daylight and Obsidian. Copy `themes/orbit` as a starting point for the Orbit layout,
`themes/arctic` for a menu bar, or `themes/midnight` for a simpler one. Changes to a theme's CSS show up on
refresh — no restart needed. New theme folders appear after a page reload.
```

Replace the `layout` bullet with:

```markdown
- `layout`: `"orbit"` (the page in a floating window, a glass menu on the left, a dock on phones), `"top"` (menu bar)
  or `"side"` (Kodi-style side menu). Phones get a bottom tab bar in the top and side layouts.
```

Add this section before "## What the layout gives you":

````markdown
## The orbit layout

Themes with `"layout": "orbit"` get Orbit's structure from `public/css/orbit.css`; their `theme.css` only gives the
look. What the structure provides:

- **The window** (`main`): fixed and rounded, and the page scrolls inside it.
  - TVs (landscape, 1600 px and wider): inset 40/40/40/168 px, radius 44.
  - Laptops (landscape, 1000–1599 px): 20/20/20/100 px, radius 32.
  - Phones and portrait screens: no window.

  `.backdrop` (the crisp artwork) fills the window.
- **The environment** (`.environment`): the same artwork all round the window. It is drawn into a 64 × 36 canvas and
  stretched, so it looks blurred without a full-screen blur. Style its shade with `.environment::after`.
- **The menu** (`.orbit-menu`, entries `.nav-link[data-nav]`):
  - It floats left of the window and grows to show names while the remote is in it (`html.menu-open`) or under a mouse.
  - `[aria-current="page"]` marks the page you're on.
  - On phones it is a dock at the bottom, and Add-ons and Settings move to `.orbit-tool` buttons in the corner.
- **The cluster** (`.orbit-cluster`): the clock and the profile picture, at the window's top-right.
- **Sizes** are written as `calc(N * var(--px))`, where `--px` is 1px at 1920 px wide, 0.72px at least, and 0.4px on phones.
  The window's insets are `--win-t`, `--win-r`, `--win-b`, `--win-l` and `--win-radius`.
- **Reduce effects** (a profile setting) sets `html.reduce-effects`, and every `backdrop-filter` is switched off.
  `themes/orbit` also turns its glass solid; use the same `--glass-*` names if you want that for free.

`themes/orbit/theme.css` documents its tokens:
- glass: `--glass-clear`, `--glass-tinted`, `--glass-panel`, `--blur-clear`, `--blur-tinted`;
- selection: `--ring`, `--lift`, `--grow-btn`, `--grow-card`, `--grow-avatar`;
- type: `--t-display` … `--t-caption`.

The accent is `--tint`, the colour of the artwork.
````

In "Handy selectors", append after `.intro-line` (admins, episode pages):

```markdown
In Orbit also: `.orbit-menu`, `.orbit-cluster`, `.environment`, `.episode-row`, `.episode-story`, `.details-panel`,
`.upnext-art`, `.upnext-ring` (its fill follows `--left`) and `.home-view.is-compact` (Home below the first row).
```

- [ ] **Step 3: `docs/ARCHITECTURE.md`**

- In the "Web client" section, replace "the layout switches between top and side navigation based on the theme." with:

```markdown
the layout switches between top, side and Orbit navigation based on the theme. For Orbit, `shell.js` builds the
floating menu, and `nav.js` drives it with the remote: Left from the leftmost control enters it, Up/Down move,
Right/Back leave and restore focus. Rows scroll so the selected card stays at the left, and Back on Home goes to
the top first, then opens the menu. These rules are plain functions in `orbit-rules.js`, tested in Node
(`test/orbit-rules.test.js`). Orbit's pages scroll inside the window (`main`), not the document.
```

- After the paragraph that starts "`backdrop.js` owns the full-screen artwork layer", add:

```markdown
In Orbit the same artwork also feeds the *environment* around the window: a 64 × 36 canvas stretched to the whole
screen (two canvases cross-fade). This keeps the soft background cheap on TV browsers.
```

- In the migrations list, after item 7:

```markdown
8. The Orbit theme becomes the default: a stored server default of `arctic` changes to `orbit`. Themes people picked
   for their own profile are kept.
```

- [ ] **Step 4: `README.md`**

- Replace the "**Arctic look**" bullet with:

```markdown
- **Orbit look** — the default theme, made for a TV and a remote:
  - Your artwork fills the screen and the page floats over it in a rounded window, with a glass menu beside it that grows when the remote reaches it.
  - Whatever the remote is on turns white; everything else takes its colour from the artwork.
  - Sora type, wide cards with progress, a side panel for subtitles and audio, and a floating mini-player.
  - **Reduce effects** swaps the glass for solid panels on slower TVs.
  - The **Arctic** looks (inspired by the Arctic: Zephyr – Reloaded and Arctic Horizon 2 Kodi skins) are still there.
```

- In the "**Customisable**" bullet, change `(Arctic, Arctic Side, Midnight, …)` to `(Orbit, Arctic, Arctic Side, Midnight, Harbour, Daylight, Obsidian)`.
- In the **Themes** line (around line 162), replace ``Make your own by copying `themes/arctic` (or the simpler `themes/midnight`).`` with ``Make your own by copying `themes/orbit` (or `themes/arctic`, or the simpler `themes/midnight`).``
- Change the Troubleshooting line about Skip intro to:

```markdown
- **Skip intro is missing or in the wrong place** — an admin can fix it on the episode's page (**… → Edit intro** in
  Orbit, or **Edit** next to "Intro" in the other themes), for one episode or the whole season.
```

- [ ] **Step 5: Final verification**

Run each, and paste the tail of each into the summary:

```bash
cd /home/claude/nodeflix && npm test 2>&1 | tail -4
/home/claude/devtools/restart-dev.sh
node /home/claude/devtools/orbit-ui.mjs 2>&1 | tail -3
node /home/claude/devtools/orbit-a11y.mjs 2>&1 | tail -3
node /home/claude/devtools/oldthemes-compare.mjs compare 2>&1 | tail -1
for f in regress.mjs extras-ui.mjs rebrand-ui.mjs; do node /home/claude/devtools/$f 2>&1 | grep -c FAIL; done
```

Expected:
- `# fail 0`;
- `orbit-ui` and `orbit-a11y`: no FAIL, exit 0;
- `all pages match`;
- `0` for each of the three older suites.

- [ ] **Step 6: Pictures for Dallas at TV, laptop and phone sizes**

Rerun `node /home/claude/devtools/orbit-ui.mjs` so the pictures are current. Also take laptop and phone pictures of Home, a show and the player:

```bash
cd /home/claude/devtools && cat > orbit-sizes.mjs <<'EOF'
// Orbit at laptop and phone sizes, for Dallas.
import { open, signIn, go, api } from './orbit-lib.mjs';
for (const [name, width, height] of [['laptop', 1280, 800], ['phone', 390, 844]]) {
  const { browser, page } = await open({ width, height });
  await signIn(page);
  await go(page, '#/', '.home-view');
  await page.screenshot({ path: `/tmp/shots/orbit/home-${name}.png` });
  await go(page, '#/item/4', '.episode-row');
  await page.screenshot({ path: `/tmp/shots/orbit/show-${name}.png` });
  const ep = (await api(page, 'GET', '/api/items/4')).nextEpisode.id;
  await go(page, `#/play/${ep}`, '.player video');
  await page.waitForTimeout(2500);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/shots/orbit/player-${name}.png` });
  await browser.close();
}
EOF
node orbit-sizes.mjs && ls /tmp/shots/orbit/
```

Look at every picture with the Read tool before sending. Fix anything that is cut off, overlapping or unreadable, then rerun Step 5.

- [ ] **Step 7: Deliver to Dallas's PC (controller)**

1. Copy every changed or new repository file (Tasks 2–17, including this plan and `public/fonts/sora-*` / `OFL-sora.txt`) into `/mnt/user-data/outputs/Atomix/<same path>`.
2. Write each to `D:\Nodeflix\<same path>` with `device_commit_files` (at most 50 per call; `stagedPath` = the outputs path, `devicePath` = the PC path).
3. On the PC, run `cd $HOME/mnt/Nodeflix && npm test 2>&1 | tail -4` with `device_bash`; expect `# fail 0`.
4. Check what changed with `git --no-optional-locks status --short`. A plain `git status` leaves an index lock behind.

Don't commit; Dallas commits and pushes himself. If his computer isn't reachable, say so and leave the files in the conversation instead.

- [ ] **Step 8: Project notes and the wrap-up (controller)**

- Update the project note `claude/build-status.md`: add a "Round 7 (29 Sep): the Orbit look (v0.7.0)" decision and an "Added in v0.7.0" section (what Orbit is, migration 8, Reduce effects, the plan's seven decisions, the test counts). Add to "Not yet verified": a real TV browser and remote, glass smoothness on a slow TV, and `prefers-reduced-transparency`.
- Send Dallas the TV, laptop and phone pictures with SendUserFile, and a short summary of what changed. Include the plan's decisions and anything Task 15 had to adjust.

---

## Self-review notes (for the reviewer)

**Where each spec requirement lands:**

| Spec section | Where it lands |
| --- | --- |
| §1 Foundations | Tasks 2–3 |
| §2 Window, menu, remote | Tasks 4–6 |
| §3 Home | Task 7 |
| §4 Show, movie and album pages | Tasks 8–9 |
| §4 Mini-player | Task 12 |
| §5 Player | Tasks 10–11 |
| §6 Library, profiles, settings | Tasks 13–14 |
| §7 Build, testing, accessibility, performance, docs | Tasks 1 and 15–17 |

**One spec detail kept as it is:** the spec says the top area of Home updates "after a 300ms pause (existing follow-focus behaviour)". The existing behaviour is 120 ms for the remote and 260 ms for a mouse (`followFocus` in `backdrop.js`). The plan keeps it, since the spec asks for the existing behaviour and the older themes share it.

**Checked by eye only:**
- Glass smoothness on a real TV, and the look of the boards themselves: Dallas reviews the pictures at each stage end.
- `prefers-reduced-transparency`: Playwright can't emulate it; the CSS path is the same one Reduce effects uses, which is tested.

