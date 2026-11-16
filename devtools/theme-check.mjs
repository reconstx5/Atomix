// Plan C theme checks. `node devtools/theme-check.mjs [check ...]`  (no names: every check)
//   THEMES=arctic,midnight narrows the themes a check visits (each check has its own default)
//   BASE=http://localhost:8797   the dev Atomix (default http://localhost:8787, like the other devtools)
//   SHOTS=<dir>                  keep a screenshot per check and theme
// Needs a dev Atomix (devtools/make-dev.sh) with user dallas / atomix-dev-1, and Playwright outside the repo.
// Artwork is stubbed the way fixed-compare.mjs does with ART=1 (small SVGs through page.route), so the dev media's
// missing art doesn't matter. Prints PASS/FAIL lines and exits 1 on any FAIL. Add a check: put a function in CHECKS.
import fs from 'node:fs';
import path from 'node:path';
import { open, check, failed, BASE } from './lib.mjs';

if (!process.env.BASE || /:8787/.test(process.env.BASE)) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}
const SHOTS = process.env.SHOTS || '';
const only = (process.env.THEMES || '').split(',').filter(Boolean);
const themesFor = (dflt) => (only.length ? only : dflt);

const artSvg = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;
const CLEAR = { oled: null, contrast: null, textScale: null, glass: null, reduceEffects: null, pinnedLibraries: null }; // PATCH prefs merges; null deletes

