// OLED black, More contrast, Large text (visual refresh B2). `node devtools/modes-check.mjs`  (dev server up)
// True black: body background #000 (Midnight, Orbit); More contrast: a button and a card's art have a 2 px edge, the
// glass is Solid; Large text 1.3: .card-title 1.3× normal (±1 px) in Midnight and Orbit; with Largest text at 390×844 and
// 1920×1080 no page scrolls sideways (Home, a library, a title page, Settings); forced colours hide the backdrop/scrim.
import { open, go, check, failed, BASE } from './lib.mjs';

const API = `${BASE}/api/me`;
const reset = { oled: null, contrast: null, textScale: null, glass: null };
async function at(theme, size, prefs, fn, extra = {}) {
  const [width, height] = size;
  const s = await open({ width, height, theme, isMobile: width < 600, hasTouch: width < 600 });
  await s.context.request.patch(API, { data: { prefs: { ...reset, ...prefs } } });
  if (extra.forced) await s.page.emulateMedia({ forcedColors: 'active' });
  try { await fn(s.page); } finally { await s.context.request.patch(API, { data: { prefs: reset } }); await s.browser.close(); }
}
const fresh = async (page, hash) => { await page.goto('about:blank'); await go(page, hash); };
const px = (v) => parseFloat(v);

for (const theme of ['midnight', 'orbit']) {
  await at(theme, [1366, 768], { oled: true }, async (page) => {
    await fresh(page, '#/settings');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`${theme} OLED: page is black`, /^rgb\(0, 0, 0\)$/.test(bg), bg);
  });
  await at(theme, [1366, 768], { oled: true }, async (page) => {
    // Final review C1: a dialog under OLED must not jump the page to the top.
    await fresh(page, '#/settings');
    // The page's scroller: the window, or (Orbit) the element that scrolls the page.
    await page.evaluate(() => {
      const se = document.scrollingElement;
      window.__sc = se.scrollHeight > innerHeight + 200 ? se : [...document.querySelectorAll('#main, #main *')].find((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY)) || se;
      window.__sc.scrollTop = 1200;
    });
    await page.waitForTimeout(300);
    const pos = () => page.evaluate(() => window.__sc.scrollTop);
    const y0 = await pos();
    await page.evaluate(() => { import('/js/components.js').then((c) => c.openSheet('Test', [{ label: 'One', icon: 'check', onSelect() {} }])); }); // not awaited: the sheet's promise ends when it closes
    await page.waitForTimeout(400);
    const yOpen = await pos();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const yClosed = await pos();
    check(`${theme} OLED: a sheet keeps the page where it was`, y0 > 0 && Math.abs(yOpen - y0) < 2 && Math.abs(yClosed - y0) < 2, `${y0} → ${yOpen} → ${yClosed}`);
  });
  await at(theme, [1366, 768], { contrast: 'more' }, async (page) => {
    await fresh(page, '#/');
    const r = await page.evaluate(() => {
      const b = document.querySelector('.btn');
      const a = document.querySelector('.card .card-art');
      const after = a ? getComputedStyle(a, '::after').boxShadow : '';
      return { btn: b ? getComputedStyle(b).borderTopWidth : null, art: after, glass: document.documentElement.dataset.glass };
    });
    check(`${theme} More contrast: buttons have a 2px edge`, px(r.btn) >= 2, r.btn);
    check(`${theme} More contrast: card art has a 2px edge`, /inset 0px 0px 0px 2px/.test(r.art) || /0px 0px 0px 2px .*inset/.test(r.art), r.art);
    check(`${theme} More contrast: glass is solid`, r.glass === 'solid', r.glass);
  });
  const size = {};
  for (const scale of [1, 1.3]) {
    await at(theme, [1366, 768], { textScale: scale }, async (page) => {
      await fresh(page, '#/');
      size[scale] = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.card-title')).fontSize));
    });
  }
  check(`${theme} Largest text: card titles 1.3×`, Math.abs(size[1.3] - size[1] * 1.3) <= 1, `${size[1]} → ${size[1.3]}`);
  for (const vp of [[390, 844], [1920, 1080]]) {
    await at(theme, vp, { textScale: 1.3 }, async (page) => {
      for (const hash of ['#/', '#/library/1', '#/item/1', '#/settings']) {
        await fresh(page, hash);
        const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        check(`${theme} Largest text ${vp.join('×')} ${hash}: no sideways scroll`, w[0] <= w[1] + 1, w.join(' > '));
      }
    });
  }
}
await at('midnight', [1366, 768], {}, async (page) => {
  await fresh(page, '#/item/1');
  const shown = await page.evaluate(() => [...document.querySelectorAll('.backdrop, .scrim')].filter((e) => getComputedStyle(e).display !== 'none').length);
  check('forced colours: no picture behind text', shown === 0, String(shown));
}, { forced: true });
console.log(failed() ? `${failed()} FAIL` : 'ALL PASS');
process.exit(failed() ? 1 : 0);
