// Card motion v2 (v0.28), selecting a card: the selected poster lifts (art scale 1.06, up 4 px), its glow fades in,
// the row's other cards dim to 0.78 and (Orbit) a one-line info strip rises in on the art's lower edge; a held arrow tweens nothing;
// reduce: no growth or dimming, the strip only fades; none: instant; hover (fine pointers only) is subtler; the sheen
// crosses a card once per page visit. Orbit and Arctic, desktop and phone. `node devtools/card-select.mjs`
import { open, go, check, failed } from './lib.mjs';

const ROW = '.row[data-row="recent-1"] .row-scroller';
const near = (a, b, d = 0.006) => Math.abs(a - b) <= d;

/** Everything the checks read, in one go: the art's scale and lift, the glow, a neighbour, the info strip. */
const read = (page, i = 1) =>
  page.evaluate(({ ROW, i }) => {
    const row = document.querySelector(ROW);
    const cards = [...row.querySelectorAll(':scope > a.card')];
    const card = cards[i];
    const art = card.querySelector('.card-art');
    const m = new DOMMatrix(getComputedStyle(art).transform);
    const info = card.querySelector('.card-info');
    const is = info && getComputedStyle(info);
    const r = info?.getBoundingClientRect();
    return {
      scale: m.a,
      y: m.f,
      glow: Number(getComputedStyle(card, '::before').opacity),
      neighbour: Number(getComputedStyle(cards[i + 1]).opacity),
      self: Number(getComputedStyle(card).opacity),
      hasSelected: row.classList.contains('has-selected'),
      // Shown: a real box, not clipped away; Orbit lays it on the lower edge of the art (a row clips below its cards).
      info: info && {
        text: info.textContent,
        opacity: Number(is.opacity),
        shown: r.width > 20 && r.height > 8 && is.clipPath === 'none',
        onArt: (() => { const a = art.getBoundingClientRect(); return r.bottom <= a.bottom + 0.5 && r.top >= a.top && r.left >= a.left - 0.5 && r.right <= a.right + 0.5; })(),
        prop: is.transitionProperty,
        delay: is.transitionDelay,
        dur: is.transitionDuration,
      },
      artDur: getComputedStyle(art).transitionDuration,
      rowScrollsDown: row.scrollHeight > row.clientHeight + 1,
    };
  }, { ROW, i });

/** Keyboard mode (one arrow press), so a scripted focus is focus-visible; the sheen count starts from there. */
async function prime(page) {
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window.__sheens = 0));
}
async function focusCard(page, i = 1) {
  await page.evaluate(({ ROW, i }) => document.querySelectorAll(`${ROW} > a.card`)[i].focus({ preventScroll: false }), { ROW, i });
}

