// A podcast's page (v0.22): the show, its episodes (Unplayed / Downloaded / All), "Play unplayed in order" (oldest
// first), Mark played, a device download; admins also keep episodes, set what the server keeps, see the feed's last
// check and unsubscribe. A Kids profile sees the show and its episodes only.
import { api } from '../api.js';
import { h, clear, timeAgo } from '../dom.js';
import { art, button, toast, openDialog, confirmDialog, field, toggle, episodeCaption, moreButton } from '../components.js';
import { setTitle, navigate, canAdmin } from '../app.js';
import { setBackdrop } from '../backdrop.js';
import { playEpisode } from '../spoken.js';
import { downloadSheetItem } from '../offline/ui.js';

const FILTERS = [
  ['unplayed', 'Unplayed'],
  ['downloaded', 'Downloaded'],
  ['all', 'All'],
];
const KEEP = ['all', 3, 5, 10, 25, 50, 100];

const unplayed = (e) => !e.progress?.watched;
const dateOf = (e) => (e.publishedAt ? new Date(e.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);
/** Oldest first, for playing in order (the list is newest first). */
const oldestFirst = (eps) => [...eps].sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0) || a.id - b.id);

export function feedLine(feed) {
  if (!feed) return null;
  if (feed.error) return h('p', { class: 'feed-status is-error', role: 'status' }, `Couldn't check the feed: ${feed.error}${feed.errorSince ? ` (first failed ${timeAgo(feed.errorSince)})` : ''}`);
  return h('p', { class: 'feed-status muted small' }, feed.checkedAt ? `Checked ${timeAgo(feed.checkedAt)}` : 'Not checked yet');
}

