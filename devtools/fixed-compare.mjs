// Before/after for Live TV, the Guide and Home with frozen data and a fixed clock (v0.28). compare.mjs can't compare
// these pages: the dev server's own channels change programme every ~40 s, so two captures never match.
//   node devtools/fixed-compare.mjs record <before-dir>   (old code) saves the API answers to <before-dir>/fixtures.json
//   node devtools/fixed-compare.mjs replay <after-dir> <before-dir>   (new code) captures with those answers
//   node devtools/fixed-compare.mjs diff <before-dir> <after-dir>     markup and pixels (Pillow)
// Run with an IPTV source, e.g. `node devtools/mock-iptv.mjs serve --plain`. THEMES= and PAGES= narrow it.
// ART=1 gives the films, shows and episodes on Home, a library grid and a title page artwork and tints (small SVGs
// answered here; the dev media has none), and the title page a backdrop: the pages are captured once every picture on
// screen (and the backdrop) has loaded (card motion v2: older themes identical at rest after load).
//   ART=1 PAGES='#/,#/library/1,#/item/1' THEMES=arctic,midnight node devtools/fixed-compare.mjs record <dir> …
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const [mode, dir, other] = process.argv.slice(2);
if (mode === 'diff') {
  const { execFileSync } = await import('node:child_process');
  let bad = 0;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const a = fs.readFileSync(path.join(dir, f), 'utf8');
    const b = fs.existsSync(path.join(other, f)) ? fs.readFileSync(path.join(other, f), 'utf8') : '';
    if (a !== b) (bad++, console.log(`MARKUP DIFFERS ${f}`));
    const png = f.replace(/\.html$/, '.png');
    const py = [
      'import sys',
      'from PIL import Image, ImageChops',
      'a = Image.open(sys.argv[1]).convert("RGB"); b = Image.open(sys.argv[2]).convert("RGB")',
      'print("size" if a.size != b.size else (ImageChops.difference(a, b).getbbox() or ""))',
    ].join('\n');
    const d = execFileSync('python3', ['-c', py, path.join(dir, png), path.join(other, png)]).toString().trim();
    if (d) (bad++, console.log(`PICTURE DIFFERS ${png} ${d}`));
  }
  console.log(bad ? `${bad} differences` : 'identical');
  process.exit(bad ? 1 : 0);
}
const fixDir = mode === 'record' ? dir : other;
const T = Date.parse('2026-11-11T19:10:00+13:00');
const PAGES = (process.env.PAGES || '#/live,#/live/guide,#/').split(',');
const THEMES = (process.env.THEMES || 'arctic,arctic-side,midnight,daylight,harbour,obsidian,orbit').split(',');
const SIZES = { desk: [1917, 992], phone: [390, 844] };
fs.mkdirSync(dir, { recursive: true });
const fixFile = path.join(fixDir, 'fixtures.json');
const fixtures = mode === 'replay' ? JSON.parse(fs.readFileSync(fixFile, 'utf8')) : {};
const ART = process.env.ART === '1';
const artSvg = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;
/** ART=1: the titles in an answer with a poster and tints (the answer is otherwise left as it is). */
function dress(v) {
  if (!ART) return v;
  if (Array.isArray(v)) v.forEach(dress);
  else if (v && typeof v === 'object') {
    if (v.id && ['movie', 'show', 'episode'].includes(v.kind)) Object.assign(v, { poster: `/fake-art/poster-${v.id}.svg`, tint: '#c03020', tintWide: '#2040c0' });
    Object.values(v).forEach(dress);
  }
  return v;
}
const browser = await chromium.launch();
for (const theme of THEMES) for (const [size, [w, h]] of Object.entries(SIZES)) {
  if (size === 'phone' && !['orbit', 'arctic', 'midnight'].includes(theme)) continue;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: 'block' }); // the app's service worker would answer past page.route
  await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
  await ctx.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: true } } });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(T);
  if (ART) await page.route(/\/fake-art\/(poster|backdrop)-(\d+)\.svg/, (route) => {
    const [, type, id] = /(poster|backdrop)-(\d+)/.exec(route.request().url());
    route.fulfill({ contentType: 'image/svg+xml', body: type === 'poster' ? artSvg(300, 450, id * 40) : artSvg(1920, 1080, id * 40) });
  });
  // A title page's own title also gets a backdrop (its card art travels into it; at rest it is behind the page).
  const dressPage = (key, data) => {
    data = dress(data);
    if (ART && /^\/api\/items\/\d+(\?|$)/.test(key) && data?.item?.id) data.item.backdrop = `/fake-art/backdrop-${data.item.id}.svg`;
    return data;
  };
  await page.route(/\/api\/(live\/(channels|groups|status|guide|search)|home|libraries\/\d+\/items|items\/\d+)(\?|$)/, async (route) => {
    const key = route.request().url().replace(BASE, '');
    if (mode === 'replay' && fixtures[key]) return route.fulfill({ json: dressPage(key, structuredClone(fixtures[key])) });
    const res = await route.fetch();
    let data = await res.json();
    if (key.startsWith('/api/home')) { data.hero = null; data.rows = data.rows.filter((r) => !/random/.test(r.id)); }
    if (mode === 'record' && !fixtures[key]) fixtures[key] = data;
    if (mode === 'replay') console.log('not recorded', key);
    await route.fulfill({ json: dressPage(key, structuredClone(mode === 'record' ? fixtures[key] : data)) });
  });
  for (const p of PAGES) {
    await page.goto('about:blank'); // each page loaded afresh: a hash change alone would keep the last page's loads
    await page.goto(`${BASE}/${p}`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1800);
    if (ART) await page.waitForFunction(() => [...document.querySelectorAll('main .art img')].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; }).every((i) => i.complete && i.closest('.art').classList.contains('loaded')), null, { timeout: 8000 }).catch(() => console.log('pictures still loading', theme, size, p));
    if (ART) await page.waitForFunction(() => { const b = document.querySelector('.backdrop'); const want = [...(b?.querySelectorAll('img') || [])].some((i) => /fake-art\/backdrop/.test(i.src)); return !want || [...b.querySelectorAll('img.is-on')].some((i) => i.complete && /fake-art\/backdrop/.test(i.src)); }, null, { timeout: 8000 }).catch(() => console.log('backdrop still loading', theme, size, p));
    if (ART) await page.waitForTimeout(800); // the last fades (pictures, the backdrop's cross-fade)
    const html = await page.evaluate(() => document.querySelector('main').outerHTML.replace(/\?v=\d+/g, '?v=X').replace(/ style=""/g, ''));
    const f = `${theme}-${size}-${p.replace(/[#/?=&]+/g, '_')}`;
    fs.writeFileSync(path.join(dir, `${f}.html`), html.replace(/></g, '>\n<'));
    await page.screenshot({ path: path.join(dir, `${f}.png`), mask: [page.locator('.nav-clock, .orbit-clock, time')] });
  }
  await ctx.close();
}
await browser.close();
if (mode === 'record') fs.writeFileSync(fixFile, JSON.stringify(fixtures));
