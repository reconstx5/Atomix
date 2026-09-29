// Add-ons: content sources provided by plugins (like Kodi video add-ons).
import { api, qs } from '../api.js';
import { h, icon, clear } from '../dom.js';
import { art, emptyState, spinner, button } from '../components.js';
import { setTitle, navigate, canAdmin } from '../app.js';

function sourceTile(src) {
  return h(
    'a',
    { class: 'card addon-tile', href: `#/addons/${src.pluginId}/${src.id}` },
    h('span', { class: 'addon-icon' }, icon(src.icon && ['archive', 'film', 'tv', 'folder', 'sparkle'].includes(src.icon) ? src.icon : 'addons', { size: 34 })),
    h('span', { class: 'card-title' }, src.name),
    src.description ? h('span', { class: 'card-sub' }, src.description) : null,
  );
}

function entryCard(params, entry) {
  const href =
    entry.kind === 'folder'
      ? `#/addons/${params.plugin}/${params.source}${qs({ path: entry.path ?? entry.id })}`
      : `#/play-source/${params.plugin}/${params.source}${qs({ id: entry.id, title: entry.title })}`;
  return h(
    'a',
    { class: `card poster-card${entry.kind === 'folder' ? ' is-folder' : ''}`, href, title: entry.overview || entry.title },
    h('div', { class: 'card-art' }, art(entry.poster, entry.title), entry.kind === 'folder' ? h('span', { class: 'badge' }, icon('folder', { size: 14 })) : null),
    h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, entry.title), entry.year || entry.subtitle ? h('span', { class: 'card-sub' }, String(entry.subtitle || entry.year)) : null),
  );
}

export async function render(el, params, query) {
  if (!params.plugin) {
    setTitle('Add-ons');
    const sources = await api.get('/api/sources');
    el.append(h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Add-ons'), h('p', { class: 'muted' }, 'Extra sources of video provided by plugins.'))));
    if (!sources.length) {
      el.append(
        emptyState({
          title: 'No add-on sources enabled',
          text: 'Plugins can add online sources here. Turn one on in Settings → Plugins, or write your own (see docs/PLUGINS.md).',
          action: canAdmin() ? button('Manage plugins', { href: '#/settings/plugins', variant: 'primary', autofocus: true }) : null,
        }),
      );
      return;
    }
    el.append(h('div', { class: 'addon-grid' }, sources.map(sourceTile)));
    return;
  }

  const path = query.path || '';
  const q = query.q || '';
  const data = await api.get(`/api/sources/${params.plugin}/${params.source}/browse${qs({ path, q })}`);
  setTitle(data.title);
  const gridEl = h('div', { class: 'grid grid-poster', role: 'list' });
  const addItems = (items) => {
    for (const entry of items) {
      const c = entryCard(params, entry);
      c.setAttribute('role', 'listitem');
      gridEl.append(c);
    }
  };
  addItems(data.items);

  const searchInput = h('input', { type: 'search', placeholder: `Search ${data.source.name}`, value: q, 'aria-label': `Search ${data.source.name}` });
  const searchForm = h('form', { class: 'toolbar', role: 'search' }, searchInput, button('Search', { icon: 'search', type: 'submit' }));
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = searchInput.value.trim();
    navigate(`#/addons/${params.plugin}/${params.source}${qs({ q: value })}`);
  });

  let next = data.next;
  const more = h('div', { class: 'load-more' });
  function renderMore() {
    clear(more);
    if (!next) return;
    more.append(
      button('Load more', {
        icon: 'chevronDown',
        onClick: async () => {
          clear(more).append(spinner());
          const page = await api.get(`/api/sources/${params.plugin}/${params.source}/browse${qs({ path: next, q })}`);
          addItems(page.items);
          next = page.next;
          renderMore();
        },
      }),
    );
  }
  renderMore();

  el.append(
    h(
      'header',
      { class: 'page-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, h('a', { href: '#/addons' }, 'Add-ons'), path || q ? [' · ', h('a', { href: `#/addons/${params.plugin}/${params.source}` }, data.source.name)] : null), h('h1', {}, data.title)),
      data.source.searchable ? searchForm : null,
    ),
    data.items.length ? gridEl : emptyState({ title: 'Nothing here', text: q ? 'No results — try other words.' : 'This folder is empty.' }),
    more,
  );
}
