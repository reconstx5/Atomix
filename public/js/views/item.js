// Detail page for a movie, show (with seasons & episodes) or single episode.
import { api, qs } from '../api.js';
import { openCastPicker } from '../cast.js';
import { h, icon, clear, episodeLabel, formatRuntime, formatBytes, formatClock } from '../dom.js';
import { art, metaLine, button, toast, openDialog, landscapeCard, spinner, grid, mediaFlags, endsAt, timeLeft, field, moreButton, row, episodeCaption } from '../components.js';
import { watchlistButton, addToPlaylistItems } from '../lists.js';
import { parseClock } from '../markers.js';
import { setTitle, navigate, refreshView, canAdmin, isKidsProfile, isOrbit } from '../app.js';
import { music, trackList } from '../music.js';
import { setBackdrop, followFocus } from '../backdrop.js';

/** The title as its clear logo when there is one (the text stays for screen readers and as a fallback). */
function titleArt(logoUrl, text) {
  const heading = h('h1', { class: 'detail-title' }, text);
  if (!logoUrl) return heading;
  heading.classList.add('visually-hidden');
  const img = h('img', { class: 'detail-logo', src: logoUrl, alt: '', decoding: 'async' });
  img.addEventListener('error', () => {
    img.remove();
    heading.classList.remove('visually-hidden');
  });
  return [img, heading];
}

function resumeInfo(item) {
  const p = item.progress;
  if (!p || p.watched || p.position < 30) return null;
  const dur = p.duration || item.duration;
  return { position: p.position, left: dur ? Math.max(0, dur - p.position) : null };
}

async function setWatched(item, watched) {
  await api.post(`/api/items/${item.id}/watched`, { watched });
  toast(watched ? 'Marked as watched' : 'Marked as unwatched');
  refreshView();
}

function watchedButton(item) {
  const watched = item.kind === 'show' ? item.unwatched === 0 : Boolean(item.progress?.watched);
  return button(watched ? 'Watched' : 'Mark watched', {
    icon: 'check',
    variant: watched ? 'secondary active' : 'ghost',
    onClick: () => setWatched(item, !watched),
    attrs: { 'aria-pressed': String(watched) },
  });
}

function adminMenu(item) {
  if (!canAdmin() || item.remote) return null; // a connected server's title: its details live there
  const actions = [
    button('Refresh info', {
      icon: 'refresh',
      variant: 'ghost',
      onClick: async (e) => {
        e.currentTarget.disabled = true;
        toast('Refreshing metadata…');
        await api.post(`/api/items/${item.id}/refresh`, {});
        refreshView();
      },
    }),
  ];
  if (item.kind === 'movie' || item.kind === 'show') actions.push(button('Fix match', { icon: 'edit', variant: 'ghost', onClick: () => identifyDialog(item) }));
  return actions;
}

/** Orbit's round "…" button: the less-used actions (Refresh info, Fix match, Download, Edit intro). */
function moreItems(item, markers, extra = {}) {
  const items = [];
  // Playlists first: they are for everyone, not just admins.
  if (item.kind === 'movie' || item.kind === 'episode') items.push(addToPlaylistItems({ itemId: item.id }));
  else if (item.kind === 'show') items.push(addToPlaylistItems({ get seasonId() { return extra.seasonId?.(); } }, { label: 'Add season to playlist…' }));
  else if (item.kind === 'album' || item.kind === 'artist') items.push(addToPlaylistItems({ itemIds: (extra.tracks || []).map((t) => t.id) }, { kind: 'music' }));
  // Casting: Atomix plays it on a TV and this screen is the remote.
  if (item.kind === 'movie' || item.kind === 'episode') items.push({ label: 'Cast to…', icon: 'cast', onSelect: () => openCastPicker({ itemId: item.id }) });
  else if ((item.kind === 'album' || item.kind === 'artist') && extra.tracks?.length) items.push({ label: 'Cast to…', icon: 'cast', onSelect: () => openCastPicker({ queue: { itemIds: extra.tracks.map((t) => t.id), index: 0 } }) });
  if (canAdmin() && !item.remote) {
    items.push({
      label: 'Refresh info',
      icon: 'refresh',
      onSelect: async () => {
        toast('Refreshing metadata…');
        await api.post(`/api/items/${item.id}/refresh`, {});
        refreshView();
      },
    });
    if (item.kind === 'movie' || item.kind === 'show') items.push({ label: 'Fix match', icon: 'edit', onSelect: () => identifyDialog(item) });
  }
  if ((item.kind === 'movie' || item.kind === 'episode') && !isKidsProfile() && !item.remote) items.push({ label: 'Download', icon: 'download', href: `/api/items/${item.id}/download`, download: true });
  if (item.kind === 'episode' && markers !== undefined) items.push({ label: 'Edit intro', icon: 'edit', onSelect: () => introDialog(item, markers?.intro) });
  return items;
}

