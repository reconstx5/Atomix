// The comic reader (v0.22 Plan D): one page at a time on a phone held upright, two side by side on a wide screen (the
// cover alone); fit to the screen, its width or its height (kept per profile); pinch, double-tap or OK to zoom, a
// drag or Up/Down to move about; manga right to left (the series says so); the next pages fetched ahead; at the end,
// the next issue. A page over 4000 px comes scaled to 2400 px; zooming in on it fetches the original.
import { api } from '../api.js';
import { h, icon, clear } from '../dom.js';
import { toast } from '../components.js';
import { state, updatePrefs } from '../app.js';
import { thisDevice, moveWithin, ownButton } from './epub.js';

const REPORT_MS = 30_000;
const AHEAD = 3;
const SCALED = 2400; // the server's phone-sized copy of a big page
const FITS = ['screen', 'width', 'height'];
const FIT_WORDS = { screen: 'Fit: screen', width: 'Fit: width', height: 'Fit: height' };

/** The spreads: each page alone, or (two-up) the cover alone and then pairs. */
export function spreads(count, twoUp) {
  const out = [];
  if (!twoUp) {
    for (let i = 0; i < count; i++) out.push([i]);
    return out;
  }
  if (count) out.push([0]);
  for (let i = 1; i < count; i += 2) out.push(i + 1 < count ? [i, i + 1] : [i]);
  return out;
}

/**
 * @param {HTMLElement} el
 * @param {{ data: object, leave: () => void, pageUrl?: (n: number) => string, report?: (body) => Promise<void> }} opts
 *   `data` is GET /api/items/:id of a comic (item, show).
 */
