// Card motion v2 (v0.28), opening a title: the card's art travels into the title page's backdrop (or poster) and the
// card's title into the page title — names set just before the change and cleared once it has finished; the page's
// first-screen blocks (meta, plot, buttons, first row) rise in 20 ms apart, ≤ 200 ms; Back goes the other way, into
// the same card, which gets the focus with its row scrolled as before. Reduce: a crossfade only (nothing named, the
// blocks fade without rising). No view transitions: the instant swap. A card off screen (or gone) on Back: no
// morph, the focus still comes back. `node devtools/card-open.mjs`
import { open, go, check, failed } from './lib.mjs';

const ROW = '.row[data-row="recent-1"] .row-scroller';

/** Record each view transition: the names in the old state, the names and groups once it is running. */
function recorder() {
  window.__vts = [];
  const names = () =>
    [...document.querySelectorAll('*')]
      .map((el) => [getComputedStyle(el).viewTransitionName, el])
      .filter(([n]) => n && n !== 'none')
      .map(([n, el]) => ({ name: n, cls: String(el.className?.baseVal ?? el.className ?? '') }));
  const orig = Document.prototype.startViewTransition;
  if (!orig) return;
  Document.prototype.startViewTransition = function (cb) {
    const rec = { html: document.documentElement.className, old: names(), now: null, groups: null, rise: null, after: null };
    window.__vts.push(rec);
    const t = orig.call(this, cb);
    t.ready.then(() => {
      rec.now = names();
      rec.htmlNow = document.documentElement.className;
      // The backdrop, if it is what the art travels into: is its picture really there (loaded and shown)?
      const bd = document.querySelector('.backdrop');
      rec.backdrop = bd && {
        named: getComputedStyle(bd).viewTransitionName === 'poster',
        loaded: [...bd.querySelectorAll('img')].some((i) => i.classList.contains('is-on') && i.complete && i.naturalWidth > 0 && /backdrop-/.test(i.src)),
      };
      rec.groups = document.getAnimations().map((a) => a.effect?.pseudoElement).filter(Boolean);
      rec.rise = [...document.querySelectorAll('[data-rise]')].map((el) =>
        el.getAnimations().map((a) => ({ name: a.animationName, delay: a.effect.getTiming().delay, dur: a.effect.getTiming().duration })),
      );
    }, () => {});
    t.finished.then(() => setTimeout(() => (rec.after = names()), 0), () => {});
    return t;
  };
}

// The dev media has no artwork: give every card a poster, and title pages a backdrop (opts.art 'backdrop') or only
// a poster ('poster'), drawn as small SVGs answered here.
const svg = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;
let dropId = null; // a title left out of Home's answer (the "card has gone" case)
async function withArt(context, kind, slowBackdrop = 0) {
  await context.route(/\/fake-art\/(poster|backdrop)-(\d+)\.svg/, async (route) => {
    const [, type, id] = /(poster|backdrop)-(\d+)/.exec(route.request().url());
    if (type === 'backdrop' && slowBackdrop) await new Promise((r) => setTimeout(r, slowBackdrop)); // a slow backdrop
    route.fulfill({ contentType: 'image/svg+xml', body: type === 'poster' ? svg(300, 450, id * 40) : svg(1920, 1080, id * 40) });
  });
  const dress = (it) => it && typeof it === 'object' && it.id && ['movie', 'show', 'episode'].includes(it.kind) && (it.poster = `/fake-art/poster-${it.id}.svg`);
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
    if (dropId) for (const r of body.rows || []) if (Array.isArray(r.items)) r.items = r.items.filter((it) => it.id !== dropId);
    route.fulfill({ response: res, json: body });
  });
  await context.route(/\/api\/items\/\d+(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.item) {
      dress(body.item);
      if (kind === 'backdrop') body.item.backdrop = `/fake-art/backdrop-${body.item.id}.svg`;
    }
    route.fulfill({ response: res, json: body });
  });
}

async function setup(opts = {}) {
  const o = await open(opts);
  await withArt(o.context, opts.art || 'backdrop', opts.slowBackdrop || 0);
  if (opts.noVT) await o.context.addInitScript(() => { delete Document.prototype.startViewTransition; });
  await o.context.addInitScript(recorder);
  await go(o.page, '#/');
  await o.page.keyboard.press('ArrowDown'); // keyboard mode
  await o.page.waitForTimeout(250);
  return o;
}

