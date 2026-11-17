// The title page: a movie, a show (seasons and episodes), an episode, an album or an artist. v0.30: a Preact screen
// (the same elements as before, built from ui/detail.js and ui/cards.js). Books, comics, series, podcasts and
// audiobooks keep their own older pages (book.js, podcast.js, audiobook.js), handed the data load() already fetched.
import { api, qs } from '../api.js';
import { html, useLayoutEffect } from '../ui.js';
import { Button, MoreButton } from '../ui/basics.js';
import { Art, LandscapeCard, PosterCard, Row } from '../ui/cards.js';
import { MediaChips, DetailMeta, TitleArt, Genres, WatchlistButton, DownloadButton, RatingControl } from '../ui/detail.js';
import { openCastPicker } from '../cast.js';
import { h, icon, clear, episodeLabel, formatRuntime, formatBytes, formatClock } from '../dom.js';
import { toast, openDialog, spinner, endsAt, timeLeft, field, TOASTS, art, metaLine, button, landscapeCard, grid, mediaChips, moreButton, row, episodeCaption, cardState } from '../components.js';
import { addToPlaylistItems, watchlistButton } from '../lists.js';
import { openRating, canRate, ratingControl } from '../rating.js';
import { sizedAttrs } from '../sized.js';
import { music, trackList } from '../music.js';
import { parseClock } from '../markers.js';
import { setTitle, navigate, refreshView, canAdmin, isKidsProfile, isOrbit } from '../app.js';
import { setBackdrop, followFocus } from '../backdrop.js';
import { openEditDetails } from './edit-details.js';
import { downloadButton, downloadSheetItem } from '../offline/ui.js';
import { resumeInfo, selectedSeasonId, rowStartEpisode, introText, isWatched } from '../item-rules.js';

/** An older page (book, podcast, audiobook) drawn into a detached element; the screen puts its nodes on the page. */
async function older(load, params, query, data) {
  const mod = await load();
  const box = document.createElement('div');
  await mod.render(box, params, query, data);
  return { older: [...box.childNodes] };
}

export async function load(params, query) {
  const data = await api.get(`/api/items/${params.id}`);
  const item = data.item;
  const go = (to) => (navigate(to, { replace: true }), { redirect: true });
  if (item.kind === 'season') return go(`#/item/${item.showId}?season=${item.id}`);
  if (item.kind === 'track' && data.album) return go(`#/item/${data.album.id}?track=${item.id}`);
  // Spoken titles (v0.22): an episode opens on its podcast's page, a book's part on its book.
  if (['book', 'comic', 'series'].includes(item.kind)) return older(() => import('./book.js'), params, query, data); // v0.22 Plan D
  if (item.kind === 'podcast') return older(() => import('./podcast.js'), params, query, data);
  if (item.kind === 'podcast_episode' && item.showId) return go(`#/item/${item.showId}?episode=${item.id}`);
  if (item.kind === 'audiobook') return older(() => import('./audiobook.js'), params, query, data);
  if (item.kind === 'chapter' && item.parentId) return go(`#/item/${item.parentId}`);
  // Not moved yet: the older render, handed the data (shows: Plan step 6; albums and artists: step 7).
  if (['show', 'album', 'artist'].includes(item.kind)) return older(async () => ({ render: renderOlder }), params, query, data);
  const show = data.show;
  setTitle(item.kind === 'episode' ? `${show?.title} ${episodeLabel(item)}` : item.title);
  setBackdrop(item.backdrop || show?.backdrop || item.poster || show?.poster);
  return { page: data };
}

export function Screen({ params, query, data, view }) {
  useLayoutEffect(() => {
    if (!data.older) return undefined;
    view.append(...data.older);
    return () => data.older.forEach((n) => n.remove());
  }, []);
  if (!data.page) return null;
  return html`<${TitlePage} data=${data.page} query=${query} />`;
}

async function setWatched(item, watched) {
  await api.post(`/api/items/${item.id}/watched`, { watched });
  toast(watched ? 'Marked as watched' : 'Marked as unwatched');
  refreshView();
}

async function refreshInfo(item) {
  TOASTS.refreshStarted();
  await api.post(`/api/items/${item.id}/refresh`, {});
  refreshView();
}

