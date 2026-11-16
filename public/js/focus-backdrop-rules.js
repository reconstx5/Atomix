// The pure parts of the backdrop that follows the focused card (Plan C task 6). Node-tested in test/focus-backdrop.test.js.

/** The backdrop address an item offers (a title's own, or its show's for an episode); null when it has none. A poster
 * alone doesn't count: Arctic would stretch a poster over the whole screen. */
export const followUrl = (item) => item?.backdrop || item?.showBackdrop || null;

/**
 * Whether the backdrop should follow focus right now.
 * `flag`: the theme asks for it (html[data-follow-focus]); `held`: an arrow is held (html.nav-held);
 * `motion`: html[data-motion] (full | reduce | none); `item`: the focused card's title.
 */
export function shouldFollow({ flag, held, motion, item }) {
  if (!flag || held || motion === 'none') return false;
  return Boolean(followUrl(item));
}

/**
 * Whether a focused or hovered card may set the backdrop through the older paths (the Spotlight's follow, the library
 * and search grids). A theme that sets html[data-follow-focus] (Arctic) leaves that to focus-backdrop.js alone, which
 * waits for the remote to rest and never works under a held arrow or motion none.
 */
export const focusSetsBackdrop = (flagPresent) => !flagPresent;
