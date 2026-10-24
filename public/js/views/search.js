// Search across every library. Orbit (v0.24) adds recent searches, genre and library tiles before typing, and
// suggestions from the first letter. v0.26: a Preact screen.
import { html, useState, useRef, useLayoutEffect, useAppState } from '../ui.js';
import { Icon, Button, EmptyState, Spinner, Island } from '../ui/basics.js';
import { Grid } from '../ui/cards.js';
import { api, qs } from '../api.js';
import { browseTarget, cardItems } from '../components.js';
import { setTitle, canAdmin, liveAllowed, isOrbit } from '../app.js';
import { orbitLibraryIcon } from '../orbit-rules.js';
import { search as liveSearch, clockTime, playChannel, channelLabel } from '../live.js';
import { trackList } from '../music.js';
import { followFocus } from '../backdrop.js';

export async function load() {
  setTitle('Search');
  return null;
}

const SECTIONS = [
  ['Movies', 'movies', 'poster'],
  ['Shows', 'shows', 'poster'],
  ['Episodes', 'episodes', 'landscape'],
  ['Artists', 'artists', 'square'],
  ['Albums', 'albums', 'square'],
  ['Songs', 'tracks', 'tracks'],
];

/** "On TV": matching channels (play) and programmes ("7:30 PM · TVNZ 1 · The Chase", opening the programme sheet). */
function OnTv({ tv }) {
  const today = new Date().toDateString();
  return html`<section class="search-section search-section-live">
    <h2>On TV <span class="muted">${String(tv.channels.length + tv.programmes.length)}</span></h2>
    <ul class="live-search-list" role="list">
      ${tv.channels.map((c) => html`<li key=${`c${c.id}`}><button type="button" class="live-search-chan" onClick=${() => playChannel(c)}><${Icon} name=${c.radio ? 'radio' : 'live'} size=${20} /><span>${channelLabel(c)}</span></button></li>`)}
      ${tv.programmes.map((p) => {
        const when = `${new Date(p.start).toDateString() === today ? '' : 'Tomorrow '}${clockTime(p.start)}`;
        return html`<li key=${`p${p.id}`}><button type="button" class="live-search-prog" onClick=${async () => (await import('./guide.js')).openProgramme(p.id)}><${Icon} name="guide" size=${20} /><span>${`${when} · ${p.channel?.name || ''} · ${p.title}`}</span></button></li>`;
      })}
    </ul>
  </section>`;
}

function Results({ found, libraries }) {
  if (!found) return null;
  if (found.short) return found.orbit ? null : html`<p class="muted center">Type at least two letters.</p>`;
  if (found.loading) return html`<${Spinner} label="Searching" />`;
  const { q, data, tv } = found;
  const sections = SECTIONS.map(([title, key, style]) => [title, data[key] || [], style]).filter(([, items]) => items.length);
  const tvCount = tv ? tv.channels.length + tv.programmes.length : 0;
  if (!sections.length && !tvCount) {
    const browse = browseTarget(libraries, 'watchlist');
    const action = canAdmin() ? html`<${Button} label="Open Add-ons" icon="addons" variant="ghost" href="#/addons" />` : browse ? html`<${Button} label=${browse.label} icon=${browse.icon} variant="ghost" href=${browse.href} />` : null;
    return html`<${EmptyState} title=${`No results for “${q}”`} text=${canAdmin() ? 'Check the spelling, or look in Add-ons for online sources.' : 'Check the spelling.'} icon="search" action=${action} />`;
  }
  return html`${sections.map(
    ([title, items, style]) => html`<section key=${title} class="search-section">
      <h2>${`${title} `}<span class="muted">${String(items.length)}</span></h2>
      ${style === 'tracks' ? html`<${Island} class="song-list" make=${() => trackList(items, { showAlbum: true, numbers: false })} deps=${[items]} />` : html`<${Grid} items=${items} style=${style} />`}
    </section>`,
  )}${tvCount ? html`<${OnTv} tv=${tv} />` : null}`;
}