/** The less-used actions behind "…": playlists, casting, Refresh info, Fix match, Download, Edit intro. */
function moreItems(item, markers, extra = {}) {
  const items = [];
  // Playlists first: they are for everyone, not just admins.
  if (item.kind === 'movie' || item.kind === 'episode') items.push(addToPlaylistItems({ itemId: item.id }));
  else if (item.kind === 'show') items.push(addToPlaylistItems({ get seasonId() { return extra.seasonId?.(); } }, { label: 'Add season to playlist…' }));
  else if (item.kind === 'album' || item.kind === 'artist') items.push(addToPlaylistItems({ itemIds: (extra.tracks || []).map((t) => t.id) }, { kind: 'music' }));
  // Stars and hearts: Orbit shows them on the page; the older layouts keep them here (their pages stay as they were).
  if (!isOrbit() && canRate(item)) items.push({ label: 'Rate…', icon: 'star', onSelect: () => openRating(item) });
  // Casting: Atomix plays it on a TV and this screen is the remote.
  if (item.kind === 'movie' || item.kind === 'episode') items.push({ label: 'Cast to…', icon: 'cast', onSelect: () => openCastPicker({ itemId: item.id }) });
  else if ((item.kind === 'album' || item.kind === 'artist') && extra.tracks?.length) items.push({ label: 'Cast to…', icon: 'cast', onSelect: () => openCastPicker({ queue: { itemIds: extra.tracks.map((t) => t.id), index: 0 } }) });
  if (canAdmin() && !item.remote) {
    items.push({ label: 'Refresh info', icon: 'refresh', onSelect: () => refreshInfo(item) });
    if (item.kind === 'movie' || item.kind === 'show') items.push({ label: 'Fix match', icon: 'edit', onSelect: () => identifyDialog(item) });
    // v0.20: in "…" in every theme (the classic layouts' row of admin buttons stays as it was).
    if (['movie', 'show', 'episode', 'album', 'artist'].includes(item.kind)) items.push({ label: 'Edit details', icon: 'edit', onSelect: () => openEditDetails(item) });
  }
  // v0.21: Download into the app (Orbit has the button on the page; the older themes find it here), a show's season,
  // an album's or artist's songs. Saving the file itself keeps its own entry.
  if (!item.remote) {
    if ((item.kind === 'movie' || item.kind === 'episode') && !isOrbit()) items.push(downloadSheetItem(item));
    if (item.kind === 'show') items.push(downloadSheetItem(item, { label: 'Download season', ids: () => [extra.seasonId?.()].filter(Boolean) }));
    if (item.kind === 'album') items.push(downloadSheetItem(item, { label: 'Download album' }));
    if (item.kind === 'artist') items.push(downloadSheetItem(item, { label: 'Download all songs' }));
  }
  if ((item.kind === 'movie' || item.kind === 'episode') && !isKidsProfile() && !item.remote) items.push({ label: 'Save the file', icon: 'download', href: `/api/items/${item.id}/download`, download: true });
  if (item.kind === 'episode' && markers !== undefined) items.push({ label: 'Edit intro', icon: 'edit', onSelect: () => introDialog(item, markers?.intro) });
  return items.filter(Boolean);
}

/** The classic layouts' admin buttons beside "…" (Orbit keeps them in "…"). */
function AdminButtons({ item }) {
  if (!canAdmin() || item.remote) return null; // a connected server's title: its details live there
  return [
    html`<${Button} label="Refresh info" icon="refresh" variant="ghost" onClick=${(e) => ((e.currentTarget.disabled = true), refreshInfo(item))} />`,
    item.kind === 'movie' || item.kind === 'show' ? html`<${Button} label="Fix match" icon="edit" variant="ghost" onClick=${() => identifyDialog(item)} />` : null,
  ];
}

/**
 * One action set for every theme: Orbit folds it all into "…"; the classic layouts show the admin buttons and the
 * download inline and keep the rest (playlists, casting, Edit intro) in "…".
 */
function MoreActions({ item, more, download = true }) {
  if (isOrbit()) return more.length ? html`<${MoreButton} title=${item.title} items=${more} />` : null;
  const inline = new Set(['Refresh info', 'Fix match', 'Save the file']);
  const rest = more.filter((m) => !inline.has(m.label));
  return [
    rest.length ? html`<${MoreButton} title=${item.title} items=${rest} />` : null,
    download && !isKidsProfile() && !item.remote ? html`<${Button} label="" icon="download" variant="ghost" href=${`/api/items/${item.id}/download`} title="Download file" attrs=${{ download: '' }} />` : null,
    html`<${AdminButtons} item=${item} />`,
  ];
}