async function setup(opts) {
  const o = await open(opts);
  // Count sheens: each time a card gains .is-sheen.
  await o.context.addInitScript(() => {
    window.__sheens = 0;
    new MutationObserver((list) => {
      for (const m of list) if (m.target.matches?.('a.card.is-sheen') && !(m.oldValue || '').includes('is-sheen')) window.__sheens++;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  await go(o.page, '#/');
  await o.page.waitForSelector(`${ROW} > a.card`, { timeout: 15000 });
  await o.page.waitForTimeout(400);
  return o;
}

for (const theme of ['orbit', 'arctic']) {
  for (const [size, w, h, phone] of [['desktop', 1917, 992, false], ['phone', 390, 844, true]]) {
    const tag = `${theme} ${size}`;
    // ---- full motion ----
    {
      const { browser, page, errors } = await setup({ theme, width: w, height: h, hasTouch: phone, isMobile: phone });
      const rest = await read(page);
      check(`${tag}: at rest nothing is lifted, glowing or dimmed`, near(rest.scale, 1) && rest.y === 0 && rest.glow === 0 && rest.neighbour === 1 && !rest.hasSelected, JSON.stringify(rest));
      check(`${tag}: at rest the row doesn't scroll up and down`, !rest.rowScrollsDown);
      const label = await page.evaluate((ROW) => { const c = document.querySelectorAll(`${ROW} > a.card`)[1]; return { label: c.getAttribute('aria-label'), line: c.querySelector('.card-info')?.textContent }; }, ROW);
      check(`${tag}: the card's spoken name carries the info line`, Boolean(label.line) && label.label.includes(label.line.split(' · ').join(', ')), JSON.stringify(label));
      check(`${tag}: the info strip is in the page at rest, unseen`, Boolean(rest.info?.text) && (rest.info.opacity === 0 || !rest.info.shown), JSON.stringify(rest.info));
      await prime(page);
      await focusCard(page);
      await page.waitForTimeout(450);
      const s = await read(page);
      check(`${tag}: the selected poster's art grows 1.06 and lifts 4 px`, near(s.scale, 1.06) && near(s.y, -4, 0.05), `scale ${s.scale} y ${s.y}`);
      check(`${tag}: its glow is on`, s.glow === 1, String(s.glow));
      check(`${tag}: the row's other cards dim to 0.78, the selected one doesn't`, near(s.neighbour, 0.78, 0.001) && s.self === 1 && s.hasSelected, `${s.neighbour} / ${s.self}`);
      if (theme === 'orbit') check(`${tag}: the info strip shows on its lower edge`, s.info.opacity === 1 && s.info.shown && s.info.onArt && /^\d{4}/.test(s.info.text), JSON.stringify(s.info));
      else check(`${tag}: older themes keep the strip for screen readers only`, !s.info.shown, JSON.stringify(s.info));
      check(`${tag}: no vertical scroll in the row while selected`, !s.rowScrollsDown);
      // The sheen: once per card per page visit.
      const sheens = await page.evaluate(() => window.__sheens || 0);
      check(`${tag}: the sheen crossed the card once`, sheens === 1, String(sheens));
      await focusCard(page, 2);
      await page.waitForTimeout(80);
      await focusCard(page, 1);
      await page.waitForTimeout(500);
      check(`${tag}: not again on the same page`, (await page.evaluate(() => window.__sheens)) === 2, `${await page.evaluate(() => window.__sheens)} (2 = cards 1 and 2 once each)`);
      // A held arrow: nothing tweens.
      await page.evaluate(() => document.documentElement.classList.add('nav-held'));
      const held = await read(page);
      check(`${tag}: a held arrow: the art's transition takes 0 s`, held.artDur.split(',').every((d) => parseFloat(d) === 0), held.artDur);
      if (theme === 'orbit') check(`${tag}: a held arrow: the strip has no tween or delay`, held.info.dur.split(',').every((d) => parseFloat(d) === 0) && held.info.delay.split(',').every((d) => parseFloat(d) === 0), `${held.info.dur} / ${held.info.delay}`);
      await focusCard(page, 3);
      await page.waitForTimeout(30);
      check(`${tag}: a held arrow: no sheen`, (await page.evaluate(() => window.__sheens)) === 2);
      await page.evaluate(() => document.documentElement.classList.remove('nav-held'));
      // A new page visit: the sheen comes back.
      await page.evaluate(() => (location.hash = '#/search'));
      await page.waitForTimeout(500);
      await page.evaluate(() => (location.hash = '#/'));
      await page.waitForSelector(`${ROW} > a.card`);
      await page.waitForTimeout(400);
      await focusCard(page, 1);
      await page.waitForTimeout(100);
      check(`${tag}: a new visit to the page: the sheen again`, (await page.evaluate(() => window.__sheens)) === 3, String(await page.evaluate(() => window.__sheens)));
      // Moving off the row clears the dimming.
      await page.evaluate(() => document.activeElement.blur());
      await page.waitForTimeout(300);
      const off = await read(page);
      check(`${tag}: focus gone: nothing dimmed`, !off.hasSelected && off.neighbour === 1, JSON.stringify(off));
      // Hover: fine pointers only.
      if (!phone) {
        await page.locator(`${ROW} > a.card`).nth(1).hover();
        await page.waitForTimeout(450);
        const hv = await read(page);
        check(`${tag}: hover (mouse): the art grows 1.04`, near(hv.scale, 1.04) && near(hv.y, -4, 0.05) && hv.glow === 1, `scale ${hv.scale} y ${hv.y} glow ${hv.glow}`);
        check(`${tag}: hover dims the others, never the one under the pointer`, near(hv.neighbour, 0.78, 0.001) && hv.self === 1);
      } else {
        await page.locator(`${ROW} > a.card`).nth(1).hover().catch(() => {});
        await page.waitForTimeout(450);
        const hv = await read(page);
        check(`${tag}: no hover growth on a touch screen`, near(hv.scale, 1) && hv.glow === 0, `scale ${hv.scale}`);
      }
      check(`${tag}: no page errors`, !errors.length, errors.join(' | '));
      await browser.close();
    }
    // ---- reduce ----
    {
      const { browser, page } = await setup({ theme, width: w, height: h, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' });
      await prime(page);
      await focusCard(page);
      const early = await read(page);
      await page.waitForTimeout(450);
      const s = await read(page);
      check(`${tag} reduce: no growth or lift`, near(s.scale, 1) && s.y === 0, `scale ${s.scale} y ${s.y}`);
      check(`${tag} reduce: nothing dims`, s.neighbour === 1 && !s.hasSelected, String(s.neighbour));
      check(`${tag} reduce: no sheen`, (await page.evaluate(() => window.__sheens || 0)) === 0);
      if (theme === 'orbit') check(`${tag} reduce: the strip fades in (opacity only)`, s.info.opacity === 1 && s.info.shown && early.info.opacity < 1 && !/transform/.test(s.info.prop), `${early.info.opacity} → ${s.info.opacity}, ${s.info.prop}`);
      await browser.close();
    }
    // ---- none ----
    {
      const { browser, page } = await setup({ theme, width: w, height: h, hasTouch: phone, isMobile: phone });
      await page.evaluate(() => (document.documentElement.dataset.motion = 'none'));
      await prime(page);
      await focusCard(page);
      await page.waitForTimeout(40);
      // Read on a painted frame after the focus (the near-zero transition starts with the next style update).
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const s = await read(page);
      check(`${tag} none: the art is there at once`, s.artDur.split(',').every((d) => parseFloat(d) <= 0.0001), s.artDur);
      check(`${tag} none: nothing dims, no sheen`, s.neighbour === 1 && (await page.evaluate(() => window.__sheens || 0)) === 0);
      if (theme === 'orbit') check(`${tag} none: the strip shows at once`, s.info.opacity === 1 && s.info.shown, JSON.stringify(s.info));
      await browser.close();
    }
  }
}
process.exit(failed() ? 1 : 0);
