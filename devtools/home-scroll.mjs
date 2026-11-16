import { open, go, check, failed } from './lib.mjs';
const { browser, page, errors } = await open();
await go(page, '#/');
await page.waitForSelector('.home-rows .row', { timeout: 15000 });
const info = await page.evaluate(() => {
  const rows = document.querySelector('.home-rows');
  const spot = document.querySelector('.home-view .spotlight');
  const r = spot?.getBoundingClientRect();
  return { scrollable: rows.scrollHeight > rows.clientHeight, top: rows.scrollTop, spot: r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }, rowsTop: rows.getBoundingClientRect().top, layout: document.body.dataset.layout };
});
console.log(JSON.stringify(info));
await page.mouse.move(info.spot.x, info.spot.y);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(800);
const after = await page.evaluate(() => document.querySelector('.home-rows').scrollTop);
check('a wheel turn over the spotlight scrolls Home\'s rows', after > info.top, `scrollTop ${info.top} → ${after}`);
check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