/** Play or Resume (and From the start) for a film, an episode, or a show's next episode. */
function PlayButtons({ target, label }) {
  const r = resumeInfo(target);
  return [
    html`<${Button} label=${label(r)} icon="play" variant="primary" href=${`#/play/${target.id}`} autofocus=${true} />`,
    r ? html`<${Button} label="From the start" icon="replay" variant="ghost" href=${`#/play/${target.id}?t=0`} />` : null,
  ];
}

function WatchedButton({ item }) {
  const watched = isWatched(item);
  return html`<${Button} label=${watched ? 'Watched' : 'Mark watched'} icon="check" variant=${watched ? 'secondary active' : 'ghost'} onClick=${() => setWatched(item, !watched)} attrs=${{ 'aria-pressed': String(watched) }} />`;
}

/** Admins: where this episode's intro is, and (older themes) a way to fix it. Orbit keeps Edit intro in "…". */
function IntroLine({ item, markers, edit }) {
  return html`<p class="intro-line muted"><span>${introText(markers)}</span>${edit ? html`<${Button} label="Edit" icon="edit" variant="ghost" onClick=${() => introDialog(item, markers?.intro)} />` : null}</p>`;
}

function MediaDetails({ item, subtitles, rise }) {
  const m = item.media;
  const rows = [];
  if (item.fileName) rows.push(['File', `${item.fileName}${item.size ? ` · ${formatBytes(item.size)}` : ''}`]);
  if (item.remote && item.serverName) rows.push(['From', item.serverName]);
  if (m?.videoCodec) rows.push(['Video', `${m.videoCodec.toUpperCase()} ${m.width}×${m.height}${m.bitDepth > 8 ? ` · ${m.bitDepth}-bit` : ''}${m.hdr ? ' · HDR' : ''}`]);
  if (m?.audio?.length) rows.push(['Audio', m.audio.map((a) => [a.language?.toUpperCase(), a.codec?.toUpperCase(), a.channels ? `${a.channels}ch` : null, a.title].filter(Boolean).join(' ')).join(' / ')]);
  if (subtitles?.length) rows.push(['Subtitles', subtitles.map((s) => s.label).join(' / ')]);
  if (item.originalTitle) rows.push(['Original title', item.originalTitle]);
  if (!rows.length) return null;
  return html`<section class="detail-section details-panel" data-rise=${rise}><h2>Details</h2><dl class="details-list">${rows.map(([k, v]) => [html`<dt>${k}</dt>`, html`<dd>${v}</dd>`])}</dl></section>`;
}

/** The current movie in its collection's row: a "This movie" badge, and not a link to the page you're on. */
const collectionCard = (item) => (item.isCurrent ? html`<${PosterCard} item=${item} current=${true} />` : undefined);

