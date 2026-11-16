// Moving around Atomix (v0.28, "Capture"). The rules are in motion-rules.js; this file does them on the page.
// - Screen changes: opening a card brings the next page toward you, its poster travelling into the detail page's
//   poster; Back goes the other way; a new section is a flat fade. Browsers without view transitions (and Reduce
//   motion's "none") keep the plain page fade.
// - Card motion v2: the card's art travels into the title page's backdrop (or its poster when it has no backdrop) and
//   the card's title into the page title; the page's first blocks rise in after (meta, plot, buttons, first row).
//   Back goes into the same card, which gets the focus with its row scrolled as it was (with or without a change).
// - Card motion v2, the first-screen ripple: the first time a page with rows is drawn (Home, a library; not on Back,
//   not when the same page is drawn again), its cards on screen fade and rise 8 px in, 20 ms apart, ≤ 300 ms in all.
//   Reduce: a fade, all together; none or a held key: nothing.
// - The focus "capture": after the remote rests on a card, a thin orbit draws once around it; pressing OK sends one
//   ring outward. Both are decoration on top of the focus ring, which always appears at once.
import { pickTransition } from './motion-rules.js';
import { motionLevel } from './motion.js';
import { backdropLayer, backdropShowing, backdropReady } from './backdrop.js';

const root = () => document.documentElement;
const supported = () => typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
const visible = (el) => {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};
const detailPoster = (scope) => scope.querySelector('.detail-poster .art');
/** On screen and really seen: a real box (not a visually-hidden 1 px one), not hidden or see-through. */
const shown = (el) => {
  if (!visible(el)) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2 && (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true);
};
/**
 * What a title page's art is, for the change: its backdrop (the full-screen artwork behind the page) when it has one,
 * else its poster where the page shows one, else the backdrop showing the poster (Orbit hides the page poster). Pages
 * that don't say (music, books) keep the poster. `backdrop: false` (its picture hasn't loaded yet): the page poster
 * where it shows one, else nothing (the card's art leaves with the old page: a plain fade).
 */
function pageArt(scope, { backdrop = true } = {}) {
  const kind = scope.querySelector('.detail-header')?.dataset.art;
  const poster = detailPoster(scope);
  if ((kind !== 'backdrop' || !backdrop) && poster && shown(poster)) return poster;
  if (backdrop && kind && backdropShowing() && shown(backdropLayer)) return backdropLayer;
  return null;
}
/** A title page's title: its logo when it shows, else the heading. */
function pageTitle(scope) {
  const logo = scope.querySelector('.detail-header .detail-logo');
  if (logo && shown(logo)) return logo;
  const heading = scope.querySelector('.detail-header .detail-title');
  return heading && shown(heading) ? heading : null;
}
const samePage = (a, b) => typeof a === 'string' && typeof b === 'string' && a.split('?')[0] === b.split('?')[0];
const OPEN_BUDGET = 300; // ms from the press: a page slower than this comes in with a plain fade, not a late morph

// ---- What the last address change was ----
let step = { dir: 'none', from: null };
let opened = null; // the card last opened: { href, art, title, at }

// ---- Where Back returns: per page, the card opened from it ----
const returns = new Map(); // page address → { href, row, rowIndex, index, left, tops }

/** The card Back to `page` returns to (a live record: tests change it to stand for a re-drawn page). */
export function returnPoint(page) {
  return returns.get(page) || null;
}

/** Everything above the card that scrolls up and down (and the page itself), with where it is now. */
function scrollTops(card, main) {
  const out = [];
  for (let el = card.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    if (el === main) out.push(['main', el.scrollTop]);
    else if (el.scrollHeight > el.clientHeight + 1 && el.classList[0] && /auto|scroll/.test(getComputedStyle(el).overflowY)) out.push([`.${el.classList[0]}`, el.scrollTop]);
  }
  out.push([null, (document.scrollingElement || document.documentElement).scrollTop]);
  return out;
}

