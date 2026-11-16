// Focus with two cues (visual refresh A4). `node devtools/focus-check.mjs`  (THEMES=midnight,orbit narrows it)
// In all seven themes, on a laptop-size desktop (1366x768: --focus-width 3 px) and a TV-size screen (1920x1080, the
// wide-landscape TV block: 4 px), the keyboard focus (an arrow press first, so the focus is :focus-visible, the way the
// app's spatial nav focuses) on a Home card, a title-page button, a Settings chip (.chip-radio), a menu entry (.nav-link)
// and a Settings toggle shows:
//   1. a real outline (computed outline-style not none) at least --focus-width wide, on the element that draws the ring
//      (a card: its art; a toggle: its track; otherwise the element itself);
//   2. a ring colour >= 3:1 (WCAG) against the page background (--app-bg);
//   3. a 1 px halo outside the ring (a box-shadow spread >= offset + width + 1);
//   4. a second cue: the card lifts or grows (transform); the others change their fill (background) or grow;
//   5. no tween on the ring: transition-property with a non-zero duration never names outline*, box-shadow or all;
//   6. with forced colours emulated (Windows High Contrast) the outline is still there (presence only: the system
//      palette decides its colour, so no contrast is asserted);
//   7. the lifted card's ring box doesn't cross its neighbour's box (the second card, and the first, which grows from
//      its inner edge), and the row doesn't clip the ring.
// Reduce motion (Midnight and Orbit, TV size): 5 holds too (reduce's own transition list must not name outline-color).
import { open, go, check, failed } from './lib.mjs';
import { wcagRatio } from '../src/themes/apca.js';

const THEMES = (process.env.THEMES || 'arctic,arctic-side,daylight,harbour,midnight,obsidian,orbit').split(',');
const SIZES = [['desktop', 1366, 768, 3], ['tv', 1920, 1080, 4]];
const ROW = '.row[data-row="recent-1"] .row-scroller';

// [name, page, selector of the thing focused, how to find the ring element from it]
const TARGETS = [
  ['card', '#/', `${ROW} > a.card`, 'art', 1],
  ['button', '#/item/1', '.detail-actions .btn, .detail-info .btn, main .btn', 'self', 0],
  ['chip', '#/settings', '.chip-radio', 'self', 0],
  ['menu entry', '#/settings', '.nav-link:not([aria-current="page"])', 'self', 0],
  ['settings toggle', '#/settings', '.toggle input', 'track', 0],
  // Over video: a stand-in player (the real markup's classes, drawn by the real stylesheets) over a white frame,
  // the worst case for a white ring; the halo must survive the buttons' own resting shadows.
  ['skip intro', '#/', '.player .skip-intro', 'self', 0],
  ['big play', '#/', '.player .player-bigplay', 'self', 0],
];
const PROBE = new Set(['skip intro', 'big play']);
/** In the page: a stand-in player with Skip intro and the big play button. */
const addPlayer = (page) => page.evaluate(() => {
  document.querySelector('.player.focus-probe')?.remove();
  const p = document.createElement('div');
  p.className = 'player focus-probe'; p.dataset.controls = 'visible'; p.style.background = '#fff';
  p.innerHTML = '<button type="button" class="skip-intro">Skip intro<span class="skip-intro-bar"></span></button><button type="button" class="player-bigplay" aria-label="Play">&#9654;</button>';
  document.body.append(p);
});

/** In the page: the visible match number `i` of `sel`, scrolled into view; returns nothing (the element is window.__t). */
const pick = (page, sel, i) => page.evaluate(({ sel, i }) => {
  const vis = [...document.querySelectorAll(sel)].filter((e) => {
    const box = e.matches('.toggle input') ? e.parentElement : e;
    const r = box.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(box).visibility !== 'hidden';
  });
  window.__t = vis[i] || null;
  return Boolean(window.__t);
}, { sel, i });

