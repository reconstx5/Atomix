// Full-screen player with custom controls, subtitles, audio/quality switching,
// resume, progress sync and "up next" for TV episodes.
import { api } from '../api.js';
import { h, icon, clear, append, formatClock, formatRuntime, episodeLabel } from '../dom.js';
import { art, toast, endsAt } from '../components.js';
import { Scrubber, COMMIT_AFTER_MS } from '../scrub.js';
import { seekPreview } from '../seekpreview.js';
import { introRange, inIntro, introLeft, upNextAt, focusIsFree, creditsStep, reportedPosition } from '../markers.js';
import { state, goBack, navigate, setTitle, isOrbit } from '../app.js';
import { markPlaying } from '../gate.js';
import { detectCaps } from '../caps.js';
import { parseVtt, cueHtml } from '../vtt.js';
import { VOLUME_KEY } from '../storage.js';
import { openCastPicker } from '../cast.js';

const QUALITIES = [
  ['original', 'Original'],
  ['1080', '1080p'],
  ['720', '720p'],
  ['480', '480p'],
  ['360', '360p'],
];
const LANG3 = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', jpn: 'ja', por: 'pt', rus: 'ru', chi: 'zh', zho: 'zh', kor: 'ko', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi', mao: 'mi', mri: 'mi' };
const lang2 = (l) => (l ? LANG3[l.toLowerCase()] || l.toLowerCase().slice(0, 2) : null);
const MODE_LABEL = { direct: 'Direct play', remux: 'Remux (no quality loss)', transcode: 'Transcoding' };