function remember(card) {
  const main = card.closest('main');
  if (!main) return;
  const row = card.closest('.row');
  const cards = row ? [...row.querySelectorAll('a.card')] : [];
  returns.delete(location.hash || '#/');
  returns.set(location.hash || '#/', {
    href: card.getAttribute('href'),
    row: row?.dataset.row || null,
    rowIndex: row ? [...main.querySelectorAll('.row')].indexOf(row) : -1,
    index: cards.indexOf(card),
    left: card.closest('.row-scroller')?.scrollLeft || 0,
    tops: scrollTops(card, main),
  });
  if (returns.size > 30) returns.delete(returns.keys().next().value);
}

/** The card a record points at on the page now: the same place in the same row, else the same title anywhere. */
function findCard(main, rec) {
  const same = (a) => a && samePage(a.getAttribute('href'), rec.href);
  const rows = [...main.querySelectorAll('.row')];
  const row = (rec.row && rows.find((r) => r.dataset.row === rec.row)) || (rec.row ? null : rows[rec.rowIndex]) || null;
  const inRow = row ? [...row.querySelectorAll('a.card')] : [];
  if (same(inRow[rec.index])) return inRow[rec.index];
  return inRow.find(same) || [...main.querySelectorAll('a.card')].find(same) || null;
}

/** The address changed (hashchange): 'forward', 'back' or 'none', and the address left. */
export function noteStep(dir, from = null) {
  step = { dir, from };
}

// ---- The first-screen ripple ----
const rippling = new WeakSet(); // the pages (their .view) that ripple in when first drawn
let lastPage = null; // the address the last page change drew (the same one again is a re-draw)
const RIPPLE_DUR = 160;
const RIPPLE_TOTAL = 300; // the last card's delay plus its fade
const RIPPLE_EASE = 'cubic-bezier(0.05, 0.7, 0.1, 1)'; // --ease-out

/** A page with rows (Home, a library) asks for the ripple when it is first drawn: call while it mounts. */
export function rippleOnArrival(view) {
  if (view) rippling.add(view);
}

/** The cards on screen fade (and, with full motion, rise) in, one after another. */
function ripple(view) {
  const tier = motionLevel();
  if (tier === 'none' || root().classList.contains('nav-held')) return;
  // Never the focused card: its focus ring must show on the same frame as the focus, not fade in with the others.
  const focused = document.activeElement;
  const cards = [...view.querySelectorAll('a.card')].filter((c) => c !== focused && typeof c.animate === 'function' && visible(c));
  if (!cards.length) return;
  const css = getComputedStyle(root());
  const full = tier === 'full';
  const stepMs = full ? parseFloat(css.getPropertyValue('--ripple-step')) || 0 : 0;
  const rise = (full && css.getPropertyValue('--ripple-rise').trim()) || '0px';
  // `translate`, not `transform`: it adds to whatever a theme's card already does (a focused card's growth).
  const frames = full && rise !== '0px' ? [{ opacity: 0, translate: `0 ${rise}` }, { opacity: 1, translate: '0 0' }] : [{ opacity: 0 }, { opacity: 1 }];
  const anims = new Map();
  cards.forEach((card, i) => {
    anims.set(card, card.animate(frames, { duration: RIPPLE_DUR, delay: Math.min(i * stepMs, RIPPLE_TOTAL - RIPPLE_DUR), easing: RIPPLE_EASE, fill: 'backwards' }));
  });
  // A card focused while the ripple runs (the remote got there first): shown at once, with its focus ring.
  const onFocus = (e) => anims.get(e.target.closest?.('a.card'))?.finish();
  document.addEventListener('focusin', onFocus);
  setTimeout(() => document.removeEventListener('focusin', onFocus), RIPPLE_TOTAL + 50);
}

// ---- One page change at a time ----
let current = null;