/** Orbit, before typing: recent searches (each removable), then genre and library tiles. */
function Discover({ data, hidden, libraries, onRecent, onRemove, onClear, secRef }) {
  const flag = new Map((libraries || []).map((l) => [l.id, l]));
  const { recent = [], browse = { genres: [], libraries: [] } } = data || {};
  return html`<section ref=${secRef} class="search-discover" aria-label="Browse" hidden=${hidden}>
    ${recent.length
      ? html`<div class="search-discover-head"><h2>Recent searches</h2><button type="button" class="btn btn-ghost search-clear" onClick=${onClear}>Clear</button></div>
          <ul class="search-recent" role="list">
            ${recent.map(
              (r) => html`<li key=${r.id}>
                <a class="search-recent-link" href=${`#/search${qs({ q: r.query })}`} onClick=${(e) => (e.preventDefault(), onRecent(r.query))}><${Icon} name="clock" size=${22} /><span>${r.query}</span></a>
                <button type="button" class="btn btn-ghost btn-icon search-recent-remove" aria-label=${`Remove ${r.query}`} title="Remove" onClick=${() => onRemove(r)}><${Icon} name="close" size=${20} /></button>
              </li>`,
            )}
          </ul>`
      : null}
    ${browse.genres.length ? html`<h2>Genres</h2><div class="search-tiles search-genres">${browse.genres.map((g) => html`<a key=${g.name} class="search-tile" href=${`#/genre/${encodeURIComponent(g.name)}`}><span>${g.name}</span></a>`)}</div>` : null}
    ${browse.libraries.length ? html`<h2>Libraries</h2><div class="search-tiles search-libraries">${browse.libraries.map((l) => html`<a key=${l.id} class="search-tile" href=${`#/library/${l.id}`}><${Icon} name=${orbitLibraryIcon(flag.get(l.id) || l)} size=${26} /><span>${l.name}</span></a>`)}</div>` : null}
  </section>`;
}

export function Screen({ query }) {
  const [orbit] = useState(isOrbit);
  const libraries = useAppState((s) => s.libraries);
  const [text, setText] = useState(query.q || '');
  const [found, setFound] = useState(null); // what the results show
  const [summary, setSummary] = useState(''); // one line carries the news ("18 results"); the grids aren't read out
  const [ranQ, setRanQ] = useState(text.trim()); // the search the page shows (Orbit hides the tiles once typed)
  const [discover, setDiscover] = useState(null);
  const [suggest, setSuggest] = useState([]);
  const input = useRef(null);
  const results = useRef(null);
  const discoverEl = useRef(null);
  const suggestEl = useRef(null);
  const current = useRef(text); // the box's text for handlers that outlive a render
  const token = useRef(0);
  const suggestToken = useRef(0);
  const suggestAbort = useRef(null);
  const timers = useRef({});
  const left = useRef(false);
  const focusAfter = useRef(null); // after the tiles redraw: { remove: i } (the next ✕, else the last, else Clear, else the box) | 'box'
  const suggestAt = useRef(-1); // the suggestion the remote was on before a redraw
  current.current = text;

  async function run() {
    const q = current.current.trim();
    history.replaceState(null, '', `#/search${qs({ q })}`);
    const my = ++token.current;
    setRanQ(q);
    if (orbit && !q) showDiscover();
    if (q.length < 2) {
      setFound({ short: true, orbit });
      return;
    }
    setFound({ loading: true });
    // Live TV's matches ride along (channels by name, programmes in the next 24 h), only for viewers who have it.
    const [data, tv] = await Promise.all([api.get(`/api/search${qs({ q })}`), liveAllowed() ? liveSearch(q).catch(() => null) : null]);
    if (left.current || my !== token.current) return;
    const tvCount = tv ? tv.channels.length + tv.programmes.length : 0;
    const sections = SECTIONS.map(([t, key]) => [t, data[key] || []]).filter(([, items]) => items.length);
    const count = sections.reduce((n, [, items]) => n + items.length, 0) + tvCount;
    const parts = sections.map(([t, items]) => `${items.length} ${t.toLowerCase()}`).concat(tvCount ? [`${tvCount} on TV`] : []);
    setSummary(count ? `${count} ${count === 1 ? 'result' : 'results'}: ${parts.join(', ')}` : `No results for ${q}`);
    setFound({ q, data, tv });
  }

  // ---- Remembering a search (v0.24): on Enter, or on opening a result; every theme, though only Orbit shows them ----
  const remember = () => {
    const q = current.current.trim();
    if (q) api.post('/api/search/recent', { query: q }, { keepalive: true }).catch(() => {});
  };

  // ---- Orbit: recent searches, genre and library tiles ----
  async function showDiscover() {
    const [recent, browse] = await Promise.all([api.get('/api/search/recent').catch(() => []), api.get('/api/search/browse').catch(() => ({ genres: [], libraries: [] }))]);
    if (left.current || current.current.trim()) return;
    setDiscover({ recent, browse });
  }

  // ---- Orbit: suggestions as you type ----
  async function suggestNow() {
    const q = current.current.trim();
    const my = ++suggestToken.current;
    suggestAbort.current?.abort();
    if (!q) {
      setSuggest([]);
      return;
    }
    suggestAbort.current = new AbortController();
    let list;
    try {
      list = await api.get(`/api/search/suggest${qs({ q })}`, { signal: suggestAbort.current.signal });
    } catch {
      return; // abandoned (more typing) or offline
    }
    if (left.current || my !== suggestToken.current) return; // only the latest answer counts
    // The remote may already be in the list: keep its place (the same row, or the last) after redrawing.
    suggestAt.current = [...(suggestEl.current?.querySelectorAll('a') || [])].indexOf(document.activeElement);
    setSuggest(list);
  }

  const later = (name, fn, ms) => {
    clearTimeout(timers.current[name]);
    timers.current[name] = setTimeout(fn, ms);
  };
  const onInput = (e) => {
    current.current = e.currentTarget.value;
    setText(e.currentTarget.value);
    later('run', run, 250);
    if (orbit) later('suggest', suggestNow, 150);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      remember();
      run();
    }
  };
  const pickRecent = (q) => {
    current.current = q;
    setText(q);
    remember();
    run();
    suggestNow();
    focusAfter.current = 'box';
  };
  const removeRecent = async (r) => {
    const at = discover?.recent.findIndex((x) => x.id === r.id) ?? 0;
    await api.del(`/api/search/recent/${r.id}`).catch(() => {});
    focusAfter.current = { remove: Math.max(0, at) }; // the ✕ that takes its place, else the last
    await showDiscover();
  };
  const clearRecent = async () => {
    await api.del('/api/search/recent').catch(() => {});
    focusAfter.current = 'box';
    await showDiscover();
    input.current?.focus();
  };
  // Back or Escape in the suggestions returns to the box (not to the page before).
  const onSuggestKey = (e) => {
    if (!['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    input.current.focus();
  };

  useLayoutEffect(() => {
    followFocus(results.current, (card) => cardItems.get(card));
    run();
    if (orbit && current.current.trim()) suggestNow();
    // Focus the box even for mouse users — that's what they came here for.
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => {
      left.current = true;
      cancelAnimationFrame(frame);
      for (const t of Object.values(timers.current)) clearTimeout(t);
      suggestAbort.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    const want = focusAfter.current;
    focusAfter.current = null;
    if (want?.remove != null) {
      const removes = discoverEl.current?.querySelectorAll('.search-recent-remove') || [];
      (removes[Math.min(want.remove, removes.length - 1)] || discoverEl.current?.querySelector('.search-clear') || input.current)?.focus();
    }
    else if (want === 'box') input.current?.focus();
  }, [discover, text]);
  useLayoutEffect(() => {
    const at = suggestAt.current;
    suggestAt.current = -1;
    if (at < 0) return;
    const links = suggestEl.current?.querySelectorAll('a') || [];
    if (document.activeElement === links[at]) return; // the same row kept its element
    (links[Math.min(at, links.length - 1)] || input.current)?.focus({ preventScroll: true });
  }, [suggest]);

  const suggestions = orbit
    ? html`<ul ref=${suggestEl} class="search-suggest" id="search-suggest" role="list" aria-label="Suggestions" hidden=${!suggest.length} onKeyDown=${onSuggestKey}>
        ${suggest.map((s, i) => {
          const href = s.kind === 'person' ? `#/person/${encodeURIComponent(s.title)}` : `#/item/${s.id}`;
          return html`<li key=${i}>
            <a class="search-suggest-link" href=${href} onClick=${remember}>
              ${s.poster ? html`<img key=${s.poster} class="search-suggest-art" src=${s.poster} alt="" loading="lazy" decoding="async" />` : html`<span class="search-suggest-art"><${Icon} name=${s.kind === 'person' ? 'user' : 'search'} size=${20} /></span>`}
              <span class="search-suggest-text"><span class="search-suggest-title">${s.title}</span>${s.subtitle ? html`<span class="search-suggest-sub">${s.subtitle}</span>` : null}</span>
            </a>
          </li>`;
        })}
      </ul>`
    : null;
  return html`<header class="page-head search-head">
      <h1 class="visually-hidden">Search</h1>
      <search class="search-box"><${Icon} name="search" size=${22} /><input ref=${input} type="search" class="search-input" placeholder="Movies, shows, music…" value=${text} aria-label="Search" data-autofocus="" autocomplete="off" aria-controls=${orbit ? 'search-suggest' : null} onInput=${onInput} onKeyDown=${onKeyDown} /></search>
    </header>
    ${suggestions}
    ${orbit ? html`<${Discover} secRef=${discoverEl} data=${discover} hidden=${ranQ.length > 0} libraries=${libraries} onRecent=${pickRecent} onRemove=${removeRecent} onClear=${clearRecent} />` : null}
    <p class="search-summary visually-hidden" aria-live="polite">${summary}</p>
    <div ref=${results} class="search-results" onClickCapture=${(e) => e.target.closest('a[href], button') && remember()}><${Results} found=${found} libraries=${libraries} /></div>`;
}
