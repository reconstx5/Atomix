// Orbit's Movies and TV Shows (v0.25, a Preact screen since v0.26): Home's spotlight on top, following the remote;
// one glass bar (Sort ▾, Genre ▾, Unwatched, Search, "…"); the posters scroll under it, with the A–Z rail beside
// them when sorted A–Z.
import { html, useState, useRef, useLayoutEffect, useEffect } from '../ui.js';
import { Button, MoreButton } from '../ui/basics.js';
import { Spotlight } from '../ui/spotlight.js';
import { AzRail } from '../ui/az-rail.js';
import { api } from '../api.js';
import { openSheet, cardItems } from '../components.js';
import { setBackdrop, artFor, followFocus } from '../backdrop.js';
import { followFocus as followBackdrop } from '../focus-backdrop.js';
import { focusSetsBackdrop } from '../focus-backdrop-rules.js';
import { spotStartItem, playFor, countLine, inProgress, railShown } from '../library-rules.js';
import { NOUN, sortsFor, useLibrary, useTypedText, Results, scan, collectionsFor, CollectionsResults, collectionsCount } from './library-parts.js';

export function Shelf({ data, query, view, admin }) {
  const { first, genres, recent } = data;
  const lib = first.library;
  const id = lib.id;
  const [collections, setCollections] = useState(data.collections ? data.collections : null); // shown: { cols } or null
  const [colsOpen, setColsOpen] = useState(Boolean(data.collections));
  const L = useLibrary(id, false, first.items, data.start, { requestView: () => '' });
  const { opts, items, busy, version } = L;
  // Any bar choice made on the Collections view goes back to the films.
  const set = (patch) => {
    setColsOpen(false);
    setCollections(null);
    return L.set(patch);
  };
  const [text, setText, setTextNow] = useTypedText(opts.q, (q) => set({ q }));
  const [boxOpen, setBoxOpen] = useState(Boolean(opts.q));
  const results = useRef(null);
  const box = useRef(null);
  const searchPill = useRef(null);
  const focusAfter = useRef(null); // 'box' | 'pill' | 'card', for the next drawing

  // ---- The spotlight: the focused or hovered poster, with its extra details (one fetch per title) ----
  const [spotItem, setSpotItem] = useState(() => spotStartItem(first.items, recent));
  const [extra, setExtra] = useState(null);
  const shownId = useRef(spotItem?.id);
  shownId.current = spotItem?.id;
  const focusPick = useRef(null); // id of the title the spotlight last took from a focused card (Arctic: focus-backdrop.js sets the artwork)
  const cache = useRef(new Map());
  const details = (item) => {
    if (!cache.current.has(item.id)) {
      cache.current.set(
        item.id,
        api
          .get(`/api/items/${item.id}`)
          .then((d) => ({ trailer: d.trailer || null, seasonCount: d.seasons?.length || null, nextEpisode: d.nextEpisode || null }))
          .catch(() => null),
      );
    }
    return cache.current.get(item.id);
  };
  useEffect(() => {
    if (!spotItem) return;
    details(spotItem).then((d) => {
      // A late answer for a title the spotlight has moved on from changes nothing.
      if (!d || shownId.current !== spotItem.id) return;
      // A show resumes the episode it is part-way through (the recent list knows it; the title's page only knows the next one).
      const mine = recent.find((r) => r.id === spotItem.id)?.episode;
      setExtra({ for: spotItem, trailer: d.trailer, seasonCount: d.seasonCount, playAs: playFor(spotItem, { nextEpisode: mine || d.nextEpisode }) });
    });
  }, [spotItem]);
  const spotShown = extra && extra.for === spotItem ? { ...spotItem, trailer: extra.trailer, seasonCount: extra.seasonCount, playAs: extra.playAs } : spotItem;

  // The spotlight keeps its title while it is still listed, else starts again (the most recent, else the first).
  useLayoutEffect(() => {
    if (!version || !items.length) return;
    const keep = spotItem && items.find((i) => i.id === spotItem.id);
    setSpotItem(keep || spotStartItem(items, recent));
  }, [version]);

  // The spotlight speaks for a title on the page: with none listed (or on Collections) it goes.
  const hideSpot = colsOpen || (!busy && !items.length);
  useLayoutEffect(() => {
    view?.classList.add('library-view', 'has-spot');
  }, []);
  useLayoutEffect(() => {
    view?.classList.toggle('spot-hidden', hideSpot); // the header then starts below the app's top bar, as other pages do
  }, [hideSpot]);

  // The spotlight (and the artwork behind it) follows the focused or hovered poster; past the first row it gets compact.
  useLayoutEffect(() => {
    followFocus(results.current, (card) => cardItems.get(card), (item, o) => { focusPick.current = o && o.mouse ? null : item.id; setSpotItem(item); });
    const onFocus = (e) => {
      if (e.target.closest?.('.az-rail')) return; // the rail keeps the spotlight's size: a press must not move it under the pointer
      const card = e.target.closest?.('.library-results .card');
      const firstCard = results.current?.querySelector('.card');
      const past = Boolean(card && firstCard && card.offsetTop > firstCard.offsetTop);
      view?.classList.toggle('is-compact', past);
      // The first row brings the header (name, count, controls) back into view with it.
      if (card && !past) requestAnimationFrame(() => view?.querySelector('.library-scroll')?.scrollTo({ top: 0 }));
    };
    view?.addEventListener('focusin', onFocus);
    const stopBackdrop = followBackdrop(results.current, { itemOf: (card) => cardItems.get(card) }); // Arctic: the artwork follows a resting card
    return () => {
      view?.removeEventListener('focusin', onFocus);
      stopBackdrop();
    };
  }, []);

  useLayoutEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    if (want === 'box') box.current?.focus();
    else if (want === 'pill') searchPill.current?.focus();
    else if (want === 'card' && !busy) results.current?.querySelector('.card')?.focus(); // the pressed button is gone with the empty state
    if (want !== 'card' || !busy) focusAfter.current = null;
  });

  // ---- The bar ----
  const sortLabel = sortsFor(false, opts.view).find(([v]) => v === opts.sort)?.[1] || 'A–Z';
  const openBox = () => {
    focusAfter.current = 'box';
    setBoxOpen(true);
  };
  const closeBox = (focus) => {
    if (focus) focusAfter.current = 'pill';
    setBoxOpen(false);
  };
  const onBoxKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // Escape here closes the box; it isn't Back
    if (text) {
      setTextNow('');
      set({ q: '' });
    }
    closeBox(true);
  };
  const onBoxBlur = () => setTimeout(() => !box.current?.value && document.activeElement !== box.current && closeBox(false), 0);
  const clearFilters = async () => {
    setTextNow('');
    setBoxOpen(false);
    focusAfter.current = 'card';
    await set({ genre: '', unwatched: false, q: '' });
  };
  const toggleCollections = async () => {
    if (colsOpen) {
      setColsOpen(false);
      setCollections(null);
      L.set({});
      return;
    }
    setColsOpen(true);
    history.replaceState(null, '', `#/library/${id}?view=collections`);
    setCollections(await collectionsFor(id));
  };
  const more = [];
  if (lib.type === 'movies') more.push({ label: 'Collections', icon: 'list', onSelect: toggleCollections, current: colsOpen }); // a tick while its view is open
  if (admin && lib.type !== 'podcasts') more.push({ label: 'Scan', icon: 'refresh', onSelect: () => scan(id) });
  const filter = html`<input ref=${box} type="search" class="lib-search-box" placeholder=${`Filter ${lib.name}`} value=${text} aria-label=${`Filter ${lib.name}`} onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${onBoxKey} onBlur=${onBoxBlur} />`;
  const bar = html`<div class="library-bar kind-pills" role="toolbar" aria-label="Library controls">
    <button type="button" class="pill lib-sort" aria-haspopup="dialog" aria-label=${`Sort: ${sortLabel}`} onClick=${() => openSheet('Sort by', sortsFor(false, opts.view).map(([v, label]) => ({ label, icon: 'list', current: v === opts.sort, onSelect: () => set({ sort: v }) })))}>${`${sortLabel} ▾`}</button>
    ${genres.length ? html`<button type="button" class="pill lib-genre" aria-haspopup="dialog" aria-label=${`Genre: ${opts.genre || 'All genres'}`} onClick=${() => openSheet('Genre', [['', 'All genres'], ...genres.map((g) => [g, g])].map(([v, label]) => ({ label, icon: 'list', current: v === opts.genre, onSelect: () => set({ genre: v }) })))}>${`${opts.genre || 'All genres'} ▾`}</button>` : null}
    <button type="button" class="pill lib-unwatched" aria-pressed=${String(opts.unwatched)} onClick=${() => set({ unwatched: !opts.unwatched })}>Unwatched</button>
    ${boxOpen ? filter : html`<button ref=${searchPill} type="button" class="pill lib-search" onClick=${openBox}>Search</button>`}
    ${more.length ? html`<${MoreButton} title=${lib.name} items=${more} />` : null}
  </div>`;

  const [one, many] = NOUN[lib.type] || NOUN.movies;
  const count = colsOpen ? collectionsCount(collections) ?? countLine(items.length, items.filter(inProgress).length, [one, many]) : countLine(items.length, items.filter(inProgress).length, [one, many]);
  const filtered = Boolean(opts.q || opts.genre || opts.unwatched);
  const clearAction = filtered ? html`<${Button} label="Clear filters" icon="close" variant="secondary" onClick=${clearFilters} />` : null;
  // The A–Z rail: sorted A–Z, 20 or more titles and nothing typed; a new list gets a new rail.
  const rail = !colsOpen && !busy && items.length && railShown({ sort: opts.sort, q: opts.q, count: items.length });
  return html`<${Spotlight} item=${spotShown} quiet=${Boolean(extra && extra.for === spotItem)} hidden=${hideSpot} onShow=${(item) => { const byFocus = focusPick.current === item.id; focusPick.current = null; if (!byFocus || focusSetsBackdrop(document.documentElement.hasAttribute('data-follow-focus'))) setBackdrop(artFor(item)); }} />
    <div class="library-scroll">
      <header class="page-head library-head"><div><h1>${lib.name}</h1><span class="muted count">${count}</span></div><search class="library-bar-wrap">${bar}</search></header>
      <div ref=${results} class="library-results">${colsOpen ? html`<${CollectionsResults} data=${collections} />` : html`<${Results} items=${items} busy=${busy} opts=${opts} lib=${lib} isMusic=${false} filtered=${filtered} clearAction=${clearAction} />`}</div>
    </div>
    ${rail ? html`<${AzRail} key=${version} items=${items} cards=${() => [...results.current.querySelectorAll('.card')]} />` : null}`;
}
