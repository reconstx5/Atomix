// Shared helpers for the cloud browser checks.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
export const BASE = process.env.BASE || 'http://localhost:8787';
const PASSWORDS = { dallas: 'atomix-dev-1', guest: 'atomix-dev-guest' }; // guest and its Kids profile: item-users.mjs
/** Sign in as `user` (dallas, or guest from item-users.mjs) and, when `profile` is named, pick that profile. */
export async function open({ width = 1917, height = 992, reducedMotion = 'no-preference', hasTouch = false, isMobile = false, theme = 'orbit', serviceWorkers = 'allow', user = 'dallas', profile } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, hasTouch, isMobile, serviceWorkers });
  const r = await context.request.post(`${BASE}/api/auth/login`, { data: { username: user, password: PASSWORDS[user] } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  if (profile) await selectProfile(context, profile);
  await context.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: false } } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { browser, context, page, errors };
}
/** Pick the signed-in user's profile called `name` for this browser context. */
export async function selectProfile(context, name) {
  const list = await (await context.request.get(`${BASE}/api/profiles`)).json();
  const p = list.find((x) => x.name === name);
  if (!p) throw new Error(`No profile called ${name} (run devtools/item-users.mjs).`);
  const r = await context.request.post(`${BASE}/api/profiles/${p.id}/select`, { data: {} });
  if (!r.ok()) throw new Error(`select ${name}: ${r.status()}`);
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
