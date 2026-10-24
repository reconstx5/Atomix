// Music player: one <audio> element that lives outside the page views, so
// songs keep playing while you browse. Shows a mini-player bar, keeps an
// "up next" queue, and hooks into the system media controls (lock screen,
// keyboard media keys, headphones) through the Media Session API.
import { api } from './api.js';
import { h, icon, clear, formatClock } from './dom.js';
import { Queue } from './queue.js';
import { addToPlaylistItems } from './lists.js';
import { ratingControl, openRating } from './rating.js';
import { downloadSheetItem } from './offline/ui.js';
import { detectCaps } from './caps.js';
import { markPlaying as gatePlaying } from './gate.js';
import { art, toast, openDialog, openSheet, sliderText, percentSlider } from './components.js';
import { VOLUME_KEY, musicKey } from './storage.js';
import { partAt, bookTime, chapterAt, leftText, fadeVolume, SPEEDS, FADE_MS } from './spoken-time.js';

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
let prefs = {}; // the profile's own: spokenSpeed, spokenBack, spokenForward (v0.22)
const sleep = { mode: null, end: 0, chapterEnd: 0, base: null, timer: null, set: null }; // v0.22 sleep timer (set: the volume it last set)

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
  /** A radio station is playing (no times, no seeking, no lyrics). */
  get live() {
    return Boolean(queue.current?.live);
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

  /** Radio: play a station; next/previous step through the radio stations (in the Channels page's order). */
  async playLive(channel) {
    const { channels, zapOrder } = await import('./live.js');
    let radios = [];
    try {
      radios = (await channels()).filter((c) => c.radio);
    } catch {
      radios = [];
    }
    if (!radios.some((c) => c.id === channel.id)) radios.unshift(channel);
    const order = zapOrder();
    radios.sort((a, b) => (order.includes(a.id) && order.includes(b.id) ? order.indexOf(a.id) - order.indexOf(b.id) : 0));
    const list = radios.map(stationEntry);
    queue.set(list, Math.max(0, list.findIndex((t) => t.channelId === channel.id)), { shuffle: false });
    retried = false;
    failures = 0;
    load(0);
  },

  /** Play a list of songs. `start` = index to begin at, or -1 with shuffle for a random start; `at` = seconds into it. */
  playTracks(tracks, start = 0, { shuffle = false, at = 0 } = {}) {
    const list = slimAll(tracks);
    if (!list.length) return;
    queue.set(list, shuffle && start < 0 ? -1 : Math.max(0, start), { shuffle });
    if (list[0].spoken && queue.repeat !== 'off') queue.repeat = 'off'; // a book or an episode never starts over by itself
    retried = false;
    failures = 0;
    load(Math.max(0, Number(at) || 0));
  },

  // ---- v0.22: audiobooks and podcast episodes ("spoken" entries) ----
  /** The playing entry's spoken data (a book or an episode), or null for a song or a station. */
  get spoken() {
    return queue.current?.spoken || null;
  },
  /** Where the book (or episode) is, in seconds, and its whole length — across a book's parts. */
  get bookPosition() {
    return bookPos();
  },
  get bookDuration() {
    return bookDur();
  },
  get speed() {
    return speedFor(queue.current);
  },
  get skipBack() {
    return clampPref(prefs.spokenBack, 5, 60, 15);
  },
  get skipForward() {
    return clampPref(prefs.spokenForward, 10, 120, 30);
  },
  /** Back (negative) or forward on the book's timeline. */
  skip(seconds) {
    if (!this.spoken) return this.seek(currentTime() + seconds);
    this.seekBook(bookPos() + seconds);
  },
  /** A place on the book's timeline: the part it falls in, at the right offset. */
  seekBook(t) {
    const sp = this.spoken;
    if (!sp) return this.seek(t);
    const total = bookDur();
    const known = !(sp.parts?.length > 1) || sp.parts.every((p) => p.duration); // an unknown part: its end isn't known
    t = Math.max(0, total && known ? Math.min(t, total - 0.5) : t);
    if (!(sp.parts?.length > 1)) return this.seek(t);
    const { index, offset } = partAt(sp.parts, t, sp.partIndex); // a part whose length isn't known yet keeps its skips
    if (index === sp.partIndex) return this.seek(offset);
    const qi = queue.items.findIndex((e) => e.id === sp.parts[index].id);
    if (qi < 0) return this.seek(offset);
    queue.jump(qi);
    retried = false;
    load(offset, { autoplay: !audio.paused || switching });
  },
  /** The sleep timer: minutes from now, or 'chapter' (the end of the chapter playing). */
  sleep: {
    start: (what) => sleepStart(what),
    cancel: () => sleepCancel(),
    addTen: () => sleepAddTen(),
    get remaining() {
      return sleep.mode ? Math.max(0, sleepLeft()) : null;
    },
    get mode() {
      return sleep.mode;
    },
  },
  /** A spoken title's speed (kept for the profile); songs always play at 1×. */
  setSpeed(v) {
    const speed = SPEEDS.includes(Number(v)) ? Number(v) : 1;
    prefs = { ...prefs, spokenSpeed: speed };
    applySpeed();
    changed();
    api.patch('/api/me', { prefs: { spokenSpeed: speed } }).catch(() => {});
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
    if (queue.current?.live) return stepStation(1);
    const t = queue.next();
    if (t) {
      retried = false;
      load(0);
    }
  },

  prev() {
    if (queue.current?.live) return stepStation(-1);
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
    if (!queue.current || queue.current.live) return; // a broadcast can't be seeked
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
    if (queue.current?.live) return;
    queue.setShuffle(on);
    changed();
  },

  cycleRepeat() {
    if (queue.current?.live) return;
    queue.cycleRepeat();
    changed();
  },

  /** Stop and clear everything. */
  stop() {
    sleepCancel();
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
    prefs = profile?.prefs || {};
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

// ---- Downloads (v0.21) ----
let offStore = null;
/** A downloaded song's place, queued for the server (it counts as a play when the device is back online). */
async function saveOffline(track, position) {
  try {
    const [{ openStore }, { downloads }] = await Promise.all([import('./offline/store.js'), import('./offline/downloader.js')]);
    offStore ||= await openStore();
    if (downloads.profileId == null) return;
    await offStore.queueProgress({ profileId: downloads.profileId, itemId: track.id, position, duration: totalDuration(), at: Date.now() });
  } catch {
    /* nowhere to keep it: the song still plays */
  }
}

/**
 * Play downloads (entries from the device's downloads) from `index`, in the order given — songs, or (v0.22) a book's
 * parts and podcast episodes, whose entries carry `spoken` (see views/downloads.js), from `at` seconds into the first.
 */
export async function playOffline(entries, index = 0, { at = 0 } = {}) {
  const { openStore } = await import('./offline/store.js');
  offStore ||= await openStore();
  const list = entries.map((e) => ({ id: e.itemId, kind: e.kind || 'track', title: e.spoken ? e.spoken.title : e.title, artist: e.artist, albumTitle: e.albumTitle, parentId: e.parentId, duration: e.duration, spoken: e.spoken || null, offline: offStore.fileUrl(e) }));
  music.playTracks(list, index, { at });
}

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
    stars: t.stars ?? null, // the profile's own (the bar's heart, Now Playing's stars)
    favourite: Boolean(t.favourite),
    offline: t.offline || null, // v0.21: a download on this device — its own file plays, no server needed
    spoken: t.spoken || null, // v0.22: a book's part or a podcast episode (see spoken.js)
  };
}
const slimAll = (tracks) => (Array.isArray(tracks) ? tracks : [tracks]).filter((t) => t && t.id != null).map(slim);

