// Now Playing: the cover, the song, lyrics with the current line in the middle, the queue, and the transport.
// A bigger window onto the same `music` object the mini-player drives; made for a TV across the room.
import { h, icon, clear, formatClock } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack, updatePrefs, navigate } from '../app.js';
import { button, emptyState, art } from '../components.js';
import { music, trackList, openQueue } from '../music.js';
import { setBackdrop } from '../backdrop.js';

export async function render(el, params, query = {}) {
  el.classList.add('nowplaying-view');
  setTitle('Now playing');
  // ?song=<id>: another song's lyrics, read-only, with "Play this song"; the queue plays on (or stays stopped).
  if (query.song && Number(query.song) !== music.current?.id) return renderSong(el, Number(query.song));
  if (!music.current) {
    el.append(emptyState({ title: 'Nothing playing', text: 'Pick a song and it will show up here.', action: button('Back', { icon: 'back', autofocus: true, onClick: () => goBack('#/') }) }));
    return;
  }
  const cover = h('div', { class: 'np-cover' });
  const title = h('h1', { class: 'np-title' });
  const sub = h('p', { class: 'np-sub muted' });
  const lyricsEl = h('div', { class: 'np-lyrics' });
  const queueEl = h('aside', { class: 'np-queue' });
  const play = button('', { icon: 'pause', variant: 'primary', title: 'Pause', autofocus: true, onClick: () => music.toggle() });
  const shuffleBtn = button('', { icon: 'shuffle', variant: 'ghost', title: 'Shuffle', onClick: () => music.setShuffle(!music.shuffle) });
  const repeatBtn = button('', { icon: 'repeat', variant: 'ghost', title: 'Repeat', onClick: () => music.cycleRepeat() });
  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  // Left/Right on the bar seek 5 s (the native step would be a fraction of a second).
  seek.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    music.seek(Math.max(0, Math.min(music.duration || 0, music.position + (e.key === 'ArrowRight' ? 5 : -5))));
  });
  // Volume: Up/Down on the bar change it by 5%; it is kept in the profile's prefs.
  const volume = h('input', { type: 'range', class: 'np-volume', min: 0, max: 1, step: 0.05, value: String(music.volume), 'aria-label': 'Volume' });
  let saveVolume = null;
  const setVolume = (v) => {
    music.setVolume(v);
    volume.value = String(music.volume);
    clearTimeout(saveVolume);
    saveVolume = setTimeout(flushVolume, 800);
  };
  const flushVolume = () => {
    saveVolume = null;
    updatePrefs({ musicVolume: music.volume }).catch(() => {});
  };
  volume.addEventListener('input', () => setVolume(Number(volume.value)));
  volume.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    setVolume(Math.round((music.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100);
  });
  const cur = h('span', { class: 'np-time' }, '0:00');
  const left = h('span', { class: 'np-time' }, '-0:00');
  const transport = h(
    'div',
    { class: 'np-transport' },
    h(
      'div',
      { class: 'np-buttons' },
      shuffleBtn,
      button('', { icon: 'prev', variant: 'ghost', title: 'Previous', onClick: () => music.prev() }),
      play,
      button('', { icon: 'next', variant: 'ghost', title: 'Next', onClick: () => music.next() }),
      repeatBtn,
      h('span', { class: 'np-phone-only' }, button('Queue', { icon: 'queue', variant: 'ghost', onClick: () => openQueue() })),
      h('span', { class: 'np-volume-wrap' }, icon('volume', { size: 20 }), volume),
    ),
    h('div', { class: 'np-seek' }, cur, seek, left),
  );
  el.append(h('div', { class: 'np-main' }, h('div', { class: 'np-side' }, cover, h('div', { class: 'np-text' }, title, sub)), lyricsEl, queueEl), transport);

  let lines = [];
  let synced = false;
  let lineEls = [];
  let list = null;
  let userHold = 0;
  let token = 0;
  let loadedId = null;

  async function load() {
    const t = music.current;
    loadedId = t.id;
    const mine = ++token;
    clear(cover).append(art(t.poster || t.albumPoster, t.title, { kind: 'square', eager: true }));
    title.textContent = t.title;
    sub.textContent = [t.artist, t.albumTitle].filter(Boolean).join(' · ');
    setBackdrop(t.poster || t.albumPoster);
    clear(lyricsEl).append(h('p', { class: 'muted np-looking' }, 'Looking for lyrics…'));
    lines = [];
    lineEls = [];
    list = null;
    synced = false;
    const r = await api.get(`/api/items/${t.id}/lyrics`).catch(() => null);
    if (mine !== token) return;
    clear(lyricsEl);
    lines = r?.lines || [];
    synced = Boolean(r?.synced);
    if (!r) lyricsEl.append(h('p', { class: 'muted np-none' }, 'No lyrics for this song'));
    else if (!synced) lyricsEl.append(h('div', { class: 'lyrics-plain' }, lines.map((l) => h('p', {}, l.text || ' '))));
    else {
      list = h('ol', { class: 'lyrics-synced', role: 'list' });
      lines.forEach((l, i) => {
        const li = h('li', { class: 'lyric-line', tabindex: l.text ? '0' : '-1', dataset: { at: String(l.at), i: String(i) }, onClick: () => music.seek(l.at) }, l.text || ' ');
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            music.seek(l.at);
          }
        });
        // The remote walks the lines: the list moves to the focused line (the box itself never scrolls).
        li.addEventListener('focus', () => {
          userHold = Date.now() + 4000;
          requestAnimationFrame(() => {
            lyricsEl.scrollTop = 0;
            centre(li);
          });
        });
        lineEls.push(li);
        list.append(li);
      });
      lyricsEl.append(list);
      tick();
    }
    drawQueue();
  }
  function drawQueue() {
    clear(queueEl).append(h('h2', {}, 'Up next'), trackList(music.queue.items, { numbers: false, showAlbum: true }));
  }
  function tick() {
    const pos = music.position;
    const dur = music.duration || 0;
    cur.textContent = formatClock(pos);
    left.textContent = `-${formatClock(Math.max(0, dur - pos))}`;
    if (dur && document.activeElement !== seek) seek.value = String(Math.round((pos / dur) * 1000));
    if (!synced || !lineEls.length) return;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].at <= pos + 0.3) idx = i;
      else break;
    }
    lineEls.forEach((li, i) => li.classList.toggle('is-current', i === idx));
    if (idx >= 0 && Date.now() > userHold) centre(lineEls[idx]);
  }
  function centre(li) {
    if (!list) return;
    const offset = li.offsetTop + li.offsetHeight / 2 - lyricsEl.clientHeight / 2;
    list.style.transform = `translateY(${-Math.max(0, offset)}px)`;
  }
  function drawState() {
    if (document.activeElement !== volume) volume.value = String(music.volume);
    clear(play).append(icon(music.playing ? 'pause' : 'play', { size: 22 }));
    play.title = music.playing ? 'Pause' : 'Play';
    shuffleBtn.setAttribute('aria-pressed', String(Boolean(music.shuffle)));
    repeatBtn.setAttribute('aria-pressed', String(music.repeat !== 'off'));
  }
  seek.addEventListener('input', () => music.seek((Number(seek.value) / 1000) * (music.duration || 0)));
  const onTime = () => tick();
  const onState = () => drawState();
  const onChange = () => {
    if (!music.current) {
      goBack('#/');
      return;
    }
    drawState();
    // Shuffle, repeat, a seek on a converted stream and queue edits all fire `change`: only a new song reloads the lyrics.
    if (music.current.id !== loadedId) load();
    else drawQueue();
  };
  const onKey = (e) => {
    // Escape leaves, as Back and Backspace do.
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      goBack('#/');
      return;
    }
    if (e.defaultPrevented || e.target.closest?.('dialog, button, a, input, textarea, select')) return;
    if (e.key === ' ') {
      e.preventDefault();
      music.toggle();
    }
  };
  music.events.addEventListener('time', onTime);
  music.events.addEventListener('state', onState);
  music.events.addEventListener('change', onChange);
  window.addEventListener('keydown', onKey);
  lyricsEl.addEventListener('wheel', () => (userHold = Date.now() + 4000), { passive: true });
  lyricsEl.addEventListener('scroll', () => { lyricsEl.scrollTop = 0; }); // focus() may scroll the box; the transform does the moving
  drawState();
  drawQueue();
  document.documentElement.classList.add('nowplaying-open');
  load(); // not awaited: the page is usable while a slow lyrics service answers
  return () => {
    music.events.removeEventListener('time', onTime);
    music.events.removeEventListener('state', onState);
    music.events.removeEventListener('change', onChange);
    window.removeEventListener('keydown', onKey);
    if (saveVolume) {
      clearTimeout(saveVolume);
      flushVolume(); // leaving straight after a change still keeps it
    }
    document.documentElement.classList.remove('nowplaying-open');
  };
}

