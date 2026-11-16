// Even volume: a song plays through a gain that levels it; the profile setting turns it off.
import { open, go, check, failed, BASE } from './lib.mjs';
const { browser, context, page, errors } = await open();
await page.addInitScript(() => {
  window.__gains = [];
  const orig = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function (...a) {
    const g = orig.apply(this, a);
    window.__gains.push(g);
    return g;
  };
});
const lib = (await (await context.request.get(`${BASE}/api/libraries`)).json()).find((l) => l.type === 'music');
const tracks = (await (await context.request.get(`${BASE}/api/libraries/${lib.id}/items?view=tracks`)).json()).items;
const loud = tracks.find((t) => t.title === 'Loud One');
await go(page, '#/');
await page.click('body'); // a user gesture, as pressing Play would be
const play = (id) => page.evaluate(async (id) => {
  const { music } = await import('/js/music.js');
  const { item } = await (await fetch(`/api/items/${id}`)).json();
  await music.playTracks([item], 0);
}, id);
await play(loud.id);
await page.waitForFunction(() => !document.querySelector('audio')?.paused || window.__gains.length, null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
const g = await page.evaluate(() => window.__gains.map((x) => x.gain.value));
check('a measured song plays through the level gain', g.length === 1 && Math.abs(g[0] - 10 ** (6 / 20)) < 0.01, JSON.stringify(g));
await context.request.patch(`${BASE}/api/me`, { data: { prefs: { levelVolume: false } } });
await page.evaluate(async () => {
  const { music } = await import('/js/music.js');
  const me = await (await fetch('/api/me')).json();
  music.setProfile(me.profile);
});
const g2 = await page.evaluate(() => window.__gains.map((x) => x.gain.value));
check('turning it off plays songs as they are', g2[0] === 1, JSON.stringify(g2));
await context.request.patch(`${BASE}/api/me`, { data: { prefs: { levelVolume: true } } });
check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
