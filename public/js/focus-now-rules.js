// The router's first focus for a page that marks one element data-focus-now (a deep link such as the guide's
// ?channel=). The rules need no page, so Node tests them (test/focus-now-rules.test.js).
//
// The page can't always take the focus when it comes in: behind the splash (a fresh open, or a move made while it
// shows) everything but the splash is inert, so a focus() call does nothing. The router keeps the mark and asks again
// once the splash lets go of the page.

/**
 * What to do with the marked element, each time the router asks (when the page is in, and again when the splash ends):
 * - 'focus': focus it and keep it in view;
 * - 'wait': it can't take the focus yet (it is inside something inert): ask again later;
 * - 'keep': the person has moved the focus since the page came in: theirs stays where it is, the mark is not used;
 * - 'drop': a newer page change took over, or the page redrew without it: forget it.
 * @param {{ current: boolean, connected: boolean, inert: boolean, moved: boolean }} s
 */
export function focusNowStep({ current, connected, inert, moved }) {
  if (!current || !connected) return 'drop';
  if (moved) return 'keep';
  return inert ? 'wait' : 'focus';
}

/**
 * Has the person moved the focus since the page came in? Not when it is where it was then, nowhere (the body: the old
 * page went away under it) or on the page itself (main).
 */
export function focusMoved({ active, before, body, main }) {
  return Boolean(active) && active !== before && active !== body && active !== main;
}
