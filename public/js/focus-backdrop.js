// Arctic and Arctic Side: the page's artwork follows the focused card once the remote rests (Plan C task 6).
// One delegated focusin listener and one timer; every focus restarts the timer. While an arrow is held (html.nav-held)
// nothing happens, and letting go restarts the timer on the card the focus landed on. Themes without
// `backdropFollowsFocus` (html[data-follow-focus]) are untouched.
import { setBackdrop } from './backdrop.js';
import { followUrl, shouldFollow } from './focus-backdrop-rules.js';

/**
 * followFocus(rowsEl, { itemOf(cardEl) → item|null, delay = 350 }) → cleanup
 * `itemOf` maps a focused card to its title (Home and the libraries pass their `cardItems` lookup).
 */
export function followFocus(rowsEl, { itemOf, delay = 350 } = {}) {
  const root = document.documentElement;
  let timer = null;
  let wanted = null; // the title of the card focus is resting on
  let wasHeld = false; // an arrow was held since the last keyup
  const fire = () => {
    timer = null;
    const flag = root.hasAttribute('data-follow-focus');
    if (!shouldFollow({ flag, held: root.classList.contains('nav-held'), motion: root.dataset.motion, item: wanted })) return;
    setBackdrop(followUrl(wanted));
  };
  const restart = () => {
    clearTimeout(timer);
    timer = wanted ? setTimeout(fire, delay) : null;
  };
  const onFocusIn = (e) => {
    const card = e.target.closest?.('.card');
    wanted = (card && itemOf(card)) || null;
    restart();
  };
  // nav.js clears nav-held on this same keyup (its listener was added first): once it has, the remote is resting.
  const onKeyDown = () => {
    if (root.classList.contains('nav-held')) wasHeld = true;
  };
  const onKeyUp = (e) => {
    if (!e.key.startsWith('Arrow') || !wasHeld || root.classList.contains('nav-held')) return;
    wasHeld = false;
    if (wanted) restart();
  };
  // Focus leaving the rows altogether: nothing waits any more.
  const onFocusOut = (e) => {
    if (rowsEl.contains(e.relatedTarget)) return;
    wanted = null;
    clearTimeout(timer);
    timer = null;
  };
  rowsEl.addEventListener('focusin', onFocusIn);
  rowsEl.addEventListener('focusout', onFocusOut);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  return () => {
    rowsEl.removeEventListener('focusin', onFocusIn);
    rowsEl.removeEventListener('focusout', onFocusOut);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    clearTimeout(timer);
    timer = null;
  };
}
