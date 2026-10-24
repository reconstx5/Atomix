// Downloads (v0.21): what this profile keeps on this device — films, shows (by show and season), music (by album) and
// (v0.22) audiobooks (by book) and podcasts (by show), played through the bar in spoken mode,
// with the space used, each one's quality, size and expiry, and Play / Remove. It also opens with no connection.
import { h, clear, formatBytes, episodeLabel } from '../dom.js';
import { button, emptyState, toast, announce } from '../components.js';
import { state, setTitle } from '../app.js';
import { downloads } from '../offline/downloader.js';
import { openStore } from '../offline/store.js';
import { stateLabel } from '../offline/ui.js';
import { isExpired } from '../offline/sync.js';
import { partAt, resumePoint } from '../spoken-time.js';

const DAY = 86400_000;
const trackOrder = (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || String(a.title).localeCompare(b.title);

function expiresText(e) {
  const days = Number(state.status?.downloads?.offlineDays) || 30;
  if (isExpired(e)) return 'Connect to Atomix to keep this download';
  const left = Math.max(0, Math.ceil(((e.checkedAt || e.downloadedAt || Date.now()) + days * DAY - Date.now()) / DAY));
  return `Expires in ${left} day${left === 1 ? '' : 's'}`;
}

const BOOK_KINDS = new Set(['chapter', 'audiobook']);
const playable = (x) => x.status === 'ready' && !isExpired(x);
const bookKey = (e) => e.book?.id ?? `t:${e.title}`;

/**
 * Where to pick a spoken title up offline: the newest of the place known when it was downloaded and the places this
 * device has kept since (a book's parts turned into book time), 5 s back after more than 10 minutes away.
 */
async function savedPlace(profileId, { ids, toBook, base }) {
  let best = base?.positionAt != null || base?.position ? { position: base.watched ? 0 : base.position || 0, updatedAt: base.positionAt || 0 } : null;
  try {
    const store = await openStore();
    for (const p of await store.pendingProgress()) {
      if (p.profileId !== profileId || !ids.includes(p.itemId)) continue;
      if (!best || p.at >= best.updatedAt) best = { position: toBook(p.itemId, p.position), updatedAt: p.at };
    }
  } catch {
    /* nothing kept: the download's own place */
  }
  return best ? resumePoint(best) : 0;
}

/** A book's downloaded parts as one book in the bar (from `from` seconds into the book, else from its saved place). */
async function playBookOffline(e, all, profileId, from = null) {
  const book = e.book || { id: e.itemId, title: e.title, author: e.artist || null, parts: [], chapters: [] };
  const parts = book.parts?.length ? book.parts : [{ id: e.itemId, title: e.title, start: 0, duration: e.duration || 0 }];
  const total = parts.reduce((t, p) => t + (p.duration || 0), 0);
  const mine = all.filter((x) => BOOK_KINDS.has(x.kind) && playable(x) && bookKey(x) === bookKey(e));
  const byId = new Map(mine.map((x) => [x.itemId, x]));
  const entries = [];
  parts.forEach((p, i) => {
    const x = byId.get(p.id);
    if (x) entries.push({ ...x, spoken: { kind: 'book', bookId: book.id, title: book.title, author: book.author, parts: parts.length > 1 ? parts : [], partIndex: i, chapters: book.chapters || [], total } });
  });
  if (!entries.length) return;
  const toBook = (itemId, pos) => (parts.find((p) => p.id === itemId)?.start || 0) + (Number(pos) || 0);
  const start = from ?? (await savedPlace(profileId, { ids: parts.map((p) => p.id), toBook, base: book }));
  const { index, offset } = partAt(parts.length > 1 ? parts : [], start);
  // The part to start in, or the next one on this device (a part that isn't here is passed over).
  let qi = entries.findIndex((x) => x.spoken.partIndex >= index);
  if (qi < 0) qi = entries.length - 1;
  const at = entries[qi].spoken.partIndex === index ? offset : 0;
  const { playOffline } = await import('../music.js');
  return playOffline(entries, qi, { at });
}

/** Play a download: a song with the rest of its album's downloaded songs, in order; a video in the player; a book's
 *  part as its book; a podcast episode on its own. */
export async function playEntry(e, all = [], { from = null } = {}) {
  if (isExpired(e)) {
    toast('Connect to Atomix to keep this download', { type: 'error' });
    announce('Connect to Atomix to keep this download');
    return;
  }
  const profileId = state.profile?.id ?? downloads.profileId;
  if (BOOK_KINDS.has(e.kind) || e.kind === 'podcast_episode') {
    // The places on the device may have moved since the page was drawn (a sync): read them as they are now.
    all = await (await openStore()).list(profileId).catch(() => all);
    e = all.find((x) => x.itemId === e.itemId) || e;
  }
  if (e.kind === 'book' || e.kind === 'comic') {
    location.hash = `#/read/${e.itemId}?offline=1`; // v0.22 Plan D: the readers open the copy on this device
    return;
  }
  if (BOOK_KINDS.has(e.kind)) return playBookOffline(e, all, profileId, from);
  if (e.kind === 'podcast_episode') {
    const show = e.showTitle || null;
    const start = await savedPlace(profileId, { ids: [e.itemId], toBook: (_, p) => Number(p) || 0, base: e });
    const { playOffline } = await import('../music.js');
    return playOffline([{ ...e, artist: show, spoken: { kind: 'episode', title: e.title, author: show, parts: [], partIndex: 0, chapters: [], total: e.duration || 0 } }], 0, { at: start });
  }
  if (e.kind === 'track') {
    const { playOffline } = await import('../music.js');
    const album = all.filter((x) => x.kind === 'track' && x.status === 'ready' && !isExpired(x) && (x.parentId ?? x.albumTitle ?? null) === (e.parentId ?? e.albumTitle ?? null)).sort(trackOrder);
    const list = album.some((x) => x.itemId === e.itemId) ? album : [e];
    return playOffline(list, list.findIndex((x) => x.itemId === e.itemId));
  }
  location.hash = `#/play/${e.itemId}?offline=1`;
}

export async function render(el) {
  setTitle('Downloads');
  const store = await openStore();
  const body = h('div', { class: 'downloads-body' });
  const space = h('div', { class: 'dl-space' });
  const banner = h('p', { class: 'dl-offline', role: 'status', hidden: !state.offline }, 'You’re offline — your downloads are here');
  const elsewhere = h('p', { class: 'dl-elsewhere muted', role: 'status', hidden: true }, 'Downloading in another tab');
  const heading = h('h1', { tabindex: '-1' }, 'Downloads');
  let refocus = null; // after Remove: the rows to put the focus on (the next, else the previous), else the heading
  const removeAll = button('Remove all', { icon: 'trash', variant: 'ghost', onClick: () => confirmAll() });
  const confirm = h('div', { class: 'dl-confirm', role: 'group', 'aria-label': 'Remove all downloads?', hidden: true });
  el.append(h('div', { class: 'downloads-view page' }, h('header', { class: 'page-head' }, heading, removeAll), banner, elsewhere, space, confirm, body));
  const profileId = () => state.profile?.id ?? downloads.profileId;

  function confirmAll() {
    const no = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Cancel');
    const yes = h('button', { type: 'button', class: 'btn btn-danger' }, 'Remove all downloads');
    no.addEventListener('click', () => {
      confirm.hidden = true;
      removeAll.focus();
    });
    yes.addEventListener('click', async () => {
      for (const e of await store.list(profileId())) await downloads.remove(e.itemId);
      confirm.hidden = true;
      toast('Downloads removed');
      announce('Downloads removed');
      removeAll.focus();
    });
    confirm.replaceChildren(h('p', {}, 'Remove every download from this device? You can download them again later.'), h('div', { class: 'actions' }, no, yes));
    confirm.hidden = false;
    no.focus();
  }

  const posters = [];
  let current = []; // this profile's downloads, as last drawn
  function row(e) {
    let poster = null;
    if (e.poster instanceof Blob) {
      const url = URL.createObjectURL(e.poster);
      posters.push(url);
      poster = h('img', { class: 'dl-poster', src: url, alt: '', loading: 'lazy' });
    } else poster = h('span', { class: 'dl-poster dl-poster-none', 'aria-hidden': 'true' });
    const expired = isExpired(e);
    const ready = e.status === 'ready' && !expired;
    const busy = ['preparing', 'downloading', 'waiting'].includes(e.status);
    const title = e.kind === 'episode' && e.episode != null ? `${e.title}` : e.title;
    const meta = ready || expired ? [e.quality ? `${e.quality}p` : null, formatBytes(e.size), expiresText(e)].filter(Boolean).join(' · ') : stateLabel(e) + (e.error && e.status === 'failed' ? ` — ${e.error}` : '');
    const actions = h(
      'div',
      { class: 'dl-actions' },
      // Each button says whose it is ("Pause Big Book"): a list of plain "Pause"s can't be told apart by ear.
      ready || expired ? button(e.kind === 'book' || e.kind === 'comic' ? 'Read' : 'Play', { icon: 'play', variant: 'secondary', onClick: () => playEntry(e, current, { from: e.kind === 'chapter' ? (e.book?.parts?.find((p) => p.id === e.itemId)?.start ?? 0) : null }), attrs: { 'aria-label': `${e.kind === 'book' || e.kind === 'comic' ? 'Read' : 'Play'} ${title}`, 'data-key': `play:${e.itemId}` } }) : null,
      busy ? button('Pause', { variant: 'ghost', onClick: () => downloads.pause(e.itemId), attrs: { 'aria-label': `Pause ${title}`, 'data-key': `pause:${e.itemId}` } }) : null,
      e.status === 'paused' ? button('Resume', { variant: 'ghost', onClick: () => downloads.resume(e.itemId), attrs: { 'aria-label': `Resume ${title}`, 'data-key': `resume:${e.itemId}` } }) : null,
      button('Remove', {
        icon: 'trash',
        variant: 'ghost',
        onClick: (ev) => {
          const rows = [...body.querySelectorAll('.dl-row')];
          const i = rows.indexOf(ev.currentTarget.closest('.dl-row'));
          refocus = [rows[i + 1]?.dataset.id, rows[i - 1]?.dataset.id].filter(Boolean);
          return downloads.remove(e.itemId).then(() => toast(`Removed ${e.title}`));
        },
        attrs: { 'aria-label': `Remove ${title}`, 'data-key': `remove:${e.itemId}` },
      }),
    );
    return h(
      'li',
      { class: 'dl-row', dataset: { status: e.status, id: e.itemId } },
      poster,
      h('div', { class: 'dl-text' }, h('strong', { class: 'dl-title' }, title), e.kind === 'episode' && e.episode != null ? h('span', { class: 'muted small' }, episodeLabel(e)) : null, h('span', { class: 'muted small dl-meta' }, meta)),
      actions,
    );
  }

  async function draw() {
    const focusKey = document.activeElement?.closest?.('.downloads-view')?.dataset?.key || document.activeElement?.dataset?.key;
    for (const u of posters.splice(0)) URL.revokeObjectURL(u);
    const list = await store.list(profileId());
    current = list;
    const { used, quota } = await store.usage();
    const limit = Math.min(quota ?? Infinity, (Number(state.status?.downloads?.deviceGb) || 20) * 1024 ** 3);
    space.replaceChildren(
      h('span', {}, `Using ${formatBytes(used) || '0 MB'} of ${formatBytes(limit)}`),
      h('meter', { min: 0, max: limit, value: Math.min(used, limit), 'aria-label': 'Space used by downloads' }),
    );
    removeAll.hidden = !list.length;
    elsewhere.hidden = !(downloads.elsewhere && list.some((x) => ['preparing', 'downloading', 'waiting'].includes(x.status)));
    clear(body);
    if (!list.length) {
      if (refocus) ((refocus = null), heading.focus());
      body.append(emptyState({ title: 'Nothing downloaded yet', text: 'Download a film, an episode, a season or an album from its page to watch it here with no connection.', icon: 'download' }));
      return;
    }
    const films = list.filter((e) => e.kind === 'movie').sort((a, b) => String(a.title).localeCompare(b.title));
    const eps = list.filter((e) => e.kind === 'episode');
    const songs = list.filter((e) => e.kind === 'track');
    const books = list.filter((e) => BOOK_KINDS.has(e.kind));
    const pods = list.filter((e) => e.kind === 'podcast_episode');
    const reading = [['Books', list.filter((e) => e.kind === 'book')], ['Comics', list.filter((e) => e.kind === 'comic')]];
    if (films.length) body.append(h('section', { class: 'dl-section' }, h('h2', {}, 'Films'), h('ul', { class: 'dl-list', role: 'list' }, films.map(row))));
    if (eps.length) {
      const shows = new Map();
      for (const e of eps) {
        const key = e.showTitle || 'Episodes';
        if (!shows.has(key)) shows.set(key, new Map());
        const seasons = shows.get(key);
        const s = e.season ?? 0;
        if (!seasons.has(s)) seasons.set(s, []);
        seasons.get(s).push(e);
      }
      const section = h('section', { class: 'dl-section' }, h('h2', {}, 'Shows'));
      for (const [show, seasons] of [...shows].sort((a, b) => a[0].localeCompare(b[0]))) {
        const group = h('div', { class: 'dl-group' }, h('h3', {}, show));
        for (const [n, items] of [...seasons].sort((a, b) => a[0] - b[0])) {
          group.append(h('h4', {}, n ? `Season ${n}` : 'Specials'), h('ul', { class: 'dl-list', role: 'list' }, items.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)).map(row)));
        }
        section.append(group);
      }
      body.append(section);
    }
    if (songs.length) {
      const albums = new Map();
      for (const e of songs) {
        const key = e.albumTitle || 'Songs';
        if (!albums.has(key)) albums.set(key, []);
        albums.get(key).push(e);
      }
      const section = h('section', { class: 'dl-section' }, h('h2', {}, 'Music'));
      for (const [album, items] of albums) section.append(h('div', { class: 'dl-group' }, h('h3', {}, album), h('ul', { class: 'dl-list', role: 'list' }, items.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0)).map(row))));
      body.append(section);
    }
    if (books.length) {
      const byBook = new Map();
      for (const e of books) {
        if (!byBook.has(bookKey(e))) byBook.set(bookKey(e), []);
        byBook.get(bookKey(e)).push(e);
      }
      const section = h('section', { class: 'dl-section' }, h('h2', {}, 'Audiobooks'));
      for (const items of [...byBook.values()].sort((a, b) => String(a[0].book?.title || a[0].title).localeCompare(b[0].book?.title || b[0].title))) {
        const b = items[0].book;
        const order = (x) => b?.parts?.findIndex((p) => p.id === x.itemId) ?? 0;
        items.sort((x, y) => order(x) - order(y));
        const name = b?.title || items[0].title;
        const first = items.find((x) => playable(x));
        const play = first ? button('Play book', { icon: 'play', variant: 'secondary', onClick: () => playEntry(first, current), attrs: { class: 'btn btn-secondary dl-book-play', 'aria-label': `Play ${name}`, 'data-key': `book:${bookKey(first)}` } }) : null;
        section.append(
          h(
            'div',
            { class: 'dl-group dl-book', dataset: { book: b?.id ?? '' } },
            h('div', { class: 'dl-group-head' }, h('div', {}, h('h3', {}, name), b?.author ? h('p', { class: 'muted small' }, b.author) : null), play),
            h('ul', { class: 'dl-list', role: 'list' }, items.map(row)),
          ),
        );
      }
      body.append(section);
    }
    if (pods.length) {
      const byShow = new Map();
      for (const e of pods) {
        const k = e.showTitle || 'Episodes';
        if (!byShow.has(k)) byShow.set(k, []);
        byShow.get(k).push(e);
      }
      const section = h('section', { class: 'dl-section' }, h('h2', {}, 'Podcasts'));
      for (const [show, items] of [...byShow].sort((a, b) => a[0].localeCompare(b[0]))) {
        section.append(h('div', { class: 'dl-group' }, h('h3', {}, show), h('ul', { class: 'dl-list', role: 'list' }, items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).map(row))));
      }
      body.append(section);
    }
    // v0.22 Plan D: books, and comics in number order.
    for (const [name, items] of reading) {
      if (!items.length) continue;
      items.sort((a, b) => String(a.showTitle || a.title).localeCompare(b.showTitle || b.title) || (Number(a.issue) || 0) - (Number(b.issue) || 0) || String(a.title).localeCompare(b.title));
      body.append(h('section', { class: 'dl-section' }, h('h2', {}, name), h('ul', { class: 'dl-list', role: 'list' }, items.map(row))));
    }
    if (refocus) {
      const to = refocus.map((id) => body.querySelector(`.dl-row[data-id="${id}"] button`)).find(Boolean);
      refocus = null;
      (to || heading).focus();
    } else if (focusKey) body.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  let timer = null;
  // (the route's cleanup stops this; the page isn't on screen yet while it is first drawn, so that isn't a reason)
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 250);
  };
  downloads.events.addEventListener('change', onChange);
  await draw();
  return () => {
    clearTimeout(timer);
    downloads.events.removeEventListener('change', onChange);
    for (const u of posters.splice(0)) URL.revokeObjectURL(u);
  };
}
