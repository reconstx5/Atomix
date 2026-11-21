// Now Playing: the cover, the song, lyrics with the current line in the middle, the queue, and the transport.
// A bigger window onto the same `music` object the mini-player drives; made for a TV across the room.
// Faces (nowplaying-rules.js faceFor): the playing song, another song's lyrics (?song=), a book or episode (spoken),
// nothing playing, no such song. Only the seek rows and the lyric highlight follow the clock ('time').
import { html, useState, useRef, useMemo, useLayoutEffect } from '../ui.js';
import { Button, Icon, EmptyState } from '../ui/basics.js';
import { Art } from '../ui/cards.js';
import { RatingControl } from '../ui/detail.js';
import { useMusic, TrackList, openQueue } from '../ui/music.js';
import { currentLine, seekStep, volumeStep, faceFor, sleepLabel, HOLD_MS, VOLUME_SAVE_MS } from '../nowplaying-rules.js';
import { music, openSpeed, openSleep } from '../music.js';
import { formatClock } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack, updatePrefs, navigate, refreshView } from '../app.js';
import { sliderText, percentSlider, openSheet } from '../components.js';
import { chapterAt, leftText } from '../spoken-time.js';
import { setBackdrop } from '../backdrop.js';

/** Which face, and for ?song= the song and its lyrics (the page arrives with them). */
export async function load(params, query = {}) {
  setTitle('Now playing');
  const face = faceFor({ song: query.song, current: music.current });
  if (face !== 'lyrics') return { face };
  const id = Number(query.song);
  const t = (await api.get(`/api/items/${id}`).catch(() => null))?.item;
  if (!t || t.kind !== 'track') return { face: 'missing' };
  setTitle(t.title);
  const lyrics = await api.get(`/api/items/${id}/lyrics`).catch(() => null);
  return { face: 'lyrics', track: t, lyrics };
}

export function Screen({ data, view }) {
  // What plays may have changed between load() and now: the playing faces are decided again (as today's render did).
  const [face] = useState(() => (data.face === 'lyrics' || data.face === 'missing' ? data.face : faceFor({ current: music.current })));
  if (face === 'song') return html`<${SongFace} view=${view} />`;
  if (face === 'spoken') return html`<${SpokenFace} view=${view} />`;
  if (face === 'lyrics') return html`<${LyricsFace} view=${view} track=${data.track} lyrics=${data.lyrics} />`;
  return html`<${Empty} view=${view} missing=${face === 'missing'} />`;
}

const back = () => goBack('#/');
const GONE = Symbol('gone');
const isSong = (m) => m.current;
const isSpoken = (m) => m.current?.spoken;

/** useMusic, holding the last value once the face no longer applies (stopped, or a book became a song): the page
 * being left keeps what it showed. */
function useNow(select, kinds, valid = isSong) {
  const v = useMusic((m) => (valid(m) ? select(m) : GONE), kinds);
  const last = useRef(v);
  if (v !== GONE) last.current = v;
  return last.current;
}