async function identifyDialog(item) {
  const queryInput = h('input', { type: 'search', value: item.title, 'aria-label': 'Title to search for' });
  const yearInput = h('input', { type: 'number', value: item.year || '', min: 1880, max: 2100, placeholder: 'Year', 'aria-label': 'Year', class: 'input-year' });
  const results = h('ul', { class: 'identify-results', role: 'list' });
  let chosen = null;

  async function search() {
    clear(results).append(spinner());
    try {
      const list = await api.get(`/api/items/${item.id}/identify${qs({ query: queryInput.value.trim(), year: yearInput.value })}`);
      clear(results);
      if (!list.length) results.append(h('li', { class: 'muted' }, 'No matches. Try a shorter title or remove the year.'));
      for (const r of list.slice(0, 12)) {
        const btn = h(
          'button',
          {
            type: 'button',
            class: 'identify-option',
            onClick: () => {
              chosen = r.tmdbId;
              for (const b of results.querySelectorAll('.identify-option')) b.setAttribute('aria-pressed', String(b === btn));
            },
            'aria-pressed': 'false',
          },
          r.poster ? h('img', { src: r.poster, alt: '', width: 46, height: 69, loading: 'lazy' }) : h('span', { class: 'identify-noimg' }),
          h('span', {}, h('strong', {}, r.title), r.year ? ` (${r.year})` : '', h('small', {}, (r.overview || '').slice(0, 140))),
        );
        results.append(h('li', {}, btn));
      }
    } catch (err) {
      clear(results).append(h('li', { class: 'form-error' }, err.message));
    }
  }

  const searchBtn = button('Search', { icon: 'search', onClick: search });
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search();
    }
  });
  search();
  await openDialog({
    title: `Fix match for “${item.title}”`,
    wide: true,
    body: h('div', {}, h('div', { class: 'identify-search' }, queryInput, yearInput, searchBtn), results),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use this match', value: 'ok', variant: 'primary' },
    ],
    onSubmit: async () => {
      if (!chosen) {
        toast('Pick one of the results first.');
        return false;
      }
      await api.post(`/api/items/${item.id}/identify`, { tmdbId: chosen });
      toast('Updated');
      refreshView();
      return true;
    },
  });
}

const INTRO_SOURCE = { audio: 'found automatically', chapter: 'from chapters', manual: 'set by hand' };

/** Admins: where this episode's intro is, and (older themes) a way to fix it. Orbit keeps Edit intro in "…". */
function introLine(item, markers, { edit = true } = {}) {
  const m = markers?.intro;
  const text = !m ? 'Intro not found yet' : m.none ? 'No intro' : `Intro ${formatClock(m.start)}–${formatClock(m.end)} · ${INTRO_SOURCE[m.source] || ''}`;
  return h('p', { class: 'intro-line muted' }, h('span', {}, text), edit ? button('Edit', { icon: 'edit', variant: 'ghost', onClick: () => introDialog(item, m) }) : null);
}

