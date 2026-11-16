// v0.28: channels this device can't play. An iPhone (390 × 844, iPhone Safari's user agent, no Widevine or PlayReady)
// doesn't list a Widevine-only channel on the Live TV wall, the guide, Home's On now or search; the switch brings it
// back dimmed with "Can't play here"; opening it shows the message card (Watch on TV, Open TVNZ+) and asks for no
// stream; channel up/down skips it; a typed number opens the card. Desktop Chrome (Widevine, as a real Chrome has)
// sees it as before. Also an admin's "Provider app link…". Sets up its own IPTV source (devtools/mock-iptv.mjs) and
// puts the dev data back afterwards.
import { parseColor, wcagRatio } from '../src/themes/apca.js';
import { createRequire } from 'node:module';
import { BASE, go, check, failed } from './lib.mjs';
import { useMockSource } from './mock-iptv.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

// requestMediaKeySystemAccess answering as the device would: only the key systems named.
const keySystems = (have) => `(() => {
  const have = ${JSON.stringify(have)};
  const ok = (k) => have.some((h) => k.startsWith(h));
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { configurable: true, value: (k) => ok(k) ? Promise.resolve({ keySystem: k, getConfiguration: () => ({}), createMediaKeys: () => Promise.reject(new Error('stub')) }) : Promise.reject(new DOMException('Unsupported keySystem', 'NotSupportedError')) });
})();`;