/** Outside the screen: the view's classes, html.nowplaying-open, and Escape (Space too on the song face). */
function useShell(view, { classes = [], open = false, keys = true, space = false } = {}) {
  useLayoutEffect(() => {
    view.classList.add('nowplaying-view', ...classes);
    if (!keys) return undefined;
    const onKey = (e) => {
      // Escape leaves, as Back and Backspace do.
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        back();
        return;
      }
      if (!space || e.defaultPrevented || e.target.closest?.('dialog, button, a, input, textarea, select')) return;
      if (e.key === ' ') {
        e.preventDefault();
        music.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    if (open) document.documentElement.classList.add('nowplaying-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      if (open) document.documentElement.classList.remove('nowplaying-open');
    };
  }, []);
}

const sub = (t) => [t.artist, t.albumTitle].filter(Boolean).join(' · ');
const playIcon = (playing) => html`<${Icon} name=${playing ? 'pause' : 'play'} size=${22} />`;
const noLyrics = html`<p class="muted np-none">No lyrics for this song</p>`;
// An empty line is a no-break space on the song face (it keeps its height: the verse break) and a plain space on ?song= (as before).
const plainLyrics = (lines, blank = '\u00a0') => html`<div class="lyrics-plain">${lines.map((l) => html`<p>${l.text || blank}</p>`)}</div>`;

/** Nothing playing, or no such song: Back. */
function Empty({ view, missing }) {
  useShell(view, { keys: false });
  const action = html`<${Button} label="Back" icon="back" autofocus=${true} onClick=${back} />`;
  return missing
    ? html`<${EmptyState} title="No such song" text="" action=${action} />`
    : html`<${EmptyState} title="Nothing playing" text="Pick a song and it will show up here." action=${action} />`;
}

// ---- the playing song ----

function SongFace({ view }) {
  useShell(view, { open: true, space: true });
  const [now, nowTitle] = useNow((m) => [m.current, m.current.title], ['change', 'state']);
  const [playing, shuffle, repeat] = useNow((m) => [m.playing, Boolean(m.shuffle), m.repeat], ['change', 'state']);
  // Drawn again for a new song only; a station's programme changing renames it (as before).
  const t = useMemo(() => now, [now.id]);
  const live = Boolean(t.live);
  const title = now.live ? nowTitle : t.title;
  const volume = useRef(null);
  const saveVolume = useRef(null);

  // A radio station: the programme and the station, "Live" for the bar, no lyrics, no shuffle or repeat.
  useLayoutEffect(() => {
    view.classList.toggle('is-live', live);
  }, [live]);
  useLayoutEffect(() => {
    setBackdrop(t.poster || t.albumPoster);
  }, [t.id]);

  // Volume: kept in the profile's prefs, 800 ms after the last change (and at once when the page is left).
  const flushVolume = () => {
    saveVolume.current = null;
    updatePrefs({ musicVolume: music.volume }).catch(() => {});
  };
  const setVolume = (v) => {
    music.setVolume(v);
    volume.current.value = String(music.volume);
    clearTimeout(saveVolume.current);
    saveVolume.current = setTimeout(flushVolume, VOLUME_SAVE_MS);
  };
  useLayoutEffect(() => {
    const vol = volume.current;
    percentSlider(vol); // its spoken value is a percentage, however .value is set
    vol.value = String(music.volume);
    const sync = () => {
      if (document.activeElement !== vol) vol.value = String(music.volume);
    };
    const onChange = () => {
      if (!music.current) return back();
      sync();
    };
    music.events.addEventListener('state', sync);
    music.events.addEventListener('change', onChange);
    return () => {
      music.events.removeEventListener('state', sync);
      music.events.removeEventListener('change', onChange);
      if (saveVolume.current) {
        clearTimeout(saveVolume.current);
        flushVolume(); // leaving straight after a change still keeps it
      }
    };
  }, []);
  const onVolumeKey = (e) => {
    const v = volumeStep(music.volume, e.key); // Up/Down: 5%
    if (v == null) return;
    e.preventDefault();
    e.stopPropagation();
    setVolume(v);
  };

  const pressed = (on) => String(Boolean(on));
  return html`<div class="np-main">
      <div class="np-side">
        <div class="np-cover"><${Art} key=${t.id} src=${t.poster || t.albumPoster} title=${t.title} kind="square" eager=${true} /></div>
        <div class="np-text">
          <h1 class="np-title">${title}</h1>
          <p class="np-sub muted">${sub(t)}</p>
          <div class="np-rate">${live ? null : html`<${RatingControl} key=${t.id} item=${t} />`}</div>
        </div>
      </div>
      <${Lyrics} id=${t.id} live=${live} />
      <aside class="np-queue"><${UpNext} /></aside>
    </div>
    <div class="np-transport">
      <div class="np-buttons">
        <${Button} label="" icon="shuffle" variant="ghost" title="Shuffle" onClick=${() => music.setShuffle(!music.shuffle)} attrs=${{ 'aria-pressed': pressed(shuffle), disabled: live }} />
        <${Button} label="" icon="prev" variant="ghost" title="Previous" onClick=${() => music.prev()} />
        <button class="btn btn-primary btn-icon" type="button" onClick=${() => music.toggle()} data-autofocus="" title=${playing ? 'Pause' : 'Play'} aria-label=${playing ? 'Pause' : 'Play'}>${playIcon(playing)}</button>
        <${Button} label="" icon="next" variant="ghost" title="Next" onClick=${() => music.next()} />
        <${Button} label="" icon="repeat" variant="ghost" title="Repeat" onClick=${() => music.cycleRepeat()} attrs=${{ 'aria-label': `Repeat: ${repeat || 'off'}`, 'aria-pressed': pressed(repeat !== 'off'), disabled: live }} />
        <span class="np-phone-only"><${Button} label="Queue" icon="queue" variant="ghost" onClick=${() => openQueue()} /></span>
        <span class="np-volume-wrap"><${Icon} name="volume" size=${20} /><input type="range" class="np-volume" min="0" max="1" step="0.05" aria-label="Volume" ref=${volume} onInput=${(e) => setVolume(Number(e.currentTarget.value))} onKeyDown=${onVolumeKey} /></span>
      </div>
      <${SeekRow} live=${live} />
    </div>`;
}

/** The song's place: "Live" for a station, the times, and the seek bar (in seconds, spoken "1:12 of 3:40"). */
function SeekRow({ live }) {
  const [pos, dur] = useNow((m) => [m.position, m.duration || 0], ['time', 'change', 'state']);
  const seek = useRef(null);
  useLayoutEffect(() => {
    seek.current.value = '0';
  }, []);
  useLayoutEffect(() => {
    const s = seek.current;
    if (!dur) return;
    s.max = String(Math.max(1, Math.round(dur)));
    if (document.activeElement !== s) s.value = String(Math.round(pos));
    s.style.setProperty('--pct', `${Math.min(100, (pos / dur) * 100)}%`);
    sliderText(s, `${formatClock(pos)} of ${formatClock(dur)}`);
  });
  const onKey = (e) => {
    const to = seekStep(music.position, music.duration, e.key); // Left/Right: 5 s (the native step would be a fraction of a second)
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    music.seek(to);
    seek.current.value = String(Math.round(to));
    sliderText(seek.current, `${formatClock(to)} of ${formatClock(music.duration || 0)}`, { force: true });
  };
  const onInput = (e) => {
    const s = e.currentTarget;
    music.seek(Number(s.value));
    sliderText(s, `${formatClock(Number(s.value))} of ${formatClock(music.duration || 0)}`, { force: true });
  };
  return html`<div class="np-seek">
    <span class="np-live" hidden=${!live}>Live</span>
    <span class="np-time">${formatClock(pos)}</span>
    <input type="range" class="np-seek-range" min="0" max="1" step="1" aria-label="Seek" ref=${seek} onKeyDown=${onKey} onInput=${onInput} />
    <span class="np-time">${`-${formatClock(Math.max(0, dur - pos))}`}</span>
  </div>`;
}

/** The songs after the playing one; a click jumps there. */
function UpNext() {
  const [, index] = useNow((m) => [m.queue.items.map((x) => x.id).join(','), m.queue.index], ['change', 'state']);
  const upcoming = music.queue.items.slice(index + 1);
  return html`<h2>Queue</h2>${upcoming.length
    ? html`<${TrackList} tracks=${upcoming} numbers=${false} showAlbum=${true} queueOffset=${index + 1} />`
    : html`<p class="muted">Nothing more queued.</p>`}`;
}

/** The lyrics box: fetched for each song (the page is usable meanwhile); an answer for an earlier song is dropped. */
function Lyrics({ id, live }) {
  const box = useRef(null);
  const hold = useRef(0); // until when the automatic centring waits (a focused line, a wheel turn)
  const [got, setGot] = useState(null); // { id, r }
  useLayoutEffect(() => {
    if (live) return undefined;
    let mine = true;
    api.get(`/api/items/${id}/lyrics`).catch(() => null).then((r) => mine && setGot({ id, r }));
    return () => {
      mine = false; // a new song, or the page left: this answer is dropped
    };
  }, [id, live]);
  useLayoutEffect(() => {
    const el = box.current;
    const onWheel = () => (hold.current = Date.now() + HOLD_MS);
    const onScroll = () => (el.scrollTop = 0); // focus() may scroll the box; the transform does the moving
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);
  let body = null;
  if (!live) {
    const r = got?.id === id ? got.r : undefined;
    if (r === undefined) body = html`<p class="muted np-looking">Looking for lyrics…</p>`;
    else if (!r) body = noLyrics;
    else if (!r.synced) body = plainLyrics(r.lines || []);
    else body = html`<${SyncedLyrics} key=${id} lines=${r.lines || []} box=${box} hold=${hold} />`;
  }
  return html`<div class="np-lyrics" ref=${box}>${body}</div>`;
}

/** Synced lines, the current one lit and in the middle: the list moves (transform), the box never scrolls. */
function SyncedLyrics({ lines, box, hold }) {
  const list = useRef(null);
  const words = useRef(lines);
  words.current = lines;
  const idx = useMusic((m) => currentLine(lines, m.position), ['time', 'change', 'state']);
  const centre = (li) => {
    if (!list.current || !box.current) return;
    const offset = li.offsetTop + li.offsetHeight / 2 - box.current.clientHeight / 2;
    list.current.style.transform = `translateY(${-Math.max(0, offset)}px)`;
  };
  const lit = useRef(idx); // the line drawn lit: centring measures it only once its larger size is on the page
  lit.current = idx;
  const frame = useRef(0);
  const follow = () => {
    const i = currentLine(words.current, music.position);
    if (i < 0 || i !== lit.current || Date.now() <= hold.current || !list.current) return; // a new line: its layout effect centres it
    if (!list.current.isConnected) {
      frame.current ||= requestAnimationFrame(() => ((frame.current = 0), follow())); // placed once the page is on screen
      return;
    }
    centre(list.current.children[i].firstChild);
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  useLayoutEffect(() => {
    const onEvent = () => followRef.current();
    for (const k of ['time', 'change', 'state']) music.events.addEventListener(k, onEvent);
    return () => {
      cancelAnimationFrame(frame.current);
      for (const k of ['time', 'change', 'state']) music.events.removeEventListener(k, onEvent);
    };
  }, []);
  useLayoutEffect(() => follow(), [idx]); // after the lit line's class is committed
  // The remote walks the lines: the list moves to the focused line.
  const onFocus = (e) => {
    hold.current = Date.now() + HOLD_MS;
    const li = e.currentTarget;
    requestAnimationFrame(() => {
      if (!box.current) return;
      box.current.scrollTop = 0;
      centre(li);
    });
  };
  return html`<ol class="lyrics-synced" role="list" ref=${list}>
    ${lines.map((l, i) => {
      const cls = `lyric-line${i === idx ? ' is-current' : ''}`;
      // A real button (Enter and Space, announced as one) inside a plain list item; an empty line is just a gap.
      return html`<li key=${i}>${l.text
        ? html`<button type="button" class=${cls} aria-label=${`Jump to: ${l.text}`} data-at=${String(l.at)} data-i=${String(i)} onClick=${() => music.seek(l.at)} onFocus=${onFocus}>${l.text}</button>`
        : html`<span class=${cls} data-at=${String(l.at)} data-i=${String(i)} onFocus=${onFocus}>${' '}</span>`}</li>`;
    })}
  </ol>`;
}

// ---- another song's lyrics (?song=) ----

/** A song's lyrics without playing it: cover, title, the lines, and a Play this song button. */
function LyricsFace({ view, track: t, lyrics: r }) {
  // Song mode is a page about a song, not the player: the mini-player (whatever is playing) stays on screen.
  useShell(view);
  useLayoutEffect(() => {
    setBackdrop(t.poster || t.albumPoster);
  }, []);
  const play = () => {
    music.playTracks([{ ...t, poster: t.poster || t.albumPoster }], 0);
    navigate('#/now-playing', { replace: true }); // the live page takes over: transport, synced lyrics, the queue
  };
  return html`<div class="np-main">
      <div class="np-side">
        <div class="np-cover"><${Art} src=${t.poster || t.albumPoster} title=${t.title} kind="square" eager=${true} /></div>
        <div class="np-text"><h1 class="np-title">${t.title}</h1><p class="np-sub muted">${sub(t)}</p></div>
      </div>
      <div class="np-lyrics">${r?.lines?.length ? plainLyrics(r.lines, ' ') : noLyrics}</div>
      <aside class="np-queue"></aside>
    </div>
    <div class="np-transport"><div class="np-buttons"><${Button} label="Play this song" icon="play" variant="primary" autofocus=${true} attrs=${{ class: 'btn btn-primary np-play-this' }} onClick=${play} /></div></div>`;
}

// ---- a book or a podcast episode ----

/**
 * Now Playing for a book or a podcast episode (v0.22): the cover, the title, who wrote or hosts it, the chapter; the
 * book's timeline with its chapters marked; large skip buttons, play, speed, the sleep timer and the chapters list.
 */
function SpokenFace({ view }) {
  useShell(view, { classes: ['is-spoken'], open: true });
  // The sleep label is read on change/state only (as before), so "N min left" can lag between them.
  const [t, playing, speed, sleep, total] = useNow((m) => [m.current, m.playing, m.speed, sleepLabel(m.sleep), m.bookDuration || 0], ['change', 'state'], isSpoken);
  const sp = t.spoken;
  const bookId = sp.bookId ?? t.id;
  const shown = useMemo(() => t, [bookId]); // the cover and names change with the book, not with its parts
  const [skips] = useState(() => [music.skipBack, music.skipForward]);
  useLayoutEffect(() => {
    setTitle(shown.spoken.title);
    setBackdrop(shown.poster);
  }, [bookId]);
  useLayoutEffect(() => {
    const onChange = () => {
      if (!music.current) return back();
      if (!music.spoken) return refreshView(); // a song now: the song layout
      return undefined;
    };
    music.events.addEventListener('change', onChange);
    music.events.addEventListener('state', onChange);
    return () => {
      music.events.removeEventListener('change', onChange);
      music.events.removeEventListener('state', onChange);
    };
  }, []);
  const openChapters = () => {
    const s = music.spoken;
    if (!s?.chapters?.length) return;
    const now = chapterAt(s.chapters, music.bookPosition)?.index;
    openSheet('Chapters', s.chapters.map((c, i) => ({ label: `${c.title || `Chapter ${i + 1}`} · ${formatClock(c.start)}`, icon: i === now ? 'play' : 'list', onSelect: () => music.seekBook(c.start) })));
  };
  const ticks = total ? (sp.chapters || []).slice(1).map((c) => html`<span class="np-tick" style=${{ left: `${(c.start / total) * 100}%` }} />`) : null;
  return html`<div class="np-main">
      <div class="np-side">
        <div class="np-cover"><${Art} key=${bookId} src=${shown.poster} title=${shown.spoken.title} kind="square" eager=${true} /></div>
        <div class="np-text"><h1 class="np-title">${shown.spoken.title}</h1><p class="np-sub muted">${shown.spoken.author || ''}</p><${ChapterLine} /></div>
      </div>
    </div>
    <div class="np-transport">
      <div class="np-buttons np-spoken-buttons">
        <${Button} label="" icon="rewind" variant="ghost" title=${`Back ${skips[0]} seconds`} attrs=${{ class: 'btn btn-ghost btn-icon np-skip' }} onClick=${() => music.skip(-music.skipBack)} />
        <button class="btn btn-primary btn-icon" type="button" onClick=${() => music.toggle()} data-autofocus="" title=${playing ? 'Pause' : 'Play'} aria-label=${playing ? 'Pause' : 'Play'}>${playIcon(playing)}</button>
        <${Button} label="" icon="skip" variant="ghost" title=${`Forward ${skips[1]} seconds`} attrs=${{ class: 'btn btn-ghost btn-icon np-skip' }} onClick=${() => music.skip(music.skipForward)} />
      </div>
      <div class="np-buttons np-spoken-more">
        <${Button} label=${`${speed}×`} variant="ghost" attrs=${{ class: 'btn btn-ghost np-speed', 'aria-label': `Speed ${speed}×` }} onClick=${() => openSpeed()} />
        <${Button} label="Sleep timer" icon="moon" variant="ghost" attrs=${{ class: 'btn btn-ghost np-sleep', 'aria-label': sleep }} onClick=${() => openSleep()} />
        <${Button} label="Chapters" icon="list" variant="ghost" attrs=${{ class: 'btn btn-ghost np-chapters', hidden: !(sp.chapters?.length > 1) }} onClick=${openChapters} />
      </div>
      <div class="np-seek">
        <${BookTime} />
        <div class="np-seek-wrap"><${BookSeek} /><div class="np-ticks" aria-hidden="true">${ticks}</div></div>
        <${BookLeft} />
      </div>
    </div>`;
}

/** Where the book is and its whole length, following the clock. */
const useBookClock = () => useNow((m) => [m.bookPosition, m.bookDuration || 0], ['time', 'change', 'state'], isSpoken);

function ChapterLine() {
  const title = useNow((m) => chapterAt(m.spoken.chapters, m.bookPosition)?.title || '', ['time', 'change', 'state'], isSpoken);
  return html`<p class="np-chapter">${title}</p>`;
}

function BookTime() {
  const [pos] = useBookClock();
  return html`<span class="np-time">${formatClock(pos)}</span>`;
}

function BookLeft() {
  const [pos, total] = useBookClock();
  return html`<span class="np-time">${total ? leftText(total - pos) : ''}</span>`;
}

/** The book's timeline: Left/Right skip by the profile's lengths, a drag seeks within the book. */
function BookSeek() {
  const [pos, total] = useBookClock();
  const seek = useRef(null);
  useLayoutEffect(() => {
    seek.current.value = '0';
  }, []);
  useLayoutEffect(() => {
    const s = seek.current;
    if (!total) return;
    s.max = String(Math.max(1, Math.round(total)));
    if (document.activeElement !== s) s.value = String(Math.round(pos));
    s.style.setProperty('--pct', `${Math.min(100, (pos / total) * 100)}%`);
    sliderText(s, `${formatClock(pos)} of ${formatClock(total)}`);
  });
  const onKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    music.skip(e.key === 'ArrowRight' ? music.skipForward : -music.skipBack);
  };
  return html`<input type="range" class="np-seek-range" min="0" max="1" step="1" aria-label="Seek" ref=${seek} onKeyDown=${onKey} onChange=${(e) => music.seekBook(Number(e.currentTarget.value))} />`;
}