/** The rows under the details: Extras, Part of <collection>, More like this. `rise`: the first block's data-rise. */
function TitleRows({ data, item, backdrop, rise }) {
  const blocks = [];
  if (data.extras?.length) blocks.push((r) => html`<${Row} id="extras" title="Extras" items=${data.extras.map((e) => ({ ...e, href: `#/play/${e.id}?from=${item.id}`, ownerBackdrop: backdrop }))} style="landscape" rise=${r} />`);
  const c = data.collection;
  if (c) blocks.push((r) => html`<${Row} id="collection" title=${`Part of ${c.name}`} subtitle=${`${c.owned} of ${c.total} in your library`} items=${c.items} style="poster" href=${`#/collections/${c.id}`} card=${collectionCard} rise=${r} />`);
  if (data.similar?.length) blocks.push((r) => html`<${Row} id="similar" title="More like this" items=${data.similar} style="poster" rise=${r} />`);
  return blocks.map((b, i) => b(i === 0 ? rise : null));
}

/** A movie or an episode. */
function TitlePage({ data }) {
  const { item, show } = data;
  const orbit = isOrbit();
  const backdrop = item.backdrop || show?.backdrop;
  const r = resumeInfo(item);
  const episode = item.kind === 'episode';
  const t = data.trailer;
  const actions = [
    html`<${PlayButtons} target=${item} label=${(res) => (res ? `Resume from ${formatClock(res.position)}` : 'Play')} />`,
    t ? html`<${Button} label="Trailer" icon="film" variant="ghost" href=${t.kind === 'local' ? `#/play/${t.itemId}?from=${item.id}` : `#/trailer/${item.id}`} />` : null,
    item.kind === 'movie' ? html`<${WatchlistButton} item=${item} initialIn=${data.inWatchlist} />` : null,
    html`<${WatchedButton} item=${item} />`,
    orbit && !item.remote ? html`<${DownloadButton} item=${item} />` : null,
    html`<${MoreActions} item=${item} more=${moreItems(item, data.markers)} />`,
  ];
  // The body's first block rises in after the page's first-screen blocks (data-rise: their order).
  const next = episode && data.nextEpisode;
  const details = MediaDetails({ item, subtitles: data.subtitles, rise: next ? null : '3' });
  return [
    html`<header class="detail-header" data-art=${backdrop ? 'backdrop' : 'poster'}>
      <div class="detail-inner">
        <div class=${`detail-poster ${episode ? 'is-landscape' : ''}`}><${Art} key=${item.poster || show?.poster || ''} src=${item.poster || show?.poster} title=${item.title} kind=${episode ? 'landscape' : 'poster'} eager=${true} /></div>
        <div class="detail-info">
          ${episode ? html`<p class="eyebrow"><a href=${`#/item/${show.id}`}>${show.title}</a>${` · ${episodeLabel(item)}`}</p>` : null}
          <${TitleArt} logo=${episode ? null : item.logo} title=${item.title} />
          <${DetailMeta} item=${item} ends=${endsAt(timeLeft(item))} rise="0" />
          <${MediaChips} item=${item} />
          <${Genres} genres=${item.genres} />
          ${item.tagline ? html`<p class="tagline">${item.tagline}</p>` : null}
          ${item.overview ? html`<p class="overview" data-rise="1">${item.overview}</p>` : html`<p class="overview muted" data-rise="1">No description yet.</p>`}
          ${r?.left ? html`<p class="muted small">${`${formatRuntime(r.left / 60)} left`}</p>` : null}
          <div class="actions" data-rise="2">${actions}</div>
          ${orbit && canRate(item) ? html`<${RatingControl} item=${item} />` : null}
          ${data.markers !== undefined ? html`<${IntroLine} item=${item} markers=${data.markers} edit=${!orbit} />` : null}
        </div>
      </div>
    </header>`,
    html`<div class="detail-body">
      ${next ? html`<section class="detail-section" data-rise="3"><h2>Next episode</h2><div class="next-card"><${LandscapeCard} item=${{ ...data.nextEpisode, showTitle: show.title }} /></div></section>` : null}
      ${details}
      <${TitleRows} data=${data} item=${item} backdrop=${backdrop} rise=${next || details ? null : '3'} />
    </div>`,
  ];
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
        toast('Pick one of the results first');
        return false;
      }
      await api.post(`/api/items/${item.id}/identify`, { tmdbId: chosen });
      toast('Updated');
      refreshView();
      return true;
    },
  });
}

async function introDialog(item, current) {
  const has = current && !current.none;
  const start = h('input', { value: has ? formatClock(current.start, { tenths: true }) : '', placeholder: '0:42', inputmode: 'decimal', autocomplete: 'off', 'data-autofocus': true });
  const end = h('input', { value: has ? formatClock(current.end, { tenths: true }) : '', placeholder: '1:32', inputmode: 'decimal', autocomplete: 'off' });
  const all = h('input', { type: 'checkbox' });
  const shown = { start: start.value, end: end.value }; // what the editor opened with
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
        // Nothing changed: an automatic intro stays automatic (a save would make it "set by hand").
        if (has && start.value === shown.start && end.value === shown.end && !applyToSeason) return true;
        const s = parseClock(start.value);
        const e = parseClock(end.value);
        if (s == null || e == null) {
          toast('Enter times like 0:42 and 1:32');
          return false;
        }
        await api.put(`/api/items/${item.id}/markers/intro`, { start: s, end: e, applyToSeason });
        toast('Intro saved', { type: 'success' });
      } else if (value === 'none') {
        await api.put(`/api/items/${item.id}/markers/intro`, { none: true, applyToSeason });
        toast('Saved: no intro', { type: 'success' });
      } else if (value === 'detect') {
        await api.post(`/api/items/${item.id}/markers/detect`, {});
        toast('Looking for the intro again — this can take a minute');
      } else if (value === 'auto') {
        await api.del(`/api/items/${item.id}/markers/intro`);
        toast('Using the automatic intro times');
      }
      refreshView();
      return true;
    },
  });
}