async function context(browser, { phone, theme, base = BASE }) {
  const ctx = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, reducedMotion: 'reduce' }
      : { viewport: { width: 1917, height: 992 }, reducedMotion: 'reduce' },
  );
  await ctx.addInitScript(keySystems(phone ? ['org.w3.clearkey', 'com.apple.fps'] : ['com.widevine.alpha', 'org.w3.clearkey']));
  const r = await ctx.request.post(`${base}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  await ctx.request.patch(`${base}/api/me`, { data: { prefs: { theme, reduceMotion: true } } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // No stream is ever started: a play request is recorded and refused (the mock's streams go nowhere anyway).
  const plays = [];
  await page.route('**/api/live/channels/*/play', (route) => {
    plays.push(Number(route.request().url().match(/channels\/(\d+)\/play/)[1]));
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Check stub: no stream.' }) });
  });
  return { ctx, page, errors, plays };
}

// The contrast of an element's text against what is really behind it: its colour and every background up the tree
// (rgb() or color(srgb …), with alpha), composited, each faded by the element's and its ancestors' opacity.
/** Any computed colour -> [r, g, b, a] (0-255, alpha 0-1): rgb()/rgba() and oklch() through src/themes/apca.js
 *  (Daylight's colours compute to oklch() since visual refresh A), color(srgb ...) here; anything else is transparent. */
const toRgba = (c) => {
  const p = parseColor(c);
  if (p) return [p.r, p.g, p.b, p.a];
  const m = /color\(srgb ([^)]+)\)/.exec(c);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[ /]+/).filter(Boolean).map(Number);
    return [r * 255, g * 255, b * 255, a];
  }
  return [0, 0, 0, 0];
};
/** WCAG contrast of an element's text on what is painted under it (its own and its ancestors' backgrounds over white). */
const contrastOf = async (locator) => {
  const { fg, bgs, opacity } = await locator.evaluate((el) => {
    const bgs = [];
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      bgs.push(cs.backgroundColor);
    }
    return { fg: getComputedStyle(el).color, bgs, opacity };
  });
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  let bg = [255, 255, 255, 1];
  for (const l of bgs.map(toRgba).reverse()) bg = over(l, bg);
  const f = toRgba(fg);
  const text = over([f[0], f[1], f[2], f[3] * opacity], bg);
  const ratio = wcagRatio({ r: text[0], g: text[1], b: text[2] }, { r: bg[0], g: bg[1], b: bg[2] });
  return Math.round(ratio * 100) / 100;
};
const opacityOf = (locator) =>
  locator.evaluate((el) => {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });

const names = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.getAttribute('aria-label') || e.textContent));
const has = (list, name) => list.some((t) => t.includes(name));

const src = await useMockSource();
const id = Object.fromEntries(src.channels.map((c) => [c.name, c.id]));
const browser = await chromium.launch();
try {
  // ---------------- iPhone, Orbit ----------------
  {
    const { ctx, page, errors, plays } = await context(browser, { phone: true, theme: 'orbit' });
    await go(page, '#/live');
    await page.waitForSelector('.live-item');
    let wall = await names(page, '.live-item > button');
    check('iPhone: TVNZ 2 (Widevine only) is not on the wall', !has(wall, 'TVNZ 2'), wall.join(' | '));
    check('iPhone: Both Ways (Widevine + ClearKey) and Plain One are', has(wall, 'Both Ways') && has(wall, 'Plain One'));
    const more = page.locator('.live-toolbar [aria-label="More options for Live TV"]');
    check('iPhone: the "…" with the switch is there', (await more.count()) === 1);
    await more.click();
    const item = page.locator('dialog[open] .sheet-item', { hasText: "Show channels this iPhone can't play" });
    check('the switch says "Show channels this iPhone can\'t play"', (await item.count()) === 1);
    check('…and says it is off (aria-pressed)', (await item.getAttribute('aria-pressed')) === 'false');
    await item.click();
    await page.waitForTimeout(300);
    wall = await names(page, '.live-item > button');
    const tv2 = page.locator(`.live-item[data-id="${id['TVNZ 2'].toString()}"]`);
    check('with the switch on, TVNZ 2 is back', has(wall, 'TVNZ 2'));
    check('…dimmed, with "Can\'t play here"', (await tv2.getAttribute('class'))?.includes('is-unplayable') && (await tv2.innerText()).includes("Can't play here") && (await opacityOf(tv2.locator('.live-card-art'))) < 1);
    check('…only the picture is dimmed: the name and the tag are not', (await opacityOf(tv2.locator('.live-card-name'))) === 1 && (await opacityOf(tv2.locator('.live-cant'))) === 1);
    check('the switch is kept on this device', (await page.evaluate(() => localStorage.getItem('atomix-show-unplayable'))) === '1');
    await more.click();
    check('…and now says it is on (aria-pressed, ticked)', (await item.getAttribute('aria-pressed')) === 'true' && (await item.getAttribute('class'))?.includes('is-current'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await tv2.locator('> button').click();
    const card = page.locator('dialog[open] .cant-play');
    await card.waitFor({ timeout: 4000 }).catch(() => {});
    check('opening it shows the message card', (await card.count()) === 1);
    const text = (await card.innerText().catch(() => '')) || '';
    check('…with the sentence', text.includes("This channel is encrypted with Widevine, which iPhones can't play."), text.replace(/\n/g, ' / '));
    check('…Watch on TV', (await card.locator('button', { hasText: 'Watch on TV' }).count()) === 1);
    const app = card.locator('a', { hasText: 'Open TVNZ+' });
    check('…and "Open TVNZ+" to the TVNZ site, in a new tab', (await app.count()) === 1 && (await app.getAttribute('href')) === 'https://www.tvnz.co.nz' && (await app.getAttribute('target')) === '_blank' && (await app.getAttribute('rel')) === 'noopener');
    check('…and Go back', (await card.locator('button', { hasText: 'Go back' }).count()) === 1);
    check('no stream was asked for', plays.length === 0, JSON.stringify(plays));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    check('Back closes the card', (await page.locator('dialog[open]').count()) === 0);
    check('still on Live TV', page.url().endsWith('#/live'));
    // A typed channel number of a channel the switch hides opens the card too.
    await page.locator('.live-toolbar [aria-label="More options for Live TV"]').click();
    await page.locator('dialog[open] .sheet-item').first().click();
    await page.waitForTimeout(300);
    check('switch off: TVNZ 2 is gone again', !has(await names(page, '.live-item > button'), 'TVNZ 2'));
    await page.locator('.live-item > button').first().focus();
    await page.keyboard.press('2');
    await page.keyboard.press('Enter');
    await page.locator('dialog[open] .cant-play').waitFor({ timeout: 4000 }).catch(() => {});
    check('typing 2 (TVNZ 2) opens the card', (await page.locator('dialog[open] .cant-play').count()) === 1 && page.url().endsWith('#/live'));
    check('…and asks for no stream', plays.length === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Zapping: from Both Ways, channel down (PageUp) skips TVNZ 2 and wraps to the last channel.
    const order = (await (await ctx.request.get(`${BASE}/api/live/channels`)).json()).filter((c) => !c.radio).map((c) => c.id);
    const last = order[order.length - 1];
    await page.locator(`.live-item[data-id="${id['Both Ways']}"] > button`).click();
    await page.waitForFunction(() => location.hash.startsWith('#/live/play/'), null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    check('Both Ways is asked for (it plays here with ClearKey)', plays.includes(id['Both Ways']), JSON.stringify(plays));
    plays.length = 0;
    await page.locator('.player').focus().catch(() => {});
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(1500);
    check('channel down from Both Ways skips TVNZ 2', !plays.includes(id['TVNZ 2']) && plays.includes(last), `asked for ${JSON.stringify(plays)}; TVNZ 2 is ${id['TVNZ 2']}, the last is ${last}`);
    plays.length = 0;
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(1500);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(1500);
    // The mock's channels come first (2, 3, 4), so from the last channel up wraps over TVNZ 2 to Both Ways, then Plain One.
    check('channel up from the last channel wraps over TVNZ 2 to Both Ways, then Plain One', !plays.includes(id['TVNZ 2']) && plays[0] === id['Both Ways'] && plays.at(-1) === id['Plain One'], JSON.stringify(plays));

    // A link straight to the hidden channel (an old bookmark): the card, no stream, Go back leaves.
    plays.length = 0;
    await go(page, '#/');
    await page.evaluate((n) => (location.hash = `#/live/play/${n}`), id['TVNZ 2']);
    await page.waitForTimeout(2500);
    check('a link to TVNZ 2 opens the card instead of the stream', (await page.locator('dialog[open] .cant-play').count()) === 1 && plays.length === 0, JSON.stringify(plays));
    await page.locator('dialog[open] button', { hasText: 'Go back' }).click().catch(() => {});
    await page.waitForTimeout(800);
    check('…Go back leaves the player', !page.url().includes('#/live/play/'), page.url());

    // The guide, Home's On now and search's On TV.
    await go(page, '#/live/guide');
    await page.waitForSelector('.guide-channel-select option, .guide-chan', { timeout: 5000 }).catch(() => {});
    const guideNames = await page.$$eval('.guide-channel-select option, .guide-chan', (els) => els.map((e) => e.textContent));
    check('iPhone guide: no TVNZ 2', guideNames.length > 0 && !has(guideNames, 'TVNZ 2') && has(guideNames, 'Both Ways'), guideNames.join(' | '));
    await go(page, '#/');
    await page.waitForTimeout(800);
    const onNow = await page.$$eval('[data-channel]', (els) => els.map((e) => Number(e.dataset.channel)));
    check('iPhone Home On now: no TVNZ 2', onNow.length > 0 && !onNow.includes(id['TVNZ 2']) && onNow.includes(id['Plain One']), JSON.stringify(onNow));
    await go(page, '#/search');
    await page.fill('.search-input', 'TVNZ');
    await page.waitForTimeout(1500);
    const tvNames = await names(page, '.live-search-chan');
    check('iPhone search "TVNZ": no TVNZ 2 under On TV', !has(tvNames, 'TVNZ 2'), tvNames.join(' | '));
    await page.fill('.search-input', 'Both');
    await page.waitForTimeout(1500);
    check('iPhone search "Both": Both Ways is', has(await names(page, '.live-search-chan'), 'Both Ways'));

    // With the switch on, the guide and On now list it too, dimmed and tagged.
    await page.evaluate(() => localStorage.setItem('atomix-show-unplayable', '1'));
    await go(page, '#/live/guide');
    await page.waitForSelector('.guide-channel-select option', { timeout: 5000 }).catch(() => {});
    const opt = await page.$$eval('.guide-channel-select option', (els) => els.map((e) => [e.value, e.textContent]));
    const tvOpt = opt.find(([, t]) => t.includes('TVNZ 2'));
    check('switch on, iPhone guide: TVNZ 2 listed, saying it can\'t play here', Boolean(tvOpt) && tvOpt[1].includes("can't play here"), JSON.stringify(opt));
    if (tvOpt) {
      await page.selectOption('.guide-channel-select', tvOpt[0]);
      await page.waitForTimeout(800);
      check('…its day marked, its text at full contrast (no picture to dim; the picker says why)', (await page.locator('.guide-list.is-unplayable').count()) === 1 && (await opacityOf(page.locator('.guide-list > li').first())) === 1);
      await page.selectOption('.guide-channel-select', String(id['Plain One']));
      await page.waitForTimeout(800);
      check('…another channel\'s day not dimmed', (await page.locator('.guide-list.is-unplayable').count()) === 0);
    }
    await go(page, '#/');
    await page.waitForTimeout(800);
    const tvCard = page.locator(`a.live-card[data-channel="${id['TVNZ 2']}"]`);
    check('switch on, iPhone On now: TVNZ 2 dimmed with "Can\'t play here"', (await tvCard.count()) === 1 && (await tvCard.getAttribute('class')).includes('is-unplayable') && (await tvCard.locator('.live-cant').innerText()) === "Can't play here" && Number(await tvCard.locator('.card-art').evaluate((e) => getComputedStyle(e).opacity)) < 1);
    check('…the others not', (await page.locator('a.live-card.is-unplayable').count()) === 1 && (await page.locator('a.live-card .live-cant').count()) === 1);
    plays.length = 0;
    await tvCard.click();
    await page.locator('dialog[open] .cant-play').waitFor({ timeout: 4000 }).catch(() => {});
    check('…opening it shows the card, no stream', (await page.locator('dialog[open] .cant-play').count()) === 1 && plays.length === 0 && !page.url().includes('#/live/play/'));
    await page.keyboard.press('Escape');
    check('iPhone: no page errors', errors.length === 0, errors.join(' | '));
    await page.evaluate(() => localStorage.removeItem('atomix-show-unplayable'));
    await ctx.close();
  }

  // ---------------- iPhone, a fresh load of the player for TVNZ 2 (a bookmark, a shared link, a reload) ----------------
  {
    const { ctx, page, errors, plays } = await context(browser, { phone: true, theme: 'orbit' });
    await page.goto(`${BASE}/#/live/play/${id['TVNZ 2']}`);
    await page.keyboard.press('Escape').catch(() => {}); // the splash
    await page.locator('dialog[open] .cant-play').waitFor({ timeout: 6000 }).catch(() => {});
    check('fresh load of TVNZ 2\'s player: the card', (await page.locator('dialog[open] .cant-play').count()) === 1);
    await page.waitForTimeout(800);
    check('…and no stream asked for', plays.length === 0, JSON.stringify(plays));
    check('fresh load: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- Desktop at a plain-http address (nothing can be hidden): a fresh load doesn't wait for the list ----------------
  if (process.env.PLAIN_BASE) {
    const { ctx, page, errors, plays } = await context(browser, { phone: false, theme: 'orbit', base: process.env.PLAIN_BASE });
    let listedAt = 0;
    await page.route('**/api/live/channels', async (route) => {
      await new Promise((r) => setTimeout(r, 4000)); // a slow channel list
      listedAt = Date.now();
      await route.continue();
    });
    const at = Date.now();
    await page.goto(`${process.env.PLAIN_BASE}/#/live/play/${id['Plain One']}`);
    await page.keyboard.press('Escape').catch(() => {});
    for (let i = 0; i < 30 && !plays.length; i++) await page.waitForTimeout(100);
    check('plain-http desktop, fresh load of Plain One: the stream is asked for at once', plays.length === 1 && !listedAt, `after ${Date.now() - at} ms, list answered: ${Boolean(listedAt)}`);
    check('…no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } else console.log('SKIP plain-http fresh load (set PLAIN_BASE to a non-local address of the dev server, e.g. http://<LAN IP>:8787)');

  // ---------------- iPhone's user agent at a wide size: the guide grid, switch on ----------------
  {
    const { ctx, page, errors } = await context(browser, { phone: true, theme: 'arctic' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => localStorage.setItem('atomix-show-unplayable', '1'));
    await go(page, '#/live/guide');
    await page.waitForSelector('.guide-row', { timeout: 5000 }).catch(() => {});
    const row = page.locator(`.guide-row[data-channel="${id['TVNZ 2']}"]`);
    check('switch on, guide grid: TVNZ 2\'s row dimmed with "Can\'t play here"', (await row.count()) === 1 && (await row.getAttribute('class')).includes('is-unplayable') && (await row.locator('.live-cant').count()) === 1 && (await opacityOf(row.locator('.live-logo'))) < 1);
    check('…its logo only: the name, the tag and the programmes keep full contrast', (await opacityOf(row.locator('.guide-chan-name'))) === 1 && (await opacityOf(row.locator('.live-cant'))) === 1 && (await opacityOf(row.locator('button').first())) === 1);
    check('…the other rows not', (await page.locator('.guide-row.is-unplayable').count()) === 1 && (await page.locator('.guide-row .live-cant').count()) === 1);
    check('…its cells say so', ((await row.locator('button').first().getAttribute('aria-label')) || '').includes("can't play here"));
    check('guide grid: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- iPhone, an older theme: the check box ----------------
  {
    const { ctx, page, errors } = await context(browser, { phone: true, theme: 'arctic' });
    await go(page, '#/live');
    await page.waitForSelector('.live-item');
    const box = page.locator('label.live-show-unplayable');
    check('older theme on iPhone: the check box over the list', (await box.count()) === 1 && (await box.innerText()).includes("Show channels this iPhone can't play"));
    check('…TVNZ 2 not listed', !has(await names(page, '.live-row'), 'TVNZ 2'));
    await box.locator('input').check();
    await page.waitForTimeout(300);
    check('…ticked: TVNZ 2 listed with "Can\'t play here"', (await page.locator('.live-item.is-unplayable', { hasText: "Can't play here" }).count()) === 1);
    {
      const dim = page.locator('.live-item.is-unplayable');
      check('…its logo dimmed', (await opacityOf(dim.locator('.live-logo'))) < 1);
      check('…its text not', (await opacityOf(dim.locator('.live-name'))) === 1 && (await opacityOf(dim.locator('.live-now'))) === 1);
    }
    await box.locator('input').uncheck();
    check('older theme on iPhone: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- iPhone, the lightest theme (Daylight): the dimmed row's text and tag keep 4.5:1 ----------------
  {
    const { ctx, page, errors } = await context(browser, { phone: true, theme: 'daylight' });
    await page.addInitScript(() => localStorage.setItem('atomix-show-unplayable', '1'));
    await go(page, '#/live');
    await page.waitForSelector('.live-item.is-unplayable');
    const dim = page.locator('.live-item.is-unplayable');
    const muted = await contrastOf(dim.locator('.muted').first());
    const tag = await contrastOf(dim.locator('.live-cant'));
    const name = await contrastOf(dim.locator('.live-name'));
    check('Daylight: a dimmed row\'s muted text is at least 4.5:1', muted >= 4.5, String(muted));
    check('Daylight: its "Can\'t play here" tag is at least 4.5:1', tag >= 4.5, String(tag));
    check('Daylight: its name is at least 4.5:1', name >= 4.5, String(name));
    await go(page, '#/live/guide');
    await page.waitForSelector('.guide-list, .guide-row', { timeout: 5000 }).catch(() => {});
    const gtag = page.locator('.is-unplayable .live-cant').first();
    if (await gtag.count()) check('Daylight guide: the tag is at least 4.5:1', (await contrastOf(gtag)) >= 4.5, String(await contrastOf(gtag)));
    await page.evaluate(() => localStorage.removeItem('atomix-show-unplayable'));
    check('Daylight: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- Desktop Chrome: as before ----------------
  for (const theme of ['orbit', 'arctic']) {
    const { ctx, page, errors } = await context(browser, { phone: false, theme });
    await go(page, '#/live');
    await page.waitForSelector('.live-item');
    await page.waitForTimeout(800); // the key-system probe
    const wall = await names(page, '.live-item > button');
    check(`desktop ${theme}: TVNZ 2 is listed`, has(wall, 'TVNZ 2'), wall.join(' | '));
    check(`desktop ${theme}: nothing dimmed, no switch`, (await page.locator('.is-unplayable, .live-cant, .live-show-unplayable, [aria-label="More options for Live TV"]').count()) === 0);
    await go(page, '#/live/guide');
    await page.waitForSelector('.guide-chan', { timeout: 5000 }).catch(() => {});
    check(`desktop ${theme}: the guide lists TVNZ 2`, has(await page.$$eval('.guide-chan', (els) => els.map((e) => e.textContent)), 'TVNZ 2'));
    await go(page, '#/');
    await page.waitForTimeout(800);
    check(`desktop ${theme}: Home On now has TVNZ 2`, (await page.locator(`[data-channel="${id['TVNZ 2']}"]`).count()) > 0);
    if (theme === 'arctic') {
      // An admin's "Provider app link…".
      await go(page, '#/live');
      await page.locator(`.live-item[data-id="${id['TVNZ 2']}"] [aria-label="More options for TVNZ 2"]`).click();
      const linkItem = page.locator('dialog[open] .sheet-item', { hasText: 'Provider app link…' });
      check('admin: "Provider app link…" in the channel\'s "…"', (await linkItem.count()) === 1);
      await linkItem.click();
      const dlg = page.locator('dialog[open]', { hasText: 'Provider app link for TVNZ 2' });
      await dlg.waitFor({ timeout: 3000 }).catch(() => {});
      check('…opens its dialog, filled with the link in force', (await dlg.locator('input[name="url"]').inputValue()) === 'https://www.tvnz.co.nz' && (await dlg.locator('input[name="name"]').inputValue()) === 'TVNZ+');
      // Save with nothing changed: the built-in link must not become the admin's own setting.
      const puts = [];
      const onReq = (rq) => rq.method() === 'PUT' && rq.url().includes('/app-link') && puts.push(rq.postData());
      page.on('request', onReq);
      await dlg.locator('button', { hasText: 'Save' }).click();
      await page.waitForTimeout(600);
      page.off('request', onReq);
      let unchanged = (await (await ctx.request.get(`${BASE}/api/live/channels`)).json()).find((x) => x.id === id['TVNZ 2']);
      check('…Save with nothing changed saves nothing (the built-in link stays the default)', puts.length === 0 && unchanged.appLinkAdmin === false && (await page.locator('dialog[open]', { hasText: 'Provider app link for TVNZ 2' }).count()) === 0, JSON.stringify({ puts, appLinkAdmin: unchanged.appLinkAdmin }));
      await page.locator(`.live-item[data-id="${id['TVNZ 2']}"] [aria-label="More options for TVNZ 2"]`).click();
      await page.locator('dialog[open] .sheet-item', { hasText: 'Provider app link…' }).click();
      await dlg.waitFor({ timeout: 3000 }).catch(() => {});
      await dlg.locator('input[name="url"]').fill('http://insecure.example/');
      await dlg.locator('button', { hasText: 'Save' }).click();
      await page.waitForTimeout(400);
      check('…an http address is refused, in the dialog', (await dlg.locator('.form-error').innerText().catch(() => '')).includes('https://'));
      await dlg.locator('input[name="url"]').fill('https://watch.example/app');
      await dlg.locator('input[name="name"]').fill('Example');
      await dlg.locator('button', { hasText: 'Save' }).click();
      await page.waitForTimeout(600);
      let c = (await (await ctx.request.get(`${BASE}/api/live/channels`)).json()).find((x) => x.id === id['TVNZ 2']);
      check('…Save keeps it', c.appUrl === 'https://watch.example/app' && c.appName === 'Example', JSON.stringify([c.appUrl, c.appName]));
      await page.locator(`.live-item[data-id="${id['TVNZ 2']}"] [aria-label="More options for TVNZ 2"]`).click();
      await page.locator('dialog[open] .sheet-item', { hasText: 'Provider app link…' }).click();
      await page.locator('dialog[open] button', { hasText: 'Use default' }).click();
      await page.waitForTimeout(600);
      c = (await (await ctx.request.get(`${BASE}/api/live/channels`)).json()).find((x) => x.id === id['TVNZ 2']);
      check('…Use default goes back to TVNZ+', c.appUrl === 'https://www.tvnz.co.nz' && c.appName === 'TVNZ+' && c.appLinkAdmin === false, JSON.stringify([c.appUrl, c.appName, c.appLinkAdmin]));
    }
    check(`desktop ${theme}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
  await src.restore();
}
process.exit(failed() ? 1 : 0);