class PageChange {
  constructor(main) {
    this.main = main;
    const fromPage = document.body.dataset.view === 'page';
    const was = opened && opened.href === location.hash && performance.now() - opened.at < 4000;
    // Never from a held key (html.nav-held): the remote is racing along, the page just changes.
    const held = root().classList.contains('nav-held');
    // The ripple: a page drawn for the first time (not Back, not the same address drawn again).
    const here = location.hash || '#/';
    this.mayRipple = step.dir !== 'back' && !(lastPage && samePage(lastPage, here));
    lastPage = here;
    this.kind = held ? 'none' : pickTransition({ tier: motionLevel(), supported: supported(), dir: step.dir, fromPage, toPage: true, opened: Boolean(was) });
    this.openedAt = was ? opened.at : 0;
    this.fromCard = Boolean(was); // a card opened this page: its first blocks rise in
    this.leaving = step.from;
    // Back to a page a card was opened from: that card gets the focus again (whatever change plays, or none).
    const rec = step.dir === 'back' ? returns.get(location.hash || '#/') : null;
    this.back = rec && samePage(rec.href, step.from) ? rec : null;
    if (this.back) returns.delete(location.hash || '#/');
    step = { dir: 'none', from: null };
    this.timer = null;
    this.still = null;
    this.restored = false;
    this.oldNames = new Set();
    this.named = [];
    this.oldBackdrop = false;
    this.backdropReady = true; // open: false when the page's backdrop picture wasn't there within the budget
    if (this.kind === 'none') return;
    // What travels, named now so the copy of the page below carries the names: the card's art and title (open),
    // the page's art and title (back). The backdrop is outside the page: it is named just before the change starts.
    let pairs = [];
    if (this.kind === 'open') pairs = [['poster', opened.art], ['title', opened.title]];
    else if (this.kind === 'back') {
      const art = pageArt(main);
      if (art === backdropLayer) this.oldBackdrop = true;
      pairs = [['poster', art === backdropLayer ? null : art], ['title', pageTitle(main)]];
    }
    pairs = pairs.filter(([, el]) => el && shown(el));
    for (const [name, el] of pairs) {
      el.style.viewTransitionName = name;
      this.oldNames.add(name);
    }
    if (this.oldBackdrop) this.oldNames.add('poster');
    // A still copy of the page stays up while the next one loads (leaving runs the old page's cleanup, which can
    // empty it), so the change starts from what was on screen. It can't be used: it is inert.
    this.still = [...main.children].map((n) => n.cloneNode(true));
    this.scrolls = scrolledIn(main.children, this.still); // copies start unscrolled: rows would jump back
    for (const [, el] of pairs) el.style.viewTransitionName = '';
  }

  /** After the old page's cleanup: show the still copy (nothing, for a change without a transition). */
  hold() {
    if (!this.still) return false;
    root().classList.add('vt-hold');
    this.main.replaceChildren(...this.still);
    for (const n of this.still) n.inert = true;
    for (const [el, left, top] of this.scrolls) {
      el.scrollLeft = left;
      el.scrollTop = top;
    }
    return true;
  }

  /** The next page is taking a while: show `showSpinner` after a moment, not at once (no flash for quick pages). */
  later(showSpinner) {
    this.timer = setTimeout(() => {
      if (current !== this) return;
      root().classList.remove('vt-hold');
      showSpinner();
    }, 400);
  }

  /**
   * Put the new page in: `swap` does the DOM change, inside a view transition when there is one. Resolves once the
   * new page is in (a view transition runs `swap` a frame later), so focus and scrolling can follow it; then call
   * finish(), which names the poster the change travels to (where the page has settled it).
   */
  swap(swap) {
    clearTimeout(this.timer);
    // The DOM change itself, then focus and scrolling for Back, all at once (inside the change when there is one).
    const run = (animated) => {
      swap();
      this.view = this.main.querySelector('.view'); // this change's page (a later one may replace it before the end)
      this.restored = this.restore();
      if (this.mayRipple && !this.restored && rippling.has(this.view)) ripple(this.view);
      // Full motion only: under reduce the crossfade is the whole change.
      if (animated && this.fromCard && motionLevel() === 'full') this.rise();
    };
    if (this.kind === 'none' || !supported() || document.activeViewTransition) {
      this.end();
      run(false);
      return Promise.resolve();
    }
    // The page took a while: a morph starting long after the press feels late, so a plain fade instead.
    const left = OPEN_BUDGET - (performance.now() - this.openedAt);
    if (this.kind === 'open' && left <= 0) {
      this.kind = 'section';
      for (const el of namedIn(this.still)) el.style.viewTransitionName = '';
      this.oldNames.clear();
    }
    // The page's backdrop (set while it was drawn) must be loaded before the art may travel into it: waited for
    // within what is left of the budget, never longer; not there by then, the page poster or a plain fade (finish).
    if (this.kind === 'open' && backdropShowing()) {
      const late = new Promise((resolve) => setTimeout(() => resolve(false), left));
      return Promise.race([backdropReady(), late]).then((ok) => {
        if (current !== this) return; // a newer page change took over while waiting: it draws its own page
        this.backdropReady = ok;
        return this.start(run);
      });
    }
    return this.start(run);
  }

