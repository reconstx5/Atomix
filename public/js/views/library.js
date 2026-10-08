// A library: poster grid with sort, genre and watched filters. Music
// libraries switch between albums, artists and a songs list.
import { api, qs } from '../api.js';
import { h, clear, append, debounce } from '../dom.js';
import { grid, emptyState, spinner, button, toast } from '../components.js';
import { setTitle, canAdmin } from '../app.js';
import { music, trackList } from '../music.js';
import { setBackdrop, artFor, followFocus } from '../backdrop.js';
import { cardItems } from '../components.js';

const SONG_LIMIT = 500;

const SORTS = {
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
const VIEWS = [
  ['albums', 'Albums'],
  ['artists', 'Artists'],
  ['tracks', 'Songs'],
];
const NOUN = {
  movies: ['movie', 'movies'],
  tv: ['show', 'shows'],
  albums: ['album', 'albums'],
  artists: ['artist', 'artists'],
  tracks: ['song', 'songs'],
};

export async function render(el, params, query) {
  const id = params.id;
  const opts = { view: query.view || '', sort: query.sort || 'title', genre: query.genre || '', unwatched: query.unwatched === '1', q: query.q || '' };
  const request = () => {
    const isSongs = opts.view === 'tracks';
    return api.get(
      `/api/libraries/${id}/items${qs({
        view: opts.view,
        sort: opts.sort,
        genre: isSongs ? '' : opts.genre,
        unwatched: opts.unwatched,
        q: opts.q,
        limit: isSongs ? SONG_LIMIT : '',
      })}`,
    );
  };
  const [first, genres] = await Promise.all([request(), api.get(`/api/libraries/${id}/genres`)]);
  const lib = first.library;
  const isMusic = lib.type === 'music';
  if (isMusic && !VIEWS.some(([v]) => v === opts.view)) opts.view = 'albums';
  if (!isMusic) opts.view = '';
  setTitle(lib.name);

  const results = h('div', { class: 'library-results' });
  const count = h('span', { class: 'muted count' });
  const sortsFor = () => SORTS[isMusic ? opts.view : 'default'];

  const sortSel = h('select', { 'aria-label': 'Sort by' });
  function fillSorts() {
    const list = sortsFor();
    if (!list.some(([v]) => v === opts.sort)) opts.sort = 'title';
    clear(sortSel).append(...list.map(([v, label]) => h('option', { value: v, selected: opts.sort === v }, label)));
  }
  fillSorts();
  const genreSel = h('select', { 'aria-label': 'Genre' }, h('option', { value: '' }, 'All genres'), genres.map((g) => h('option', { value: g, selected: opts.genre === g }, g)));
  const unwatched = h('input', { type: 'checkbox', checked: opts.unwatched });
  const unwatchedLabel = h('label', { class: 'check' }, unwatched, h('span', {}, 'Unwatched'));
  const filter = h('input', { type: 'search', placeholder: `Filter ${lib.name}`, value: opts.q, 'aria-label': `Filter ${lib.name}` });

  function show(items) {
    clear(results);
    const kind = isMusic ? opts.view : lib.type;
    const [one, many] = NOUN[kind] || NOUN.movies;
    count.textContent = `${items.length}${opts.view === 'tracks' && items.length >= SONG_LIMIT ? '+' : ''} ${items.length === 1 ? one : many}`;
    const filtered = opts.q || (opts.genre && opts.view !== 'tracks') || opts.unwatched;
    if (!items.length) {
      results.append(
        emptyState({
          title: filtered ? 'Nothing matches' : 'This library is empty',
          text: filtered ? 'Try clearing the filters.' : 'If you just added it, the scan may still be running.',
        }),
      );
      return;
    }
    if (opts.view === 'tracks') {
      results.append(h('div', { class: 'song-list' }, trackList(items, { showAlbum: true, numbers: false })));
      if (items.length >= SONG_LIMIT) results.append(h('p', { class: 'muted center small' }, `Showing the first ${SONG_LIMIT} songs — use the filter to find others.`));
      return;
    }
    results.append(grid(items, { style: isMusic ? 'square' : 'poster' }));
    setBackdrop(artFor(items.find((i) => i.backdrop) || items[0]));
  }

  async function reload() {
    // Keep the URL in sync so Back returns to the same filters.
    history.replaceState(
      null,
      '',
      `#/library/${id}${qs({ view: isMusic && opts.view !== 'albums' ? opts.view : '', sort: opts.sort !== 'title' ? opts.sort : '', genre: opts.genre, unwatched: opts.unwatched, q: opts.q })}`,
    );
    clear(results).append(spinner());
    const data = await request();
    show(data.items);
  }

  sortSel.addEventListener('change', () => ((opts.sort = sortSel.value), reload()));
  genreSel.addEventListener('change', () => ((opts.genre = genreSel.value), reload()));
  unwatched.addEventListener('change', () => ((opts.unwatched = unwatched.checked), reload()));
  filter.addEventListener('input', debounce(() => ((opts.q = filter.value.trim()), reload()), 250));

  // Albums / Artists / Songs switcher for music.
  let viewTabs = null;
  function syncControls() {
    genreSel.hidden = !genres.length || opts.view === 'tracks' || opts.view === 'artists';
    unwatchedLabel.hidden = isMusic;
    if (viewTabs) for (const b of viewTabs.children) b.setAttribute('aria-pressed', String(b.dataset.view === opts.view));
  }
  if (isMusic) {
    viewTabs = h(
      'div',
      { class: 'view-tabs', role: 'group', 'aria-label': 'Show' },
      VIEWS.map(([v, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'season-tab',
            dataset: { view: v },
            'aria-pressed': String(v === opts.view),
            onClick: () => {
              if (opts.view === v) return;
              opts.view = v;
              fillSorts();
              syncControls();
              reload();
            },
          },
          label,
        ),
      ),
    );
  }

  const tools = [];
  if (lib.type === 'movies') {
    // Collections: the film series and hand-made collections with a film in this library.
    const startOnCollections = opts.view === 'collections';
    if (startOnCollections) opts.view = '';
    const collectionsBtn = button('Collections', { icon: 'list', variant: 'ghost', attrs: { 'aria-pressed': 'false' } });
    collectionsBtn.addEventListener('click', async () => {
      opts.view = opts.view === 'collections' ? '' : 'collections';
      collectionsBtn.setAttribute('aria-pressed', String(opts.view === 'collections'));
      if (opts.view === 'collections') {
        history.replaceState(null, '', `#/library/${id}?view=collections`);
        clear(results).append(spinner());
        const { collectionCard } = await import('./lists.js');
        const cols = (await api.get('/api/collections')).filter((c) => c.libraryIds?.includes(Number(id)));
        clear(results);
        count.textContent = `${cols.length} ${cols.length === 1 ? 'collection' : 'collections'}`;
        results.append(cols.length ? h('div', { class: 'grid grid-poster', role: 'list' }, cols.map(collectionCard)) : emptyState({ title: 'No collections yet', text: 'Film series turn up here as your films are matched; admins can make their own in Settings → Libraries.' }));
      } else reload();
    });
    tools.push(collectionsBtn);
    if (startOnCollections) setTimeout(() => collectionsBtn.click(), 0);
  }
  if (isMusic) {
    tools.push(
      button('Shuffle all', {
        icon: 'shuffle',
        variant: 'primary',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const data = await api.get(`/api/libraries/${id}/items${qs({ view: 'tracks', sort: 'random', limit: SONG_LIMIT })}`);
            if (!data.items.length) toast('No songs in this library yet.');
            else music.playTracks(data.items, 0);
          } catch (err) {
            toast(err.message, { type: 'error' });
          } finally {
            btn.disabled = false;
          }
        },
      }),
    );
  }
  if (canAdmin()) {
    tools.push(
      button('Scan', {
        icon: 'refresh',
        variant: 'ghost',
        title: 'Look for new and removed files',
        onClick: async () => {
          await api.post(`/api/libraries/${id}/scan`, {});
          toast(`Scanning ${lib.name}…`);
        },
      }),
    );
  }

  syncControls();
  // The artwork behind the page follows the focused (or hovered) title.
  followFocus(results, (card) => cardItems.get(card));
  append(el, [
    h(
      'header',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, lib.name), count),
      h('search', { class: 'toolbar' }, filter, sortSel, genres.length ? genreSel : null, unwatchedLabel, tools),
    ),
    viewTabs ? h('div', { class: 'view-tabs-wrap' }, viewTabs) : null, // append() skips null; el.append would print it
    results,
  ]);
  show(first.items);
}
