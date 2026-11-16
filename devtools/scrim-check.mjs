// Scrim for text on artwork (visual refresh A5), `node devtools/scrim-check.mjs`
// Every artwork picture (posters, backdrops, episode stills, programme pictures, card thumbs) is answered with a pure
// white PNG (page.route), the titles get artwork addresses, a long synopsis, genres and a rating, and Home gets a
// Continue watching row of landscape cards. In all seven themes at 1920x1080 and 390x844:
//   Home: the spotlight title, synopsis and metadata (meta line, genres); landscape card captions (On now, Continue).
//   A title page (#/item/1, a film): its title, metadata and synopsis. A show (#/item/9): its episodes' captions.
//   Live TV: text on its cards (Orbit's wall: pictures behind the words) and its spotlight when it has a picture.
// Each text node's line boxes are found, every text on the page is made transparent, the page is screenshotted and
// the pixels behind each line are read. The text's computed colour (composited on each pixel when translucent) against
// the 5th-percentile pixel (the worst 5 % excluded: anti-aliased edges) must reach WCAG >= 4.5:1. The synopsis's APCA
// Lc is reported as a target (>= 75), not as a failure.
// Second pass, 1920x1080 only, with every picture pure black: the same texts must still reach 4.5:1 (dark text on a
// light wash would pass on white and fail on dark artwork; the scrim is black in every theme, Daylight included).
//   THEMES=orbit,arctic narrows it; SIZES=desk|phone; ART=black|white|both (default both); VERBOSE=1 prints passes;
//   SHOTS=<dir> keeps each sampled screenshot (words hidden). PICTURES=<dir>: before/after pictures instead (below).
// Plan A Task 5 RED (BASE 38dbf19): 36 FAIL; GREEN after fix round 1: 0 FAIL (devtools/out/visual-a/task-5/red.txt, fix1/).
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { apcaContrast, wcagRatio } from '../src/themes/apca.js';
import { check, failed } from './lib.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const THEMES = (process.env.THEMES || 'arctic,arctic-side,daylight,harbour,midnight,obsidian,orbit').split(',');
const SIZES = Object.entries({ desk: [1920, 1080], phone: [390, 844] }).filter(([k]) => !process.env.SIZES || process.env.SIZES.split(',').includes(k));
const ARTS = process.env.ART === 'white' ? ['white'] : process.env.ART === 'black' ? ['black'] : ['white', 'black'];
const VERBOSE = process.env.VERBOSE === '1';

