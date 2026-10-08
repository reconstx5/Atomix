// Music player: one <audio> element that lives outside the page views, so
// songs keep playing while you browse. Shows a mini-player bar, keeps an
// "up next" queue, and hooks into the system media controls (lock screen,
// keyboard media keys, headphones) through the Media Session API.
import { api } from './api.js';
import { h, icon, clear, formatClock } from './dom.js';
import { Queue } from './queue.js';
import { addToPlaylistItems } from './lists.js';
import { detectCaps } from './caps.js';
import { markPlaying as gatePlaying } from './gate.js';
import { art, toast, openDialog, openSheet } from './components.js';
import { VOLUME_KEY, musicKey } from './storage.js';

const PING_EVERY = 30000; // the server drops sessions it hasn't heard from in 2 minutes
const SAVE_EVERY = 5000;

let queue = new Queue();
let profileId = null;
let session = null; // playback response for the current song
let offset = 0; // converted streams start at `offset` seconds
let duration = 0;
let loadToken = 0;
let retried = false;
let failures = 0;
let seekTarget = null;
let pendingSeek = null;
let resumeAt = 0; // position to continue from after a page reload
let pausedAt = 0;
let suspended = false; // a video is playing
let switching = false; // between songs: ignore the pause that comes with swapping sources
let lastSave = 0;

const events = new EventTarget();
const emit = (type) => events.dispatchEvent(new Event(type));

const audio = h('audio', { preload: 'auto' });

// ---- Public API ----
export const music = {
  events,
  get queue() {
    return queue;
  },
  get current() {
    return queue.current;
  },
  get playing() {
    return !audio.paused;
  },
  /** Where the song is, in seconds, and how long it is (for the Now Playing page). */
  get position() {
    return currentTime();
  },
  get duration() {
    return totalDuration();
  },
  get shuffle() {
    return queue.shuffle;
  },
  /** 0–1 (Now Playing's slider and the mini-player's share it). */
  get volume() {
    return audio.muted ? 0 : audio.volume;
  },
  setVolume(v) {
    audio.volume = Math.max(0, Math.min(1, Number(v) || 0));
    audio.muted = audio.volume === 0;
  },
  get repeat() {
    return queue.repeat;
  },

  /** Play a list of songs. `start` = index to begin at, or -1 with shuffle for a random start. */
  playTracks(tracks, start = 0, { shuffle = false } = {}) {
    const list = slimAll(tracks);
    if (!list.length) return;
    queue.set(list, shuffle && start < 0 ? -1 : Math.max(0, start), { shuffle });
    retried = false;
    failures = 0;
    load(0);
  },

  playNext(tracks) {
    const list = slimAll(tracks);
    if (!list.length) return;
    const wasEmpty = !queue.current;
    queue.playNext(list);
    changed();
    if (wasEmpty) load(0);
    else toast(list.length === 1 ? `“${list[0].title}” plays next` : `${list.length} songs play next`);
  },

  addToQueue(tracks) {
    const list = slimAll(tracks);
    if (!list.length) return;
    const wasEmpty = !queue.current;
    queue.add(list);
    changed();
    if (wasEmpty) load(0);
    else toast(list.length === 1 ? `Added “${list[0].title}” to the queue` : `Added ${list.length} songs to the queue`);
  },

  toggle() {
    if (audio.paused) this.play();
    else this.pause();
  },

  play() {
    if (!queue.current || suspended) return;
    const stale = session && session.mode !== 'direct' && pausedAt && Date.now() - pausedAt > 90000;
    if (!session || stale) {
      // Nothing loaded yet (e.g. after a reload), or a converted stream the server has since dropped.
      load(stale ? currentTime() : resumeAt);
      return;
    }
    audio.play().catch(() => {});
  },

  pause() {
    audio.pause();
  },

  next() {
    const t = queue.next();
    if (t) {
      retried = false;
      load(0);
    }
  },

  prev() {
    const { track, restart } = queue.prev(currentTime());
    if (!track) return;
    if (restart) this.seek(0);
    else {
      retried = false;
      load(0);
    }
  },

  jump(i) {
    if (queue.jump(i)) {
      retried = false;
      load(0);
    }
  },

  remove(i) {
    const wasCurrent = queue.remove(i);
    if (!queue.current) return this.stop();
    if (wasCurrent) load(0, { autoplay: !audio.paused });
    else changed();
  },

  move(from, to) {
    queue.move(from, to);
    changed();
  },

  seek(t) {
    if (!queue.current) return;
    const total = totalDuration();
    t = Math.max(0, total ? Math.min(t, total - 0.5) : t);
    if (!session) {
      resumeAt = t;
      updateTime();
      return;
    }
    if (session.mode === 'direct') {
      audio.currentTime = t;
      return;
    }
    // Converted streams restart from the new spot; debounced so a drag only restarts once.
    seekTarget = t;
    updateTime();
    clearTimeout(pendingSeek);
    pendingSeek = setTimeout(() => load(t, { autoplay: !audio.paused || audio.readyState < 2 }), 350);
  },

  setShuffle(on) {
    queue.setShuffle(on);
    changed();
  },

  cycleRepeat() {
    queue.cycleRepeat();
    changed();
  },

  /** Stop and clear everything. */
  stop() {
    loadToken++;
    stopSession();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    queue.clear();
    resumeAt = 0;
    save(true);
    changed();
  },

  /** A video is about to play: pause the music and let the video own the media keys. */
  suspend() {
    suspended = true;
    audio.pause();
    clearMediaSession();
  },

  resume() {
    if (!suspended) return;
    suspended = false;
    updateMediaSession();
  },

  /** Signed in as someone else, or switched profile: load that profile's queue. */
  setProfile(profile) {
    const id = profile?.id ?? null;
    if (id === profileId) return;
    if (queue.current) save(true);
    loadToken++;
    stopSession();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    profileId = id;
    // The profile's own music volume, when it has set one on Now Playing; otherwise this device's remembered one.
    // A profile's volume is not written over the device's: the next profile without one gets the device's back.
    let remembered = null;
    try {
      remembered = localStorage.getItem(VOLUME_KEY);
    } catch {
      /* private mode */
    }
    const target = profile?.prefs?.musicVolume != null ? profile.prefs.musicVolume : id != null ? (remembered !== null && Number(remembered) >= 0 && Number(remembered) <= 1 ? Number(remembered) : 1) : null;
    if (target != null && target !== audio.volume) {
      fromPref = target; // the volumechange event comes later: that one is not the device's to remember
      this.setVolume(target);
    }
    queue = new Queue();
    resumeAt = 0;
    if (id != null) restore();
    changed();
    if (queue.current) updateMediaSession(); // so the lock screen / media keys can resume it
  },
};

