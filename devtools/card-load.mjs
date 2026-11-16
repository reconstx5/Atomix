// Card motion v2 (v0.28), rows and loading: a card's art paints its tint (the artwork's own colour) until the picture
// has decoded, then the picture fades in over 180 ms (img.decode() first); a picture already there when the card is
// drawn shows at once (no fade, no tint); nothing moves while pictures arrive (Home's CLS 0). The first time a page
// with rows is drawn, its first screenful of cards fades and rises 8 px in, 20 ms apart, ≤ 300 ms in all — not on
// Back, not when the page is drawn again. Along a row the remote glides for a single press and jumps while held.
// Reduce: the fades stay, the ripple is a fade without stagger; none: everything at once.
// Artwork is stubbed (the dev media has none) and held back 800 ms.  `node devtools/card-load.mjs`
import { open, go, check, failed } from './lib.mjs';

const TINT = '#c03020';
const TINT_RGB = 'rgb(192, 48, 32)';
const DELAY = 800;
const svg = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;

/** Every film, show and episode gets a poster and tints; pictures answer after `delay` ms. */
async function withArt(context, { delay = DELAY } = {}) {
  await context.route(/\/fake-art\/(poster|backdrop)-(\d+)\.svg/, async (route) => {
    const [, type, id] = /(poster|backdrop)-(\d+)/.exec(route.request().url());
    if (delay) await new Promise((r) => setTimeout(r, delay));
    route.fulfill({ contentType: 'image/svg+xml', headers: { 'cache-control': 'max-age=3600' }, body: type === 'poster' ? svg(300, 450, id * 40) : svg(1920, 1080, id * 40) }).catch(() => {});
  });
  const dress = (it) => it && typeof it === 'object' && it.id && ['movie', 'show', 'episode'].includes(it.kind) && Object.assign(it, { poster: `/fake-art/poster-${it.id}.svg`, tint: TINT, tintWide: TINT });
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      dress(v);
      Object.values(v).forEach(walk);
    }
  };
  await context.route(/\/api\/(home|libraries\/\d+\/items)(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    walk(body);
    route.fulfill({ response: res, json: body });
  });
}

/** Watches from the first script: layout shifts, decode() calls, each drawn page's card animations, each art img. */
function recorder() {
  window.__cls = 0;
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cls += e.value;
      window.__shifts.push({ value: e.value, nodes: (e.sources || []).map((s) => s.node?.className || s.node?.nodeName) });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  window.__decodes = 0;
  const decode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = function () {
    window.__decodes++;
    return decode.call(this);
  };
  window.__scrolls = [];
  const siv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (o) {
    if (this.closest?.('.row-scroller')) window.__scrolls.push(typeof o === 'object' ? o.behavior || 'auto' : 'auto');
    return siv.call(this, o);
  };
  window.__pages = []; // per drawn page: [{ onScreen, anims: [{ delay, dur, props }] }]
  window.__imgs = []; // per art img: what it looked like on its first frame
  const seenView = new WeakSet();
  const look = (img) => {
    const art = img.closest('.art');
    const rec = { src: img.getAttribute('src'), completeAtMount: img.complete && img.naturalWidth > 0 };
    window.__imgs.push(rec);
    requestAnimationFrame(() => {
      rec.firstFrame = { opacity: getComputedStyle(img).opacity, loaded: art.classList.contains('loaded'), transitions: img.getAnimations().length, ph: getComputedStyle(art.querySelector('.art-placeholder')).backgroundColor };
    });
  };
  const onView = (view) => {
    if (seenView.has(view)) return;
    seenView.add(view);
    const rec = { hash: location.hash, cards: null };
    window.__pages.push(rec);
    const take = () => {
      if (!view.querySelector('a.card')) return requestAnimationFrame(take);
      rec.cards = [...view.querySelectorAll('a.card')].map((c) => {
        const r = c.getBoundingClientRect();
        return {
          onScreen: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0,
          anims: c.getAnimations().map((a) => {
            const t = a.effect.getTiming();
            const kf = a.effect.getKeyframes?.() || [];
            return { name: a.animationName || a.transitionProperty || 'waapi', delay: t.delay, dur: t.duration, props: [...new Set(kf.flatMap((k) => Object.keys(k)).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)))] };
          }),
        };
      });
    };
    requestAnimationFrame(take);
  };
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      if (n.matches('main .view') || (n.classList.contains('view') && n.parentElement?.id === 'main')) onView(n);
      for (const img of n.matches('.art img') ? [n] : n.querySelectorAll('.art img')) look(img);
    }
  }).observe(document, { childList: true, subtree: true });
}

