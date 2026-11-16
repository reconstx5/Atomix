// Lists: the Lists page (Watchlist, playlists, collections), a list page (play, reorder with the remote,
// rename/share/delete), and a collection page (the films in order, Play). v0.28: Preact screens, the same elements as
// before (collectionCard() stays for the library's Collections view).
import { downloadSheetItem } from '../offline/ui.js';
import { h, formatRuntime } from '../dom.js';
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Button, EmptyState, MoreButton } from '../ui/basics.js';
import { Art, ListCard, PosterCard, LandscapeCard, SquareCard, Grid } from '../ui/cards.js';
import { openCastPicker } from '../cast.js';
import { api } from '../api.js';
import { navigate, setTitle, refreshView, isKidsProfile, state as app, canAdmin } from '../app.js';
import { openDialog, confirmDialog, toast, art, field, browseTarget } from '../components.js';
import { music } from '../music.js';
import { setBackdrop } from '../backdrop.js';

export async function load(params) {
  if (params.id && /^#\/collections\//.test(location.hash)) {
    const c = await api.get(`/api/collections/${params.id}`);
    setTitle(c.name);
    return { page: 'collection', c };
  }
  if (params.id) {
    const list = await api.get(`/api/lists/${params.id}`);
    setTitle(list.name);
    return { page: 'list', list };
  }
  setTitle('Lists');
  const [lists, collections] = await Promise.all([api.get('/api/lists'), api.get('/api/collections')]);
  return { page: 'lists', lists, collections };
}

export function Screen({ data, view }) {
  useLayoutEffect(() => view.classList.add({ lists: 'lists-view', list: 'list-view', collection: 'collection-view' }[data.page]), []);
  if (data.page === 'collection') return html`<${CollectionPage} c=${data.c} />`;
  if (data.page === 'list') return html`<${ListPage} list=${data.list} />`;
  return html`<${ListsPage} lists=${data.lists} collections=${data.collections} />`;
}

/** A collection card: the poster, the name and how much of it you own. */
export function collectionCard(c) {
  return h(
    'a',
    { class: 'card collection-card', href: `#/collections/${c.id}`, dataset: { id: c.id } },
    h('div', { class: 'card-art' }, art(c.poster || c.firstPoster, c.name, { kind: 'poster' })),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, c.name), h('span', { class: 'card-sub' }, `${c.owned} of ${c.total}`)),
  );
}

