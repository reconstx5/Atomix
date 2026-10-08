// Kodi-style "10-foot" navigation: arrow keys move focus to the nearest
// control in that direction, Enter activates, Backspace goes back.
// Works with keyboards, TV remotes (which send arrow keys) and gamepads
// mapped to arrows.
import { menuKey, menuStep, leftOnPage, FRAME_QUERY } from './orbit-rules.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let keyboardMode = false;
export const isKeyboardMode = () => keyboardMode;
/** An arrow key or Tab was pressed: focus rings show and pages start with a control focused. */
export function enterKeyboardMode() {
  keyboardMode = true;
  document.documentElement.classList.add('kbd');
}
const KBD_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
export const isKeyboardModeKey = (key) => KBD_KEYS.has(key);

function visible(el) {
  if (el.getAttribute('tabindex') === '-1') return false; // mouse-only helpers (e.g. row scroll arrows)
  if (el.classList.contains('skip-link')) return false; // for Tab users only
  if (el.closest('[inert], [hidden]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function scopeRoot() {
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  return dialogs[dialogs.length - 1] || document.querySelector('[data-nav-scope]') || document;
}

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** The nearest ancestor that scrolls along `axis` ('x' or 'y') and has something to scroll. */
function scroller(el, axis) {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    const o = axis === 'y' ? s.overflowY : s.overflowX;
    if ((o === 'auto' || o === 'scroll') && (axis === 'y' ? p.scrollHeight > p.clientHeight + 1 : p.scrollWidth > p.clientWidth + 1)) return p;
  }
  return null;
}

/** The nearest focusable element from `from` in direction `dir`, inside `root`, leaving out `skip` (Orbit's menu). */
function findNext(from, dir, root, skip = null) {
  const a = from.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  let candidates = [];
  for (const el of root.querySelectorAll(FOCUSABLE)) {
    if (el === from || !visible(el) || skip?.contains(el)) continue;
    const b = el.getBoundingClientRect();
    let primary;
    let ov;
    if (horizontal) {
      primary = dir === 'right' ? b.left - a.right : a.left - b.right;
      if (primary < -a.width / 2) continue;
      ov = overlap(a.top, a.bottom, b.top, b.bottom);
    } else {
      primary = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      if (primary < -a.height / 2) continue;
      ov = overlap(a.left, a.right, b.left, b.right);
    }
    const cross = horizontal
      ? Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2)
      : Math.abs(b.left - a.left); // line up left edges in grids and rows
    candidates.push({ el, primary: Math.max(primary, 0), ov, cross });
  }
  if (!candidates.length) return null;
  // Inside a scrolling area (the home rows, a row of cards) keep going through its own
  // items first — ones scrolled out of sight included — before jumping outside it.
  const box = scroller(from, horizontal ? 'x' : 'y');
  if (box) {
    const inside = candidates.filter((c) => box.contains(c.el));
    if (inside.length) candidates = inside;
  }
  if (horizontal) {
    // Stay on the same line when possible.
    const sameLine = candidates.filter((c) => c.ov > 0);
    const pool = sameLine.length ? sameLine : candidates;
    pool.sort((x, y) => x.primary + x.cross * 2 - (y.primary + y.cross * 2));
    return pool[0].el;
  }
  // Up/down: go to the nearest line first (so short rows aren't skipped),
  // then pick whatever is horizontally closest on that line.
  const nearest = Math.min(...candidates.map((c) => c.primary));
  const band = candidates.filter((c) => c.primary <= nearest + 24);
  band.sort((x, y) => x.cross - y.cross);
  return band[0].el;
}

function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(el.type);
  return false;
}

