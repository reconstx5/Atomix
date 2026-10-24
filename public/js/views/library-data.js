// A library's data (v0.26): its sorts and nouns, the request for a set of filters and what the page needs to open.
// Kept apart from the screen (library.js, library-shelf.js, library-parts.js) so the router can start it while
// the screen's modules, Preact among them, are still arriving.
import { api, qs } from '../api.js';
import { setTitle, isOrbit, state } from '../app.js';

export const SONG_LIMIT = 500;

export const SORTS = {
  default: [
    ['title', 'A–Z'],
    ['added', 'Recently added'],
    ['year', 'Release year'],
    ['rating', 'Rating'],
    ['random', 'Shuffle'],
  ],
  albums: [
    ['title', 'A–Z'],
    ['added', 'Recently added'],
    ['year', 'Release year'],
    ['random', 'Shuffle'],
  ],
  artists: [
    ['title', 'A–Z'],
    ['added', 'Recently added'],
  ],
  tracks: [
    ['title', 'A–Z'],
    ['added', 'Recently added'],
    ['random', 'Shuffle'],
  ],
};
export const VIEWS = [
  ['albums', 'Albums'],
  ['artists', 'Artists'],
  ['tracks', 'Songs'],
];
export const NOUN = {
  movies: ['movie', 'movies'],
  tv: ['show', 'shows'],
  albums: ['album', 'albums'],
  artists: ['artist', 'artists'],
  tracks: ['song', 'songs'],
  podcasts: ['podcast', 'podcasts'],
  audiobooks: ['book', 'books'],
  books: ['title', 'titles'], // v0.22 Plan D: a series counts as one
  comics: ['title', 'titles'],
};

export const sortsFor = (isMusic, view) => SORTS[isMusic ? view : 'default'];

/** The library's items for a set of filters (a songs view asks for at most SONG_LIMIT). */
export function request(id, opts, view = opts.view) {
  const isSongs = opts.view === 'tracks';
  return api.get(`/api/libraries/${id}/items${qs({ view, sort: opts.sort, genre: isSongs ? '' : opts.genre, unwatched: opts.unwatched, q: opts.q, limit: isSongs ? SONG_LIMIT : '' })}`);
}

/** The filters as the page opens: from the address, with a music view always set and others never. */
export function startOpts(query, isMusic) {
  const opts = { view: query.view || '', sort: query.sort || 'title', genre: query.genre || '', unwatched: query.unwatched === '1', q: query.q || '' };
  if (isMusic == null) return opts; // the type isn't known yet: as the address says
  if (isMusic && !VIEWS.some(([v]) => v === opts.view)) opts.view = 'albums';
  if (!isMusic) opts.view = '';
  if (!sortsFor(isMusic, opts.view).some(([v]) => v === opts.sort)) opts.sort = 'title';
  return opts;
}

/** The newest unplayed podcast episodes across the library (v0.22), as a row; each plays at once. */
export async function newEpisodes(id, q) {
  const eps = q ? [] : await api.get(`/api/libraries/${id}/new-episodes`).catch(() => []);
  return eps.map((e) => ({ ...e, poster: e.poster || e.showPoster, href: `#/item/${e.showId}?episode=${e.id}` }));
}
/** The films' collections: the film series and hand-made collections with a film in this library. */
export async function collectionsFor(id) {
  const { collectionCard } = await import('./lists.js');
  const cols = (await api.get('/api/collections')).filter((c) => c.libraryIds?.includes(Number(id)));
  return { cols, collectionCard };
}
export async function load(params, query) {
  const id = params.id;
  // The first answer is for the filters as the address gives them; the library's type then settles the view.
  const raw = startOpts(query, null);
  // v0.25 (Orbit, Movies and TV Shows): Home's spotlight on top, following the remote; the posters scroll under it.
  // Its recent titles are asked for with the items when the app's library list already knows the type.
  const shelf = (type) => isOrbit() && (type === 'movies' || type === 'tv');
  const recentFor = () => api.get(`/api/libraries/${id}/recent`).catch(() => []);
  const known = state.libraries?.find((l) => String(l.id) === String(id))?.type;
  const early = shelf(known) ? recentFor() : null;
  const [first, genres] = await Promise.all([request(id, raw, query.view || ''), api.get(`/api/libraries/${id}/genres`)]);
  const lib = first.library;
  const isMusic = lib.type === 'music';
  const start = startOpts(query, isMusic);
  setTitle(lib.name);
  const orbitShelf = shelf(lib.type);
  const recent = orbitShelf ? await (early || recentFor()) : [];
  // Whether there is anything to shuffle: the library's songs, whatever the view or a search shows now.
  const hasSongs = !isMusic ? false : first.items.length > 0 && !start.q && !start.genre && !start.unwatched ? true : ((await api.get(`/api/libraries/${id}/items${qs({ view: 'tracks', limit: 1 })}`).catch(() => null))?.items?.length ?? 1) > 0;
  const fresh = lib.type === 'podcasts' ? await newEpisodes(id, start.q) : [];
  const collections = lib.type === 'movies' && query.view === 'collections' ? await collectionsFor(id) : null;
  return { first, genres, recent, hasSongs, fresh, collections, start, orbitShelf };
}

