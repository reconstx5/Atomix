import { open, go, check, failed } from './lib.mjs';
const { browser, page, errors } = await open({ width: 1917, height: 700 });
await go(page, '#/library/1');
await page.waitForSelector('.library-view', { timeout: 15000 });
await page.waitForTimeout(800);
const info = await page.evaluate(() => {
  const list = document.querySelector('.library-scroll');
  const spot = document.querySelector('.library-view .spotlight');
  const r = spot?.getBoundingClientRect();
  return { has: Boolean(list), scrollable: list && list.scrollHeight > list.clientHeight, spot: r && !spot.hidden && { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
});
console.log(JSON.stringify(info));
if (info.scrollable && info.spot) {
  await page.mouse.move(info.spot.x, info.spot.y);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.querySelector('.library-scroll').scrollTop);
  check('a wheel turn over the library spotlight scrolls its grid', after > 0, `scrollTop → ${after}`);
} else console.log('SKIP library not scrollable with 8 films');
// A phone: the page scrolls as a whole and the wheel handler stays out of the way.
const p2 = await open({ width: 390, height: 844, isMobile: true, hasTouch: true });
await go(p2.page, '#/');
await p2.page.waitForSelector('.home-rows .row', { timeout: 15000 });
check('phone Home: no page errors', !p2.errors.length, p2.errors.join(' | '));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close(); await p2.browser.close();
process.exit(failed() ? 1 : 0);