export function focusFirst(root = document) {
  const target = root.querySelector('[data-autofocus]') || [...root.querySelectorAll(FOCUSABLE)].find(visible);
  if (target) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// ---- Orbit's floating menu ----
// Left from the leftmost control enters it (it grows to show names), Up/Down move, OK opens,
// Right or Back leave and put the remote back where it was. Phones use it as a dock instead.
const BACK_KEYS = ['BrowserBack', 'GoBack', 'Backspace'];
const framed = matchMedia(FRAME_QUERY);
let menuEl = null;
let rowInline = 'nearest';
let returnTo = null;

/** Layout-specific behaviour: Orbit's menu list (null for layouts without one) and how rows follow the selection. */
export function configureNavigation({ menu = null, rowAlign = 'nearest' } = {}) {
  if (menuEl && menuEl !== menu) document.documentElement.classList.remove('menu-open');
  menuEl = menu;
  rowInline = rowAlign;
}
const floatingMenu = () => (menuEl?.isConnected && framed.matches ? menuEl : null);
const menuItems = () => [...(floatingMenu()?.querySelectorAll(FOCUSABLE) || [])].filter(visible);
export const menuIsOpen = () => document.documentElement.classList.contains('menu-open');

/** Put the remote in the menu, on the page you're on. Remembers where it came from. */
export function openMenu(from = document.activeElement) {
  const items = menuItems();
  if (!items.length) return false;
  if (from && from !== document.body && !menuEl.contains(from)) returnTo = from;
  document.documentElement.classList.add('menu-open');
  (items.find((a) => a.getAttribute('aria-current') === 'page') || items[0]).focus({ preventScroll: true });
  return true;
}

/** Leave the menu and put the remote back where it was. */
export function closeMenu() {
  document.documentElement.classList.remove('menu-open');
  const target = returnTo;
  returnTo = null;
  if (target?.isConnected && visible(target)) target.focus({ preventScroll: true });
  else focusFirst(document.querySelector('main') || document);
}

/** An arrow or Back press that involves the menu. Returns true when it was used. */
function menuKeys(e, key, active) {
  const menu = floatingMenu();
  if (!menu || scopeRoot() !== document) return false;
  const inMenu = menu.contains(active);
  let leftTarget = 'none';
  if (!inMenu) {
    if (key !== 'left' || !active?.matches?.(FOCUSABLE)) return false;
    // Where Left would go on the page (the menu left out): on the same line, or wholly to the left like a column of
    // section tabs, it is an ordinary move; anything else means the remote has reached the edge.
    const next = findNext(active, 'left', document, menu);
    leftTarget = leftOnPage(active.getBoundingClientRect(), next?.getBoundingClientRect()) ? 'page' : 'none';
  }
  const action = menuKey({ key, inMenu, leftTarget });
  if (!action || (action === 'enter' && !openMenu(active))) return false;
  if (action === 'move') {
    const items = menuItems();
    const next = items[menuStep(items.length, items.indexOf(active), key)];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }
  if (action === 'leave') closeMenu();
  e.preventDefault();
  return true;
}

export function initNavigation({ onBack }) {
  window.addEventListener('pointerdown', () => {
    keyboardMode = false;
    document.documentElement.classList.remove('kbd');
  }, { passive: true });
  // Clicking or tabbing somewhere else closes the menu.
  document.addEventListener('focusin', (e) => {
    if (menuIsOpen() && !menuEl?.contains(e.target)) {
      document.documentElement.classList.remove('menu-open');
      returnTo = null;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (isKeyboardModeKey(e.key)) enterKeyboardMode();
    // The player handles its own keys, except in a dialog over it (the cast picker).
    if (document.body.dataset.view === 'player' && !document.activeElement?.closest?.('dialog[open]')) return;
    const active = document.activeElement;

    if (dir) {
      if (isTyping(active) && (dir === 'left' || dir === 'right' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
      if (active?.type === 'range' && (dir === 'left' || dir === 'right')) return; // sliders use left/right; up/down leaves them
      if (menuKeys(e, dir, active)) return;
      const root = scopeRoot();
      if (!active || active === document.body || active.id === 'main' || !active.matches(FOCUSABLE) || !root.contains(active)) {
        e.preventDefault();
        focusFirst(root === document ? document.querySelector('main') || document : root);
        return;
      }
      // The floating menu is entered with Left only (menuKeys); other moves stay on the page.
      const menu = floatingMenu();
      const next = findNext(active, dir, root, menu && !menu.contains(active) ? menu : null);
      if (next) {
        e.preventDefault();
        next.focus({ preventScroll: true });
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Orbit: moving along a row scrolls it so the selected card stays at the left.
        const inline = rowInline === 'start' && (dir === 'left' || dir === 'right') && next.closest('.row-scroller') ? 'start' : 'nearest';
        next.scrollIntoView({ block: 'nearest', inline, behavior: reduce ? 'auto' : 'smooth' });
      }
      return;
    }

    const back = BACK_KEYS.includes(e.key);
    if ((back || e.key === 'Escape') && menuIsOpen() && !isTyping(active) && menuKeys(e, 'back', active)) return;
    if (back && !isTyping(active)) {
      e.preventDefault();
      // The remote's Back closes a dialog first, as Esc does.
      const dialogs = document.querySelectorAll('dialog[open]');
      if (dialogs.length) dialogs[dialogs.length - 1].close('cancel');
      else onBack();
    }
  });
}