/** In the page: what the ring element shows now. */
const read = (page, how) => page.evaluate((how) => {
  const el = window.__t;
  const ring = how === 'art' ? el.querySelector('.card-art') : how === 'track' ? el.parentElement.querySelector('.toggle-track') : el;
  const rgb = (c) => { // any CSS colour -> [r,g,b,a] via a canvas
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const x = cv.getContext('2d'); x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = c; x.fillRect(0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  };
  const probe = document.createElement('i'); probe.style.color = 'var(--app-bg)'; document.body.append(probe);
  const appBg = getComputedStyle(probe).color; probe.remove();
  const cs = getComputedStyle(ring), es = getComputedStyle(el);
  const tr = (s) => { // [property, duration ms] pairs, with the durations list repeated as CSS does
    const p = s.transitionProperty.split(',').map((x) => x.trim()), d = s.transitionDuration.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000));
    return p.map((name, k) => [name, d[k % d.length]]);
  };
  const r = ring.getBoundingClientRect();
  const out = {
    focusVisible: el.matches(':focus-visible'),
    style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset),
    color: rgb(cs.outlineColor), bg: rgb(appBg), shadow: cs.boxShadow,
    fill: cs.backgroundColor, fillSelf: es.backgroundColor, transform: cs.transform, transformSelf: es.transform,
    trans: [...tr(cs), ...(ring === el ? [] : tr(es))],
    box: { l: r.left, t: r.top, r: r.right, b: r.bottom },
  };
  if (how === 'art') { // the neighbour (next card's own box) and the row's clip box
    const next = el.nextElementSibling?.getBoundingClientRect();
    const sc = el.closest('.row-scroller').getBoundingClientRect();
    out.next = next && { l: next.left, t: next.top, r: next.right, b: next.bottom };
    out.clip = { l: sc.left, t: sc.top, r: sc.right, b: sc.bottom };
  }
  return out;
}, how);

