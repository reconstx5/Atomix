// Moving around Atomix (v0.28, "Capture"). The rules are in motion-rules.js; this file does them on the page.
// - Screen changes: opening a card brings the next page toward you, its poster travelling into the detail page's
//   poster; Back goes the other way; a new section is a flat fade. Browsers without view transitions (and Reduce
//   motion's "none") keep the plain page fade.
// - The focus "capture": after the remote rests on a card, a thin orbit draws once around it; pressing OK sends one
//   ring outward. Both are decoration on top of the focus ring, which always appears at once.
import { pickTransition } from './motion-rules.js';
import { motionLevel } from './motion.js';

const root = () => document.documentElement;
const supported = () => typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
const visible = (el) => {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};
const detailPoster = (scope) => scope.querySelector('.detail-poster .art');

// ---- What the last address change was ----
let step = { dir: 'none', from: null };
let opened = null; // the card last opened: { href, art, at }

/** The address changed (hashchange): 'forward', 'back' or 'none', and the address left. */
export function noteStep(dir, from = null) {
  step = { dir, from };
}

// ---- One page change at a time ----
let current = null;

class PageChange {
  constructor(main) {
    this.main = main;
    const fromPage = document.body.dataset.view === 'page';
    const was = opened && opened.href === location.hash && performance.now() - opened.at < 4000;
    this.kind = pickTransition({ tier: motionLevel(), supported: supported(), dir: step.dir, fromPage, toPage: true, opened: Boolean(was) });
    this.leaving = step.from;
    step = { dir: 'none', from: null };
    this.timer = null;
    this.still = null;
    if (this.kind === 'none') return;
    // The element that travels, named now so the copy of the page below carries the name.
    const art = this.kind === 'open' ? opened.art : this.kind === 'back' ? detailPoster(main) : null;
    if (art && visible(art)) art.style.viewTransitionName = 'poster';
    // A still copy of the page stays up while the next one loads (leaving runs the old page's cleanup, which can
    // empty it), so the change starts from what was on screen. It can't be used: it is inert.
    this.still = [...main.children].map((n) => n.cloneNode(true));
    this.scrolls = scrolledIn(main.children, this.still); // copies start unscrolled: rows would jump back
    if (art) art.style.viewTransitionName = '';
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
    if (this.kind === 'none' || !supported() || document.activeViewTransition) {
      this.end();
      swap();
      return Promise.resolve();
    }
    const kind = this.kind;
    const cls = ['vt', `vt-${kind}`];
    root().classList.add(...cls);
    this.named = null;
    this.transition = document.startViewTransition(() => {
      swap();
      root().classList.remove('vt-hold');
    });
    const done = () => {
      root().classList.remove(...cls);
      if (this.named) this.named.style.viewTransitionName = '';
      if (current === this) current = null;
    };
    this.transition.finished.then(done, done);
    return this.transition.updateCallbackDone.catch(() => {});
  }

  /** The new page has its focus and scroll: name where the poster lands (captured on the next frame). */
  finish() {
    if (!this.transition) return;
    const target = this.kind === 'open' ? detailPoster(this.main) : this.kind === 'back' && this.leaving ? cardFor(this.main, this.leaving) : null;
    if (target && visible(target)) {
      target.style.viewTransitionName = 'poster';
      this.named = target;
    }
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
    opened = { href: card.getAttribute('href'), art, at: performance.now() };
    if (!art || quiet()) return;
    dropArc();
    const ring = document.createElement('span');
    ring.className = 'press-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.addEventListener('animationend', () => ring.remove());
    art.append(ring);
  }, true);
}
