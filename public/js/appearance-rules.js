// v0.29 visual refresh B: what a profile's appearance choices mean on this device. Pure functions (tested in
// test/appearance-rules.test.js); app.js turns the answers into html[data-glass|data-oled|data-contrast] and --text-scale.

const GLASS = ['clear', 'tinted', 'solid'];
export const TEXT_SCALES = [1, 1.15, 1.3];

/**
 * How see-through menus and panels are.
 * env: { tv, backdropFilter, reducedTransparency, contrastMore }. The system's "reduce transparency" and a browser without
 * backdrop-filter always get Solid; otherwise the profile's choice; otherwise Solid on TV-size screens, Tinted elsewhere.
 * An old reduceEffects: true (before the Glass setting) reads as Solid.
 */
export function glassMode(prefs = {}, env = {}) {
  if (env.reducedTransparency || env.backdropFilter === false || env.contrastMore) return 'solid'; // More contrast: opaque panels
  if (GLASS.includes(prefs.glass)) return prefs.glass;
  if (prefs.reduceEffects) return 'solid';
  return env.tv ? 'solid' : 'tinted';
}

/**
 * Whether the profile asked for fewer effects (Glass Solid, or the old Reduce effects switch). Card motion's sheen and
 * preview clips stop then; a Solid that is only a device default (TV-size screen, no blur) keeps them.
 */
export function effectsReduced(prefs = {}) {
  return prefs.glass === 'solid' || (!GLASS.includes(prefs.glass) && Boolean(prefs.reduceEffects));
}

/** 'more' or 'normal': the profile's choice, else the system's prefers-contrast: more (env.prefersMore). */
export function contrastMode(prefs = {}, env = {}) {
  if (prefs.contrast === 'more' || prefs.contrast === 'normal') return prefs.contrast;
  return env.prefersMore ? 'more' : 'normal';
}

/**
 * Whether True black is on: never on a light theme; the profile's own yes or no wins; otherwise the theme's default.
 * theme: { colorScheme, oled }.
 */
export function oledMode(prefs = {}, theme = {}) {
  if (theme.colorScheme === 'light') return false;
  if (typeof prefs.oled === 'boolean') return prefs.oled;
  return theme.oled === true;
}

/** The text size multiplier: 1, 1.15 or 1.3. */
export function textScale(prefs = {}) {
  return TEXT_SCALES.includes(prefs.textScale) ? prefs.textScale : 1;
}

/**
 * The menu's libraries: pinned ones in the profile's order, the rest (for "More") in their own order. No pins (or
 * pins that all point at libraries this profile doesn't have) keeps every library in the menu, as before.
 */
export function orderLibraries(libraries = [], pinned) {
  const byId = new Map(libraries.map((l) => [l.id, l]));
  const ids = Array.isArray(pinned) ? [...new Set(pinned)].filter((id) => byId.has(id)) : [];
  if (!ids.length) return { pinned: libraries.slice(), rest: [] };
  const set = new Set(ids);
  return { pinned: ids.map((id) => byId.get(id)), rest: libraries.filter((l) => !set.has(l.id)) };
}

/** A new pinned list after Move up (-1), Move down (1), 'pin' (to the end) or 'unpin'. */
export function movePinned(pinned, id, dir) {
  const list = Array.isArray(pinned) ? pinned.slice() : [];
  const i = list.indexOf(id);
  if (dir === 'pin') return i < 0 ? [...list, id] : list;
  if (dir === 'unpin') return i < 0 ? list : list.filter((x) => x !== id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}
