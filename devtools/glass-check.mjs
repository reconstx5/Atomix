// Glass setting (visual refresh B1). `node devtools/glass-check.mjs`  (dev server up)
// Orbit at 1366×768: the menu's background alpha and blur follow the profile's Glass choice (Clear ≤ .3 alpha + blur,
// Tinted .5–.7 + blur, Solid ≥ .9 + no blur); the Details panel never goes below .66; at 1920×1080 with no choice the
// page is Solid; a profile saved with reduceEffects: true shows "Solid" chosen in Settings; nothing inside a row or grid
// has a backdrop-filter at rest; every theme sets html[data-glass] and offers the three choices in Settings.
import { open, go, check, failed } from './lib.mjs';

const THEMES = ['arctic', 'arctic-side', 'daylight', 'harbour', 'midnight', 'obsidian', 'orbit'];
const probe = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
  const parts = m ? m[1].split(/[ ,/]+/).filter(Boolean).map(Number) : [];
  return { alpha: parts.length > 3 ? parts[3] : parts.length ? 1 : 0, blur: cs.backdropFilter || cs.webkitBackdropFilter || 'none', glass: document.documentElement.dataset.glass };
}, sel);
const setPrefs = (ctx, prefs) => ctx.request.patch('http://localhost:8787/api/me', { data: { prefs } });

const { browser, context, page } = await open({ width: 1366, height: 768, theme: 'orbit' });
const want = { clear: [0, 0.3, true], tinted: [0.5, 0.7, true], solid: [0.9, 1, false] };
for (const [mode, [lo, hi, blurred]] of Object.entries(want)) {
  await setPrefs(context, { glass: mode, reduceEffects: null });
  await page.goto('about:blank'); // a fresh load picks up the new prefs
  await go(page, '#/');
  const m = await probe(page, '.orbit-menu');
  check(`orbit ${mode}: html[data-glass]`, m?.glass === mode, m?.glass);
  check(`orbit ${mode}: menu alpha ${lo}–${hi}`, m && m.alpha >= lo && m.alpha <= hi, String(m?.alpha));
  check(`orbit ${mode}: menu ${blurred ? 'blurred' : 'not blurred'}`, m && (m.blur !== 'none') === blurred, m?.blur);
  await go(page, '#/item/1');
  const d = await probe(page, '.details-panel, .panel');
  check(`orbit ${mode}: details panel alpha >= .66`, d && d.alpha >= 0.659, String(d?.alpha));
  await go(page, '#/');
  const rowGlass = await page.evaluate(() => [...document.querySelectorAll('.row *, .grid *')].filter((e) => { const b = getComputedStyle(e).backdropFilter; return b && b !== 'none'; }).map((e) => e.className).slice(0, 3));
  check(`orbit ${mode}: no glass on scrolling rows`, rowGlass.length === 0, rowGlass.join(' | '));
}
await browser.close();

{ // TV default, and an old Reduce effects choice
  const tv = await open({ width: 1920, height: 1080, theme: 'orbit' });
  await setPrefs(tv.context, { glass: null, reduceEffects: null });
  await go(tv.page, '#/');
  check('orbit TV with no choice: solid', (await probe(tv.page, '.orbit-menu'))?.glass === 'solid');
  await tv.browser.close();
  const old = await open({ width: 1366, height: 768, theme: 'midnight' });
  await setPrefs(old.context, { glass: null, reduceEffects: true });
  await go(old.page, '#/settings');
  const chosen = await old.page.evaluate(() => document.querySelector('[role="radiogroup"][aria-label="Glass"] [aria-checked="true"]')?.textContent.trim());
  check('reduceEffects: true shows Solid chosen', /^Solid/.test(chosen || ''), String(chosen));
  check('reduceEffects: true still sets html.reduce-effects', await old.page.evaluate(() => document.documentElement.classList.contains('reduce-effects')));
  await setPrefs(old.context, { reduceEffects: null });
  await old.browser.close();
}

for (const theme of THEMES) {
  const t = await open({ width: 1366, height: 768, theme });
  await setPrefs(t.context, { glass: null });
  await go(t.page, '#/settings');
  const n = await t.page.evaluate(() => document.querySelectorAll('[role="radiogroup"][aria-label="Glass"] [role="radio"]').length);
  check(`${theme}: Settings offers three Glass choices`, n === 3, String(n));
  check(`${theme}: html[data-glass] set`, Boolean(await t.page.evaluate(() => document.documentElement.dataset.glass)));
  await t.browser.close();
}
{
  const r = await open({ width: 1366, height: 768, theme: 'orbit' });
  await setPrefs(r.context, { glass: null, reduceEffects: null });
  await r.browser.close();
}
console.log(failed() ? `${failed()} FAIL` : 'ALL PASS');
process.exit(failed() ? 1 : 0);
