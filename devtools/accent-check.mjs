// Accent for every theme, clamped (visual refresh A6). `node devtools/accent-check.mjs`  (THEMES=midnight narrows it)
// In Midnight, Daylight and Orbit, Settings → Appearance has the accent picker (10 named swatches, "Theme default" and a
// "Custom…" hex field). For each custom colour #ffff00, #101010 and #3a7bff typed into the field (Enter):
//   1. the accent-painted controls repaint to the clamped colour (public/js/tint.js clampAccent for the theme's
//      colour scheme): a primary button (.btn-primary, not in Orbit, whose buttons are glass) and the checked toggle's
//      track (every theme);
//   2. --accent-text on --accent, as painted on the page, reaches APCA Lc 60;
//   3. the keyboard focus ring on a swatch and on the field's Apply button is >= 3:1 (WCAG) on --app-bg;
//   4. each swatch shows its own colour clamped for this theme.
// Also: invalid input says exactly "Enter a colour like #3a7bff." and saves nothing; arrows move between swatches;
// a swatch gets aria-pressed; "Theme default" clears the accent (the controls go back to the theme's colour).
// PICTURES=<dir>: no checks, pictures of the picker and a primary button (theme default, #3a7bff, #ffff00) per theme.
// Plan A Task 6 RED (BASE 7474dc9): devtools/out/visual-a/task-6/red.txt.
import fs from 'node:fs';
import path from 'node:path';
import { open, go, check, failed } from './lib.mjs';
import { apcaContrast, wcagRatio } from '../src/themes/apca.js';
import { clampAccent } from '../public/js/tint.js';

const THEMES = (process.env.THEMES || 'midnight,daylight,orbit').split(',');
const SCHEME = { daylight: 'light' };
const COLOURS = ['#ffff00', '#101010', '#3a7bff'];
const MESSAGE = 'Enter a colour like #3a7bff.';
const PICTURES = process.env.PICTURES;
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const near = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= 2);
const C = ([r, g, b]) => ({ r, g, b });

/** In the page: a probe primary button (and the real checked toggle track), and what they paint. */
const paint = (page) => page.evaluate(() => {
  const rgb = (c) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const x = cv.getContext('2d'); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1);
    return [...x.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  let btn = document.getElementById('__accent-probe');
  if (!btn) {
    btn = Object.assign(document.createElement('button'), { id: '__accent-probe', className: 'btn btn-primary', type: 'button', tabIndex: -1, textContent: 'Play' });
    document.querySelector('main').append(btn);
  }
  const ink = document.createElement('i');
  ink.style.cssText = 'color: var(--accent-text); background: var(--accent)';
  document.body.append(ink);
  const out = {
    btn: rgb(getComputedStyle(btn).backgroundColor), btnInk: rgb(getComputedStyle(btn).color),
    accent: rgb(getComputedStyle(ink).backgroundColor), accentText: rgb(getComputedStyle(ink).color),
  };
  ink.remove();
  const track = [...document.querySelectorAll('.toggle input:checked + .toggle-track')][0];
  out.track = track ? rgb(getComputedStyle(track).backgroundColor) : null;
  const sw = [...document.querySelectorAll('.accent-swatch')].map((b) => ({ name: b.getAttribute('aria-label'), hex: b.dataset.hex, bg: rgb(getComputedStyle(b).backgroundColor), pressed: b.getAttribute('aria-pressed') }));
  out.swatches = sw;
  out.def = document.querySelector('.accent-default')?.getAttribute('aria-pressed') ?? null;
  out.error = document.querySelector('.accent-error')?.textContent ?? null;
  out.inline = document.documentElement.style.getPropertyValue('--a-9');
  return out;
});

/** Keyboard-focus `sel` (an arrow press first, so it is :focus-visible) and read its ring against --app-bg. */
async function ring(page, sel) {
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.focus({ preventScroll: false });
    const rgb = (c) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      const x = cv.getContext('2d'); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1);
      return [...x.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const p = document.createElement('i'); p.style.color = 'var(--app-bg)'; document.body.append(p);
    const bg = rgb(getComputedStyle(p).color); p.remove();
    const cs = getComputedStyle(el);
    return { fv: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: rgb(cs.outlineColor), bg };
  }, sel);
}

async function enter(page, value) {
  const f = page.locator('.accent-hex');
  // The app may still move the first focus just after a page loads; type only once the field really holds the text.
  for (let i = 0; i < 10; i++) {
    await f.fill(value);
    if ((await f.inputValue()) === value && (await f.evaluate((el) => el === document.activeElement))) break;
    await page.waitForTimeout(300);
  }
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/me') && r.request().method() === 'PATCH', { timeout: 5000 }).catch(() => null);
  await f.press('Enter');
  if (/^#/.test(value) && !(await saved)) console.log(`  (no save seen for ${value}: field "${await f.inputValue()}", ${await page.locator('.accent-hex').count()} fields, error "${await page.locator('.accent-error').textContent()}")`);
  await page.waitForTimeout(1200); // Orbit's --tint is a registered property that eases to a new colour
}

async function pictures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const theme of THEMES) {
    const { browser, context, page } = await open({ width: 1366, height: 900, theme });
    for (const [tag, accent] of [['default', null], ['3a7bff', '#3a7bff'], ['ffff00', '#ffff00']]) {
      await context.request.patch(`${process.env.BASE || 'http://localhost:8787'}/api/me`, { data: { prefs: { accent } } });
      await page.goto('about:blank'); // a new load, so the app reads the new prefs
      await go(page, '#/settings');
      await page.evaluate(() => { // the probe button next to the picker, so one picture shows both
        const field = document.querySelector('.accent-picker') || [...document.querySelectorAll('.field')].find((f) => /Accent/.test(f.textContent))?.parentElement;
        field.id = '__accent-field';
        const b = Object.assign(document.createElement('button'), { className: 'btn btn-primary', type: 'button', textContent: 'Play' });
        b.style.marginTop = '12px';
        field.after(b);
        field.scrollIntoView({ block: 'center' });
      });
      await page.waitForTimeout(300);
      const box = await page.evaluate(() => {
        const a = document.getElementById('__accent-field').getBoundingClientRect(), b = document.getElementById('__accent-field').nextElementSibling.getBoundingClientRect();
        return { x: Math.max(0, Math.min(a.left, b.left) - 16), y: Math.max(0, a.top - 40), width: Math.min(1366, Math.max(a.right, b.right) - Math.min(a.left, b.left) + 32), height: b.bottom - a.top + 56 };
      });
      await page.screenshot({ path: path.join(dir, `${theme}-${tag}.png`), clip: box });
    }
    await context.request.patch(`${process.env.BASE || 'http://localhost:8787'}/api/me`, { data: { prefs: { accent: null } } });
    await browser.close();
  }
  console.log(`pictures in ${dir}`);
}