/** A solid PNG (RGB, 8 bit). */
function png(w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMG = { white: png(64, 36, [255, 255, 255]), black: png(64, 36, [0, 0, 0]) };

const SYNOPSIS = 'A harbour pilot who has never lost a ship takes one last night crossing through a storm the radio says will pass by morning. '
  + 'Below deck a stranger carries a letter meant for the pilot\'s brother, and every mile closer to the lighthouse the letter grows heavier. '
  + 'Tides, old debts and a long-dead promise meet on the water before dawn, and only one of them can be kept.';
const art = (id, type) => `/api/items/${id}/image/${type}`;
/** Every title in an answer gets artwork, a synopsis, genres and a rating (logos stay off: a logo hides the title). */
function dress(v) {
  if (Array.isArray(v)) v.forEach(dress);
  else if (v && typeof v === 'object') {
    if (v.id && ['movie', 'show', 'episode', 'season'].includes(v.kind)) {
      Object.assign(v, { poster: art(v.id, 'poster'), backdrop: art(v.id, 'backdrop'), logo: null, overview: SYNOPSIS, genres: ['Drama', 'Mystery', 'Thriller'], rating: 7.4, year: v.year || 2021, runtime: v.runtime || 112, tagline: 'Some promises sink.' });
      if (v.kind === 'episode') v.showBackdrop = art(v.showId || v.id, 'backdrop');
    }
    if (v.kind === 'live') Object.assign(v, { image: art(900 + (v.channelId || 0), 'still') });
    if ('now' in v && 'number' in v && 'groups' in v) { // a Live TV channel
      v.now ||= { id: 1, channelId: v.id, start: Date.now() - 6e5, end: Date.now() + 1.2e6, title: 'Evening News', subtitle: 'Tonight', description: SYNOPSIS, categories: [], image: null, repeat: false, recording: null };
      v.now.image = art(800 + v.id, 'still');
      v.now.description ||= SYNOPSIS;
    }
    Object.values(v).forEach(dress);
  }
  return v;
}

const TARGETS = {
  '#/': [
    ['spotlight title', '.spotlight:not([hidden]) .spot-title'],
    ['spotlight synopsis', '.spotlight:not([hidden]) .spot-overview'],
    ['spotlight metadata', '.spotlight:not([hidden]) .meta-line, .spotlight:not([hidden]) .spot-genres'],
    ['landscape caption', '.landscape-card .card-art :is(.card-tag, .card-live, .card-cant), .landscape-card .card-meta', { card: '.landscape-card' }],
  ],
  '#/item/1': [
    ['title-page title', '.detail-info :is(h1, .detail-title)'],
    ['title-page metadata', '.detail-info :is(.meta-line, .media-flags, .tagline, .eyebrow)'],
    ['title-page synopsis', '.detail-info .overview'],
  ],
  '#/item/9': [ // a show: its episodes (landscape thumbs with the words beside them in every theme today)
    ['landscape caption', '.landscape-card .card-art :is(.card-tag, .card-live, .card-cant), .landscape-card .card-meta, .episode :is(.episode-thumb, .episode-info)', { card: '.landscape-card, .episode' }],
  ],
  '#/live': [
    ['live card text', '.live-card :is(.live-card-num, .live-card-text), .landscape-card .card-art :is(.card-live, .card-cant), .landscape-card .card-meta', { card: '.live-card' }],
    ['live spotlight', '.live-view.has-picture .live-spot :is(.live-spot-where, .live-spot-title, .live-spot-sub, .live-spot-desc, .live-spot-time)'],
  ],
};

/** In the page: the line boxes and colour of every visible text node under `sel` (first `max` cards when `card`). */
const collect = (page, sel, cardSel) => page.evaluate(({ sel, cardSel }) => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data; return { r, g, b, a: a / 255 }; };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const out = [];
  for (const root of document.querySelectorAll(sel)) {
    if (cardSel) { const card = root.closest(cardSel); if (!card || !card.dataset.scrimPick) continue; }
    if (!root.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) {
      const el = n.parentElement;
      if (!n.nodeValue.trim() || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (el.closest('.visually-hidden, [hidden]')) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      // Lines a clamp or a scroller hides (overflow other than visible on the way up) are left out.
      let clip = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { const q = e.getBoundingClientRect(); clip = { l: Math.max(clip.l, q.left), t: Math.max(clip.t, q.top), r: Math.min(clip.r, q.right), b: Math.min(clip.b, q.bottom) }; }
      }
      const rects = [...r.getClientRects()].map((b) => ({ l: Math.max(b.left, clip.l), t: Math.max(b.top, clip.t), r: Math.min(b.right, clip.r), b: Math.min(b.bottom, clip.b) }))
        .filter((b) => b.r - b.l > 2 && b.b - b.t > 4)
        .map((b) => ({ x: Math.floor(b.l), y: Math.floor(b.t), w: Math.ceil(b.r) - Math.floor(b.l), h: Math.ceil(b.b) - Math.floor(b.t) }));
      if (!rects.length) continue;
      const cs = getComputedStyle(el);
      const col = rgba(cs.color);
      col.a *= opacityOf(el);
      out.push({ text: n.nodeValue.trim().slice(0, 36), cls: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`, color: col, size: parseFloat(cs.fontSize), rects });
    }
  }
  return out;
}, { sel, cardSel });

/** Pixels of a PNG screenshot inside rects, decoded in the page (canvas). */
const pixels = (page, b64, rects) => page.evaluate(async ({ b64, rects }) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
  return rects.map((r) => { const d = cx.getImageData(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h)).data; const px = []; for (let i = 0; i < d.length; i += 4 * 3) px.push([d[i], d[i + 1], d[i + 2]]); return px; });
}, { b64, rects });

const over = (t, [r, g, b]) => ({ r: t.r * t.a + r * (1 - t.a), g: t.g * t.a + g * (1 - t.a), b: t.b * t.a + b * (1 - t.a) });
const rgb = ([r, g, b]) => ({ r, g, b });

const HIDE = `*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }
  :focus, :focus-visible { outline-color: transparent !important; }
  .capture-arc, .card-play, .progress, .badge, .live-bar, .spot-resume-track, .live-logo, .live-card-logo { visibility: hidden !important; }`;

// PICTURES=<dir>: Home and a title page per theme (desk and phone), with stand-in artwork (fixed-compare's coloured
// SVGs, ART=1 style) and with white artwork, words showing; then exits. Before/after pictures for the report.
const artSvg = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 60% 40%)"/><circle cx="50%" cy="40%" r="${Math.min(w, h) / 4}" fill="hsl(${hue + 40} 70% 60%)"/></svg>`;
const ROUTE_IMG = (page, kind) => page.route((u) => /\/api\/(items|collections)\/\d+\/image\/|\/api\/live\/.*(logo|image)|\/fake-art\//.test(u.pathname), (route) => {
  if (kind !== 'art') return route.fulfill({ contentType: 'image/png', body: IMG[kind] });
  const m = /\/(\d+)\/image\/(\w+)/.exec(new URL(route.request().url()).pathname) || [0, 1, 'backdrop'];
  route.fulfill({ contentType: 'image/svg+xml', body: m[2] === 'poster' ? artSvg(300, 450, m[1] * 40) : artSvg(1920, 1080, m[1] * 40) });
});
const ROUTE_API = (page) => page.route(/\/api\/(home|libraries\/\d+\/items|items\/\d+|live\/(channels|status|search|groups))(\?|$)/, async (route) => {
  const res = await route.fetch();
  const data = await res.json().catch(() => null);
  if (data == null) return route.fulfill({ response: res });
  if (/\/api\/home/.test(route.request().url())) {
    data.rows = data.rows.filter((r) => !/random/.test(r.id));
    const films = data.rows.flatMap((r) => r.items || []).filter((i) => i.kind === 'movie').slice(0, 4);
    if (films.length && !data.rows.some((r) => /continue/.test(r.id))) {
      data.rows.splice(1, 0, { id: 'continue', title: 'Continue watching', style: 'landscape', items: films.map((f, i) => ({ ...structuredClone(f), kind: 'episode', id: 100 + i, showId: f.id, showTitle: f.title, season: 1, episode: i + 1, title: `Episode ${i + 1}`, progress: { position: 600, duration: 2400, watched: false } })) });
    }
  }
  await route.fulfill({ json: dress(data) });
});
const settle = async (page, hash) => {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => { const b = document.querySelector('.backdrop'); if (!b) return true; const want = [...b.querySelectorAll('img')].some((i) => i.getAttribute('src')); return !want || [...b.querySelectorAll('img.is-on')].some((i) => i.complete); }, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
};
const newPage = async (browser, theme, w, h, size) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: 'block' });
  await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: 'dallas', password: 'atomix-dev-1' } });
  await ctx.request.patch(`${BASE}/api/me`, { data: { prefs: { theme, reduceMotion: true } } });
  return { ctx, page: await ctx.newPage() };
};
if (process.env.PICTURES) {
  const fs = await import('node:fs');
  fs.mkdirSync(process.env.PICTURES, { recursive: true });
  const browser = await chromium.launch();
  for (const kind of ['art', 'white']) for (const theme of THEMES) for (const [size, [w, h]] of SIZES) {
    const { ctx, page } = await newPage(browser, theme, w, h, size);
    await ROUTE_IMG(page, kind); await ROUTE_API(page);
    for (const hash of ['#/', '#/item/1', '#/live']) {
      await settle(page, hash);
      await page.screenshot({ path: `${process.env.PICTURES}/${kind}-${theme}-${size}-${hash === '#/' ? 'home' : hash === '#/live' ? 'live' : 'title'}.png`, mask: [page.locator('.nav-clock, .orbit-clock, time')] });
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(0);
}

const browser = await chromium.launch();
const results = [];
for (const artColour of ARTS) for (const theme of THEMES) for (const [size, [w, h]] of SIZES) {
  if (artColour === 'black' && size !== 'desk') continue;
  const { ctx, page } = await newPage(browser, theme, w, h, size);
  await ROUTE_IMG(page, artColour); await ROUTE_API(page);
  for (const [hash, groups] of Object.entries(TARGETS)) {
    await settle(page, hash);
    for (const [name, sel, opt = {}] of groups) {
      let cards = [null];
      if (opt.card) {
        const n = await page.evaluate((c) => { document.querySelectorAll('[data-scrim-pick]').forEach((e) => delete e.dataset.scrimPick); return document.querySelectorAll(c).length; }, opt.card);
        cards = Array.from({ length: Math.min(n, 3) }, (_, i) => i);
      }
      if (!cards.length) { console.log(`---- ${artColour} ${theme} ${size} ${hash} ${name}: none on the page`); continue; }
      let worst = null, synApca = null, count = 0;
      for (const ci of cards) {
        if (ci != null) {
          await page.evaluate(({ c, i }) => { document.querySelectorAll('[data-scrim-pick]').forEach((e) => delete e.dataset.scrimPick); const el = document.querySelectorAll(c)[i]; el.dataset.scrimPick = '1'; el.scrollIntoView({ block: 'center', inline: 'nearest' }); }, { c: opt.card, i: ci });
          await page.waitForTimeout(350);
        } else await page.evaluate(() => scrollTo(0, 0));
        const nodes = await collect(page, sel, opt.card ? opt.card : null);
        if (!nodes.length) continue;
        const style = await page.addStyleTag({ content: HIDE });
        await page.waitForTimeout(60);
        const buf = await page.screenshot();
        if (process.env.SHOTS) { (await import('node:fs')).mkdirSync(process.env.SHOTS, { recursive: true }); (await import('node:fs')).writeFileSync(`${process.env.SHOTS}/${artColour}-${theme}-${size}-${hash.replace(/[#/]+/g, '_')}-${name.replace(/ /g, '-')}${ci ?? ''}.png`, buf); }
        const shot = buf.toString('base64');
        await style.evaluate((s) => s.remove());
        const px = await pixels(page, shot, nodes.flatMap((n) => n.rects));
        let k = 0;
        for (const n of nodes) {
          const all = n.rects.flatMap(() => px[k++]);
          if (!all.length) continue;
          count++;
          const ratios = all.map((p) => ({ p, c: wcagRatio(over(n.color, p), rgb(p)) })).sort((a, b) => a.c - b.c);
          const at = ratios[Math.floor(ratios.length * 0.05)];
          const rec = { text: n.text, cls: n.cls, ratio: at.c, min: ratios[0].c, bg: at.p, color: n.color };
          if (!worst || rec.ratio < worst.ratio) worst = rec;
          if (/synopsis/.test(name)) {
            const lc = Math.abs(apcaContrast(over(n.color, at.p), rgb(at.p)));
            if (synApca == null || lc < synApca) synApca = lc;
          }
        }
      }
      if (!count) { console.log(`---- ${artColour} ${theme} ${size} ${hash} ${name}: no visible text`); continue; }
      const detail = `${worst.ratio.toFixed(2)}:1 (min ${worst.min.toFixed(2)}) "${worst.text}" ${worst.cls} on rgb(${worst.bg.join(',')})${synApca != null ? ` · APCA Lc ${synApca.toFixed(1)}${synApca >= 75 ? '' : ' (target 75, not met)'}` : ''}`;
      results.push({ artColour, theme, size, hash, name, ...worst, synApca });
      if (VERBOSE || worst.ratio < 4.5) check(`${artColour} art ${theme} ${size} ${hash} ${name} >= 4.5:1`, worst.ratio >= 4.5, detail);
      else console.log(`PASS ${artColour} art ${theme} ${size} ${hash} ${name} — ${detail}`);
    }
  }
  await ctx.close();
}
await browser.close();
const syn = results.filter((r) => r.synApca != null);
console.log(`synopsis APCA (target Lc >= 75): ${syn.filter((r) => r.synApca >= 75).length}/${syn.length} meet it; lowest ${Math.min(...syn.map((r) => r.synApca)).toFixed(1)}`);
console.log(failed() ? `${failed()} FAIL` : `0 FAIL (${results.length} checks)`);
process.exit(failed() ? 1 : 0);
