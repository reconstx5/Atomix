// Pinned libraries (visual refresh B3). `node devtools/pinned-check.mjs`  (dev server up; libraries 1 Movies, 2 TV Shows, 3 Music)
// With pinnedLibraries [2, 1]: Orbit's rail, the phone dock and Arctic Side's list show TV Shows then Movies, Music only
// under "More libraries"; a pinned id that doesn't exist is ignored; no pins = every library in the server's order and no
// More entry; Settings → Menu "Move up" reorders the rail at once; a library entry's menu (right click / long press /
// menu key) can Unpin it.
import { open, go, check, failed, BASE } from './lib.mjs';

const API = `${BASE}/api/me`;
const libsIn = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((a) => a.offsetParent || getComputedStyle(a).display !== 'none').map((a) => a.dataset.nav).filter((n) => /^lib-/.test(n)), sel);
const hasMore = (page) => page.evaluate(() => Boolean(document.querySelector('#nav [data-nav="more-libs"]')));
async function at(theme, size, pinned, fn) {
  const s = await open({ width: size[0], height: size[1], theme, isMobile: size[0] < 600, hasTouch: size[0] < 600 });
  await s.context.request.patch(API, { data: { prefs: { pinnedLibraries: pinned } } });
  await s.page.goto('about:blank');
  await go(s.page, '#/');
  try { await fn(s.page); } finally { await s.context.request.patch(API, { data: { prefs: { pinnedLibraries: null } } }); await s.browser.close(); }
}

await at('orbit', [1366, 768], [2, 1], async (page) => {
  const libs = await libsIn(page, '.orbit-list .nav-link');
  check('orbit rail: pinned in order, Music not listed', libs.join() === 'lib-2,lib-1', libs.join());
  check('orbit rail: a More libraries entry', await hasMore(page));
});
await at('orbit', [390, 844], [2, 1], async (page) => {
  const libs = await libsIn(page, '.orbit-dock .nav-link');
  check('orbit phone dock: pinned in order', libs.join() === 'lib-2,lib-1', libs.join());
});
await at('arctic-side', [1366, 768], [2, 1], async (page) => {
  const libs = await libsIn(page, '.nav-links .nav-link');
  check('arctic side: pinned in order', libs.join() === 'lib-2,lib-1', libs.join());
  check('arctic side: a More libraries entry', await hasMore(page));
  await page.click('#nav [data-nav="more-libs"]');
  await page.waitForTimeout(400);
  const inSheet = await page.evaluate(() => [...document.querySelectorAll('dialog[open] a')].map((a) => a.getAttribute('href')));
  check('arctic side: More lists Music', inSheet.includes('#/library/3'), inSheet.join());
});
await at('midnight', [1366, 768], [99, 2], async (page) => {
  const libs = await libsIn(page, '.nav-links .nav-link');
  check('a pinned id that does not exist is ignored', libs.join() === 'lib-2', libs.join());
});
await at('orbit', [1366, 768], null, async (page) => {
  const libs = await libsIn(page, '.orbit-list .nav-link');
  check('no pins: every library as before', libs.join() === 'lib-1,lib-3,lib-2', libs.join());
  check('no pins: no More libraries entry', !(await hasMore(page)));
});
await at('orbit', [1366, 768], [1, 2], async (page) => {
  await go(page, '#/settings');
  const up = page.locator('.menu-libraries [data-library="2"] button', { hasText: 'Move up' });
  await up.click();
  await page.waitForTimeout(600);
  const libs = await libsIn(page, '.orbit-list .nav-link');
  check('Settings Move up reorders the rail at once', libs.join() === 'lib-2,lib-1', libs.join());
  await page.dispatchEvent('.orbit-list [data-nav="lib-1"]', 'contextmenu');
  await page.waitForTimeout(400);
  const items = await page.evaluate(() => [...document.querySelectorAll('dialog[open] .sheet-item')].map((b) => b.textContent.trim()));
  // lib-1 is last now: Unpin and Move up, no Move down at the end.
  check('a library entry menu offers Unpin and Move up (and no Move down for the last)', ['Unpin', 'Move up'].every((t) => items.includes(t)) && !items.includes('Move down'), items.join(' | '));
  await page.locator('dialog[open] .sheet-item', { hasText: 'Unpin' }).click();
  await page.waitForTimeout(600);
  const after = await libsIn(page, '.orbit-list .nav-link');
  // Final review I4: focus comes back to the menu, not the page.
  const inNav = await page.evaluate(() => Boolean(document.activeElement?.closest('#nav')));
  check('after a change from the entry menu, focus is back in the menu', inNav, await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
  check('Unpin from the entry menu takes it out of the rail', after.join() === 'lib-2', after.join());
});
console.log(failed() ? `${failed()} FAIL` : 'ALL PASS');
process.exit(failed() ? 1 : 0);
