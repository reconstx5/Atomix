// Full-screen player with custom controls, subtitles, audio/quality switching,
// resume, progress sync and "up next" for TV episodes.
import { api } from '../api.js';
import { h, icon, clear, append, formatClock, formatRuntime, episodeLabel } from '../dom.js';
import { art, toast, endsAt, sliderText, percentSlider, announce, openSheet, openDialog, field, button } from '../components.js';
import { Scrubber, COMMIT_AFTER_MS } from '../scrub.js';
import { seekPreview } from '../seekpreview.js';
import { tileFor } from '../previews.js';
import { introLeft, skipSegment, upNextAt, focusIsFree, creditsStep, reportedPosition } from '../markers.js';
import { state, goBack, navigate, setTitle, isOrbit, canAdmin } from '../app.js';
import { NEED_SECURE, NO_WIDEVINE, NO_WIDEVINE_IPHONE, NO_COMMON_SYSTEM, NO_PROTECTION_IOS } from '../dash/eme.js'; // a small module of sentences and helpers (the engine itself loads on demand)
import { markPlaying } from '../gate.js';
import { phoneLive } from './phone-live.js';
import { detectCaps, needsMediaLink } from '../caps.js';
import { parseVtt, cueHtml } from '../vtt.js';
import { VOLUME_KEY } from '../storage.js';
import { openCastPicker } from '../cast.js';
import { joinTogether, startRoom, joinRoom, newsLine } from '../together.js';
import { listable, unplayableHere, deviceNow, deviceSoon, mayHide } from '../dash/playable.js';
import { guide as fetchGuide, channels as fetchChannels, protectionOf, castableDrm, zapOrder, setZapOrder, neighbour, zapQueue, programmeTimes, clockTime, programmeProgress, channelLabel, sessionPath, takeOver } from '../live.js';
import { rowName, channelLogo, lockBadge } from '../live-bits.js';

const QUALITIES = [
  ['original', 'Original'],
  ['1080', '1080p'],
  ['720', '720p'],
  ['480', '480p'],
  ['360', '360p'],
];
// v0.20: the speeds offered, and how a speed and a delay read.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedText = (v) => `${v}×`;
const round1 = (v) => Math.round(v * 10) / 10;
const delayText = (v) => (v ? `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} s` : 'Off');
const LANG3 = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', jpn: 'ja', por: 'pt', rus: 'ru', chi: 'zh', zho: 'zh', kor: 'ko', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi', mao: 'mi', mri: 'mi' };
const lang2 = (l) => (l ? LANG3[l.toLowerCase()] || l.toLowerCase().slice(0, 2) : null);
// v0.28: the key system an encrypted session plays with, by its name (the reply's `system`, else its EME name).
const SYSTEM_NAMES = { widevine: 'Widevine', playready: 'PlayReady', clearkey: 'ClearKey', fairplay: 'FairPlay' };
const EME_SYSTEMS = { 'com.widevine.alpha': 'widevine', 'com.microsoft.playready.recommendation': 'playready', 'com.microsoft.playready': 'playready', 'org.w3.clearkey': 'clearkey', 'com.apple.fps': 'fairplay' };
const systemOf = (res) => res?.system || EME_SYSTEMS[res?.keySystem] || 'clearkey';
const systemName = (res) => SYSTEM_NAMES[systemOf(res)] || 'ClearKey';
const MODE_LABEL = { direct: 'Direct play', remux: 'Remux (no quality loss)', transcode: 'Transcoding', encrypted: 'Encrypted' };

const MINUTE = 60_000;
const minutes = (ms) => {
  const n = Math.max(0, Math.round(ms / MINUTE));
  return `${n} ${n === 1 ? 'minute' : 'minutes'}`;
};