/** collectionCard() as a component. */
function CollectionCard({ c }) {
  return html`<a class="card collection-card" href=${`#/collections/${c.id}`} data-id=${c.id}>
    <div class="card-art"><${Art} src=${c.poster || c.firstPoster} title=${c.name} kind="poster" /></div>
    <div class="card-meta"><span class="card-title">${c.name}</span><span class="card-sub">${`${c.owned} of ${c.total}`}</span></div>
  </a>`;
}

/** The "Browse …" offer for an empty list of `kind`, or null when no library of that kind exists. */
function BrowseButton({ kind }) {
  const t = browseTarget(app.libraries, kind);
  return t ? html`<${Button} label=${t.label} icon=${t.icon} variant="ghost" href=${t.href} />` : null;
}
const hasBrowse = (kind) => Boolean(browseTarget(app.libraries, kind));

/** A section of the Lists page; an empty one says what fills it and, where there is somewhere to go, the way there. */
function Section({ title, cards, empty, action = null, extra = null }) {
  return html`<section class="detail-section"><h2>${title}</h2>${extra}${cards.length
    ? html`<div class="grid grid-poster" role="list">${cards}</div>`
    : html`<div class="section-empty"><${EmptyState} title=${`No ${title === 'My Watchlist' ? 'titles in your Watchlist' : title.toLowerCase()} yet`} text=${empty} action=${action} icon="list" level=${3} /></div>`}</section>`;
}

function ListsPage({ lists, collections }) {
  const wl = lists.find((l) => l.kind === 'watchlist');
  const mine = lists.filter((l) => l.kind !== 'watchlist');
  return html`<header class="page-head"><h1>Lists</h1></header>
    <${Section} title="My Watchlist" cards=${wl && wl.count ? [html`<${ListCard} key=${wl.id} list=${wl} />`] : []} empty="Press the plus on any movie or show to keep it here." action=${hasBrowse('watchlist') ? html`<${BrowseButton} kind="watchlist" />` : null} />
    <${Section} title="Playlists" cards=${mine.map((l) => html`<${ListCard} key=${l.id} list=${l} />`)} empty="Use Add to playlist… on any title’s menu to make one." extra=${html`<div class="actions section-actions"><${Button} label="New smart playlist" icon="sparkle" variant="ghost" href="#/lists/smart/new" /></div>`} />
    <${Section} title="Collections" cards=${collections.map((c) => html`<${CollectionCard} key=${c.id} c=${c} />`)} empty="Collections appear here as your movies are matched." action=${canAdmin() ? html`<${Button} label="Manage libraries" icon="settings" variant="ghost" href="#/settings/libraries" />` : null} />`;
}

function ListPage({ list }) {
  const smart = list.kind === 'smart';
  const isMusic = list.kind === 'music' || (smart && list.media === 'music');
  const editable = list.own && list.kind !== 'watchlist' && !smart; // a smart list fills itself: no reorder or remove
  // A move or a remove redraws the rows in place; `focus` puts the remote on that item's "…" afterwards.
  const [{ rows, focus }, setShown] = useState({ rows: list.items, focus: null });
  const show = (next, focusId = null) => setShown({ rows: next, focus: focusId });
  const ol = useRef(null);
  useLayoutEffect(() => {
    if (focus != null) ol.current?.querySelector(`.list-item[data-id="${focus}"] [aria-haspopup="dialog"]`)?.focus();
  }, [rows, focus]);
  useLayoutEffect(() => {
    if (editable && ol.current) dragToReorder(ol.current, list);
  }, []);
  const runtimeOf = (r) => r.reduce((s, i) => s + (i.duration || 0), 0);
  // Play starts at the first unwatched film, episode or song; a show in the Watchlist is opened, not played.
  const playable = rows.filter((i) => i.kind === 'movie' || i.kind === 'episode' || i.kind === 'track');
  const firstUnwatched = playable.find((i) => !i.progress?.watched) || playable[0];
  const actions = [];
  if (isMusic && playable.length) {
    actions.push(html`<${Button} key="play" label="Play" icon="play" variant="primary" autofocus=${true} onClick=${() => music.playTracks(playable, 0)} />`);
    actions.push(html`<${Button} key="shuffle" label="Shuffle" icon="shuffle" onClick=${() => music.playTracks(playable, -1, { shuffle: true })} />`);
  } else if (firstUnwatched) actions.push(html`<${Button} key="play" label="Play" icon="play" variant="primary" autofocus=${true} href=${`#/play/${firstUnwatched.id}?list=${list.id}`} />`);
  // A music playlist casts as a queue: Atomix plays it on the TV, song after song.
  const castItem = isMusic && playable.length ? { label: 'Cast to…', icon: 'cast', onSelect: () => openCastPicker({ queue: { itemIds: playable.map((i) => i.id), index: 0 } }) } : null;
  // v0.21: the whole playlist into the app.
  const dlItem = downloadSheetItem({ id: list.id, title: list.name, kind: isMusic ? 'album' : 'list' }, { label: 'Download all', listId: list.id });
  if ((castItem || dlItem) && !(list.own && list.kind !== 'watchlist')) actions.push(html`<${MoreButton} key="more" title=${list.name} items=${[castItem, dlItem].filter(Boolean)} />`);
  if (smart && list.own) actions.push(html`<${Button} key="rules" label="Edit rules" icon="edit" variant="ghost" href=${`#/lists/${list.id}/rules`} />`);
  if (list.own && list.kind !== 'watchlist') {
    const items = [
      castItem,
      dlItem,
      { label: 'Rename', icon: 'edit', onSelect: () => renameList(list) },
      // Kids profiles can't share (the server refuses too), so the switch isn't offered to them.
      isKidsProfile()
        ? null
        : {
            label: list.shared ? 'Keep to me' : 'Share with everyone',
            icon: list.shared ? 'lock' : 'users',
            onSelect: () =>
              attempt(async () => {
                await api.patch(`/api/lists/${list.id}`, { shared: !list.shared });
                toast(list.shared ? 'Kept to you' : 'Shared with everyone');
                refreshView();
              }),
          },
      {
        label: 'Delete',
        icon: 'trash',
        onSelect: async () => {
          if (await confirmDialog('Delete this playlist?', `“${list.name}” will be gone for everyone.`, { confirm: 'Delete', danger: true })) {
            await attempt(async () => {
              await api.del(`/api/lists/${list.id}`);
              navigate('#/lists', { replace: true });
            });
          }
        },
      },
    ];
    actions.push(html`<${MoreButton} key="own" title=${list.name} items=${items} />`);
  }
  const what = isMusic ? (rows.length === 1 ? 'song' : 'songs') : rows.length === 1 ? 'title' : 'titles';
  const total = runtimeOf(rows);
  const countLine = `${rows.length} ${what}${total ? ` · ${formatRuntime(total / 60)}` : ''}${list.own ? '' : ' · shared with you'}`;
  const head = html`<header class="page-head list-head">
    <div><h1>${list.name}</h1><p class="muted">${countLine}</p>${smart ? html`<p class="muted small smart-line">${smartLine(list)}</p>` : null}</div>
    <div class="actions">${actions}</div>
  </header>`;
  if (!list.items.length) {
    if (smart) {
      return html`${head}<${EmptyState} title="Nothing matches yet" text="Nothing in the library fits these rules today. Change the rules, or come back as the library grows." action=${list.own ? html`<${Button} label="Edit rules" icon="edit" variant="ghost" href=${`#/lists/${list.id}/rules`} />` : null} icon="sparkle" />`;
    }
    return html`${head}<${EmptyState} title="Nothing here yet" text=${list.kind === 'watchlist' ? 'Press the plus on any movie or show to keep it here.' : 'Use Add to playlist… on any title’s menu to add songs or titles.'} action=${!smart && hasBrowse(list.kind) ? html`<${BrowseButton} kind=${list.kind} />` : null} icon=${list.kind === 'music' ? 'music' : 'film'} />`;
  }
  const row = (item, i) => {
    const card = item.kind === 'track' ? html`<${SquareCard} item=${item} />` : item.kind === 'episode' ? html`<${LandscapeCard} item=${item} />` : html`<${PosterCard} item=${item} />`;
    const menu = editable
      ? html`<${MoreButton}
          title=${item.title}
          items=${[
            i > 0 ? { label: 'Move up', icon: 'up', onSelect: () => moveItem(list, item, i - 1, rows, show) } : null,
            i < rows.length - 1 ? { label: 'Move down', icon: 'chevronDown', onSelect: () => moveItem(list, item, i + 1, rows, show) } : null,
            {
              label: 'Remove',
              icon: 'trash',
              onSelect: () =>
                attempt(async () => {
                  await api.del(`/api/lists/${list.id}/items/${item.id}`);
                  const rest = rows.filter((r) => r.id !== item.id);
                  if (!rest.length) return refreshView(); // the page says "Nothing here yet" and Play goes
                  show(rest, (rest[i] || rest[i - 1]).id); // the one that took its place, else the one before
                }),
            },
            { label: 'Go to title', icon: 'forward', href: `#/item/${item.kind === 'track' ? item.parentId : item.id}` },
          ]}
        />`
      : null;
    return html`<li key=${item.id} class="list-item" ...${editable ? { draggable: 'true' } : {}} data-id=${item.id}><span class="list-index">${String(i + 1)}</span>${card}${menu}</li>`;
  };
  return html`${head}<ol ref=${ol} class="list-items" role="list">${rows.map(row)}</ol>`;
}

/** "Smart playlist · matches all of 2 rules" (or "every song" with none). */
function smartLine(list) {
  const n = list.rules?.rules?.length || 0;
  if (!n) return `Smart playlist · ${list.media === 'music' ? 'every song' : 'every film and episode'}`;
  return `Smart playlist · matches ${n === 1 ? 'one rule' : `${list.rules.match === 'any' ? 'any' : 'all'} of ${n} rules`}`;
}

/** Run a list change; a refused or failed one says so instead of silently doing nothing. */
async function attempt(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message || 'That didn’t work', { type: 'error' });
    if (err.status === 404) navigate('#/lists', { replace: true });
  }
}

function moveItem(list, item, position, rows, show) {
  return attempt(async () => {
    await api.put(`/api/lists/${list.id}/items/${item.id}/position`, { position });
    const next = rows.filter((r) => r.id !== item.id);
    next.splice(position, 0, item);
    show(next, item.id); // the page stays where it is and the remote stays on the moved item
  });
}

function renameList(list) {
  const name = h('input', { type: 'text', name: 'name', value: list.name, maxlength: '80', required: true, 'data-autofocus': true });
  openDialog({
    title: 'Rename playlist',
    body: field('Name', name),
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', variant: 'primary' }],
    onSubmit: async () => {
      await api.patch(`/api/lists/${list.id}`, { name: name.value });
      refreshView();
    },
  });
}

/** Mouse: drag a row to a new place; the drop saves the order. */
function dragToReorder(ul, list) {
  let dragging = null;
  ul.addEventListener('dragstart', (e) => {
    dragging = e.target.closest('.list-item');
    if (dragging) e.dataTransfer.effectAllowed = 'move';
  });
  ul.addEventListener('dragover', (e) => {
    e.preventDefault();
    const over = e.target.closest('.list-item');
    if (!over || !dragging || over === dragging) return;
    const r = over.getBoundingClientRect();
    ul.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  ul.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!dragging) return;
    const position = [...ul.children].indexOf(dragging);
    const id = dragging.dataset.id;
    dragging = null;
    await attempt(async () => {
      await api.put(`/api/lists/${list.id}/items/${id}/position`, { position });
      refreshView();
    });
  });
}

function CollectionPage({ c }) {
  useLayoutEffect(() => setBackdrop(c.backdrop || c.poster), []);
  const firstUnwatched = c.items.find((i) => !i.progress?.watched) || c.items[0];
  return html`<header class="page-head">
      <div><h1>${c.name}</h1><p class="muted">${`${c.owned} of ${c.total} in your library`}</p>${c.overview ? html`<p class="overview">${c.overview}</p>` : null}</div>
      <div class="actions"><${Button} label="Play" icon="play" variant="primary" autofocus=${true} href=${firstUnwatched.kind === 'show' ? `#/item/${firstUnwatched.id}` : `#/play/${firstUnwatched.id}`} /></div>
    </header>
    <section class="detail-section"><h2 class="visually-hidden">Titles</h2><${Grid} items=${c.items} style="poster" /></section>
    ${c.missing.length ? html`<section class="detail-section"><h2>Not in your library</h2><ul class="missing-list muted" role="list">${c.missing.map((m, i) => html`<li key=${i}>${`${m.title}${m.year ? ` (${m.year})` : ''}`}</li>`)}</ul></section>` : null}`;
}
