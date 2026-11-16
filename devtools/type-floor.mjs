// TV type floor (visual refresh A3), `node devtools/type-floor.mjs [record-laptop]`
//  1. 1920x1080, Home / a library / a title page / Live TV / Settings, in all seven themes: no visible text computes below 20 px.
//  2. The same pages: card titles and metadata (known selectors below) are >= 24 px (Orbit card titles >= 22), metadata weight >= 500.
//  3. Orbit at 1920x1080 shows >= 5.5 posters across a Home row.
//  4. Orbit at 1366x768 (a laptop: the TV floor does not apply) keeps the sizes recorded in devtools/fixtures/type-floor-laptop.json.
//     `record-laptop` writes that file (done once, at the commit before the floor).
//  SHOTS=<dir> also saves Home and a title page per theme (with stand-in artwork) and exits.
import fs from 'node:fs';
import path from 'node:path';
import { open, go, check, failed } from './lib.mjs';

const THEMES = ['arctic', 'arctic-side', 'daylight', 'harbour', 'midnight', 'obsidian', 'orbit'];
const PAGES = ['#/', '#/library/1', '#/item/1', '#/live', '#/settings'];
const FIXTURE = new URL('./fixtures/type-floor-laptop.json', import.meta.url);

// What counts as metadata and as a card title (the floor is 24 px; Orbit's card titles 22).
const META = '.meta-line, .spot-genres, .live-spot-where, .page-head .count';
const CARD_TITLE = '.card-title, .live-card-title, .live-name';

// Orbit's laptop sizes: selector -> page it lives on. Computed font-size and weight are compared.
const LAPTOP = {
  home: ['#/', ['html', '.orbit-menu .nav-link', '.orbit-clock, .nav-clock', '.row h2, .row-title', '.card-title', '.card-sub', '.spot-title', '.spot-meta', '.badge', '.spot-genres']],
  title: ['#/item/1', ['.detail-title, h1', '.meta-line', '.detail-synopsis, .detail-info p', '.btn']],
  live: ['#/live', ['.live-card-name', '.live-card-next', '.live-card-num', '.live-badge']],
  settings: ['#/settings', ['h1, h2', 'label', '.hint', '.toggle-hint', '.page-head .count']],
};

/** In the page: every visible text node's element below `min` px, plus the classified elements' sizes. */
const scan = (page, { min, META, CARD_TITLE }) =>
  page.evaluate(({ min, META, CARD_TITLE }) => {
    const sel = (el) => {
      const p = [];
      for (let e = el; e && e !== document.body && p.length < 4; e = e.parentElement) {
        p.unshift(e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''));
      }
      return p.join(' > ');
    };
    const hidden = (el) => {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e), r = e.getBoundingClientRect();
        if (s.clip !== 'auto' && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)|rect\(1px, 1px, 1px, 1px\)/.test(s.clip)) return true;
        if (s.clipPath && /inset\((50%|100%)/.test(s.clipPath)) return true;
        if (e === el && (r.width <= 1 || r.height <= 1)) return true; // sr-only and zero-size boxes (the text's own element only: Orbit's nav.nav is 0 px tall around visible text)
        if (e === el && (r.right <= 0 || r.bottom <= 0 || r.left < -1000)) return true; // parked off screen (the skip link until focused)
        if (e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true' && s.position === 'absolute' && r.width < 4) return true;
      }
      return false;
    };
    const small = new Map(), seen = new Map();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) {
      const text = n.nodeValue.trim();
      const el = n.parentElement;
      if (!text || !el || /^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEMPLATE)$/.test(el.tagName) || hidden(el)) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const rec = { sel: sel(el), text: text.slice(0, 40), size, weight: Number(cs.fontWeight) };
      if (size < min) small.set(el, rec);
      seen.set(el, rec);
    }
    const sized = (q) => [...document.querySelectorAll(q)].filter((e) => !hidden(e) && (e.textContent || '').trim()).map((e) => {
      const cs = getComputedStyle(e);
      return { sel: sel(e), text: e.textContent.trim().slice(0, 40), size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) };
    });
    return { small: [...small.values()], meta: sized(META), cards: sized(CARD_TITLE) };
  }, { min, META, CARD_TITLE });

const sizesOf = (page, sels) =>
  page.evaluate((sels) => Object.fromEntries(sels.map((s) => {
    const e = document.querySelector(s);
    if (!e) return [s, null];
    const cs = getComputedStyle(e);
    return [s, { size: cs.fontSize, weight: cs.fontWeight }];
  })), sels);

