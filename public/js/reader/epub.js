// The EPUB reader (v0.22 Plan D), phones and tablets first. Each chapter is one of the book's own files, served by
// Atomix (or, offline, by the offline helper) with a policy that lets nothing run, in a frame sandboxed without
// scripts; the app lays it out in columns, one screen per page. The place kept is the chapter and a text offset, so a
// new text size, font or a turned phone land on the same words. Taps on the left or right third, swipes, the arrow
// keys and the remote turn pages; the middle (or OK) opens the bar: Contents, Aa (text and page), Back.
import { api } from '../api.js';
import { h, icon, clear } from '../dom.js';
import { openDialog, openSheet, field, toast } from '../components.js';
import { state, updatePrefs } from '../app.js';
import { pageOfOffset, minutesLeft, statusText, bookPercent, deviceKind, WPM } from './paging.js';

const REPORT_MS = 30_000;
const THEMES = { light: ['#fbfaf7', '#1b1b1b'], sepia: ['#f3ead7', '#47392a'], dark: ['#121212', '#d8d8d8'] };
const FONTS = { serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif", sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" };
// The widest a page's text gets for each Margins choice (a wide screen's lines would be too long to read).
const MAX_TEXT_PX = { small: 860, medium: 720, large: 580 };
const MARGINS = { small: 0.04, medium: 0.07, large: 0.11 };
const DEVICE_WORDS = { phone: 'your phone', tablet: 'your tablet', computer: 'your computer', TV: 'your TV' };

/** What kind of device this is (a test or a person may pin it in localStorage 'atomix-device'). */
export function thisDevice() {
  try {
    const pinned = localStorage.getItem('atomix-device');
    if (pinned) return pinned;
  } catch {
    /* private mode */
  }
  return deviceKind({ ua: navigator.userAgent, touch: matchMedia('(pointer: coarse)').matches, short: Math.min(screen.width, screen.height) });
}
/** The remote's Left/Right between the buttons of a bar or a panel (a full-screen page moves its own focus). */
export function moveWithin(container, dir) {
  const items = [...container.querySelectorAll('button:not([disabled]), a[href]')].filter((b) => b.offsetParent !== null);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + dir))].focus();
}
/** A button of the reader's own (bar, jump, end) has the focus: OK presses it, Left/Right move between them. */
export const ownButton = (...parts) => parts.find((p) => !p.hidden && p.contains(document.activeElement) && document.activeElement !== p) || null;

const localKey = (itemId) => `atomix-read-${state.profile?.id ?? 0}-${itemId}`;
function readLocal(itemId) {
  try {
    return JSON.parse(localStorage.getItem(localKey(itemId)) || 'null');
  } catch {
    return null;
  }
}
function writeLocal(itemId, place) {
  try {
    localStorage.setItem(localKey(itemId), JSON.stringify(place));
  } catch {
    /* private mode: the server keeps the place */
  }
}
/** Each part of an entry's path escaped for a URL ("OEBPS/Text/Chapter 1.xhtml"). */
const entryUrl = (base, entry) => base + entry.split('/').map(encodeURIComponent).join('/');

/**
 * @param {HTMLElement} el the page
 * @param {{ base: string, data: object, leave: () => void, report?: (body) => Promise<void> }} opts
 *   `data` is GET /api/items/:id of a book (item, spine, toc, opfDir); `report` sends the place (offline: queued).
 * @returns {() => void} cleanup
 */
