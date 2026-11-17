// Made-up title pages for the title-page checks (compare.mjs, item-fn.mjs): GET /api/items/<900001–900099> is answered
// from devtools/fixtures/items/<id>.json (written by build.mjs there), and their pictures (/fake-art/…) are small SVGs.
// /fake-art/logo-404.svg answers 404 (a logo that fails to load). Every other request goes to the server as usual.
// Use a context with serviceWorkers: 'block' (the app's service worker would answer past page.route).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'items');

export const FIXTURE_PAGES = [
  '#/item/900001', '#/item/900002', '#/item/900003', '#/item/900004', '#/item/900005',
  '#/item/900010', '#/item/900010?season=900013', '#/item/900014', '#/item/900015', '#/item/900020',
  '#/item/900030', '#/item/900030?track=900305', '#/item/900031',
  '#/item/900040', '#/item/900041', '#/item/900042',
];

const svg = (w, h, hue, text = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="hsl(${hue} 55% 38%)"/><circle cx="50%" cy="42%" r="${Math.min(w, h) / 4}" fill="hsl(${(hue + 40) % 360} 70% 62%)"/>${text}</svg>`;
const logo = (hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240" viewBox="0 0 800 240"><rect x="10" y="60" width="780" height="120" rx="60" fill="hsl(${hue} 80% 70%)"/></svg>`;

/** Answer the fixture titles and their pictures on `page` (or a context). `delay(id)` → ms to hold an answer (optional). */
export async function routeItems(page, { delay } = {}) {
  await page.route(/\/fake-art\/(poster|backdrop|logo)-(\d+)\.svg/, (route) => {
    const [, type, id] = /(poster|backdrop|logo)-(\d+)/.exec(route.request().url());
    if (type === 'logo' && id === '404') return route.fulfill({ status: 404, body: '' });
    const hue = (Number(id) * 37) % 360;
    const body = type === 'poster' ? svg(300, 450, hue) : type === 'backdrop' ? svg(1920, 1080, hue) : logo(hue);
    return route.fulfill({ contentType: 'image/svg+xml', body });
  });
  await page.route(/\/api\/items\/(9000\d\d)(\?|$)/, async (route) => {
    const id = /\/api\/items\/(\d+)/.exec(route.request().url())[1];
    if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } });
    const file = path.join(DIR, `${id}.json`);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, json: { error: 'Not found' } });
    const ms = delay?.(Number(id)) || 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return route.fulfill({ json: JSON.parse(fs.readFileSync(file, 'utf8')) });
  });
  // Writes to a made-up title (Mark watched, Refresh info, ratings…) are answered here and never reach the server.
  await page.route(/\/api\/items\/9000\d\d\/.+/, (route) => (/\/image\//.test(route.request().url()) ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ json: { ok: true } })));
}
