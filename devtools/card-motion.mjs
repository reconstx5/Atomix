import { open, go, check, failed } from './lib.mjs';
// Titles with a preview clip play it instead (devtools/card-clip.mjs); here every title says it has none, so the
// still-frame flip shows.
const run = async (opts) => {
  const o = await open(opts);
  await o.context.route(/\/api\/items\/\d+\/previews(\?|$)/, async (route) => {
    const r = await route.fetch();
    await route.fulfill({ response: r, json: { ...(await r.json()), clip: false, clipUrl: null } });
  });
  await go(o.page, '#/library/1');
  await o.page.waitForSelector('.library-view a.card', { timeout: 15000 });
  await o.page.waitForTimeout(500);
  return o;
};
{
  const { browser, page, errors } = await run({});
  const card = page.locator('.library-view a.card').first();
  await card.hover();
  await page.waitForTimeout(400);
  check('nothing moves before the card is rested on', !(await page.$('.card-flip')));
  await page.waitForTimeout(1300);
  const info = await page.evaluate(() => {
    const o = document.querySelector('.card-flip.is-on');
    const on = o?.querySelector('i.on');
    return o && { bg: on?.style.backgroundImage, size: on?.style.backgroundSize, inCard: Boolean(o.closest('a.card')) };
  });
  check('a rested card flips through its own pictures', Boolean(info?.bg?.includes('/previews/')), JSON.stringify(info));
  const seen = new Set();
  for (let i = 0; i < 6; i++) { seen.add(await page.evaluate(() => document.querySelector('.card-flip i.on')?.style.backgroundPosition)); await page.waitForTimeout(650); }
  check('the pictures change', seen.size >= 3, [...seen].join(' | '));
  await page.waitForTimeout(3500);
  check('after one pass it goes back to the poster', !(await page.$('.card-flip')));
  await page.mouse.move(5, 5);
  check('no page errors', !errors.length, errors.join(' | '));
  await browser.close();
}
{
  const { browser, page } = await run({ reducedMotion: 'reduce' });
  await page.locator('.library-view a.card').first().hover();
  await page.waitForTimeout(2200);
  check('reduced motion: the card stays still', !(await page.$('.card-flip')));
  await browser.close();
}
{
  const { browser, page } = await run({});
  await page.locator('.library-view a.card').first().hover();
  await page.waitForTimeout(1600);
  await page.mouse.move(3, 400);
  await page.waitForTimeout(500);
  check('moving away stops it at once', !(await page.$('.card-flip')));
  await browser.close();
}
process.exit(failed() ? 1 : 0);
