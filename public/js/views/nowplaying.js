// Now Playing: the cover, the song, lyrics with the current line in the middle, the queue, and the transport.
// A bigger window onto the same `music` object the mini-player drives; made for a TV across the room.
import { ratingControl } from '../rating.js';
import { h, icon, clear, formatClock } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack, updatePrefs, navigate, refreshView } from '../app.js';
import { button, emptyState, art, sliderText, percentSlider } from '../components.js';
import { music, trackList, openQueue, openSpeed, openSleep } from '../music.js';
import { chapterAt, leftText } from '../spoken-time.js';
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
  if (music.spoken) return renderSpoken(el);
  const cover = h('div', { class: 'np-cover' });
  const title = h('h1', { class: 'np-title' });
  const sub = h('p', { class: 'np-sub muted' });
  const rateSlot = h('div', { class: 'np-rate' }); // the playing song's stars and heart
  const lyricsEl = h('div', { class: 'np-lyrics' });
  const queueEl = h('aside', { class: 'np-queue' });
  const play = button('', { icon: 'pause', variant: 'primary', title: 'Pause', autofocus: true, onClick: () => music.toggle() });
  const shuffleBtn = button('', { icon: 'shuffle', variant: 'ghost', title: 'Shuffle', onClick: () => music.setShuffle(!music.shuffle) });
  const repeatBtn = button('', { icon: 'repeat', variant: 'ghost', title: 'Repeat', onClick: () => music.cycleRepeat() });
  // In seconds, so the value a screen reader reads is a time; the spoken text says "1:12 of 3:40".
  const seek = h('input', { type: 'range', class: 'np-seek-range', min: '0', max: '1', step: '1', value: '0', 'aria-label': 'Seek' });
  // Left/Right on the bar seek 5 s (the native step would be a fraction of a second).
  seek.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const to = Math.max(0, Math.min(music.duration || 0, music.position + (e.key === 'ArrowRight' ? 5 : -5)));
    music.seek(to);
    seek.value = String(Math.round(to));
    sliderText(seek, `${formatClock(to)} of ${formatClock(music.duration || 0)}`, { force: true });
  });
  // Volume: Up/Down on the bar change it by 5%; it is kept in the profile's prefs.
  const volume = percentSlider(h('input', { type: 'range', class: 'np-volume', min: 0, max: 1, step: 0.05, value: String(music.volume), 'aria-label': 'Volume' }));
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
  const liveEl = h('span', { class: 'np-live', hidden: true }, 'Live');
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
    h('div', { class: 'np-seek' }, liveEl, cur, seek, left),
  );
  el.append(h('div', { class: 'np-main' }, h('div', { class: 'np-side' }, cover, h('div', { class: 'np-text' }, title, sub, rateSlot)), lyricsEl, queueEl), transport);

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
    rateSlot.replaceChildren(t.live ? '' : ratingControl(t));
    setBackdrop(t.poster || t.albumPoster);
    lines = [];
    lineEls = [];
    list = null;
    synced = false;
    // A radio station: the programme and the station, "Live" for the bar, no lyrics.
    el.classList.toggle('is-live', Boolean(t.live));
    liveEl.hidden = !t.live;
    shuffleBtn.disabled = repeatBtn.disabled = Boolean(t.live);
    if (t.live) {
      clear(lyricsEl);
      return;
    }
    clear(lyricsEl).append(h('p', { class: 'muted np-looking' }, 'Looking for lyrics…'));
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
        // A real button (Enter and Space, announced as one) inside a plain list item; an empty line is just a gap.
        const li = l.text
          ? h('button', { type: 'button', class: 'lyric-line', 'aria-label': `Jump to: ${l.text}`, dataset: { at: String(l.at), i: String(i) }, onClick: () => music.seek(l.at) }, l.text)
          : h('span', { class: 'lyric-line', dataset: { at: String(l.at), i: String(i) } }, '\u00a0');
        // The remote walks the lines: the list moves to the focused line (the box itself never scrolls).
        li.addEventListener('focus', () => {
          userHold = Date.now() + 4000;
          requestAnimationFrame(() => {
            lyricsEl.scrollTop = 0;
            centre(li);
          });
        });
        lineEls.push(li);
        list.append(h('li', {}, li));
      });
      lyricsEl.append(list);
      tick();
    }
    drawQueue();
  }
  function drawQueue() {
    const upcoming = music.queue.items.slice(music.queue.index + 1);
    clear(queueEl).append(h('h2', {}, 'Queue'), upcoming.length ? trackList(upcoming, { numbers: false, showAlbum: true, queueOffset: music.queue.index + 1 }) : h('p', { class: 'muted' }, 'Nothing more queued.'));
  }
  function tick() {
    const pos = music.position;
    const dur = music.duration || 0;
    cur.textContent = formatClock(pos);
    left.textContent = `-${formatClock(Math.max(0, dur - pos))}`;
    if (dur) {
      seek.max = String(Math.max(1, Math.round(dur)));
      if (document.activeElement !== seek) seek.value = String(Math.round(pos));
      seek.style.setProperty('--pct', `${Math.min(100, (pos / dur) * 100)}%`);
      sliderText(seek, `${formatClock(pos)} of ${formatClock(dur)}`);
    }
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
    play.setAttribute('aria-label', play.title); // the name is what a screen reader says, not the tooltip
    shuffleBtn.setAttribute('aria-pressed', String(Boolean(music.shuffle)));
    repeatBtn.setAttribute('aria-pressed', String(music.repeat !== 'off'));
    repeatBtn.setAttribute('aria-label', `Repeat: ${music.repeat || 'off'}`);
    tick(); // paused (or not started yet): the bar and its spoken time still match the song
  }
  seek.addEventListener('input', () => {
    music.seek(Number(seek.value));
    sliderText(seek, `${formatClock(Number(seek.value))} of ${formatClock(music.duration || 0)}`, { force: true });
  });
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
    else if (music.current.live) title.textContent = music.current.title; // the station's programme changed
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

