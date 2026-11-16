// Before/after check for a screen moved to Preact: each page in each theme and size, its markup (normalised) and a
// picture. `node compare.mjs capture <dir>` then `node compare.mjs diff <a> <b>`.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = 'http://localhost:8787';
const [mode, a, b] = process.argv.slice(2);
const PAGES = (process.env.PAGES || '#/,#/item/1,#/item/9,#/item/10,#/lists,#/lists/1,#/lists/2').split(',');
const THEMES = (process.env.THEMES || 'orbit,arctic,arctic-side,midnight,daylight,harbour,obsidian').split(',');
const SIZES = { desk: [1917, 992], phone: [390, 844] };
const name = (t, s, p) => `${t}-${s}-${p.replace(/[#/?=&]+/g, '_')}`;

if (mode === 'capture') {
  fs.mkdirSync(a, { recursive: true });
  const browser = await chromium.launch();
  for (const theme of THEMES) {
    for (const [size, [w, h]] of Object.entries(SIZES)) {
      if (size === 'phone' && !['orbit', 'arctic', 'midnight'].includes(theme)) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', isMobile: size === 'phone', hasTouch: size === 'phone' });
      await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
      await ctx.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: true } } });
      const page = await ctx.newPage();
      // Home's hero and "Something random" row are random: a fixed answer for both runs.
      await page.route('**/api/home', async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        data.hero = null;
        data.rows = data.rows.filter((r) => !/random/.test(r.id));
        await route.fulfill({ response: res, json: data });
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      for (const p of PAGES) {
        await page.goto(`${BASE}/${p}`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1800);
        const html = await page.evaluate(() => {
          const m = document.querySelector('main').cloneNode(true);
          m.querySelectorAll('[data-row="random-picks/random"]').forEach((n) => n.remove());
          return m.outerHTML.replace(/\?v=\d+/g, '?v=X').replace(/ style=""/g, '');
        });
        const file = name(theme, size, p);
        fs.writeFileSync(path.join(a, `${file}.html`), html.replace(/></g, '>\n<'));
        await page.screenshot({ path: path.join(a, `${file}.png`), mask: [page.locator('[data-row="random-picks/random"]'), page.locator('.nav-clock, .orbit-clock, time')] });
      }
      fs.writeFileSync(path.join(a, `errors-${theme}-${size}.txt`), errors.join('\n'));
      await ctx.close();
    }
  }
  await browser.close();
} else if (mode === 'diff') {
  const { execSync } = await import('node:child_process');
  let bad = 0;
  for (const f of fs.readdirSync(a).filter((f) => f.endsWith('.html'))) {
    const x = fs.readFileSync(path.join(a, f), 'utf8');
    const y = fs.existsSync(path.join(b, f)) ? fs.readFileSync(path.join(b, f), 'utf8') : '';
    if (x !== y) {
      bad++;
      console.log(`MARKUP DIFFERS ${f}`);
      try { execSync(`diff ${path.join(a, f)} ${path.join(b, f)} | head -${process.env.LINES || 12}`, { stdio: 'inherit' }); } catch {}
    }
    const png = f.replace('.html', '.png');
    // Pictures: every pixel but the clock corner (top right).
    let same = false;
    try { same = execSync(`python3 ${new URL('./imgdiff.py', import.meta.url).pathname} ${path.join(a, png)} ${path.join(b, png)}`).toString().trim() === 'same'; } catch {}
    if (!same) { bad++; console.log(`PICTURE DIFFERS ${png}`); }
  }
  for (const f of fs.readdirSync(b).filter((f) => f.startsWith('errors-'))) { const t = fs.readFileSync(path.join(b, f), 'utf8'); if (t) { bad++; console.log(`ERRORS ${f}: ${t.slice(0, 300)}`); } }
  console.log(bad ? `${bad} differences` : 'all pages match');
}
