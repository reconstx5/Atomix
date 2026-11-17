// The title page: a movie, a show (seasons and episodes), an episode, an album or an artist. v0.30: a Preact screen
// (the same elements as before, built from ui/detail.js and ui/cards.js). Books, comics, series, podcasts and
// audiobooks keep their own older pages (book.js, podcast.js, audiobook.js), handed the data load() already fetched.
import { api, qs } from '../api.js';
import { html, useLayoutEffect, useRef } from '../ui.js';
import { Button, MoreButton } from '../ui/basics.js';
import { Art, LandscapeCard, PosterCard, Row } from '../ui/cards.js';
import { MediaChips, DetailMeta, TitleArt, Genres, WatchlistButton, DownloadButton, RatingControl } from '../ui/detail.js';
import { openCastPicker } from '../cast.js';
import { h, clear, episodeLabel, formatRuntime, formatBytes, formatClock } from '../dom.js';
import { toast, openDialog, spinner, endsAt, timeLeft, field, button, TOASTS } from '../components.js';
import { addToPlaylistItems } from '../lists.js';
import { openRating, canRate } from '../rating.js';
import { parseClock } from '../markers.js';
import { setTitle, navigate, refreshView, canAdmin, isKidsProfile, isOrbit } from '../app.js';
import { setBackdrop } from '../backdrop.js';
import { openEditDetails } from './edit-details.js';
import { downloadSheetItem } from '../offline/ui.js';
import { resumeInfo, selectedSeasonId, introText, isWatched } from '../item-rules.js';
import { Seasons } from './item-show.js';
import { AlbumPage, ArtistPage } from './item-music.js';

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
  if (item.kind === 'album') {
    setTitle(`${item.title}${data.artist ? ` · ${data.artist.title}` : ''}`);
    setBackdrop(item.backdrop || data.artist?.backdrop || item.poster);
    return { page: data };
  }
  if (item.kind === 'artist') {
    setTitle(item.title);
    setBackdrop(item.backdrop || item.poster);
    return { page: data };
  }
  if (item.kind === 'show') {
    setTitle(item.title);
    setBackdrop(item.backdrop || item.poster); // before the season's answer, so the card's art has it at once
    // The page arrives with its selected season's episodes (the address says which, for Back and a reload).
    const id = selectedSeasonId(data.seasons || [], { query, nextEpisode: data.nextEpisode });
    if (id) {
      history.replaceState(null, '', `#/item/${item.id}?season=${id}`);
      data.season = await api.get(`/api/items/${id}`);
    }
    return { page: data };
  }
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
  const { item, tracks } = data.page;
  if (item.kind === 'album' || item.kind === 'artist') {
    const Page = item.kind === 'album' ? AlbumPage : ArtistPage;
    const more = html`<${MoreActions} item=${item} more=${moreItems(item, undefined, { tracks: tracks || [] })} download=${false} />`;
    return html`<${Page} data=${data.page} query=${query} more=${more} />`;
  }
  return html`<${TitlePage} data=${data.page} />`;
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

/** A movie, a show or an episode. */
function TitlePage({ data }) {
  const { item, show } = data;
  const orbit = isOrbit();
  const backdrop = item.backdrop || show?.backdrop;
  const r = resumeInfo(item);
  const episode = item.kind === 'episode';
  const isShow = item.kind === 'show';
  const playable = !isShow; // a film or an episode (a show plays its next episode)
  const season = useRef(null); // the show's selected season, for "…"'s Add season to playlist and Download season
  const t = data.trailer;
  const actions = [
    playable ? html`<${PlayButtons} target=${item} label=${(res) => (res ? `Resume from ${formatClock(res.position)}` : 'Play')} />` : null,
    isShow && data.nextEpisode ? html`<${PlayButtons} target=${data.nextEpisode} label=${(res) => `${res ? 'Resume' : 'Play'} ${episodeLabel(data.nextEpisode)}`} />` : null,
    t ? html`<${Button} label="Trailer" icon="film" variant="ghost" href=${t.kind === 'local' ? `#/play/${t.itemId}?from=${item.id}` : `#/trailer/${item.id}`} />` : null,
    item.kind === 'movie' || isShow ? html`<${WatchlistButton} item=${item} initialIn=${data.inWatchlist} />` : null,
    html`<${WatchedButton} item=${item} />`,
    orbit && playable && !item.remote ? html`<${DownloadButton} item=${item} />` : null,
    html`<${MoreActions} item=${item} more=${moreItems(item, data.markers, { seasonId: () => season.current })} download=${playable} />`,
  ];
  // The body's first block rises in after the page's first-screen blocks (data-rise: their order).
  const next = episode && data.nextEpisode;
  const details = playable ? MediaDetails({ item, subtitles: data.subtitles, rise: next ? null : '3' }) : null;
  return [
    html`<header class="detail-header" data-art=${backdrop ? 'backdrop' : 'poster'}>
      <div class="detail-inner">
        <div class=${`detail-poster ${episode ? 'is-landscape' : ''}`}><${Art} key=${item.poster || show?.poster || ''} src=${item.poster || show?.poster} title=${item.title} kind=${episode ? 'landscape' : 'poster'} eager=${true} /></div>
        <div class="detail-info">
          ${episode ? html`<p class="eyebrow"><a href=${`#/item/${show.id}`}>${show.title}</a>${` · ${episodeLabel(item)}`}</p>` : null}
          <${TitleArt} logo=${episode ? null : item.logo} title=${item.title} />
          <${DetailMeta} item=${item} ends=${playable ? endsAt(timeLeft(item)) : null} rise="0" />
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
      ${isShow ? html`<${Seasons} show=${item} seasons=${data.seasons || []} first=${data.season || null} rise="3" selected=${season} />` : null}
      ${next ? html`<section class="detail-section" data-rise="3"><h2>Next episode</h2><div class="next-card"><${LandscapeCard} item=${{ ...data.nextEpisode, showTitle: show.title }} /></div></section>` : null}
      ${details}
      <${TitleRows} data=${data} item=${item} backdrop=${backdrop} rise=${isShow || next || details ? null : '3'} />
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


