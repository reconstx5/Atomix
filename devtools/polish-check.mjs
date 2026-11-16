// Shared polish pieces (visual refresh B4). `node devtools/polish-check.mjs`  (dev server up)
// THEMES=midnight,orbit narrows it. The dev library has no logos or HDR files, so the item API is rewritten in the page
// (page.route): film 1 gets a logo (the app icon, held back 5 s: the splash and first render can take 2 s) and 4K Dolby Vision / Atmos / 5.1 / subtitles.
//  1. Title page: the typed title shows in the logo box while the logo loads; no layout shift (CLS 0) when it arrives.
//  2. Chips: 4K, Dolby Vision, Atmos, 5.1, Subtitles, outlined.
//  3. Progress track (not Orbit, whose floating track is its own design): 3 px (4 px on TV), flush with the art's bottom.
//  4. Watched mark: top-right, an opaque disc, no blur; count badges top-left.
//  5. Skeletons: a page answering in 600 ms shows neither skeleton nor spinner; one taking 2.5 s shows a skeleton after
//     about 1 s and never the spinner; no shimmer under reduced motion or at TV size.
import { open, go, check, failed, BASE } from './lib.mjs';
import { parseColor } from '../src/themes/apca.js';

const THEMES = (process.env.THEMES || 'midnight,daylight,arctic,orbit').split(',');
const css = (await import('node:fs')).readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
// Final review I1: TV browsers without clamp() keep a height for the logo box.
check('the logo box has a plain height before its clamp()', /\.logo-box \{[^}]*height: \d+px;[^}]*height: clamp\(/.test(css));
const media = { resolution: '4K', width: 3840, height: 2160, videoCodec: 'hevc', hdr: true, hdrFormat: 'Dolby Vision', atmos: true, bitDepth: 10, container: 'matroska', bitrate: 1, audio: [{ index: 0, codec: 'eac3', channels: 6, default: true }], subtitles: 2 };