if (PICTURES) {
  await pictures(PICTURES);
  process.exit(0);
}

for (const theme of THEMES) {
  const scheme = SCHEME[theme] || 'dark';
  const { browser, context, page, errors } = await open({ width: 1366, height: 900, theme });
  const BASE = process.env.BASE || 'http://localhost:8787';
  await context.request.patch(`${BASE}/api/me`, { data: { prefs: { accent: null } } });
  await go(page, '#/settings');
  const has = await page.locator('.accent-picker').count();
  check(`${theme}: Settings → Appearance shows the accent picker`, has === 1);
  if (!has) { await browser.close(); continue; }
  const base = await paint(page);
  check(`${theme}: 10 named swatches`, base.swatches.length === 10 && base.swatches.every((s) => s.name && s.hex), base.swatches.map((s) => s.name).join(','));
  check(`${theme}: "Theme default" is pressed with no accent`, base.def === 'true', base.def);

  for (const hex of COLOURS) {
    await enter(page, hex);
    const p = await paint(page);
    const want = rgbOf(clampAccent(hex, scheme));
    check(`${theme} ${hex}: the checked toggle repaints to ${clampAccent(hex, scheme)}`, near(p.track, want), `track ${p.track}`);
    if (theme !== 'orbit') check(`${theme} ${hex}: the primary button repaints`, near(p.btn, want), `btn ${p.btn}`);
    const lc = Math.abs(apcaContrast(C(p.accentText), C(p.accent)));
    check(`${theme} ${hex}: --accent-text on --accent Lc >= 60`, lc >= 60, `Lc ${lc.toFixed(1)} (${p.accentText} on ${p.accent})`);
    if (theme !== 'orbit') {
      const b = Math.abs(apcaContrast(C(p.btnInk), C(p.btn)));
      check(`${theme} ${hex}: button text Lc >= 60`, b >= 60, `Lc ${b.toFixed(1)}`);
    }
    const sw = p.swatches.filter((s) => !near(s.bg, rgbOf(clampAccent(s.hex, scheme))));
    check(`${theme} ${hex}: each swatch shows its colour clamped for the theme`, sw.length === 0, sw.map((s) => s.name).join(','));
    // A typed colour presses the swatch with that colour (#3a7bff is Blue), else none; never "Theme default".
    check(`${theme} ${hex}: the typed colour presses only its own swatch, if any`, p.def === 'false' && p.swatches.every((s) => s.pressed === String(s.hex === hex)), p.swatches.filter((s) => s.pressed === 'true').map((s) => s.name).join(','));
    for (const [what, sel] of [['swatch', '.accent-swatch'], ['Apply', '.accent-apply']]) {
      const r = await ring(page, sel);
      const ratio = r && wcagRatio(C(r.color), C(r.bg));
      check(`${theme} ${hex}: focus ring on ${what} >= 3:1`, r && r.fv && r.style !== 'none' && r.width >= 3 && ratio >= 3, r ? `${r.style} ${r.width}px ${r.color} on ${r.bg} = ${ratio.toFixed(2)}:1` : 'missing');
    }
  }

  // Invalid input: the sentence, nothing saved.
  const before = await paint(page);
  await enter(page, 'blue');
  const bad = await paint(page);
  check(`${theme}: invalid input says "${MESSAGE}"`, bad.error === MESSAGE, JSON.stringify(bad.error));
  check(`${theme}: invalid input saves nothing`, near(bad.track, before.track));

  // Arrows move along the swatches (spatial navigation).
  await ring(page, '.accent-swatch');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const second = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check(`${theme}: Right moves from the first swatch to the second`, second === base.swatches[1].name, second);

  // A swatch: pressed, and painted.
  await page.locator('.accent-swatch[aria-label="Blue"]').click();
  await page.waitForTimeout(700);
  const blue = await paint(page);
  check(`${theme}: the Blue swatch is pressed after choosing it`, blue.swatches.find((s) => s.name === 'Blue')?.pressed === 'true' && blue.def === 'false');
  check(`${theme}: the error goes once a colour is chosen`, !blue.error, blue.error);

  // Theme default: back to the theme's own colour.
  await page.locator('.accent-default').click();
  await page.waitForTimeout(700);
  const back = await paint(page);
  check(`${theme}: "Theme default" brings the theme colour back`, near(back.track, base.track) && back.def === 'true' && !back.inline, `track ${back.track} vs ${base.track}, inline --a-9 "${back.inline}"`);
  check(`${theme}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}
console.log(`\n${failed()} failed`);
process.exit(failed() ? 1 : 0);