// ---- Loading songs ----
function slim(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist || null,
    albumTitle: t.albumTitle || null,
    albumId: t.kind === 'track' || t.albumTitle ? t.parentId : null,
    artistId: t.showId || null,
    poster: t.poster || t.albumPoster || null,
    duration: t.duration || null,
  };
}
const slimAll = (tracks) => (Array.isArray(tracks) ? tracks : [tracks]).filter((t) => t && t.id != null).map(slim);

const currentTime = () => (seekTarget != null ? seekTarget : !session ? resumeAt : (session.mode === 'direct' ? 0 : offset) + (audio.currentTime || 0));
const totalDuration = () => duration || queue.current?.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);

async function load(start = 0, { autoplay = true, forceTranscode = false } = {}) {
  const track = queue.current;
  const token = ++loadToken;
  clearTimeout(pendingSeek);
  if (!track) return;
  const replaces = session?.sessionId;
  const sameSong = session && session.item?.id === track.id;
  session = null;
  seekTarget = null;
  resumeAt = start;
  if (!sameSong) duration = track.duration || 0;
  switching = autoplay && !suspended;
  if (!audio.paused) audio.pause(); // don't let the old song carry on while the new one loads
  changed();
  setBusy(switching);
  let res;
  try {
    res = await api.post(`/api/items/${track.id}/playback`, { caps: detectCaps(), start, replaces, forceTranscode });
  } catch (err) {
    if (token !== loadToken) return;
    switching = false;
    setBusy(false);
    updateState();
    skipAfterError(`Can't play “${track.title}”: ${err.message}`);
    return;
  }
  if (token !== loadToken) {
    api.post(`/api/playback/${res.sessionId}/stop`, {}).catch(() => {});
    return;
  }
  session = res;
  resumeAt = 0;
  offset = res.mode === 'direct' ? 0 : res.start || 0;
  duration = res.duration || track.duration || 0;
  audio.src = res.url;
  if (res.mode === 'direct' && start > 0) {
    audio.addEventListener('loadedmetadata', () => token === loadToken && (audio.currentTime = start), { once: true });
  }
  if (autoplay && !suspended) {
    audio
      .play()
      .catch(() => {
        // Autoplay was blocked (or a newer load took over): show it as paused.
      })
      .finally(() => {
        if (token !== loadToken) return;
        switching = false;
        if (audio.paused) setBusy(false);
        updateState();
      });
  } else {
    switching = false;
    setBusy(false);
    updateState();
  }
  updateMediaSession();
  updateTime();
  save(true);
}