async function fakeItem(page, { logoDelay = 5000, apiDelay = 0, id = 1 } = {}) {
  await page.route(new RegExp(`/api/items/${id}(\\?.*)?$`), async (route) => {
    if (apiDelay) await new Promise((r) => setTimeout(r, apiDelay));
    const res = await route.fetch();
    const body = await res.json();
    const it = body.item || body;
    it.logo = '/img/icon-512.png?logo=1';
    it.media = media;
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/icon-512\.png\?.*logo/, async (route) => {
    await new Promise((r) => setTimeout(r, logoDelay));
    await route.continue();
  });
}

for (const theme of THEMES) {
  const s = await open({ width: 1366, height: 768, theme });
  const { page } = s;
  await fakeItem(page);
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto('about:blank');
  await go(page, '#/item/1');
  const before = await page.evaluate(() => {
    const t = document.querySelector('.detail-title');
    const box = document.querySelector('.logo-box');
    return { typed: t && !t.classList.contains('visually-hidden') && t.getBoundingClientRect().height > 0, box: box?.getBoundingClientRect().height };
  });
  check(`${theme}: the typed title shows while the logo loads`, before.typed && before.box > 0, JSON.stringify(before));
  await page.waitForTimeout(5200);
  const after = await page.evaluate(() => ({ cls: window.__cls, box: document.querySelector('.logo-box')?.getBoundingClientRect().height, img: document.querySelector('.logo-box img:not([hidden])')?.getBoundingClientRect().height || 0 }));
  check(`${theme}: the logo arrives without a layout shift`, after.cls < 0.001 && Math.abs(after.box - before.box) < 1 && after.img > 0, JSON.stringify(after));
  const chips = await page.evaluate(() => [...document.querySelectorAll('.media-chips li')].map((li) => [li.textContent.trim(), getComputedStyle(li).borderTopWidth, getComputedStyle(li).boxShadow]));
  const words = chips.map((c) => c[0]);
  check(`${theme}: media chips`, ['4K', 'Dolby Vision', 'Atmos', '5.1', 'Subtitles'].every((w) => words.includes(w)), words.join(', '));
  // an edge: a border, or Orbit's inset hairline
  check(`${theme}: chips are outlined`, chips.length && chips.every((c) => parseFloat(c[1]) >= 1 || /inset/.test(c[2])), chips.map((c) => c[1] + ' ' + c[2]).join(' | '));

  // Watched mark and count badge, drawn on a real card.
  await go(page, '#/');
  const marks = await page.evaluate(() => {
    const art = document.querySelector('.poster-card .card-art, .card .card-art');
    if (!art) return null;
    const w = Object.assign(document.createElement('span'), { className: 'badge badge-watched' });
    const n = Object.assign(document.createElement('span'), { className: 'badge', textContent: '3' });
    art.append(w);
    const a = art.getBoundingClientRect(), wr = w.getBoundingClientRect(), ws = getComputedStyle(w);
    w.remove(); art.append(n);
    const nr = n.getBoundingClientRect(); n.remove();
    const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); const p = m ? m[1].split(/[ ,/]+/).filter(Boolean) : []; return p.length > 3 ? Number(p[3]) : 1; };
    return { right: a.right - wr.right, top: wr.top - a.top, alpha: alpha(ws.backgroundColor), blur: ws.backdropFilter, round: ws.borderRadius, countLeft: nr.left - a.left };
  });
  check(`${theme}: watched mark top-right, opaque disc, no blur`, marks && marks.right < 16 && marks.top < 16 && marks.alpha >= 0.99 && (marks.blur === 'none' || !marks.blur), JSON.stringify(marks));
  check(`${theme}: count badges top-left`, marks && marks.countLeft < 16, String(marks?.countLeft));
  await s.browser.close();

  if (theme === 'orbit') {
    // Orbit keeps its own floating track (final review I2).
    const t = await open({ width: 1366, height: 768, theme });
    await go(t.page, '#/');
    const gap = await t.page.evaluate(() => { const b = document.querySelector('.card-art > .progress'); return b ? b.parentElement.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom : null; });
    check('orbit: its floating progress track stays', gap != null && gap > 2, String(gap));
    await t.browser.close();
  }
  // More contrast and OLED edges never cover the progress track (final review I3).
  for (const prefs of [{ contrast: 'more' }, ...(theme === 'daylight' ? [] : [{ oled: true }])]) {
    const t = await open({ width: 1366, height: 768, theme });
    await t.context.request.patch(`${BASE}/api/me`, { data: { prefs } });
    await go(t.page, '#/');
    await t.page.waitForTimeout(1500); // the splash fades
    // Paint order can't be hit-tested (the edge is a pointer-events: none ::after): compare the pixels at the middle of the track's
    // watched part with the fill colour (a 2 px inset edge would cover the middle row of a 3 px track).
    const spot = await t.page.evaluate(() => {
      const bar = [...document.querySelectorAll('.card-art > .progress')].find((b) => b.querySelector('span')?.getBoundingClientRect().width > 12);
      if (!bar) return null;
      const r = bar.querySelector('span').getBoundingClientRect();
      const c = getComputedStyle(bar.querySelector('span')).backgroundColor;
      return { x: Math.round(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2), fill: c };
    });
    let top = 'no track';
    if (spot) {
      const png = await t.page.screenshot({ clip: { x: spot.x, y: spot.y, width: 1, height: 1 } });
      const px = await t.page.evaluate(async (b64) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
        return [...x.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      }, png.toString('base64'));
      const f = parseColor(spot.fill) || {};
      const want = [f.r, f.g, f.b];
      top = px.every((v, i) => Math.abs(v - want[i]) <= 24) ? 'track' : `pixel ${px} vs fill ${want}`;
    }
    check(`${theme} ${Object.keys(prefs)[0]}: the progress track is on top of the card edge`, top === 'track', top);
    await t.context.request.patch(`${BASE}/api/me`, { data: { prefs: { contrast: null, oled: null } } });
    await t.browser.close();
  }

  if (theme !== 'orbit') for (const [w, h, want] of [[1366, 768, 3], [1920, 1080, 4]]) {
    const t = await open({ width: w, height: h, theme });
    await go(t.page, '#/');
    const p = await t.page.evaluate(() => {
      const bar = document.querySelector('.card-art > .progress');
      if (!bar) return null;
      const b = bar.getBoundingClientRect(), a = bar.parentElement.getBoundingClientRect();
      return { h: b.height, gap: a.bottom - b.bottom, left: b.left - a.left, right: a.right - b.right };
    });
    check(`${theme} ${w}: progress track ${want}px, flush`, p && Math.abs(p.h - want) < 0.5 && Math.abs(p.gap) <= 1 && p.left <= 1 && p.right <= 1, JSON.stringify(p));
    await t.browser.close();
  }
}

