// Orbit's shell: the Atomix mark, the floating glass menu (a dock on phones), and the clock and
// profile picture in the screen's top-right corner. app.js calls renderOrbitNav() from renderNav()
// when the theme's layout is "orbit"; nav.js drives the menu with the remote.
import { h, icon, clear, logoMark } from './dom.js';
import { avatar, openDialog } from './components.js';
import { orbitLibraryIcon } from './orbit-rules.js';

export const libraryIcon = (type) => ({ tv: 'tv', music: 'music', podcasts: 'mic', audiobooks: 'book', books: 'book', comics: 'book' })[type] || 'film';

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
    // The glass menu: a list that scrolls, and Search and Settings pinned at the bottom (v0.24). Entries marked
    // orbit-dock are the phone's dock (Home, Search, the first three libraries); the rest are in its More panel.
    h(
      'div',
      { class: 'orbit-menu' },
      h(
        'ul',
        { class: 'orbit-list', role: 'list' },
        entry('home', '#/', 'Home', 'home', 'orbit-dock'),
        o.libraries.map((l, i) => entry(`lib-${l.id}`, `#/library/${l.id}`, l.name, orbitLibraryIcon(l), i < 3 ? 'orbit-dock' : null)),
        entry('lists', '#/lists', 'Lists', 'list'),
        o.live ? entry('live', '#/live', 'Live TV', 'mast') : null,
        o.downloads ? entry('downloads', '#/downloads', 'Downloads', 'download') : null,
        o.addons ? entry('addons', '#/addons', 'Add-ons', 'addons') : null,
      ),
      h(
        'ul',
        { class: 'orbit-pinned', role: 'list' },
        h('li', { class: 'orbit-divider', 'aria-hidden': 'true' }),
        entry('search', '#/search', 'Search', 'search', 'orbit-dock'),
        entry('settings', '#/settings', o.settingsLabel, 'settings'),
        h(
          'li',
          { class: 'orbit-more orbit-dock' },
          h('button', { type: 'button', class: 'nav-link orbit-more-btn', 'aria-haspopup': 'dialog', 'aria-label': 'More', onClick: () => openMore(moreEntries(o)) }, icon('more', { size: 26 }), h('span', { class: 'nav-label' }, 'More')),
        ),
      ),
    ),
    h(
      'div',
      { class: 'orbit-cluster' },
      // Phones: Settings sits here, beside the profile picture (Live TV and Add-ons are in the dock's More panel).
      h('a', { class: 'orbit-tool', href: '#/settings', title: o.settingsLabel, 'aria-label': o.settingsLabel }, icon('settings', { size: 22 })),
      o.clock,
      o.profile ? h('a', { class: 'orbit-profile', href: '#/profiles', title: `Watching as ${o.profile.name}. Switch profile`, 'aria-label': `Switch profile (now ${o.profile.name})` }, avatar(o.profile, 40)) : null,
    ),
  );
}

/** Everything the phone's More panel lists: every library, Lists, Live TV, Downloads, Add-ons and Settings. */
function moreEntries(o) {
  return [
    ...o.libraries.map((l) => ({ nav: `lib-${l.id}`, href: `#/library/${l.id}`, label: l.name, icon: orbitLibraryIcon(l) })),
    { nav: 'lists', href: '#/lists', label: 'Lists', icon: 'list' },
    o.live ? { nav: 'live', href: '#/live', label: 'Live TV', icon: 'mast' } : null,
    o.downloads ? { nav: 'downloads', href: '#/downloads', label: 'Downloads', icon: 'download' } : null,
    o.addons ? { nav: 'addons', href: '#/addons', label: 'Add-ons', icon: 'addons' } : null,
    { nav: 'settings', href: '#/settings', label: o.settingsLabel, icon: 'settings' },
  ].filter(Boolean);
}

/**
 * The phone dock's More panel (v0.24): a dialog listing every entry. Focus moves into it; Back or Escape closes it,
 * and so does opening one of its pages. The page you're on is marked as in the menu.
 */
export function openMore(entries) {
  const current = document.querySelector('.orbit-menu .nav-link[data-nav][aria-current="page"]')?.dataset.nav;
  return openDialog({
    title: 'More',
    actions: [],
    body: (dialog) =>
      h(
        'ul',
        { class: 'orbit-more-list', role: 'list' },
        entries.map((e) =>
          h(
            'li',
            {},
            h('a', { class: 'orbit-more-link', href: e.href, 'aria-current': e.nav === current ? 'page' : null, onClick: () => dialog.close('close') }, icon(e.icon, { size: 22 }), h('span', {}, e.label)),
          ),
        ),
      ),
  });
}
