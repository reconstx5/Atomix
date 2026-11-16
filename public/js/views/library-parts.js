// The library page's shared pieces (v0.26): its sorts and nouns, the state of its filters (kept in the address), the
// results (posters, squares or the songs list), podcasts' New episodes, the buttons for each library type and the
// podcast Subscribe dialog. views/library.js puts them together; library-shelf.js is Orbit's Movies and TV Shows.
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Button, EmptyState, Spinner } from '../ui/basics.js';
import { Grid, Row } from '../ui/cards.js';
import { Island } from '../ui/basics.js';
import { api, qs } from '../api.js';
import { SONG_LIMIT, NOUN, sortsFor, request } from './library-data.js';

export { SONG_LIMIT, SORTS, VIEWS, NOUN, sortsFor, request, startOpts, newEpisodes, collectionsFor } from './library-data.js';
import { h, clear, debounce } from '../dom.js';
import { toast, openDialog, field, spinner, TOASTS, cardItems } from '../components.js';
import { music, trackList } from '../music.js';

/**
 * The filters and the items they show. `set(patch)` changes filters, puts them in the address (so Back returns to
 * them) and fetches again; only the latest answer is drawn. `requestView` is the `view` sent (Collections, below).
 */
export function useLibrary(id, isMusic, first, start, { requestView = (o) => o.view } = {}) {
  const [opts, setOpts] = useState(start);
  const [items, setItems] = useState(first);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0); // each answer drawn
  const seq = useRef(0);
  const left = useRef(false);
  const latest = useRef(opts); // the filters in force, for a change that settles after another (typing, then Sort)
  useLayoutEffect(() => () => (left.current = true), []);
  async function set(patch) {
    if (left.current) return undefined;
    const next = { ...latest.current, ...patch };
    latest.current = next;
    if (patch.view !== undefined && !sortsFor(isMusic, next.view).some(([v]) => v === next.sort)) next.sort = 'title';
    setOpts(next);
    history.replaceState(null, '', `#/library/${id}${qs({ view: isMusic && next.view !== 'albums' ? next.view : '', sort: next.sort !== 'title' ? next.sort : '', genre: next.genre, unwatched: next.unwatched, q: next.q })}`);
    const my = ++seq.current;
    setBusy(true);
    let data;
    try {
      data = await request(id, next, requestView(next));
    } catch (err) {
      // v0.28: a failed answer takes the spinner down and says so; the titles shown before come back.
      if (left.current || my !== seq.current) return undefined;
      setBusy(false);
      toast(err.message ? `Couldn't load these titles: ${err.message}. Try again.` : "Couldn't load these titles. Try again.", { type: 'error' });
      return undefined;
    }
    if (left.current || my !== seq.current) return; // a newer choice (or another page) has taken over
    setItems(data.items);
    setBusy(false);
    setVersion((v) => v + 1);
    return data.items;
  }
  return { opts, items, busy, version, set };
}

/** The text of a filter box: its own state (so a redraw never puts back older text), handed on 250 ms after typing. */
export function useTypedText(value, onSettle) {
  const [text, setText] = useState(value);
  const settled = useRef(value);
  const settle = useRef(onSettle);
  settle.current = onSettle; // the latest, so it sees the filters in force when it fires
  useLayoutEffect(() => {
    const q = text.trim();
    if (q === settled.current) return undefined;
    const t = setTimeout(() => {
      settled.current = q;
      settle.current(q);
    }, 250);
    return () => clearTimeout(t); // a layout effect: leaving the page stops it at once
  }, [text]);
  // Set at once (Escape, Clear filters): no wait, no second fetch.
  const now = (t) => {
    settled.current = t.trim();
    setText(t);
  };
  return [text, setText, now];
}

/** The results: the empty state, the songs list, or the grid. */
export function Results({ items, busy, opts, lib, isMusic, filtered, clearAction = null }) {
  if (busy) return html`<${Spinner} />`;
  if (!items.length) {
    return html`<${EmptyState}
      title=${filtered ? 'Nothing matches' : 'This library is empty'}
      text=${filtered ? 'Try clearing the filters.' : 'If you just added it, the scan may still be running.'}
      action=${clearAction}
    />`;
  }
  if (opts.view === 'tracks') {
    return html`<${Island} class="song-list" make=${() => trackList(items, { showAlbum: true, numbers: false })} deps=${[items]} />${items.length >= SONG_LIMIT ? html`<p class="muted center small">${`Showing the first ${SONG_LIMIT} songs — use the filter to find others.`}</p>` : null}`;
  }
  const spoken = lib.type === 'podcasts' || lib.type === 'audiobooks';
  return html`<${Grid} items=${items} style=${isMusic || spoken ? 'square' : 'poster'} />`;
}

/** "12 movies", "500+ songs". */
export function countText(items, opts, kind) {
  const [one, many] = NOUN[kind] || NOUN.movies;
  return `${items.length}${opts.view === 'tracks' && items.length >= SONG_LIMIT ? '+' : ''} ${items.length === 1 ? one : many}`;
}

export function NewEpisodes({ items }) {
  const play = async (e) => {
    const card = e.target.closest('.card');
    const ep = card && cardItems.get(card);
    if (!ep) return;
    e.preventDefault();
    (await import('../spoken.js')).playEpisode(ep, { show: { title: ep.showTitle, poster: ep.poster } });
  };
  return html`<div class="new-episodes" onClick=${play}>${items.length ? html`<${Row} id="new-episodes" title="New episodes" items=${items} style="landscape" />` : null}</div>`;
}