// Skeletons (one theme is enough: the loading state is shared).
for (const [delay, want] of [[600, false], [2500, true]]) {
  const s = await open({ width: 1366, height: 768, theme: 'midnight' });
  await go(s.page, '#/');
  await fakeItem(s.page, { apiDelay: delay, id: 2, logoDelay: 0 });
  await s.page.evaluate(() => {
    window.__seen = { skeleton: null, spinner: false };
    const t0 = performance.now();
    new MutationObserver(() => {
      if (document.querySelector('#main .spinner-wrap')) window.__seen.spinner = true;
      if (window.__seen.skeleton == null && document.querySelector('#main .skeleton')) window.__seen.skeleton = performance.now() - t0;
    }).observe(document.getElementById('main'), { childList: true, subtree: true });
    location.hash = '#/item/2';
  });
  await s.page.waitForTimeout(delay + 800);
  const seen = await s.page.evaluate(() => window.__seen);
  if (want) check(`a page taking ${delay} ms: a skeleton after about 1 s`, seen.skeleton != null && seen.skeleton >= 900 && seen.skeleton <= 1500, JSON.stringify(seen));
  else check(`a page taking ${delay} ms: no skeleton`, seen.skeleton == null, JSON.stringify(seen));
  if (want) {
    // Final review M8: screen readers hear "Loading" while it waits.
    await s.page.evaluate(() => (location.hash = '#/'));
    await s.page.waitForTimeout(1500);
    await fakeItem(s.page, { apiDelay: 3000, id: 3, logoDelay: 0 });
    await s.page.evaluate(() => (location.hash = '#/item/3'));
    await s.page.waitForTimeout(1300);
    const said = await s.page.evaluate(() => document.querySelector('#main .page-loading')?.textContent.trim());
    check('the loading place says Loading to screen readers', said === 'Loading', String(said));
  }
  check(`a page taking ${delay} ms: never the spinner`, !seen.spinner);
  await s.page.unrouteAll({ behavior: 'ignoreErrors' });
  await s.browser.close();
}
for (const [opts, label] of [[{ reducedMotion: 'reduce' }, 'reduced motion'], [{ width: 1920, height: 1080 }, 'TV size']]) {
  const s = await open({ width: 1366, height: 768, theme: 'midnight', ...opts });
  await go(s.page, '#/');
  const anim = await s.page.evaluate(() => {
    const sk = Object.assign(document.createElement('div'), { className: 'skeleton' });
    sk.innerHTML = '<div class="sk"></div>';
    document.getElementById('main').append(sk);
    return getComputedStyle(sk.querySelector('.sk'), '::after').animationName;
  });
  check(`no shimmer under ${label}`, anim === 'none' || !anim, anim);
  await s.context.request.patch(`${BASE}/api/me`, { data: { prefs: { reduceMotion: false } } });
  await s.browser.close();
}
console.log(failed() ? `${failed()} FAIL` : 'ALL PASS');
process.exit(failed() ? 1 : 0);
