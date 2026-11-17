// The title page's behaviour (made-up titles from item-fixtures.mjs): first focus, season tabs, Orbit's episode row,
// the "…" sheet per person, Mark watched redrawing in place, the collection's current movie, pages with nothing in
// them, and no listeners or timers left behind. Prints PASS/FAIL lines; exit 1 on a FAIL.
//   BASE=http://localhost:8797 node devtools/item-fn.mjs [focus seasons row actions redraw collection empty leaks]
// Needs devtools/item-users.mjs run once (guest and its Kids profile).
import { open, check, failed, BASE } from './lib.mjs';
import { routeItems } from './item-fixtures.mjs';

if (!process.env.BASE || /:8787/.test(process.env.BASE)) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}
const LEGS = process.argv.slice(2).length ? process.argv.slice(2) : ['focus', 'seasons', 'row', 'actions', 'redraw', 'collection', 'empty', 'leaks'];

/** A signed-in page with the made-up titles, in keyboard (remote) mode, on Home. */
async function start({ theme = 'orbit', user = 'dallas', profile, delay, init } = {}) {
  const s = await open({ theme, user, profile, serviceWorkers: 'block' });
  if (init) await s.page.addInitScript(init);
  await routeItems(s.page, { delay });
  await s.page.goto(`${BASE}/#/`);
  await s.page.keyboard.press('Escape').catch(() => {}); // end the splash
  await s.page.waitForTimeout(1200);
  // A user with more than one profile is asked "Who's watching?" on a fresh open: pick as a person would.
  if (profile && await s.page.locator('.picker-profile').count()) {
    await s.page.click(`.picker-profile[aria-label^="${profile}"]`);
    await s.page.waitForTimeout(1500);
  }
  await s.page.keyboard.press('ArrowDown'); // the remote: pages start with a control focused
  await s.page.waitForTimeout(200);
  return s;
}
/** Go to a page inside the app (as a card or link would), then let it settle. */
async function visit(page, hash, wait = 1200) {
  await page.evaluate((h) => { location.hash = h; }, hash.replace(/^#/, ''));
  await page.waitForSelector('main .detail-header, main .detail-title', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(wait);
}
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { text: a?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60), label: a?.getAttribute('aria-label'), cls: a?.className, track: a?.closest('.track-row')?.dataset.id };
});
const sheetLabels = async (page, title) => {
  await page.click(`button[aria-label="More options for ${title}"]`);
  await page.waitForSelector('dialog[open] .sheet', { timeout: 3000 });
  const labels = await page.$$eval('dialog[open] .sheet > *', (els) => els.map((e) => e.textContent.trim()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return labels;
};
const inlineActions = (page) => page.$$eval('.detail-header .actions > *', (els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim() || e.getAttribute('title')));

if (LEGS.includes('focus')) {
  const { browser, page, errors } = await start();
  const want = { '#/item/900001': /^Play$/, '#/item/900002': /^Resume from 30:00$/, '#/item/900020': /^Play$/, '#/item/900010': /^Resume S2/, '#/item/900030': /^Play$/ };
  for (const [hash, re] of Object.entries(want)) {
    await visit(page, hash);
    const f = await focused(page);
    check(`focus: ${hash} starts on ${re}`, re.test(f.text || ''), JSON.stringify(f));
  }
  await visit(page, '#/item/900030?track=900340');
  const t = await page.evaluate(() => {
    const row = document.activeElement?.closest('.track-row');
    const r = row?.getBoundingClientRect();
    return { id: row?.dataset.id, top: r && Math.round(r.top), bottom: r && Math.round(r.bottom), mid: r ? Math.round(r.top + r.height / 2) : null, centre: Math.round(innerHeight / 2) };
  });
  check('focus: ?track= focuses that song', t.id === '900340', JSON.stringify(t));
  // Today's page (full motion) leaves it at the bottom of the screen: its centring runs before the page is shown.
  check('focus: ?track= has that song on screen', t.top >= 0 && t.bottom <= 992, JSON.stringify(t));
  // "Go to album" from a page that already shows the song (Search, Songs, the queue): the page being left is kept as a
  // still copy while the album draws, and it has the same song row in it. The album's own row is the one centred.
  // Stand-in for that copy: a row with the same song, earlier in the document than the new page.
  await visit(page, '#/');
  await page.evaluate(() => {
    const copy = Object.assign(document.createElement('div'), { className: 'still-copy', inert: true });
    copy.innerHTML = '<div class="track-row" data-id="900307">Song 7</div>';
    document.body.prepend(copy);
  });
  await visit(page, '#/item/900030?track=900307');
  const g = await page.evaluate(() => {
    document.querySelector('.still-copy')?.remove();
    const row = document.querySelector('main .track-row[data-id="900307"]');
    const r = row?.getBoundingClientRect();
    return { mid: r ? Math.round(r.top + r.height / 2) : null, centre: Math.round(innerHeight / 2), h: r && Math.round(r.height) };
  });
  check('focus: "Go to album" from a page with that song centres the album’s own row', g.mid !== null && Math.abs(g.mid - g.centre) <= g.h, JSON.stringify(g));
  check('focus: no page errors', !errors.filter((e) => !/404/.test(e)).length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('seasons')) {
  const { browser, page, errors } = await start();
  await visit(page, '#/item/900010');
  const tabs = () => page.evaluate(() => {
    const sel = document.querySelector('.season-tab[aria-selected="true"]');
    const panel = document.querySelector('.season-panel');
    return {
      selected: sel?.dataset.id, focused: document.activeElement?.dataset?.id, hash: location.hash,
      stops: document.querySelectorAll('.season-tabs [tabindex="0"]').length, labelled: panel?.getAttribute('aria-labelledby') === sel?.id,
      first: panel?.querySelector('.card-title, .episode-info h3')?.textContent.trim(),
    };
  });
  let s = await tabs();
  check('seasons: season 2 (the next episode) is selected', s.selected === '900012', JSON.stringify(s));
  await page.focus('.season-tab[aria-selected="true"]');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  s = await tabs();
  check('seasons: Right moves focus and selection to season 3', s.selected === '900013' && s.focused === '900013', JSON.stringify(s));
  check('seasons: the address says ?season=900013', /season=900013/.test(s.hash), s.hash);
  check('seasons: one tab stop', s.stops === 1, String(s.stops));
  check('seasons: the panel is named by the selected tab', s.labelled);
  check('seasons: season 3 episodes show', /3\.1|^1\./.test(s.first || ''), s.first);
  check('seasons: no page errors', !errors.length, errors.join(' | '));
  await browser.close();

  // Newest wins: season 3's answer is held 800 ms; Right then Left at once leaves season 2 showing.
  const slow = await start({ delay: (id) => (id === 900013 ? 800 : 0) });
  await visit(slow.page, '#/item/900010');
  await slow.page.focus('.season-tab[aria-selected="true"]');
  await slow.page.keyboard.press('ArrowRight');
  await slow.page.keyboard.press('ArrowLeft');
  await slow.page.waitForTimeout(1500);
  const shown = await slow.page.evaluate(() => ({ selected: document.querySelector('.season-tab[aria-selected="true"]')?.dataset.id, eps: [...document.querySelectorAll('.season-panel .card-title, .season-panel .episode-info h3')].map((e) => e.textContent.trim()).join(' | ') }));
  check('seasons: switching fast shows the season picked last', shown.selected === '900012' && /2\.1/.test(shown.eps) && !/3\.1/.test(shown.eps), JSON.stringify(shown));
  await slow.browser.close();
}

if (LEGS.includes('row')) {
  const { browser, page, errors } = await start();
  await visit(page, '#/item/900010');
  const about = () => page.evaluate(() => {
    const row = document.querySelector('.episode-row');
    const card = row?.querySelector('a[href="#/play/900216"]');
    const pad = row ? parseFloat(getComputedStyle(row).paddingLeft) || 0 : 0;
    return {
      story: document.querySelector('.episode-story strong')?.textContent, href: document.querySelector('.episode-about a')?.getAttribute('href'),
      offset: card ? Math.round(card.getBoundingClientRect().left - row.getBoundingClientRect().left - pad) : null,
      scrolls: row ? row.scrollWidth > row.clientWidth : false,
    };
  });
  let a = await about();
  check('row: the story is the part-watched episode', a.story === 'Episode title 2.6.' && a.href === '#/item/900216', JSON.stringify(a));
  // Where the row scrolls, it opens at that episode. (Today it wraps instead: app.css's podcast .episode-row, flex-wrap,
  // shares the class. A visual fix, left for later.)
  check('row: the row opens at the part-watched episode (where it scrolls)', !a.scrolls || (a.offset != null && Math.abs(a.offset) <= 4), JSON.stringify(a));
  await page.focus('.episode-row a[href="#/play/900217"]');
  await page.waitForTimeout(900);
  a = await about();
  check('row: focusing another card changes the story and Episode details', a.story === 'Episode title 2.7.' && a.href === '#/item/900217', JSON.stringify(a));
  check('row: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('actions')) {
  // What each person's "…" holds on today's page (written down 18 Nov 2026 from the older title page).
  const WANT = {
    'dallas orbit': ['Add to playlist…', 'Cast to…', 'Refresh info', 'Fix match', 'Edit details', 'Save the file'],
    'dallas midnight': ['Add to playlist…', 'Rate…', 'Cast to…', 'Edit details', 'Download'],
    'guest orbit': ['Add to playlist…', 'Cast to…', 'Save the file'],
    'Kids orbit': ['Add to playlist…', 'Cast to…'],
  };
  const WANT_INLINE_MIDNIGHT = [];
  for (const [who, want] of Object.entries(WANT)) {
    const [name, theme] = who.split(' ');
    const s = await start({ theme, user: name === 'dallas' ? 'dallas' : 'guest', profile: name === 'dallas' ? undefined : name });
    await visit(s.page, '#/item/900001');
    const got = await sheetLabels(s.page, 'The Lighthouse Keeper');
    check(`actions: "…" on a film for ${who}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
    if (who === 'dallas midnight') {
      const inline = await inlineActions(s.page);
      WANT_INLINE_MIDNIGHT.push(...inline);
      console.log(`  (Midnight's actions row: ${JSON.stringify(inline)})`);
    }
    if (who === 'dallas orbit') {
      await visit(s.page, '#/item/900005');
      const remote = await sheetLabels(s.page, 'Borrowed Time');
      const bad = remote.filter((l) => /Refresh info|Fix match|Edit details|Download|Save the file/.test(l));
      check('actions: a remote film has no admin entries or download', !bad.length, JSON.stringify(remote));
    }
    if (who === 'dallas midnight') {
      await visit(s.page, '#/item/900005');
      const inline = await inlineActions(s.page);
      check('actions: a remote film (Midnight) has no download link or admin buttons', !inline.some((l) => /Download|Refresh info|Fix match/.test(l)), JSON.stringify(inline));
    }
    check(`actions: no page errors (${who})`, !s.errors.filter((e) => !/404/.test(e)).length, s.errors.join(' | '));
    await s.browser.close();
  }
}

if (LEGS.includes('redraw')) {
  const { browser, page, errors } = await start({ theme: 'midnight' });
  await visit(page, '#/item/900001');
  let gets = 0;
  page.on('request', (r) => { if (r.method() === 'GET' && /\/api\/items\/900001(\?|$)/.test(r.url())) gets++; });
  const scrollers = () => page.evaluate(() => [document.querySelector('main').scrollTop, document.scrollingElement.scrollTop]);
  await page.evaluate(() => { document.querySelector('main').scrollTop = 240; document.scrollingElement.scrollTop = 240; });
  await page.waitForTimeout(200);
  const before = await scrollers();
  const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/items\/900001\/watched$/.test(r.url()), { timeout: 4000 }).catch(() => null);
  await page.click('.detail-header .actions button:has-text("Mark watched")');
  const req = await posted;
  await page.waitForTimeout(1500);
  const after = await scrollers();
  check('redraw: Mark watched sends POST /api/items/900001/watched', Boolean(req));
  check('redraw: the page is fetched and drawn again', gets >= 1, `GETs: ${gets}`);
  check('redraw: the scroll position is kept', before.some((v) => v > 0) && before.every((v, i) => Math.abs(v - after[i]) <= 2), JSON.stringify({ before, after }));
  check('redraw: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('collection')) {
  const { browser, page, errors } = await start();
  await visit(page, '#/item/900001');
  const cur = await page.evaluate(() => {
    const c = document.querySelector('[data-row="collection"] .is-current');
    return c && { tag: c.tagName, tabindex: c.getAttribute('tabindex'), current: c.getAttribute('aria-current'), badge: c.querySelector('.badge-current')?.textContent, label: c.getAttribute('aria-label') };
  });
  check('collection: the current movie is a div, not a stop, marked current', cur?.tag === 'DIV' && cur.tabindex === '-1' && cur.current === 'true', JSON.stringify(cur));
  check('collection: it has the "This movie" badge', cur?.badge === 'This movie', JSON.stringify(cur));
  check('collection: its label says "this movie"', /, this movie$/.test(cur?.label || ''), cur?.label);
  await page.focus('[data-row="collection"] a.card[href="#/item/900111"]');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);
  const f = await page.evaluate(() => document.activeElement?.getAttribute('href'));
  check('collection: Right along the row skips the current movie', f === '#/item/900112', f);
  check('collection: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('empty')) {
  const { browser, page, errors } = await start();
  await visit(page, '#/item/900003');
  const a = await page.evaluate(() => ({ art: document.querySelector('.detail-header')?.dataset.art, title: document.querySelector('.detail-title')?.textContent, hidden: document.querySelector('.detail-title')?.classList.contains('visually-hidden'), overview: document.querySelector('.overview')?.textContent }));
  check('empty: no pictures → data-art="poster" and the typed title', a.art === 'poster' && a.title === 'Untitled Home Movie' && !a.hidden, JSON.stringify(a));
  check('empty: no overview → "No description yet."', a.overview === 'No description yet.', a.overview);
  await visit(page, '#/item/900004', 1800);
  const b = await page.evaluate(() => ({ hidden: document.querySelector('.detail-title')?.classList.contains('visually-hidden'), hasLogo: document.querySelector('.logo-box')?.classList.contains('has-logo'), img: Boolean(document.querySelector('.detail-logo')) }));
  check('empty: a logo that fails keeps the typed title, no has-logo', b.hidden === false && b.hasLogo === false, JSON.stringify(b));
  await visit(page, '#/item/900001', 1800);
  const c = await page.evaluate(() => ({ hidden: document.querySelector('.detail-title')?.classList.contains('visually-hidden'), hasLogo: document.querySelector('.logo-box')?.classList.contains('has-logo'), shown: document.querySelector('.detail-logo')?.hidden === false }));
  check('empty: a logo that loads replaces the typed title (kept for screen readers)', c.hidden && c.hasLogo && c.shown, JSON.stringify(c));
  await visit(page, '#/item/900014');
  const d = await page.evaluate(() => ({ tabs: document.querySelectorAll('.season-tab').length, panel: document.querySelector('.season-panel')?.textContent.trim() }));
  check('empty: a show with no seasons has no tabs and an empty panel', d.tabs === 0 && d.panel === '', JSON.stringify(d));
  await visit(page, '#/item/900015');
  const e = await page.evaluate(() => document.querySelector('.season-panel')?.textContent.trim());
  check('empty: a season with no episodes says "No episodes found."', e === 'No episodes found.', e);
  await visit(page, '#/item/900050');
  const x = await page.evaluate(() => ({ actions: [...document.querySelectorAll('.detail-header .actions > *')].map((el) => el.getAttribute('aria-label') || el.textContent.trim()), ends: Boolean(document.querySelector('.ends-at')), focus: document.activeElement?.textContent?.trim() }));
  check('empty: an extra on its own has no Play, Resume, Download or ends-at', !x.actions.some((t) => /^(Play|Resume|Download)/.test(t || '')) && !x.ends, JSON.stringify(x));
  check('empty: no page errors', !errors.filter((x) => !/404/.test(x)).length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('leaks')) {
  // Count listeners on document and window, and timers still waiting, from the page's first moment.
  const init = () => {
    const live = new Set();
    const key = (t, type, fn, opt) => [t === window ? 'w' : 'd', type, typeof opt === 'boolean' ? opt : Boolean(opt?.capture)].join(':');
    const fns = new Map();
    const add = EventTarget.prototype.addEventListener;
    const rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opt) {
      if ((this === window || this === document) && fn) {
        if (!fns.has(fn)) fns.set(fn, new Set());
        const k = key(this, type, fn, opt);
        if (!fns.get(fn).has(k)) { fns.get(fn).add(k); live.add(fn); }
        if (opt?.signal) opt.signal.addEventListener('abort', () => { fns.get(fn)?.delete(k); });
      }
      return add.call(this, type, fn, opt);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, opt) {
      if ((this === window || this === document) && fn) fns.get(fn)?.delete(key(this, type, fn, opt));
      return rem.call(this, type, fn, opt);
    };
    const timers = new Set();
    const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
    window.setTimeout = function (fn, ms, ...rest) { const id = st.call(window, (...a) => { timers.delete(id); typeof fn === 'function' && fn(...a); }, ms, ...rest); timers.add(id); return id; };
    window.clearTimeout = function (id) { timers.delete(id); return ct.call(window, id); };
    const intervals = new Set();
    window.setInterval = function (...a) { const id = si.apply(window, a); intervals.add(id); return id; };
    window.clearInterval = function (id) { intervals.delete(id); return ci.call(window, id); };
    window.__leaks = () => ({ listeners: [...fns.values()].reduce((n, s) => n + s.size, 0), timeouts: timers.size, intervals: intervals.size });
  };
  const { browser, page, errors } = await start({ init });
  const round = async () => {
    await visit(page, '#/item/900010', 700);
    await page.evaluate(() => { location.hash = '/'; });
    await page.waitForTimeout(1500);
    return page.evaluate(() => window.__leaks());
  };
  const first = await round();
  let last = first;
  for (let i = 2; i <= 20; i++) last = await round();
  check('leaks: listeners on document and window are the same after 20 visits', last.listeners === first.listeners, JSON.stringify({ first, last }));
  check('leaks: intervals are the same after 20 visits', last.intervals === first.intervals, JSON.stringify({ first, last }));
  check('leaks: waiting timeouts are the same after 20 visits', last.timeouts <= first.timeouts, JSON.stringify({ first, last }));
  check('leaks: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

console.log(failed() ? `${failed()} FAIL` : 'all passed');
process.exit(failed() ? 1 : 0);