/** A button that is disabled while its job runs. */
function BusyButton({ run, ...props }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };
  return html`<${Button} ...${props} onClick=${onClick} attrs=${{ ...(props.attrs || {}), ...(busy ? { disabled: true } : {}) }} />`;
}

/**
 * The library type's own buttons, in the older themes' toolbar: Collections (films), Shuffle all (music), Subscribe
 * and Check now (podcasts, admins), Scan (other libraries, admins).
 */
export function Tools({ lib, admin, hasSongs, collections, onCollections, onSubscribe }) {
  const id = lib.id;
  const out = [];
  if (lib.type === 'movies') out.push(html`<${Button} key="collections" label="Collections" icon="list" variant="ghost" onClick=${onCollections} attrs=${{ 'aria-pressed': String(collections) }} />`);
  if (lib.type === 'music') {
    out.push(html`<${BusyButton}
      key="shuffle"
      label="Shuffle all"
      icon="shuffle"
      variant="primary"
      attrs=${hasSongs ? {} : { disabled: true, title: 'No songs in this library yet' }}
      run=${async () => {
        try {
          const data = await api.get(`/api/libraries/${id}/items${qs({ view: 'tracks', sort: 'random', limit: SONG_LIMIT })}`);
          if (data.items.length) music.playTracks(data.items, 0);
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      }}
    />`);
  }
  if (lib.type === 'podcasts' && admin) {
    out.push(
      html`<${Button} key="subscribe" label="Subscribe" icon="plus" variant="primary" onClick=${onSubscribe} />`,
      html`<${BusyButton}
        key="check"
        label="Check now"
        icon="refresh"
        variant="ghost"
        title="Look for new episodes of every podcast here"
        run=${async () => {
          const r = await api.post('/api/podcasts/check-all', {});
          toast(`Checking ${r.checked} ${r.checked === 1 ? 'podcast' : 'podcasts'} for new episodes`);
        }}
      />`,
    );
  } else if (admin) {
    out.push(html`<${Button} key="scan" label="Scan" icon="refresh" variant="ghost" title="Look for new and removed files" onClick=${() => scan(id)} />`);
  }
  return out;
}
export async function scan(id) {
  await api.post(`/api/libraries/${id}/scan`, {});
  TOASTS.scanStarted();
}

export function CollectionsResults({ data }) {
  if (!data) return html`<${Spinner} />`;
  const { cols, collectionCard } = data;
  if (!cols.length) return html`<${EmptyState} title="No collections yet" text="Collections appear here as your movies are matched; admins can make their own in Settings → Libraries." />`;
  return html`<${Island} class="grid grid-poster" role="list" make=${() => cols.map(collectionCard)} deps=${[cols]} />`;
}
export const collectionsCount = (data) => (data ? `${data.cols.length} ${data.cols.length === 1 ? 'collection' : 'collections'}` : null);

/** Subscribe (admins): search the podcast directory, or paste a feed's address. A dialog: built as before. */
export function subscribeDialog(lib, done) {
  const search = h('input', { type: 'search', placeholder: 'Name of a podcast', 'aria-label': 'Search the directory', 'data-autofocus': '' });
  const found = h('ul', { class: 'directory-results', role: 'list', 'aria-live': 'polite' });
  const address = h('input', { type: 'url', placeholder: 'https://…', autocomplete: 'off' });
  const subscribe = async (body, title) => {
    const row = await api.post('/api/podcasts', { libraryId: lib.id, ...body });
    toast(`Subscribed to ${row?.title || title || 'the podcast'}`);
    document.querySelector('dialog[open]')?.close('done');
    done();
  };
  const look = debounce(async () => {
    const q = search.value.trim();
    clear(found);
    if (q.length < 2) return;
    found.append(h('li', {}, spinner('Searching', { inline: true })));
    let list = [];
    try {
      list = await api.get(`/api/podcasts/directory${qs({ q })}`);
    } catch (err) {
      clear(found).append(h('li', { class: 'form-error' }, err.message));
      return;
    }
    if (search.value.trim() !== q) return;
    clear(found).append(
      ...(list.length
        ? list.map((p) =>
            h(
              'li',
              { class: 'directory-result' },
              p.artwork ? h('img', { src: p.artwork, alt: '', loading: 'lazy', width: 56, height: 56 }) : h('span', { class: 'directory-art' }),
              h('span', { class: 'directory-text' }, h('strong', {}, p.name), p.author ? h('span', { class: 'muted small' }, p.author) : null),
              h('button', {
                type: 'button',
                class: 'btn btn-secondary',
                'aria-label': `Subscribe to ${p.name}`,
                onClick: async (e) => {
                  e.currentTarget.disabled = true;
                  try {
                    await subscribe({ directoryId: p.id }, p.name);
                  } catch (err) {
                    e.currentTarget.disabled = false;
                    toast(err.message, { type: 'error' });
                  }
                },
              }, 'Subscribe'),
            ),
          )
        : [h('li', { class: 'muted' }, 'Nothing found — try another name, or paste the feed’s address below.')]),
    );
  }, 350);
  search.addEventListener('input', look);
  return openDialog({
    title: 'Subscribe to a podcast',
    wide: true,
    body: h('div', { class: 'stack' }, field('Search the directory', search), found, field('Or the feed’s address', address, 'The RSS address from the podcast’s website.')),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Subscribe', value: 'feed', variant: 'primary' },
    ],
    onSubmit: async () => {
      const url = address.value.trim();
      if (!url) throw new Error('Choose a podcast from the search, or paste its feed’s address.');
      await subscribe({ feedUrl: url });
      return false; // subscribe() closed it
    },
  });
}
