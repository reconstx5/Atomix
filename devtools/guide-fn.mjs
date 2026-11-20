// The Live TV guide's behaviour (made-up channels and programmes from live-fixtures.mjs, clock fixed at T_LIVE): the one
// tab stop, ?channel=, arrows inside and off the edge of the window, a held arrow, Up/Down keeping the column, the
// tools, groups, more rows on scroll, the phone list, the programme sheet, an empty channel list, an unknown channel and
// nothing left running after the page is left. Prints PASS/FAIL lines; exit 1 on a FAIL.
//   BASE=http://localhost:8797 node devtools/guide-fn.mjs [tabstop deeplink focus arrows edge held updown tools group more phone phone-race sheet empty unknown leaks]
// SKIP=phone-race,... leaves legs out.
// On the guide before its Preact move (v0.29) five legs fail on bugs the move removes: deeplink (a channel past row 50
// isn't drawn or focused), group (a group change can draw its rows twice), phone-race (a slower answer for an earlier
// pick wins), empty (the phone list throws with no channels) and leaks (the more-rows observer is never disconnected).
import { open, check, failed, BASE } from './lib.mjs';
import { routeLive, liveRequests, T_LIVE, CHANNEL_IDS } from './live-fixtures.mjs';

if (!process.env.BASE || /:8787/.test(process.env.BASE)) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}
const ALL = ['tabstop', 'deeplink', 'focus', 'arrows', 'edge', 'held', 'updown', 'tools', 'group', 'more', 'group-race', 'more-race', 'quiet', 'phone', 'phone-race', 'sheet', 'empty', 'unknown', 'leaks'];
const SKIP = (process.env.SKIP || '').split(',');
const LEGS = (process.argv.slice(2).length ? process.argv.slice(2) : ALL).filter((l) => !SKIP.includes(l));
const STEP = 2 * 3600_000;
const DAY = 24 * 3600_000;

// Notes every element given data-focus-now (the router takes it off once it has focused it).
const noteFocusNow = () => {
  window.__focusNow = [];
  const note = (el) => window.__focusNow.push({ channel: el.closest('.guide-row')?.dataset.channel || null, start: Number(el.dataset.start) || null, end: Number(el.dataset.end) || null, now: el.classList.contains('is-now'), firstRow: el.closest('.guide-row') === document.querySelector('.guide-row'), tabStop: el.tabIndex === 0 });
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes' && m.target.hasAttribute('data-focus-now')) note(m.target);
      for (const n of m.addedNodes || []) if (n.nodeType === 1) [n, ...n.querySelectorAll('[data-focus-now]')].filter((e) => e.hasAttribute?.('data-focus-now')).forEach(note);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-focus-now'] });
};

/** A signed-in page on the guide with the made-up Live TV, in keyboard (remote) mode. */
async function start({ hash = '#/live/guide', phone = false, init, ...live } = {}) {
  const s = await open({ theme: 'midnight', serviceWorkers: 'block', ...(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true } : {}) });
  await s.page.clock.setFixedTime(T_LIVE);
  await s.page.addInitScript(noteFocusNow);
  if (init) await s.page.addInitScript(init);
  s.live = await routeLive(s.page, live);
  await s.page.goto(`${BASE}/#/`);
  await s.page.keyboard.press('Escape').catch(() => {}); // end the splash
  await s.page.waitForTimeout(800);
  await s.page.keyboard.press('ArrowDown'); // the remote: pages start with a control focused
  await go(s.page, hash);
  return s;
}
async function go(page, hash, wait = 1200) {
  await page.evaluate((h) => { location.hash = h; }, hash.replace(/^#/, ''));
  await page.waitForSelector('main .guide-grid, main .guide-list, main .empty-state', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(wait);
}
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const row = a?.closest('.guide-row');
  const cells = row ? [...row.querySelectorAll('button.guide-prog, button.guide-empty')] : [];
  return { channel: row?.dataset.channel || null, id: a?.dataset?.id || null, start: Number(a?.dataset?.start) || null, end: Number(a?.dataset?.end) || null, index: cells.indexOf(a), text: a?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40), rowIndex: row ? [...row.parentElement.children].indexOf(row) : -1 };
});
const from = (page) => page.$eval('.guide-grid', (g) => Number(g.dataset.from));
const rows = (page) => page.$$eval('.guide-row', (rs) => rs.map((r) => Number(r.dataset.channel)));
const tabStop = (page) => page.focus('.guide-grid [tabindex="0"]');
const key = async (page, k, wait = 350) => { await page.keyboard.press(k); await page.waitForTimeout(wait); };

