// Settings cards for Home you can arrange (v0.22): Profile → Home screen (this profile's arrangement), and
// Server → Home screen (the household's default and its web apps).
import { api } from '../api.js';
import { h, clear } from '../dom.js';
import { button, toast, openDialog, field, confirmDialog, rowActions } from '../components.js';

const section = (title, ...children) => h('section', { class: 'panel', id: title === 'Home screen' ? 'home-screen' : null }, h('h2', {}, title), children);

/** Profile → Home screen: open the editor; reset this profile's own arrangement. */
export function homeCard() {
  const status = h('p', { class: 'muted' }, 'Choose which rows Home shows and in what order.');
  const actions = h('div', { class: 'actions' }, button('Arrange home', { icon: 'edit', href: '#/arrange-home' }));
  api
    .get('/api/home/layout')
    .then((d) => {
      if (d.source !== 'profile') return;
      status.textContent = 'This profile has its own arrangement.';
      actions.append(
        button('Reset to household', {
          icon: 'refresh',
          variant: 'ghost',
          onClick: async (e) => {
            await api.del('/api/home/layout');
            status.textContent = 'Home follows the household arrangement again.';
            e.currentTarget.remove();
            actions.querySelector('a, button')?.focus();
          },
        }),
      );
    })
    .catch(() => {});
  return section('Home screen', status, actions);
}

/** Server → Home screen: the household's arrangement and the web apps (shortcut tiles to sites with no API). */
export async function householdHomeSection() {
  const list = h('ul', { class: 'webapp-list', role: 'list' });
  async function draw(focusName) {
    const apps = await api.get('/api/admin/web-apps');
    clear(list).append(
      ...(apps.length
        ? apps.map((a) =>
            h(
              'li',
              { class: 'webapp-row' },
              h('span', { class: 'webapp-name' }, a.name, a.kids ? h('span', { class: 'muted' }, ' · for Kids') : null),
              h('span', { class: 'webapp-url muted' }, a.url),
              rowActions(a.name, [
                { label: 'Edit', icon: 'edit', onSelect: () => appDialog(a) },
                { label: 'Remove', icon: 'trash', danger: true, onSelect: async () => (await confirmDialog(`Remove ${a.name}?`, 'Its tile leaves everyone’s Home.', { confirm: 'Remove', danger: true })) && (await api.del(`/api/admin/web-apps/${a.id}`), draw()) },
              ]),
            ),
          )
        : [h('li', { class: 'muted' }, 'No web apps yet. A web app is a tile on Home that opens a site (one with no Atomix add-on) in a new tab.')]),
    );
    if (focusName) [...list.querySelectorAll('.webapp-row')].find((r) => r.textContent.startsWith(focusName))?.querySelector('button')?.focus();
  }
  async function appDialog(existing) {
    const name = h('input', { value: existing?.name || '', required: true, maxlength: 40, 'data-autofocus': true });
    const url = h('input', { value: existing?.url || '', required: true, type: 'url', placeholder: 'https://' });
    const image = h('input', { value: '', type: 'url', placeholder: existing?.image ? 'Leave empty to keep the picture' : 'Optional' });
    const kids = h('input', { type: 'checkbox', checked: Boolean(existing?.kids) });
    const out = await openDialog({
      title: existing ? `Edit ${existing.name}` : 'Add a web app',
      body: h('div', { class: 'stack' }, field('Name', name), field('Address', url), field('Picture address', image, 'A logo or picture for the tile. Without one, the tile shows the first letter.'), h('label', { class: 'check' }, kids, h('span', {}, 'For Kids (Kids profiles see this one)'))),
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: existing ? 'Save' : 'Add', value: 'ok', variant: 'primary' },
      ],
      onSubmit: async () => {
        const body = { name: name.value, url: url.value, kids: kids.checked, ...(image.value.trim() ? { imageUrl: image.value.trim() } : {}) };
        const r = existing ? await api.patch(`/api/admin/web-apps/${existing.id}`, body) : await api.post('/api/admin/web-apps', body);
        if (r.imageError) toast(r.imageError, { type: 'error' });
        return true;
      },
    });
    if (out === 'ok') draw(name.value.trim());
  }
  await draw();
  return section(
    'Home screen',
    h('p', { class: 'muted' }, 'The arrangement every profile starts with. A profile that changes its own Home keeps its changes; Reset to household brings this one back.'),
    h('div', { class: 'actions' }, button('Arrange the household’s Home', { icon: 'edit', href: '#/arrange-home?scope=household' })),
    h('h3', {}, 'Web apps'),
    list,
    h('div', { class: 'actions' }, button('Add a web app', { icon: 'plus', onClick: () => appDialog(null) })),
  );
}