const currentTime = () => (seekTarget != null ? seekTarget : !session ? resumeAt : (session.mode === 'direct' ? 0 : offset) + (audio.currentTime || 0));
const totalDuration = () => duration || queue.current?.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);

// ---- v0.22: spoken titles ----
const clampPref = (v, lo, hi, def) => (Number.isFinite(Number(v)) && v != null ? Math.min(hi, Math.max(lo, Number(v))) : def);
const speedFor = (t) => (t?.spoken ? (SPEEDS.includes(Number(prefs.spokenSpeed)) ? Number(prefs.spokenSpeed) : 1) : 1);
function bookPos() {
  const sp = queue.current?.spoken;
  return sp?.parts?.length > 1 ? bookTime(sp.parts, sp.partIndex, currentTime()) : currentTime();
}
function bookDur() {
  const sp = queue.current?.spoken;
  return (sp?.parts?.length > 1 && sp.total) || totalDuration();
}
/** Songs at 1×; a book or an episode at the profile's speed, its pitch kept. */
function applySpeed() {
  const rate = speedFor(queue.current);
  audio.defaultPlaybackRate = rate;
  if (audio.playbackRate !== rate) audio.playbackRate = rate;
  audio.preservesPitch = true;
}
audio.addEventListener('loadedmetadata', applySpeed);
audio.addEventListener('play', applySpeed);

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
    res = track.offline
      ? { offline: true, mode: 'direct', url: track.offline, duration: track.duration, item: { id: track.id } }
      : track.live
      ? await api.post(`/api/live/channels/${track.channelId}/play`, { caps: detectCaps(), audioOnly: true, replaces })
      : await api.post(`/api/items/${track.id}/playback`, { caps: detectCaps(), start, replaces, forceTranscode });
  } catch (err) {
    if (token !== loadToken) return;
    switching = false;
    setBusy(false);
    updateState();
    skipAfterError(`Can't play “${track.title}”: ${err.message}`);
    return;
  }
  if (token !== loadToken) {
    const stopping = res.sessionId ? api.post(`/api/playback/${res.sessionId}/stop`, {}).catch(() => {}) : null;
    if (track.live) await stopping; // the next station's start must not overlap it
    return;
  }
  session = res;
  resumeAt = 0;
  if (track.spoken && !track.spoken.chapters?.length && res.chapters?.length) track.spoken.chapters = res.chapters.map((c) => ({ title: c.title, start: c.start }));
  offset = res.mode === 'direct' ? 0 : res.start || 0;
  duration = res.duration || track.duration || 0;
  if (track.live) {
    drops = [];
    stationShow(track, res.programme, res.next);
  }
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
  if (queue.current?.live) return; // a station that won't start: say so, don't wander off to another one
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
  if (session?.sessionId) api.post(`/api/playback/${session.sessionId}/stop`, {}, { keepalive: true }).catch(() => {});
  session = null;
}