async function introDialog(item, current) {
  const has = current && !current.none;
  const start = h('input', { value: has ? formatClock(current.start, { tenths: true }) : '', placeholder: '0:42', inputmode: 'decimal', autocomplete: 'off', 'data-autofocus': true });
  const end = h('input', { value: has ? formatClock(current.end, { tenths: true }) : '', placeholder: '1:32', inputmode: 'decimal', autocomplete: 'off' });
  const all = h('input', { type: 'checkbox' });
  const actions = [
    { label: 'Cancel', value: 'cancel' },
    { label: 'No intro', value: 'none' },
    { label: 'Find again', value: 'detect' },
  ];
  if (current?.source === 'manual') actions.push({ label: 'Use automatic', value: 'auto' });
  actions.push({ label: 'Save', value: 'save', variant: 'primary' });
  await openDialog({
    title: `Intro for ${episodeLabel(item)}`,
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Starts at', start, 'Minutes and seconds, like 0:42'), field('Ends at', end)),
      h('label', { class: 'check' }, all, h('span', {}, 'Apply to the rest of this season')),
    ),
    actions,
    onSubmit: async (value) => {
      const applyToSeason = all.checked;
      if (value === 'save') {
        const s = parseClock(start.value);
        const e = parseClock(end.value);
        if (s == null || e == null) {
          toast('Enter times like 0:42 and 1:32.');
          return false;
        }
        await api.put(`/api/items/${item.id}/markers/intro`, { start: s, end: e, applyToSeason });
        toast('Intro saved', { type: 'success' });
      } else if (value === 'none') {
        await api.put(`/api/items/${item.id}/markers/intro`, { none: true, applyToSeason });
        toast('Saved: no intro', { type: 'success' });
      } else if (value === 'detect') {
        await api.post(`/api/items/${item.id}/markers/detect`, {});
        toast('Looking for the intro again. This can take a minute.');
      } else if (value === 'auto') {
        await api.del(`/api/items/${item.id}/markers/intro`);
        toast('Using the automatic intro times.');
      }
      refreshView();
      return true;
    },
  });
}

