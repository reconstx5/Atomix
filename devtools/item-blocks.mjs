// The title page's Preact building blocks (public/js/ui/detail.js, Row's `card`) draw what their older helpers draw:
// each is rendered next to its helper on a loaded page, for the made-up titles, and the markup compared.
//   BASE=http://localhost:8797 node devtools/item-blocks.mjs      (exit 1 on any difference)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, check, failed, BASE } from './lib.mjs';
import { routeItems } from './item-fixtures.mjs';

if (!process.env.BASE || /:8787/.test(process.env.BASE)) {
  console.log('Set BASE to the dev Atomix (for example http://localhost:8797). This check changes the profile, so it will not run against the default or the live server on port 8787.');
  process.exit(2);
}
const fixture = (id) => JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'items', `${id}.json`), 'utf8'));
const DATA = { 900001: fixture(900001), 900002: fixture(900002), 900003: fixture(900003), 900010: fixture(900010) };

const { browser, page, errors } = await open({ serviceWorkers: 'block' });
await routeItems(page);
await page.goto(`${BASE}/#/item/900003`);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(1500);

const results = await page.evaluate(async (DATA) => {
  const norm = (s) => (s || '').replace(/\?v=\d+/g, '?v=X');
  const [{ html, render }, detail, cards, comp, lists, rating] = await Promise.all([
    import('/js/ui.js'), import('/js/ui/detail.js'), import('/js/ui/cards.js'), import('/js/components.js'), import('/js/lists.js'), import('/js/rating.js'),
  ]);
  const out = [];
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px';
  document.body.append(stage);
  /** Draw `vnode` and the helper's `node`; compare. `after`: wait for something (a picture) first. */
  const same = async (name, vnode, make, after) => {
    const a = document.createElement('div');
    stage.append(a);
    render(vnode, a);
    const old = make();
    const b = document.createElement('div');
    if (old) b.append(...[old].flat());
    stage.append(b);
    if (after) await after(a, b);
    out.push({ name, ok: norm(a.innerHTML) === norm(b.innerHTML), a: norm(a.innerHTML).slice(0, 600), b: norm(b.innerHTML).slice(0, 600) });
    render(null, a);
    a.remove();
    b.remove();
  };
  const loaded = (root) => new Promise((res) => {
    const img = root.querySelector('img');
    if (!img) return res();
    if (img.complete) return setTimeout(res, 50);
    img.addEventListener('load', () => setTimeout(res, 50), { once: true });
    img.addEventListener('error', () => setTimeout(res, 50), { once: true });
    setTimeout(res, 3000);
  });
  const both = (fn) => async (a, b) => { await Promise.all([fn(a), fn(b)]); };
  const { item: film } = DATA[900001];
  const { item: plain } = DATA[900003];
  const { item: show } = DATA[900010];

  for (const it of [film, plain]) await same(`MediaChips ${it.id}`, html`<${detail.MediaChips} item=${it} />`, () => comp.mediaChips(it));
  for (const it of [film, DATA[900002].item, plain, show]) {
    await same(`DetailMeta ${it.id}`, html`<${detail.DetailMeta} item=${it} ends=${'Ends at 9:40 pm'} rise="0" />`, () => {
      const m = comp.metaLine(it);
      m.append(Object.assign(document.createElement('span'), { className: 'ends-at', textContent: 'Ends at 9:40 pm' }));
      m.dataset.rise = '0';
      return m;
    });
  }
  await same('DetailMeta without ends', html`<${detail.DetailMeta} item=${show} rise="0" />`, () => { const m = comp.metaLine(show); m.dataset.rise = '0'; return m; });
  // The logo box: the old helper is item.js's titleArt (not exported); written out here as it is.
  const { sizedAttrs } = await import('/js/sized.js');
  const titleArt = (logoUrl, text) => {
    const heading = document.createElement('h1');
    heading.className = 'detail-title';
    heading.textContent = text;
    if (!logoUrl) return heading;
    const img = document.createElement('img');
    img.className = 'detail-logo';
    img.hidden = true;
    img.src = sizedAttrs(logoUrl, 'logo', { orbit: document.body?.dataset.layout === 'orbit', width: Math.min(600, window.innerWidth * 0.8) * (window.devicePixelRatio || 1) }).src;
    img.alt = '';
    img.decoding = 'async';
    const box = document.createElement('div');
    box.className = 'logo-box';
    box.append(img, heading);
    img.addEventListener('load', () => { img.hidden = false; heading.classList.add('visually-hidden'); box.classList.add('has-logo'); });
    img.addEventListener('error', () => img.remove());
    return box;
  };
  await same('TitleArt no logo', html`<${detail.TitleArt} logo=${null} title=${plain.title} />`, () => titleArt(null, plain.title));
  await same('TitleArt before the logo loads', html`<${detail.TitleArt} logo=${'/fake-art/logo-900001.svg?slow'} title=${film.title} />`, () => titleArt('/fake-art/logo-900001.svg?slow', film.title));
  await same('TitleArt after the logo loads', html`<${detail.TitleArt} logo=${film.logo} title=${film.title} />`, () => titleArt(film.logo, film.title), both(loaded));
  await same('TitleArt a logo that fails', html`<${detail.TitleArt} logo=${'/fake-art/logo-404.svg'} title=${film.title} />`, () => titleArt('/fake-art/logo-404.svg', film.title), both(loaded));
  const genres = (g) => { if (!g?.length) return null; const ul = document.createElement('ul'); ul.className = 'genres'; ul.setAttribute('role', 'list'); for (const x of g) ul.append(Object.assign(document.createElement('li'), { className: 'chip', textContent: x })); return ul; };
  await same('Genres', html`<${detail.Genres} genres=${film.genres} />`, () => genres(film.genres));
  await same('Genres none', html`<${detail.Genres} genres=${[]} />`, () => genres([]));
  await same('WatchlistButton in', html`<${detail.WatchlistButton} item=${film} initialIn=${true} />`, () => lists.watchlistButton(film, true));
  await same('WatchlistButton out', html`<${detail.WatchlistButton} item=${film} initialIn=${false} />`, () => lists.watchlistButton(film, false));
  const offline = await import('/js/offline/ui.js');
  await same('DownloadButton', html`<${detail.DownloadButton} item=${film} />`, () => offline.downloadButton(film), async () => new Promise((r) => setTimeout(r, 300)));
  await same('RatingControl', html`<${detail.RatingControl} item=${{ ...film, stars: 3, favourite: true }} />`, () => rating.ratingControl({ ...film, stars: 3, favourite: true }));
  const rowItems = DATA[900001].collection.items;
  await same('Row without card', html`<${cards.Row} id="collection" title="Part" items=${rowItems} />`, () => comp.row({ id: 'collection', title: 'Part', items: rowItems, style: 'poster' }));
  await same('Row with card returning undefined', html`<${cards.Row} id="collection" title="Part" items=${rowItems} card=${() => undefined} />`, () => comp.row({ id: 'collection', title: 'Part', items: rowItems, style: 'poster' }));
  // A card(item, i) that returns a vnode draws that vnode in place of the card.
  const a = document.createElement('div');
  stage.append(a);
  render(html`<${cards.Row} id="collection" title="Part" items=${rowItems} card=${(it, i) => (i === 1 ? html`<div class="custom-card">${it.title}</div>` : undefined)} />`, a);
  const kids = [...a.querySelector('.row-scroller').children].map((c) => c.className);
  out.push({ name: 'Row card(item, i) replaces that card', ok: kids.length === 3 && kids[1] === 'custom-card' && /poster-card/.test(kids[0]) && /poster-card/.test(kids[2]), a: JSON.stringify(kids), b: '' });
  render(null, a);
  stage.remove();
  return out;
}, DATA).catch((e) => [{ name: 'the blocks load', ok: false, a: String(e).slice(0, 300), b: '' }]);

for (const r of results) check(r.name, r.ok, r.ok ? '' : `\n  new: ${r.a}\n  old: ${r.b}`);
check('no page errors', !errors.filter((e) => !/404/.test(e)).length, errors.join(' | '));
await browser.close();
process.exit(failed() ? 1 : 0);