/** Opens a signed-in page for `theme` with clean appearance prefs and stubbed artwork (posters and backdrops for every title). */
async function session(theme, { width = 1920, height = 1080 } = {}) {
  const s = await open({ width, height, theme, serviceWorkers: 'block' }) /* the app's service worker would answer past page.route */;
  await s.context.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: false, ...CLEAR } } });
  const page = s.page;
  const closeAll = s.browser.close.bind(s.browser);
  s.browser.close = async () => { // leave the profile's appearance prefs clean, as modes-check does
    await s.context.request.patch(`${BASE}/api/me`, { data: { prefs: { ...CLEAR } } }).catch(() => {});
    await closeAll();
  };
  const notFound = [];
  page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
  s.notFound = notFound;
  await page.route(/\/fake-art\/(poster|backdrop)-(\d+)\.svg/, (route) => {
    const [, type, id] = /(poster|backdrop)-(\d+)/.exec(route.request().url());
    route.fulfill({ contentType: 'image/svg+xml', body: type === 'poster' ? artSvg(300, 450, id * 40) : artSvg(1920, 1080, id * 40) });
  });
  const dress = (v) => {
    if (Array.isArray(v)) v.forEach(dress);
    else if (v && typeof v === 'object') {
      if (v.id && ['movie', 'show', 'episode'].includes(v.kind)) Object.assign(v, { poster: `/fake-art/poster-${v.id}.svg`, backdrop: `/fake-art/backdrop-${v.id}.svg`, tint: '#c03020', tintWide: '#2040c0' });
      Object.values(v).forEach(dress);
    }
    return v;
  };
  await page.route(/\/api\/(home|libraries\/\d+\/items)(\?|$)/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ json: dress(await res.json()) });
  });
  return s;
}
async function home(page) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/#/`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForSelector('.rows .row a.card', { timeout: 10000 });
  // The splash makes the page inert until it ends (any key ends it): focus() does nothing while it shows.
  for (let i = 0; i < 20 && (await page.evaluate(() => Boolean(document.querySelector('body > [inert]')))); i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);
}
/** Whether a theme asks for the backdrop to follow focus (its theme.json `backdropFollowsFocus`). */
const followsFocus = (theme) => {
  try { return JSON.parse(fs.readFileSync(new URL(`../themes/${theme}/theme.json`, import.meta.url), 'utf8')).backdropFollowsFocus === true; } catch { return false; }
};
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** The backdrop picture showing now: its address, or '' for none. */
const backdropSrc = (page) => page.evaluate(() => document.querySelector('.backdrop img.is-on')?.getAttribute('src') || '');
/** Start recording every change of the showing backdrop picture (window.__bd). */
const watchBackdrop = (page) => page.evaluate(() => {
  window.__bd = [];
  const on = () => document.querySelector('.backdrop img.is-on')?.getAttribute('src') || '';
  let last = on();
  new MutationObserver(() => { const now = on(); if (now !== last) { window.__bd.push(now); last = now; } })
    .observe(document.querySelector('.backdrop'), { subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
});
/** Focus the card at `index` of the poster rows (not On now); returns its title id. */
const focusCard = (page, index) => page.evaluate((index) => {
  const cards = [...document.querySelectorAll('.rows .row:not([data-row="live-now"]) .row-scroller > a.card')];
  const c = cards[index];
  if (!c) return null;
  c.focus();
  return Number(/\/item\/(\d+)/.exec(c.getAttribute('href') || '')?.[1]) || null;
}, index);
const focusedId = (page) => page.evaluate(() => Number(/\/item\/(\d+)/.exec(document.activeElement?.getAttribute?.('href') || '')?.[1]) || null);

const CHECKS = {
  // Arctic, Arctic Side (theme.json backdropFollowsFocus): Home's backdrop follows a card the remote rests on, and not a card passed while an arrow is held.
  // Midnight: the theme flag is off. The Home spotlight itself sets the backdrop from the focused card in every theme
  // (views/home.js: Spotlight onShow), so a change in Midnight passes only when the spotlight title changed with it.
  async 'follow-focus'() {
    for (const theme of themesFor(['arctic', 'midnight'])) {
      const { browser, page, errors, notFound } = await session(theme);
      try {
        await home(page);
        const flag = await page.evaluate(() => document.documentElement.hasAttribute('data-follow-focus'));
        await watchBackdrop(page);
        const id = await focusCard(page, 2);
        await page.waitForTimeout(500);
        const src = await backdropSrc(page);
        const spotTitle = await page.evaluate(() => document.querySelector('.spot-title')?.textContent || '');
        const cardTitle = await page.evaluate(() => (document.activeElement?.querySelector('.card-title')?.textContent || '').trim());
        if (followsFocus(theme)) {
          check(`follow-focus ${theme}: the theme flag is on`, flag);
          check(`follow-focus ${theme}: card 3 focused, then after 500 ms the backdrop is its art`, id && src.includes(`backdrop-${id}.svg`), `card id ${id}, backdrop ${src}`);
          // Hold ArrowRight for 1.2 s: key repeats (e.repeat) set html.nav-held; the backdrop may change at most once (on release).
          // Start at the row's first card and repeat every 200 ms (6 steps): the row has only 8 cards, and a hold that
          // runs off its end would leave the row for the menu.
          const startId = await focusCard(page, 0);
          await page.waitForTimeout(700);
          await page.evaluate(() => { window.__bd.length = 0; });
          let heldSeen = false;
          for (let t = 0; t < 1200; t += 200) {
            await page.keyboard.down('ArrowRight');
            if (t >= 400) heldSeen = heldSeen || (await page.evaluate(() => document.documentElement.classList.contains('nav-held')));
            await page.waitForTimeout(200);
          }
          const changesDuring = await page.evaluate(() => window.__bd.length);
          await page.keyboard.up('ArrowRight');
          await page.waitForTimeout(700);
          const landed = await focusedId(page);
          const after = await backdropSrc(page);
          check(`follow-focus ${theme}: a held arrow sets html.nav-held`, heldSeen);
          check(`follow-focus ${theme}: during the hold the backdrop changes at most once`, changesDuring <= 1, `${changesDuring} changes`);
          check(`follow-focus ${theme}: the hold moved focus along the row`, landed && landed !== startId, `from ${startId} to ${landed}`);
          check(`follow-focus ${theme}: after the release the backdrop is the card it landed on`, landed && after.includes(`backdrop-${landed}.svg`), `landed ${landed}, backdrop ${after}`);
          // Motion none: focusing a card must not change the backdrop (the older spotlight path must stay out of it too).
          await page.evaluate(() => { document.documentElement.dataset.motion = 'none'; window.__bd.length = 0; });
          const before = await backdropSrc(page);
          // a card whose art is not the one showing
          let other = null;
          for (let i = 0; i < 12 && !other; i++) {
            const id = await page.evaluate((i) => Number(/\/item\/(\d+)/.exec(document.querySelectorAll('.rows .row:not([data-row="live-now"]) .row-scroller > a.card')[i]?.getAttribute('href') || '')?.[1]) || null, i);
            if (id && !before.includes(`backdrop-${id}.svg`)) other = await focusCard(page, i);
          }
          await page.waitForTimeout(900);
          const stillNone = await page.evaluate(() => document.documentElement.dataset.motion === 'none');
          const quiet = await backdropSrc(page);
          check(`follow-focus ${theme}: with motion none, focusing a card leaves the backdrop alone`, stillNone && other && quiet === before && (await page.evaluate(() => window.__bd.length)) === 0, `card ${other}, motion none kept: ${stillNone}, ${before} -> ${quiet}`);
        } else {
          check(`follow-focus ${theme}: the theme flag is off`, !flag);
          const changed = await page.evaluate(() => window.__bd.length);
          check(`follow-focus ${theme}: focusing a card changes the backdrop only with the spotlight`, changed === 0 || Boolean(spotTitle && cardTitle && spotTitle.includes(cardTitle)), `${changed} changes, spotlight "${spotTitle}", card "${cardTitle}"`);
        }
        check(`follow-focus ${theme}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200) + (notFound.length ? ` 404: ${[...new Set(notFound)].slice(0, 5).join(', ')}` : ''));
        await shot(page, `follow-focus-${theme}`);
      } finally {
        await browser.close();
      }
    }
  },
};

const names = process.argv.slice(2);
for (const n of names) if (!CHECKS[n]) { console.log(`unknown check "${n}" (have: ${Object.keys(CHECKS).join(', ')})`); process.exit(2); }
for (const n of names.length ? names : Object.keys(CHECKS)) {
  try { await CHECKS[n](); } catch (e) { check(`${n} ran`, false, String(e.message || e).split('\n')[0]); }
}
process.exit(failed() ? 1 : 0);