if (process.env.SHOTS) {
  const { chromium } = (await import('node:module')).createRequire(import.meta.url)('playwright');
  const BASE = process.env.BASE || 'http://localhost:8787';
  const out = process.env.SHOTS; fs.mkdirSync(out, { recursive: true });
  const art = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;
  const dress = (v) => {
    if (Array.isArray(v)) v.forEach(dress);
    else if (v && typeof v === 'object') {
      if (v.id && ['movie', 'show', 'episode'].includes(v.kind)) Object.assign(v, { poster: `/fake-art/poster-${v.id}.svg`, tint: '#c03020', tintWide: '#2040c0' });
      Object.values(v).forEach(dress);
    }
    return v;
  };
  const browser = await chromium.launch();
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
    await ctx.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: true } } });
    const page = await ctx.newPage();
    await page.route(/\/fake-art\/(poster|backdrop)-(\d+)\.svg/, (r) => {
      const [, type, id] = /(poster|backdrop)-(\d+)/.exec(r.request().url());
      r.fulfill({ contentType: 'image/svg+xml', body: type === 'poster' ? art(300, 450, id * 40) : art(1920, 1080, id * 40) });
    });
    await page.route(/\/api\/(home|libraries\/\d+\/items|items\/\d+)(\?|$)/, async (r) => {
      const res = await r.fetch(); const j = dress(await res.json());
      if (/\/api\/items\/\d+/.test(r.request().url()) && j?.item?.id) j.item.backdrop = `/fake-art/backdrop-${j.item.id}.svg`;
      r.fulfill({ response: res, json: j });
    });
    for (const [name, hash] of [['home', '#/'], ['title', '#/item/1']]) {
      await page.goto(`${BASE}/${hash}`); await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(out, `${theme}-${name}.png`) });
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(0);
}

const record = process.argv[2] === 'record-laptop';

if (record || !process.env.SKIP_LAPTOP) {
  const { browser, page } = await open({ width: 1366, height: 768, theme: 'orbit' });
  const now = {};
  for (const [name, [hash, sels]] of Object.entries(LAPTOP)) { await go(page, hash); now[name] = await sizesOf(page, sels); }
  await browser.close();
  if (record) {
    fs.mkdirSync(path.dirname(FIXTURE.pathname), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    console.log(`recorded ${Object.values(now).reduce((n, o) => n + Object.values(o).filter(Boolean).length, 0)} laptop sizes`);
    process.exit(0);
  }
  const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [name, sels] of Object.entries(base)) for (const [s, v] of Object.entries(sels)) {
    const n = now[name][s];
    check(`laptop 1366x768 ${name} ${s}`, JSON.stringify(n) === JSON.stringify(v), `${JSON.stringify(v)} -> ${JSON.stringify(n)}`);
  }
}

let under = 0;
for (const theme of THEMES) {
  const { browser, page, errors } = await open({ width: 1920, height: 1080, theme });
  for (const hash of PAGES) {
    await go(page, hash);
    const r = await scan(page, { min: 20, META, CARD_TITLE });
    const groups = new Map();
    for (const s of r.small) { const k = `${s.size}px ${s.sel}`; const g = groups.get(k) || { n: 0, text: s.text }; g.n++; groups.set(k, g); }
    for (const [k, g] of groups) console.log(`  ${theme} ${hash} ${k} x${g.n} "${g.text}"`);
    under += r.small.length;
    check(`${theme} 1080p ${hash} no text under 20 px`, r.small.length === 0, `${r.small.length} below`);
    const cardMin = theme === 'orbit' ? 22 : 24;
    const badCards = r.cards.filter((c) => c.size < cardMin);
    const badMeta = r.meta.filter((m) => m.size < 24 || m.weight < 500);
    check(`${theme} 1080p ${hash} card titles >= ${cardMin} px`, badCards.length === 0, badCards.slice(0, 2).map((c) => `${c.size} ${c.sel}`).join('; ') || `${r.cards.length} checked`);
    check(`${theme} 1080p ${hash} metadata >= 24 px, weight >= 500`, badMeta.length === 0, badMeta.slice(0, 2).map((c) => `${c.size}/${c.weight} ${c.sel}`).join('; ') || `${r.meta.length} checked`);
  }
  if (theme === 'orbit') {
    await go(page, '#/');
    const across = await page.evaluate(() => {
      const row = document.querySelector('.row-scroller.row-poster');
      const cards = [...row.querySelectorAll(':scope > a.card')];
      const r = row.getBoundingClientRect(), first = cards[0].getBoundingClientRect();
      const stride = cards[1] ? cards[1].getBoundingClientRect().left - first.left : first.width;
      return { n: (r.right - first.left) / stride, w: first.width, cards: cards.length };
    });
    check('orbit 1080p row shows >= 5.5 posters', across.n >= 5.5, `${across.n.toFixed(2)} posters (card ${across.w.toFixed(0)} px)`);
  }
  if (errors.length) check(`${theme} no page errors`, false, errors[0]);
  await browser.close();
}
console.log(`${under} text elements below 20 px in total`);
process.exit(failed() ? 1 : 0);