// ---- Not moved yet: the older DOM code for shows, albums and artists (removed in Plan steps 6 and 7) ----

/**
 * The title as its clear logo when there is one (v0.29 B4: in a fixed-height logo box, so nothing moves when it
 * arrives). The typed title shows in the box until the logo has loaded, and stays if it fails; it stays for screen
 * readers either way.
 */
function titleArt(logoUrl, text) {
  const heading = h('h1', { class: 'detail-title' }, text);
  if (!logoUrl) return heading;
  const img = h('img', { class: 'detail-logo', hidden: true, src: sizedAttrs(logoUrl, 'logo', { orbit: document.body?.dataset.layout === 'orbit', width: Math.min(600, window.innerWidth * 0.8) * (window.devicePixelRatio || 1) }).src, alt: '', decoding: 'async' });
  const box = h('div', { class: 'logo-box' }, img, heading);
  img.addEventListener('load', () => {
    img.hidden = false;
    heading.classList.add('visually-hidden');
    box.classList.add('has-logo');
  });
  img.addEventListener('error', () => img.remove());
  return box;
}

function watchedButton(item) {
  const watched = isWatched(item);
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
        TOASTS.refreshStarted();
        await api.post(`/api/items/${item.id}/refresh`, {});
        refreshView();
      },
    }),
  ];
  if (item.kind === 'movie' || item.kind === 'show') actions.push(button('Fix match', { icon: 'edit', variant: 'ghost', onClick: () => identifyDialog(item) }));
  return actions;
}

function headerMore(item, more) {
  if (isOrbit()) return more.length ? [moreButton(item.title, more)] : [];
  const inline = new Set(['Refresh info', 'Fix match']);
  const rest = more.filter((m) => !inline.has(m.label));
  return [...(rest.length ? [moreButton(item.title, rest)] : []), ...(adminMenu(item) || [])];
}

