// The music screens' Preact parts: useMusic() (a value from the music engine, re-rendering when it changes), the song
// rows (TrackList: album pages, the Songs view, search and Now Playing's up next) and a song's "…" menu. Same
// elements, classes and attributes as the engine's older trackList(); each list marks the playing song itself.
import { html, useState, useRef, useLayoutEffect } from '../ui.js';
import { Icon } from './basics.js';
import { Art } from './cards.js';
import { formatClock } from '../dom.js';
import { openSheet } from '../components.js';
import { addToPlaylistItems } from '../lists.js';
import { openRating } from '../rating.js';
import { downloadSheetItem } from '../offline/ui.js';
import { music } from '../music.js';
import { discRows, trackNumber, subLine } from '../nowplaying-rules.js';

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
