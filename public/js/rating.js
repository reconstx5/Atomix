// Stars and hearts: a profile's own 1–5 stars and favourite for a film, show, album, artist or song. The heart is a
// toggle; the stars are one radio group (one tab stop, arrows move, Enter picks — choosing the checked star again
// clears it). Saved at once; a failed save puts the control back as it was.
import { api } from './api.js';
import { h, icon } from './dom.js';
import { toast, rovingRadios, openDialog } from './components.js';

const NEVER_PLACED_MS = 5000; // a control not on the page this long after it was made never will be
const RATEABLE = new Set(['track', 'album', 'artist', 'movie', 'show']);
/** v0.21: every saved rating is told here, so each control showing that title (the music bar's heart, Now Playing,
 *  a title page) shows it too. `detail`: { id, stars, favourite }. */
export const ratingEvents = new EventTarget();
export const canRate = (item) => Boolean(item && RATEABLE.has(item.kind));

/**
 * @param {{ id, title, kind, stars?, favourite? }} item  updated in place when a save succeeds
 * @param {{ compact?: boolean, onChange?: (item) => void }} [opts] compact: the heart only (the music bar)
 */
export function ratingControl(item, { compact = false, onChange } = {}) {
  const state = { stars: item.stars ?? null, favourite: Boolean(item.favourite) };
  const heart = h('button', { type: 'button', class: 'btn btn-ghost btn-icon rating-heart', 'aria-label': `Favourite ${item.title}`, title: 'Favourite' });
  const radios = [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', role: 'radio', class: 'rating-star', 'aria-label': n === 1 ? '1 star' : `${n} stars`, dataset: { n } }));
  const group = compact ? null : rovingRadios(h('div', { role: 'radiogroup', class: 'rating-stars', 'aria-label': `Stars for ${item.title}` }, radios));

  const paint = () => {
    heart.setAttribute('aria-pressed', String(state.favourite));
    heart.replaceChildren(icon(state.favourite ? 'heartFill' : 'heart', { size: 20 }));
    for (const r of radios) {
      const n = Number(r.dataset.n);
      r.setAttribute('aria-checked', String(state.stars === n));
      r.classList.toggle('is-lit', state.stars != null && n <= state.stars);
      r.replaceChildren(icon(state.stars != null && n <= state.stars ? 'star' : 'starLine', { size: 20 }));
    }
  };

  let busy = false;
  async function save(change, said) {
    if (busy) return;
    busy = true;
    const before = { ...state };
    Object.assign(state, change);
    paint();
    try {
      const saved = await api.put(`/api/items/${item.id}/rating`, change);
      Object.assign(state, saved);
      Object.assign(item, saved);
      toast(said(saved));
      onChange?.(item);
      ratingEvents.dispatchEvent(new CustomEvent('change', { detail: { id: item.id, stars: saved.stars ?? null, favourite: Boolean(saved.favourite) } }));
    } catch (err) {
      Object.assign(state, before);
      toast(err.message, { type: 'error' });
    } finally {
      busy = false;
      paint();
    }
  }

  // Another control saved this title: show it here too (until this one has left the page — or, never put on a page,
  // a few seconds after it was made).
  let placed = false;
  const made = Date.now();
  const onRated = (e) => {
    if (heart.isConnected) placed = true;
    else if (placed || Date.now() - made > NEVER_PLACED_MS) return ratingEvents.removeEventListener('change', onRated);
    if (e.detail.id !== item.id || busy) return;
    Object.assign(state, { stars: e.detail.stars, favourite: e.detail.favourite });
    Object.assign(item, { stars: e.detail.stars, favourite: e.detail.favourite });
    paint();
  };
  ratingEvents.addEventListener('change', onRated);

  heart.addEventListener('click', () => save({ favourite: !state.favourite }, (s) => (s.favourite ? 'Added to favourites' : 'Removed from favourites')));
  for (const r of radios) {
    r.addEventListener('click', () => {
      const n = Number(r.dataset.n);
      save({ stars: state.stars === n ? null : n }, (s) => (s.stars == null ? 'Rating cleared' : `Rated ${s.stars} ${s.stars === 1 ? 'star' : 'stars'}`));
    });
  }
  // Left/Right walk the stars (the spatial navigation skips the group's other radios: they're out of the tab order);
  // past either end the arrow carries on to the next control as usual.
  group?.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const at = radios.indexOf(document.activeElement);
    if (!step || at < 0 || !radios[at + step]) return;
    e.preventDefault();
    e.stopPropagation();
    radios[at + step].focus();
  });
  paint();
  return h('div', { class: `my-rating${compact ? ' my-rating-compact' : ''}` }, heart, group);
}

/** "Rate <title>": the control in a small dialog (a song's "…" menu, and the older layouts' "…"). */
export function openRating(item, opts) {
  return openDialog({ title: `Rate ${item.title}`, body: h('div', { class: 'rating-dialog' }, ratingControl(item, opts)), actions: [{ label: 'Done', value: 'close', variant: 'primary' }] });
}