if (LEGS.includes('tabstop')) {
  const { browser, page, errors } = await start();
  const t = await page.$$eval('.guide-grid [tabindex="0"]', (els) => els.map((e) => ({ now: e.matches('button.guide-prog.is-now'), firstRow: e.closest('.guide-row') === document.querySelector('.guide-row') })));
  check('tabstop: exactly one tab stop in the grid', t.length === 1, JSON.stringify(t));
  check('tabstop: it is the programme on now in the first row', t[0]?.now && t[0]?.firstRow, JSON.stringify(t));
  check('tabstop: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('deeplink')) {
  const want = CHANNEL_IDS[56];
  const { browser, page, errors } = await start({ hash: `#/live/guide?channel=${want}` });
  // What the guide decides: the programme it marks data-focus-now (the router focuses it: the focus leg checks that)
  // and the one tab stop.
  const marked = await page.evaluate(() => window.__focusNow);
  const stop = await page.$$eval('.guide-grid [tabindex="0"]', (els) => els.map((e) => ({ channel: e.closest('.guide-row')?.dataset.channel, start: Number(e.dataset.start), end: Number(e.dataset.end) })));
  const n = (await rows(page)).length;
  check(`deeplink: channel ${want}'s programme on now is marked data-focus-now`, marked.length === 1 && marked[0].channel === String(want) && marked[0].start <= T_LIVE && T_LIVE < marked[0].end, JSON.stringify(marked));
  check(`deeplink: the one tab stop is that programme`, stop.length === 1 && stop[0].channel === String(want) && stop[0].start <= T_LIVE && T_LIVE < stop[0].end, JSON.stringify(stop));
  // Two pages of 50 cover the 57th channel; there are 60, so all 60.
  check('deeplink: two pages of rows drawn (all 60)', n === 60, `rows ${n}`);
  check('deeplink: no page errors', !errors.length, errors.join(' | '));
  // A channel on the first page of rows.
  const early = CHANNEL_IDS[11];
  await page.evaluate(() => { window.__focusNow = []; });
  await go(page, `#/live/guide?channel=${early}`);
  const m2 = await page.evaluate(() => window.__focusNow);
  check(`deeplink: channel ${early} (first page) is marked and is the tab stop`, m2.length === 1 && m2[0].channel === String(early) && m2[0].tabStop && m2[0].start <= T_LIVE && T_LIVE < m2[0].end, JSON.stringify(m2));
  check('deeplink: first page: 50 rows', (await rows(page)).length === 50, `rows ${(await rows(page)).length}`);
  await browser.close();
}

// The router gives the marked programme the focus (document.activeElement), in view, after an in-app move and a full
// load, with and without the splash up, under full and reduced motion. Behind the splash the page is inert: the router
// keeps the mark and focuses it once the splash lets go (before that fix the moves made during the splash and the
// full load ended on "Channels" or the page itself).
if (LEGS.includes('focus')) {
  const want = CHANNEL_IDS[56];
  const early = CHANNEL_IDS[11];
  const splashUp = (page) => page.waitForSelector('#splash:not([hidden])', { timeout: 6000 }).then(() => true, () => false);
  const splashGone = (page) => page.waitForSelector('#splash', { state: 'hidden', timeout: 8000 }).catch(() => {});
  const onIt = async (page, name, channel) => {
    const f = await focused(page);
    const seen = await page.evaluate(() => {
      const r = document.activeElement.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    });
    check(`focus: ${name}: channel ${channel}'s programme on now has the focus`, f.channel === String(channel) && f.start <= T_LIVE && T_LIVE < f.end, JSON.stringify(f));
    check(`focus: ${name}: it is in view`, seen);
  };
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const tier = reducedMotion === 'reduce' ? 'reduce' : 'full';
    const session = async () => {
      const s = await open({ theme: 'midnight', serviceWorkers: 'block', reducedMotion });
      await s.page.clock.setFixedTime(T_LIVE);
      await routeLive(s.page, {});
      return s;
    };
    {
      // An in-app move made while the splash is still up (the page behind it is inert).
      const { browser, page, errors } = await session();
      await page.goto(`${BASE}/#/live`);
      const up = await splashUp(page);
      check(`focus (${tier}): the splash is up for the move`, up);
      await go(page, `#/live/guide?channel=${want}`, 0);
      await splashGone(page);
      await page.waitForTimeout(800);
      await onIt(page, `${tier}, move during the splash`, want);
      // Then a move after the splash: from Live TV to a channel on the first page of rows.
      await go(page, '#/live', 600);
      await go(page, `#/live/guide?channel=${early}`);
      await onIt(page, `${tier}, move after the splash`, early);
      // The person moves on: the focus is theirs (the router doesn't take it back).
      await key(page, 'ArrowDown');
      const after = await focused(page);
      check(`focus (${tier}): an arrow after it moves the focus on and it stays there`, after.channel && after.channel !== String(early), JSON.stringify(after));
      check(`focus (${tier}): no page errors`, !errors.length, errors.join(' | '));
      await browser.close();
    }
    {
      // A full load straight onto the link (the splash plays over it).
      const { browser, page, errors } = await session();
      await page.goto(`${BASE}/#/live/guide?channel=${want}`);
      await splashUp(page);
      await splashGone(page);
      await page.waitForTimeout(800);
      await onIt(page, `${tier}, full load`, want);
      check(`focus (${tier}): full load: no page errors`, !errors.length, errors.join(' | '));
      await browser.close();
    }
  }
}

