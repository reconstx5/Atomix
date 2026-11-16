// Your own channels: the channel plays in the Live TV player.
import { open, go, check, failed, BASE } from './lib.mjs';
const { browser, context, page, errors } = await open();
const chans = await (await context.request.get(`${BASE}/api/live/channels`)).json();
const ch = chans.find((c) => c.name === 'Movie Night');
if (!ch) { console.log('SKIP no channel'); process.exit(0); }
await go(page, `#/live/play/${ch.id}`);
const ok = await page.waitForFunction(() => document.querySelector('video')?.currentTime > 2, null, { timeout: 45000 }).then(() => true, () => false);
const st = await page.evaluate(() => ({ t: document.querySelector('video')?.currentTime, err: document.querySelector('.player-error, .player [role="alert"]')?.textContent || null, title: document.querySelector('.player-title, .player-top h1')?.textContent || null }));
check('a channel made from the library plays live', ok, JSON.stringify(st));
check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