/**
 * Now Playing for a book or a podcast episode (v0.22): the cover, the title, who wrote or hosts it, the chapter; the
 * book's timeline with its chapters marked; large skip buttons, play, speed, the sleep timer and the chapters list.
 */
function renderSpoken(el) {
  el.classList.add('is-spoken');
  const cover = h('div', { class: 'np-cover' });
  const title = h('h1', { class: 'np-title' });
  const sub = h('p', { class: 'np-sub muted' });
  const chapterEl = h('p', { class: 'np-chapter' });
  const seek = h('input', { type: 'range', class: 'np-seek-range', min: '0', max: '1', step: '1', value: '0', 'aria-label': 'Seek' });
  const ticks = h('div', { class: 'np-ticks', 'aria-hidden': 'true' });
  const cur = h('span', { class: 'np-time' }, '0:00');
  const left = h('span', { class: 'np-time' }, '');
  const play = button('', { icon: 'pause', variant: 'primary', title: 'Pause', autofocus: true, onClick: () => music.toggle() });
  const back = button('', { icon: 'rewind', variant: 'ghost', title: `Back ${music.skipBack} seconds`, attrs: { class: 'btn btn-ghost btn-icon np-skip' }, onClick: () => music.skip(-music.skipBack) });
  const fwd = button('', { icon: 'skip', variant: 'ghost', title: `Forward ${music.skipForward} seconds`, attrs: { class: 'btn btn-ghost btn-icon np-skip' }, onClick: () => music.skip(music.skipForward) });
  const speed = button(`${music.speed}×`, { variant: 'ghost', attrs: { class: 'btn btn-ghost np-speed', 'aria-label': `Speed ${music.speed}×` }, onClick: () => openSpeed() });
  const sleepBtn = button('Sleep timer', { icon: 'moon', variant: 'ghost', attrs: { class: 'btn btn-ghost np-sleep' }, onClick: () => openSleep() });
  const chaptersBtn = button('Chapters', { icon: 'list', variant: 'ghost', attrs: { class: 'btn btn-ghost np-chapters' }, onClick: () => openChapters() });
  seek.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    music.skip(e.key === 'ArrowRight' ? music.skipForward : -music.skipBack);
  });
  seek.addEventListener('change', () => music.seekBook(Number(seek.value)));
  el.append(
    h('div', { class: 'np-main' }, h('div', { class: 'np-side' }, cover, h('div', { class: 'np-text' }, title, sub, chapterEl))),
    h(
      'div',
      { class: 'np-transport' },
      h('div', { class: 'np-buttons np-spoken-buttons' }, back, play, fwd),
      h('div', { class: 'np-buttons np-spoken-more' }, speed, sleepBtn, chaptersBtn),
      h('div', { class: 'np-seek' }, cur, h('div', { class: 'np-seek-wrap' }, seek, ticks), left),
    ),
  );
  let shownId = null;
  function draw() {
    const t = music.current;
    if (!t?.spoken) return;
    const sp = t.spoken;
    if (shownId !== (sp.bookId ?? t.id)) {
      shownId = sp.bookId ?? t.id;
      clear(cover).append(art(t.poster, sp.title, { kind: 'square', eager: true }));
      title.textContent = sp.title;
      sub.textContent = sp.author || '';
      setTitle(sp.title);
      setBackdrop(t.poster);
    }
    const total = music.bookDuration || 0;
    clear(ticks).append(...(total ? (sp.chapters || []).slice(1).map((c) => h('span', { class: 'np-tick', style: { left: `${(c.start / total) * 100}%` } })) : []));
    chaptersBtn.hidden = !(sp.chapters?.length > 1);
    speed.querySelector('span').textContent = `${music.speed}×`;
    speed.setAttribute('aria-label', `Speed ${music.speed}×`);
    const m = music.sleep.mode;
    sleepBtn.setAttribute('aria-label', m ? `Sleep timer: ${m === 'chapter' ? 'end of chapter' : `${Math.ceil((music.sleep.remaining || 0) / 60000)} min left`}` : 'Sleep timer');
    tick();
  }
  function tick() {
    const pos = music.bookPosition;
    const total = music.bookDuration || 0;
    cur.textContent = formatClock(pos);
    left.textContent = total ? leftText(total - pos) : '';
    chapterEl.textContent = chapterAt(music.spoken?.chapters, pos)?.title || '';
    if (total) {
      seek.max = String(Math.max(1, Math.round(total)));
      if (document.activeElement !== seek) seek.value = String(Math.round(pos));
      seek.style.setProperty('--pct', `${Math.min(100, (pos / total) * 100)}%`);
      sliderText(seek, `${formatClock(pos)} of ${formatClock(total)}`);
    }
    clear(play).append(icon(music.playing ? 'pause' : 'play', { size: 22 }));
    play.setAttribute('aria-label', music.playing ? 'Pause' : 'Play');
    play.title = play.getAttribute('aria-label');
  }
  function openChapters() {
    const sp = music.spoken;
    if (!sp?.chapters?.length) return;
    const now = chapterAt(sp.chapters, music.bookPosition)?.index;
    import('../components.js').then(({ openSheet }) =>
      openSheet('Chapters', sp.chapters.map((c, i) => ({ label: `${c.title || `Chapter ${i + 1}`} · ${formatClock(c.start)}`, icon: i === now ? 'play' : 'list', onSelect: () => music.seekBook(c.start) }))),
    );
  }
  const onChange = () => {
    if (!music.current) return goBack('#/');
    if (!music.spoken) return refreshView(); // a song now: the song layout
    draw();
  };
  const onTime = () => tick();
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      goBack('#/');
    }
  };
  music.events.addEventListener('change', onChange);
  music.events.addEventListener('state', onChange);
  music.events.addEventListener('time', onTime);
  window.addEventListener('keydown', onKey);
  document.documentElement.classList.add('nowplaying-open');
  draw();
  return () => {
    music.events.removeEventListener('change', onChange);
    music.events.removeEventListener('state', onChange);
    music.events.removeEventListener('time', onTime);
    window.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('nowplaying-open');
  };
}
