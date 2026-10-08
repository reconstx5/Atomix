// Lists: the Lists page (Watchlist, playlists, collections), a list page (play, reorder with the remote,
// rename/share/delete), and a collection page (the films in order, Play).
import { h, icon, clear, formatRuntime } from '../dom.js';
import { openCastPicker } from '../cast.js';
import { api } from '../api.js';
import { navigate, setTitle, refreshView, isKidsProfile } from '../app.js';
import { button, moreButton, openDialog, confirmDialog, toast, grid, art, emptyState, field, posterCard, landscapeCard, squareCard } from '../components.js';
import { listCard } from '../lists.js';
import { music } from '../music.js';
import { setBackdrop } from '../backdrop.js';

export async function render(el, params) {
  if (params.id && /^#\/collections\//.test(location.hash)) return renderCollection(el, params.id);
  if (params.id) return renderList(el, params.id);
  return renderLists(el);
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

async function renderLists(el) {
  setTitle('Lists');
  const [lists, collections] = await Promise.all([api.get('/api/lists'), api.get('/api/collections')]);
  const wl = lists.find((l) => l.kind === 'watchlist');
  const mine = lists.filter((l) => l.kind !== 'watchlist');
  el.classList.add('lists-view');
  el.append(h('header', { class: 'page-head' }, h('h1', {}, 'Lists')));
  const sec = (title, cards, empty) => h('section', { class: 'detail-section' }, h('h2', {}, title), cards.length ? h('div', { class: 'grid grid-poster', role: 'list' }, cards) : h('p', { class: 'muted' }, empty));
  el.append(sec('My Watchlist', wl && wl.count ? [listCard(wl)] : [], 'Press the plus on any film or show to keep it here.'));
  el.append(sec('Playlists', mine.map(listCard), 'Add to playlist… from any title’s menu makes one.'));
  el.append(sec('Collections', collections.map(collectionCard), 'Film series turn up here as your films are matched.'));
}

async function renderList(el, id) {
  const list = await api.get(`/api/lists/${id}`);
  setTitle(list.name);
  el.classList.add('list-view');
  const state = { rows: list.items }; // a move or a remove redraws the rows in place; Play and the count read these
  const items = state.rows;
  const runtimeOf = (rows) => rows.reduce((s, i) => s + (i.duration || 0), 0);
  // Play starts at the first unwatched film, episode or song; a show in the Watchlist is opened, not played.
  const playableOf = (rows) => rows.filter((i) => i.kind === 'movie' || i.kind === 'episode' || i.kind === 'track');
  const playable = () => playableOf(state.rows);
  const firstUnwatched = () => playable().find((i) => !i.progress?.watched) || playable()[0];
  const actions = [];
  if (list.kind === 'music' && playable().length) {
    actions.push(button('Play', { icon: 'play', variant: 'primary', autofocus: true, onClick: () => music.playTracks(playable(), 0) }));
    actions.push(button('Shuffle', { icon: 'shuffle', onClick: () => music.playTracks(playable(), -1, { shuffle: true }) }));
  } else if (firstUnwatched()) actions.push(button('Play', { icon: 'play', variant: 'primary', autofocus: true, href: `#/play/${firstUnwatched().id}?list=${list.id}` }));
  const playLink = actions[0]?.tagName === 'A' ? actions[0] : null;
  // A music playlist casts as a queue: Atomix plays it on the TV, song after song.
  const castItem = list.kind === 'music' && playable().length ? { label: 'Cast to…', icon: 'cast', onSelect: () => openCastPicker({ queue: { itemIds: playable().map((i) => i.id), index: 0 } }) } : null;
  if (castItem && !(list.own && list.kind !== 'watchlist')) actions.push(moreButton(list.name, [castItem]));
  if (list.own && list.kind !== 'watchlist') {
    actions.push(
      moreButton(list.name, [
        castItem,
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
      ]),
    );
  }
  const countLine = (rows) => {
    const what = list.kind === 'music' ? (rows.length === 1 ? 'song' : 'songs') : rows.length === 1 ? 'title' : 'titles';
    const total = runtimeOf(rows);
    return `${rows.length} ${what}${total ? ` · ${formatRuntime(total / 60)}` : ''}${list.own ? '' : ' · shared with you'}`;
  };
  const count = h('p', { class: 'muted' }, countLine(items));
  el.append(
    h(
      'header',
      { class: 'page-head list-head' },
      h('div', {}, h('h1', {}, list.name), count),
      h('div', { class: 'actions' }, actions),
    ),
  );
  if (!items.length) {
    el.append(emptyState({ title: 'Nothing here yet', text: list.kind === 'watchlist' ? 'Press the plus on any film or show.' : 'Use Add to playlist… from a title’s menu.' }));
    return;
  }
  const ul = h('ol', { class: 'list-items', role: 'list' });
  /** Draws the items; `focusId` puts the remote on that item's "…" (a move or a remove keeps the place). */
  const renderItems = (rows, focusId = null) => {
    state.rows = rows;
    count.textContent = countLine(rows);
    if (playLink && firstUnwatched()) playLink.href = `#/play/${firstUnwatched().id}?list=${list.id}`;
    clear(ul);
    rows.forEach((item, i) => {
      const card = item.kind === 'track' ? squareCard(item) : item.kind === 'episode' ? landscapeCard(item) : posterCard(item);
      const menu = list.own
        ? moreButton(item.title, [
            i > 0 ? { label: 'Move up', icon: 'up', onSelect: () => moveItem(list, item, i - 1, rows, renderItems) } : null,
            i < rows.length - 1 ? { label: 'Move down', icon: 'chevronDown', onSelect: () => moveItem(list, item, i + 1, rows, renderItems) } : null,
            {
              label: 'Remove',
              icon: 'trash',
              onSelect: () =>
                attempt(async () => {
                  await api.del(`/api/lists/${list.id}/items/${item.id}`);
                  const rest = rows.filter((r) => r.id !== item.id);
                  if (!rest.length) return refreshView(); // the page says "Nothing here yet" and Play goes
                  renderItems(rest, (rest[i] || rest[i - 1]).id); // the one that took its place, else the one before
                }),
            },
            { label: 'Go to title', icon: 'forward', href: `#/item/${item.kind === 'track' ? item.parentId : item.id}` },
          ])
        : null;
      ul.append(h('li', { class: 'list-item', draggable: list.own ? 'true' : null, dataset: { id: item.id } }, h('span', { class: 'list-index' }, String(i + 1)), card, menu));
    });
    if (focusId != null) ul.querySelector(`.list-item[data-id="${focusId}"] [aria-haspopup="dialog"]`)?.focus();
  };
  renderItems(items);
  if (list.own) dragToReorder(ul, list);
  el.append(ul);
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

function moveItem(list, item, position, rows, renderItems) {
  return attempt(async () => {
    await api.put(`/api/lists/${list.id}/items/${item.id}/position`, { position });
    const next = rows.filter((r) => r.id !== item.id);
    next.splice(position, 0, item);
    renderItems(next, item.id); // the page stays where it is and the remote stays on the moved item
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

async function renderCollection(el, id) {
  const c = await api.get(`/api/collections/${id}`);
  setTitle(c.name);
  el.classList.add('collection-view');
  setBackdrop(c.backdrop || c.poster);
  const firstUnwatched = c.items.find((i) => !i.progress?.watched) || c.items[0];
  el.append(
    h(
      'header',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, c.name), h('p', { class: 'muted' }, `${c.owned} of ${c.total} in your library`), c.overview ? h('p', { class: 'overview' }, c.overview) : null),
      h('div', { class: 'actions' }, button('Play', { icon: 'play', variant: 'primary', autofocus: true, href: firstUnwatched.kind === 'show' ? `#/item/${firstUnwatched.id}` : `#/play/${firstUnwatched.id}` })),
    ),
  );
  el.append(h('section', { class: 'detail-section' }, h('h2', { class: 'visually-hidden' }, 'Titles'), grid(c.items, { style: 'poster' })));
  if (c.missing.length) {
    el.append(h('section', { class: 'detail-section' }, h('h2', {}, 'Not in your library'), h('ul', { class: 'missing-list muted', role: 'list' }, c.missing.map((m) => h('li', {}, `${m.title}${m.year ? ` (${m.year})` : ''}`)))));
  }
}
