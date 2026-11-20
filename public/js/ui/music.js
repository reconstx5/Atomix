// The music screens' Preact parts: useMusic() (a value from the music engine, re-rendering when it changes), the song
// rows (TrackList: album pages, the Songs view, search and Now Playing's up next) and a song's "…" menu. Same
// elements, classes and attributes as the engine's older trackList(); each list marks the playing song itself.
import { html, render, useState, useRef, useLayoutEffect } from '../ui.js';
import { Icon } from './basics.js';
import { Art } from './cards.js';
import { formatClock } from '../dom.js';
import { openSheet, openDialog } from '../components.js';
import { addToPlaylistItems } from '../lists.js';
import { openRating } from '../rating.js';
import { downloadSheetItem } from '../offline/ui.js';
import { music } from '../music.js';
import { discRows, trackNumber, subLine, queueFocusAfter } from '../nowplaying-rules.js';

const same = (a, b) => Object.is(a, b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));

/**
 * A value from the music engine; the component re-renders when it changes (arrays compared item by item).
 *   const [id, playing] = useMusic((m) => [m.current?.id, m.playing]);
 * `kinds`: the engine events to listen to ('time' only for parts that move with the clock).
 */
export function useMusic(select, kinds = ['change', 'state']) {
  const [value, setValue] = useState(() => select(music));
  const pick = useRef(select);
  pick.current = select;
  useLayoutEffect(() => {
    const check = () => {
      const next = pick.current(music);
      setValue((prev) => (same(prev, next) ? prev : next));
    };
    for (const k of kinds) music.events.addEventListener(k, check);
    check(); // in case it changed between the first render and this effect
    return () => {
      for (const k of kinds) music.events.removeEventListener(k, check);
    };
  }, [kinds.join(',')]);
  return value;
}

/**
 * Song rows. showArtist: true = always, a string = only when the song's artist differs from it. `queueOffset`: the rows
 * are the live queue from that index on — a click jumps there instead of rebuilding the queue.
 */
export function TrackList({ tracks, showAlbum = false, showArtist = true, numbers = true, discs = false, focusId = null, queueOffset = null }) {
  const [currentId, playing] = useMusic((m) => [m.current?.id, m.playing]);
  const click = (t, i) => {
    if (music.current?.id === t.id && music.started) music.toggle();
    else if (queueOffset != null) music.jump(queueOffset + i);
    else music.playTracks(tracks, i, { shuffle: music.shuffle });
  };
  return html`<ol class=${`tracks${showAlbum ? ' with-album' : ''}`} role="list">
    ${discRows(tracks, discs).map((row) => {
      if (row.disc != null) return html`<li key=${`disc:${row.disc}`} class="disc-head" aria-hidden="true"><${Icon} name="album" size=${16} />${`Disc ${row.disc}`}</li>`;
      const { track: t, i } = row;
      const on = Number(t.id) === currentId;
      const sub = subLine(t, showArtist, showAlbum);
      const src = t.poster || t.albumPoster;
      return html`<li key=${`${t.id}:${i}`} class=${`track-row${on ? ' is-current' : ''}${on && playing ? ' is-playing' : ''}`} data-id=${t.id} aria-current=${on ? 'true' : null}>
        <button type="button" class="track-main" aria-label=${`Play ${t.title}${t.artist ? ` by ${t.artist}` : ''}`} data-autofocus=${focusId === t.id ? '' : null} onClick=${() => click(t, i)}>
          <span class="track-num"><span class="track-n">${trackNumber(t, i, numbers)}</span><span class="track-eq" aria-hidden="true"><i /><i /><i /></span><${Icon} name="play" size=${16} /></span>
          ${showAlbum ? html`<${Art} key=${src || ''} src=${src} title=${t.albumTitle || t.title} kind="square" />` : null}
          <span class="track-text"><span class="track-title">${t.title}</span>${sub ? html`<span class="track-sub">${sub}</span>` : null}</span>
          <span class="track-time">${t.duration ? formatClock(t.duration) : ''}</span>
        </button>
        <button type="button" class="mbtn track-more" aria-label=${`More for ${t.title}`} title="More" onClick=${() => trackMenu(t)}><${Icon} name="more" size=${20} /></button>
      </li>`;
    })}
  </ol>`;
}

/**
 * The queue dialog's list: the songs still to come (the playing one is on the mini-player already). After a move or
 * remove, focus stays on the same kind of button (queueFocusAfter); otherwise on whichever row control had it.
 */
