// Plan C theme checks. `node devtools/theme-check.mjs [check ...]`  (no names: every check)
//   THEMES=arctic,midnight narrows the themes a check visits (each check has its own default)
//   BASE=http://localhost:8797   the dev Atomix (default http://localhost:8787, like the other devtools)
//   SHOTS=<dir>                  keep a screenshot per check and theme
// Needs a dev Atomix (devtools/make-dev.sh) with user dallas / atomix-dev-1, and Playwright outside the repo.
// Artwork is stubbed the way fixed-compare.mjs does with ART=1 (small SVGs through page.route), so the dev media's
// missing art doesn't matter. Prints PASS/FAIL lines and exits 1 on any FAIL. Add a check: put a function in CHECKS.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

/** The profile's theme and reduceMotion as they are now (null when unset), read before a check changes them. */
async function savedPrefs() {
  try {
    const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dallas', password: 'atomix-dev-1' }) });
    const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const me = await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json();
    const p = me.profile?.prefs || {};
    return { theme: p.theme ?? null, reduceMotion: p.reduceMotion ?? null };
  } catch { return {}; }
}

/** Opens a signed-in page for `theme` with clean appearance prefs and stubbed artwork (posters and backdrops for every title). */
async function session(theme, { width = 1920, height = 1080 } = {}) {
  const was = await savedPrefs(); // the profile's own theme and motion setting, put back when the check closes
  const s = await open({ width, height, theme, serviceWorkers: 'block' }) /* the app's service worker would answer past page.route */;
  await s.context.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: false, ...CLEAR } } });
  const page = s.page;
  const closeAll = s.browser.close.bind(s.browser);
  s.browser.close = async () => { // leave the profile's appearance prefs clean, as modes-check does
    await s.context.request.patch(`${BASE}/api/me`, { data: { prefs: { ...CLEAR, ...was } } }).catch(() => {});
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

  // Orbit: the first poster row shows 6.0-6.6 posters, so the 7th peeks (the visible fraction of every card in the
  // row's box, added up). Harbour must show at least 5.0 fully visible posters at 1920x1080.
  async rows() {
    const ENFORCED = { orbit: [6.0, 6.6], harbour: [5.0, Infinity] };
    for (const theme of themesFor(['orbit', 'harbour'])) {
      for (const [width, height] of theme === 'orbit' ? [[1920, 1080], [1366, 768]] : [[1920, 1080]]) {
        const { browser, page, errors } = await session(theme, { width, height });
        try {
          await home(page);
          const n = await page.evaluate(() => {
            const row = [...document.querySelectorAll('.rows .row:not([data-row="live-now"])')].find((r) => r.querySelector('.row-scroller > a.card'));
            if (!row) return null;
            const box = (row.querySelector('.row-scroller') || row).getBoundingClientRect();
            const left = Math.max(box.left, 0), right = Math.min(box.right, innerWidth);
            let sum = 0, cards = 0;
            for (const c of row.querySelectorAll('.row-scroller > a.card')) {
              const r = c.getBoundingClientRect();
              const vis = Math.max(0, Math.min(r.right, right) - Math.max(r.left, left));
              if (vis > 0) { sum += vis / r.width; cards++; }
            }
            return { sum: Math.round(sum * 100) / 100, cards, first: Math.round(row.querySelector('.row-scroller > a.card').getBoundingClientRect().width), box: [Math.round(left), Math.round(right)] };
          });
          const label = `rows ${theme} ${width}x${height}`;
          if (!n) { check(`${label}: has a poster row`, false); continue; }
          const band = ENFORCED[theme];
          const detail = `${n.sum} posters (card ${n.first}px wide, row box ${n.box.join('-')})`;
          if (band) check(`${label}: first row shows ${band[0]}${Number.isFinite(band[1]) ? `-${band[1]}` : ' or more'} posters`, n.sum >= band[0] && n.sum <= band[1], detail);
          else check(`${label}: poster count recorded (not enforced yet)`, true, detail);
          check(`${label}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
          await shot(page, `rows-${theme}-${width}`);
        } finally { await browser.close(); }
      }
    }
  },

  // Harbour's grown card (--focus-grow): one ArrowRight in a row, then in the first frame after it the focused card shows
  // its ring (outline on .card-art) together with the scale; once it settles the scale is --focus-grow. The grown card's
  // box overlaps no neighbour in the row, and its badge and progress track stay inside it (a badge and a progress track are
  // added to the card's art when the dev media has none).
  async grown() {
    for (const theme of themesFor(['harbour'])) {
      const { browser, page, errors } = await session(theme);
      try {
        await home(page);
        await focusCard(page, 1);
        await page.waitForTimeout(300);
        await page.evaluate(() => {
          const art = document.activeElement?.querySelector('.card-art');
          if (!art) return;
          if (!art.querySelector(':scope > .badge:not(.badge-watched)')) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = '4K'; art.append(b); }
          if (!art.querySelector(':scope > .progress')) { const p = document.createElement('div'); p.className = 'progress'; p.innerHTML = '<span style="width:60%"></span>'; art.append(p); }
        });
        await page.keyboard.press('ArrowLeft'); // back to the card before, whose neighbours both exist
        await page.keyboard.press('ArrowRight'); // the single keydown under test
        const read = () => {
          const c = document.activeElement;
          if (!c || !c.classList.contains('card')) return null;
          const art = c.querySelector('.card-art');
          const as = getComputedStyle(art), cs = getComputedStyle(c);
          const m = /matrix\(([^)]+)\)/.exec(cs.transform);
          const scale = m ? Number(m[1].split(',')[0]) : 1;
          const ring = { width: parseFloat(as.outlineWidth) || 0, style: as.outlineStyle, colour: as.outlineColor };
          const box = c.getBoundingClientRect();
          const grow = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--focus-grow')) || 0;
          return { scale, ring, grow, id: Number(/\/item\/(\d+)/.exec(c.getAttribute('href') || '')?.[1]) || null, w: box.width };
        };
        const first = await page.evaluate(`new Promise((res) => requestAnimationFrame(() => res((${read.toString()})())))`);
        await page.waitForTimeout(700);
        const geo = await page.evaluate(() => {
          const c = document.activeElement;
          if (!c || !c.classList.contains('card')) return null;
          const box = c.getBoundingClientRect(), art = c.querySelector('.card-art');
          const ring = getComputedStyle(art);
          const reach = (parseFloat(ring.outlineOffset) || 0) + (parseFloat(ring.outlineWidth) || 0);
          const scroller = c.parentElement;
          const others = [...scroller.querySelectorAll(':scope > a.card')].filter((x) => x !== c).map((x) => x.getBoundingClientRect());
          const artBox = art.getBoundingClientRect();
          const overlap = others.filter((o) => Math.min(o.right, box.right) - Math.max(o.left, box.left) > 0.5 && Math.min(o.bottom, box.bottom) - Math.max(o.top, box.top) > 0.5).length;
          const ringBox = { l: artBox.left - reach, r: artBox.right + reach };
          const ringHits = others.filter((o) => o.width && Math.min(o.right, ringBox.r) - Math.max(o.left, ringBox.l) > 0.5).length;
          const inside = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5; };
          const parts = [...art.querySelectorAll(':scope > .badge, :scope > .progress')];
          return { overlap, ringHits, parts: parts.length, outside: parts.filter((p) => !inside(p)).length, neighbours: others.length };
        });
        const label = `grown ${theme}`;
        check(`${label}: a card is focused after one ArrowRight`, Boolean(first && geo), 'no focused .card');
        if (first && geo) {
          check(`${label}: the ring (an outline of 3px or more) is on the card in the same frame as its scale`, first.ring.style !== 'none' && first.ring.width >= 3 && first.scale > 1.0001, `ring ${first.ring.width}px ${first.ring.style}, scale ${first.scale.toFixed(3)} in the first frame`);
          const settled = await page.evaluate(`(${read.toString()})()`);
          check(`${label}: once settled the card is --focus-grow (${first.grow}) times its size`, Math.abs(settled.scale - first.grow) < 0.002, `scale ${settled.scale.toFixed(3)}`);
          check(`${label}: no row neighbour overlaps the grown card`, geo.overlap === 0, `${geo.overlap} neighbours overlap (of ${geo.neighbours})`);
          check(`${label}: the ring does not touch a neighbour's box`, geo.ringHits === 0, `${geo.ringHits} neighbours reached`);
          check(`${label}: the badge and the progress track stay inside the card`, geo.parts >= 2 && geo.outside === 0, `${geo.parts} parts, ${geo.outside} outside`);
        }
        check(`${label}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
        await shot(page, `grown-${theme}`);
      } finally { await browser.close(); }
    }
  },

  // Orbit's player top bar over the worst frame, a white one: the clock and the icons carry a dark edge (text-shadow or
  // filter), and the clock's pixels still reach 3:1 against the frame sampled beside them.
  async 'player-chrome'() {
    for (const theme of themesFor(['orbit'])) {
      const { browser, page, errors } = await session(theme);
      try {
        await home(page);
        const id = await page.evaluate(() => Number(/\/item\/(\d+)/.exec(document.querySelector('.rows .row:not([data-row="live-now"]) .row-scroller > a.card')?.getAttribute('href') || '')?.[1]) || null);
        await page.goto('about:blank');
        await page.goto(`${BASE}/#/play/${id || 1}`);
        await page.waitForSelector('.player-top', { timeout: 10000 });
        await page.addStyleTag({ content: [
          '.player video { visibility: hidden !important; } .player { background: #fff !important; }',
          '.player-error, .player-spinner, .player-bigplay { display: none !important; }',
          '.player[data-controls="hidden"] .player-top { opacity: 1 !important; transform: none !important; transition: none !important; }'].join('\n') });
        await page.waitForSelector('.player-clock', { timeout: 5000 });
        await page.waitForTimeout(600);
        const info = await page.evaluate(() => {
          const sh = (el) => { const cs = getComputedStyle(el); return { textShadow: cs.textShadow, filter: cs.filter }; };
          const clock = document.querySelector('.player-clock');
          const r = clock.getBoundingClientRect();
          return { clock: sh(clock), icons: [...document.querySelectorAll('.player-top svg')].map(sh), box: { x: r.x, y: r.y, width: r.width, height: r.height } };
        });
        const edge = (o) => (o.textShadow && o.textShadow !== 'none') || (o.filter && o.filter !== 'none');
        check(`player-chrome ${theme}: the clock has a text-shadow or filter`, edge(info.clock), info.clock.textShadow);
        check(`player-chrome ${theme}: the top-bar icons have a text-shadow or filter`, info.icons.length > 0 && info.icons.every(edge), `${info.icons.length} icons`);
        // Pixels: the text colour is the brightest pixel in the clock's box (t.png); the frame behind it is the median pixel of the
        // same box with the text and its shadow switched off (b.png): the white frame under the top gradient, no halo to flatter it.
        const clip = { x: Math.max(0, info.box.x - 4), y: Math.max(0, info.box.y - 4), width: info.box.width + 8, height: info.box.height + 8 };
        const withText = await page.screenshot({ clip });
        await page.addStyleTag({ content: '.player-clock { color: transparent !important; text-shadow: none !important; }' });
        const frame = await page.screenshot({ clip });
        const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '.', 'tc-'));
        fs.writeFileSync(path.join(dir, 't.png'), withText);
        fs.writeFileSync(path.join(dir, 'b.png'), frame);
        const script = [
          'import sys, warnings','warnings.simplefilter("ignore")',
          'from PIL import Image',
          'def lum(c):',
          '    f = lambda v: (v/255/12.92) if v/255 <= 0.04045 else (((v/255)+0.055)/1.055)**2.4',
          '    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2])',
          "t = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')",
          'px = sorted(b.getdata(), key=lum); bg = px[len(px)//2]',
          'ink = max(t.getdata(), key=lum)',
          'hi, lo = sorted([lum(ink), lum(bg)], reverse=True)',
          "print('%.2f #%02x%02x%02x #%02x%02x%02x' % (((hi+0.05)/(lo+0.05),) + tuple(ink) + tuple(bg)))"].join('\n');
        const [ratio, ink, bg] = execFileSync(process.env.PYTHON || 'python', ['-c', script, path.join(dir, 't.png'), path.join(dir, 'b.png')], { encoding: 'utf8' }).trim().split(' ');
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.copyFileSync(path.join(dir, 't.png'), path.join(SHOTS, 'clock-text.png')); fs.copyFileSync(path.join(dir, 'b.png'), path.join(SHOTS, 'clock-frame.png')); }
        fs.rmSync(dir, { recursive: true, force: true });
        check(`player-chrome ${theme}: the clock reads at 3.5:1 or more over the bare white frame`, Number(ratio) >= 3.5, `${ratio}:1, text ${ink} on ${bg}`);
        check(`player-chrome ${theme}: no page errors`, errors.filter((e) => !/Failed to load resource|The stream stopped|NotSupportedError|NotAllowedError|AbortError/i.test(e)).length === 0, errors.join(' | ').slice(0, 200));
        await shot(page, `player-chrome-${theme}`);
      } finally { await browser.close(); }
    }
  },

  // Midnight is the no-blur reference (Task 3): nothing on Home or a title page has a computed backdrop-filter.
  async 'no-blur'() {
    for (const theme of themesFor(['midnight'])) {
      const { browser, page, errors } = await session(theme);
      try {
        await home(page);
        const blurred = () => page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => {
          const cs = getComputedStyle(e);
          return (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none');
        }).map((e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '')));
        const onHome = await blurred();
        check(`no-blur ${theme}: Home has no element with a backdrop-filter`, onHome.length === 0, onHome.slice(0, 5).join(', ') || '0 elements');
        const id = await page.evaluate(() => Number(/\/item\/(\d+)/.exec(document.querySelector('.rows .row:not([data-row="live-now"]) .row-scroller > a.card')?.getAttribute('href') || '')?.[1]) || null);
        if (id) {
          await page.goto('about:blank');
          await page.goto(`${BASE}/#/item/${id}`);
          await page.waitForSelector('.detail-title, .logo-box', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1200);
          const onItem = await blurred();
          check(`no-blur ${theme}: a title page has no element with a backdrop-filter`, onItem.length === 0, onItem.slice(0, 5).join(', ') || '0 elements');
        }
        check(`no-blur ${theme}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
        await shot(page, `no-blur-${theme}`);
      } finally { await browser.close(); }
    }
  },
};

const names = process.argv.slice(2);
for (const n of names) if (!CHECKS[n]) { console.log(`unknown check "${n}" (have: ${Object.keys(CHECKS).join(', ')})`); process.exit(2); }
for (const n of names.length ? names : Object.keys(CHECKS)) {
  try { await CHECKS[n](); } catch (e) { check(`${n} ran`, false, String(e.message || e).split('\n')[0]); }
}
process.exit(failed() ? 1 : 0);