export function openComicReader(el, { data, leave, pageUrl = null, report = null }) {
  const comic = data.item;
  const series = data.show || null;
  const count = comic.pageCount || 0;
  const urlOf = pageUrl || ((n) => `/api/comics/${comic.id}/pages/${n}`);
  const send = report || ((body) => api.post(`/api/items/${comic.id}/progress`, body).catch(() => {}));
  const rtl = (series?.readingDir || comic.readingDir) === 'rtl';
  const device = thisDevice();
  let fit = FITS.includes(state.profile?.prefs?.comicFit) ? state.profile.prefs.comicFit : 'screen';
  const s = { spread: 0, list: [], zoom: 1, x: 0, y: 0, turned: 0, finished: false };

  el.classList.add('reader-view', 'comic-view');
  el.classList.toggle('is-rtl', rtl);
  const stage = h('div', { class: 'comic-stage' });
  const holder = h('div', { class: 'comic-holder', tabindex: '-1', role: 'img' }, stage);
  const where = h('p', { class: 'reader-status comic-status' });
  const fitBtn = h('button', { type: 'button', class: 'btn btn-ghost comic-fit-btn', onClick: () => cycleFit() }, FIT_WORDS[fit]);
  const bar = h(
    'div',
    { class: 'reader-bar', hidden: true },
    h('button', { type: 'button', class: 'btn btn-ghost btn-icon reader-back', 'aria-label': 'Back', onClick: () => close() }, icon('back')),
    h('p', { class: 'reader-title' }, series ? `${series.title}${comic.issue ? ` #${comic.issue}` : ''}` : comic.title),
    fitBtn,
  );
  const end = h('div', { class: 'reader-end comic-end', hidden: true });
  el.append(h('div', { class: 'reader-page' }, holder), where, bar, end);
  el.dataset.fit = fit;

  const twoUp = () => window.innerWidth > window.innerHeight;
  // This device's own place (so a comic read with no connection opens again where it was left).
  const placeKey = `atomix-read-${state.profile?.id ?? 0}-${comic.id}`;
  function readPlace() {
    try {
      return JSON.parse(localStorage.getItem(placeKey) || 'null');
    } catch {
      return null;
    }
  }
  function writePlace(page = firstPage()) {
    try {
      localStorage.setItem(placeKey, JSON.stringify({ at: Date.now(), page }));
    } catch {
      /* private mode: Atomix keeps the place */
    }
  }
  function build(keepPage = null) {
    s.list = spreads(count, twoUp());
    if (keepPage != null) s.spread = Math.max(0, s.list.findIndex((sp) => sp.includes(keepPage)));
  }
  const firstPage = () => s.list[s.spread]?.[0] ?? 0;

  function paint() {
    const pages = s.list[s.spread] || [];
    clear(stage).append(
      ...pages.map((n) => {
        const img = h('img', { class: 'comic-page', src: urlOf(n), alt: `Page ${n + 1} of ${count}`, decoding: 'async', draggable: 'false', dataset: { n } });
        img.addEventListener('load', () => zoomed());
        // A page the server couldn't give: what it said (7-Zip gone, a damaged file), not a broken picture.
        img.addEventListener('error', async () => {
          let why = "This page couldn't be read.";
          try {
            const r = await fetch(img.src, { credentials: 'same-origin' });
            if (!r.ok) why = (await r.json().catch(() => null))?.error || why;
          } catch {
            /* no answer at all: the plain sentence */
          }
          if (img.isConnected) where.textContent = `Page ${n + 1} of ${count}: ${why}`;
        });
        return img;
      }),
    );
    // The later page on the left when reading right to left.
    stage.classList.toggle('two', pages.length > 1);
    stage.style.flexDirection = rtl ? 'row-reverse' : 'row';
    holder.setAttribute('aria-label', pages.length > 1 ? `Pages ${pages[0] + 1} and ${pages[1] + 1} of ${count}` : `Page ${pages[0] + 1} of ${count}`);
    where.textContent = `${pages.length > 1 ? `Pages ${pages[0] + 1}–${pages[1] + 1}` : `Page ${pages[0] + 1}`} of ${count}`;
    setZoom(1);
    Object.assign(el.dataset, { ready: 'true', spread: s.spread, page: firstPage(), pages: count, rtl: String(rtl) });
    writePlace();
    // Fetched ahead.
    const last = pages[pages.length - 1] ?? 0;
    for (let n = last + 1; n <= Math.min(count - 1, last + AHEAD); n++) new Image().src = urlOf(n);
  }
  function go(spread) {
    if (spread >= s.list.length) return finish();
    s.spread = Math.max(0, spread);
    s.turned++;
    paint();
  }
  const forward = () => go(s.spread + 1);
  const back = () => go(s.spread - 1);

  // ---- zoom and pan ----
  function setZoom(z, cx = null, cy = null) {
    const prev = s.zoom;
    s.zoom = Math.max(1, Math.min(4, z));
    if (s.zoom === 1) {
      s.x = 0;
      s.y = 0;
    } else if (cx != null) {
      // Keep the point under the finger where it is.
      const r = holder.getBoundingClientRect();
      const px = cx - r.left - r.width / 2;
      const py = cy - r.top - r.height / 2;
      s.x = px - ((px - s.x) * s.zoom) / prev;
      s.y = py - ((py - s.y) * s.zoom) / prev;
    }
    zoomed();
  }
  function zoomed() {
    const r = holder.getBoundingClientRect();
    const maxX = (r.width * (s.zoom - 1)) / 2;
    const maxY = (r.height * (s.zoom - 1)) / 2 + Math.max(0, stage.scrollHeight - r.height) / 2;
    s.x = Math.max(-maxX, Math.min(maxX, s.x));
    s.y = Math.max(-maxY, Math.min(maxY, s.y));
    stage.style.transform = s.zoom === 1 ? '' : `translate(${s.x}px, ${s.y}px) scale(${s.zoom})`;
    el.dataset.zoom = String(s.zoom);
    el.classList.toggle('is-zoomed', s.zoom > 1);
    // Past the phone-sized copy of a big page: the original.
    if (s.zoom > 1) {
      for (const img of stage.querySelectorAll('img.comic-page')) {
        if (Math.max(img.naturalWidth, img.naturalHeight) === SCALED && !img.src.includes('full=1')) img.src = `${urlOf(Number(img.dataset.n))}?full=1`;
      }
    }
  }
  const pan = (dx, dy) => {
    s.x += dx;
    s.y += dy;
    zoomed();
  };

  // ---- input ----
  const pointers = new Map();
  let pinch = null;
  let drag = null;
  let lastTap = 0;
  holder.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    holder.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: s.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      drag = null;
    } else drag = { x: e.clientX, y: e.clientY, sx: s.x, sy: s.y, moved: false };
  });
  holder.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      setZoom((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, pinch.cx, pinch.cy);
    } else if (drag && s.zoom > 1) {
      drag.moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
      s.x = drag.sx + (e.clientX - drag.x);
      s.y = drag.sy + (e.clientY - drag.y);
      zoomed();
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag || pointers.size) return;
    const dx = e.clientX - drag.x;
    const moved = drag.moved || Math.abs(dx) > 50;
    const d = drag;
    drag = null;
    if (s.zoom > 1 && d.moved) return;
    if (!moved || s.zoom > 1) return tap(e);
    // A swipe: towards the next page (from right to left; the other way for manga).
    if ((dx < 0) !== rtl) forward();
    else back();
  };
  holder.addEventListener('pointerup', up);
  holder.addEventListener('pointercancel', (e) => (pointers.delete(e.pointerId), (drag = null), (pinch = null)));
  function tap(e) {
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      clearTimeout(tap.timer);
      setZoom(s.zoom > 1 ? 1 : 2, e.clientX, e.clientY);
      return;
    }
    lastTap = now;
    clearTimeout(tap.timer);
    // A single tap waits a moment: it may be the first of two.
    tap.timer = setTimeout(() => {
      if (s.zoom > 1) return;
      const r = holder.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < r.width / 3) rtl ? forward() : back();
      else if (x > (r.width * 2) / 3) rtl ? back() : forward();
      else toggleBar(bar.hidden);
    }, 280);
  }
  function onKey(e) {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const k = e.key;
    const step = Math.round(holder.clientHeight * 0.25);
    const panel = ownButton(bar, end);
    if (panel && (k === 'ArrowRight' || k === 'ArrowLeft')) {
      e.preventDefault();
      moveWithin(panel, k === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (panel && (k === 'Enter' || k === ' ')) return; // the button's own press
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      e.preventDefault();
      if (!end.hidden) return;
      const towardsNext = (k === 'ArrowRight') !== rtl;
      towardsNext ? forward() : back();
    } else if ((k === 'ArrowDown' || k === 'ArrowUp') && s.zoom > 1) {
      e.preventDefault();
      pan(0, k === 'ArrowDown' ? -step : step);
    } else if (k === 'Enter' && bar.hidden && end.hidden) {
      e.preventDefault();
      setZoom(s.zoom > 1 ? 1 : 2);
    } else if (k === ' ' || k === 'PageDown') {
      e.preventDefault();
      forward();
    } else if (k === 'PageUp') {
      e.preventDefault();
      back();
    } else if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(k)) {
      e.preventDefault();
      if (!bar.hidden) toggleBar(false);
      else if (s.zoom > 1) setZoom(1);
      else close();
    } else if (k === 'ContextMenu' || k === 'm') toggleBar(bar.hidden);
  }
  function toggleBar(on) {
    bar.hidden = !on;
    if (on) fitBtn.focus();
    else holder.focus();
  }
  function cycleFit() {
    fit = FITS[(FITS.indexOf(fit) + 1) % FITS.length];
    el.dataset.fit = fit;
    fitBtn.textContent = FIT_WORDS[fit];
    setZoom(1);
    updatePrefs({ comicFit: fit }).catch((err) => toast(err.message, { type: 'error' }));
  }

  // ---- the end, and the place ----
  async function finish() {
    if (s.finished) return;
    s.finished = true;
    writePlace(0); // read: next time from the start
    sendPlace({ watched: true });
    let next = null;
    if (series) {
      const sd = await api.get(`/api/items/${series.id}`).catch(() => null);
      const books = sd?.books || [];
      const at = books.findIndex((b) => b.id === comic.id);
      next = at >= 0 ? books.slice(at + 1).find((b) => !b.needsTool) || null : null;
    }
    const read = next ? h('a', { class: 'btn btn-primary', href: `#/read/${next.id}` }, 'Read it') : null;
    clear(end).append(
      h('p', {}, next ? `Next issue: ${next.issue ? `#${next.issue}` : next.title}` : `You finished ${comic.title}.`),
      h('div', { class: 'actions' }, read, h('a', { class: `btn ${next ? 'btn-ghost' : 'btn-primary'}`, href: series ? `#/item/${series.id}` : `#/item/${comic.id}` }, series ? 'Back to the series' : 'Back')),
    );
    end.hidden = false;
    end.querySelector('.btn').focus();
  }
  function sendPlace({ watched = false } = {}) {
    const page = firstPage();
    const body = { position: watched ? count : page, duration: count, locator: { page }, device, pages: s.turned, ...(watched ? { watched: true } : {}) };
    s.turned = 0;
    send(body);
  }
  const timer = setInterval(() => document.visibilityState === 'visible' && !s.finished && sendPlace(), REPORT_MS);
  const onHide = () => document.visibilityState === 'hidden' && !s.finished && sendPlace();
  const onResize = () => {
    clearTimeout(onResize.t);
    onResize.t = setTimeout(() => {
      build(firstPage());
      paint();
    }, 150);
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (!s.finished) sendPlace();
    leave();
  }

  if (!count) {
    where.textContent = comic.needsTool ? `${comic.needsTool}.` : 'This comic has no pages.';
    return () => window.removeEventListener('keydown', onKey);
  }
  // Where to start: the newest of this device's own place and the one Atomix knows (a finished comic starts over).
  const p = comic.progress;
  const mine = readPlace();
  const known = p && !p.watched ? { page: p.locator?.page ?? Math.round(p.position) ?? 0, at: p.updatedAt || 0 } : p?.watched ? { page: 0, at: p.updatedAt || 0 } : null;
  const start = mine && (!known || mine.at >= known.at) ? mine.page : known?.page ?? 0;
  build(Math.max(0, Math.min(count - 1, start)));
  paint();
  holder.focus();

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    if (!closed && !s.finished) sendPlace();
  };
}
