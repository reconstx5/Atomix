// Before/after check for a screen moved to Preact: each page in each theme and size, its markup (normalised) and a
// picture. `node compare.mjs capture <dir>` then `node compare.mjs diff <a> <b>`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { routeItems, FIXTURE_PAGES } from './item-fixtures.mjs';
import { ids as musicIds, MUSIC_PAGES, routeMusicQuiet, stopMusic } from './music-fixtures.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE;
const [mode, a, b] = process.argv.slice(2);
if (mode === 'capture' && (!BASE || /:8787/.test(BASE))) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}
// MUSIC=1: the made-up music (make-music.mjs, music-fixtures.mjs) instead: songs and albums, Now Playing in its states,
// the queue dialog. Each page is started from Home with the music stopped, playback paused at 2.5 s.
const MUSIC = process.env.MUSIC === '1';
// Today's pages plus the made-up title pages (item-fixtures.mjs).
const PAGES = (process.env.PAGES || ['#/', '#/item/1', '#/item/9', '#/item/10', '#/lists', '#/lists/1', '#/lists/2', ...FIXTURE_PAGES].join(',')).split(',');
const T = new Date('2026-11-17T20:00:00').getTime(); // a fixed clock: "Ends at" reads the same in both runs
const THEMES = (process.env.THEMES || 'orbit,arctic,arctic-side,midnight,daylight,harbour,obsidian').split(',');
const SIZES = { desk: [1917, 992], phone: [390, 844] };
let musicEntries = null; // MUSIC=1: { name, path, play, after }, once the ids are known
// Whitespace inside style="..." is evened out (a style set as a string and one set from script differ only in spacing).
const evenStyles = (html) => html.replace(/ style="([^"]*)"/g, (m, v) => ` style="${v.replace(/\s*([:;])\s*/g, '$1').replace(/;$/, '').trim()}"`);
const name = (t, s, p) => `${t}-${s}-${p.replace(/[#/?=&]+/g, '_')}`;

if (mode === 'capture') {
  fs.mkdirSync(a, { recursive: true });
  const browser = await chromium.launch();
  for (const theme of THEMES) {
    for (const [size, [w, h]] of Object.entries(SIZES)) {
      if (size === 'phone' && !['orbit', 'arctic', 'midnight'].includes(theme)) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: 'block' }); // the service worker would answer past page.route
      await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
      await ctx.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: true } } });
      const page = await ctx.newPage();
      await page.clock.setFixedTime(T);
      // Home's hero and "Something random" row are random: a fixed answer for both runs.
      await page.route('**/api/home', async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        data.hero = null;
        data.rows = data.rows.filter((r) => !/random/.test(r.id));
        await route.fulfill({ response: res, json: data });
      });
      await routeItems(page);
      if (MUSIC) {
        await routeMusicQuiet(page);
        musicEntries ||= MUSIC_PAGES(await musicIds(ctx));
      }
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const entry of MUSIC ? musicEntries : PAGES.map((p) => ({ name: name(theme, size, p).slice(`${theme}-${size}-`.length), path: p }))) {
        const p = entry.path;
        if (MUSIC) {
          // Home first, music stopped and the page's own playback set up; then move inside the app (as a click would).
          await page.goto(`${BASE}/#/`);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(1200);
          await stopMusic(page);
          await entry.play?.(page);
          await page.evaluate((h) => { location.hash = h; }, p);
          await page.waitForTimeout(1800);
          await entry.after?.(page);
          if (/^search/.test(entry.name)) await page.evaluate(() => document.activeElement?.blur()); // the search box takes the focus late: sometimes before the picture, sometimes after
          await page.waitForTimeout(entry.after ? 1200 : 400);
          if (entry.play) await page.waitForTimeout(800); // lyrics are placed once the page has its layout
        } else {
          await page.goto(`${BASE}/${p}`);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(1800);
        }
        let html = await page.evaluate((withDialog) => {
          const m = document.querySelector('main').cloneNode(true);
          m.querySelectorAll('[data-row="random-picks/random"]').forEach((n) => n.remove());
          const dlg = withDialog ? [...document.querySelectorAll('dialog[open]')].map((d) => d.outerHTML).join('') : '';
          return m.outerHTML.replace(/\?v=\d+/g, '?v=X').replace(/ style=""/g, '') + dlg;
        }, MUSIC);
        if (MUSIC) html = evenStyles(html);
        const file = MUSIC ? `${theme}-${size}-${entry.name}` : name(theme, size, p);
        fs.writeFileSync(path.join(a, `${file}.html`), html.replace(/></g, '>\n<'));
        await page.screenshot({ path: path.join(a, `${file}.png`), mask: [page.locator('[data-row="random-picks/random"]'), page.locator('.nav-clock, .orbit-clock, time, .ends-at')] });
      }
      fs.writeFileSync(path.join(a, `errors-${theme}-${size}.txt`), errors.join('\n'));
      await ctx.close();
    }
  }
  await browser.close();
} else if (mode === 'diff') {
  const { execSync } = await import('node:child_process');
  if (MUSIC) process.env.TOLERANCE ||= '3'; // a blurred backdrop or a scaled cover can be a step or two off between two runs (a real change is far more)
  let bad = 0;
  // Whether a picture had finished loading when the page was read (loaded, is-instant) is timing, not markup.
  const settle = (t) => t.replace(/class="art art-(\w+)[^"]*"/g, 'class="art art-$1"');
  for (const f of fs.readdirSync(a).filter((f) => f.endsWith('.html'))) {
    const x = settle(fs.readFileSync(path.join(a, f), 'utf8'));
    const y = settle(fs.existsSync(path.join(b, f)) ? fs.readFileSync(path.join(b, f), 'utf8') : '');
    if (x !== y) {
      bad++;
      console.log(`MARKUP DIFFERS ${f}`);
      try { execSync(`diff "${path.join(a, f)}" "${path.join(b, f)}" | head -${process.env.LINES || 12}`, { stdio: 'inherit', shell: process.env.SHELL || 'bash' }); } catch {}
    }
    const png = f.replace('.html', '.png');
    // Pictures: every pixel but the clock corner (top right).
    let same = false;
    try { same = execSync(`${process.env.PYTHON || 'python'} "${fileURLToPath(new URL('./imgdiff.py', import.meta.url))}" "${path.join(a, png)}" "${path.join(b, png)}"`).toString().trim() === 'same'; } catch {}
    if (!same) { bad++; console.log(`PICTURE DIFFERS ${png}`); }
  }
  for (const f of fs.readdirSync(b).filter((f) => f.startsWith('errors-'))) { const t = fs.readFileSync(path.join(b, f), 'utf8'); if (t) { bad++; console.log(`ERRORS ${f}: ${t.slice(0, 300)}`); } }
  console.log(bad ? `${bad} differences` : 'all pages match');
}