export function QueueList({ list }) {
  const pending = useRef(null); // the data-qkey to refocus after the next redraw
  const want = useRef(null);
  const [, length, index] = useMusic((m) => [m.queue.items.map((t) => t.id).join(','), m.queue.length, m.queue.index], ['change']);
  const q = music.queue;
  // Read while rendering, before the DOM changes: the keyed control that has focus now.
  want.current = pending.current ?? document.activeElement?.dataset?.qkey ?? null;
  useLayoutEffect(() => {
    pending.current = null;
    const keep = want.current;
    const target = keep && list.querySelector(`[data-qkey="${keep}"]:not(:disabled)`);
    if (target) target.focus({ preventScroll: false });
  });
  const act = (i, action, fn) => () => {
    pending.current = queueFocusAfter(action, i, q.length);
    fn();
  };
  const upcoming = q.items.map((t, i) => [t, i]).filter(([, i]) => i > q.index);
  const body = !q.length
    ? html`<li class="muted">Nothing queued.</li>`
    : !upcoming.length
      ? html`<li class="muted">Nothing more queued.</li>`
      : upcoming.map(([t, i]) => html`<li key=${`${t.id}:${i}`} class="queue-row">
          <button type="button" class="queue-main" data-qkey=${`${i}:main`} onClick=${() => { pending.current = `${i}:main`; music.jump(i); }}>
            <${Art} key=${t.poster || ''} src=${t.poster} title=${t.albumTitle || t.title} kind="square" />
            <span class="queue-text"><strong>${t.title}</strong><small>${[t.artist, t.albumTitle].filter(Boolean).join(' · ')}</small></span>
            <span class="muted small">${t.duration ? formatClock(t.duration) : ''}</span>
          </button>
          <span class="queue-tools">
            <button type="button" class="mbtn" aria-label=${`Move “${t.title}” up`} title="Move up" disabled=${i <= q.index + 1} data-qkey=${`${i}:up`} onClick=${act(i, 'up', () => music.move(i, i - 1))}><${Icon} name="up" size=${18} /></button>
            <button type="button" class="mbtn" aria-label=${`Move “${t.title}” down`} title="Move down" disabled=${i === q.length - 1} data-qkey=${`${i}:down`} onClick=${act(i, 'down', () => music.move(i, i + 1))}><${Icon} name="chevronDown" size=${18} /></button>
            <button type="button" class="mbtn" aria-label=${`Remove “${t.title}”`} title="Remove" data-qkey=${`${i}:remove`} onClick=${act(i, 'remove', () => music.remove(i))}><${Icon} name="close" size=${18} /></button>
          </span>
        </li>`);
  return body;
}

/** The Queue dialog. Its list stops listening when the dialog closes. */
export function openQueue() {
  let list;
  openDialog({
    title: 'Queue',
    wide: true,
    body: () => {
      list = document.createElement('ol');
      list.className = 'queue-list';
      list.setAttribute('role', 'list');
      render(html`<${QueueList} list=${list} />`, list);
      return list;
    },
    actions: [
      { label: 'Clear queue', value: 'clear', variant: 'ghost' },
      { label: 'Done', value: 'close', variant: 'primary' },
    ],
  }).then((v) => {
    render(null, list);
    if (v === 'clear') music.stop();
  });
}

/** A song's "…" sheet. */
export function trackMenu(t) {
  openSheet(t.title, [
    { label: 'Play now', icon: 'play', onSelect: () => music.playTracks([t], 0) },
    { label: 'Play next', icon: 'queue', onSelect: () => music.playNext([t]) },
    { label: 'Add to queue', icon: 'queue', onSelect: () => music.addToQueue([t]) },
    // Lyrics for a song that isn't playing: its own page, with the queue left as it is.
    { label: 'Lyrics', icon: 'list', onSelect: () => { location.hash = music.current?.id === t.id ? '#/now-playing' : `#/now-playing?song=${t.id}`; } },
    addToPlaylistItems({ itemId: t.id }, { kind: 'music' }),
    { label: 'Rate…', icon: 'star', onSelect: () => openRating(t) },
    downloadSheetItem(t), // v0.21: into the app
    { label: 'Cast to…', icon: 'cast', onSelect: async () => (await import('../cast.js')).openCastPicker({ queue: { itemIds: [t.id], index: 0 } }) },
    t.parentId ? { label: 'Go to album', icon: 'album', onSelect: () => (location.hash = `#/item/${t.parentId}?track=${t.id}`) } : null,
    t.showId ? { label: 'Go to artist', icon: 'user', onSelect: () => (location.hash = `#/item/${t.showId}`) } : null,
  ]);
}