audio.addEventListener('ended', () => {
  const track = queue.current;
  if (track?.live) return reconnect();
  if (track && session?.offline) saveOffline(track, totalDuration());
  else if (track && session) {
    // Counts as played (and lets plugins such as scrobblers hear about it).
    api.post(`/api/items/${track.id}/progress`, { position: totalDuration(), duration: totalDuration(), sessionId: session.sessionId }, { keepalive: true }).catch(() => {});
  }
  failures = 0;
  const next = queue.next({ auto: true });
  if (!next) {
    // End of the queue: go back to the first song, paused, ready to play again (a sleep timer has nothing left to do).
    sleepCancel();
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
  if (queue.current?.live) return reconnect();
  if (!retried && session.mode !== 'transcode' && !session.offline) {
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
  reportProgress();
});

audio.addEventListener('pause', () => {
  if (switching) return;
  pausedAt = Date.now();
  updateState();
  ping();
  reportProgress();
  save(true);
});
audio.addEventListener('waiting', () => setBusy(true));
audio.addEventListener('playing', () => {
  setBusy(false);
  reportProgress(); // opens the song's play (the 'play' event can come while the source is still swapping)
});
audio.addEventListener('canplay', () => setBusy(false));
audio.addEventListener('timeupdate', () => {
  updateTime();
  emit('time');
  if (Date.now() - lastSave > SAVE_EVERY) save();
  // A download playing (no server session to ping): its place every 10 s, so a phone that closes the app loses little.
  if (session?.offline && !audio.paused && Date.now() - lastOfflineReport > OFFLINE_REPORT_MS) {
    lastOfflineReport = Date.now();
    reportProgress();
  }
});
audio.addEventListener('loadedmetadata', updateTime);
const OFFLINE_REPORT_MS = 10_000;
let lastOfflineReport = 0;

// Remember the volume (shared with the video player).
try {
  const v = localStorage.getItem(VOLUME_KEY);
  if (v !== null && Number(v) >= 0 && Number(v) <= 1) audio.volume = Number(v);
} catch {
  /* private mode */
}
let fromPref = null; // a profile's saved volume being applied: that change is not the device's to remember
audio.addEventListener('volumechange', () => {
  if (sleep.set != null && Math.abs(audio.volume - sleep.set) < 1e-6) return; // the sleep timer's own fade
  if (sleep.mode) sleep.base = audio.volume; // the person's own volume, while a timer runs: the one it fades from
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

/** Where a song is, for play history: when it starts, every 30 s while it plays, and when it pauses. */
function reportProgress() {
  const track = queue.current;
  if (!track || track.live || !session || switching) return;
  if (session.offline) return saveOffline(track, currentTime());
  api.post(`/api/items/${track.id}/progress`, { position: currentTime(), duration: totalDuration(), sessionId: session.sessionId, paused: audio.paused }).catch(() => {});
}

function ping() {
  if (!session?.sessionId) return;
  if (!audio.paused) reportProgress();
  const sid = session.sessionId;
  api
    .post(`/api/playback/${sid}/ping`, { position: currentTime(), paused: audio.paused })
    .then((res) => {
      if (!res || session?.sessionId !== sid || !queue.current?.live) return;
      if (res.notice) toast(res.notice);
      if (res.error) {
        toast(res.error, { type: 'error' });
        session = null;
        audio.pause();
        audio.removeAttribute('src');
        updateState();
      }
    })
    .catch(() => {});
}

// ---- Radio ----
let drops = []; // reconnects in the last 2 minutes
let showTimer = null;
const stationEntry = (c) => ({ id: `live:${c.id}`, live: true, channelId: c.id, title: c.now?.title || c.name, artist: c.name, albumTitle: null, poster: c.logo || null, duration: null, end: c.now?.end || null });

let stepTimer = null;
let stationLoad = Promise.resolve();
/**
 * Next/Previous between stations: the title moves at once; the station starts once the presses stop (400 ms), and
 * never while another station is still starting — a provider allowing one stream would refuse the overlap.
 */
function stepStation(dir) {
  if (queue.length < 2) return;
  retried = false;
  queue.jump((queue.index + dir + queue.length) % queue.length);
  changed();
  clearTimeout(stepTimer);
  stepTimer = setTimeout(() => {
    stationLoad = stationLoad.then(() => load(0)).catch(() => {});
  }, 400);
}

/** The station's programme as the song title; it follows the guide (at the programme's end, and each minute). */
function stationShow(track, now, next) {
  track.title = now?.title || track.artist;
  track.end = now?.end || null;
  track.nextTitle = next?.title || null;
  changed();
  clearTimeout(showTimer);
  const wait = track.end ? Math.min(60_000, Math.max(1000, track.end - Date.now() + 500)) : 60_000;
  showTimer = setTimeout(() => refreshShow(track), wait);
}
async function refreshShow(track) {
  if (queue.current !== track) return;
  const { guide } = await import('./live.js');
  const t = Date.now();
  let list = [];
  try {
    const g = await guide(t, t + 4 * 3600_000, [track.channelId]);
    list = (g.programmes?.[track.channelId] || []).sort((a, b) => a.start - b.start);
  } catch {
    /* try again in a minute */
  }
  if (queue.current !== track) return;
  const i = list.findIndex((p) => p.start <= Date.now() && Date.now() < p.end);
  stationShow(track, i >= 0 ? list[i] : null, i >= 0 ? list[i + 1] : null);
}

/** A station's stream ended or broke: ask for it again (a new request restarts it), 3 times in 2 minutes. */
function reconnect() {
  if (!session?.url) return;
  const now = Date.now();
  drops = [...drops.filter((t) => now - t < 120_000), now];
  if (drops.length > 3) {
    toast('This station stopped sending audio.', { type: 'error' });
    stopSession();
    updateState();
    return;
  }
  toast('Lost the station — trying again');
  const url = session.url;
  setTimeout(() => {
    if (session?.url !== url) return;
    audio.src = `${url}${url.includes('?') ? '&' : '?'}retry=${now}`;
    audio.play().catch(() => {});
  }, 1000);
}
setInterval(ping, PING_EVERY);
window.addEventListener('pagehide', () => {
  save(true);
  if (session?.offline) reportProgress();
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
  // v0.22: a book or an episode skips on its own timeline — a headphone double-tap is "next", and that is 30 s on.
  const spoken = Boolean(t.spoken);
  const handlers = spoken
    ? {
        play: () => music.play(),
        pause: () => music.pause(),
        stop: () => music.stop(),
        previoustrack: () => music.skip(-music.skipBack),
        nexttrack: () => music.skip(music.skipForward),
        seekto: (d) => music.seekBook(d.seekTime),
        seekbackward: (d) => music.skip(-(d.seekOffset || music.skipBack)),
        seekforward: (d) => music.skip(d.seekOffset || music.skipForward),
      }
    : {
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
  const sp = queue.current?.spoken;
  const total = sp ? bookDur() : totalDuration(); // a book: its whole timeline, at its speed
  if (!total) return;
  try {
    navigator.mediaSession.setPositionState({ duration: total, playbackRate: sp ? speedFor(queue.current) : 1, position: Math.min(sp ? bookPos() : currentTime(), total) });
  } catch {
    /* ignore */
  }
}

// ---- Mini-player bar ----
const ctl = (name, label, onClick, extra = {}) => h('button', { class: 'mbtn', type: 'button', 'aria-label': label, title: label, onClick, ...extra }, icon(name, { size: 22 }));

const artLink = h('a', { class: 'mini-art', href: '#/', tabindex: '-1', 'aria-hidden': 'true' });
const titleEl = h('a', { class: 'mini-title', href: '#/' });
const subEl = h('div', { class: 'mini-sub' });
const heartSlot = h('span', { class: 'mini-heart' }); // the playing song's heart (not for radio)
const shuffleBtn = ctl('shuffle', 'Shuffle', () => music.setShuffle(!queue.shuffle), { 'aria-pressed': 'false', class: 'mbtn mini-extra' });
const prevBtn = ctl('prev', 'Previous', () => music.prev(), { class: 'mbtn mini-prev' });
const playBtn = ctl('play', 'Play', () => music.toggle(), { class: 'mbtn mbtn-play' });
const nextBtn = ctl('next', 'Next', () => music.next(), { class: 'mbtn mini-next' });
// v0.22: a book or an episode skips back and forward instead, and has a speed (hidden for songs: CSS .is-spoken).
const backBtn = ctl('rewind', 'Back 15 seconds', () => music.skip(-music.skipBack), { class: 'mbtn mini-back' });
const fwdBtn = ctl('skip', 'Forward 30 seconds', () => music.skip(music.skipForward), { class: 'mbtn mini-forward' });
const speedBtn = h('button', { class: 'mbtn mini-speed', type: 'button', 'aria-label': 'Speed 1×', title: 'Speed', onClick: () => openSpeed() }, '1×');
export function openSpeed() {
  openSheet('Speed', SPEEDS.map((v) => ({ label: `${v}×${v === music.speed ? ' (now)' : ''}`, icon: v === music.speed ? 'check' : 'play', onSelect: () => music.setSpeed(v) })));
}
const speedText = (v) => `${v}×`;
const sleepBtn = ctl('moon', 'Sleep timer', () => openSleep(), { class: 'mbtn mini-sleep' });
const repeatBtn = ctl('repeat', 'Repeat: off', () => music.cycleRepeat(), { 'aria-pressed': 'false', class: 'mbtn mini-extra' });
const seek = h('input', { type: 'range', class: 'mini-seek-range', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Seek' });
const timeCur = h('span', { class: 'mini-time' }, '0:00');
const timeEnd = h('span', { class: 'mini-time' }, '0:00');
const line = h('span');
const queueBtn = ctl('queue', 'Queue', () => openQueue());
const muteBtn = ctl('volume', 'Mute', () => (audio.muted = !audio.muted), { class: 'mbtn mini-extra' });
const volume = percentSlider(h('input', { type: 'range', class: 'mini-volume mini-extra', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' }));
const closeBtn = ctl('close', 'Stop and clear the queue', () => music.stop(), { class: 'mbtn mini-extra' });

export const miniPlayer = h(
  'section',
  { class: 'mini', 'aria-label': 'Music player', hidden: true },
  h('div', { class: 'mini-line', 'aria-hidden': 'true' }, line),
  h('div', { class: 'mini-now' }, artLink, h('div', { class: 'mini-text' }, titleEl, subEl), heartSlot),
  h(
    'div',
    { class: 'mini-center' },
    h('div', { class: 'mini-buttons' }, shuffleBtn, prevBtn, backBtn, playBtn, fwdBtn, nextBtn, repeatBtn, speedBtn, sleepBtn),
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
  sliderText(seek, `${formatClock(Number(seek.value))} of ${formatClock(totalDuration())}`, { force: true });
});
seek.addEventListener('change', () => {
  scrubbing = false;
  if (music.spoken) music.seekBook(Number(seek.value));
  else music.seek(Number(seek.value));
});
// Arrow keys (and TV remotes) jump 10 seconds rather than the slider's 1-second step.
seek.addEventListener('keydown', (e) => {
  const step = music.spoken ? { ArrowLeft: -music.skipBack, ArrowRight: music.skipForward }[e.key] : { ArrowLeft: -10, ArrowRight: 10 }[e.key];
  if (!step) return;
  e.preventDefault();
  if (music.spoken) return music.skip(step); // a book: the skip amounts, on the book's timeline
  const to = Math.max(0, Math.min(totalDuration() || Infinity, currentTime() + step));
  music.seek(to);
  sliderText(seek, `${formatClock(to)} of ${formatClock(totalDuration())}`, { force: true });
});
volume.addEventListener('input', () => {
  audio.volume = Number(volume.value);
  audio.muted = audio.volume === 0;
});

function paintSeek(now, total = queue.current?.spoken ? bookDur() : totalDuration()) {
  const pct = total ? `${Math.min(100, (now / total) * 100)}%` : '0%';
  seek.style.setProperty('--pct', pct);
  line.style.width = pct;
}

function updateTime() {
  if (queue.current?.live) {
    timeCur.textContent = 'Live';
    timeEnd.textContent = '';
    line.style.width = '0';
    return;
  }
  const spoken = queue.current?.spoken;
  const total = spoken ? bookDur() : totalDuration();
  const now = spoken ? bookPos() : currentTime();
  if (!scrubbing) {
    seek.max = String(Math.max(1, Math.floor(total)));
    seek.value = String(Math.floor(now));
    timeCur.textContent = formatClock(now);
    paintSeek(now, total);
  }
  timeEnd.textContent = total ? (spoken ? leftText(total - now) : formatClock(total)) : '';
  if (spoken) spokenSub(now);
  if (!scrubbing) sliderText(seek, `${formatClock(now)} of ${formatClock(total)}`);
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
    if (t.spoken) spokenSub(bookPos(), true);
    // Rebuilt when the song changes — or the same song arrives as a fresher copy (a restored queue, then Play).
    if (heartSlot.track !== t) {
      heartSlot.track = t;
      heartSlot.replaceChildren(t.live || t.spoken ? '' : ratingControl(t, { compact: true }));
    }
  } else {
    clearMediaSession();
  }
  const live = Boolean(t?.live);
  miniPlayer.classList.toggle('is-live', live);
  miniPlayer.classList.toggle('is-spoken', Boolean(t?.spoken));
  if (t?.spoken) {
    backBtn.setAttribute('aria-label', `Back ${music.skipBack} seconds`);
    backBtn.title = backBtn.getAttribute('aria-label');
    fwdBtn.setAttribute('aria-label', `Forward ${music.skipForward} seconds`);
    fwdBtn.title = fwdBtn.getAttribute('aria-label');
    speedBtn.textContent = speedText(music.speed);
    speedBtn.setAttribute('aria-label', `Speed ${speedText(music.speed)}`);
  }
  updateSleepButton();
  shuffleBtn.disabled = repeatBtn.disabled = live;
  seek.disabled = live;
  shuffleBtn.setAttribute('aria-pressed', String(queue.shuffle));
  repeatBtn.setAttribute('aria-pressed', String(queue.repeat !== 'off'));
  repeatBtn.dataset.repeat = queue.repeat;
  repeatBtn.setAttribute('aria-label', REPEAT_LABEL[queue.repeat]);
  repeatBtn.title = REPEAT_LABEL[queue.repeat];
  clear(repeatBtn).append(icon(queue.repeat === 'one' ? 'repeatOne' : 'repeat', { size: 22 }));
  prevBtn.disabled = !t;
  nextBtn.disabled = !t || (live ? queue.length < 2 : queue.index >= queue.length - 1 && queue.repeat === 'off');
  if (live) prevBtn.disabled = queue.length < 2;
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
    if (on) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}

// ---- The queue dialog: the songs still to come (the playing one is on the mini-player already) ----
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
    const upcoming = queue.items.map((t, i) => [t, i]).filter(([, i]) => i > queue.index);
    if (!upcoming.length) {
      list.append(h('li', { class: 'muted' }, 'Nothing more queued.'));
      return;
    }
    upcoming.forEach(([t, i]) => {
      const isCur = false;
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
            h('button', { type: 'button', class: 'mbtn', 'aria-label': `Move “${t.title}” up`, title: 'Move up', disabled: i <= queue.index + 1, dataset: { qkey: `${i}:up` }, onClick: act(`${i - 1}:up`, () => music.move(i, i - 1)) }, icon('up', { size: 18 })),
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
    title: 'Queue',
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
/** `queueOffset`: the rows are the live queue from that index on — a click jumps there instead of rebuilding the queue. */
export function trackList(tracks, { showAlbum = false, showArtist = true, numbers = true, discs = false, focusId = null, queueOffset = null } = {}) {
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
              else if (queueOffset != null) music.jump(queueOffset + i);
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
    { label: 'Rate…', icon: 'star', onSelect: () => openRating(t) },
    downloadSheetItem(t), // v0.21: into the app
    { label: 'Cast to…', icon: 'cast', onSelect: async () => (await import('./cast.js')).openCastPicker({ queue: { itemIds: [t.id], index: 0 } }) },
    t.parentId ? { label: 'Go to album', icon: 'album', onSelect: () => (location.hash = `#/item/${t.parentId}?track=${t.id}`) } : null,
    t.showId ? { label: 'Go to artist', icon: 'user', onSelect: () => (location.hash = `#/item/${t.showId}`) } : null,
  ]);
}

// ---- v0.22: the bar's second line for a book or an episode (the chapter, then who wrote or hosts it) ----
let lastSub = '';
function spokenSub(now, force = false) {
  const t = queue.current;
  const sp = t?.spoken;
  if (!sp) return;
  const ch = chapterAt(sp.chapters, now);
  const text = [ch?.title, sp.author].filter(Boolean).join(' · ');
  if (!force && text === lastSub) return;
  lastSub = text;
  subEl.textContent = text;
  subEl.title = text;
}

// J and L skip back and forward while a book or an episode plays (not while typing, in a dialog or in the video player).
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !music.spoken) return;
  if (document.body.dataset.view === 'player' || document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const key = e.key.toLowerCase();
  if (key !== 'j' && key !== 'l') return;
  e.preventDefault();
  music.skip(key === 'j' ? -music.skipBack : music.skipForward);
});

// ---- v0.22: the sleep timer ----
// Counts on the wall clock (minutes) or the book's timeline (End of chapter, at the playing speed); the last 10 seconds
// fade the volume down, then it pauses and the volume is put back as it was.
function sleepLeft() {
  if (sleep.mode === 'chapter') return ((sleep.chapterEnd - bookPos()) / (speedFor(queue.current) || 1)) * 1000;
  return sleep.end - Date.now();
}
function sleepStart(what) {
  sleepCancel();
  if (!queue.current) return;
  if (what === 'chapter') {
    const sp = queue.current.spoken;
    const pos = bookPos();
    const next = (sp?.chapters || []).find((c) => c.start > pos + 0.5);
    sleep.mode = 'chapter';
    sleep.chapterEnd = next ? next.start : bookDur();
  } else {
    const minutes = Number(what);
    if (!(minutes > 0)) return;
    sleep.mode = 'time';
    sleep.end = Date.now() + minutes * 60_000;
  }
  sleep.base = audio.volume;
  sleep.set = null;
  sleep.timer = setInterval(sleepTick, 250);
  sleepTick();
  changed();
}
function sleepAddTen() {
  if (!sleep.mode) return;
  const left = Math.max(0, sleepLeft());
  sleep.mode = 'time';
  sleep.end = Date.now() + left + 600_000;
  setVolumeQuietly(sleep.base);
  changed();
}
function sleepCancel() {
  if (!sleep.mode) return;
  clearInterval(sleep.timer);
  const base = sleep.base;
  sleep.mode = null;
  sleep.timer = null;
  sleep.base = null;
  if (base != null) setVolumeQuietly(base);
  changed();
}
/** The sleep timer's volume (its fade, and putting it back): remembered as its own, so it isn't taken as anyone's. */
function setVolumeQuietly(v) {
  sleep.set = v;
  audio.volume = v;
}
function sleepTick() {
  if (!sleep.mode) return;
  const left = sleepLeft();
  if (left <= 0) {
    audio.pause();
    sleepCancel();
    toast('Sleep timer: paused');
    return;
  }
  // Only in its last 10 s: before that the volume is the person's to change.
  if (left <= FADE_MS) {
    const v = fadeVolume(sleep.base, left);
    if (Math.abs(audio.volume - v) > 0.001) setVolumeQuietly(v);
  }
  updateSleepButton();
}
function updateSleepButton() {
  if (!sleepBtn) return;
  const left = sleep.mode ? Math.ceil(Math.max(0, sleepLeft()) / 60000) : null;
  const label = sleep.mode ? `Sleep timer: ${sleep.mode === 'chapter' ? 'end of chapter' : `${left} min left`}` : 'Sleep timer';
  if (sleepBtn.getAttribute('aria-label') !== label) {
    sleepBtn.setAttribute('aria-label', label);
    sleepBtn.title = label;
    sleepBtn.classList.toggle('is-on', Boolean(sleep.mode));
  }
}
export function openSleep() {
  if (sleep.mode) {
    openSheet('Sleep timer', [
      { label: 'Add 10 min', icon: 'plus', onSelect: () => sleepAddTen() },
      { label: 'Turn off', icon: 'close', onSelect: () => sleepCancel() },
    ]);
    return;
  }
  openSheet('Sleep timer', [
    ...[15, 30, 45, 60].map((m) => ({ label: `${m} min`, icon: 'clock', onSelect: () => sleepStart(m) })),
    { label: 'End of chapter', icon: 'list', onSelect: () => sleepStart('chapter') },
  ]);
}