function mediaDetails(item, subtitles) {
  const m = item.media;
  const rows = [];
  if (item.fileName) rows.push(['File', `${item.fileName}${item.size ? ` · ${formatBytes(item.size)}` : ''}`]);
  if (item.remote && item.serverName) rows.push(['From', item.serverName]);
  if (m?.videoCodec) rows.push(['Video', `${m.videoCodec.toUpperCase()} ${m.width}×${m.height}${m.bitDepth > 8 ? ` · ${m.bitDepth}-bit` : ''}${m.hdr ? ' · HDR' : ''}`]);
  if (m?.audio?.length) rows.push(['Audio', m.audio.map((a) => [a.language?.toUpperCase(), a.codec?.toUpperCase(), a.channels ? `${a.channels}ch` : null, a.title].filter(Boolean).join(' ')).join(' / ')]);
  if (subtitles?.length) rows.push(['Subtitles', subtitles.map((s) => s.label).join(' / ')]);
  if (item.originalTitle) rows.push(['Original title', item.originalTitle]);
  if (!rows.length) return null;
  return h('section', { class: 'detail-section details-panel' }, h('h2', {}, 'Details'), h('dl', { class: 'details-list' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
}

function episodeList(episodes) {
  if (!episodes.length) return h('p', { class: 'muted' }, 'No episodes found.');
  return h(
    'ol',
    { class: 'episodes', role: 'list' },
    episodes.map((ep) => {
      const r = resumeInfo(ep);
      const bits = [ep.airDate ? new Date(ep.airDate).toLocaleDateString() : null, episodeCaption(ep)].filter(Boolean);
      return h(
        'li',
        { class: `episode${ep.progress?.watched ? ' is-watched' : ''}` },
        h(
          'a',
          { class: 'episode-thumb', href: `#/play/${ep.id}`, 'aria-label': `Play episode ${ep.episode}: ${ep.title}` },
          art(ep.poster, ep.title, { kind: 'landscape' }),
          h('span', { class: 'card-play' }, icon('play', { size: 20 })),
          ep.progress?.watched ? h('span', { class: 'badge badge-watched' }, icon('check', { size: 14, label: 'Watched' })) : null,
          r && ep.duration ? h('div', { class: 'progress' }, h('span', { style: { width: `${Math.min(100, (r.position / ep.duration) * 100)}%` } })) : null,
        ),
        h(
          'div',
          { class: 'episode-info' },
          h('h3', {}, h('a', { href: `#/item/${ep.id}` }, h('span', { class: 'ep-num' }, `${ep.episode}.`), ` ${ep.title}`)),
          bits.length ? h('p', { class: 'muted small' }, bits.join(' · ')) : null,
          ep.overview ? h('p', { class: 'episode-overview' }, ep.overview) : null,
        ),
      );
    }),
  );
}

/**
 * Orbit: a season's episodes as a row of wide cards. The selected episode's story shows under the
 * row, next to an Episode details button that Down reaches. OK on a card plays that episode.
 */
function episodeRow(episodes) {
  if (!episodes.length) return h('p', { class: 'muted' }, 'No episodes found.');
  const cards = h('div', { class: 'row-scroller row-landscape episode-row' });
  const byCard = new WeakMap();
  // The episode the story below describes: the one to resume, else the first unwatched, else the first.
  const first = episodes.find((e) => resumeInfo(e)) || episodes.find((e) => !e.progress?.watched) || episodes[0];
  let firstCard = null;
  for (const ep of episodes) {
    const r = resumeInfo(ep);
    const length = episodeCaption(ep);
    const card = h(
      'a',
      { class: `card episode-card${ep.progress?.watched ? ' is-watched' : ''}`, href: `#/play/${ep.id}`, 'aria-label': `Play episode ${ep.episode}: ${ep.title}` },
      h(
        'div',
        { class: 'card-art' },
        art(ep.poster, ep.title, { kind: 'landscape' }),
        ep.progress?.watched ? h('span', { class: 'badge badge-watched' }, icon('check', { size: 14, label: 'Watched' })) : null,
        r && ep.duration ? h('div', { class: 'progress' }, h('span', { style: { width: `${Math.min(100, (r.position / ep.duration) * 100)}%` } })) : null,
      ),
      h('div', { class: 'card-meta' }, h('span', { class: 'card-title' }, `${ep.episode}. ${ep.title}`), length ? h('span', { class: 'card-sub' }, length) : null),
    );
    byCard.set(card, ep);
    if (ep === first) firstCard = card;
    cards.append(card);
  }
  // Open the row at that episode, so the story matches the card at the start and Down lands on it
  // (it may be far along a long season). Waits for the row to be on the page; gives up after a second.
  let tries = 0;
  const reveal = () => {
    if (!cards.isConnected) return void (tries++ < 60 && requestAnimationFrame(reveal));
    const pad = parseFloat(getComputedStyle(cards).paddingLeft) || 0;
    cards.scrollLeft += firstCard.getBoundingClientRect().left - cards.getBoundingClientRect().left - pad;
  };
  if (firstCard !== cards.firstElementChild) requestAnimationFrame(reveal);
  const story = h('p', { class: 'episode-story' });
  const details = button('Episode details', { icon: 'info', variant: 'ghost', href: `#/item/${first.id}` });
  const show = (ep) => {
    clear(story).append(h('strong', {}, `${ep.title}.`), ep.overview ? ` ${ep.overview}` : '');
    details.href = `#/item/${ep.id}`;
    details.setAttribute('aria-label', `Episode details: ${ep.episode}. ${ep.title}`);
  };
  show(first);
  followFocus(cards, (card) => byCard.get(card), show);
  return h('div', { class: 'episode-browser' }, cards, h('div', { class: 'episode-about' }, story, details));
}

// ---- Music: album and artist pages ----
function musicHeader(el, { item, eyebrow, backdrop, meta, actions, round = false }) {
  setBackdrop(backdrop || item.poster);
  el.append(
    h(
      'header',
      { class: 'detail-header music-header' },
      h(
        'div',
        { class: 'detail-inner' },
        h('div', { class: `detail-poster is-square${round ? ' is-round' : ''}` }, art(item.poster, item.title, { kind: 'square', eager: true })),
        h(
          'div',
          { class: 'detail-info' },
          h('p', { class: 'eyebrow' }, eyebrow),
          titleArt(item.logo, item.title),
          h('div', { class: 'meta-line' }, meta.filter(Boolean).map((m) => h('span', {}, m))),
          item.genres?.length ? h('ul', { class: 'genres', role: 'list' }, item.genres.map((g) => h('li', { class: 'chip' }, g))) : null,
          item.overview ? h('p', { class: 'overview' }, item.overview) : null,
          h('div', { class: 'actions' }, actions),
        ),
      ),
    ),
  );
}

const songCount = (n) => `${n} ${n === 1 ? 'song' : 'songs'}`;
const totalTime = (sec) => (sec ? formatRuntime(sec / 60) : null);

function playButtons(tracks, { label = 'Play', autofocus = true } = {}) {
  if (!tracks.length) return [];
  return [
    button(label, { icon: 'play', variant: 'primary', autofocus, onClick: () => music.playTracks(tracks, 0) }),
    button('Shuffle', { icon: 'shuffle', onClick: () => music.playTracks(tracks, -1, { shuffle: true }) }),
    button('', { icon: 'queue', variant: 'ghost', title: 'Add to queue', onClick: () => music.addToQueue(tracks) }),
  ];
}

function renderAlbum(el, data, query) {
  const { item, artist } = data;
  const tracks = data.tracks || [];
  setTitle(`${item.title}${artist ? ` · ${artist.title}` : ''}`);
  const focusId = Number(query.track) || null;
  const actions = playButtons(tracks, { autofocus: !focusId });
  if (isOrbit()) {
    const more = moreItems(item, undefined, { tracks });
    if (more.length) actions.push(moreButton(item.title, more));
  } else {
    const admin = adminMenu(item);
    if (admin) actions.push(...admin);
  }
  musicHeader(el, {
    item,
    backdrop: item.backdrop || artist?.backdrop,
    eyebrow: artist ? ['Album · ', h('a', { href: `#/item/${artist.id}` }, artist.title)] : 'Album',
    meta: [item.year ? String(item.year) : null, songCount(tracks.length), totalTime(item.duration)],
    actions,
  });
  el.append(
    h(
      'div',
      { class: 'detail-body' },
      h(
        'section',
        { class: 'detail-section' },
        h('h2', { class: 'visually-hidden' }, 'Songs'),
        tracks.length ? trackList(tracks, { showArtist: artist?.title || true, discs: true, focusId }) : h('p', { class: 'muted' }, 'No songs found.'),
      ),
    ),
  );
  if (focusId) requestAnimationFrame(() => el.querySelector(`.track-row[data-id="${focusId}"]`)?.scrollIntoView({ block: 'center' }));
}

function renderArtist(el, data) {
  const { item } = data;
  const albums = data.albums || [];
  const tracks = data.tracks || [];
  setTitle(item.title);
  const actions = playButtons(tracks, { label: 'Play all' });
  if (isOrbit()) {
    const more = moreItems(item, undefined, { tracks });
    if (more.length) actions.push(moreButton(item.title, more));
  } else {
    const admin = adminMenu(item);
    if (admin) actions.push(...admin);
  }
  musicHeader(el, {
    item,
    round: true,
    backdrop: item.backdrop,
    eyebrow: 'Artist',
    meta: [`${albums.length} ${albums.length === 1 ? 'album' : 'albums'}`, songCount(tracks.length), totalTime(item.duration)],
    actions,
  });
  el.append(
    h(
      'div',
      { class: 'detail-body detail-body-flush' },
      h('section', { class: 'detail-section' }, h('h2', { class: 'section-pad' }, 'Albums'), albums.length ? grid(albums, { style: 'square' }) : h('p', { class: 'muted section-pad' }, 'No albums found.')),
    ),
  );
}

export async function render(el, params, query) {
  const data = await api.get(`/api/items/${params.id}`);
  const item = data.item;
  if (item.kind === 'season') {
    navigate(`#/item/${item.showId}?season=${item.id}`, { replace: true });
    return;
  }
  if (item.kind === 'track' && data.album) {
    navigate(`#/item/${data.album.id}?track=${item.id}`, { replace: true });
    return;
  }
  if (item.kind === 'album') return renderAlbum(el, data, query);
  if (item.kind === 'artist') return renderArtist(el, data);
  const show = data.show;
  setTitle(item.kind === 'episode' ? `${show?.title} ${episodeLabel(item)}` : item.title);

  const backdrop = item.backdrop || show?.backdrop;
  setBackdrop(backdrop || item.poster || show?.poster);
  const r = resumeInfo(item);
  const actions = [];

  if (item.kind === 'movie' || item.kind === 'episode') {
    actions.push(button(r ? `Resume from ${formatClock(r.position)}` : 'Play', { icon: 'play', variant: 'primary', href: `#/play/${item.id}`, autofocus: true }));
    if (r) actions.push(button('From the start', { icon: 'replay', variant: 'ghost', href: `#/play/${item.id}?t=0` }));
  } else if (item.kind === 'show' && data.nextEpisode) {
    const n = data.nextEpisode;
    const nr = resumeInfo(n);
    actions.push(button(`${nr ? 'Resume' : 'Play'} ${episodeLabel(n)}`, { icon: 'play', variant: 'primary', href: `#/play/${n.id}`, autofocus: true }));
    if (nr && isOrbit()) actions.push(button('From the start', { icon: 'replay', variant: 'ghost', href: `#/play/${n.id}?t=0` }));
  }
  if (data.trailer) {
    const t = data.trailer;
    actions.push(button('Trailer', { icon: 'film', variant: 'ghost', href: t.kind === 'local' ? `#/play/${t.itemId}?from=${item.id}` : `#/trailer/${item.id}` }));
  }
  if (item.kind === 'movie' || item.kind === 'show') actions.push(watchlistButton(item, data.inWatchlist));
  actions.push(watchedButton(item));
  const currentSeason = () => Number(document.querySelector('.season-tab[aria-selected="true"]')?.dataset.id) || null;
  if (isOrbit()) {
    const more = moreItems(item, data.markers, { seasonId: currentSeason });
    if (more.length) actions.push(moreButton(item.title, more));
  } else {
    const playlistEntry = item.kind === 'show' ? addToPlaylistItems({ get seasonId() { return currentSeason(); } }, { label: 'Add season to playlist…' }) : addToPlaylistItems({ itemId: item.id });
    actions.push(moreButton(item.title, [playlistEntry]));
    if (item.kind !== 'show' && !isKidsProfile() && !item.remote) {
      actions.push(button('', { icon: 'download', variant: 'ghost', href: `/api/items/${item.id}/download`, title: 'Download file', attrs: { download: '' } }));
    }
    const admin = adminMenu(item);
    if (admin) actions.push(...admin);
  }

  // Episodes say which show they belong to; movies and shows don't need a label.
  const eyebrow = item.kind === 'episode' ? h('p', { class: 'eyebrow' }, h('a', { href: `#/item/${show.id}` }, show.title), ` · ${episodeLabel(item)}`) : null;
  const meta = metaLine(item);
  const ends = item.kind === 'movie' || item.kind === 'episode' ? endsAt(timeLeft(item)) : null;
  if (ends) meta.append(h('span', { class: 'ends-at' }, ends));
  const flags = mediaFlags(item);

  el.append(
    h(
      'header',
      { class: 'detail-header' },
      h(
        'div',
        { class: 'detail-inner' },
        h('div', { class: `detail-poster ${item.kind === 'episode' ? 'is-landscape' : ''}` }, art(item.poster || show?.poster, item.title, { kind: item.kind === 'episode' ? 'landscape' : 'poster', eager: true })),
        h(
          'div',
          { class: 'detail-info' },
          eyebrow,
          titleArt(item.kind === 'episode' ? null : item.logo, item.title),
          meta,
          flags.length ? h('ul', { class: 'media-flags', 'aria-label': 'Media' }, flags.map((f) => h('li', {}, f))) : null,
          item.genres?.length ? h('ul', { class: 'genres', role: 'list' }, item.genres.map((g) => h('li', { class: 'chip' }, g))) : null,
          item.tagline ? h('p', { class: 'tagline' }, item.tagline) : null,
          item.overview ? h('p', { class: 'overview' }, item.overview) : h('p', { class: 'overview muted' }, 'No description yet.'),
          r?.left ? h('p', { class: 'muted small' }, `${formatRuntime(r.left / 60)} left`) : null,
          h('div', { class: 'actions' }, actions),
          data.markers !== undefined ? introLine(item, data.markers, { edit: !isOrbit() }) : null,
        ),
      ),
    ),
  );

  const body = h('div', { class: 'detail-body' });
  el.append(body);

  if (item.kind === 'show') {
    const seasons = data.seasons || [];
    const selectedId = Number(query.season) || (data.nextEpisode ? data.nextEpisode.parentId : seasons.find((s) => s.season > 0)?.id || seasons[0]?.id);
    const tabs = h('div', { class: 'season-tabs', role: 'tablist', 'aria-label': 'Seasons' });
    const panel = h('div', { class: 'season-panel', role: 'tabpanel' });
    async function selectSeason(season) {
      for (const t of tabs.children) t.setAttribute('aria-selected', String(Number(t.dataset.id) === season.id));
      history.replaceState(null, '', `#/item/${item.id}?season=${season.id}`);
      clear(panel).append(spinner());
      const sd = await api.get(`/api/items/${season.id}`);
      clear(panel);
      if (sd.item.overview && sd.item.overview !== item.overview) panel.append(h('p', { class: 'season-overview muted' }, sd.item.overview));
      panel.append(isOrbit() ? episodeRow(sd.episodes || []) : episodeList(sd.episodes || []));
    }
    for (const s of seasons) {
      const done = s.childCount && !s.unwatched;
      tabs.append(
        h(
          'button',
          { type: 'button', role: 'tab', class: 'season-tab', dataset: { id: s.id }, 'aria-selected': 'false', title: `${s.childCount || 0} episodes${done ? ', all watched' : ''}`, onClick: () => selectSeason(s) },
          s.title,
          done ? icon('check', { size: 14, label: 'All watched' }) : null,
        ),
      );
    }
    body.append(h('section', { class: 'detail-section' }, h('h2', { class: 'visually-hidden' }, 'Episodes'), tabs, panel));
    const sel = seasons.find((s) => s.id === selectedId) || seasons[0];
    if (sel) await selectSeason(sel);
  } else {
    if (item.kind === 'episode' && data.nextEpisode) {
      body.append(h('section', { class: 'detail-section' }, h('h2', {}, 'Next episode'), h('div', { class: 'next-card' }, landscapeCard({ ...data.nextEpisode, showTitle: show.title }))));
    }
    const details = mediaDetails(item, data.subtitles);
    if (details) body.append(details);
  }
  if (data.extras?.length) {
    body.append(row({ id: 'extras', title: 'Extras', items: data.extras.map((e) => ({ ...e, href: `#/play/${e.id}?from=${item.id}`, ownerBackdrop: backdrop })), style: 'landscape' }));
  }
  if (data.collection) {
    const part = row({ id: 'collection', title: `Part of ${data.collection.name}`, subtitle: `${data.collection.owned} of ${data.collection.total} in your library`, items: data.collection.items, style: 'poster', href: `#/collections/${data.collection.id}` });
    // The film you're on: a "This film" badge, and not a link to the page you're already on.
    const at = data.collection.items.findIndex((i) => i.isCurrent);
    const link = at >= 0 ? part.querySelector('.row-scroller').children[at] : null;
    if (link) {
      const card = h('div', { class: `${link.className} is-current`, tabindex: '0', 'aria-label': `${link.getAttribute('aria-label') || ''}, this film` }, ...link.childNodes);
      card.querySelector('.card-art')?.append(h('span', { class: 'badge badge-current' }, 'This film'));
      link.replaceWith(card);
    }
    body.append(part);
  }
  if (data.similar?.length) body.append(row({ id: 'similar', title: 'More like this', items: data.similar, style: 'poster' }));
}
