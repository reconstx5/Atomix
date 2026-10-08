// Home screen, Kodi "Arctic" style: a spotlight with the focused title's details
// and artwork on top, rows of cards ("widgets") underneath. On big screens the
// rows scroll under a fixed spotlight, the way a TV media centre does.
import { api } from '../api.js';
import { h } from '../dom.js';
import { spotlight, row, emptyState, button, cardItems } from '../components.js';
import { setTitle, canAdmin, isKidsProfile } from '../app.js';
import { setBackdrop, artFor, followFocus } from '../backdrop.js';

export async function render(el) {
  setTitle();
  const data = await api.get('/api/home');
  const isAdmin = canAdmin();

  if (!data.libraries.length) {
    el.append(
      emptyState({
        title: 'Your media hub is empty',
        text: isAdmin ? 'Add a folder of movies, TV shows or music and Atomix will organise it for you.' : 'An admin needs to add some media folders first.',
        action: isAdmin ? button('Add a library', { icon: 'plus', variant: 'primary', href: '#/settings/libraries', autofocus: true }) : null,
      }),
    );
    return;
  }

  const rows = h('div', { class: 'rows' });
  for (const r of data.rows) {
    rows.append(row({ id: r.id, inMenu: true, title: r.title, items: r.items, style: r.style, href: r.libraryId ? `#/library/${r.libraryId}` : r.id === 'watchlist' || r.id === 'lists' ? '#/lists' : null }));
  }
  if (!data.rows.length) {
    rows.append(
      isKidsProfile()
        ? emptyState({ title: 'Nothing to watch here yet', text: 'This Kids profile only shows titles with a suitable age rating. A grown-up can change that in Settings → Profiles.' })
        : emptyState({ title: 'Nothing here yet', text: 'Your libraries are still being scanned. This page fills in as media is found.' }),
    );
  }

  const featured = data.hero || data.rows[0]?.items[0] || null;
  el.classList.add('home-view');
  if (featured) {
    const spot = spotlight(featured, { onShow: (item) => setBackdrop(artFor(item)) });
    el.append(spot.el);
    // The spotlight (and the artwork behind it) follows whatever card has focus.
    followFocus(rows, (card) => cardItems.get(card), (item) => spot.show(item));
  } else {
    el.classList.add('no-spotlight');
  }
  el.append(h('div', { class: 'home-rows' }, rows));
  // Orbit: past the first row the top area gets smaller so two rows fit; moving back up restores it.
  // (Other themes have no styles for .is-compact.)
  const rowEls = [...rows.querySelectorAll(':scope > .row')];
  el.addEventListener('focusin', (e) => el.classList.toggle('is-compact', rowEls.indexOf(e.target.closest?.('.row')) > 0));
}