  /** Start the view transition that runs `run` (swap's DOM change); resolves once the new page is in. */
  start(run) {
    if (document.activeViewTransition) {
      this.end();
      run(false);
      return Promise.resolve();
    }
    const cls = ['vt', `vt-${this.kind}`];
    root().classList.add(...cls);
    if (this.oldBackdrop) backdropLayer.style.viewTransitionName = 'poster';
    this.transition = document.startViewTransition(() => {
      backdropLayer.style.viewTransitionName = ''; // the old page's: the new one names its own (finish)
      run(true);
      // Back to a card that has gone or is off screen: nothing to go into, so a plain fade, not the page shrinking away.
      if (this.kind === 'back' && this.back && !this.returnCard) {
        root().classList.replace('vt-back', 'vt-section');
        this.kind = 'section';
      }
      root().classList.remove('vt-hold');
    });
    const done = () => {
      this.ended = true;
      root().classList.remove('vt', 'vt-open', 'vt-back', 'vt-section', 'vt-lone-poster', 'vt-lone-title', 'vt-to-backdrop');
      // The change was the page's entrance: its own fade-in (held off by html.vt) would now play a second time.
      for (const a of this.view?.getAnimations() || []) if (a.animationName === 'fade-in') a.finish();
      backdropLayer.style.viewTransitionName = '';
      for (const el of this.named) el.style.viewTransitionName = '';
      this.named = [];
      if (current === this) current = null;
    };
    this.transition.finished.then(done, done);
    return this.transition.updateCallbackDone.catch(() => {});
  }

  /** The new page has its focus and scroll: name where the poster lands (captured on the next frame). */
  finish() {
    if (!this.transition || this.ended) return; // skipped or over already: nothing may stay named
    let pairs = [];
    if (this.kind === 'open') pairs = [['poster', pageArt(this.main, { backdrop: this.backdropReady })], ['title', pageTitle(this.main)]];
    else if (this.kind === 'back') {
      // Into the card Back returned to, only if it was on screen where it was left; with no record (the page wasn't
      // opened from a card here), the card for the page left, if this page has one.
      const card = this.back ? this.returnCard : this.leaving ? cardFor(this.main, this.leaving)?.closest('a.card') : null;
      pairs = [['poster', card?.querySelector('.card-art')], ['title', card?.querySelector('.card-title')]];
    }
    for (const [name, el] of pairs) {
      // Only pairs travel: a name only on the new page would just fade in on its own, apart from the page.
      if (!el || !this.oldNames.has(name) || !shown(el)) continue;
      el.style.viewTransitionName = name;
      this.named.push(el);
      // The page's backdrop is a full-screen picture: the page itself must stay above it while it grows.
      if (el === backdropLayer) root().classList.add('vt-to-backdrop');
    }
    // A name only on the old page (its card has gone, or is off screen) leaves with the page, not on its own.
    for (const name of this.oldNames) if (!this.named.some((el) => el.style.viewTransitionName === name)) root().classList.add(`vt-lone-${name}`);
  }