/** Admins: where this episode's intro is, and (older themes) a way to fix it. Orbit keeps Edit intro in "…". */
function introLine(item, markers, { edit = true } = {}) {
  const m = markers?.intro;
  return h('p', { class: 'intro-line muted' }, h('span', {}, introText(markers)), edit ? button('Edit', { icon: 'edit', variant: 'ghost', onClick: () => introDialog(item, m) }) : null);
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
          { class: 'episode-thumb', href: `#/play/${ep.id}`, 'aria-label': `Play episode ${ep.episode}: ${ep.title}${cardState(ep)}` },
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
  const first = rowStartEpisode(episodes);
  let firstCard = null;
  for (const ep of episodes) {
    const r = resumeInfo(ep);
    const length = episodeCaption(ep);
    const card = h(
      'a',
      { class: `card episode-card${ep.progress?.watched ? ' is-watched' : ''}`, href: `#/play/${ep.id}`, 'aria-label': `Play episode ${ep.episode}: ${ep.title}${cardState(ep)}` },
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
          isOrbit() && canRate(item) ? ratingControl(item) : null,
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
  actions.push(...headerMore(item, moreItems(item, undefined, { tracks })));
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
  actions.push(...headerMore(item, moreItems(item, undefined, { tracks })));
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

/** The older render, for shows, albums and artists until they move (Plan steps 6 and 7). */
async function renderOlder(el, params, query, data) {
  const item = data.item;
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
    if (nr) actions.push(button('From the start', { icon: 'replay', variant: 'ghost', href: `#/play/${n.id}?t=0` }));
  }
  if (data.trailer) {
    const t = data.trailer;
    actions.push(button('Trailer', { icon: 'film', variant: 'ghost', href: t.kind === 'local' ? `#/play/${t.itemId}?from=${item.id}` : `#/trailer/${item.id}` }));
  }
  if (item.kind === 'movie' || item.kind === 'show') actions.push(watchlistButton(item, data.inWatchlist));
  actions.push(watchedButton(item));
  if (isOrbit() && (item.kind === 'movie' || item.kind === 'episode') && !item.remote) actions.push(downloadButton(item));
  const currentSeason = () => Number(document.querySelector('.season-tab[aria-selected="true"]')?.dataset.id) || null;
  // One action set for every theme: Orbit folds it all into "…"; the classic layouts show the admin buttons and the
  // download inline and keep the rest (playlists, casting, Edit intro) in "…".
  const more = moreItems(item, data.markers, { seasonId: currentSeason });
  if (isOrbit()) {
    if (more.length) actions.push(moreButton(item.title, more));
  } else {
    const inline = new Set(['Refresh info', 'Fix match', 'Save the file']);
    const rest = more.filter((m) => !inline.has(m.label));
    if (rest.length) actions.push(moreButton(item.title, rest));
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
  const chips = mediaChips(item);
  // The first-screen blocks that rise in, in turn, after a card opens the page (data-rise: their order).
  meta.dataset.rise = '0';
  const overview = item.overview ? h('p', { class: 'overview', dataset: { rise: '1' } }, item.overview) : h('p', { class: 'overview muted', dataset: { rise: '1' } }, 'No description yet.');

  el.append(
    h(
      'header',
      // data-art: what a card opening this page travels into (transitions.js): the backdrop, else the poster.
      { class: 'detail-header', dataset: { art: backdrop ? 'backdrop' : 'poster' } },
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
          chips,
          item.genres?.length ? h('ul', { class: 'genres', role: 'list' }, item.genres.map((g) => h('li', { class: 'chip' }, g))) : null,
          item.tagline ? h('p', { class: 'tagline' }, item.tagline) : null,
          overview,
          r?.left ? h('p', { class: 'muted small' }, `${formatRuntime(r.left / 60)} left`) : null,
          h('div', { class: 'actions', dataset: { rise: '2' } }, actions),
          isOrbit() && canRate(item) ? ratingControl(item) : null,
          data.markers !== undefined ? introLine(item, data.markers, { edit: !isOrbit() }) : null,
        ),
      ),
    ),
  );

  const body = h('div', { class: 'detail-body' });
  el.append(body);

  if (item.kind === 'show') {
    const seasons = data.seasons || [];
    const selectedId = selectedSeasonId(seasons, { query, nextEpisode: data.nextEpisode });
    const tabs = h('div', { class: 'season-tabs', role: 'tablist', 'aria-label': 'Seasons' });
    const panel = h('div', { class: 'season-panel', role: 'tabpanel', id: `season-panel-${item.id}` });
    // A tab pattern: one tab stop (the selected season), Left/Right between seasons, the panel named by its tab.
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const all = [...tabs.children];
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      const next = all[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      next.focus();
      next.click();
    });
    async function selectSeason(season) {
      for (const t of tabs.children) {
        const on = Number(t.dataset.id) === season.id;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        if (on) panel.setAttribute('aria-labelledby', t.id);
      }
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
          { type: 'button', role: 'tab', class: 'season-tab', id: `season-tab-${s.id}`, 'aria-controls': panel.id, tabindex: '-1', dataset: { id: s.id }, 'aria-selected': 'false', title: `${s.childCount || 0} episodes${done ? ', all watched' : ''}`, onClick: () => selectSeason(s) },
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
    // The movie you're on: a "This movie" badge, and not a link to the page you're already on.
    const at = data.collection.items.findIndex((i) => i.isCurrent);
    const link = at >= 0 ? part.querySelector('.row-scroller').children[at] : null;
    if (link) {
      // Not a stop for the remote (OK would do nothing on it): marked current for a screen reader instead.
      const card = h('div', { class: `${link.className} is-current`, tabindex: '-1', 'aria-current': 'true', 'aria-label': `${link.getAttribute('aria-label') || ''}, this movie` }, ...link.childNodes);
      card.querySelector('.card-art')?.append(h('span', { class: 'badge badge-current' }, 'This movie'));
      link.replaceWith(card);
    }
    body.append(part);
  }
  if (data.similar?.length) body.append(row({ id: 'similar', title: 'More like this', items: data.similar, style: 'poster' }));
  body.firstElementChild?.setAttribute('data-rise', '3'); // the first row (or the episodes, or the details)
}