/** A song's lyrics without playing it: cover, title, the lines, and a Play this song button. */
async function renderSong(el, id) {
  const d = await api.get(`/api/items/${id}`).catch(() => null);
  const t = d?.item;
  if (!t || t.kind !== 'track') {
    el.append(emptyState({ title: 'No such song', text: '', action: button('Back', { icon: 'back', autofocus: true, onClick: () => goBack('#/') }) }));
    return;
  }
  setTitle(t.title);
  const lyricsEl = h('div', { class: 'np-lyrics' }, h('p', { class: 'muted np-looking' }, 'Looking for lyrics…'));
  const play = button('Play this song', { icon: 'play', variant: 'primary', autofocus: true, attrs: { class: 'btn btn-primary np-play-this' }, onClick: () => {
    music.playTracks([{ ...t, poster: t.poster || t.albumPoster }], 0);
    navigate('#/now-playing', { replace: true }); // the live page takes over: transport, synced lyrics, the queue
  } });
  el.append(
    h(
      'div',
      { class: 'np-main' },
      h('div', { class: 'np-side' }, h('div', { class: 'np-cover' }, art(t.poster || t.albumPoster, t.title, { kind: 'square', eager: true })), h('div', { class: 'np-text' }, h('h1', { class: 'np-title' }, t.title), h('p', { class: 'np-sub muted' }, [t.artist, t.albumTitle].filter(Boolean).join(' · ')))),
      lyricsEl,
      h('aside', { class: 'np-queue' }),
    ),
    h('div', { class: 'np-transport' }, h('div', { class: 'np-buttons' }, play)),
  );
  setBackdrop(t.poster || t.albumPoster);
  const r = await api.get(`/api/items/${id}/lyrics`).catch(() => null);
  clear(lyricsEl);
  if (!r?.lines?.length) lyricsEl.append(h('p', { class: 'muted np-none' }, 'No lyrics for this song'));
  else lyricsEl.append(h('div', { class: 'lyrics-plain' }, r.lines.map((l) => h('p', {}, l.text || ' '))));
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      goBack('#/');
    }
  };
  window.addEventListener('keydown', onKey);
  // Song mode is a page about a song, not the player: the mini-player (whatever is playing) stays on screen.
  return () => window.removeEventListener('keydown', onKey);
}
