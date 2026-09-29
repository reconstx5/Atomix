// Search across every library.
import { api, qs } from '../api.js';
import { h, clear, debounce, icon } from '../dom.js';
import { grid, emptyState, spinner } from '../components.js';
import { setTitle } from '../app.js';
import { trackList } from '../music.js';
import { followFocus } from '../backdrop.js';
import { cardItems } from '../components.js';

export async function render(el, _params, query) {
  setTitle('Search');
  const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Movies, shows, music…', value: query.q || '', 'aria-label': 'Search', 'data-autofocus': true, autocomplete: 'off' });
  const results = h('div', { class: 'search-results', 'aria-live': 'polite' });

  let token = 0;
  async function run() {
    const q = input.value.trim();
    history.replaceState(null, '', `#/search${qs({ q })}`);
    const my = ++token;
    if (q.length < 2) {
      clear(results).append(h('p', { class: 'muted center' }, 'Type at least two letters.'));
      return;
    }
    clear(results).append(spinner('Searching'));
    const data = await api.get(`/api/search${qs({ q })}`);
    if (my !== token) return;
    clear(results);
    const sections = [
      ['Movies', data.movies, 'poster'],
      ['Shows', data.shows, 'poster'],
      ['Episodes', data.episodes, 'landscape'],
      ['Artists', data.artists || [], 'square'],
      ['Albums', data.albums || [], 'square'],
      ['Songs', data.tracks || [], 'tracks'],
    ].filter(([, items]) => items.length);
    if (!sections.length) {
      results.append(emptyState({ title: `No results for “${q}”`, text: 'Check the spelling, or try the Add-ons section for online sources.' }));
      return;
    }
    for (const [title, items, style] of sections) {
      const body = style === 'tracks' ? h('div', { class: 'song-list' }, trackList(items, { showAlbum: true, numbers: false })) : grid(items, { style });
      results.append(h('section', { class: 'search-section' }, h('h2', {}, `${title} `, h('span', { class: 'muted' }, String(items.length))), body));
    }
  }
  input.addEventListener('input', debounce(run, 250));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });

  followFocus(results, (card) => cardItems.get(card));
  el.append(h('header', { class: 'page-head search-head' }, h('h1', { class: 'visually-hidden' }, 'Search'), h('search', { class: 'search-box' }, icon('search', { size: 22 }), input)), results);
  run();
  // Focus the box even for mouse users — that's what they came here for.
  requestAnimationFrame(() => input.focus());
}