function skipAfterError(message) {
  toast(message, { type: 'error' });
  failures++;
  if (failures >= 3) {
    failures = 0;
    audio.pause();
    updateState();
    return;
  }
  setTimeout(() => {
    if (queue.next()) {
      retried = false;
      load(0);
    }
  }, 800);
}

function stopSession() {
  if (session) api.post(`/api/playback/${session.sessionId}/stop`, {}, { keepalive: true }).catch(() => {});
  session = null;
}

audio.addEventListener('ended', () => {
  const track = queue.current;
  if (track && session) {
    // Counts as played (and lets plugins such as scrobblers hear about it).
    api.post(`/api/items/${track.id}/progress`, { position: totalDuration(), duration: totalDuration(), sessionId: session.sessionId }, { keepalive: true }).catch(() => {});
  }
  failures = 0;
  const next = queue.next({ auto: true });
  if (!next) {
    // End of the queue: go back to the first song, paused, ready to play again.
    stopSession();
    queue.jump(0);
    resumeAt = 0;
    duration = queue.current?.duration || 0;
    changed();
    return;
  }
  retried = false;
  if (next === track && session?.mode === 'direct') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } else load(0);
});

audio.addEventListener('error', () => {
  if (!audio.getAttribute('src') || !session) return;
  if (!retried && session.mode !== 'transcode') {
    // The browser couldn't decode the original; ask the server to convert it.
    retried = true;
    load(currentTime(), { forceTranscode: true });
    return;
  }
  const track = queue.current;
  stopSession();
  setBusy(false);
  skipAfterError(`Couldn't play “${track?.title || 'this song'}”.`);
});

audio.addEventListener('play', () => {
  failures = 0;
  pausedAt = 0;
  gatePlaying(true); // music playing counts as being there (gate.js)
  updateState();
});

audio.addEventListener('pause', () => {
  if (switching) return;
  pausedAt = Date.now();
  updateState();
  ping();
  save(true);
});
audio.addEventListener('waiting', () => setBusy(true));
audio.addEventListener('playing', () => setBusy(false));
audio.addEventListener('canplay', () => setBusy(false));
audio.addEventListener('timeupdate', () => {
  updateTime();
  emit('time');
  if (Date.now() - lastSave > SAVE_EVERY) save();
});
audio.addEventListener('loadedmetadata', updateTime);

// Remember the volume (shared with the video player).
try {
  const v = localStorage.getItem(VOLUME_KEY);
  if (v !== null && Number(v) >= 0 && Number(v) <= 1) audio.volume = Number(v);
} catch {
  /* private mode */
}
let fromPref = null; // a profile's saved volume being applied: that change is not the device's to remember
audio.addEventListener('volumechange', () => {
  if (fromPref !== null && Math.abs(audio.volume - fromPref) < 1e-6) {
    fromPref = null;
    return;
  }
  fromPref = null;
  try {
    localStorage.setItem(VOLUME_KEY, String(audio.volume));
  } catch {
    /* ignore */
  }
  updateVolume();
});