export async function render(el, params, query = {}, first = null) {
  let data = first || (await api.get(`/api/items/${params.id}`));
  const show = data.item;
  setTitle(show.title);
  setBackdrop(show.backdrop || show.poster);
  const admin = canAdmin();
  let filter = data.episodes.some(unplayed) ? 'unplayed' : 'all';

  const list = h('ol', { class: 'episode-list', role: 'list', 'aria-label': 'Episodes' });
  const chips = h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Show' });
  const playBtn = h('div', { class: 'play-slot' });
  const feedSlot = h('div', {});

  const shown = () => data.episodes.filter((e) => (filter === 'unplayed' ? unplayed(e) : filter === 'downloaded' ? e.downloaded : true));
  const queueable = () => oldestFirst(data.episodes.filter((e) => unplayed(e) && e.downloaded));

  async function reload() {
    data = await api.get(`/api/items/${show.id}`);
    draw();
  }
  /**
   * After a row's action the list is drawn again: the focus goes back to the same button of that row, else the same
   * button of the next row (the episode left this filter), else the previous, else the filters.
   */
  async function reloadKeepingFocus(btn, cls) {
    const row = btn.closest('.episode-row');
    const ids = [row, row?.nextElementSibling, row?.previousElementSibling].map((r) => r?.dataset?.id).filter(Boolean);
    await reload();
    const target = ids.map((id) => list.querySelector(`.episode-row[data-id="${id}"] .${cls}`)).find(Boolean);
    (target || chips.querySelector('[aria-pressed="true"]'))?.focus();
  }

  function episodeRow(ep) {
    const played = Boolean(ep.progress?.watched);
    const bits = [dateOf(ep), episodeCaption(ep)].filter(Boolean).join(' · ');
    const pos = ep.progress && !played ? ep.progress.position : 0;
    const dur = ep.progress?.duration || ep.duration;
    const actions = [
      button('', {
        icon: 'play',
        variant: 'ghost',
        title: ep.downloaded ? `Play ${ep.title}` : 'Not downloaded to the server yet',
        attrs: { 'aria-label': `Play ${ep.title}`, disabled: ep.downloaded ? null : true, class: 'btn btn-ghost btn-icon episode-play' },
        onClick: () => playEpisode(ep, { show }),
      }),
      button(played ? 'Mark unplayed' : 'Mark played', {
        variant: 'ghost',
        attrs: { class: 'btn btn-ghost mark-played', 'aria-label': `${played ? 'Mark unplayed' : 'Mark played'}: ${ep.title}` },
        onClick: async (ev) => {
          const btn = ev.currentTarget; // (gone from the event once it has been handled)
          await api.post(`/api/items/${ep.id}/watched`, { watched: !played });
          toast(played ? 'Marked as unplayed' : 'Marked as played');
          await reloadKeepingFocus(btn, 'mark-played');
        },
      }),
    ];
    const dl = ep.downloaded ? downloadSheetItem(ep, { label: 'Download to this device' }) : null;
    if (dl) actions.push(button('', { icon: 'download', variant: 'ghost', title: 'Download to this device', attrs: { 'aria-label': `Download ${ep.title} to this device`, class: 'btn btn-ghost btn-icon' }, onClick: dl.onSelect }));
    if (admin) {
      actions.push(
        button(ep.kept ? 'Kept' : 'Keep', {
          variant: ep.kept ? 'secondary active' : 'ghost',
          title: ep.kept ? 'Kept on the server whatever the keep settings say' : 'Keep this episode on the server',
          attrs: { class: `btn ${ep.kept ? 'btn-secondary active' : 'btn-ghost'} keep-toggle`, 'aria-pressed': String(Boolean(ep.kept)), 'aria-label': `Keep ${ep.title}` },
          onClick: async (ev) => {
            const btn = ev.currentTarget;
            await api.put(`/api/podcasts/episodes/${ep.id}/keep`, { kept: !ep.kept });
            await reloadKeepingFocus(btn, 'keep-toggle');
          },
        }),
      );
    }
    return h(
      'li',
      { class: `episode-row${played ? ' is-played' : ''}`, dataset: { id: ep.id } },
      h(
        'div',
        { class: 'episode-info' },
        h('h3', { class: 'episode-title' }, ep.title),
        bits ? h('p', { class: 'muted small' }, bits) : null,
        pos > 30 && dur ? h('div', { class: 'progress', role: 'presentation' }, h('span', { style: { width: `${Math.min(100, (pos / dur) * 100)}%` } })) : null,
        ep.overview ? h('p', { class: 'episode-overview' }, ep.overview) : null,
      ),
      h('div', { class: 'episode-actions' }, actions),
    );
  }

  function draw() {
    const eps = shown();
    clear(chips).append(
      ...FILTERS.map(([v, label]) =>
        h('button', { type: 'button', class: 'season-tab', 'aria-pressed': String(filter === v), onClick: () => ((filter = v), draw(), chips.querySelector('[aria-pressed="true"]')?.focus()) }, label),
      ),
    );
    clear(list).append(...(eps.length ? eps.map(episodeRow) : [h('li', { class: 'muted episode-empty' }, filter === 'unplayed' ? 'Nothing left to play.' : filter === 'downloaded' ? 'No episodes on the server yet.' : 'No episodes yet.')]));
    const q = queueable();
    clear(playBtn).append(
      button('Play unplayed in order', {
        icon: 'play',
        variant: 'primary',
        attrs: q.length ? {} : { disabled: true, title: 'Nothing unplayed on the server' },
        onClick: () => playEpisode(q[0], { list: q, show }),
      }),
    );
    if (admin) clear(feedSlot).append(feedLine(data.feed) || '');
  }

  const more = [];
  const dl = downloadSheetItem(show, { label: 'Download kept episodes to this device' });
  if (dl) more.push(dl);
  if (admin) {
    more.push({ label: 'Keep settings', icon: 'settings', onSelect: () => keepDialog(show, data.feed, reload) });
    more.push({
      label: 'Unsubscribe',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        if (!(await confirmDialog(`Unsubscribe from ${show.title}?`, 'Its downloaded episodes are deleted from the server, and its place in everyone’s lists goes too.', { confirm: 'Unsubscribe', danger: true }))) return;
        await api.del(`/api/podcasts/${show.id}`);
        toast(`Unsubscribed from ${show.title}`);
        navigate(`#/library/${show.libraryId}`, { replace: true });
      },
    });
  }
  const actions = [playBtn];
  if (admin) {
    actions.push(
      button('Check now', {
        icon: 'refresh',
        variant: 'ghost',
        onClick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            const r = await api.post(`/api/podcasts/${show.id}/check`, {});
            toast(r?.error ? `Couldn't check: ${r.error}` : r?.found ? `${r.found} new ${r.found === 1 ? 'episode' : 'episodes'}` : 'No new episodes', { type: r?.error ? 'error' : 'info' });
            await reload();
          } finally {
            b.disabled = false;
          }
        },
      }),
    );
  }
  if (more.length) actions.push(moreButton(show.title, more));

  el.append(
    h(
      'div',
      { class: 'podcast-view' },
      h(
        'header',
        { class: 'detail-header' },
        h(
          'div',
          { class: 'detail-inner' },
          h('div', { class: 'detail-poster is-square' }, art(show.poster, show.title, { kind: 'square', eager: true })),
          h(
            'div',
            { class: 'detail-info' },
            h('h1', { class: 'detail-title' }, show.title),
            show.author ? h('p', { class: 'byline' }, show.author) : null,
            show.overview ? h('p', { class: 'overview' }, show.overview) : null,
            h('div', { class: 'actions' }, actions),
            feedSlot,
          ),
        ),
      ),
      h('div', { class: 'detail-body' }, h('section', { class: 'detail-section' }, h('h2', { class: 'visually-hidden' }, 'Episodes'), chips, list)),
    ),
  );
  draw();
  // From an episode's link: show it (whatever the filter) and put the focus on it.
  const want = Number(query.episode);
  if (want) {
    if (!shown().some((e) => e.id === want)) ((filter = 'all'), draw());
    const row = list.querySelector(`.episode-row[data-id="${want}"]`);
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector('.episode-play:not([disabled]), .mark-played')?.focus();
  }
}

async function keepDialog(show, feed, done) {
  const keep = h('select', {}, KEEP.map((n) => h('option', { value: String(n), selected: String(feed?.keep ?? 'all') === String(n) }, n === 'all' ? 'Every episode' : `The newest ${n}`)));
  let deletePlayed = Boolean(feed?.deletePlayed);
  await openDialog({
    title: 'Keep settings',
    body: h(
      'div',
      { class: 'stack' },
      field('Download to the server', keep, 'Older episodes stay listed; Keep on one downloads it whatever this says.'),
      toggle('Delete played episodes', deletePlayed, (v) => (deletePlayed = v), { hint: 'Older ones than those, once finished and nobody is part-way through.' }),
    ),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'save', variant: 'primary' },
    ],
    onSubmit: async () => {
      await api.patch(`/api/podcasts/${show.id}`, { keep: keep.value === 'all' ? 'all' : Number(keep.value), deletePlayed });
      toast('Keep settings saved');
      await done();
    },
  });
}
