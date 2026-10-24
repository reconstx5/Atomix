// A library: poster grid with sort, genre and watched filters. Music libraries switch between albums, artists and a
// songs list; podcasts show their new episodes. Orbit's Movies and TV Shows are a shelf under a spotlight
// (library-shelf.js). v0.26: a Preact screen; its pieces are in library-parts.js.
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { canAdmin } from '../app.js';
import { cardItems } from '../components.js';
import { setBackdrop, artFor, followFocus } from '../backdrop.js';
import { Shelf } from './library-shelf.js';
import { VIEWS, sortsFor, useLibrary, useTypedText, Results, countText, newEpisodes, NewEpisodes, Tools, subscribeDialog, collectionsFor, CollectionsResults, collectionsCount } from './library-parts.js';

export { load } from './library-data.js';

export function Screen({ data, query, view }) {
  const admin = canAdmin();
  if (data.orbitShelf) return html`<${Shelf} data=${data} query=${query} view=${view} admin=${admin} />`;
  return html`<${Classic} data=${data} view=${view} admin=${admin} />`;
}

/** An option that carries its value as an attribute, as v0.25's did (Preact leaves it out when it equals the text). */
const Option = ({ value, selected, children }) => html`<option value=${value} selected=${selected} ref=${(el) => el?.setAttribute('value', value)}>${children}</option>`;

/** Every library in the older themes, and Orbit's other libraries: a header with the toolbar, then the results. */
function Classic({ data, view, admin }) {
  const { first, genres, hasSongs } = data;
  const lib = first.library;
  const id = lib.id;
  const isMusic = lib.type === 'music';
  const isSpoken = lib.type === 'podcasts' || lib.type === 'audiobooks'; // v0.22
  const isReading = lib.type === 'books' || lib.type === 'comics'; // v0.22 Plan D
  // Collections (films): the button stays pressed while a filter change shows the films again, as before.
  const [colsPressed, setColsPressed] = useState(Boolean(data.collections));
  const [cols, setCols] = useState(data.collections); // what the results show: { cols } or null (the films)
  const [colsOpen, setColsOpen] = useState(Boolean(data.collections));
  const pressed = useRef(colsPressed);
  pressed.current = colsPressed;
  const L = useLibrary(id, isMusic, first.items, data.start, { requestView: (o) => (isMusic ? o.view : pressed.current ? 'collections' : '') });
  const { opts, items, busy, version } = L;
  const [fresh, setFresh] = useState(data.fresh);
  const set = async (patch) => {
    setColsOpen(false);
    const got = await L.set(patch);
    if (got && lib.type === 'podcasts') setFresh(await newEpisodes(id, { ...opts, ...patch }.q));
  };
  const [text, setText] = useTypedText(opts.q, (q) => set({ q }));
  const results = useRef(null);

  // The artwork behind the page follows the focused (or hovered) title, and starts on the first with a backdrop.
  useLayoutEffect(() => {
    followFocus(results.current, (card) => cardItems.get(card));
  }, []);
  useLayoutEffect(() => {
    if (colsOpen || opts.view === 'tracks' || !items.length) return;
    setBackdrop(artFor(items.find((i) => i.backdrop) || items[0]));
  }, [version]);

  const toggleCollections = async () => {
    const on = !colsPressed;
    setColsPressed(on);
    pressed.current = on;
    if (!on) {
      setColsOpen(false);
      set({});
      return;
    }
    setColsOpen(true);
    setCols(null);
    history.replaceState(null, '', `#/library/${id}?view=collections`);
    setCols(await collectionsFor(id));
  };

  const genreHidden = !genres.length || opts.view === 'tracks' || opts.view === 'artists' || isSpoken || isReading;
  const toolbar = html`<search class="toolbar">
    <input type="search" placeholder=${`Filter ${lib.name}`} value=${text} aria-label=${`Filter ${lib.name}`} onInput=${(e) => setText(e.currentTarget.value)} />
    <select aria-label="Sort by" value=${opts.sort} onChange=${(e) => set({ sort: e.currentTarget.value })}>${sortsFor(isMusic, opts.view).map(([v, label]) => html`<${Option} key=${v} value=${v} selected=${opts.sort === v}>${label}<//>`)}</select>
    ${genres.length ? html`<select aria-label="Genre" hidden=${genreHidden} value=${opts.genre} onChange=${(e) => set({ genre: e.currentTarget.value })}><option value="">All genres</option>${genres.map((g) => html`<${Option} key=${g} value=${g} selected=${opts.genre === g}>${g}<//>`)}</select>` : null}
    <label class="check" hidden=${isMusic || isSpoken || isReading}><input type="checkbox" checked=${opts.unwatched} onChange=${(e) => set({ unwatched: e.currentTarget.checked })} /><span>Unwatched</span></label>
    <${Tools} lib=${lib} admin=${admin} hasSongs=${hasSongs} collections=${colsPressed} onCollections=${toggleCollections} onSubscribe=${() => subscribeDialog(lib, () => set({}))} />
  </search>`;
  const tabs = isMusic
    ? html`<div class="view-tabs-wrap"><div class="view-tabs" role="group" aria-label="Show">${VIEWS.map(([v, label]) => html`<button key=${v} type="button" class="season-tab" data-view=${v} aria-pressed=${String(v === opts.view)} onClick=${() => opts.view !== v && set({ view: v })}>${label}</button>`)}</div></div>`
    : null;
  const kind = isMusic ? opts.view : lib.type;
  const filtered = Boolean(opts.q || (opts.genre && opts.view !== 'tracks') || opts.unwatched);
  const count = colsOpen ? collectionsCount(cols) ?? countText(items, opts, kind) : countText(items, opts, kind);
  return html`<header class="page-head"><div><h1>${lib.name}</h1><span class="muted count">${count}</span></div>${toolbar}</header>
    ${tabs}
    ${lib.type === 'podcasts' ? html`<${NewEpisodes} items=${fresh} />` : null}
    <div ref=${results} class="library-results">${colsOpen ? html`<${CollectionsResults} data=${cols} />` : html`<${Results} items=${items} busy=${busy} opts=${opts} lib=${lib} isMusic=${isMusic} filtered=${filtered} />`}</div>`;
}