function ping() {
  if (!session) return;
  api.post(`/api/playback/${session.sessionId}/ping`, { position: currentTime(), paused: audio.paused }).catch(() => {});
}
setInterval(ping, PING_EVERY);
window.addEventListener('pagehide', () => {
  save(true);
  if (session) {
    resumeAt = currentTime();
    stopSession();
  }
});

// ---- Saving the queue between visits ----
const storageKey = () => musicKey(profileId);

function save(force = false) {
  if (profileId == null) return;
  if (!force && Date.now() - lastSave < SAVE_EVERY) return;
  lastSave = Date.now();
  try {
    if (!queue.current) localStorage.removeItem(storageKey());
    else localStorage.setItem(storageKey(), JSON.stringify({ queue: queue.toJSON(), position: currentTime() }));
  } catch {
    /* storage full or blocked — not important */
  }
}

function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    if (!data?.queue) return;
    queue = Queue.fromJSON(data.queue);
    resumeAt = Math.max(0, Number(data.position) || 0);
    duration = queue.current?.duration || 0;
  } catch {
    queue = new Queue();
  }
}

// ---- System media controls ----
const MS_ACTIONS = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'];

function updateMediaSession() {
  if (!('mediaSession' in navigator) || suspended) return;
  const ms = navigator.mediaSession;
  const t = queue.current;
  if (!t) return clearMediaSession();
  try {
    ms.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || '',
      album: t.albumTitle || '',
      artwork: t.poster ? [{ src: new URL(t.poster, location.href).href }] : [],
    });
  } catch {
    /* older browsers */
  }
  const handlers = {
    play: () => music.play(),
    pause: () => music.pause(),
    stop: () => music.stop(),
    previoustrack: () => music.prev(),
    nexttrack: () => music.next(),
    seekto: (d) => music.seek(d.seekTime),
    seekbackward: (d) => music.seek(currentTime() - (d.seekOffset || 10)),
    seekforward: (d) => music.seek(currentTime() + (d.seekOffset || 10)),
  };
  for (const a of MS_ACTIONS) {
    try {
      ms.setActionHandler(a, handlers[a]);
    } catch {
      /* action not supported here */
    }
  }
  ms.playbackState = audio.paused ? 'paused' : 'playing';
}

function clearMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.metadata = null;
  ms.playbackState = 'none';
  for (const a of MS_ACTIONS) {
    try {
      ms.setActionHandler(a, null);
    } catch {
      /* ignore */
    }
  }
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || suspended || !navigator.mediaSession.setPositionState) return;
  const total = totalDuration();
  if (!total) return;
  try {
    navigator.mediaSession.setPositionState({ duration: total, playbackRate: 1, position: Math.min(currentTime(), total) });
  } catch {
    /* ignore */
  }
}

// ---- Mini-player bar ----
const ctl = (name, label, onClick, extra = {}) => h('button', { class: 'mbtn', type: 'button', 'aria-label': label, title: label, onClick, ...extra }, icon(name, { size: 22 }));