/** The largest spread length among the box-shadow layers. */
const spread = (shadow) => Math.max(0, ...[...String(shadow).matchAll(/(?:^|,)\s*(?:rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|#\w+)?\s*(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px(?!\s*inset)/g)].map((m) => Number(m[4])));
const badTween = (trans) => trans.filter(([p, d]) => d > 0 && (p === 'all' || p.startsWith('outline') || p === 'box-shadow'));

// SHOTS=<dir>: a focused card (Home, stand-in artwork) and a focused button (title page) per theme at 1920x1080, then exit.
if (process.env.SHOTS) {
  const fs = await import('node:fs'); const path = await import('node:path');
  const out = process.env.SHOTS; fs.mkdirSync(out, { recursive: true });
  const art = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;
  const dress = (v) => {
    if (Array.isArray(v)) v.forEach(dress);
    else if (v && typeof v === 'object') {
      if (v.id && ['movie', 'show', 'episode'].includes(v.kind)) Object.assign(v, { poster: `/fake-art/poster-${v.id}.svg`, tint: '#c03020', tintWide: '#2040c0' });
      Object.values(v).forEach(dress);
    }
    return v;
  };
  for (const theme of THEMES) {
    const { browser, page } = await open({ width: 1920, height: 1080, theme });
    await page.context().route(/\/fake-art\/(poster|backdrop)-(\d+)\.svg/, (r) => {
      const [, type, id] = /(poster|backdrop)-(\d+)/.exec(r.request().url());
      r.fulfill({ contentType: 'image/svg+xml', body: type === 'poster' ? art(300, 450, id * 40) : art(1920, 1080, id * 40) });
    });
    await page.context().route(/\/api\/(home|items\/\d+)(\?|$)/, async (r) => {
      const res = await r.fetch(); const j = dress(await res.json());
      if (/\/api\/items\/\d+/.test(r.request().url()) && j?.item?.id) j.item.backdrop = `/fake-art/backdrop-${j.item.id}.svg`;
      r.fulfill({ response: res, json: j });
    });
    await page.context().addInitScript(() => navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((x) => x.unregister())));
    for (const [name, hash, sel, i] of [['card', '#/', `${ROW} > a.card`, 1], ['button', '#/item/1', TARGETS[1][2], 0]]) {
      await go(page, hash);
      await page.waitForTimeout(1200);
      if (!(await focusOn(page, sel, i))) continue;
      await page.evaluate(() => window.__t.focus({ preventScroll: true }));
      await page.waitForTimeout(500);
      const box = await page.evaluate(() => { const r = window.__t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const pad = name === 'card' ? 60 : 40;
      const clip = { x: Math.max(0, box.x - pad - (name === 'card' ? box.w : 0)), y: Math.max(0, box.y - pad), width: box.w * (name === 'card' ? 3 : 1) + pad * 2, height: box.h + pad * 2 };
      clip.width = Math.min(clip.width, 1920 - clip.x); clip.height = Math.min(clip.height, 1080 - clip.y);
      await page.screenshot({ path: path.join(out, `${theme}-${name}.png`), clip });
    }
    await browser.close();
  }
  process.exit(0);
}

async function focusOn(page, sel, i) {
  await page.keyboard.press('ArrowDown'); // keyboard modality (html.kbd), like a remote
  await page.waitForTimeout(150);
  if (!(await pick(page, sel, i))) return false;
  await page.evaluate(() => { window.__t.scrollIntoView({ block: 'center', inline: 'nearest' }); });
  await page.waitForTimeout(200);
  return true;
}

for (const theme of THEMES) {
  for (const [size, w, h, minW] of SIZES) {
    const { browser, page, errors } = await open({ width: w, height: h, theme });
    for (const [name, hash, sel, how, i] of TARGETS) {
      const tag = `${theme} ${size} ${name}`;
      await go(page, hash);
      if (name === 'card') await page.waitForSelector(`${ROW} > a.card`, { timeout: 15000 }).catch(() => {});
      if (PROBE.has(name)) await addPlayer(page);
      if (!(await focusOn(page, sel, i))) { check(`${tag}: found`, false, sel); continue; }
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(350);
      const rest = await read(page, how);
      await page.evaluate(() => window.__t.focus({ preventScroll: true }));
      await page.waitForTimeout(450); // past the lift
      const f = await read(page, how);
      check(`${tag}: focus-visible`, f.focusVisible);
      check(`${tag}: outline ring >= ${minW} px`, f.style !== 'none' && f.width >= minW, `${f.style} ${f.width}px offset ${f.offset}`);
      const ratio = wcagRatio({ r: f.color[0], g: f.color[1], b: f.color[2] }, { r: f.bg[0], g: f.bg[1], b: f.bg[2] });
      check(`${tag}: ring >= 3:1 on the page`, f.color[3] > 0.99 && ratio >= 3, `${f.color} on ${f.bg} = ${ratio.toFixed(2)}`);
      check(`${tag}: 1 px halo outside the ring`, spread(f.shadow) >= f.offset + f.width + 1 - 0.01, f.shadow);
      const second = how === 'art' ? f.transform !== rest.transform || f.transformSelf !== rest.transformSelf
        : f.fill !== rest.fill || f.fillSelf !== rest.fillSelf || f.transform !== rest.transform || f.transformSelf !== rest.transformSelf;
      check(`${tag}: a second cue (${how === 'art' ? 'lift' : 'fill or growth'})`, second, `fill ${rest.fill} -> ${f.fill}; transform ${rest.transform} -> ${f.transform}`);
      check(`${tag}: no tween on the ring`, badTween(f.trans).length === 0, JSON.stringify(badTween(f.trans)));
      if (how === 'art') {
        const e = f.offset + f.width; // the ring's reach outside the art
        const ringBox = { l: f.box.l - e, t: f.box.t - e, r: f.box.r + e, b: f.box.b + e };
        check(`${tag}: the lifted card stays off its neighbour`, f.next && ringBox.r <= f.next.l + 0.5, `ring right ${ringBox.r.toFixed(1)} vs next left ${f.next?.l.toFixed(1)}`);
        check(`${tag}: the row doesn't clip the ring`, ringBox.t >= f.clip.t - 0.5 && ringBox.b <= f.clip.b + 0.5, `ring ${ringBox.t.toFixed(1)}..${ringBox.b.toFixed(1)} row ${f.clip.t.toFixed(1)}..${f.clip.b.toFixed(1)}`);
      }
      if (size === 'tv') {
        await page.emulateMedia({ forcedColors: 'active' });
        await page.waitForTimeout(100);
        const fc = await read(page, how);
        // Presence only, not a contrast figure: the system's colours decide here (headless Chromium's Highlight is rgba(5, 0, 73, 0.8)).
        check(`${tag}: forced colours keep the outline`, fc.style !== 'none' && fc.width >= minW && fc.color[3] > 0.5, `${fc.style} ${fc.width}px ${fc.color}`);
        await page.emulateMedia({ forcedColors: 'none' });
      }
      if (how === 'art') { // the row's first card grows from its inner edge: all of its growth goes toward the second
        await page.evaluate(({ sel }) => { window.__t = document.querySelector(sel); window.__t.focus({ preventScroll: true }); window.__t.closest('.row-scroller').scrollLeft = 0; }, { sel });
        await page.waitForTimeout(450);
        const f0 = await read(page, how);
        const e = f0.offset + f0.width;
        check(`${tag}: the first card, lifted, stays off the second`, f0.next && f0.box.r + e <= f0.next.l + 0.5, `ring right ${(f0.box.r + e).toFixed(1)} vs next left ${f0.next?.l.toFixed(1)}`);
      }
    }
    check(`${theme} ${size}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await browser.close();
  }
}

// Sweep (desktop): every visible focusable on Home, a library, a title page, Live TV and Settings, focused in turn,
// keeps its ring and its halo (an outer spread >= offset + width + 1, or the inward ring's inset halo). This catches a
// resting box-shadow that beats the :where() halo.
const SWEEP = ['#/', '#/library/1', '#/item/1', '#/live', '#/settings'];
for (const theme of THEMES) {
  const { browser, page } = await open({ width: 1366, height: 768, theme });
  for (const hash of SWEEP) {
    await go(page, hash);
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
    const bad = await page.evaluate(() => {
      const spread = (sh, inset) => Math.max(0, ...[...String(sh).matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px(\s*inset)?/g)].filter((m) => Boolean(m[5]) === inset).map((m) => Number(m[4])));
      const sel = (e) => e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '') + (e.getAttribute('aria-current') ? '[current]' : '');
      const out = new Map();
      const els = [...document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')];
      for (const el of els) {
        if (el.disabled || el.closest('[hidden], [inert]') || el.matches('main')) continue;
        const holder = el.matches('.card') ? el.querySelector('.card-art') : el.matches('.toggle input') ? el.parentElement.querySelector('.toggle-track')
          : el.matches('.search-box input') ? el.closest('.search-box') : el.matches('.picker-profile') ? el.querySelector('.avatar') : el;
        if (!holder) continue;
        const r = (el.matches('.toggle input') ? holder : el).getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || !el.checkVisibility({ checkOpacity: !el.matches('.toggle input'), checkVisibilityCSS: true })) continue;
        el.focus({ preventScroll: true });
        if (!el.matches(':focus-visible')) continue;
        const cs = getComputedStyle(holder), w = parseFloat(cs.outlineWidth), off = parseFloat(cs.outlineOffset);
        const ok = cs.outlineStyle !== 'none' && w >= 3 && (off < 0 ? spread(cs.boxShadow, true) >= w + 1 - 0.01 : spread(cs.boxShadow, false) >= off + w + 1 - 0.01);
        if (!ok) out.set(sel(el), `${cs.outlineStyle} ${w}px off ${off} | ${cs.boxShadow}`.slice(0, 160));
      }
      document.activeElement?.blur();
      return [...out];
    });
    check(`${theme} sweep ${hash}: every focusable keeps ring and halo`, bad.length === 0, bad.map(([k, v]) => `${k}: ${v}`).join(' ;; '));
  }
  await browser.close();
}

// Reduce motion: its transition list must not bring a tween onto the ring.
for (const theme of THEMES.filter((t) => ['midnight', 'orbit'].includes(t))) {
  const { browser, page } = await open({ width: 1920, height: 1080, theme, reducedMotion: 'reduce' });
  for (const [name, hash, sel, how, i] of TARGETS) {
    await go(page, hash);
    if (name === 'card') await page.waitForSelector(`${ROW} > a.card`, { timeout: 15000 }).catch(() => {});
    if (PROBE.has(name)) await addPlayer(page);
    if (!(await focusOn(page, sel, i))) continue;
    await page.evaluate(() => window.__t.focus({ preventScroll: true }));
    await page.waitForTimeout(300);
    const f = await read(page, how);
    check(`${theme} reduce ${name}: no tween on the ring`, badTween(f.trans).length === 0, JSON.stringify(badTween(f.trans)));
  }
  await browser.close();
}

console.log(failed() ? `${failed()} failed` : 'all passed');
process.exit(failed() ? 1 : 0);