export function openEpubReader(el, { base, data, leave, report = null }) {
  const book = data.item;
  const spine = data.spine || [];
  const device = thisDevice();
  const send = report || ((body) => api.post(`/api/items/${book.id}/progress`, body).catch(() => {}));
  let prefs = { ...(state.profile?.prefs || {}) };
  const s = { chapter: 0, page: 0, pages: 1, offset: 0, starts: [0], width: 0, height: 0, turned: 0, finished: false, ready: false };

  el.classList.add('reader-view');
  const frame = h('iframe', { class: 'reader-frame', sandbox: 'allow-same-origin', title: book.title, tabindex: '-1' });
  const status = h('p', { class: 'reader-status', 'aria-live': 'off' });
  const title = h('p', { class: 'reader-title' }, book.title);
  const bar = h(
    'div',
    { class: 'reader-bar', hidden: true },
    h('button', { type: 'button', class: 'btn btn-ghost btn-icon reader-back', 'aria-label': 'Back', onClick: () => close() }, icon('back')),
    title,
    h('button', { type: 'button', class: 'btn btn-ghost reader-toc-btn', onClick: () => contents() }, icon('list'), h('span', {}, 'Contents')),
    h('button', { type: 'button', class: 'btn btn-ghost reader-settings-btn', 'aria-label': 'Text and page', onClick: () => settings() }, h('span', { 'aria-hidden': 'true', class: 'reader-aa' }, 'Aa')),
  );
  const jump = h('div', { class: 'reader-jump', role: 'status', hidden: true });
  const end = h('div', { class: 'reader-end', hidden: true });
  el.append(h('div', { class: 'reader-page' }, frame), status, bar, jump, end);

  // ---- the chapter's text: offsets ⇄ places on the page ----
  const doc = () => frame.contentDocument;
  function textNodes() {
    const d = doc();
    const out = [];
    if (!d?.body) return out;
    const walk = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n);
    return out;
  }
  function offsetOf(node, at) {
    let total = 0;
    for (const n of textNodes()) {
      if (n === node) return total + at;
      total += n.data.length;
    }
    return total;
  }
  function pointAt(offset) {
    let left = offset;
    const nodes = textNodes();
    for (const n of nodes) {
      if (left < n.data.length || n === nodes[nodes.length - 1]) return { node: n, at: Math.max(0, Math.min(left, n.data.length)) };
      left -= n.data.length;
    }
    return null;
  }
  /** The text offset at the top left of the page showing now. */
  function offsetHere() {
    const d = doc();
    const m = margins();
    const x = m.h + 2;
    for (let y = m.v + 2; y < s.height - m.v; y += 12) {
      const r = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : (() => { const p = d.caretPositionFromPoint?.(x, y); if (!p) return null; const rr = d.createRange(); rr.setStart(p.offsetNode, p.offset); return rr; })();
      if (r && r.startContainer?.nodeType === 3) return offsetOf(r.startContainer, r.startOffset);
    }
    return s.starts[s.page] ?? 0;
  }
  function pageOfPoint(offset) {
    const p = pointAt(offset);
    if (!p) return 0;
    const r = doc().createRange();
    r.setStart(p.node, p.at);
    r.setEnd(p.node, Math.min(p.at + 1, p.node.data.length));
    const rect = r.getClientRects()[0] || r.getBoundingClientRect();
    const x = rect.left + doc().documentElement.scrollLeft;
    return Math.max(0, Math.min(s.pages - 1, Math.floor(x / s.width)));
  }

  // ---- layout ----
  function margins() {
    const h = Math.max(12, Math.round(s.width * (MARGINS[prefs.readerMargins] ?? MARGINS.medium)));
    // On a wide screen the text keeps a readable width (about 46em): the rest is margin on both sides.
    const cap = MAX_TEXT_PX[prefs.readerMargins] ?? MAX_TEXT_PX.medium;
    return { h: Math.max(h, Math.round((s.width - cap) / 2)), v: Math.max(16, Math.round(s.height * 0.04)) };
  }
  function colours() {
    const t = prefs.readerTheme || 'light';
    if (t === 'app') {
      const cs = getComputedStyle(document.body);
      return [cs.getPropertyValue('--bg').trim() || '#000', cs.getPropertyValue('--text').trim() || '#fff'];
    }
    return THEMES[t] || THEMES.light;
  }
  function style() {
    const d = doc();
    if (!d?.documentElement) return;
    s.width = frame.clientWidth;
    s.height = frame.clientHeight;
    const m = margins();
    const [bg, fg] = colours();
    const font = FONTS[prefs.readerFont];
    let st = d.getElementById('atomix-reader-style');
    if (!st) {
      st = d.createElement('style');
      st.id = 'atomix-reader-style';
      (d.head || d.documentElement).append(st);
    }
    st.textContent = `
      html { margin: 0 !important; padding: 0 !important; height: ${s.height}px !important; overflow: hidden !important; background: ${bg} !important; }
      body { margin: ${m.v}px ${m.h}px !important; padding: 0 !important; height: ${s.height - 2 * m.v}px !important; box-sizing: border-box;
        column-width: ${s.width - 2 * m.h}px !important; column-gap: ${2 * m.h}px !important; column-fill: auto !important;
        color: ${fg} !important; background: transparent !important; font-size: ${(prefs.readerText || 100) * 1.08}% !important;
        line-height: ${prefs.readerSpacing || 1.5} !important; overflow-wrap: break-word; -webkit-text-size-adjust: none; }
      ${font ? `body, body * { font-family: ${font} !important; }` : ''}
      body * { color: inherit !important; max-width: 100% !important; }
      img, svg, video { max-height: ${s.height - 2 * m.v}px !important; height: auto; object-fit: contain; break-inside: avoid; }
      a { text-decoration: underline; }`;
    el.dataset.theme = prefs.readerTheme || 'light';
    el.style.setProperty('--reader-bg', bg);
    el.style.setProperty('--reader-fg', fg);
  }
  function measure() {
    const d = doc();
    s.pages = Math.max(1, Math.round(d.documentElement.scrollWidth / s.width));
    // Each page's first text offset, sampled at its top left.
    const at = s.page;
    s.starts = [];
    for (let p = 0; p < s.pages; p++) {
      d.documentElement.scrollLeft = p * s.width;
      s.starts.push(offsetHere());
    }
    for (let p = 1; p < s.starts.length; p++) if (s.starts[p] < s.starts[p - 1]) s.starts[p] = s.starts[p - 1];
    s.page = Math.min(at, s.pages - 1);
    d.documentElement.scrollLeft = s.page * s.width;
  }
  function show(page) {
    s.page = Math.max(0, Math.min(s.pages - 1, page));
    doc().documentElement.scrollLeft = s.page * s.width;
    s.offset = s.starts[s.page] ?? 0;
    paint();
  }
  /** Lay the chapter out again (a new text size, a turned phone) and go back to the same words. */
  function relayout() {
    if (!s.ready) return;
    const keep = s.offset;
    style();
    measure();
    show(pageOfOffset(s.starts, keep));
    s.offset = keep;
    paint();
  }
  function percent() {
    return bookPercent({ chapter: s.chapter, page: s.page, pages: s.pages, chapters: spine.length });
  }
  function paint() {
    const text = doc()?.body?.textContent || '';
    const wordsLeft = text.slice(s.offset).split(/\s+/).filter(Boolean).length;
    status.textContent = statusText({ chapter: s.chapter + 1, percent: percent(), minutes: minutesLeft(wordsLeft, speed()) });
    Object.assign(el.dataset, { ready: String(s.ready), chapter: s.chapter, page: s.page, pages: s.pages, offset: s.offset });
    writeLocal(book.id, { at: Date.now(), chapter: s.chapter, offset: s.offset, device });
  }
  function speed() {
    try {
      return Number(localStorage.getItem('atomix-wpm')) || WPM;
    } catch {
      return WPM;
    }
  }

  // ---- chapters ----
  let loading = null;
  function load(chapter, { offset = 0, last = false, hash = null } = {}) {
    s.chapter = Math.max(0, Math.min(spine.length - 1, chapter));
    s.ready = false;
    el.dataset.ready = 'false';
    loading = new Promise((resolve) => {
      frame.addEventListener(
        'load',
        () => {
          wire();
          style();
          // Pictures that come late change the layout: once they are in, measure again.
          measure();
          s.ready = true;
          let page = last ? s.pages - 1 : pageOfOffset(s.starts, offset);
          if (hash) {
            const target = doc().getElementById(hash);
            if (target) page = Math.floor((target.getBoundingClientRect().left + doc().documentElement.scrollLeft) / s.width);
          } else if (!last && offset) page = Math.max(pageOfOffset(s.starts, offset), Math.min(pageOfPoint(offset), s.pages - 1));
          show(page);
          if (!last && !hash && offset) s.offset = offset;
          paint();
          resolve();
        },
        { once: true },
      );
    });
    frame.src = entryUrl(base, spine[s.chapter]);
    return loading;
  }
  function next() {
    if (!s.ready) return;
    s.turned++;
    if (s.page < s.pages - 1) return show(s.page + 1);
    if (s.chapter < spine.length - 1) return load(s.chapter + 1);
    finish();
  }
  function prev() {
    if (!s.ready) return;
    if (s.page > 0) return show(s.page - 1);
    if (s.chapter > 0) load(s.chapter - 1, { last: true });
  }
  function finish() {
    s.finished = true;
    sendPlace({ watched: true });
    clear(end).append(h('p', {}, `You finished ${book.title}.`), h('button', { type: 'button', class: 'btn btn-primary', onClick: () => close() }, 'Back'));
    end.hidden = false;
    end.querySelector('button').focus();
  }

  // ---- input ----
  let downX = null;
  function onKey(e) {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const k = e.key;
    const panel = ownButton(bar, jump, end);
    if (panel && (k === 'ArrowRight' || k === 'ArrowLeft')) {
      e.preventDefault();
      moveWithin(panel, k === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (panel && (k === 'Enter' || k === ' ')) return; // the button's own press
    if (['ArrowRight', 'PageDown', ' '].includes(k)) {
      e.preventDefault();
      if (bar.hidden) next();
    } else if (['ArrowLeft', 'PageUp'].includes(k)) {
      e.preventDefault();
      if (bar.hidden) prev();
    } else if (k === 'Enter' && bar.hidden && end.hidden) {
      e.preventDefault();
      toggleBar(true);
    } else if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(k)) {
      e.preventDefault();
      if (!bar.hidden) toggleBar(false);
      else close();
    }
  }
  function onClick(e) {
    const a = e.target.closest?.('a[href]');
    if (a) {
      e.preventDefault();
      follow(a.getAttribute('href'));
      return;
    }
    if (!bar.hidden) return toggleBar(false);
    const x = e.clientX;
    if (x < s.width / 3) prev();
    else if (x > (s.width * 2) / 3) next();
    else toggleBar(true);
  }
  function wire() {
    const d = doc();
    d.addEventListener('keydown', onKey);
    d.addEventListener('click', onClick);
    d.addEventListener('pointerdown', (e) => (downX = e.clientX));
    d.addEventListener('pointerup', (e) => {
      if (downX == null) return;
      const dx = e.clientX - downX;
      downX = null;
      if (Math.abs(dx) > 50) {
        e.preventDefault();
        if (dx < 0) next();
        else prev();
      }
    });
    // Forms in a book send nothing anywhere.
    d.addEventListener('submit', (e) => e.preventDefault(), true);
  }
  /** A link in the book: another place in it (outside links aren't followed). */
  function follow(href) {
    let url;
    try {
      url = new URL(href, frame.contentWindow.location.href);
    } catch {
      return;
    }
    const own = new URL(base, location.href);
    if (url.origin !== own.origin || !url.pathname.startsWith(own.pathname)) {
      toast("Links out of the book aren't opened here.");
      return;
    }
    const entry = decodeURIComponent(url.pathname.slice(own.pathname.length));
    const i = spine.indexOf(entry);
    if (i >= 0) load(i, { hash: url.hash ? decodeURIComponent(url.hash.slice(1)) : null });
  }
  function toggleBar(on) {
    bar.hidden = !on;
    el.classList.toggle('bar-open', on);
    if (on) bar.querySelector('.reader-toc-btn')?.focus();
    else frame.focus();
  }

  // ---- the bar ----
  function contents() {
    const toc = data.toc || [];
    if (!toc.length) return toast('This book has no table of contents.');
    const dir = data.opfDir ? `${data.opfDir}/` : '';
    openSheet(
      'Contents',
      toc.map((t) => ({
        label: `${'  '.repeat(t.level)}${t.title}`,
        icon: 'list',
        onSelect: () => {
          const [file, hash] = t.href.split('#');
          const i = spine.indexOf(dir + file);
          if (i >= 0) {
            toggleBar(false);
            load(i, { hash: hash || null });
          }
        },
      })),
    );
  }
  function settings() {
    let saveTimer = null;
    const save = (change) => {
      prefs = { ...prefs, ...change };
      relayout();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => updatePrefs(change).catch((err) => toast(err.message, { type: 'error' })), 300);
    };
    const sizeOut = h('output', {}, `${prefs.readerText || 100}%`);
    const size = h('input', { type: 'range', class: 'reader-text-size', min: '80', max: '200', step: '10', value: String(prefs.readerText || 100), 'aria-label': 'Text size' });
    size.addEventListener('input', () => {
      sizeOut.textContent = `${size.value}%`;
      save({ readerText: Number(size.value) });
    });
    const select = (name, label, options, value, key) => {
      const sel = h('select', { class: `reader-${name}` }, options.map(([v, text]) => h('option', { value: v, selected: String(value) === String(v) }, text)));
      sel.addEventListener('change', () => save({ [key]: key === 'readerSpacing' ? Number(sel.value) : sel.value }));
      return field(label, sel);
    };
    openDialog({
      title: 'Text and page',
      body: h(
        'div',
        { class: 'stack reader-settings' },
        h('div', { class: 'field' }, h('label', {}, 'Text size ', sizeOut), size),
        select('spacing', 'Line spacing', [['1.2', 'Close'], ['1.5', 'Normal'], ['1.8', 'Wide'], ['2', 'Widest']], prefs.readerSpacing || 1.5, 'readerSpacing'),
        select('font', 'Font', [['book', "The book's"], ['serif', 'Serif'], ['sans', 'Sans serif']], prefs.readerFont || 'book', 'readerFont'),
        select('theme', 'Page', [['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark'], ['app', 'Like the app']], prefs.readerTheme || 'light', 'readerTheme'),
        select('margins', 'Margins', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], prefs.readerMargins || 'medium', 'readerMargins'),
      ),
    });
  }

  // ---- the place ----
  function sendPlace({ watched = false } = {}) {
    if (!s.ready && !watched) return;
    const body = { position: watched ? 100 : percent(), duration: 100, locator: { chapter: s.chapter, offset: s.offset }, device, pages: s.turned, ...(watched ? { watched: true } : {}) };
    s.turned = 0;
    send(body);
  }
  const timer = setInterval(() => document.visibilityState === 'visible' && s.ready && !s.finished && sendPlace(), REPORT_MS);
  const onHide = () => document.visibilityState === 'hidden' && !s.finished && sendPlace();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('keydown', onKey);
  const onResize = () => {
    clearTimeout(onResize.t);
    onResize.t = setTimeout(relayout, 150);
  };
  window.addEventListener('resize', onResize);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (!s.finished) sendPlace();
    leave();
  }

  // Where to start: this device's own place; another device's newer one is offered (a finished book starts over).
  const server = book.progress && !book.progress.watched ? book.progress : null;
  const mine = readLocal(book.id);
  const from = mine && mine.chapter != null ? mine : server?.locator ? { chapter: server.locator.chapter, offset: server.locator.offset } : { chapter: 0, offset: 0 };
  load(from.chapter || 0, { offset: from.offset || 0 }).then(() => {
    frame.focus();
    // A newer place from anywhere else (another device, of any kind) that isn't where this one opened.
    const other = server?.locator && mine && server.updatedAt > (mine.at || 0) + 2000 && (server.locator.chapter !== s.chapter || Math.abs(server.locator.offset - s.offset) > 200);
    if (!other) return;
    const perPage = s.starts.length > 1 ? (s.starts[s.starts.length - 1] - s.starts[0]) / (s.starts.length - 1) || 1000 : 1000;
    const page = Math.floor(server.locator.offset / perPage) + 1;
    const go = h('button', { type: 'button', class: 'btn btn-primary' }, 'Jump');
    const stay = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Stay here');
    clear(jump).append(h('span', {}, `Jump to chapter ${server.locator.chapter + 1}, page ${page} (from ${DEVICE_WORDS[server.device] || 'another device'})?`), go, stay);
    jump.hidden = false;
    go.focus();
    go.addEventListener('click', () => ((jump.hidden = true), load(server.locator.chapter, { offset: server.locator.offset }).then(() => frame.focus())));
    stay.addEventListener('click', () => ((jump.hidden = true), frame.focus()));
  });

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    if (!closed && !s.finished) sendPlace();
  };
}