export async function render(el, params, query) {
  const isSource = Boolean(params.plugin);
  // Live TV: a channel (`live`) or a programme from the archive (`catchup`). Neither keeps progress.
  const liveMode = params.live != null;
  const catchupMode = params.catchup != null;
  const isTv = liveMode || catchupMode;
  // v0.21: a download on this device (`?offline=1`): played from the device's own copy, no server needed.
  const offlineMode = query.offline != null && !isSource && !isTv;
  const prefs = state.profile?.prefs || {};
  // x-webkit-airplay: Safari offers its AirPlay picker; the Apple TV then fetches the video itself (with a cast link).
  const video = h('video', { playsinline: true, preload: 'auto', 'aria-label': 'Video', 'x-webkit-airplay': 'allow' });
  const subLayer = h('div', { class: 'subtitle-layer', 'aria-live': 'off' });
  const spinnerEl = h('div', { class: 'player-spinner', hidden: true }, h('div', { class: 'spinner' }));
  const bigPlay = h('button', { class: 'player-bigplay', type: 'button', 'aria-label': 'Play', hidden: true }, icon('play', { size: 44 }));
  const titleEl = h('div', { class: 'player-title' });
  const notice = h('div', { class: 'player-notice', role: 'status', hidden: true });
  const errorEl = h('div', { class: 'player-error', hidden: true, role: 'alert' });
  const infoEl = h('div', { class: 'player-info', hidden: true });
  const upNext = h('div', { class: 'upnext', hidden: true });
  // v0.28: the same button skips a recap ("Previously on…") first, then the intro.
  const skipLabel = h('span', {}, 'Skip intro');
  const skipBtn = h('button', { class: 'skip-intro', type: 'button', hidden: true, onClick: () => skipIntro() }, skipLabel, h('span', { class: 'skip-intro-bar', 'aria-hidden': 'true' }));

  const seek = h('input', { type: 'range', class: 'seekbar', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Seek' });
  const bufferBar = h('div', { class: 'seek-buffer' });
  const timeCur = h('span', { class: 'time' }, '0:00');
  const timeEnd = h('span', { class: 'time' }, '0:00');
  const chapterTicks = h('div', { class: 'seek-chapters', 'aria-hidden': 'true' });
  const seekTrack = h('div', { class: 'seek-track' }, bufferBar, chapterTicks, seek);
  const bubble = seekPreview(seekTrack);
  const ctlBtn = (name, label, onClick, extra = {}) => h('button', { class: 'pbtn', type: 'button', 'aria-label': label, title: label, onClick, ...extra }, icon(name, { size: 24 }));
  const playBtn = ctlBtn('play', 'Play (Space)', () => togglePlay(), { class: 'pbtn pbtn-play' });
  const backBtn = ctlBtn('replay', 'Back 10 seconds', () => seekTo(currentTime() - 10));
  const fwdBtn = ctlBtn('skip', 'Forward 30 seconds', () => seekTo(currentTime() + 30));
  const muteBtn = ctlBtn('volume', 'Mute (M)', () => {
    video.muted = !video.muted;
  });
  const volume = percentSlider(h('input', { type: 'range', class: 'volume', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' }));
  const nextBtn = ctlBtn('next', 'Next episode (N)', () => playNext(), { hidden: true });
  const popup = { 'aria-haspopup': 'menu', 'aria-expanded': 'false' };
  const subsBtn = ctlBtn('subtitles', 'Subtitles: off', () => toggleMenu('subs'), { ...popup, title: 'Subtitles (C)' });
  const audioBtn = ctlBtn('audio', 'Audio track', () => toggleMenu('audio'), { hidden: true, ...popup });
  // v0.20: Playback settings — Quality, Speed and Audio delay.
  const qualityBtn = ctlBtn('quality', 'Playback settings', () => toggleMenu('quality'), { class: 'pbtn pbtn-settings', ...popup });
  const chaptersBtn = ctlBtn('list', 'Chapters', () => toggleMenu('chapters'), { class: 'pbtn pbtn-chapters', hidden: true, ...popup });
  const fsBtn = ctlBtn('fullscreen', 'Full screen (F)', () => toggleFullscreen());
  const castBtn = ctlBtn('cast', 'Cast to a TV', () => castToTv(), { class: 'pbtn pbtn-cast', hidden: isSource || offlineMode });
  // v0.20 Watch together: films and episodes (shown once the title is known).
  const togetherBtn = ctlBtn('users', 'Watch together', () => openTogether(), { class: 'pbtn pbtn-together', hidden: true, 'aria-haspopup': 'dialog' });
  const togetherStrip = h('div', { class: 'together-strip', role: 'status', hidden: true });
  let together = null;
  const airplayBtn = ctlBtn('airplay', 'AirPlay', () => video.webkitShowPlaybackTargetPicker?.(), { class: 'pbtn pbtn-airplay', hidden: true });
  const menu = h('div', { class: 'player-menu', hidden: true, role: 'menu', 'aria-labelledby': 'player-menu-title' });
  // Its title is a plain paragraph with this id (menus may only hold menu items, separators and groups otherwise).
  const menuTitle = (text) => h('p', { class: 'menu-title', id: 'player-menu-title', role: 'presentation' }, text);
  const modeBadge = h('button', { class: 'mode-badge', type: 'button', title: 'Playback info (I)', onClick: () => toggleInfo() });

  // On a phone the row has no room for everything: Quality, Cast and Full screen move into this "…" sheet (CSS shows it
  // and hides those three below 480 px).
  const moreBtn = ctlBtn('more', 'More controls', () =>
    openSheet('Playback', [
      { label: 'Playback settings', icon: 'quality', onSelect: () => toggleMenu('quality') },
      togetherBtn.hidden ? null : { label: 'Watch together', icon: 'users', onSelect: () => openTogether() },
      castBtn.hidden ? null : { label: 'Cast to a TV', icon: 'cast', onSelect: () => castToTv() },
      { label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', icon: 'fullscreen', onSelect: () => toggleFullscreen() },
    ].filter(Boolean)),
    { class: 'pbtn pbtn-more', 'aria-haspopup': 'dialog' },
  );
  // Live: channel up/down and the channel list take the place of the skip buttons.
  const prevChanBtn = ctlBtn('chan-down', 'Previous channel', () => zap(-1), { hidden: !liveMode });
  const nextChanBtn = ctlBtn('chan-up', 'Next channel', () => zap(1), { hidden: !liveMode });
  const channelsBtn = ctlBtn('live', 'Channels', () => openChannels(), { hidden: !liveMode, 'aria-haspopup': 'dialog' });
  const liveBadge = h('span', { class: 'live-badge', hidden: !liveMode }, 'LIVE');
  // v0.19: behind live (paused, rewound), this returns to the live point.
  const goLiveBtn = h('button', { class: 'btn btn-secondary btn-sm player-go-live', type: 'button', 'aria-label': 'Go to live', hidden: true, onClick: () => goLive() }, 'Live');
  const watchLiveBtn = h('button', { class: 'btn btn-secondary btn-sm player-watch-live', type: 'button', hidden: true, onClick: () => navigate(`#/live/play/${tvChannel?.id}`, { replace: true }) }, icon('live', { size: 16 }), h('span', {}, 'Watch live'));
  const channelsEl = h('div', { class: 'player-channels', hidden: true, role: 'dialog', 'aria-label': 'Channels' });
  if (isTv) {
    backBtn.hidden = fwdBtn.hidden = liveMode;
    subsBtn.hidden = true; // no subtitle files for broadcasts
  }
  const playGroup = h('div', { class: 'control-group' }, playBtn, backBtn, fwdBtn, prevChanBtn, nextChanBtn, channelsBtn, h('div', { class: 'volume-wrap' }, muteBtn, volume));
  const controls = h(
    'div',
    { class: 'player-controls' },
    h('div', { class: 'seek-wrap' }, liveBadge, timeCur, seekTrack, timeEnd, goLiveBtn),
    h('div', { class: 'control-row' }, playGroup, h('div', { class: 'control-group' }, modeBadge, nextBtn, chaptersBtn, subsBtn, audioBtn, qualityBtn, togetherBtn, castBtn, airplayBtn, fsBtn, moreBtn)),
    menu,
  );
  // Like a TV media centre: when will this finish if I keep watching?
  const endsEl = h('div', { class: 'player-ends', 'aria-live': 'off' });
  const top = h('div', { class: 'player-top' }, h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Back', title: 'Back (Esc)', onClick: () => leave() }, icon('back', { size: 26 })), titleEl, watchLiveBtn, endsEl);
  // Orbit: the clock top-right, and "Ends at" beside the play buttons.
  const clockEl = h('time', { class: 'player-clock' });
  const tickClock = () => (clockEl.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  let clockTimer = null;
  if (isOrbit()) {
    playGroup.append(endsEl);
    top.append(clockEl);
    tickClock();
    clockTimer = setInterval(tickClock, 15000);
  }
  const root = h('div', { class: 'player', tabindex: '-1', dataset: { controls: 'visible' } }, video, subLayer, spinnerEl, bigPlay, notice, errorEl, infoEl, upNext, skipBtn, togetherStrip, top, controls, channelsEl);
  if (isTv) root.classList.add('is-tv');
  if (liveMode) {
    root.classList.add('is-live');
    timeCur.hidden = timeEnd.hidden = true;
    seek.setAttribute('aria-readonly', 'true');
    seek.tabIndex = -1;
    seek.setAttribute('aria-label', 'Programme progress');
  }
  el.append(root);

  // ---- State ----
  let convBehind = 0; // a live conversion from the tuner's buffer: how far behind live it started (v0.19)
  let convStartedAt = 0;
  let convPaused = 0; // seconds a conversion has been paused (it falls that far further behind)
  let convPausedAt = 0;
  let session = null; // playback response
  let offset = 0; // where the current stream starts, in seconds
  let duration = 0;
  let cues = [];
  let currentSub = null;
  let burnIndex = null;
  let audioIndex = null;
  let quality = prefs.quality || null; // null → the server's default quality
  let scrubbing = false;
  let destroyed = false;
  let hideTimer = null;
  let rafId = 0;
  let retried = false;
  let upNextTimer = null;
  let item = null;
  let lastReported = 0;
  let autoSkip = prefs.skipIntros === true; // "Watch it" turns this off for the rest of the video
  let autoSkipped = new Set(); // auto-skip once per play-through (v0.28: the recap and the intro each once)
  let creditsArmed = true; // Up next may start at the credits (again after seeking back)
  let upNextCancelled = false; // cancelled during the credits: don't start it again at the end
  const subCache = new Map();
  // v0.20: speed (browser-side, back to 1× for the next title) and the delays remembered per profile and title.
  let speed = 1;
  let audioDelay = 0;
  let audioDelayDirty = false; // changed here: the next restart carries it (and the server saves it)
  let subtitleDelay = 0;
  let audioDelayTimer = null;
  let subSaveTimer = null;
  let subSavePending = false;

  const isStream = () => session && session.mode !== 'direct' && !isSource;
  const currentTime = () => (liveMode && rewindOn() ? rwPos() : seekTarget != null ? seekTarget : (isStream() ? offset : 0) + (video.currentTime || 0));
  const totalDuration = () => duration || (Number.isFinite(video.duration) ? video.duration : 0);
  const scrubber = new Scrubber({ duration: () => totalDuration() });
  let commitTimer = null;

  // The dismiss listeners of the notice on screen: a newer notice drops the older one's (it mustn't hide the new one).
  let noticeListeners = new AbortController();
  function setNotice(text, action) {
    noticeListeners.abort();
    noticeListeners = new AbortController();
    clear(notice);
    if (!text) {
      notice.hidden = true;
      return;
    }
    notice.append(h('span', {}, text));
    if (action) notice.append(h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: action.onClick }, action.label));
    notice.hidden = false;
    clearTimeout(setNotice.t);
    // A notice with a button ("Watch it", "Start over") stays until the viewer does something else, so there is time
    // to reach it; a plain one goes after 7 s.
    if (action) {
      const signal = noticeListeners.signal;
      const done = () => (notice.hidden = true);
      root.addEventListener('pointerdown', (e) => !notice.contains(e.target) && done(), { once: true, signal });
      root.addEventListener('keydown', (e) => !notice.contains(e.target) && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key) && done(), { once: true, signal });
      setNotice.t = setTimeout(done, 30000);
    } else setNotice.t = setTimeout(() => (notice.hidden = true), 7000);
  }

  /** A static stream (a programme from the archive) reached its end. */
  function showEnded() {
    clear(errorEl).append(h('h2', {}, 'This programme has ended'), h('button', { class: 'btn btn-primary', type: 'button', onClick: () => leave() }, 'Go back'));
    errorEl.hidden = false;
    spinnerEl.hidden = true;
    showControls(true);
  }
  /** A play() refused because a newer start (or a pause) interrupted it isn't the viewer's to press Play for. */
  const playRefused = (res) => (err) => {
    if (err?.name === 'AbortError' || destroyed || session !== res) return;
    bigPlay.hidden = false;
    spinnerEl.hidden = true;
  };
  // What the browser itself said about each failed try (v0.27.1): shown small under the sentence, for support.
  const mediaErrors = [];
  let startedAt = null; // when the latest start was asked for (performance.now())
  /** v0.28: tell the server what went wrong (it writes it to data/logs/atomix.log), since a phone has no console. */
  function reportProblem(message) {
    let src = '';
    try {
      src = video.currentSrc ? new URL(video.currentSrc, location.href).pathname : '';
    } catch {
      /* ignore */
    }
    const caps = detectCaps();
    const details = [...mediaErrors, `session ${session?.mode || '-'}/${session?.delivery || '-'}`, src && `src ${src}`, `page ${location.protocol}//${location.host}`, `caps hls:${Boolean(caps.hls)} mse:${Boolean(caps.mse)} link:${needsMediaLink()}`];
    api.post('/api/client-log', { message, details: details.filter(Boolean), itemId: liveMode ? undefined : Number(params.id) || undefined, liveChannelId: liveMode ? params.live : undefined }).catch(() => {});
  }
  function showError(message) {
    clear(errorEl).append(h('h2', {}, "Can't play this right now"), h('p', {}, message));
    if (mediaErrors.length) errorEl.append(h('p', { class: 'muted small player-error-details' }, `Details: ${mediaErrors.join('; ')}`));
    reportProblem(message);
    // v0.27: an encrypted channel on a plain (http) page: the secure address plays it, if there is one.
    if (message === NEED_SECURE) {
      const secureUrl = state.status?.secureUrl;
      if (secureUrl) errorEl.append(h('p', {}, h('a', { class: 'btn btn-primary', href: `${secureUrl}/${location.hash}` }, 'Open the secure address')));
      else errorEl.append(h('p', { class: 'muted' }, 'Ask the admin to turn on the secure address (Settings → Server)'));
    }
    // v0.27: a phone that can't play this channel's protection can send it to a Chromecast or Google TV.
    const tvFor = (message === NO_WIDEVINE_IPHONE || message === NO_WIDEVINE || ((message === NO_PROTECTION_IOS || message === NO_COMMON_SYSTEM) && castableDrm(protectionOf(zapTarget ?? tvChannel?.id ?? Number(params.live)) ?? tvChannel?.drm))) && liveMode && globalThis.matchMedia?.('(pointer: coarse)').matches ? zapTarget ?? tvChannel?.id ?? Number(params.live) : null;
    if (tvFor != null) errorEl.append(h('p', {}, h('button', { class: 'btn btn-primary', type: 'button', onClick: () => openCastPicker({ liveChannelId: tvFor }, { encrypted: true }) }, icon('cast', { size: 20 }), ' Watch on TV')));
    errorEl.append(h('button', { class: `btn ${(message === NEED_SECURE && state.status?.secureUrl) || tvFor != null ? 'btn-secondary' : 'btn-primary'}`, type: 'button', onClick: () => leave() }, 'Go back'));
    errorEl.hidden = false;
    spinnerEl.hidden = true;
    showControls(true);
  }

  // ---- Controls visibility ----
  function showControls(sticky = false) {
    root.dataset.controls = 'visible';
    clearTimeout(hideTimer);
    if (!sticky && !video.paused) hideTimer = setTimeout(hideControls, 3200);
  }
  function hideControls() {
    if (video.paused || !menu.hidden || scrubbing) return;
    root.dataset.controls = 'hidden';
    if (controls.contains(document.activeElement) || top.contains(document.activeElement)) root.focus({ preventScroll: true });
  }
  root.addEventListener('pointermove', () => showControls());
  let menuJustClosed = false;
  root.addEventListener('pointerdown', (e) => {
    if (menuJustClosed) {
      menuJustClosed = false; // this click only dismissed a menu
      return;
    }
    if (e.target === video || e.target === root || e.target === subLayer) {
      if (e.pointerType === 'mouse') togglePlay();
      else if (root.dataset.controls === 'hidden') showControls();
      else hideControls();
    }
  });
  video.addEventListener('dblclick', () => toggleFullscreen());

  // ---- Playback ----
  async function togglePlay() {
    if (video.paused) {
      together?.localPlay(); // in a room, the room starts it for everyone
      try {
        await video.play();
      } catch {
        bigPlay.hidden = false;
      }
    } else {
      video.pause();
      together?.localPause();
    }
  }
  // A live conversion from the buffer: time spent paused is time behind live.
  video.addEventListener('pause', () => {
    if (liveMode && !dash && session?.rewind && !convPausedAt) convPausedAt = Date.now();
  });
  video.addEventListener('play', () => {
    if (convPausedAt) convPaused += (Date.now() - convPausedAt) / 1000;
    convPausedAt = 0;
  });
  bigPlay.addEventListener('click', () => {
    bigPlay.hidden = true;
    video.play().catch(() => {});
  });

  function updatePlayState() {
    const paused = video.paused;
    clear(playBtn).append(icon(paused ? 'play' : 'pause', { size: 24 }));
    playBtn.setAttribute('aria-label', paused ? 'Play (Space)' : 'Pause (Space)');
    if (paused) showControls(true);
    else {
      bigPlay.hidden = true;
      showControls();
    }
  }

  // ---- A download on this device (v0.21) ----
  let offStore = null;
  let offProfile = null;
  /** The answer the server would give, made from the download's own entry: its file, subtitles, saved place and the
   *  next downloaded episode of the show. */
  async function offlineSession(start, resume) {
    const [{ openStore }, { downloads }, { isExpired }] = await Promise.all([import('../offline/store.js'), import('../offline/downloader.js'), import('../offline/sync.js')]);
    offStore ||= await openStore();
    offProfile = state.profile?.id ?? downloads.profileId;
    const e = await offStore.get(offProfile, Number(params.id));
    if (!e || !['ready', 'expired'].includes(e.status)) throw new Error("This download isn't on this device any more.");
    if (isExpired(e)) throw new Error('Connect to Atomix to keep this download');
    let next = null;
    if (e.kind === 'episode') {
      const eps = (await offStore.list(offProfile))
        .filter((x) => x.kind === 'episode' && x.status === 'ready' && x.showId === e.showId)
        .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
      const n = eps[eps.findIndex((x) => x.itemId === e.itemId) + 1];
      if (n && n.itemId !== e.itemId) next = { id: n.itemId, title: n.title, season: n.season, episode: n.episode, duration: n.duration };
    }
    const at = resume ? Number(e.position) || 0 : Math.max(0, start || 0);
    return {
      offline: true,
      mode: 'direct',
      delivery: 'file',
      url: offStore.fileUrl(e),
      item: { id: e.itemId, kind: e.kind, title: e.title, year: e.year, season: e.season, episode: e.episode, showId: e.showId, parentId: e.parentId, duration: e.duration },
      show: e.showTitle ? { id: e.showId, title: e.showTitle } : null,
      duration: e.duration || 0,
      start: at,
      resumed: resume && at > 0,
      subtitles: (e.subtitles || []).map((t) => ({ id: t.id, label: t.label, language: t.language, kind: 'text', url: offStore.fileUrl(e, `${e.itemId}.${t.id}.vtt`) })),
      audioTracks: [],
      quality: e.quality ? String(e.quality) : 'original',
      reasons: ['Playing the download on this device'],
      next,
    };
  }
  /** Where the download is: kept on its entry (the next play resumes there) and queued for the server. */
  function saveOffline(position, total) {
    if (!offStore || offProfile == null) return;
    const itemId = Number(params.id);
    offStore.patch(offProfile, itemId, { position }).catch(() => {});
    offStore.queueProgress({ profileId: offProfile, itemId, position, duration: total, at: Date.now() }).catch(() => {});
  }

  async function startSession(start, { forceTranscode = false, resume = false } = {}) {
    startedAt = performance.now();
    errorEl.hidden = true;
    spinnerEl.hidden = false;
    clearTimeout(pendingSeek);
    const body = {
      caps: detectCaps(),
      mediaLink: needsMediaLink(),
      listId: query.list ? Number(query.list) : undefined, // playing through a playlist: "next" follows it
      start: resume ? undefined : Math.max(0, start || 0),
      resume,
      audioIndex,
      quality: quality || undefined,
      burnSubtitle: burnIndex,
      audioDelay: audioDelayDirty ? audioDelay : undefined, // carried: a pagehide meanwhile doesn't send it again
      speed: speed !== 1 ? speed : undefined, // a converted stream is read ahead fast enough for it
      forceTranscode,
      replaces: session?.sessionId,
    };
    const carried = audioDelayDirty;
    audioDelayDirty = false;
    let res;
    try {
      res = offlineMode
        ? await offlineSession(start, resume)
        : catchupMode
        ? await api.post(`/api/live/programmes/${params.catchup}/play`, { caps: body.caps, mediaLink: body.mediaLink, quality: body.quality, replaces: body.replaces, from: body.start || 0 })
        : await api.post(`/api/items/${params.id}/playback`, body);
    } catch (err) {
      if (carried) audioDelayDirty = true; // not saved: the next restart (or leaving) still sends it
      seekTarget = null; // not restarting any more: Watch together hears this member is ready (it can't play)
      together?.restartFailed?.();
      showError(err.message);
      return;
    }
    if (destroyed) {
      api.post(`/api/playback/${res.sessionId}/stop`, {}).catch(() => {});
      return;
    }
    const firstSession = !session;
    session = res;
    if (!audioDelayDirty) audioDelay = Number(res.audioDelay) || 0; // a press while it started is newer (its restart follows)
    if (firstSession) subtitleDelay = Number(res.subtitleDelay) || 0; // later, this player's own value is the newer one
    bubble.setManifest(res.previews);
    item = res.item || null;
    if (catchupMode) {
      tvChannel = res.channel;
      tvProgramme = res.programme;
    }
    duration = res.duration || 0;
    offset = res.mode === 'direct' ? 0 : res.start;
    audioIndex = res.audioIndex;
    quality = res.quality;
    const modeText = res.offline ? 'Downloaded' : res.mode === 'direct' ? 'Direct play' : res.mode === 'remux' ? 'Remuxing' : 'Converting';
    modeBadge.replaceChildren(icon('info', { size: 14 }), document.createTextNode(modeText));
    modeBadge.title = modeText;
    modeBadge.dataset.mode = res.mode;
    renderInfo();
    nextBtn.hidden = !res.next;
    drawChapters();
    audioBtn.hidden = (res.audioTracks || []).length < 2;
    seekTarget = null;
    video.src = res.url;
    if (res.mode === 'direct' && res.start > 0) {
      video.addEventListener('loadedmetadata', () => (video.currentTime = res.start), { once: true });
    }
    video.play().catch(() => {
      bigPlay.hidden = false;
      spinnerEl.hidden = true;
    });
    updateTimeline();
  }

  let pendingSeek = null;
  let seekTarget = null;
  function seekTo(t, { remote = false } = {}) {
    if (liveMode) return rewindOn() ? liveSeekTo(t) : undefined;
    const total = totalDuration();
    t = Math.max(0, total ? Math.min(t, total - 1) : t);
    if (!remote) together?.localSeek(t); // the room hears about the person's own seeks, not the ones it asked for
    showControls();
    if (!isStream()) {
      video.currentTime = t;
      return;
    }
    // Converted streams can't jump around, so ask the server for a new stream
    // from t — debounced so pressing → five times only restarts ffmpeg once.
    seekTarget = t;
    updateTimeline();
    clearTimeout(pendingSeek);
    pendingSeek = setTimeout(() => startSession(t), 450);
  }

  // ---- Timeline ----
  function updateTimeline() {
    if (liveMode) return updateLiveBar();
    const total = totalDuration();
    const now = currentTime();
    if (!scrubbing) {
      seek.max = String(Math.max(1, Math.floor(total)));
      seek.value = String(Math.floor(now));
      seek.style.setProperty('--pct', total ? `${(now / total) * 100}%` : '0%');
      timeCur.textContent = formatClock(now);
    }
    timeEnd.textContent = total ? `-${formatClock(Math.max(0, total - now))}` : '';
    endsEl.textContent = total ? endsAt(Math.max(0, total - now)) || '' : '';
    if (!scrubbing) sliderText(seek, `${formatClock(now)} of ${formatClock(total)}`);
    if (!isStream() && video.buffered.length && total) {
      const end = video.buffered.end(video.buffered.length - 1);
      bufferBar.style.width = `${(end / total) * 100}%`;
    } else bufferBar.style.width = '0';
    updateIntro(now, total);
    updateCredits(now, total);
  }
  seek.addEventListener('input', () => {
    if (liveMode && rewindOn()) {
      scrubbing = true;
      const w = rwWindow();
      const t = w.start + Number(seek.value);
      timeCur.hidden = false;
      timeCur.textContent = behindText(w.live - t) || 'Live';
      showControls(true);
      return;
    }
    if (liveMode) return updateLiveBar(); // read-only: a programme's progress, not a position
    scrubbing = true;
    const t = Number(seek.value);
    timeCur.textContent = formatClock(t);
    const total = totalDuration();
    seek.style.setProperty('--pct', total ? `${(t / total) * 100}%` : '0%');
    bubble.show(t, total);
    showControls(true);
  });
  seek.addEventListener('change', () => {
    if (liveMode && rewindOn()) {
      scrubbing = false;
      return liveSeekTo(rwWindow().start + Number(seek.value));
    }
    if (liveMode) return;
    bubble.hide();
    scrubbing = false;
    seekTo(Number(seek.value));
  });

  // Mouse over the bar: preview without seeking.
  seekTrack.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || scrubbing) return;
    const rect = seekTrack.getBoundingClientRect();
    const total = totalDuration();
    if (!total || !rect.width) return;
    bubble.show(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total, total);
  });
  seekTrack.addEventListener('pointerleave', () => {
    if (!scrubbing) bubble.hide();
  });

  // ---- Scrubbing with a remote: arrows move a marker, OK (or a pause) jumps ----
  function showScrub(t) {
    scrubbing = true;
    const total = totalDuration();
    seek.value = String(Math.floor(t));
    seek.style.setProperty('--pct', total ? `${(t / total) * 100}%` : '0%');
    sliderText(seek, `Jump to ${formatClock(t)}`, { force: true });
    timeCur.textContent = formatClock(t);
    bubble.show(t, total);
    showControls(true);
  }
  const stepLabel = (dir, step) => (step > 10 ? `${dir > 0 ? '+' : '−'}${step} s` : null);
  function scrubPress(dir, e) {
    showScrub(scrubber.press(dir, { from: currentTime(), now: performance.now(), repeat: e.repeat }));
    bubble.setStep(stepLabel(dir, scrubber.lastStep));
    clearTimeout(commitTimer);
    const check = () => {
      if (scrubber.due(performance.now())) commitScrub();
      else if (scrubber.active) commitTimer = setTimeout(check, 50);
    };
    commitTimer = setTimeout(check, COMMIT_AFTER_MS);
  }
  function commitScrub() {
    clearTimeout(commitTimer);
    const t = scrubber.commit();
    scrubbing = false;
    bubble.hide();
    if (t != null) seekTo(t);
  }
  function cancelScrub() {
    clearTimeout(commitTimer);
    if (!scrubber.cancel()) return false;
    scrubbing = false;
    bubble.hide();
    updateTimeline();
    showControls();
    return true;
  }
  seek.addEventListener('blur', () => {
    if (scrubber.active) commitScrub(); // moving off the bar keeps the chosen spot
  });

  // ---- Intros and credits ----
  function updateIntro(now, total) {
    const range = skipSegment(session?.markers, now, total);
    const show = Boolean(range) && seekTarget == null && !scrubbing;
    if (range) {
      const label = range.kind === 'recap' ? 'Skip recap' : 'Skip intro';
      if (skipLabel.textContent !== label) skipLabel.textContent = label;
    }
    if (show && autoSkip && !autoSkipped.has(range.kind)) {
      autoSkipped.add(range.kind); // a recap and then the intro are each skipped once
      skipIntro({ auto: true });
      return;
    }
    if (show === skipBtn.hidden) {
      skipBtn.hidden = !show;
      if (!show && document.activeElement === skipBtn) root.focus({ preventScroll: true });
    }
    if (show) {
      // Like a TV app: OK skips. Checked on every tick, so the button also takes focus once the
      // viewer is done with the controls — but it never takes it from something they're using.
      if (document.activeElement !== skipBtn && focusIsFree(document.activeElement, root)) skipBtn.focus({ preventScroll: true });
      skipBtn.style.setProperty('--left', String(introLeft(range, now)));
    }
  }
  function skipIntro({ auto = false } = {}) {
    const range = skipSegment(session?.markers, currentTime(), totalDuration());
    if (!range) return;
    skipBtn.hidden = true;
    if (document.activeElement === skipBtn) root.focus({ preventScroll: true });
    seekTo(range.end);
    if (auto) {
      setNotice(range.kind === 'recap' ? 'Skipped recap' : 'Skipped intro', {
        label: 'Watch it',
        onClick: () => {
          autoSkip = false;
          setNotice(null);
          seekTo(range.start);
        },
      });
    }
  }
  function updateCredits(now, total) {
    const at = upNextAt(session?.markers, total);
    if (at == null || !session?.next || prefs.autoplayNext === false) return;
    if (now < at - 1) upNextCancelled = false; // seeked back to before the credits
    const step = creditsStep({ at, now, armed: creditsArmed });
    if (step.start && (seekTarget != null || scrubbing || !upNext.hidden)) return; // try again on the next tick
    creditsArmed = step.armed;
    if (step.start) startUpNext();
  }

  video.addEventListener('timeupdate', () => {
    updateTimeline();
    maybeReport();
  });
  video.addEventListener('play', updatePlayState);
  // Playing counts as being there: "Who's watching?" never interrupts a video (gate.js).
  video.addEventListener('play', () => markPlaying(true)); // the gate asks the element itself whether it's still playing
  video.addEventListener('pause', () => {
    updatePlayState();
    report();
  });
  video.addEventListener('waiting', () => (spinnerEl.hidden = false));
  video.addEventListener('playing', () => {
    spinnerEl.hidden = true;
    // v0.28: a slow start (over 4 s from pressing play) is noted in the server's log with how it was played.
    if (startedAt != null) {
      const took = (performance.now() - startedAt) / 1000;
      startedAt = null;
      if (took > 4 && !liveMode) api.post('/api/client-log', { message: `Slow start: ${took.toFixed(1)} s to the first picture`, details: [`session ${session?.mode || '-'}/${session?.delivery || '-'}`], itemId: Number(params.id) || undefined }).catch(() => {});
    }
  });
  video.addEventListener('canplay', () => (spinnerEl.hidden = true));
  video.addEventListener('loadedmetadata', updateTimeline);
  video.addEventListener('loadedmetadata', () => drawChapters());
  video.addEventListener('volumechange', () => {
    clear(muteBtn).append(icon(video.muted || video.volume === 0 ? 'mute' : 'volume', { size: 24 }));
    volume.value = String(video.muted ? 0 : video.volume);
    try {
      localStorage.setItem(VOLUME_KEY, String(video.volume));
    } catch {
      /* private mode */
    }
  });
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  });
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    if (v >= 0 && v <= 1 && localStorage.getItem(VOLUME_KEY) !== null) video.volume = v;
  } catch {
    /* ignore */
  }

  video.addEventListener('error', () => {
    if (destroyed) return;
    if (fps) return fairPlayBroke(); // v0.27: a FairPlay channel's stream broke — not a file to convert
    if (!video.getAttribute('src') || dash) return; // an encrypted channel's engine reports its own
    if (liveMode && reconnect()) return;
    const code = video.error?.code;
    const label = { direct: 'Direct play', remux: 'Remuxing', transcode: 'Converting' }[session?.mode] || session?.mode || 'Playing';
    mediaErrors.push(`${label} (${session?.delivery || '?'}): error ${code ?? '?'}${video.error?.message ? ` — ${video.error.message}` : ''}`);
    if (!isSource && session && !retried && session.mode !== 'transcode') {
      retried = true;
      setNotice("This browser couldn't play the original, so the server is converting it.");
      startSession(currentTime(), { forceTranscode: true });
      return;
    }
    showError(code === 4 ? 'The video format is not supported by this browser.' : 'The stream stopped unexpectedly. Check the server log for ffmpeg errors.');
  });

  video.addEventListener('ended', () => {
    if (dash) return showEnded(); // only a static (archive) stream ends; a live one's duration is endless
    if (fps) return fairPlayBroke(); // a live FairPlay channel doesn't end: its stream stopped
    if (liveMode && reconnect()) return;
    if (isTv) return showControls(true);
    report(true);
    if (item?.kind === 'extra') return leave(); // a trailer or featurette goes back to its film
    if (!upNext.hidden) return; // already counting down (it started at the credits)
    if (session?.next && prefs.autoplayNext !== false && !upNextCancelled) startUpNext();
    else showControls(true);
  });

  // ---- Progress reporting ----
  function report(final = false) {
    if (isSource || isTv || !session) return;
    const total = totalDuration();
    const position = reportedPosition({ position: currentTime(), duration: total, ended: final && video.ended, markers: session.markers });
    if (session.offline) {
      saveOffline(position, total);
      lastReported = Date.now();
      return;
    }
    const body = { position, duration: total, sessionId: session.sessionId, paused: video.paused };
    api.post(`/api/items/${params.id}/progress`, body, { keepalive: true }).catch(() => {});
    lastReported = Date.now();
  }
  function maybeReport() {
    if (Date.now() - lastReported > 10000) report();
  }
  // Heartbeat while paused so the server keeps the session.
  const heartbeat = setInterval(() => {
    if (video.paused && session && !isSource) report();
  }, 30000);
  // Live and catch-up keep their stream with a ping (no progress), and hear why a channel dropped or ended.
  const pinger = isTv
    ? setInterval(async () => {
        if (!session?.sessionId) return;
        const sid = session.sessionId;
        const res = await api.post(`${sessionPath(session)}/ping`, { paused: video.paused }).catch(() => null);
        if (!res || destroyed || session?.sessionId !== sid) return;
        if (res.notice) setNotice(res.notice);
        if (res.error) {
          stopDash();
          video.pause();
          video.removeAttribute('src');
          showError(res.error);
        }
      }, 10000)
    : null;

  // ---- Subtitles ----
  async function selectSubtitle(sub) {
    closeMenu();
    const needsRestart = (burnIndex != null && (!sub || sub.kind !== 'image')) || (sub && sub.kind === 'image');
    currentSub = sub;
    subsBtn.setAttribute('aria-label', `Subtitles: ${sub ? sub.label : 'off'}`);
    announce(sub ? `Subtitles: ${sub.label}` : 'Subtitles off');
    cues = [];
    subLayer.innerHTML = '';
    if (!sub) {
      if (needsRestart) {
        burnIndex = null;
        await startSession(currentTime());
      }
      return;
    }
    if (sub.kind === 'image') {
      burnIndex = sub.streamIndex;
      setNotice('Picture-based subtitles are being drawn onto the video (this needs transcoding).');
      await startSession(currentTime());
      return;
    }
    if (burnIndex != null) {
      burnIndex = null;
      await startSession(currentTime());
    }
    try {
      if (!subCache.has(sub.id)) {
        const res = await fetch(sub.url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        subCache.set(sub.id, parseVtt(await res.text()));
      }
      cues = subCache.get(sub.id);
      startSubLoop();
    } catch (err) {
      toast(`Couldn't load subtitles: ${err.message}`, { type: 'error' });
    }
  }

  let lastCueKey = '';
  function drawSubs() {
    const t = currentTime() - subtitleDelay; // a delay of +1 s shows each line a second later
    const active = cues.filter((c) => c.start <= t && c.end >= t);
    const key = active.map((c) => c.start).join(',');
    if (key !== lastCueKey) {
      lastCueKey = key;
      subLayer.innerHTML = active.map((c) => `<span class="cue">${cueHtml(c.text)}</span>`).join('');
    }
  }
  function startSubLoop() {
    cancelAnimationFrame(rafId);
    const loop = () => {
      if (destroyed || !cues.length) return;
      drawSubs();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  // ---- Speed and delays (v0.20) ----
  function applySpeed() {
    video.defaultPlaybackRate = speed; // a new stream (a restart, a seek) keeps it
    video.playbackRate = speed;
    video.preservesPitch = true;
  }
  video.addEventListener('loadedmetadata', applySpeed);
  /** Why speed can't change now, or null. */
  function speedBlocked() {
    if (together) return "Speed can't change while watching together.";
    if (liveMode && (!rewindOn() || behindSec() < 10)) return 'Pause or rewind first';
    return null;
  }
  function setSpeed(v) {
    if (v === speed) return;
    const why = speedBlocked();
    if (why && v !== 1) {
      toast(why);
      announce(why);
      return;
    }
    const was = speed;
    speed = v;
    applySpeed();
    // A converted HLS stream is read ahead just fast enough for its speed (the server's -readrate): a faster speed
    // needs a stream read faster, from where the person is now (debounced with the seeks).
    const readRate = (x) => Math.max(1.5, x + 0.5);
    if (session?.delivery === 'hls' && !liveMode && !catchupMode && !offlineMode && readRate(v) !== readRate(was)) seekTo(currentTime());
    toast(`Speed ${speedText(v)}`);
    announce(`Speed ${speedText(v)}`);
  }
  function stepSpeed(dir) {
    const i = SPEEDS.indexOf(speed);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))];
    if (next !== speed) setSpeed(next);
  }
  // Live TV from the buffer at another speed: the stream's own clock says how far behind live it is, and at the live
  // point it goes back to 1×.
  let rateTick = null;
  video.addEventListener('timeupdate', () => {
    if (!liveMode) return;
    const now = performance.now();
    const vt = video.currentTime;
    if (rateTick && !dash && session?.rewind && !video.paused && speed !== 1) {
      const dv = vt - rateTick.vt;
      if (dv >= 0 && dv < 5) convPaused += (now - rateTick.at) / 1000 - dv;
    }
    rateTick = { at: now, vt };
    if (speed > 1 && behindSec() < 3) {
      speed = 1;
      applySpeed();
      toast('Back at live: speed 1×');
      announce('Back at live: speed 1×');
    }
  });
  const canDelay = () => !isTv && !isSource && (item?.kind === 'movie' || item?.kind === 'episode');
  const canAudioDelay = () => canDelay() && !item?.remote && !offlineMode; // a connected server's stream can't be opened twice with its sign-in
  const showDelay = (cls, v) => {
    const el = menu.querySelector(`.${cls} .delay-value`);
    if (el) el.textContent = delayText(v);
  };
  /** Audio delay: the stream restarts at the same time with the audio shifted (the server remembers it). */
  function setAudioDelay(v) {
    v = Math.max(-5, Math.min(5, round1(v)));
    if (v === audioDelay || !canAudioDelay()) return;
    audioDelay = v;
    audioDelayDirty = true;
    showDelay('audio-delay-row', v);
    const msg = v ? `Audio delay ${delayText(v)}` : 'Audio delay off';
    toast(msg);
    announce(msg);
    clearTimeout(audioDelayTimer);
    audioDelayTimer = setTimeout(() => startSession(currentTime()), 450); // five presses restart the stream once
  }
  const subtitleOn = () => Boolean(currentSub) || burnIndex != null;
  /** Subtitle delay: text lines shift at once; picture subtitles drawn onto the video restart with it. */
  function setSubtitleDelay(v) {
    v = Math.max(-10, Math.min(10, round1(v)));
    if (v === subtitleDelay || !subtitleOn()) return;
    subtitleDelay = v;
    lastCueKey = null; // redraw, even when nothing is showing now
    if (cues.length) drawSubs();
    showDelay('subtitle-delay-row', v);
    const msg = v ? `Subtitles ${Math.abs(v).toFixed(1)} s ${v > 0 ? 'later' : 'earlier'}` : 'Subtitles in time';
    toast(msg);
    announce(msg);
    subSavePending = true;
    clearTimeout(subSaveTimer);
    subSaveTimer = setTimeout(async () => {
      await saveSubtitleDelay();
      if (burnIndex != null && !destroyed) startSession(currentTime());
    }, 450);
  }
  async function saveSubtitleDelay() {
    if (!subSavePending) return;
    subSavePending = false;
    if (!canDelay() || offlineMode) return; // a download keeps no server settings
    await api.put(`/api/items/${item.id}/play-settings`, { subtitleDelay }, { keepalive: true }).catch((err) => toast(err.message, { type: 'error' }));
  }

  // ---- Chapters (v0.20) ----
  const chapters = () => (isTv ? [] : session?.chapters || []);
  /** The index of the chapter playing at t (-1 before the first). */
  function chapterAt(t) {
    const list = chapters();
    let i = -1;
    list.forEach((c, k) => {
      if (c.start <= t + 0.5) i = k;
    });
    return i;
  }
  function drawChapters() {
    const list = chapters();
    const total = totalDuration();
    chaptersBtn.hidden = !list.length;
    clear(chapterTicks);
    if (!total) return;
    for (const c of list) if (c.start > 0.5 && c.start < total) chapterTicks.append(h('span', { class: 'chapter-tick', style: `left: ${((c.start / total) * 100).toFixed(3)}%` }));
  }
  /** A row: the preview picture (when the title has previews), the name and the time. */
  function chapterItem(c, checked) {
    const tile = tileFor(session?.previews, c.start + Math.min(5, (c.end - c.start) / 2));
    let pic = null;
    if (tile) {
      const w = 96;
      const scale = w / tile.width;
      pic = h('span', { class: 'chapter-pic', 'aria-hidden': 'true', style: `width: ${w}px; aspect-ratio: ${tile.width} / ${tile.height}; background-image: url("${tile.url}"); background-size: ${tile.sheetWidth * scale}px ${tile.sheetHeight * scale}px; background-position: ${-tile.x * scale}px ${-tile.y * scale}px` });
    }
    return h(
      'button',
      {
        type: 'button',
        role: 'menuitemradio',
        class: 'menu-item chapter-item',
        'aria-checked': String(checked),
        onClick: () => {
          closeMenu();
          goChapter(c);
        },
      },
      h('span', { class: 'menu-check' }, checked ? icon('check', { size: 16 }) : null),
      pic,
      h('span', { class: 'chapter-name' }, c.title),
      h('small', {}, formatClock(c.start)),
    );
  }
  function goChapter(c) {
    announce(`${c.title}, ${formatClock(c.start)}`);
    seekTo(c.start);
  }
  /** PageDown → the next chapter; PageUp → this one's start, or the previous one within 3 s of it. */
  function stepChapter(dir) {
    const list = chapters();
    if (!list.length) return false;
    const t = currentTime();
    const i = chapterAt(t);
    if (dir > 0) {
      const next = list[i + 1];
      if (next) goChapter(next);
      return true;
    }
    const cur = list[Math.max(0, i)];
    goChapter(i > 0 && t - cur.start < 3 ? list[i - 1] : cur);
    return true;
  }

  // ---- Menus ----
  let openMenu = null;
  const menuOpeners = { subs: subsBtn, audio: audioBtn, quality: qualityBtn, online: subsBtn, chapters: chaptersBtn };
  function closeMenu() {
    // A picked online result disables itself while it downloads, which drops focus to the page: that counts too.
    const refocus = menu.contains(document.activeElement) || document.activeElement === document.body;
    const opener = menuOpeners[openMenu];
    for (const b of [subsBtn, audioBtn, qualityBtn, chaptersBtn]) b.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    openMenu = null;
    showControls();
    // At phone width the opener (Quality) is hidden and reached through More controls: focus goes back there.
    if (refocus) (opener?.offsetParent ? opener : moreBtn)?.focus({ preventScroll: true });
  }
  /** A line in a menu that isn't a choice: a disabled item, so screen readers read it as part of the menu. */
  function menuNote(text) {
    return h('div', { role: 'none', class: 'menu-empty' }, h('span', { role: 'menuitem', 'aria-disabled': 'true', tabindex: '-1' }, text));
  }
  function menuItem(label, checked, onClick, detail) {
    return h('button', { type: 'button', role: 'menuitemradio', class: 'menu-item', 'aria-checked': String(Boolean(checked)), onClick }, h('span', { class: 'menu-check' }, checked ? icon('check', { size: 16 }) : null), h('span', {}, label), detail ? h('small', {}, detail) : null);
  }
  /** A labelled section of a menu (its heading is presentation; the group carries the name). */
  function menuGroup(cls, label, children) {
    return h('div', { role: 'group', class: `menu-group ${cls}`, 'aria-label': label }, h('p', { class: 'menu-heading', role: 'presentation' }, label), children);
  }
  /** −, the value, +, Reset: Left/Right move along it, Up/Down leave it. */
  function delayRow(cls, label, value, onStep, onReset) {
    const name = label.toLowerCase();
    return menuGroup(`delay-row ${cls}`, label, [
      h(
        'div',
        { class: 'delay-controls', role: 'none' },
        h('button', { type: 'button', role: 'menuitem', class: 'menu-item delay-step', 'aria-label': `Less ${name}`, onClick: () => onStep(-0.1) }, '−'),
        h('span', { class: 'delay-value', role: 'menuitem', 'aria-disabled': 'true', tabindex: '-1' }, delayText(value)),
        h('button', { type: 'button', role: 'menuitem', class: 'menu-item delay-step', 'aria-label': `More ${name}`, onClick: () => onStep(0.1) }, '+'),
        h('button', { type: 'button', role: 'menuitem', class: 'menu-item delay-reset', 'aria-label': `Reset ${name}`, onClick: () => onReset() }, 'Reset'),
      ),
    ]);
  }
  function toggleMenu(kind) {
    if (openMenu === kind) return closeMenu();
    openMenu = kind;
    clear(menu);
    if (kind === 'subs') {
      menu.append(menuTitle('Subtitles'), menuItem('Off', !currentSub, () => selectSubtitle(null)));
      for (const s of session?.subtitles || []) menu.append(menuItem(s.label, currentSub?.id === s.id, () => selectSubtitle(s), s.source === 'external' ? 'File' : null));
      if (!(session?.subtitles || []).length) menu.append(menuNote('No subtitles found for this video.'));
      if (!session?.subtitleProviders?.length && canAdmin() && !offlineMode) menu.append(menuNote('Online subtitles are off — turn them on in Settings → Plugins.'));
      if (session?.subtitleProviders?.length) {
        menu.append(h('div', { class: 'menu-sep', role: 'separator' }), h('button', { type: 'button', role: 'menuitem', class: 'menu-item menu-action', onClick: () => searchOnline() }, h('span', { class: 'menu-check', 'aria-hidden': 'true' }, icon('search', { size: 16 })), h('span', {}, 'Find subtitles online…')));
      }
      if (subtitleOn()) menu.append(delayRow('subtitle-delay-row', 'Subtitle delay', subtitleDelay, (d) => setSubtitleDelay(subtitleDelay + d), () => setSubtitleDelay(0)));
    } else if (kind === 'chapters') {
      menu.append(menuTitle('Chapters'));
      const now = chapterAt(currentTime());
      chapters().forEach((c, i) => menu.append(chapterItem(c, i === now)));
    } else if (kind === 'audio') {
      menu.append(menuTitle('Audio'));
      for (const a of session?.audioTracks || []) {
        const label = [a.title, a.language?.toUpperCase(), a.codec?.toUpperCase(), a.channels ? `${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels + 'ch'}` : null].filter(Boolean).join(' · ');
        menu.append(
          menuItem(label || `Track ${a.index + 1}`, a.index === audioIndex, async () => {
            closeMenu();
            if (a.index === audioIndex) return;
            audioIndex = a.index;
            await startSession(currentTime());
          }),
        );
      }
    } else if (kind === 'quality') {
      // Playback settings: Quality (not for an add-on's own stream), Speed, and Audio delay (films and episodes).
      menu.append(menuTitle('Playback settings'));
      if (dash) {
        // An encrypted channel: the stream's own levels (the browser decrypts it, so nothing is converted).
        const levels = [['auto', 'Auto', 'Follows your connection'], ...dashLevels.map((l) => [l.id, l.height ? `${l.height}p` : `${Math.round(l.bandwidth / 1000)} kb/s`, `${(l.bandwidth / 1e6).toFixed(1)} Mb/s`])];
        menu.append(
          menuGroup('quality-row', 'Quality', levels.map(([value, label, detail]) =>
            menuItem(label, dash.level === value, () => {
              closeMenu();
              dash?.setLevel(value);
              announce(`Quality: ${label}`);
            }, detail),
          )),
        );
      } else if (!isSource && !offlineMode) {
        menu.append(
          menuGroup('quality-row', 'Quality', QUALITIES.map(([value, label]) =>
            menuItem(label, quality === value, async () => {
              closeMenu();
              if (quality === value) return;
              quality = value;
              await startSession(currentTime());
            }, value === 'original' ? 'Best, may convert' : 'Converted'),
          )),
        );
      }
      const blocked = speedBlocked();
      const speedItems = SPEEDS.map((v) => {
        const b = menuItem(speedText(v), speed === v, () => {
          closeMenu();
          setSpeed(v);
        });
        if (blocked) b.setAttribute('aria-disabled', 'true');
        return b;
      });
      menu.append(menuGroup('speed-row', 'Speed', [h('div', { class: 'speed-choices', role: 'none' }, speedItems), blocked ? menuNote(blocked) : null]));
      if (canAudioDelay()) menu.append(delayRow('audio-delay-row', 'Audio delay', audioDelay, (d) => setAudioDelay(audioDelay + d), () => setAudioDelay(0)));
    }
    menu.setAttribute('role', 'menu');
    menu.removeAttribute('aria-label');
    menu.hidden = false;
    menuOpeners[kind]?.setAttribute('aria-expanded', 'true');
    showControls(true);
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
  }
  document.addEventListener('pointerdown', onOutside, true);
  function onOutside(e) {
    if (!menu.hidden && !menu.contains(e.target) && ![subsBtn, audioBtn, qualityBtn, chaptersBtn].some((b) => b.contains(e.target))) {
      closeMenu();
      menuJustClosed = true;
    }
  }

  // Search plugins (e.g. OpenSubtitles) and download a subtitle without leaving the player.
  async function searchOnline() {
    openMenu = 'online';
    const wanted = (prefs.subtitleLanguage || navigator.language || 'en').slice(0, 2).toLowerCase();
    const langInput = h('input', { class: 'menu-lang', value: wanted, maxlength: 12, 'aria-label': 'Languages (e.g. en,fr)' });
    const results = h('div', { class: 'menu-results' });
    const run = async () => {
      clear(results).append(h('p', { class: 'menu-empty' }, 'Searching…'));
      try {
        const data = await api.get(`/api/items/${params.id}/subtitles/search?languages=${encodeURIComponent(langInput.value)}`);
        clear(results);
        if (!data.results.length) {
          results.append(h('p', { class: 'menu-empty' }, data.errors?.[0]?.error || 'Nothing found. Try another language.'));
          return;
        }
        for (const r of data.results.slice(0, 20)) {
          const detail = [r.language?.toUpperCase(), r.hashMatch ? 'exact match' : null, r.hearingImpaired ? 'SDH' : null, r.downloads ? `${r.downloads.toLocaleString()} downloads` : null].filter(Boolean).join(' · ');
          results.append(
            h(
              'button',
              {
                type: 'button',
                class: 'menu-item',
                onClick: async (e) => {
                  const btn = e.currentTarget; // currentTarget is gone after the first await
                  btn.disabled = true;
                  try {
                    const got = await api.post(`/api/items/${params.id}/subtitles/download`, { provider: r.provider, id: r.id });
                    session.subtitles = got.subtitles;
                    toast('Subtitles downloaded', { type: 'success' });
                    await selectSubtitle(got.subtitle);
                  } catch (err) {
                    toast(err.message, { type: 'error' });
                    btn.disabled = false;
                  }
                },
              },
              h('span', { class: 'menu-check' }, r.hashMatch ? icon('check', { size: 16 }) : null),
              h('span', { class: 'menu-result-label' }, r.label || 'Subtitle'),
              h('small', {}, detail),
            ),
          );
        }
        results.querySelector('button')?.focus();
      } catch (err) {
        clear(results).append(h('p', { class: 'menu-empty' }, err.message));
      }
    };
    langInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    // A search box and its results are a small dialog, not a menu (a menu can't hold a text field).
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Find subtitles online');
    clear(menu).append(h('p', { class: 'menu-title', id: 'player-menu-title' }, 'Find subtitles online'), h('div', { class: 'menu-search' }, langInput, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: run }, 'Search')), results);
    menu.hidden = false;
    showControls(true);
    run();
  }

  function renderInfo() {
    clear(infoEl);
    if (!session) return;
    // dom.js append() skips nulls (the native one would print "null").
    append(infoEl, [
      h('h2', {}, session.delivery === 'drm' ? `Encrypted (${systemName(session)})` : MODE_LABEL[session.mode] || session.mode),
      h('p', {}, session.delivery === 'drm' ? `Delivery: encrypted ${systemOf(session) === 'fairplay' ? 'HLS' : 'DASH'}, played by the browser (${systemName(session)}) · Quality: ${dash?.level === 'auto' || !dash ? 'Auto' : `${dashLevels.find((l) => l.id === dash.level)?.height || ''}p`}${dash?.ahead === 10 ? ' · Buffer: 10 s ahead (mobile data)' : ''}` : `Delivery: ${session.delivery === 'file' ? 'original file' : session.delivery === 'hls' ? 'HLS' : 'MP4 stream'} · Quality: ${session.quality === 'original' ? 'original' : `${session.quality}p`}`),
      session.reasons?.length ? h('ul', {}, session.reasons.map((r) => h('li', {}, r))) : null,
    ]);
    if (liveMode) {
      const line = (label, p) => h('p', { class: 'player-info-prog' }, h('strong', {}, `${label}: `), p ? `${programmeTimes(p)} ${p.title}` : 'No guide information');
      infoEl.prepend(h('h2', {}, tvChannel ? channelLabel(tvChannel) : ''), line('Now', tvProgramme), line('Next', tvNext), tvProgramme?.description ? h('p', { class: 'muted' }, tvProgramme.description) : '');
    }
  }
  function toggleInfo() {
    if (infoEl.hidden) renderInfo();
    infoEl.hidden = !infoEl.hidden;
  }

  // ---- Fullscreen ----
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  }
  document.addEventListener('fullscreenchange', onFsChange);
  // v0.27: Live TV on a phone keeps the screen on and turns to landscape in full screen (touch devices only).
  const phone = liveMode ? phoneLive(video) : null;
  function onFsChange() {
    clear(fsBtn).append(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', { size: 24 }));
  }

  // ---- Up next ----
  function startUpNext() {
    if (together) return; // in a room, the room decides: the strip offers the next episode for everyone
    upNextCancelled = false;
    const next = session.next;
    let left = 10;
    const count = h('span', { class: 'upnext-count' }, String(left));
    // Orbit also shows the episode's picture, the show and its length, and a ring round Play now that
    // empties as the countdown runs (older themes hide those three).
    const ring = h('span', { class: 'upnext-ring', 'aria-hidden': 'true', style: { '--left': '1' } });
    const length = formatRuntime(next.runtime || (next.duration ? next.duration / 60 : null));
    append(clear(upNext), [
      // The episode's picture, else the show's; with neither, the tinted placeholder the episode rows use.
      h('div', { class: 'upnext-art' }, art(next.poster || session.show?.backdrop, next.title, { kind: 'landscape', eager: true })),
      h('p', { class: 'eyebrow' }, 'Up next'),
      h('h2', {}, `${episodeLabel(next)} · ${next.title}`),
      h('p', { class: 'upnext-meta muted' }, [session.show?.title, length].filter(Boolean).join(', ')),
      h('p', { class: 'muted', 'aria-hidden': 'true' }, 'Starting in ', count, ' s'), // the ticking number isn't read; one sentence is (below)
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => playNext(), 'data-autofocus': true }, ring, icon('play'), h('span', {}, 'Play now')),
        h('button', { class: 'btn btn-secondary', type: 'button', onClick: cancelUpNext }, 'Keep watching'),
      ),
    ]);
    upNext.hidden = false;
    upNext.classList.remove('is-live');
    void upNext.offsetWidth; // restart the ring's sweep from the top each time the card shows
    upNext.classList.add('is-live');
    upNext.querySelector('[data-autofocus]').focus();
    announce(`Up next: ${episodeLabel(next)} ${next.title}. Starting in 10 seconds`);
    upNextTimer = setInterval(() => {
      left--;
      count.textContent = String(left);
      ring.style.setProperty('--left', String(Math.max(0, left) / 10));
      if (left <= 0) playNext();
    }, 1000);
  }
  function cancelUpNext() {
    if (upNextAt(session?.markers, totalDuration()) != null) upNextCancelled = true;
    clearInterval(upNextTimer);
    upNext.hidden = true;
    upNext.classList.remove('is-live');
    showControls(true);
  }
  function playNext() {
    if (together) {
      const nextId = together.next() ?? session?.next?.id;
      if (nextId) together.act('next', { itemId: nextId });
      return;
    }
    clearInterval(upNextTimer);
    if (session?.next && offlineMode) navigate(`#/play/${session.next.id}?offline=1`, { replace: true });
    else if (session?.next) navigate(`#/play/${session.next.id}${session.listId ? `?list=${session.listId}` : ''}`, { replace: true });
  }

  // ---- Live TV ----
  let tvChannel = null; // the channel playing (live) or the programme's channel (catch-up)
  let tvProgramme = null; // on now (live) or the programme (catch-up)
  let tvNext = null;
  let zapTarget = null; // where channel up/down counts from: the last channel asked for, even before it starts
  let drops = []; // reconnects in the last 2 minutes
  let dash = null; // the encrypted channel's engine (DashPlayer), when one is playing
  let dashLevels = [];
  let dashReleased = null; // the last encrypted engine's keys being released
  let fps = null; // a FairPlay channel's player (dash/fairplay.js, Safari), when one is playing (v0.27)
  function stopDash() {
    if (dash) dashReleased = dash.destroy();
    dash = null;
    dashLevels = [];
    if (fps) dashReleased = fps.close();
    fps = null;
  }
  let programmeTimer = null;
  let programmeTick = null;

  function drawTvTitle() {
    clear(titleEl);
    if (liveMode) {
      append(titleEl, [h('h1', {}, tvChannel ? channelLabel(tvChannel) : ''), h('p', {}, tvProgramme ? `${tvProgramme.title} · ${programmeTimes(tvProgramme)}` : 'No guide information')]);
      setTitle(tvChannel ? `${tvChannel.name}${tvProgramme ? ` · ${tvProgramme.title}` : ''}` : 'Live TV');
    } else {
      append(titleEl, [h('h1', {}, tvProgramme?.title || ''), h('p', {}, [tvChannel?.name, tvProgramme ? `${new Date(tvProgramme.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${programmeTimes(tvProgramme)}` : null].filter(Boolean).join(' · '))]);
      setTitle(`${tvProgramme?.title || 'Catch-up'} · ${tvChannel?.name || ''}`);
      watchLiveBtn.hidden = !(tvProgramme && tvProgramme.end > Date.now());
    }
    if (!infoEl.hidden) renderInfo();
  }

  /** Live: the bar is how far through the programme on now we are. */
  function updateLiveBar() {
    if (rewindOn()) updateRewindBar();
    const now = nowAt();
    const p = tvProgramme;
    const frac = p ? programmeProgress(p, now) : 0;
    endsEl.textContent = p ? `until ${clockTime(p.end)}` : '';
    if (rewindOn()) return;
    seek.max = '1000';
    seek.value = String(Math.round(frac * 1000));
    seek.style.setProperty('--pct', `${frac * 100}%`);
    sliderText(seek, p ? `${minutes(now - p.start)} into ${p.title}, ${minutes(p.end - now)} left` : 'No guide information');
  }

  // ---- Pause and rewind on live TV (v0.19): the tuner's 30-minute buffer, or an encrypted channel's own window ----
  // Positions are in the window's own seconds: the engine's presentation time (dash, drm), or 0–1800 for a
  // conversion from the buffer (1800 = live; rewinding restarts the conversion `behind` seconds back).
  
  function rewindOn() {
    return Boolean(liveMode && session && (dash || session.rewind) && session.sessionId);
  }
  function rwWindow() {
    if (dash) return dash.window() || { start: 0, live: 0, end: 0 };
    return { start: 0, live: 1800, end: 1800 };
  }
  function behindSec() {
    if (!rewindOn()) return 0;
    if (dash) {
      const w = dash.window();
      // Before the first picture the video's clock isn't the stream's yet: nothing to say.
      if (!w || video.readyState < 1) return 0;
      return Math.max(0, Math.min(w.live - w.start, w.live - (video.currentTime || 0)));
    }
    // A conversion falls further behind while paused (the stream it reads keeps going).
    const pausedNow = convPausedAt ? (Date.now() - convPausedAt) / 1000 : 0;
    return Math.max(0, Math.min(1800, convBehind + convPaused + pausedNow));
  }
  function rwPos() {
    return rwWindow().live - behindSec();
  }
  /** The wall-clock time of what's on screen (the guide follows the playhead when behind live). */
  function nowAt() {
    return Date.now() - behindSec() * 1000;
  }
  function behindText(sec) {
    return sec >= 10 ? `−${formatClock(sec)}` : '';
  }
  let pendingLiveSeek = null;
  function liveSeekTo(pos) {
    showControls();
    const w = rwWindow();
    const to = Math.max(w.start, Math.min(w.live, pos));
    if (dash) {
      dash.seek(to);
      return updateLiveBar();
    }
    // A conversion: started again from that point (debounced, so five presses restart ffmpeg once).
    const behind = Math.round(w.live - to);
    clearTimeout(pendingLiveSeek);
    pendingLiveSeek = setTimeout(() => restartConversion(behind), 450);
  }
  async function restartConversion(behind) {
    if (!tvChannel) return;
    const id = tvChannel.id;
    spinnerEl.hidden = false;
    let res;
    try {
      res = await api.post(`/api/live/channels/${id}/play`, { caps: detectCaps(), mediaLink: needsMediaLink(), quality: quality || undefined, replaces: session?.sessionId, behind });
    } catch (err) {
      return showError(err.message);
    }
    if (destroyed || tvChannel?.id !== id) return api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
    applyLive(res, { retry: true });
  }
  /** Back to 1× (a zap, Go live): a speed belongs to the moment it was chosen for. */
  function normalSpeed() {
    if (speed === 1) return;
    speed = 1;
    applySpeed();
  }
  function goLive() {
    normalSpeed();
    if (dash) return liveSeekTo(rwWindow().live);
    restartConversion(0);
  }
  function updateRewindBar() {
    const w = rwWindow();
    const span = Math.max(1, w.live - w.start);
    const behind = behindSec();
    if (!scrubbing) {
      seek.max = String(Math.floor(span));
      seek.value = String(Math.floor(span - behind));
      seek.style.setProperty('--pct', `${((span - behind) / span) * 100}%`);
      timeCur.textContent = behindText(behind);
      timeCur.hidden = !timeCur.textContent;
      sliderText(seek, behind >= 10 ? `${formatClock(behind)} behind live` : 'Live');
    }
    goLiveBtn.hidden = behind < 10;
    liveBadge.classList.toggle('is-behind', behind >= 10);
  }
  /** The seek bar and buttons for a session that can (or can't) rewind. */
  function setRewindUi() {
    const on = rewindOn();
    backBtn.hidden = fwdBtn.hidden = !on;
    if (on) seek.removeAttribute('aria-readonly');
    else seek.setAttribute('aria-readonly', 'true');
    seek.tabIndex = on ? 0 : -1;
    seek.setAttribute('aria-label', on ? 'Seek (live)' : 'Programme progress');
    if (!on) {
      timeCur.hidden = true;
      goLiveBtn.hidden = true;
    }
  }

  /** Now and next for the channel; a reply older than the page's clock (the programme already over) is ignored. */
  async function refreshProgramme() {
    if (!tvChannel) return;
    const id = tvChannel.id;
    const t = Date.now();
    let list = [];
    try {
      const g = await fetchGuide(t, t + 4 * 3600_000, [id]);
      list = (g.programmes?.[id] || []).sort((a, b) => a.start - b.start);
    } catch {
      return;
    }
    if (destroyed || tvChannel?.id !== id) return;
    const at = Date.now();
    const i = list.findIndex((p) => p.start <= at && at < p.end);
    const now = i >= 0 ? list[i] : null;
    if (!now && tvProgramme && tvProgramme.end > at) return; // the guide hasn't caught up: keep what we have
    tvProgramme = now;
    tvNext = i >= 0 ? list[i + 1] || null : list.find((p) => p.start > at) || null;
    drawTvTitle();
    updateLiveBar();
    scheduleProgramme();
  }
  /** At the programme's end the next one takes over at once (then the guide is asked); each minute the guide is re-read. */
  function scheduleProgramme() {
    clearTimeout(programmeTimer);
    if (tvProgramme) programmeTimer = setTimeout(checkProgramme, Math.max(1000, tvProgramme.end - nowAt() + 500));
  }
  function checkProgramme() {
    if (!liveMode || !tvProgramme || nowAt() < tvProgramme.end) return;
    tvProgramme = takeOver(tvNext, nowAt());
    tvNext = null;
    drawTvTitle();
    updateLiveBar();
    refreshProgramme();
  }
  if (liveMode) {
    let minute = 0;
    programmeTick = setInterval(() => {
      checkProgramme(); // also catches a clock that jumped (a laptop waking up)
      updateLiveBar();
      if (++minute % 12 === 0) refreshProgramme();
    }, 5000);
  }

  function applyLive(res, { retry = false } = {}) {
    session = res;
    duration = 0;
    offset = 0;
    if (!retry) drops = []; // a restart after a drop keeps counting against the 3-in-2-minutes budget
    tvChannel = res.channel;
    tvProgramme = res.programme;
    tvNext = res.next;
    zapTarget = tvChannel.id;
    quality = res.quality;
    errorEl.hidden = true;
    stopDash();
    castBtn.hidden = isSource || (Boolean(tvChannel.drm) && !castableDrm(tvChannel.drm)); // v0.27: FairPlay can't be cast
    const modeText = res.delivery === 'drm' ? 'Encrypted' : res.mode === 'remux' ? 'Remuxing' : 'Converting';
    modeBadge.replaceChildren(icon(res.delivery === 'drm' ? 'lock' : 'info', { size: 14 }), document.createTextNode(modeText));
    modeBadge.title = modeText;
    modeBadge.dataset.mode = res.mode;
    renderInfo();
    // The address follows the channel without re-opening the player (a reload plays this channel).
    history.replaceState(history.state, '', `#/live/play/${tvChannel.id}`);
    drawTvTitle();
    updateLiveBar();
    scheduleProgramme();
    spinnerEl.hidden = false;
    convBehind = Number(res.behind) || 0;
    convStartedAt = Date.now();
    convPaused = 0;
    convPausedAt = 0;
    setRewindUi();
    if ((res.reasons || []).includes("Rewind isn't available on this channel") && !retry) setNotice("Rewind isn't available on this channel");
    if (res.delivery === 'drm' && systemOf(res) === 'fairplay') return playFairPlayChannel(res);
    if (res.delivery === 'drm' || res.delivery === 'dash') return playEncrypted(res);
    const load = () => {
      if (destroyed || session !== res) return;
      video.src = res.url;
      video.play().catch(playRefused(res));
    };
    // After an encrypted channel the video's keys must be gone before a plain stream loads.
    if (dashReleased) dashReleased.then(load, load);
    else load();
  }
  /**
   * An encrypted channel whose stream broke (the provider's manifest or segments stopped answering): start it again,
   * with the same budget as a plain channel's reconnects (3 in 2 minutes), each try 2 s after the last failed.
   */
  function retryEncrypted(id) {
    const now = Date.now();
    drops = [...drops.filter((t) => now - t < 120_000), now];
    if (drops.length > 3) return false;
    setNotice('Lost the channel — trying again');
    spinnerEl.hidden = false;
    setTimeout(async () => {
      if (destroyed || tvChannel?.id !== id || zapTarget !== id) return;
      let res;
      try {
        res = await startChannel(id);
      } catch (err) {
        if (!destroyed && tvChannel?.id === id && (err?.verdict || !retryEncrypted(id))) refused(err);
        return;
      }
      if (destroyed || zapTarget !== id) return api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
      applyLive(res, { retry: true });
    }, 2000);
    return true;
  }
  /** An encrypted channel: the browser's key system decrypts it; Atomix relays the stream and the licence. */
  async function playEncrypted(res) {
    video.removeAttribute('src');
    const engine = await import('../dash/player.js').catch(() => null);
    if (destroyed || session !== res) return;
    if (!engine) {
      // The relay session is over too: stop it before saying so.
      api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
      session = { ...res, sessionId: null };
      return showError("This channel's stream couldn't be read");
    }
    const mine = new engine.DashPlayer(video, {
      manifest: res.manifest,
      licence: res.licence,
      keySystem: res.delivery === 'drm' ? res.keySystem : undefined, // a tuner's buffer is clear: no key system
      serverCertificate: res.serverCertificate || null,
      initData: res.initData || null,
      ahead: engine.aheadFor(navigator.connection), // v0.27: less on mobile data
      timeUrl: res.timeUrl || `${sessionPath(res)}/time`,
      onNotice: (sentence) => setNotice(sentence),
      onLevels: (levels) => {
        dashLevels = levels;
        if (openMenu === 'quality' && dash === mine) {
          openMenu = null;
          toggleMenu('quality'); // redraw the open Quality menu with the new levels
        }
      },
      onStall: (on) => (spinnerEl.hidden = !on),
      onError: (sentence) => {
        if (dash !== mine) return;
        // A newer channel was asked for: this engine's failure is no longer the viewer's concern.
        if (zapTarget != null && zapTarget !== res.channel.id) return;
        dash = null;
        api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
        // This session is over: the pinger mustn't hear "This channel stopped." and replace the real reason.
        if (session === res) session = { ...res, sessionId: null };
        if (sentence === "This channel's stream couldn't be read" && retryEncrypted(res.channel.id)) return;
        showError(sentence);
      },
    });
    dash = mine;
    setRewindUi();
    await mine.start();
    if (dash !== mine) return;
    video.play().catch(playRefused(res));
  }
  /**
   * A channel this device can't play was asked for (v0.27): what was playing stops too — its sound, its stream and its
   * place in the provider's limit — as a channel change would have done.
   */
  function refused(err) {
    if (err?.verdict) {
      if (session?.sessionId) {
        api.post(`${sessionPath(session)}/stop`, {}).catch(() => {});
        session = { ...session, sessionId: null };
      }
      stopDash();
      video.pause();
      if (video.getAttribute('src')) {
        video.removeAttribute('src');
        video.load();
      }
    }
    showError(err.message);
  }
  /** A FairPlay stream that broke (a playlist or piece the provider stopped giving): start it again, like DASH. */
  function fairPlayBroke() {
    const res = session;
    stopDash();
    if (res?.sessionId) api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
    if (res) session = { ...res, sessionId: null };
    if (res?.channel && retryEncrypted(res.channel.id)) return;
    showError("This channel's stream couldn't be read");
  }
  /** A FairPlay channel (v0.27): Safari plays the relayed playlist with its own FairPlay; Atomix relays the licence. */
  async function playFairPlayChannel(res) {
    video.removeAttribute('src');
    if (dashReleased) await dashReleased.catch(() => {});
    const mod = await import('../dash/fairplay.js').catch(() => null);
    if (destroyed || session !== res) return;
    const over = (sentence) => {
      api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
      if (session === res) session = { ...res, sessionId: null };
      showError(sentence);
    };
    if (!mod) return over("This channel's stream couldn't be read");
    let mine = null;
    try {
      mine = await mod.playFairPlay(video, {
        playlist: res.manifest,
        licence: res.licence,
        certificate: res.certificate,
        isStale: () => destroyed || session !== res,
        onError: (sentence) => {
          if (fps !== mine || (zapTarget != null && zapTarget !== res.channel.id)) return;
          stopDash();
          over(sentence);
        },
      });
    } catch (err) {
      if (!destroyed && session === res && err.message !== 'stopped') over(err.message);
      return;
    }
    if (destroyed || session !== res) return mine.close();
    fps = mine;
    video.play().catch(playRefused(res));
  }
  /**
   * Can this device play `drm` (a channel's systems, or one)? A sentence when it can't (dash/support.js, loaded only
   * for encrypted channels). v0.28: a single v0.27 system keeps its own sentences; a list (or PlayReady) is asked as one.
   */
  const verdictFor = async (drm) => {
    const list = Array.isArray(drm) ? drm.filter(Boolean) : drm ? [drm] : [];
    if (!list.length) return null;
    const one = list.length === 1 && ['widevine', 'fairplay', 'clearkey'].includes(list[0]);
    return (await import('../dash/support.js')).protectionVerdict(one ? list[0] : list);
  };
  /** v0.28: the key systems this device has, best first, for a multi-system (or not yet known) channel's play request. */
  const keySystemsFor = async (drm) => {
    if (drm === null) return undefined; // a plain channel: the encrypted helpers aren't loaded
    const support = await import('../dash/support.js');
    if (!support.sendsKeySystems(drm)) return undefined; // plain, or one system: the v0.27 request
    const list = await support.deviceKeySystems();
    // A plain-http page has none to name: the server picks the channel's first, and the secure-address sentence follows.
    return list.length || globalThis.isSecureContext !== false ? list : undefined;
  };
  /**
   * Start a channel (v0.27): an encrypted one this device can't play says why first and opens no stream. Before the
   * channel list has loaded (a direct link) nothing waits for it: the reply names the protection, and a stream this
   * device can't play is stopped at once.
   */
  const startChannel = async (id) => {
    const drm = channelsById.has(id) ? channelsById.get(id).drm ?? null : protectionOf(id);
    const known = drm !== undefined;
    const before = await verdictFor(drm);
    if (before) throw Object.assign(new Error(before), { verdict: true });
    const keySystems = await keySystemsFor(drm);
    const res = await api.post(`/api/live/channels/${id}/play`, { caps: detectCaps(), mediaLink: needsMediaLink(), quality: quality || undefined, replaces: session?.sessionId, keySystems });
    const after = !known && res?.delivery === 'drm' ? await verdictFor(systemOf(res)) : null;
    if (after) {
      api.post(`${sessionPath(res)}/stop`, {}).catch(() => {});
      throw Object.assign(new Error(after), { verdict: true });
    }
    return res;
  };
  // Quick presses settle on the last channel; a start that a newer press overtook is stopped at once.
  const zaps = zapQueue(startChannel, { onStale: (res) => res?.sessionId && api.post(`${sessionPath(res)}/stop`, {}).catch(() => {}) });
  function zapTo(id) {
    if (id == null) return;
    normalSpeed();
    zapTarget = id;
    closeChannels();
    setNotice(null);
    spinnerEl.hidden = false;
    const c = channelsById.get(id);
    if (c) {
      clear(titleEl).append(h('h1', {}, channelLabel(c)), h('p', {}, c.now ? c.now.title : 'No guide information'));
      announce(`${c.name}${c.now ? `, ${c.now.title}` : ''}`);
    }
    zaps
      .request(id)
      .then((res) => {
        if (res && !destroyed) applyLive(res);
        else if (res) api.post(`${sessionPath(res)}/stop`, {}, { keepalive: true }).catch(() => {});
      })
      .catch((err) => !destroyed && refused(err));
  }
  function zap(dir) {
    if (!liveMode || !channelList.length) return; // the channel list hasn't loaded: nothing to step through yet
    showControls();
    zapTo(neighbour(zapTarget ?? tvChannel?.id ?? Number(params.live), dir)); // v0.28: from the opened channel, even if it didn't start
  }
  /** A live stream that ended or broke: ask for it again (a new request restarts it), 3 times in 2 minutes. */
  function reconnect() {
    if (!session?.url || session.delivery === 'drm') return false; // the encrypted engine retries on its own
    const now = Date.now();
    drops = [...drops.filter((t) => now - t < 120_000), now];
    if (drops.length > 3) return false;
    setNotice('Lost the channel — trying again');
    spinnerEl.hidden = false;
    const url = session.url;
    setTimeout(() => {
      if (destroyed || session?.url !== url) return;
      video.src = `${url}${url.includes('?') ? '&' : '?'}retry=${now}`;
      video.play().catch(() => {});
    }, 1000);
    return true;
  }

  // The channel list over the video.
  let channelList = [];
  const channelsById = new Map();
  async function loadChannels() {
    try {
      channelList = (await fetchChannels()).filter((c) => !c.radio);
    } catch {
      return;
    }
    channelsById.clear();
    for (const c of channelList) channelsById.set(c.id, c);
    if (!zapOrder().length) setZapOrder(channelList.map((c) => c.id));
  }
  async function openChannels() {
    await loadChannels();
    const order = zapOrder();
    // v0.28: without the channels this device can't play (dimmed, opening the message card, with the switch on).
    const shown = listable(order.map((id) => channelsById.get(id)).filter(Boolean));
    clear(channelsEl).append(
      h('h2', { class: 'player-channels-title' }, 'Channels'),
      h(
        'ul',
        { class: 'live-list', role: 'list' },
        shown.map((c) =>
          h(
            'li',
            { class: c.unplayable ? 'live-item is-unplayable' : 'live-item' },
            h(
              'button',
              { type: 'button', class: `live-row${c.id === tvChannel?.id ? ' is-current' : ''}`, 'aria-label': c.unplayable ? `${rowName(c)}, can't play here` : rowName(c), 'aria-current': c.id === tvChannel?.id ? 'true' : null, dataset: { id: c.id }, onClick: () => (c.unplayable ? cantPlay(c) : zapTo(c.id)) },
              channelLogo(c, 'sm'),
              h('span', { class: 'live-num' }, c.number != null ? String(c.number) : ''),
              h('span', { class: 'live-main' }, h('span', { class: 'live-name' }, c.name, lockBadge(c), c.unplayable ? h('span', { class: 'chip live-cant' }, "Can't play here") : null), h('span', { class: 'live-now muted small' }, c.now ? c.now.title : 'No guide information')),
            ),
          ),
        ),
      ),
    );
    channelsEl.hidden = false;
    channelsBtn.setAttribute('aria-expanded', 'true');
    showControls(true);
    (channelsEl.querySelector('.is-current') || channelsEl.querySelector('.live-row'))?.focus();
    channelsEl.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
  }
  /** v0.28: the message card for a channel this device can't play (no stream is asked for). */
  async function cantPlay(c) {
    closeChannels();
    await (await import('../ui/cant-play.js')).openCantPlay(c);
  }
  function closeChannels({ refocus = false } = {}) {
    if (channelsEl.hidden) return false;
    channelsEl.hidden = true;
    channelsBtn.setAttribute('aria-expanded', 'false');
    if (refocus) channelsBtn.focus({ preventScroll: true });
    showControls();
    return true;
  }

  // ---- Keyboard / remote ----
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest?.('dialog[open]')) return; // the cast picker (or another dialog) has the keys
    const active = document.activeElement;
    // Typing in a text box (e.g. subtitle search): leave the keys alone.
    if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(active.type)))) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        root.focus();
      }
      return;
    }
    // The channel list over the video: Up/Down move through it, Enter zaps (the button's click), Back closes it.
    if (!channelsEl.hidden) {
      if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(e.key)) {
        e.preventDefault();
        closeChannels({ refocus: true });
        return;
      }
      if (channelsEl.contains(active) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const rows = [...channelsEl.querySelectorAll('.live-row')];
        rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(active) + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
        return;
      }
      if (channelsEl.contains(active) && ['ArrowLeft', 'ArrowRight', ' ', 'Enter'].includes(e.key)) return;
    }
    if (liveMode && ['PageUp', 'PageDown', 'ChannelUp', 'ChannelDown'].includes(e.key)) {
      // PageDown and Channel Up go up the channel numbers (down the list); PageUp and Channel Down come back.
      e.preventDefault();
      zap(e.key === 'PageDown' || e.key === 'ChannelUp' ? 1 : -1);
      return;
    }
    const inControls = controls.contains(active) || top.contains(active) || upNext.contains(active) || errorEl.contains(active) || notice.contains(active) || togetherStrip.contains(active);
    const onButton = inControls && active.tagName === 'BUTTON';
    showControls();
    if (liveMode && (['n', 'c'].includes(e.key) || (!rewindOn() && ['j', 'l', 'MediaFastForward', 'MediaRewind'].includes(e.key)))) return; // no seeking without a buffer
    switch (e.key) {
      case ' ':
      case 'k':
      case 'MediaPlayPause':
        if (onButton && e.key === ' ') return;
        e.preventDefault();
        togglePlay();
        break;
      case 'MediaPlay':
        together?.localPlay();
        video.play().catch(() => {});
        break;
      case 'MediaPause':
        video.pause();
        together?.localPause();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const row = !menu.hidden && active?.closest?.('.delay-controls');
        if (row) {
          e.preventDefault();
          const bs = [...row.querySelectorAll('button')];
          bs[Math.max(0, Math.min(bs.length - 1, bs.indexOf(active) + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
          return;
        }
        const speeds = !menu.hidden && active?.closest?.('.speed-choices');
        if (speeds) {
          e.preventDefault();
          const bs = [...speeds.querySelectorAll('button')];
          bs[Math.max(0, Math.min(bs.length - 1, bs.indexOf(active) + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
          return;
        }
        if (!menu.hidden) return;
        if (active === seek) {
          e.preventDefault(); // stops the slider's own step, which would seek on every press
          scrubPress(e.key === 'ArrowRight' ? 1 : -1, e);
          return;
        }
        if (onButton) {
          // Along the control buttons, or between the two Up next buttons.
          const pool = upNext.contains(active) ? upNext.querySelectorAll('button') : togetherStrip.contains(active) ? togetherStrip.querySelectorAll('button') : root.querySelectorAll('.player-controls button:not([hidden]), .player-top button, .player-notice:not([hidden]) button');
          const buttons = [...pool].filter((b) => b.offsetParent);
          const i = buttons.indexOf(active);
          const next = buttons[i + (e.key === 'ArrowRight' ? 1 : -1)];
          if (next) next.focus();
          e.preventDefault();
          return;
        }
        e.preventDefault();
        if (!liveMode || rewindOn()) seekTo(currentTime() + (e.key === 'ArrowRight' ? 10 : -10));
        break;
      }
      case 'j':
        seekTo(currentTime() - 10);
        break;
      case 'l':
        seekTo(currentTime() + 10);
        break;
      case 'MediaFastForward':
        seekTo(currentTime() + 30);
        break;
      case 'MediaRewind':
        seekTo(currentTime() - 10);
        break;
      case 'Enter':
        if (active === seek && scrubber.active) {
          e.preventDefault();
          commitScrub();
        }
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        if (!menu.hidden) {
          // One stop per row: the speeds are one row (Left/Right move along it), a delay's −/+/Reset are one row.
          const rowOf = (b) => b.closest('.speed-choices, .delay-controls') || b;
          const stops = [];
          for (const b of menu.querySelectorAll('button')) if (!stops.includes(rowOf(b))) stops.push(rowOf(b));
          const at = stops.indexOf(active ? rowOf(active) : null);
          const to = stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
          if (to && to !== rowOf(active)) (to.matches('button') ? to : to.querySelector('[aria-checked="true"]') || to.querySelector('button'))?.focus();
          return;
        }
        if (e.key === 'ArrowUp' && !inControls) {
          playBtn.focus();
          return;
        }
        // Up from the control row reaches the notice's button ("Watch it", "Start over") when one is showing.
        const noticeBtn = !notice.hidden && notice.querySelector('button');
        if (e.key === 'ArrowUp' && controls.contains(active) && noticeBtn) {
          noticeBtn.focus();
          return;
        }
        // Up from the control row (or the top bar) reaches the Watch together strip's buttons; Down comes back.
        const stripBtn = !togetherStrip.hidden && togetherStrip.querySelector('button');
        if (e.key === 'ArrowUp' && (controls.contains(active) || top.contains(active)) && stripBtn && !noticeBtn) {
          stripBtn.focus();
          return;
        }
        if (e.key === 'ArrowDown' && togetherStrip.contains(active)) {
          playBtn.focus();
          return;
        }
        if (e.key === 'ArrowDown' && notice.contains(active)) {
          playBtn.focus();
          return;
        }
        if (e.key === 'ArrowDown' && inControls) {
          root.focus();
          return;
        }
        video.volume = Math.max(0, Math.min(1, video.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)));
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'm':
        video.muted = !video.muted;
        break;
      case 'c': {
        const subs = session?.subtitles || [];
        if (!subs.length) return;
        const idx = currentSub ? subs.findIndex((s) => s.id === currentSub.id) : -1;
        selectSubtitle(idx + 1 < subs.length ? subs[idx + 1] : null);
        break;
      }
      case 'n':
        if (session?.next) playNext();
        break;
      case 'PageUp':
      case 'PageDown':
        if (isTv) return;
        if (stepChapter(e.key === 'PageDown' ? 1 : -1)) e.preventDefault();
        break;
      case '[':
      case ']':
        e.preventDefault();
        stepSpeed(e.key === ']' ? 1 : -1);
        break;
      case 'z':
      case 'Z':
      case 'x':
      case 'X':
        if (!subtitleOn()) return;
        e.preventDefault();
        setSubtitleDelay(subtitleDelay + (e.key.toLowerCase() === 'x' ? 0.1 : -0.1));
        break;
      case 'i':
        toggleInfo();
        break;
      case 'Escape':
      case 'Backspace':
      case 'BrowserBack':
      case 'GoBack':
        e.preventDefault();
        if (cancelScrub()) break;
        if (!menu.hidden) closeMenu();
        else if (!upNext.hidden) cancelUpNext();
        else leave();
        break;
      default:
    }
  }
  window.addEventListener('keydown', onKey);

  // ---- Casting: Atomix drives the TV from where this player is; the player closes to the Remote ----
  function castToTv() {
    if (liveMode) return tvChannel && (!tvChannel.drm || castableDrm(tvChannel.drm)) && openCastPicker({ liveChannelId: tvChannel.id }, { encrypted: Boolean(tvChannel.drm), onStarted: () => video.pause() });
    if (catchupMode) return openCastPicker({ catchupProgrammeId: Number(params.catchup) }, { position: Math.round(currentTime()), onStarted: () => video.pause() });
    if (!item) return;
    const subtitle = burnIndex != null ? `e${burnIndex}` : currentSub?.id || null;
    openCastPicker(
      { itemId: item.id },
      {
        position: Math.round(currentTime() * 10) / 10,
        audioIndex,
        subtitle,
        onStarted: () => video.pause(),
      },
    );
  }

  // ---- AirPlay (Safari): the Apple TV fetches the media itself, so it gets a cast link for this session ----
  let plainSrc = null;
  if (window.WebKitPlaybackTargetAvailabilityEvent && !isSource) {
    video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      airplayBtn.hidden = offlineMode || e.availability !== 'available'; // the TV can't fetch this device's own copy
    });
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', async () => {
      if (!session?.sessionId) return;
      const at = video.currentTime;
      const resume = () => {
        video.addEventListener('loadedmetadata', () => (video.currentTime = at), { once: true });
        video.play().catch(() => {});
      };
      if (video.webkitCurrentPlaybackTargetIsWireless) {
        try {
          const { token } = await api.post(`/api/playback/${session.sessionId}/cast-link`, {});
          plainSrc = session.url;
          video.src = `${session.url}${session.url.includes('?') ? '&' : '?'}cast=${encodeURIComponent(token)}`;
          resume();
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      } else if (plainSrc) {
        video.src = plainSrc;
        plainSrc = null;
        resume();
      }
    });
  }

  // ---- Watch together ----
  function openTogether() {
    if (together) return showRoomCode(together.code);
    openSheet('Watch together', [
      {
        label: 'Start a room',
        icon: 'users',
        onSelect: async () => {
          try {
            const r = await startRoom(item.id, { position: currentTime(), playing: !video.paused, listId: query.list ? Number(query.list) : null });
            startTogether(r.code, r.member);
            history.replaceState(null, '', `#/play/${item.id}?together=${r.code}&member=${encodeURIComponent(r.member)}`); // a reload rejoins
            showRoomCode(r.code);
          } catch (err) {
            toast(err.message, { type: 'error' });
          }
        },
      },
      { label: 'Join with a code', icon: 'plus', onSelect: () => joinWithCode() },
    ]);
  }
  function showRoomCode(code) {
    const link = `${location.origin}/#/together/${code}`;
    const linkEl = h('code', { class: 'together-link' }, link);
    openDialog({
      title: 'Watch together',
      body: h(
        'div',
        { class: 'stack together-share' },
        h('p', { class: 'together-code', 'aria-label': `Room code ${code.split('').join(' ')}` }, `${code.slice(0, 3)} ${code.slice(3)}`),
        h('p', { class: 'muted' }, 'Share this code or link. Anyone signed in to Atomix can join.'),
        linkEl,
        button('Copy link', {
          icon: 'check',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(link);
              toast('Link copied');
            } catch {
              const r = document.createRange();
              r.selectNodeContents(linkEl);
              getSelection().removeAllRanges();
              getSelection().addRange(r);
            }
          },
        }),
      ),
      actions: [{ label: 'Done', value: 'close', variant: 'primary' }],
    });
  }
  function joinWithCode() {
    const input = h('input', { type: 'text', name: 'togetherCode', maxlength: '6', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', class: 'code-input', 'data-autofocus': true });
    input.addEventListener('input', () => (input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    openDialog({
      title: 'Join with a code',
      body: field('Room code', input, 'The 6 letters and numbers on the screen of whoever started the room.'),
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Join', value: 'ok', variant: 'primary' }],
      onSubmit: async () => {
        const r = await joinRoom(input.value);
        navigate(`#/play/${r.itemId}?together=${r.code}&member=${encodeURIComponent(r.member)}`, { replace: true });
      },
    });
  }
  function startTogether(code, member) {
    together?.close();
    if (speed !== 1) {
      // A room plays at one speed for everyone.
      speed = 1;
      applySpeed();
    }
    together = joinTogether({
      code,
      member,
      video,
      itemId: item.id,
      currentTime: () => currentTime(),
      seekTo,
      restarting: () => seekTarget != null, // a converted stream asked to restart elsewhere, not playing from there yet
      onState: drawStrip,
      onError: (m) => toast(m, { type: 'error' }),
      onNext: (itemId) => navigate(`#/play/${itemId}?together=${code}&member=${encodeURIComponent(member)}`, { replace: true }),
      onRemoved: (sentence) => endTogether(sentence),
      onRejoined: (newMember) => {
        startTogether(code, newMember);
        history.replaceState(null, '', `#/play/${item.id}?together=${code}&member=${encodeURIComponent(newMember)}`);
      },
      onClosed: (sentence) => endTogether(sentence),
    });
    together.code = code;
  }
  function endTogether(sentence) {
    together?.close();
    together = null;
    togetherStrip.hidden = true;
    history.replaceState(null, '', `#/play/${item.id}`); // a reload no longer rejoins
    toast(sentence);
    announce(sentence);
  }
  let lastNews = '';
  function drawStrip(s) {
    togetherStrip.hidden = false;
    const news = newsLine(s);
    const nextId = s.nextItemId ?? (item.kind === 'episode' ? session?.next?.id : null);
    const next = s.ended && nextId ? button(item.kind === 'episode' && !query.list ? 'Next episode for everyone' : 'Next title for everyone', { variant: 'secondary', onClick: () => together.act('next', { itemId: nextId }) }) : null;
    clear(togetherStrip).append(
      ...[h('ul', { class: 'together-members', role: 'list', 'aria-label': 'Watching together' }, s.members.map((m) => h('li', { class: `together-member${m.ready && m.connected ? ' is-ready' : ''}` }, h('span', { class: 'together-dot', 'aria-hidden': 'true' }), m.you ? `${m.name} (you)` : m.name))),
      h('p', { class: 'together-news' }, news),
      next,
      button('Leave', {
        variant: 'ghost',
        onClick: async () => {
          await together.leave();
          together = null;
          togetherStrip.hidden = true;
          history.replaceState(null, '', `#/play/${item.id}`); // a reload no longer rejoins
          toast('You left the room');
          playBtn.focus();
        },
      })].filter(Boolean),
    );
    if (news !== lastNews) {
      lastNews = news;
      showControls();
    }
  }

  function leave() {
    if (isTv) return goBack('#/live');
    if (offlineMode) return goBack('#/downloads');
    if (query.from) return goBack(`#/item/${query.from}`);
    goBack(item?.kind === 'episode' && item.parentId ? `#/item/${item.showId}?season=${item.parentId}` : item?.kind === 'extra' ? `#/item/${item.parentId}` : item ? `#/item/${item.id}` : '#/');
  }

  // ---- Start ----
  if (liveMode) {
    state.playingItemHash = '#/live';
    qualityBtn.hidden = false;
    const listed = loadChannels().then(() => {
      const c = channelsById.get(Number(params.live));
      if (c && !session) clear(titleEl).append(h('h1', {}, channelLabel(c)), h('p', {}, c.now ? c.now.title : 'No guide information'));
    });
    // v0.28: a channel this device is known not to play (a link from Home, an old bookmark) shows the message card
    // instead of a stream, and Go back leaves the player. A fresh load (a bookmark, a shared link, a reload) knows no
    // channel's protection yet: the channel list says it first, and elsewhere than an iPhone the probe has a moment.
    // Where nothing can be hidden (a plain-http page off an iPhone), the stream is asked for at once.
    const liveId = Number(params.live);
    if (protectionOf(liveId) === undefined && mayHide()) await listed;
    const drm = protectionOf(liveId);
    if (drm && mayHide() && !deviceNow()) await deviceSoon([{ drm }]);
    if (!destroyed && unplayableHere(drm)) {
      const c = channelsById.get(liveId) || { id: liveId, name: 'This channel', drm };
      spinnerEl.hidden = true;
      await (await import('../ui/cant-play.js')).openCantPlay(c);
      if (!destroyed) leave(); // Watch on TV's picker stays open over the Live TV page
    } else if (!destroyed) {
      try {
        applyLive(await startChannel(Number(params.live)));
      } catch (err) {
        refused(err);
      }
    }
  } else if (catchupMode) {
    state.playingItemHash = '#/live/guide';
    await startSession(Number(query.t) || 0);
    if (session) drawTvTitle();
  } else if (isSource) {
    state.playingItemHash = `#/addons/${params.plugin}/${params.source}`; // where "Who's watching?" returns to
    try {
      const res = await api.post(`/api/sources/${params.plugin}/${params.source}/resolve`, { id: query.id });
      titleEl.append(h('h1', {}, res.title || query.title || 'Playing'));
      setTitle(res.title || 'Playing');
      session = { mode: 'direct', delivery: 'file', subtitles: res.subtitles || [], audioTracks: [], quality: 'original', reasons: ['Streaming from the add-on source'] };
      duration = res.duration || 0;
      modeBadge.textContent = 'Add-on';
      modeBadge.title = 'Add-on';
      renderInfo();
      video.src = res.url;
      video.play().catch(() => (bigPlay.hidden = false));
    } catch (err) {
      showError(err.message);
    }
  } else {
    // Resume from saved progress unless ?t= was given.
    if (query.t != null) await startSession(Number(query.t) || 0);
    else await startSession(0, { resume: true });
    if (!session) return cleanupFn;
    if (session.resumed && !query.together) setNotice(`Resumed at ${formatClock(session.start)}`, { label: 'Start over', onClick: () => seekTo(0) });
    togetherBtn.hidden = offlineMode || !(item.kind === 'movie' || item.kind === 'episode');
    if (query.together && query.member) startTogether(query.together, query.member);
    // Title bar
    if (item.kind === 'episode') {
      titleEl.append(h('h1', {}, session.show?.title || ''), h('p', {}, `${episodeLabel(item)} · ${item.title}`));
      state.playingItemHash = `#/item/${session.show?.id || item.id}`;
      setTitle(`${session.show?.title || ''} ${episodeLabel(item)}`);
    } else if (item.kind === 'extra') {
      append(titleEl, [h('h1', {}, item.title), h('p', {}, [item.caption, session.parent?.title].filter(Boolean).join(' · '))]);
      state.playingItemHash = `#/item/${item.parentId}`;
      setTitle(`${item.title} · ${session.parent?.title || ''}`);
    } else {
      append(titleEl, [h('h1', {}, item.title), item.year ? h('p', {}, String(item.year)) : null]);
      state.playingItemHash = `#/item/${item.id}`;
      setTitle(item.title);
    }
    // Preferred audio language
    const wantAudio = lang2(prefs.audioLanguage);
    if (wantAudio) {
      const match = session.audioTracks.find((a) => lang2(a.language) === wantAudio);
      if (match && match.index !== audioIndex) {
        audioIndex = match.index;
        await startSession(Math.max(currentTime(), session.start || 0));
      }
    }
    // Preferred / forced subtitles
    const subs = session.subtitles || [];
    const wantSub = lang2(prefs.subtitleLanguage);
    const pick = (wantSub && subs.find((s) => s.kind === 'text' && lang2(s.language) === wantSub && !s.forced)) || subs.find((s) => s.kind === 'text' && s.forced);
    if (pick) selectSubtitle(pick);
  }
  root.focus({ preventScroll: true });
  showControls();

  // Headphones and the lock screen: play/pause as the player's own button does (through the room, in Watch together).
  function setMs(on) {
    if (!('mediaSession' in navigator)) return;
    const handlers = { play: () => video.paused && togglePlay(), pause: () => !video.paused && togglePlay(), seekbackward: () => seekTo(currentTime() - 10), seekforward: () => seekTo(currentTime() + 30) };
    for (const a of Object.keys(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(a, on ? handlers[a] : null);
      } catch {
        /* not offered here */
      }
    }
  }
  if (!isTv) setMs(true);

  // A reload or a closed tab leaves no time for the route's cleanup: end the stream from here (keepalive outlives the
  // page), or it would count against the account's open streams until it idles out.
  const onPageHide = () => {
    clearTimeout(audioDelayTimer);
    clearTimeout(subSaveTimer);
    saveAudioDelay();
    saveSubtitleDelay();
    report();
    if (session?.sessionId) api.post(`${sessionPath(session)}/stop`, {}, { keepalive: true }).catch(() => {});
  };
  window.addEventListener('pagehide', onPageHide);

  /** An audio delay pressed and not yet carried by a restart (leaving within the 450 ms): saved as it is. */
  function saveAudioDelay() {
    if (!audioDelayDirty || !canAudioDelay() || !item) return;
    audioDelayDirty = false;
    api.put(`/api/items/${item.id}/play-settings`, { audioDelay }, { keepalive: true }).catch(() => {});
  }

  function cleanupFn() {
    destroyed = true;
    saveAudioDelay();
    if (!isTv) setMs(false); // the music player puts its own back when it resumes
    together?.close();
    clearTimeout(audioDelayTimer);
    clearTimeout(subSaveTimer);
    saveSubtitleDelay(); // a change made just before leaving still counts
    zaps?.cancel();
    state.playingItemHash = null;
    window.removeEventListener('pagehide', onPageHide);
    report();
    if (session?.sessionId) api.post(`${sessionPath(session)}/stop`, {}, { keepalive: true }).catch(() => {});
    stopDash();
    clearInterval(heartbeat);
    clearInterval(upNextTimer);
    clearInterval(clockTimer);
    clearInterval(pinger);
    clearInterval(programmeTick);
    clearTimeout(programmeTimer);
    clearTimeout(hideTimer);
    clearTimeout(commitTimer);
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('fullscreenchange', onFsChange);
    phone?.destroy();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  return cleanupFn;
}