export async function render(el, params, query) {
  const isSource = Boolean(params.plugin);
  const prefs = state.profile?.prefs || {};
  // x-webkit-airplay: Safari offers its AirPlay picker; the Apple TV then fetches the video itself (with a cast link).
  const video = h('video', { playsinline: true, preload: 'auto', 'aria-label': 'Video', 'x-webkit-airplay': 'allow' });
  const subLayer = h('div', { class: 'subtitle-layer', 'aria-live': 'off' });
  const spinnerEl = h('div', { class: 'player-spinner', hidden: true }, h('div', { class: 'spinner' }));
  const bigPlay = h('button', { class: 'player-bigplay', type: 'button', 'aria-label': 'Play', hidden: true }, icon('play', { size: 44 }));
  const titleEl = h('div', { class: 'player-title' });
  const notice = h('div', { class: 'player-notice', hidden: true });
  const errorEl = h('div', { class: 'player-error', hidden: true, role: 'alert' });
  const infoEl = h('div', { class: 'player-info', hidden: true });
  const upNext = h('div', { class: 'upnext', hidden: true });
  const skipBtn = h('button', { class: 'skip-intro', type: 'button', hidden: true, onClick: () => skipIntro() }, h('span', {}, 'Skip intro'), h('span', { class: 'skip-intro-bar', 'aria-hidden': 'true' }));

  const seek = h('input', { type: 'range', class: 'seekbar', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Seek' });
  const bufferBar = h('div', { class: 'seek-buffer' });
  const timeCur = h('span', { class: 'time' }, '0:00');
  const timeEnd = h('span', { class: 'time' }, '0:00');
  const seekTrack = h('div', { class: 'seek-track' }, bufferBar, seek);
  const bubble = seekPreview(seekTrack);
  const ctlBtn = (name, label, onClick, extra = {}) => h('button', { class: 'pbtn', type: 'button', 'aria-label': label, title: label, onClick, ...extra }, icon(name, { size: 24 }));
  const playBtn = ctlBtn('play', 'Play (Space)', () => togglePlay(), { class: 'pbtn pbtn-play' });
  const backBtn = ctlBtn('replay', 'Back 10 seconds', () => seekTo(currentTime() - 10));
  const fwdBtn = ctlBtn('skip', 'Forward 30 seconds', () => seekTo(currentTime() + 30));
  const muteBtn = ctlBtn('volume', 'Mute (M)', () => {
    video.muted = !video.muted;
  });
  const volume = h('input', { type: 'range', class: 'volume', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volume' });
  const nextBtn = ctlBtn('next', 'Next episode (N)', () => playNext(), { hidden: true });
  const subsBtn = ctlBtn('subtitles', 'Subtitles (C)', () => toggleMenu('subs'));
  const audioBtn = ctlBtn('audio', 'Audio track', () => toggleMenu('audio'), { hidden: true });
  const qualityBtn = ctlBtn('quality', 'Quality', () => toggleMenu('quality'));
  const fsBtn = ctlBtn('fullscreen', 'Full screen (F)', () => toggleFullscreen());
  const castBtn = ctlBtn('cast', 'Cast to a TV', () => castToTv(), { class: 'pbtn pbtn-cast', hidden: isSource });
  const airplayBtn = ctlBtn('airplay', 'AirPlay', () => video.webkitShowPlaybackTargetPicker?.(), { class: 'pbtn pbtn-airplay', hidden: true });
  const menu = h('div', { class: 'player-menu', hidden: true, role: 'menu' });
  const modeBadge = h('button', { class: 'mode-badge', type: 'button', title: 'Playback info (I)', onClick: () => toggleInfo() });

  const playGroup = h('div', { class: 'control-group' }, playBtn, backBtn, fwdBtn, h('div', { class: 'volume-wrap' }, muteBtn, volume));
  const controls = h(
    'div',
    { class: 'player-controls' },
    h('div', { class: 'seek-wrap' }, timeCur, seekTrack, timeEnd),
    h('div', { class: 'control-row' }, playGroup, h('div', { class: 'control-group' }, modeBadge, nextBtn, subsBtn, audioBtn, qualityBtn, castBtn, airplayBtn, fsBtn)),
    menu,
  );
  // Like a TV media centre: when will this finish if I keep watching?
  const endsEl = h('div', { class: 'player-ends', 'aria-live': 'off' });
  const top = h('div', { class: 'player-top' }, h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Back', title: 'Back (Esc)', onClick: () => leave() }, icon('back', { size: 26 })), titleEl, endsEl);
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
  const root = h('div', { class: 'player', tabindex: '-1', dataset: { controls: 'visible' } }, video, subLayer, spinnerEl, bigPlay, notice, errorEl, infoEl, upNext, skipBtn, top, controls);
  el.append(root);

  // ---- State ----
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
  let autoSkipped = false; // auto-skip once per play-through
  let creditsArmed = true; // Up next may start at the credits (again after seeking back)
  let upNextCancelled = false; // cancelled during the credits: don't start it again at the end
  const subCache = new Map();

  const isStream = () => session && session.mode !== 'direct' && !isSource;
  const currentTime = () => (seekTarget != null ? seekTarget : (isStream() ? offset : 0) + (video.currentTime || 0));
  const totalDuration = () => duration || (Number.isFinite(video.duration) ? video.duration : 0);
  const scrubber = new Scrubber({ duration: () => totalDuration() });
  let commitTimer = null;

  function setNotice(text, action) {
    clear(notice);
    if (!text) {
      notice.hidden = true;
      return;
    }
    notice.append(h('span', {}, text));
    if (action) notice.append(h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: action.onClick }, action.label));
    notice.hidden = false;
    clearTimeout(setNotice.t);
    setNotice.t = setTimeout(() => (notice.hidden = true), 7000);
  }

  function showError(message) {
    clear(errorEl).append(h('h2', {}, "Can't play this right now"), h('p', {}, message), h('button', { class: 'btn btn-primary', type: 'button', onClick: () => leave() }, 'Go back'));
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
      try {
        await video.play();
      } catch {
        bigPlay.hidden = false;
      }
    } else video.pause();
  }
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

  async function startSession(start, { forceTranscode = false, resume = false } = {}) {
    errorEl.hidden = true;
    spinnerEl.hidden = false;
    clearTimeout(pendingSeek);
    const body = {
      caps: detectCaps(),
      listId: query.list ? Number(query.list) : undefined, // playing through a playlist: "next" follows it
      start: resume ? undefined : Math.max(0, start || 0),
      resume,
      audioIndex,
      quality: quality || undefined,
      burnSubtitle: burnIndex,
      forceTranscode,
      replaces: session?.sessionId,
    };
    let res;
    try {
      res = await api.post(`/api/items/${params.id}/playback`, body);
    } catch (err) {
      showError(err.message);
      return;
    }
    if (destroyed) {
      api.post(`/api/playback/${res.sessionId}/stop`, {}).catch(() => {});
      return;
    }
    session = res;
    bubble.setManifest(res.previews);
    item = res.item;
    duration = res.duration || 0;
    offset = res.mode === 'direct' ? 0 : res.start;
    audioIndex = res.audioIndex;
    quality = res.quality;
    modeBadge.textContent = res.mode === 'direct' ? 'Direct' : res.mode === 'remux' ? 'Remux' : 'Transcode';
    modeBadge.dataset.mode = res.mode;
    renderInfo();
    nextBtn.hidden = !res.next;
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
  function seekTo(t) {
    const total = totalDuration();
    t = Math.max(0, total ? Math.min(t, total - 1) : t);
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
    seek.setAttribute('aria-valuetext', `${formatClock(now)} of ${formatClock(total)}`);
    if (!isStream() && video.buffered.length && total) {
      const end = video.buffered.end(video.buffered.length - 1);
      bufferBar.style.width = `${(end / total) * 100}%`;
    } else bufferBar.style.width = '0';
    updateIntro(now, total);
    updateCredits(now, total);
  }
  seek.addEventListener('input', () => {
    scrubbing = true;
    const t = Number(seek.value);
    timeCur.textContent = formatClock(t);
    const total = totalDuration();
    seek.style.setProperty('--pct', total ? `${(t / total) * 100}%` : '0%');
    bubble.show(t, total);
    showControls(true);
  });
  seek.addEventListener('change', () => {
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
    seek.setAttribute('aria-valuetext', `Jump to ${formatClock(t)}`);
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
    const range = introRange(session?.markers, total);
    const show = inIntro(range, now) && seekTarget == null && !scrubbing;
    if (show && autoSkip && !autoSkipped) {
      autoSkipped = true;
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
    const range = introRange(session?.markers, totalDuration());
    if (!range) return;
    skipBtn.hidden = true;
    if (document.activeElement === skipBtn) root.focus({ preventScroll: true });
    seekTo(range.end);
    if (auto) {
      setNotice('Skipped intro', {
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
  video.addEventListener('playing', () => (spinnerEl.hidden = true));
  video.addEventListener('canplay', () => (spinnerEl.hidden = true));
  video.addEventListener('loadedmetadata', updateTimeline);
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
    if (destroyed || !video.getAttribute('src')) return;
    const code = video.error?.code;
    if (!isSource && session && !retried && session.mode !== 'transcode') {
      retried = true;
      setNotice("This browser couldn't play the original, so the server is converting it.");
      startSession(currentTime(), { forceTranscode: true });
      return;
    }
    showError(code === 4 ? 'The video format is not supported by this browser.' : 'The stream stopped unexpectedly. Check the server log for ffmpeg errors.');
  });

  video.addEventListener('ended', () => {
    report(true);
    if (item?.kind === 'extra') return leave(); // a trailer or featurette goes back to its film
    if (!upNext.hidden) return; // already counting down (it started at the credits)
    if (session?.next && prefs.autoplayNext !== false && !upNextCancelled) startUpNext();
    else showControls(true);
  });

  // ---- Progress reporting ----
  function report(final = false) {
    if (isSource || !session) return;
    const total = totalDuration();
    const position = reportedPosition({ position: currentTime(), duration: total, ended: final && video.ended, markers: session.markers });
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

  // ---- Subtitles ----
  async function selectSubtitle(sub) {
    closeMenu();
    const needsRestart = (burnIndex != null && (!sub || sub.kind !== 'image')) || (sub && sub.kind === 'image');
    currentSub = sub;
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
    const t = currentTime();
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

  // ---- Menus ----
  let openMenu = null;
  const menuOpeners = { subs: subsBtn, audio: audioBtn, quality: qualityBtn, online: subsBtn };
  function closeMenu() {
    // A picked online result disables itself while it downloads, which drops focus to the page: that counts too.
    const refocus = menu.contains(document.activeElement) || document.activeElement === document.body;
    const opener = menuOpeners[openMenu];
    menu.hidden = true;
    openMenu = null;
    showControls();
    if (refocus) opener?.focus({ preventScroll: true });
  }
  function menuItem(label, checked, onClick, detail) {
    return h('button', { type: 'button', role: 'menuitemradio', class: 'menu-item', 'aria-checked': String(Boolean(checked)), onClick }, h('span', { class: 'menu-check' }, checked ? icon('check', { size: 16 }) : null), h('span', {}, label), detail ? h('small', {}, detail) : null);
  }
  function toggleMenu(kind) {
    if (openMenu === kind) return closeMenu();
    openMenu = kind;
    clear(menu);
    if (kind === 'subs') {
      menu.append(h('p', { class: 'menu-title' }, 'Subtitles'), menuItem('Off', !currentSub, () => selectSubtitle(null)));
      for (const s of session?.subtitles || []) menu.append(menuItem(s.label, currentSub?.id === s.id, () => selectSubtitle(s), s.source === 'external' ? 'File' : null));
      if (!(session?.subtitles || []).length) menu.append(h('p', { class: 'menu-empty' }, 'No subtitles found for this video.'));
      if (session?.subtitleProviders?.length) {
        menu.append(h('div', { class: 'menu-sep', 'aria-hidden': 'true' }), h('button', { type: 'button', class: 'menu-item menu-action', onClick: () => searchOnline() }, h('span', { class: 'menu-check' }, icon('search', { size: 16 })), h('span', {}, 'Find subtitles online…')));
      }
    } else if (kind === 'audio') {
      menu.append(h('p', { class: 'menu-title' }, 'Audio'));
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
      menu.append(h('p', { class: 'menu-title' }, 'Quality'));
      for (const [value, label] of QUALITIES) {
        menu.append(
          menuItem(label, quality === value, async () => {
            closeMenu();
            if (quality === value) return;
            quality = value;
            if (!isSource) await startSession(currentTime());
          }, value === 'original' ? 'Best, may convert' : 'Converted'),
        );
      }
    }
    menu.hidden = false;
    showControls(true);
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
  }
  document.addEventListener('pointerdown', onOutside, true);
  function onOutside(e) {
    if (!menu.hidden && !menu.contains(e.target) && ![subsBtn, audioBtn, qualityBtn].some((b) => b.contains(e.target))) {
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
    clear(menu).append(h('p', { class: 'menu-title' }, 'Find subtitles online'), h('div', { class: 'menu-search' }, langInput, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: run }, 'Search')), results);
    menu.hidden = false;
    showControls(true);
    run();
  }

  function renderInfo() {
    clear(infoEl);
    if (!session) return;
    // dom.js append() skips nulls (the native one would print "null").
    append(infoEl, [
      h('h3', {}, MODE_LABEL[session.mode] || session.mode),
      h('p', {}, `Delivery: ${session.delivery === 'file' ? 'original file' : session.delivery === 'hls' ? 'HLS' : 'MP4 stream'} · Quality: ${session.quality === 'original' ? 'original' : `${session.quality}p`}`),
      session.reasons?.length ? h('ul', {}, session.reasons.map((r) => h('li', {}, r))) : null,
    ]);
  }
  function toggleInfo() {
    infoEl.hidden = !infoEl.hidden;
  }

  // ---- Fullscreen ----
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
  }
  document.addEventListener('fullscreenchange', onFsChange);
  function onFsChange() {
    clear(fsBtn).append(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', { size: 24 }));
  }

  // ---- Up next ----
  function startUpNext() {
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
      h('h3', {}, `${episodeLabel(next)} · ${next.title}`),
      h('p', { class: 'upnext-meta muted' }, [session.show?.title, length].filter(Boolean).join(', ')),
      h('p', { class: 'muted' }, 'Starting in ', count, ' s'),
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
    clearInterval(upNextTimer);
    if (session?.next) navigate(`#/play/${session.next.id}${session.listId ? `?list=${session.listId}` : ''}`, { replace: true });
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
    const inControls = controls.contains(active) || top.contains(active) || upNext.contains(active) || errorEl.contains(active) || notice.contains(active);
    const onButton = inControls && active.tagName === 'BUTTON';
    showControls();
    switch (e.key) {
      case ' ':
      case 'k':
      case 'MediaPlayPause':
        if (onButton && e.key === ' ') return;
        e.preventDefault();
        togglePlay();
        break;
      case 'MediaPlay':
        video.play().catch(() => {});
        break;
      case 'MediaPause':
        video.pause();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (!menu.hidden) return;
        if (active === seek) {
          e.preventDefault(); // stops the slider's own step, which would seek on every press
          scrubPress(e.key === 'ArrowRight' ? 1 : -1, e);
          return;
        }
        if (onButton) {
          // Along the control buttons, or between the two Up next buttons.
          const pool = upNext.contains(active) ? upNext.querySelectorAll('button') : root.querySelectorAll('.player-controls button:not([hidden]), .player-top button, .player-notice:not([hidden]) button');
          const buttons = [...pool].filter((b) => b.offsetParent);
          const i = buttons.indexOf(active);
          const next = buttons[i + (e.key === 'ArrowRight' ? 1 : -1)];
          if (next) next.focus();
          e.preventDefault();
          return;
        }
        e.preventDefault();
        seekTo(currentTime() + (e.key === 'ArrowRight' ? 10 : -10));
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
          const items = [...menu.querySelectorAll('button')];
          const i = items.indexOf(active);
          items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
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
      airplayBtn.hidden = e.availability !== 'available';
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

  function leave() {
    if (query.from) return goBack(`#/item/${query.from}`);
    goBack(item?.kind === 'episode' && item.parentId ? `#/item/${item.showId}?season=${item.parentId}` : item?.kind === 'extra' ? `#/item/${item.parentId}` : item ? `#/item/${item.id}` : '#/');
  }

  // ---- Start ----
  if (isSource) {
    state.playingItemHash = `#/addons/${params.plugin}/${params.source}`; // where "Who's watching?" returns to
    try {
      const res = await api.post(`/api/sources/${params.plugin}/${params.source}/resolve`, { id: query.id });
      titleEl.append(h('h1', {}, res.title || query.title || 'Playing'));
      setTitle(res.title || 'Playing');
      session = { mode: 'direct', delivery: 'file', subtitles: res.subtitles || [], audioTracks: [], quality: 'original', reasons: ['Streaming from the add-on source'] };
      duration = res.duration || 0;
      qualityBtn.hidden = true;
      modeBadge.textContent = 'Add-on';
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
    if (session.resumed) setNotice(`Resumed at ${formatClock(session.start)}`, { label: 'Start over', onClick: () => seekTo(0) });
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

  function cleanupFn() {
    destroyed = true;
    state.playingItemHash = null;
    report();
    if (session?.sessionId) api.post(`/api/playback/${session.sessionId}/stop`, {}, { keepalive: true }).catch(() => {});
    clearInterval(heartbeat);
    clearInterval(upNextTimer);
    clearInterval(clockTimer);
    clearTimeout(hideTimer);
    clearTimeout(commitTimer);
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('fullscreenchange', onFsChange);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  return cleanupFn;
}