  /** Back to a page a card was opened from: that card, its row scrolled as it was, gets the focus. */
  restore() {
    const rec = this.back;
    this.returnCard = null;
    if (!rec) return false;
    const card = findCard(this.main, rec);
    if (!card) return false;
    card.focus({ preventScroll: true }); // first: focusing can change the layout (Orbit's Home gets compact)
    for (const [sel, top] of rec.tops) {
      const el = sel === null ? document.scrollingElement || document.documentElement : sel === 'main' ? this.main : this.main.querySelector(sel);
      if (el) el.scrollTop = top;
    }
    const scroller = card.closest('.row-scroller');
    if (scroller) scroller.scrollLeft = rec.left;
    // Off screen where it was left (a re-drawn row): no morph into it, but it is brought into view.
    const art = card.querySelector('.card-art');
    this.returnCard = art && visible(art) ? card : null;
    if (!visible(card)) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  /** The title page's first blocks (marked data-rise) come in one after another (CSS: tiers, timings). */
  rise() {
    const view = this.main.querySelector('.view');
    if (!view || !view.querySelector('[data-rise]')) return;
    const cls = this.kind === 'open' ? ['is-opening', 'after-morph'] : ['is-opening'];
    view.classList.add(...cls);
    setTimeout(() => view.classList.remove(...cls), 700); // all done by then (≤ 200 ms after a ≤ 200 ms wait)
  }

  /** Give up (an error page, a redirect): no copy, no spinner timer. */
  end() {
    clearTimeout(this.timer);
    root().classList.remove('vt-hold');
    if (current === this) current = null;
  }
}

/** Walk the originals and their copies side by side: the copies of anything scrolled, with where it was. */
function scrolledIn(originals, copies) {
  const out = [];
  [...originals].forEach((o, i) => {
    const a = document.createTreeWalker(o, NodeFilter.SHOW_ELEMENT);
    const b = document.createTreeWalker(copies[i], NodeFilter.SHOW_ELEMENT);
    for (let x = a.currentNode, y = b.currentNode; x && y; x = a.nextNode(), y = b.nextNode()) {
      if (x.scrollLeft || x.scrollTop) out.push([y, x.scrollLeft, x.scrollTop]);
    }
  });
  return out;
}

/** The elements in the still copy that carry a name. */
function namedIn(nodes) {
  const out = [];
  for (const n of nodes || []) for (const el of [n, ...n.querySelectorAll('*')]) if (el.style?.viewTransitionName) out.push(el);
  return out;
}

/** The card on a page that opens `href` (the one Back returns to), or null. */
function cardFor(main, href) {
  const card = [...main.querySelectorAll('a.card')].find((a) => a.getAttribute('href') === href);
  return card?.querySelector('.card-art') || null;
}

/** A page change is starting (call before the old page's cleanup). */
export function beginPageChange(main) {
  current?.end();
  current = new PageChange(main);
  return current;
}

// ---- The focus capture ----
const SVG = 'http://www.w3.org/2000/svg';
let arc = null;
let restTimer = null;

function makeArc() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'capture-arc');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%', pathLength: '1' })) rect.setAttribute(k, v);
  svg.append(rect);
  svg.addEventListener('animationend', (e) => {
    if (e.animationName === 'capture-fade') svg.remove();
  });
  return svg;
}

function dropArc() {
  clearTimeout(restTimer);
  arc?.remove();
}

const quiet = () => motionLevel() !== 'full' || root().classList.contains('nav-held');

/** Start the capture and the press ring. Once, at boot. */
export function initCapture() {
  arc = makeArc();
  document.addEventListener('focusin', (e) => {
    dropArc();
    const art = e.target.closest?.('.card')?.querySelector('.card-art');
    if (!art || !root().classList.contains('kbd') || quiet()) return;
    // Only once the remote rests: moving on before then draws nothing.
    restTimer = setTimeout(() => {
      if (document.activeElement?.contains(art) && !quiet()) art.append(arc);
    }, 260);
  });
  document.addEventListener('focusout', dropArc);
  document.addEventListener('keydown', (e) => {
    if (e.repeat) dropArc();
  });
  // Opening a card (OK or a click): remember it for the screen change, and send one ring outward.
  document.addEventListener('click', (e) => {
    const card = e.target.closest?.('a.card');
    if (!card || e.defaultPrevented) return;
    const art = card.querySelector('.card-art');
    opened = { href: card.getAttribute('href'), art, title: card.querySelector('.card-title'), at: performance.now() };
    remember(card);
    if (!art || quiet()) return;
    dropArc();
    const ring = document.createElement('span');
    ring.className = 'press-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.addEventListener('animationend', () => ring.remove());
    art.append(ring);
  }, true);
}
