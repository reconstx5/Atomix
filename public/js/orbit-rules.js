// Rules for the Orbit layout that need no page, so they are tested in Node (test/orbit-rules.test.js):
// what the remote's keys do with the floating menu, what Back does on Home, and how the environment
// crops artwork. nav.js, app.js and backdrop.js apply them.

/** Wide enough and landscape: the page sits in a floating window. Keep in step with public/css/orbit.css. */
export const FRAME_QUERY = '(min-width: 1000px) and (orientation: landscape)';

/**
 * What an arrow or Back does with the floating menu.
 * leftTarget (for Left outside the menu): what spatial navigation found to the left —
 * 'page' (a control on the same line), 'menu' (a menu entry) or 'none'.
 * @returns {'enter'|'leave'|'move'|'stay'|null} null: not the menu's business, navigate as usual
 */
export function menuKey({ key, inMenu, leftTarget = 'none' }) {
  if (inMenu) {
    if (key === 'up' || key === 'down') return 'move';
    if (key === 'right' || key === 'back') return 'leave';
    return 'stay';
  }
  if (key === 'left' && leftTarget !== 'page') return 'enter';
  return null;
}

/** The menu entry Up/Down goes to, stopping at the ends. -1 when there are none. */
export function menuStep(count, index, key) {
  if (!count) return -1;
  return Math.max(0, Math.min(count - 1, index + (key === 'down' ? 1 : -1)));
}

/** Back on Orbit's Home: to the top first, then into the menu. Other pages and layouts go back. */
export function homeBack({ hasMenu, onHome, atTop }) {
  if (!hasMenu || !onHome) return 'back';
  return atTop ? 'menu' : 'top';
}

/** Two boxes (anything with top/bottom) overlap vertically. */
export const sameLine = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;

/**
 * Left from `a` stays on the page when the nearest control that way, `b`, is on the same line or lies wholly to the
 * left (a column of section tabs beside a form); otherwise Left has reached the edge and opens the menu.
 */
export const leftOnPage = (a, b) => Boolean(b) && (sameLine(a, b) || b.right <= a.left);

/**
 * The part of a sw × sh picture that fills a dw × dh box, like object-fit: cover, with the
 * spare room split at focusX / focusY (0–1). Null until the picture has a size.
 */
export function coverRect(sw, sh, dw, dh, focusX = 0.5, focusY = 0.25) {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return null;
  const wider = sw / sh > dw / dh; // wider than the box: crop the sides
  const w = wider ? (sh * dw) / dh : sw;
  const h = wider ? sh : (sw * dh) / dw;
  return { sx: (sw - w) * focusX, sy: (sh - h) * focusY, sw: w, sh: h };
}
