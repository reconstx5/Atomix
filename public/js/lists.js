// Client side of playlists and the Watchlist: the Watchlist button, the "Add to playlist…" sheets, list cards.
import { h, icon } from './dom.js';
import { api } from './api.js';
import { button, openSheet, openDialog, toast, field } from './components.js';

/** A round plus that becomes a tick: the profile's Watchlist. */
export function watchlistButton(item, initialIn) {
  let on = Boolean(initialIn);
  const el = button('', { icon: on ? 'check' : 'plus', variant: 'ghost', title: on ? 'In your Watchlist' : 'Add to Watchlist', attrs: { 'aria-pressed': String(on), 'aria-label': 'Watchlist' } });
  el.classList.add('watchlist-btn');
  let busy = false;
  el.addEventListener('click', async () => {
    if (busy) return; // a press while the last one is on its way: aria-pressed must match the server
    busy = true;
    el.setAttribute('aria-busy', 'true');
    try {
      if (on) await api.del(`/api/watchlist/${item.id}`);
      else await api.put(`/api/watchlist/${item.id}`, {});
      on = !on;
      el.setAttribute('aria-pressed', String(on));
      el.title = on ? 'In your Watchlist' : 'Add to Watchlist';
      el.replaceChildren(icon(on ? 'check' : 'plus', { size: 20 }));
      toast(on ? 'Added to your Watchlist' : 'Removed from your Watchlist');
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      busy = false;
      el.removeAttribute('aria-busy');
    }
  });
  return el;
}

async function pickList(kind, onPick) {
  const lists = (await api.get('/api/lists')).filter((l) => l.own && l.kind === kind);
  openSheet('Add to playlist', [
    ...lists.map((l) => ({ label: l.name, icon: kind === 'music' ? 'music' : 'film', onSelect: () => onPick(l) })),
    { label: 'New playlist…', icon: 'plus', onSelect: () => newList(kind, onPick) },
  ]);
}

function newList(kind, onPick) {
  const name = h('input', { type: 'text', name: 'name', maxlength: '80', required: true, autocomplete: 'off', 'data-autofocus': true });
  openDialog({
    title: 'New playlist',
    body: field('Name', name),
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create', value: 'ok', variant: 'primary' }],
    onSubmit: async () => {
      const list = await api.post('/api/lists', { kind, name: name.value });
      onPick(list);
    },
  });
}

/**
 * A sheet entry for a title. `what` is { itemId }, { seasonId } or { itemIds } (several songs, in order);
 * `kind` picks video or song playlists.
 */
export function addToPlaylistItems(what, { kind = 'video', label = 'Add to playlist…' } = {}) {
  return {
    label,
    icon: 'plus',
    onSelect: () =>
      pickList(kind, async (list) => {
        try {
          if (what.itemIds) for (const itemId of what.itemIds) await api.post(`/api/lists/${list.id}/items`, { itemId });
          else await api.post(`/api/lists/${list.id}/items`, what);
          toast(`Added to ${list.name}`);
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      }),
  };
}

/** A playlist card for a Home row or the Lists page: the name over a 2 × 2 mosaic of its first posters. */
export function listCard(list) {
  const count = list.kind === 'music' ? `${list.count} ${list.count === 1 ? 'song' : 'songs'}` : `${list.count} ${list.count === 1 ? 'title' : 'titles'}`;
  return h(
    'a',
    { class: 'card card-list', href: `#/lists/${list.id}`, dataset: { id: list.id } },
    h(
      'div',
      { class: 'card-art list-mosaic' },
      [0, 1, 2, 3].map((i) => (list.posters[i] ? h('img', { src: list.posters[i], alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'list-blank' }))),
      list.kind === 'watchlist' ? icon('plus', { size: 28 }) : null,
    ),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, list.name), h('span', { class: 'card-sub' }, `${count}${list.own ? '' : ` · ${list.ownerName}`}`)),
  );
}
