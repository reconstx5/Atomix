// Kodi-style "10-foot" navigation: arrow keys move focus to the nearest
// control in that direction, Enter activates, Backspace goes back.
// Works with keyboards, TV remotes (which send arrow keys) and gamepads
// mapped to arrows.
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

function findNext(from, dir, root) {
  const a = from.getBoundingClientRect();
  const horizontal = dir === 'left' || dir === 'right';
  let candidates = [];
  for (const el of root.querySelectorAll(FOCUSABLE)) {
    if (el === from || !visible(el)) continue;
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

export function initNavigation({ onBack }) {
  window.addEventListener('pointerdown', () => {
    keyboardMode = false;
    document.documentElement.classList.remove('kbd');
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (dir || e.key === 'Tab') {
      keyboardMode = true;
      document.documentElement.classList.add('kbd');
    }
    if (document.body.dataset.view === 'player') return; // the player handles its own keys
    const active = document.activeElement;

    if (dir) {
      if (isTyping(active) && (dir === 'left' || dir === 'right' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
      if (active?.type === 'range' && (dir === 'left' || dir === 'right')) return; // sliders use left/right; up/down leaves them
      const root = scopeRoot();
      if (!active || active === document.body || active.id === 'main' || !active.matches(FOCUSABLE) || !root.contains(active)) {
        e.preventDefault();
        focusFirst(root === document ? document.querySelector('main') || document : root);
        return;
      }
      const next = findNext(active, dir, root);
      if (next) {
        e.preventDefault();
        next.focus({ preventScroll: true });
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      }
      return;
    }

    const backKeys = ['BrowserBack', 'GoBack', 'Backspace'];
    if (backKeys.includes(e.key) && !isTyping(active) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      onBack();
    }
  });
}