/** Focus card `i` of the row, scroll the row to `left`, press Enter; wait for the title page and its change. */
async function openCard(page, i, left) {
  const info = await page.evaluate(({ ROW, i, left }) => {
    const row = document.querySelector(ROW);
    const card = row.querySelectorAll(':scope > a.card')[i];
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (left != null) row.scrollLeft = left;
    return { href: card.getAttribute('href'), left: row.scrollLeft };
  }, { ROW, i, left });
  await page.waitForTimeout(400);
  // Home's spotlight can take the focus back while it loads: the card must hold it when OK is pressed.
  for (let n = 0; n < 5 && !(await page.evaluate(({ ROW, i }) => document.activeElement === document.querySelectorAll(`${ROW} > a.card`)[i], { ROW, i })); n++) {
    await page.evaluate(({ ROW, i }) => document.querySelectorAll(`${ROW} > a.card`)[i].focus({ preventScroll: true }), { ROW, i });
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('.detail-header', { timeout: 8000 }).catch(async (e) => {
    const s = await page.evaluate(() => ({ hash: location.hash, active: document.activeElement?.outerHTML.slice(0, 200), main: document.querySelector('main')?.textContent.slice(0, 200), cls: document.documentElement.className }));
    throw new Error(`no title page: ${JSON.stringify({ info, s })}`);
  });
  await settled(page);
  return info;
}

async function back(page) {
  await page.keyboard.press('Backspace');
  await page.waitForSelector('.home-rows .row', { timeout: 8000 });
  await settled(page);
}

const where = (page, href) =>
  page.evaluate(({ ROW, href }) => {
    const a = document.activeElement;
    const art = a?.querySelector?.('.card-art')?.getBoundingClientRect();
    return {
      href: a?.getAttribute?.('href'),
      inRow: Boolean(a?.closest?.(ROW)),
      left: document.querySelector(ROW)?.scrollLeft,
      onScreen: Boolean(art && art.right > 0 && art.left < innerWidth && art.bottom > 0 && art.top < innerHeight),
      named: [...document.querySelectorAll('*')].filter((el) => { const n = getComputedStyle(el).viewTransitionName; return n && n !== 'none' && n !== 'root'; }).length,
      vtClass: /\bvt\b|vt-/.test(document.documentElement.className),
      href0: href,
    };
  }, { ROW, href });

/** Until no screen change runs (headless software rendering makes them slower than on a real screen). */
const settled = (page) => page.waitForFunction(() => !/\bvt\b|vt-hold/.test(document.documentElement.className), null, { timeout: 5000 }).then(() => page.waitForTimeout(150));
const vts = (page) => page.evaluate(() => window.__vts || []);
const has = (list, name, cls) => (list || []).some((n) => n.name === name && (!cls || cls.test(n.cls)));

// ---- Full motion, Orbit, desktop ----
{
  const { browser, page, errors } = await setup();
  const at = await openCard(page, 7, 9999);
  const [o] = (await vts(page)).slice(-1);
  check('full: opening runs a view transition', Boolean(o), o?.html);
  check('full: the card art is named in the old page', has(o?.old, 'poster', /card-art/), JSON.stringify(o?.old));
  // Orbit's poster cards show no title under the art: no title to travel (only pairs are named).
  check('full: no lone title name (Orbit poster cards have no visible title)', !has(o?.old, 'title') && !has(o?.now, 'title'), JSON.stringify(o?.old));
  check('full: the page backdrop (or poster) is named in the new page', has(o?.now, 'poster', /backdrop|art/), JSON.stringify(o?.now));
  check('full: into the backdrop, the page stays above it (vt-to-backdrop)', /vt-to-backdrop/.test(o?.htmlNow) || !has(o?.now, 'poster', /backdrop/), o?.htmlNow);
  check('full: the art travels (group animation)', (o?.groups || []).includes('::view-transition-group(poster)'), (o?.groups || []).join(' '));
  const rise = (o?.rise || []).map((a) => a[0]).filter(Boolean);
  const ends = rise.map((r) => r.delay + r.dur);
  const starts = rise.map((r) => r.delay);
  check('full: ≥ 3 first-screen blocks rise in', rise.length >= 3 && rise.every((r) => r.name === 'open-rise'), JSON.stringify(rise));
  check('full: 20 ms apart, the sequence ≤ 200 ms', rise.length >= 3 && Math.max(...ends) - Math.min(...starts) <= 200 && starts.slice(1).every((s, i) => Math.abs(s - starts[i] - 20) < 0.5), JSON.stringify(rise));
  check('full: names cleared after the change', o?.after && o.after.filter((n) => n.name === 'poster' || n.name === 'title').length === 0, JSON.stringify(o?.after));
  check('full: rest state has no rise class left', await page.evaluate(() => !document.querySelector('.is-opening')));
  check('full: the page does not fade in a second time once the change ends', await page.evaluate(() => Number(getComputedStyle(document.querySelector('main .view')).opacity) === 1 && document.querySelector('main .view').getAnimations().length === 0));
  await back(page);
  const w = await where(page, at.href);
  const [b] = (await vts(page)).slice(-1);
  check('full: Back runs the reverse', b && b !== o && /vt-back/.test(b.html), b?.html);
  check('full: Back — the backdrop/poster named in the old page', has(b?.old, 'poster', /backdrop|art/), JSON.stringify(b?.old));
  check('full: Back — the same card named in the new page', has(b?.now, 'poster', /card-art/), JSON.stringify(b?.now));
  check('full: Back focuses the same card', w.href === at.href && w.inRow, JSON.stringify(w));
  check('full: Back restores the row scrollLeft', Math.abs(w.left - at.left) <= 1 && at.left > 0, `${w.left} vs ${at.left}`);
  check('full: nothing named at rest after Back', w.named === 0 && !w.vtClass, JSON.stringify(w));
  // Held arrow: no screen change from it.
  await page.evaluate(() => document.documentElement.classList.add('nav-held'));
  const n0 = (await vts(page)).length;
  await openCard(page, 1);
  check('held key: no view transition', (await vts(page)).length === n0);
  await page.evaluate(() => document.documentElement.classList.remove('nav-held'));
  check('full: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- Arctic: poster pages (the older theme's detail poster) ----
{
  const { browser, page, errors } = await setup({ theme: 'arctic', art: 'poster' });
  const at = await openCard(page, 2);
  const [o] = (await vts(page)).slice(-1);
  check('arctic: art named old → backdrop/poster new', has(o?.old, 'poster', /card-art/) && has(o?.now, 'poster', /backdrop|art/), JSON.stringify(o?.now));
  await back(page);
  const w = await where(page, at.href);
  check('arctic: Back focuses the same card', w.href === at.href, JSON.stringify(w));
  check('arctic: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- The title travels too, where the card shows one (a library grid) ----
{
  const { browser, page, errors } = await setup();
  await go(page, '#/library/1');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  const href = await page.evaluate(() => { const c = document.querySelector('main a.card'); c.focus(); return c.getAttribute('href'); });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.detail-header', { timeout: 8000 });
  await settled(page);
  const [o] = (await vts(page)).slice(-1);
  check('grid: the card title travels into the page title', has(o?.old, 'title', /card-title/) && has(o?.now, 'title', /detail-title|detail-logo/) && (o?.groups || []).includes('::view-transition-group(title)'), JSON.stringify({ old: o?.old, now: o?.now }));
  await page.keyboard.press('Backspace');
  await page.waitForSelector('main a.card', { timeout: 8000 });
  await settled(page);
  const [b] = (await vts(page)).slice(-1);
  check('grid: Back — the page title travels into the card title', has(b?.old, 'title', /detail-title|detail-logo/) && has(b?.now, 'title', /card-title/), JSON.stringify({ old: b?.old, now: b?.now }));
  check('grid: Back focuses the same card', await page.evaluate(() => document.activeElement?.getAttribute('href')) === href);
  check('grid: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- A backdrop that is slow to arrive (1 s): the art never travels into an empty backdrop ----
{
  const { browser, page, errors } = await setup({ slowBackdrop: 1000 });
  await go(page, '#/library/1'); // a grid: the backdrop showing is the card's poster, not the page's backdrop
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('main a.card').focus());
  await page.waitForTimeout(300);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.detail-header', { timeout: 8000 });
  const took = Date.now() - t0;
  await settled(page);
  const [o] = (await vts(page)).slice(-1);
  check('slow backdrop: a page change still runs', Boolean(o), o?.html);
  check('slow backdrop: the art is not paired with a backdrop that has not loaded', o && (!o.backdrop?.named || o.backdrop.loaded), JSON.stringify(o?.backdrop));
  check('slow backdrop: the page does not wait for the picture (in well under 1 s)', took < 900, `${took} ms`);
  check('slow backdrop: names cleared after the change', o?.after && o.after.filter((n) => n.name === 'poster' || n.name === 'title').length === 0, JSON.stringify(o?.after));
  check('slow backdrop: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- Reduce: crossfade only ----
{
  const { browser, page, errors } = await setup({ reducedMotion: 'reduce' });
  const at = await openCard(page, 7, 9999);
  const [o] = (await vts(page)).slice(-1);
  check('reduce: a crossfade runs', Boolean(o) && /vt-section/.test(o.html), o?.html);
  check('reduce: nothing named (no morph)', o && !has(o.old, 'poster') && !has(o.old, 'title') && !has(o.now, 'poster') && !has(o.now, 'title'), JSON.stringify(o?.now));
  const rise = (o?.rise || []).flat();
  check('reduce: the blocks do not stagger (the crossfade is all)', (o?.rise || []).length >= 3 && rise.length === 0, JSON.stringify(o?.rise));
  await back(page);
  const w = await where(page, at.href);
  check('reduce: Back focuses the same card, row scroll restored', w.href === at.href && Math.abs(w.left - at.left) <= 1, JSON.stringify(w));
  check('reduce: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- No view transitions (old browsers / TVs): the instant swap ----
{
  const { browser, page, errors } = await setup({ noVT: true });
  check('no VT: stubbed away', await page.evaluate(() => typeof document.startViewTransition !== 'function'));
  const at = await openCard(page, 7, 9999);
  const s = await page.evaluate(() => ({ cls: document.documentElement.className, anim: [...document.querySelectorAll('[data-rise]')].flatMap((el) => el.getAnimations()).length, hold: Boolean(document.querySelector('[inert]')) }));
  check('no VT: title page in, no transition classes, nothing animating', !/\bvt\b|vt-/.test(s.cls) && s.anim === 0 && !s.hold, JSON.stringify(s));
  await back(page);
  const w = await where(page, at.href);
  check('no VT: Back focuses the same card, row scroll restored', w.href === at.href && Math.abs(w.left - at.left) <= 1 && at.left > 0, JSON.stringify(w));
  check('no VT: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- A card off screen, or gone, on Back: no morph, focus still restored (phone) ----
{
  const { browser, page, errors } = await setup({ width: 390, height: 844, isMobile: true });
  const at = await openCard(page, 7, 9999);
  // The row comes back scrolled to the start (as if re-rendered): card 7 is off screen.
  await page.evaluate(async () => { const m = await import('/js/transitions.js'); m.returnPoint('#/').left = 0; });
  const n0 = (await vts(page)).length;
  await back(page);
  const w = await where(page, at.href);
  const [b] = (await vts(page)).slice(n0);
  check('off screen: Back still a page change, no morph into the card', b && !has(b.now, 'poster'), JSON.stringify(b?.now));
  check('off screen: a plain fade (vt-section), not the page shrinking away', /vt-section/.test(b?.htmlNow) && !/vt-back/.test(b?.htmlNow), b?.htmlNow);
  check('off screen: focus on the same card, brought into view', w.href === at.href && w.onScreen, JSON.stringify(w));
  // The card no longer exists.
  const gone = await openCard(page, 1);
  dropId = Number(gone.href.split('/').pop()); // Home comes back without it (watched, removed…)
  const n1 = (await vts(page)).length;
  await back(page);
  const [c] = (await vts(page)).slice(n1);
  const g = await where(page);
  check('gone: no morph, no error, nothing left named', c && !has(c.now, 'poster') && g.named === 0 && errors.length === 0, JSON.stringify({ now: c?.now, g }));
  check('gone: a plain fade (vt-section)', /vt-section/.test(c?.htmlNow) && !/vt-back/.test(c?.htmlNow), c?.htmlNow);
  // The app's usual landing: the first thing on Home for the remote (focusFirst), inside the page, not the body.
  const lands = await page.evaluate(() => { const a = document.activeElement; return { inMain: Boolean(a && a !== document.body && a.closest('main') && a !== a.closest('main')), html: a?.outerHTML.slice(0, 120), first: a === document.querySelector('main').querySelector('a[href], button:not([disabled]), [tabindex="0"]') }; });
  check('gone: focus lands on the first control of the page', lands.inMain && lands.first, JSON.stringify(lands));
  check('off screen / gone: no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

process.exit(failed() ? 1 : 0);
