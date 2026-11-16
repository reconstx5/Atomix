// Shared helpers for the cloud browser checks.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
export const BASE = process.env.BASE || 'http://localhost:8787';
export async function open({ width = 1917, height = 992, reducedMotion = 'no-preference', hasTouch = false, isMobile = false, theme = 'orbit' } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, hasTouch, isMobile });
  const r = await context.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  await context.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: false } } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { browser, context, page, errors };
}
export async function go(page, hash) {
  await page.goto(`${BASE}/${hash}`);
  await page.keyboard.press('Escape').catch(() => {}); // end the splash
  await page.waitForFunction(() => !document.querySelector('#splash:not([hidden])') || getComputedStyle(document.querySelector('#splash')).opacity === '0', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
}
let fails = 0;
export function check(name, ok, detail = '') {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
export const failed = () => fails;
