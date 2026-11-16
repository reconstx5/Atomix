// Card motion v2 (v0.28): the rules for selecting a film, episode or show card that need no page (tested in
// test/card-motion-rules.test.js). card-motion.js and the card builders (components.js, ui/cards.js) use them.

const runtimeText = (minutes) => {
  const m = Math.round(minutes);
  if (!(m > 0)) return '';
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h} h ${m % 60} m` : `${h} h`) : `${m} m`;
};
const minutesOf = (item) => item.runtime || (item.duration ? item.duration / 60 : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The one line under a selected poster: a film "2019 · PG-13 · 1 h 52 m", an episode "S2 · E4 · 45 m", a show
 * "2014 · 3 seasons" (cards carry the episode count: "2014 · 24 episodes"). '' for anything else or nothing known.
 */
export function cardInfoLine(item) {
  if (!item) return '';
  let parts = [];
  if (item.kind === 'movie') parts = [item.year, item.certification, runtimeText(minutesOf(item))];
  else if (item.kind === 'episode') {
    const where = item.season == null || item.episode == null ? '' : item.season === 0 ? `Special ${item.episode}` : `S${item.season} · E${item.episode}`;
    parts = [where, runtimeText(minutesOf(item))];
  } else if (item.kind === 'show') {
    const count = item.seasonCount ? plural(item.seasonCount, 'season') : item.childCount ? plural(item.childCount, 'episode') : '';
    parts = [item.year, count];
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * A poster card's spoken name (its aria-label, which replaces everything inside the card): the title, the info line
 * said with commas, then `state` (cardState: ", watched" …). The year is said once: in the line, or "(2014)" as before.
 */
export function cardLabel(item, state = '') {
  const parts = cardInfoLine(item).split(' · ').filter(Boolean);
  const yearSaid = item.year != null && parts.includes(String(item.year));
  return `${item.title}${item.year && !yearSaid ? ` (${item.year})` : ''}${parts.length ? `, ${parts.join(', ')}` : ''}${state}`;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** The card's own colour for its glow: the poster's (`tint`) on a poster card, the backdrop's (`tintWide`) on a wide one. */
export function cardTint(item, style) {
  const c = style === 'landscape' ? item?.tintWide : item?.tint;
  return typeof c === 'string' && HEX.test(c) ? c : null;
}

/** The sheen crosses each card once per page visit: take(id) is true the first time, reset() on a route change. */
export function sheenLedger() {
  const seen = new Set();
  return {
    take(id) {
      if (id == null || seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    reset() {
      seen.clear();
    },
  };
}

const SLOW = new Set(['2g', 'slow-2g']);
/**
 * What a rested card may do: 'clip' (its short silent clip, or the flip when it has none), 'flip' (the still-frame flip
 * only: Kids profiles) or 'none' (nothing at all: no clip, no flip, no manifest or sheet request). Nothing without full
 * motion or while the page is hidden; nothing with data saver, a 2g connection or the profile's "Play previews on
 * cards" off (unset counts as on).
 */
export function previewMode({ motion, saveData, effectiveType, kids, pref, hidden } = {}) {
  if (motion !== 'full' || hidden || saveData || SLOW.has(effectiveType) || pref === false) return 'none';
  return kids ? 'flip' : 'clip';
}

/** May a rested card play its short silent clip? (previewMode says 'clip'.) */
export function previewAllowed(o) {
  return previewMode(o) === 'clip';
}

/** The still-frame flip: at most this many pictures, each this long — within 5 s in all (WCAG 2.2.2). */
export const FLIP_FRAMES = 8;
export const FLIP_FRAME_MS = 620;
