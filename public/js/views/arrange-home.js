// "Arrange home" (v0.22): the rows of Home in order, each with a handle to move it, a Show switch and (pinned rows)
// Remove. With a remote: OK on a handle picks the row up, Up/Down move it, OK drops it (saved), Back puts it back.
// Touch and mouse drag the handle. ?scope=household (admins): the household's default, which every profile follows
// until it changes its own.
import { api } from '../api.js';
import { h, icon, clear } from '../dom.js';
import { button, toast, announce, openSheet } from '../components.js';
import { setTitle, state, canAdmin, isKidsProfile } from '../app.js';

const pinKey = () => `pin-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export async function render(el, params, query) {
  const household = query.scope === 'household' && canAdmin() && !isKidsProfile();
  setTitle(household ? "Arrange the household's Home" : 'Arrange home');
  const path = household ? '/api/home/layout?scope=household' : '/api/home/layout';
  let data = await api.get(path);
  let entries = data.rows.map((r) => ({ ...r }));
  let moving = null; // { key, from } while a row is picked up with the remote

  const list = h('ol', { class: 'arrange-list', 'aria-label': 'Home rows, in order' });
  const intro = h(
    'p',
    { class: 'muted' },
    household
      ? 'Every profile starts with this arrangement and follows it until it changes its own.'
      : 'Move rows with the handle (OK, then up and down, then OK). Changes are saved as you go.',
  );
  const actions = h('div', { class: 'actions arrange-actions' });

  async function save() {
    const layout = { order: entries.map((e) => ({ key: e.key, hidden: Boolean(e.hidden) })), pins: entries.filter((e) => e.pin).map((e) => e.pin) };
    try {
      if (household) await api.put('/api/admin/home-layout', { layout });
      else await api.put('/api/home/layout', { layout });
      data = await api.get(path);
      entries = data.rows.map((r) => ({ ...r }));
      draw();
    } catch (err) {
      // Not saved: the list goes back to what is saved, so the screen and Home agree.
      entries = data.rows.map((r) => ({ ...r }));
      moving = null;
      draw();
      toast(err.message, { type: 'error' });
    }
  }

  const focusHandle = (key) => list.querySelector(`.arrange-row[data-key="${CSS.escape(key)}"] .arrange-handle`)?.focus();
  function moveBy(key, dir) {
    const i = entries.findIndex((e) => e.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= entries.length) return;
    [entries[i], entries[j]] = [entries[j], entries[i]];
    draw();
    focusHandle(key);
  }

  function rowFor(e) {
    const handle = h(
      'button',
      {
        type: 'button',
        class: 'arrange-handle',
        'aria-label': `Move ${e.title}`,
        'aria-pressed': String(moving?.key === e.key),
        onClick: () => {
          if (moving?.key === e.key) {
            moving = null;
            announce(`Dropped ${e.title}.`);
            save().then(() => focusHandle(e.key));
          } else {
            moving = { key: e.key, from: entries.map((x) => x.key) };
            announce(`Moving ${e.title}. Up and down to move, OK to drop.`);
            draw();
            focusHandle(e.key);
          }
        },
        onKeydown: (ev) => {
          if (moving?.key !== e.key) return;
          if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            ev.stopPropagation();
            moveBy(e.key, ev.key === 'ArrowUp' ? -1 : 1);
          } else if (ev.key === 'Escape' || ev.key === 'BrowserBack' || ev.key === 'GoBack' || ev.key === 'Backspace') {
            ev.preventDefault();
            ev.stopPropagation();
            const from = moving.from;
            moving = null;
            entries.sort((a, b) => from.indexOf(a.key) - from.indexOf(b.key));
            announce(`${e.title} is back where it was.`);
            draw();
            focusHandle(e.key);
          }
        },
        onPointerdown: (ev) => drag(ev, e.key),
      },
      h('span', { class: 'arrange-grip', 'aria-hidden': 'true' }, '⠿'),
      h('span', { class: 'arrange-title' }, e.title),
    );
    const show = h('input', { type: 'checkbox', role: 'switch', checked: !e.hidden, disabled: e.unavailable || null, 'aria-label': `Show ${e.title}` });
    show.addEventListener('change', () => {
      e.hidden = !show.checked;
      save().then(() => list.querySelector(`.arrange-row[data-key="${CSS.escape(e.key)}"] .arrange-show input`)?.focus());
    });
    const remove = e.pin
      ? button('Remove', {
          icon: 'trash',
          variant: 'ghost',
          attrs: { 'aria-label': `Remove ${e.title}` },
          onClick: () => {
            const i = entries.indexOf(e);
            entries.splice(i, 1);
            save().then(() => (list.querySelectorAll('.arrange-handle')[Math.min(i, entries.length - 1)] || actions.querySelector('button'))?.focus());
          },
        })
      : null;
    return h(
      'li',
      { class: `arrange-row${moving?.key === e.key ? ' is-moving' : ''}${e.hidden ? ' is-hidden' : ''}`, dataset: { key: e.key } },
      handle,
      h('label', { class: 'toggle arrange-show' }, show, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), h('span', {}, e.hidden ? 'Hide' : 'Show')),
      remove,
    );
  }

  // Touch and mouse: drag the handle over the other rows; dropped where it is let go (saved).
  function drag(ev, key) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const startY = ev.clientY;
    let dragging = false;
    const onMove = (m) => {
      if (!dragging && Math.abs(m.clientY - startY) < 8) return;
      dragging = true;
      m.preventDefault();
      const rows = [...list.querySelectorAll('.arrange-row')];
      const over = rows.findIndex((r) => {
        const b = r.getBoundingClientRect();
        return m.clientY >= b.top && m.clientY < b.bottom;
      });
      const i = entries.findIndex((x) => x.key === key);
      if (over >= 0 && over !== i) {
        const [it] = entries.splice(i, 1);
        entries.splice(over, 0, it);
        draw();
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (dragging) save().then(() => focusHandle(key));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  async function addRow() {
    const pin = (p) => {
      entries.unshift({ key: p.key, title: '…', pin: p });
      save().then(() => focusHandle(p.key));
    };
    const libs = state.libraries.filter((l) => ['movies', 'tv', 'music'].includes(l.type));
    const pickLibrary = (title, then) => openSheet(title, libs.map((l) => ({ label: l.name, icon: l.type === 'music' ? 'music' : l.type === 'tv' ? 'tv' : 'film', onSelect: () => then(l) })));
    openSheet('Add a row', [
      {
        label: 'Playlist',
        icon: 'list',
        onSelect: async () => {
          const lists = (await api.get('/api/lists')).filter((l) => l.kind !== 'watchlist');
          if (!lists.length) return toast('There are no playlists to pin yet.');
          openSheet('Pin a playlist', lists.map((l) => ({ label: l.name, icon: 'list', onSelect: () => pin({ key: pinKey(), type: 'list', listId: l.id }) })));
        },
      },
      {
        label: 'Genre',
        icon: 'grid',
        onSelect: () =>
          pickLibrary('Genre from which library?', async (l) => {
            const genres = await api.get(`/api/libraries/${l.id}/genres`);
            if (!genres.length) return toast(`${l.name} has no genres yet.`);
            openSheet(`Genres in ${l.name}`, genres.map((g) => ({ label: g, icon: 'grid', onSelect: () => pin({ key: pinKey(), type: 'genre', libraryId: l.id, genre: g }) })));
          }),
      },
      {
        label: 'Collection',
        icon: 'archive',
        onSelect: async () => {
          const cols = await api.get('/api/collections');
          if (!cols.length) return toast('There are no collections yet.');
          openSheet('Pin a collection', cols.map((c) => ({ label: c.name, icon: 'archive', onSelect: () => pin({ key: pinKey(), type: 'collection', collectionId: c.id }) })));
        },
      },
      {
        label: 'Library sort',
        icon: 'shuffle',
        onSelect: () =>
          pickLibrary('Which library?', (l) =>
            openSheet(l.name, [
              { label: 'Recently added', icon: 'sparkle', onSelect: () => pin({ key: pinKey(), type: 'library', libraryId: l.id, sort: 'added' }) },
              { label: 'Something random', icon: 'shuffle', onSelect: () => pin({ key: pinKey(), type: 'library', libraryId: l.id, sort: 'random' }) },
            ]),
          ),
      },
      household ? { label: 'Web app', icon: 'plus', href: '#/settings/server#home-screen' } : null,
    ]);
  }

  function draw() {
    clear(list).append(...entries.map(rowFor));
    clear(actions).append(
      button('Add a row', { icon: 'plus', variant: 'primary', onClick: addRow }),
      !household && data.source === 'profile'
        ? button('Reset to household', {
            icon: 'refresh',
            variant: 'ghost',
            onClick: async () => {
              await api.del('/api/home/layout');
              data = await api.get(path);
              entries = data.rows.map((r) => ({ ...r }));
              announce('Home is back to the household arrangement.');
              draw();
              focusHandle(entries[0]?.key);
            },
          })
        : null,
      button('Done', { icon: 'check', variant: 'ghost', href: household ? '#/settings/server' : '#/' }),
    );
  }

  draw();
  el.classList.add('arrange-view');
  el.append(h('section', { class: 'panel arrange-panel' }, h('h1', {}, household ? "The household's Home" : 'Arrange home'), intro, list, actions));
  list.querySelector('.arrange-handle')?.focus();
}