if (LEGS.includes('arrows')) {
  const { browser, page, errors } = await start();
  await tabStop(page);
  const a = await focused(page);
  await key(page, 'ArrowRight');
  const b = await focused(page);
  check('arrows: Right goes to the next cell in the same row', b.channel === a.channel && b.index === a.index + 1, JSON.stringify({ a, b }));
  await key(page, 'ArrowLeft');
  const c = await focused(page);
  check('arrows: Left comes back', c.id === a.id, JSON.stringify({ a, c }));
  check('arrows: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('edge')) {
  const { browser, page, errors } = await start();
  const f0 = await from(page);
  await page.focus('.guide-row:nth-child(2) .guide-track button');
  const a = await focused(page);
  await key(page, 'ArrowLeft', 1200);
  const b = await focused(page);
  const f1 = await from(page);
  check('edge: Left from the first cell moves the window back 2 hours', f1 === f0 - STEP, `${f0} -> ${f1}`);
  check('edge: focus stays on that channel', b.channel === a.channel, JSON.stringify({ a, b }));
  check('edge: on the programme before', b.end <= a.start + 1 && b.start < a.start, JSON.stringify({ a, b }));
  await page.focus('.guide-row:nth-child(2) .guide-track .guide-cell:last-child button');
  const c = await focused(page);
  await key(page, 'ArrowRight', 1200);
  const d = await focused(page);
  check('edge: Right from the last cell moves the window on 2 hours', (await from(page)) === f1 + STEP, `${f1} -> ${await from(page)}`);
  check('edge: Right keeps the channel and goes later', d.channel === c.channel && d.start >= c.start, JSON.stringify({ c, d }));
  check('edge: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('held')) {
  const { browser, page, errors } = await start({ delay: 400 });
  const f0 = await from(page);
  await page.focus('.guide-row:nth-child(2) .guide-track button');
  const a = await focused(page);
  for (let i = 0; i < 6; i++) await key(page, 'ArrowLeft', 40);
  await page.waitForTimeout(3000);
  const b = await focused(page);
  const moved = (f0 - (await from(page))) / STEP;
  check('held: six quick Lefts move the window at most 2 steps', moved >= 1 && moved <= 2, `moved ${moved} steps`);
  check('held: focus still in that row', b.channel === a.channel, JSON.stringify({ a, b }));
  const dup = await page.$$eval('.guide-row', (rs) => rs.length - new Set(rs.map((r) => r.dataset.channel)).size);
  check('held: no row drawn twice', dup === 0, `duplicates ${dup}`);
  check('held: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('updown')) {
  const { browser, page, errors } = await start();
  await tabStop(page);
  await key(page, 'ArrowRight');
  const a = await focused(page);
  await key(page, 'ArrowDown');
  await key(page, 'ArrowDown');
  const mid = await focused(page);
  await key(page, 'ArrowUp');
  await key(page, 'ArrowUp');
  const b = await focused(page);
  check('updown: Down twice goes two rows down', mid.rowIndex === a.rowIndex + 2, JSON.stringify({ a, mid }));
  check('updown: Up twice comes back to the same programme (column kept)', b.id === a.id, JSON.stringify({ a, b }));
  await page.focus('.guide-row:first-child .guide-track button');
  await key(page, 'ArrowUp');
  const out = await page.evaluate(() => Boolean(document.activeElement?.closest('.guide-grid')));
  check('updown: Up from the first row leaves the grid (the usual navigation)', !out);
  check('updown: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('tools')) {
  const { browser, page, errors } = await start();
  const f0 = await from(page);
  const press = async (label) => {
    await page.focus(`.guide-tools button:has-text("${label}")`);
    await key(page, 'Enter', 900);
    return { from: await from(page), on: await page.evaluate(() => document.activeElement?.textContent?.trim()) };
  };
  const later = await press('Later');
  check('tools: Later moves on 2 hours', later.from === f0 + STEP, JSON.stringify(later));
  check('tools: focus stays on Later', later.on === 'Later', JSON.stringify(later));
  const earlier = await press('Earlier');
  check('tools: Earlier moves back 2 hours, focus stays', earlier.from === f0 && earlier.on === 'Earlier', JSON.stringify(earlier));
  await press('Later');
  const now = await press('Now');
  check('tools: Now goes back to the start, focus stays', now.from === f0 && now.on === 'Now', JSON.stringify(now));
  const one = await page.$$eval('.guide-grid [tabindex="0"]', (els) => els.length);
  check('tools: still one tab stop', one === 1, `tab stops ${one}`);
  await page.focus('.guide-day');
  await page.selectOption('.guide-day', { label: 'Tomorrow' });
  await page.waitForTimeout(900);
  check('tools: Day = Tomorrow moves a day on', (await from(page)) === f0 + DAY, `${f0} -> ${await from(page)}`);
  check('tools: focus stays on the Day picker', await page.evaluate(() => document.activeElement?.classList.contains('guide-day')));
  check('tools: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('group')) {
  const { browser, page, errors } = await start();
  const groups = await page.$$eval('.guide-group option', (os) => os.map((o) => o.textContent));
  check('group: All, Favourites, then the groups', JSON.stringify(groups) === JSON.stringify(['All', 'Favourites', 'Movies', 'News', 'Sport']), JSON.stringify(groups));
  await page.selectOption('.guide-group', 'News');
  await page.waitForTimeout(900);
  const news = await rows(page);
  check('group: News lists only its 20 channels', news.length === 20 && news.every((id) => (id - 100) % 3 === 0), JSON.stringify(news));
  await page.selectOption('.guide-group', 'Favourites');
  await page.waitForTimeout(900);
  check('group: Favourites lists the two favourites', JSON.stringify(await rows(page)) === JSON.stringify([107, 112]), JSON.stringify(await rows(page)));
  const one = await page.$$eval('.guide-grid [tabindex="0"]', (els) => els.length);
  check('group: one tab stop', one === 1, `tab stops ${one}`);
  check('group: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('more')) {
  const { browser, page, errors } = await start();
  check('more: 50 rows at first', (await rows(page)).length === 50, `rows ${(await rows(page)).length}`);
  await page.$eval('.guide-more', (s) => s.scrollIntoView());
  await page.waitForTimeout(1500);
  await page.$eval('.guide-more', (s) => s.scrollIntoView());
  await page.waitForTimeout(1500);
  const r = await rows(page);
  check('more: scrolling down draws the rest (60)', r.length === 60, `rows ${r.length}`);
  check('more: no channel drawn twice', new Set(r).size === r.length, `unique ${new Set(r).size}`);
  check('more: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('group-race')) {
  // A group picked, then Later pressed before the group's rows have arrived: Later keeps the group.
  const { browser, page, errors, live } = await start();
  const f0 = await from(page);
  live.set({ delay: 600 });
  await page.focus('.guide-group');
  await page.selectOption('.guide-group', 'News');
  await page.waitForTimeout(100);
  await page.focus('.guide-tools button:has-text("Later")');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  const r = await rows(page);
  check('group-race: Later keeps the group just picked', r.length === 20 && r.every((id) => (id - 100) % 3 === 0), JSON.stringify(r));
  check('group-race: the picker still says News', (await page.$eval('.guide-group', (s) => s.value)) === 'News');
  check('group-race: the window moved on', (await from(page)) === f0 + STEP, `${f0} -> ${await from(page)}`);
  check('group-race: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('more-race')) {
  // More rows asked for while a window move loads: every row drawn has the new window's programmes.
  const { browser, page, errors, live } = await start();
  live.set({ delay: 700 });
  await page.focus('.guide-tools button:has-text("Later")');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  await page.$eval('.guide-more', (s) => s.scrollIntoView());
  await page.waitForTimeout(4000);
  const bad = await page.$$eval('.guide-row', (rs) => {
    const to = Number(document.querySelector('.guide-grid').dataset.to);
    return rs.filter((r) => { const ends = [...r.querySelectorAll('.guide-prog')].map((x) => Number(x.dataset.end)); return ends.length && Math.max(...ends) < to; }).length;
  });
  check('more-race: no row is missing the end of the window', bad === 0, `rows short ${bad}`);
  check('more-race: 60 rows, none twice', (await rows(page)).length === 60 && new Set(await rows(page)).size === 60, `rows ${(await rows(page)).length}`);
  check('more-race: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('quiet')) {
  // An arrow inside the window touches only the cells that change, not every cell's style.
  const init = () => {
    window.__styleWrites = 0;
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) { if (n === 'style') window.__styleWrites++; return set.call(this, n, v); };
  };
  const { browser, page, errors } = await start({ init });
  await tabStop(page);
  await page.evaluate(() => { window.__styleWrites = 0; });
  await key(page, 'ArrowRight');
  await key(page, 'ArrowDown');
  const writes = await page.evaluate(() => window.__styleWrites);
  check('quiet: two arrows write no more than a few styles', writes <= 10, `style writes ${writes}`);
  check('quiet: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('phone')) {
  const { browser, page, errors } = await start({ phone: true });
  const opts = await page.$$eval('.guide-channel-select option', (os) => os.map((o) => o.textContent));
  check('phone: the channel picker lists 60 channels', opts.length === 60, `options ${opts.length}`);
  check('phone: channel 3 says encrypted', opts[2]?.endsWith(', encrypted'), opts[2]);
  check("phone: channel 4 says can't play here", opts[3]?.endsWith(", can't play here"), opts[3]);
  // On the first draw the router scrolls the page to the top after the list centred its programme on now (as today);
  // after a channel change it stays centred.
  await page.selectOption('.guide-channel-select', String(CHANNEL_IDS[8]));
  await page.waitForTimeout(900);
  const inView = await page.$eval('.guide-list .is-now', (b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).catch(() => false);
  check('phone: after a channel change the programme on now is in view', inView);
  await page.selectOption('.guide-channel-select', String(CHANNEL_IDS[3]));
  await page.waitForTimeout(900);
  check('phone: an unplayable channel dims the list', await page.$eval('.guide-list', (l) => l.classList.contains('is-unplayable')));
  await page.selectOption('.guide-channel-select', String(CHANNEL_IDS[4]));
  await page.waitForTimeout(900);
  check('phone: a channel with no guide says so', (await page.$eval('.guide-list', (l) => l.textContent.trim())) === 'No guide information');
  await page.selectOption('.guide-channel-select', String(CHANNEL_IDS[1]));
  await page.selectOption('.guide-day', { label: 'Yesterday' });
  await page.waitForTimeout(900);
  const ids = await page.$$eval('.guide-list button', (bs) => bs.map((b) => Number(b.dataset.start)));
  const y = new Date(T_LIVE); y.setHours(0, 0, 0, 0); y.setDate(y.getDate() - 1);
  check("phone: Yesterday shows yesterday's programmes", ids.length > 0 && ids.some((t) => t >= +y && t < +y + DAY) && ids.every((t) => t < +y + DAY + DAY), `${ids.length} programmes`);
  check('phone: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('phone-race')) {
  const slow = CHANNEL_IDS[6];
  const fast = CHANNEL_IDS[7];
  const { browser, page, errors } = await start({ phone: true, delay: (ids) => (ids.includes(slow) ? 800 : 0) });
  await page.selectOption('.guide-channel-select', String(slow));
  await page.waitForTimeout(100);
  await page.selectOption('.guide-channel-select', String(fast));
  await page.waitForTimeout(4500);
  const chans = await page.$$eval('.guide-list button', (bs) => [...new Set(bs.map((b) => Math.floor(Number(b.dataset.id) / 10000)))]);
  check('phone-race: the channel picked last is shown', JSON.stringify(chans) === JSON.stringify([fast]), JSON.stringify(chans));
  check('phone-race: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('sheet')) {
  const { browser, page, errors } = await start();
  await page.focus('.guide-row:nth-child(2) .guide-track .guide-cell:last-child button');
  const a = await focused(page);
  const title = await page.$eval('.guide-row:nth-child(2) .guide-track .guide-cell:last-child .guide-title', (t) => t.textContent);
  await key(page, 'Enter', 900);
  const head = await page.$eval('dialog[open] .dialog-head h2', (h) => h.textContent).catch(() => null);
  check('sheet: Enter opens the programme sheet with its title', head === title, `${head} / ${title}`);
  await page.click('dialog[open] .dialog-actions button:text-is("Record")');
  await page.waitForTimeout(1500);
  const post = liveRequests(page).find((r) => r.method === 'POST' && r.url === `/api/live/programmes/${a.id}/record`);
  check('sheet: Record asks the server to record it', Boolean(post), JSON.stringify(liveRequests(page)));
  check('sheet: the sheet closed', !(await page.$('dialog[open]')));
  const b = await focused(page);
  check('sheet: focus back on the same channel and programme', b.channel === a.channel && b.start === a.start, JSON.stringify({ a, b }));
  check('sheet: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('empty')) {
  for (const phone of [false, true]) {
    const { browser, page, errors } = await start({ channels: 'none', phone });
    const t = await page.evaluate(() => ({ head: Boolean(document.querySelector('main .page-head h1')), tools: Boolean(document.querySelector('main .guide-tools')), rows: document.querySelectorAll('main .guide-row').length, list: document.querySelector('main .guide-list')?.textContent.trim() ?? null }));
    check(`empty (${phone ? 'phone' : 'grid'}): head and tools drawn, no rows`, t.head && t.tools && t.rows === 0, JSON.stringify(t));
    if (phone) check('empty (phone): says No guide information', t.list === 'No guide information', JSON.stringify(t));
    check(`empty (${phone ? 'phone' : 'grid'}): no page errors`, !errors.length, errors.join(' | '));
    await browser.close();
  }
}

if (LEGS.includes('unknown')) {
  const { browser, page, errors } = await start({ hash: '#/live/guide?channel=999999' });
  const t = await page.$$eval('.guide-grid [tabindex="0"]', (els) => els.map((e) => ({ now: e.matches('button.guide-prog.is-now'), firstRow: e.closest('.guide-row') === document.querySelector('.guide-row') })));
  check('unknown: the page opens with one tab stop', t.length === 1 && t[0].now && t[0].firstRow, JSON.stringify(t));
  // As today: the usual tab stop is the one marked data-focus-now (the router focuses it).
  const marked = await page.evaluate(() => window.__focusNow);
  check('unknown: the usual tab stop is the one marked', marked.length === 1 && marked[0].now && marked[0].firstRow && marked[0].tabStop, JSON.stringify(marked));
  check('unknown: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

if (LEGS.includes('leaks')) {
  const init = () => {
    const intervals = new Set();
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = function (...a) { const id = si.apply(window, a); intervals.add(id); return id; };
    window.clearInterval = function (id) { intervals.delete(id); return ci.call(window, id); };
    const observers = new Set();
    const IO = window.IntersectionObserver;
    window.IntersectionObserver = class extends IO {
      observe(t) { observers.add(this); return super.observe(t); }
      disconnect() { observers.delete(this); return super.disconnect(); }
    };
    window.__leaks = () => ({ intervals: intervals.size, observers: observers.size });
  };
  const { browser, page, errors } = await start({ init, hash: '#/live' });
  const round = async () => {
    await go(page, '#/live/guide', 700);
    await go(page, '#/live', 900);
    return page.evaluate(() => window.__leaks());
  };
  const first = await round();
  let last = first;
  for (let i = 2; i <= 20; i++) last = await round();
  check('leaks: intervals are the same after 20 visits', last.intervals === first.intervals, JSON.stringify({ first, last }));
  check('leaks: observers are the same after 20 visits', last.observers === first.observers, JSON.stringify({ first, last }));
  check('leaks: no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}

console.log(failed() ? `${failed()} FAIL` : 'all passed');
process.exit(failed() ? 1 : 0);
