// Orbit's shell: the Atomix mark, the floating glass menu (a dock on phones), and the clock and
// profile picture in the screen's top-right corner. app.js calls renderOrbitNav() from renderNav()
// when the theme's layout is "orbit"; nav.js drives the menu with the remote.
import { h, icon, clear, logoMark } from './dom.js';
import { avatar } from './components.js';

const libraryIcon = (type) => (type === 'tv' ? 'tv' : type === 'music' ? 'music' : 'film');

function entry(id, href, label, iconName, extra = null) {
  return h('li', { class: extra }, h('a', { class: 'nav-link', href, dataset: { nav: id } }, icon(iconName, { size: 26 }), h('span', { class: 'nav-label' }, label)));
}

/**
 * Fill #nav with Orbit's menu.
 * @param {HTMLElement} nav
 * @param {{ serverName: string, libraries: {id: number, name: string, type: string}[], profile: object|null,
 *           addons: boolean, settingsLabel: string, clock: HTMLElement }} o
 */
export function renderOrbitNav(nav, o) {
  clear(nav).append(
    // Home is in the menu too, so the remote skips the mark (tabindex -1); a mouse can still click it.
    h('a', { class: 'brand', href: '#/', tabindex: '-1', 'aria-label': `${o.serverName} home` }, logoMark(48), h('span', { class: 'brand-name' }, o.serverName)),
    h(
      'ul',
      { class: 'orbit-menu', role: 'list' },
      entry('home', '#/', 'Home', 'home'),
      o.libraries.map((l) => entry(`lib-${l.id}`, `#/library/${l.id}`, l.name, libraryIcon(l.type))),
      entry('lists', '#/lists', 'Lists', 'list'),
      entry('search', '#/search', 'Search', 'search'),
      o.addons ? entry('addons', '#/addons', 'Add-ons', 'addons', 'orbit-extra') : null,
      h('li', { class: 'orbit-divider orbit-extra', 'aria-hidden': 'true' }),
      entry('settings', '#/settings', o.settingsLabel, 'settings', 'orbit-extra'),
    ),
    h(
      'div',
      { class: 'orbit-cluster' },
      // Phones: Add-ons and Settings sit here, beside the profile picture, instead of in the dock.
      o.addons ? h('a', { class: 'orbit-tool', href: '#/addons', title: 'Add-ons', 'aria-label': 'Add-ons' }, icon('addons', { size: 22 })) : null,
      h('a', { class: 'orbit-tool', href: '#/settings', title: o.settingsLabel, 'aria-label': o.settingsLabel }, icon('settings', { size: 22 })),
      o.clock,
      o.profile ? h('a', { class: 'orbit-profile', href: '#/profiles', title: `Watching as ${o.profile.name}. Switch profile`, 'aria-label': `Switch profile (now ${o.profile.name})` }, avatar(o.profile, 40)) : null,
    ),
  );
}