async function setup(opts = {}) {
  const o = await open(opts);
  await withArt(o.context, opts);
  await o.context.addInitScript(recorder);
  return o;
}
/** A ripple: a script animation (not a CSS transition such as the row's dimming) that fades the card. */
const isRipple = (a) => a.name === 'waapi' && a.props.includes('opacity');
const pages = (page) => page.evaluate(() => window.__pages.filter((p) => p.cards));
const lastPage = async (page, hash) => (await pages(page)).filter((p) => !hash || p.hash === hash).slice(-1)[0];
const settled = (page) => page.waitForFunction(() => !/\bvt\b|vt-hold/.test(document.documentElement.className), null, { timeout: 5000 }).then(() => page.waitForTimeout(200));
/** Where the remote is: card `i` of the first row with a movie poster card. */
const ROW = '.row-scroller';

// ---- Full motion, Orbit, desktop: placeholder, fade, CLS, ripple ----
{
  const { browser, page, errors } = await setup();
  await page.goto(`${(await import('./lib.mjs')).BASE}/#/`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForSelector('main .row a.card .art img', { timeout: 8000 });
  await page.waitForTimeout(250); // well inside the 800 ms the pictures are held back
  const before = await page.evaluate((TINT_RGB) => {
    const card = [...document.querySelectorAll('main .row a.poster-card')].find((c) => c.style.getPropertyValue('--card-tint'));
    const art = card?.querySelector('.art');
    const ph = art?.querySelector('.art-placeholder');
    const img = art?.querySelector('img');
    const box = art?.getBoundingClientRect();
    return { has: Boolean(card), bg: ph && getComputedStyle(ph).backgroundColor, bgImage: ph && getComputedStyle(ph).backgroundImage, imgOpacity: img && getComputedStyle(img).opacity, loaded: art?.classList.contains('loaded'), w: box?.width, h: box?.height, TINT_RGB };
  }, TINT_RGB);
  check('placeholder: a tinted poster card paints its tint before the picture', before.has && before.bg === TINT_RGB && before.bgImage === 'none', JSON.stringify(before));
  check('placeholder: the picture is not shown yet', before.imgOpacity === '0' && !before.loaded, JSON.stringify(before));
  check('placeholder: the art box already has its final size', before.w > 50 && Math.abs(before.h / before.w - 1.5) < 0.02, JSON.stringify(before));
  // The picture arrives: decoded, then a 180 ms fade.
  await page.waitForFunction(() => document.querySelector('main .row a.poster-card .art.loaded'), null, { timeout: 5000 });
  const fade = await page.evaluate(() => {
    const art = document.querySelector('main .row a.poster-card .art.loaded');
    const img = art.querySelector('img');
    const s = getComputedStyle(img);
    return { prop: s.transitionProperty, dur: s.transitionDuration, decodes: window.__decodes, anims: img.getAnimations().map((a) => a.transitionProperty) };
  });
  check('fade: the picture fades in over 180 ms', /opacity/.test(fade.prop) && fade.dur === '0.18s', JSON.stringify(fade));
  check('fade: decode() is waited for before the fade', fade.decodes > 0, JSON.stringify(fade));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const art = document.querySelector('main .row a.poster-card .art');
    return { opacity: getComputedStyle(art.querySelector('img')).opacity, ph: getComputedStyle(art.querySelector('.art-placeholder')).visibility };
  });
  check('fade: at rest the picture shows and the placeholder is gone', after.opacity === '1' && after.ph === 'hidden', JSON.stringify(after));
  const cls = await page.evaluate(() => ({ cls: window.__cls, shifts: window.__shifts }));
  check('no layout shift while pictures arrive (Home CLS 0)', cls.cls === 0, JSON.stringify(cls));
  // The ripple of the first visit (boot).
  const home = await lastPage(page, '#/');
  const on = (home?.cards || []).filter((c) => c.onScreen);
  const off = (home?.cards || []).filter((c) => !c.onScreen);
  const rip = on.map((c) => c.anims.find((a) => isRipple(a))).filter(Boolean);
  const delays = rip.map((a) => a.delay);
  check('ripple: every card on screen fades in on the first visit', on.length >= 4 && rip.length === on.length, JSON.stringify(home?.cards?.slice(0, 4)));
  check('ripple: 20 ms apart from 0 (0, 20, 40 …)', delays.length >= 4 && delays[0] === 0 && delays.slice(1, 4).every((d, i) => d - delays[i] === 20), JSON.stringify(delays));
  check('ripple: ≤ 300 ms in all', rip.length > 0 && Math.max(...rip.map((a) => a.delay + a.dur)) <= 300, JSON.stringify(rip.map((a) => a.delay + a.dur)));
  check('ripple: the cards rise (translate) as they fade', rip.length > 0 && rip.every((a) => a.props.includes('translate') || a.props.includes('transform')), JSON.stringify(rip[0]));
  check('ripple: cards off screen appear without animation', off.length > 0 && off.every((c) => c.anims.length === 0), `${off.length} off screen`);
  // Another page, then Home again from the menu (forward): a first mount again — with the pictures now cached.
  await page.evaluate(() => (location.hash = '#/library/1'));
  await page.waitForSelector('main .library-results a.card, main .library-scroll a.card', { timeout: 8000 });
  await settled(page);
  const lib = await lastPage(page, '#/library/1');
  check('ripple: a library page ripples on its first visit', (lib?.cards || []).some((c) => c.onScreen && c.anims.some((a) => isRipple(a))), JSON.stringify(lib?.cards?.slice(0, 2)));
  // Open a card from the library, then Back: no ripple.
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => document.querySelector('main a.card').focus());
  await page.waitForTimeout(300);
  const n0 = (await pages(page)).length;
  await page.keyboard.press('Enter');
  await page.waitForSelector('.detail-header', { timeout: 8000 });
  await settled(page);
  await page.keyboard.press('Backspace');
  await page.waitForSelector('main .library-results a.card, main .library-scroll a.card', { timeout: 8000 });
  await settled(page);
  const back = await lastPage(page, '#/library/1');
  check('ripple: none on Back', (await pages(page)).length > n0 && back && back.cards.every((c) => !c.anims.some((a) => isRipple(a))), JSON.stringify(back?.cards?.slice(0, 2)));
  // Home again (cached pictures): shown at once, no fade, no tint flash.
  const i0 = await page.evaluate(() => window.__imgs.length);
  await page.evaluate(() => (location.hash = '#/'));
  await page.waitForSelector('main .row a.card', { timeout: 8000 });
  await settled(page);
  await page.waitForTimeout(200);
  const cached = (await page.evaluate((i0) => window.__imgs.slice(i0), i0)).filter((r) => r.completeAtMount);
  check('cached: pictures there when drawn show at once (no fade, no tint)', cached.length >= 3 && cached.every((r) => r.firstFrame && r.firstFrame.opacity === '1' && r.firstFrame.loaded && r.firstFrame.transitions === 0), JSON.stringify(cached.slice(0, 2)));
  // Open a card from Home, then Back to Home: no ripple.
  await page.evaluate(() => document.querySelector('main .row[data-row="recent-1"] .row-scroller a.poster-card').focus());
  await page.waitForTimeout(300);
  const h0 = (await pages(page)).length;
  await page.keyboard.press('Enter');
  await page.waitForSelector('.detail-header', { timeout: 8000 });
  await settled(page);
  await page.keyboard.press('Backspace');
  await page.waitForSelector('main .row a.card', { timeout: 8000 });
  await settled(page);
  const homeBack = (await pages(page)).slice(h0).filter((p) => p.hash === '#/');
  check('ripple: none on Back to Home', homeBack.length >= 1 && homeBack.every((p) => p.cards.every((c) => !c.anims.some((a) => isRipple(a)))) && homeBack.slice(-1)[0].cards.every((c) => !c.anims.some((a) => isRipple(a))), JSON.stringify(homeBack.map((p) => p.cards.slice(0, 2))));
  // Drawn again in place (refreshView-like: the same address): no ripple.
  const n1 = (await pages(page)).length;
  await page.evaluate(async () => (await import('/js/app.js')).refreshView());
  await page.waitForTimeout(600);
  const re = (await pages(page)).slice(n1);
  check('ripple: none when the page is drawn again', re.length >= 1 && re.every((p) => p.cards.every((c) => !c.anims.some((a) => isRipple(a)))), JSON.stringify(re.map((p) => p.cards.slice(0, 2))));
  // Row scrolling: a single press glides, a held key jumps.
  await page.evaluate(() => document.querySelector('main .row .row-scroller a.card').focus());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__scrolls = []));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  const single = await page.evaluate(() => window.__scrolls.slice());
  check('row: a single press scrolls smoothly', single.length === 1 && single[0] === 'smooth', JSON.stringify(single));
  await page.evaluate(() => (window.__scrolls = []));
  await page.keyboard.down('ArrowRight');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('ArrowRight'); // repeat: true
    await page.waitForTimeout(40);
  }
  const heldInfo = await page.evaluate(() => {
    const s = document.activeElement.closest('.row-scroller');
    return { scrolls: window.__scrolls.slice(), held: document.documentElement.classList.contains('nav-held'), css: s && getComputedStyle(s).scrollBehavior };
  });
  await page.keyboard.up('ArrowRight');
  const repeats = heldInfo.scrolls.slice(1);
  check('row: a held key scrolls at once (instant)', repeats.length >= 3 && repeats.every((b) => b === 'instant' || (b === 'auto' && heldInfo.css === 'auto')) && heldInfo.held, JSON.stringify(heldInfo));
  check('full: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- The focused card never ripples: its focus ring shows on the same frame as the focus ----
{
  const { browser, page, errors } = await setup();
  await go(page, '#/');
  await page.keyboard.press('ArrowDown'); // keyboard mode
  await page.waitForTimeout(300);
  await page.evaluate(() => (location.hash = '#/library/1'));
  // The remote lands on a card while the ripple is still running (focused as soon as the cards are there).
  const seen = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const tryFocus = () => {
          const cards = [...document.querySelectorAll('main .view a.card')].filter((c) => c.getAnimations().some((a) => !a.animationName && !a.transitionProperty));
          if (cards.length < 3) return requestAnimationFrame(tryFocus);
          const card = cards[2]; // one still waiting for its turn (40 ms delay)
          card.focus({ preventScroll: true });
          requestAnimationFrame(() =>
            resolve({ opacity: getComputedStyle(card).opacity, ripples: card.getAnimations().filter((a) => !a.animationName && !a.transitionProperty && a.playState === 'running').length, focused: document.activeElement === card }),
          );
        };
        tryFocus();
      }),
  );
  check('ripple: the card the remote lands on shows at once (no fade on the focused card)', seen.focused && seen.ripples === 0 && seen.opacity === '1', JSON.stringify(seen));
  check('focused ripple: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- Reduce: fades kept, ripple without stagger or rise; none: nothing moves ----
for (const tier of ['reduce', 'none']) {
  const { browser, page, errors } = await setup({ reducedMotion: tier === 'reduce' ? 'reduce' : 'no-preference' });
  // none: an old TV browser (no `translate`), as motion.js tells them apart.
  if (tier === 'none') await page.addInitScript(() => { const s = CSS.supports.bind(CSS); CSS.supports = (a, b) => (a === 'translate' ? false : s(a, b)); });
  await go(page, '#/');
  const level = await page.evaluate(() => document.documentElement.dataset.motion);
  check(`${tier}: tier is ${tier}`, level === tier, level);
  const p = await lastPage(page);
  const on = (p?.cards || []).filter((c) => c.onScreen);
  const rip = on.flatMap((c) => c.anims.filter((a) => isRipple(a)));
  if (tier === 'reduce') {
    check('reduce: the first screenful fades in, together (no stagger)', on.length >= 4 && rip.length === on.length && rip.every((a) => a.delay === 0), JSON.stringify(rip.slice(0, 4)));
    check('reduce: no rise', rip.every((a) => !a.props.includes('transform') && !a.props.includes('translate')), JSON.stringify(rip[0]));
  } else {
    check('none: no ripple at all', on.length >= 4 && on.every((c) => c.anims.length === 0), JSON.stringify(on.slice(0, 2)));
  }
  await page.waitForFunction(() => document.querySelector('main .art.loaded img'), null, { timeout: 5000 }).catch(() => {});
  const dur = await page.evaluate(() => {
    const img = document.querySelector('main .art img');
    return img && getComputedStyle(img).transitionDuration;
  });
  if (tier === 'reduce') check('reduce: the picture still fades in (180 ms)', dur === '0.18s', dur);
  else check('none: the picture shows at once', parseFloat(dur) <= 0.0001, dur);
  check(`${tier}: no page errors`, errors.length === 0, errors.join(' | '));
  await browser.close();
}

process.exit(failed() ? 1 : 0);
