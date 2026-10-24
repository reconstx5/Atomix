// Pinned rows on Home (v0.22): a playlist, a genre in a library, a collection, or a library's "Recently added" /
// "Something random". Drawn with the viewer's rules every time; gone (null) when the viewer may no longer see it.
import { HttpError } from '../http/router.js';

const TYPES = new Set(['list', 'genre', 'collection', 'library']);
const SORTS = { added: 'Recently added in', random: 'Something random from' };
const LIMIT = 24;
const id = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** The shape of a pin, cleaned; throws 400 for one that can't be saved. */
export function validatePin(p) {
  const bad = (why) => {
    throw new HttpError(400, `That pinned row can't be saved: ${why}.`);
  };
  if (!p || typeof p !== 'object') bad('it is empty');
  if (typeof p.key !== 'string' || !/^pin-[0-9a-f]{8,32}$/.test(p.key)) bad('its name is wrong');
  if (!TYPES.has(p.type)) bad('it is an unknown kind of row');
  if (p.type === 'list') return { key: p.key, type: 'list', listId: id(p.listId) ?? bad('no playlist') };
  if (p.type === 'collection') return { key: p.key, type: 'collection', collectionId: id(p.collectionId) ?? bad('no collection') };
  const libraryId = id(p.libraryId) ?? bad('no library');
  if (p.type === 'genre') {
    const genre = typeof p.genre === 'string' ? p.genre.trim() : '';
    if (!genre || genre.length > 60) bad('no genre');
    return { key: p.key, type: 'genre', libraryId, genre };
  }
  if (!Object.hasOwn(SORTS, p.sort)) bad('an unknown order');
  return { key: p.key, type: 'library', libraryId, sort: p.sort };
}

/** Throws the sentence a person sees when they pin something their profile can't see. */
export function checkPinVisible(pin, core, viewer) {
  if (pinRow(pin, core, viewer, { probe: true })) return;
  const what = pin.type === 'list' ? 'playlist' : pin.type === 'collection' ? 'collection' : 'library';
  throw new HttpError(400, `That ${what} isn't available to this profile.`);
}

/**
 * The row for a pin, or null when its playlist, collection or library is gone or hidden from this viewer.
 * `probe` answers whether the thing itself is visible (an empty genre is still a fine pin).
 */
export function pinRow(pin, core, viewer, { probe = false } = {}) {
  const { library } = core;
  if (pin.type === 'list') {
    const list = core.lists.get(pin.listId);
    if (!list || list.kind === 'watchlist' || !core.lists.visibleTo(list, viewer)) return null;
    if (probe) return true;
    const rows = core.lists.rows(list.id, viewer).filter((r) => list.kind === 'smart' || library.canSee(viewer, r)).slice(0, LIMIT);
    const music = list.kind === 'music' || (list.kind === 'smart' && list.media === 'music');
    return { key: pin.key, id: pin.key, title: list.name, style: music ? 'square' : 'poster', href: `#/lists/${list.id}`, pinned: true, items: library.withProgress(rows, viewer) };
  }
  if (pin.type === 'collection') {
    const c = core.collections.get(pin.collectionId, viewer);
    if (!c) return null;
    if (probe) return true;
    return { key: pin.key, id: pin.key, title: c.name, style: 'poster', href: `#/collections/${c.id}`, pinned: true, items: c.items.slice(0, LIMIT) };
  }
  const lib = library.visibleLibraries(viewer).find((l) => l.id === pin.libraryId);
  if (!lib) return null;
  if (probe) return true;
  const kind = lib.type === 'movies' ? 'movie' : lib.type === 'tv' ? 'show' : lib.type === 'music' ? 'album' : undefined;
  const style = lib.type === 'music' ? 'square' : 'poster';
  const base = { key: pin.key, id: pin.key, style, libraryId: lib.id, pinned: true };
  if (pin.type === 'genre') {
    const items = library.list({ viewer, libraryId: lib.id, kind, genre: pin.genre, sort: 'added', limit: LIMIT });
    return { ...base, title: `${pin.genre} in ${lib.name}`, href: `#/library/${lib.id}`, items: library.withProgress(items, viewer) };
  }
  const items = library.list({ viewer, libraryId: lib.id, kind, sort: pin.sort, limit: LIMIT });
  return { ...base, title: `${SORTS[pin.sort]} ${lib.name}`, href: `#/library/${lib.id}`, items: library.withProgress(items, viewer) };
}