const artLink = h('a', { class: 'mini-art', href: '#/', tabindex: '-1', 'aria-hidden': 'true' });
const titleEl = h('a', { class: 'mini-title', href: '#/' });
const subEl = h('div', { class: 'mini-sub' });
const shuffleBtn = ctl('shuffle', 'Shuffle', () => music.setShuffle(!queue.shuffle), { 'aria-pressed': 'false', class: 'mbtn mini-extra' });
const prevBtn = ctl('prev', 'Previous', () => music.prev(), { class: 'mbtn mini-prev' });
const playBtn = ctl('play', 'Play', () => music.toggle(), { class: 'mbtn mbtn-play' });
const nextBtn = ctl('next', 'Next', () => music.next());
const repeatBtn = ctl('repeat', 'Repeat: off', () => music.cycleRepeat(), { 'aria-pressed': 'false', class: 'mbtn mini-extra' });
const seek = h('input', { type: 'range', class: 'mini-seek-range', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Seek' });
const timeCur = h('span', { class: 'mini-time' }, '0:00');
const timeEnd = h('span', { class: 'mini-time' }, '0:00');
const line = h('span');
const queueBtn = ctl('queue', 'Up next', () => openQueue());
const muteBtn = ctl('volume', 'Mute', () => (audio.muted = !audio.muted), { class: 'mbtn mini-extra' });
const volume = h('input', { type: 'range', class: 'mini-volume mini-extra', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
const closeBtn = ctl('close', 'Stop and clear the queue', () => music.stop(), { class: 'mbtn mini-extra' });

export const miniPlayer = h(
  'section',
  { class: 'mini', 'aria-label': 'Music player', hidden: true },
  h('div', { class: 'mini-line', 'aria-hidden': 'true' }, line),
  h('div', { class: 'mini-now' }, artLink, h('div', { class: 'mini-text' }, titleEl, subEl)),
  h(
    'div',
    { class: 'mini-center' },
    h('div', { class: 'mini-buttons' }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
    h('div', { class: 'mini-seek' }, timeCur, seek, timeEnd),
  ),
  h('div', { class: 'mini-side' }, queueBtn, muteBtn, volume, closeBtn),
  audio,
);

let scrubbing = false;
seek.addEventListener('input', () => {
  scrubbing = true;
  timeCur.textContent = formatClock(Number(seek.value));
  paintSeek(Number(seek.value));
});
seek.addEventListener('change', () => {
  scrubbing = false;
  music.seek(Number(seek.value));
});
// Arrow keys (and TV remotes) jump 10 seconds rather than the slider's 1-second step.
seek.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -10, ArrowRight: 10 }[e.key];
  if (!step) return;
  e.preventDefault();
  music.seek(currentTime() + step);
});
volume.addEventListener('input', () => {
  audio.volume = Number(volume.value);
  audio.muted = audio.volume === 0;
});

function paintSeek(now) {
  const total = totalDuration();
  const pct = total ? `${Math.min(100, (now / total) * 100)}%` : '0%';
  seek.style.setProperty('--pct', pct);
  line.style.width = pct;
}

function updateTime() {
  const total = totalDuration();
  const now = currentTime();
  if (!scrubbing) {
    seek.max = String(Math.max(1, Math.floor(total)));
    seek.value = String(Math.floor(now));
    timeCur.textContent = formatClock(now);
    paintSeek(now);
  }
  timeEnd.textContent = total ? formatClock(total) : '';
  seek.setAttribute('aria-valuetext', `${formatClock(now)} of ${formatClock(total)}`);
  updatePositionState();
}

function setBusy(on) {
  miniPlayer.classList.toggle('is-busy', Boolean(on));
}

function updateState() {
  const paused = audio.paused && !switching;
  clear(playBtn).append(icon(paused ? 'play' : 'pause', { size: 24 }));
  playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  playBtn.title = paused ? 'Play' : 'Pause';
  if (paused) miniPlayer.classList.remove('is-busy');
  if ('mediaSession' in navigator && !suspended && queue.current) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
  markPlaying();
  emit('state');
}

function updateVolume() {
  clear(muteBtn).append(icon(audio.muted || audio.volume === 0 ? 'mute' : 'volume', { size: 22 }));
  volume.value = String(audio.muted ? 0 : audio.volume);
}

const REPEAT_LABEL = { off: 'Repeat: off', all: 'Repeat: all songs', one: 'Repeat: this song' };

/** Something about the queue changed: redraw the bar. */
function changed() {
  const t = queue.current;
  miniPlayer.hidden = !t;
  document.documentElement.classList.toggle('has-mini', Boolean(t));
  if (t) {
    artLink.href = '#/now-playing'; // the cover and the title open Now Playing
    const artKey = `${t.poster}|${t.albumTitle || t.title}`;
    if (artLink.dataset.key !== artKey) {
      // Only redraw the cover when it changes, so it doesn't flicker on every button press.
      artLink.dataset.key = artKey;
      miniPlayer.style.setProperty('--mini-art', t.poster ? `url("${t.poster.replace(/["\\]/g, '')}")` : 'none');
      clear(artLink).append(art(t.poster, t.albumTitle || t.title, { kind: 'square', eager: true }));
    }
    titleEl.href = '#/now-playing';
    titleEl.textContent = t.title;
    titleEl.title = t.title;
    const sub = [t.artist, t.albumTitle].filter(Boolean).join(' · ');
    subEl.textContent = sub;
    subEl.title = sub;
  } else {
    clearMediaSession();
  }
  shuffleBtn.setAttribute('aria-pressed', String(queue.shuffle));
  repeatBtn.setAttribute('aria-pressed', String(queue.repeat !== 'off'));
  repeatBtn.dataset.repeat = queue.repeat;
  repeatBtn.setAttribute('aria-label', REPEAT_LABEL[queue.repeat]);
  repeatBtn.title = REPEAT_LABEL[queue.repeat];
  clear(repeatBtn).append(icon(queue.repeat === 'one' ? 'repeatOne' : 'repeat', { size: 22 }));
  prevBtn.disabled = !t;
  nextBtn.disabled = !t || (queue.index >= queue.length - 1 && queue.repeat === 'off');
  updateState();
  updateTime();
  updateVolume();
  emit('change');
}

/** Highlight the playing song in any track list on the page. */
export function markPlaying(root = document) {
  const id = queue.current?.id;
  for (const row of root.querySelectorAll('.track-row')) {
    const on = Number(row.dataset.id) === id;
    row.classList.toggle('is-current', on);
    row.classList.toggle('is-playing', on && !audio.paused);
  }
}

// ---- "Up next" dialog ----
export function openQueue() {
  let list;
  let focusKey = null; // e.g. "3:up" — refocused after the list redraws
  const act = (key, fn) => () => {
    focusKey = key;
    fn();
  };
  const render = () => {
    const keep = focusKey ?? document.activeElement?.dataset?.qkey ?? null;
    focusKey = null;
    clear(list);
    if (!queue.length) {
      list.append(h('li', { class: 'muted' }, 'Nothing queued.'));
      return;
    }
    queue.items.forEach((t, i) => {
      const isCur = i === queue.index;
      list.append(
        h(
          'li',
          { class: `queue-row${isCur ? ' is-current' : ''}${i < queue.index ? ' is-past' : ''}` },
          h(
            'button',
            { type: 'button', class: 'queue-main', 'aria-current': isCur ? 'true' : null, dataset: { qkey: `${i}:main` }, onClick: act(`${i}:main`, () => music.jump(i)) },
            art(t.poster, t.albumTitle || t.title, { kind: 'square' }),
            h('span', { class: 'queue-text' }, h('strong', {}, t.title), h('small', {}, [t.artist, t.albumTitle].filter(Boolean).join(' · '))),
            h('span', { class: 'muted small' }, t.duration ? formatClock(t.duration) : ''),
          ),
          h(
            'span',
            { class: 'queue-tools' },
            h('button', { type: 'button', class: 'mbtn', 'aria-label': `Move “${t.title}” up`, title: 'Move up', disabled: i === 0, dataset: { qkey: `${i}:up` }, onClick: act(`${i - 1}:up`, () => music.move(i, i - 1)) }, icon('up', { size: 18 })),
            h('button', { type: 'button', class: 'mbtn', 'aria-label': `Move “${t.title}” down`, title: 'Move down', disabled: i === queue.length - 1, dataset: { qkey: `${i}:down` }, onClick: act(`${i + 1}:down`, () => music.move(i, i + 1)) }, icon('chevronDown', { size: 18 })),
            h('button', { type: 'button', class: 'mbtn', 'aria-label': `Remove “${t.title}”`, title: 'Remove', dataset: { qkey: `${i}:remove` }, onClick: act(`${Math.min(i, queue.length - 2)}:remove`, () => music.remove(i)) }, icon('close', { size: 18 })),
          ),
        ),
      );
    });
    const target = keep && list.querySelector(`[data-qkey="${keep}"]:not(:disabled)`);
    if (target) target.focus({ preventScroll: false });
    else list.querySelector('.queue-row.is-current')?.scrollIntoView({ block: 'nearest' });
  };
  const onChange = () => render();
  openDialog({
    title: 'Up next',
    wide: true,
    body: () => {
      list = h('ol', { class: 'queue-list', role: 'list' });
      render();
      events.addEventListener('change', onChange);
      return list;
    },
    actions: [
      { label: 'Clear queue', value: 'clear', variant: 'ghost' },
      { label: 'Done', value: 'close', variant: 'primary' },
    ],
  }).then((v) => {
    events.removeEventListener('change', onChange);
    if (v === 'clear') music.stop();
  });
}

// ---- Track lists (album pages, songs view, search) ----
/**
 * @param {object[]} tracks
 * @param {{ showAlbum?: boolean, showArtist?: boolean|string, numbers?: boolean, discs?: boolean, focusId?: number }} [opts]
 *   showArtist: true = always, a string = only when the song's artist differs from it
 */
export function trackList(tracks, { showAlbum = false, showArtist = true, numbers = true, discs = false, focusId = null } = {}) {
  const multiDisc = discs && new Set(tracks.map((t) => t.season || 1)).size > 1;
  const list = h('ol', { class: `tracks${showAlbum ? ' with-album' : ''}`, role: 'list' });
  let disc = null;
  tracks.forEach((t, i) => {
    if (multiDisc && (t.season || 1) !== disc) {
      disc = t.season || 1;
      list.append(h('li', { class: 'disc-head', 'aria-hidden': 'true' }, icon('album', { size: 16 }), `Disc ${disc}`));
    }
    const artistText = showArtist === true ? t.artist : typeof showArtist === 'string' && t.artist && t.artist !== showArtist ? t.artist : null;
    const num = numbers ? (t.episode ?? i + 1) : null;
    list.append(
      h(
        'li',
        { class: 'track-row', dataset: { id: t.id } },
        h(
          'button',
          {
            type: 'button',
            class: 'track-main',
            'aria-label': `Play ${t.title}${t.artist ? ` by ${t.artist}` : ''}`,
            'data-autofocus': focusId === t.id || null,
            onClick: () => {
              if (queue.current?.id === t.id && session) music.toggle();
              else music.playTracks(tracks, i, { shuffle: queue.shuffle });
            },
          },
          h('span', { class: 'track-num' }, h('span', { class: 'track-n' }, num != null ? String(num) : ''), h('span', { class: 'track-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), icon('play', { size: 16 })),
          showAlbum ? art(t.poster || t.albumPoster, t.albumTitle || t.title, { kind: 'square' }) : null,
          h('span', { class: 'track-text' }, h('span', { class: 'track-title' }, t.title), artistText || (showAlbum && t.albumTitle) ? h('span', { class: 'track-sub' }, [artistText, showAlbum ? t.albumTitle : null].filter(Boolean).join(' · ')) : null),
          h('span', { class: 'track-time' }, t.duration ? formatClock(t.duration) : ''),
        ),
        h('button', { type: 'button', class: 'mbtn track-more', 'aria-label': `More for ${t.title}`, title: 'More', onClick: () => trackMenu(t) }, icon('more', { size: 20 })),
      ),
    );
  });
  markPlaying(list);
  return list;
}

function trackMenu(t) {
  openSheet(t.title, [
    { label: 'Play now', icon: 'play', onSelect: () => music.playTracks([t], 0) },
    { label: 'Play next', icon: 'queue', onSelect: () => music.playNext([t]) },
    { label: 'Add to queue', icon: 'queue', onSelect: () => music.addToQueue([t]) },
    // Lyrics for a song that isn't playing: its own page, with the queue left as it is.
    { label: 'Lyrics', icon: 'list', onSelect: () => { location.hash = music.current?.id === t.id ? '#/now-playing' : `#/now-playing?song=${t.id}`; } },
    addToPlaylistItems({ itemId: t.id }, { kind: 'music' }),
    { label: 'Cast to…', icon: 'cast', onSelect: async () => (await import('./cast.js')).openCastPicker({ queue: { itemIds: [t.id], index: 0 } }) },
    t.parentId ? { label: 'Go to album', icon: 'album', onSelect: () => (location.hash = `#/item/${t.parentId}?track=${t.id}`) } : null,
    t.showId ? { label: 'Go to artist', icon: 'user', onSelect: () => (location.hash = `#/item/${t.showId}`) } : null,
  ]);
}
