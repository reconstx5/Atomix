// The Remote (#/cast): what is playing on the TV and the buttons that drive it. Atomix talks to the TV; this page
// sends commands and reads the session every second. Back leaves it and casting goes on.
import { h, icon, clear, formatClock } from '../dom.js';
import { api } from '../api.js';
import { setTitle, goBack } from '../app.js';
import { button, emptyState, art, openSheet } from '../components.js';
import { seekPreview } from '../seekpreview.js';
import { Scrubber, COMMIT_AFTER_MS } from '../scrub.js';
import { setBackdrop } from '../backdrop.js';
import { castState, castEnded, onCastChange, castCommand, refreshCast, setFastPoll } from '../cast.js';

export async function render(el) {
  el.classList.add('remote-view');
  setTitle('Remote');
  setFastPoll(true);
  document.documentElement.classList.add('remote-open');
  const done = () => {
    setFastPoll(false);
    document.documentElement.classList.remove('remote-open');
  };
  if (!castState()) await refreshCast();
  const first = castState();
  if (!first) {
    const e = castEnded();
    el.append(
      emptyState({
        title: e ? `Casting ended on ${e.deviceName}` : 'Nothing is casting',
        text: e?.detail || 'Choose Cast in the player, or Cast to… on a title, to play it on a TV.',
        action: button('Back', { icon: 'back', autofocus: true, onClick: () => goBack('#/') }),
      }),
    );
    return done;
  }

  const artEl = h('div', { class: 'remote-art' });
  const device = h('p', { class: 'remote-device' });
  const title = h('h1', { class: 'remote-title' });
  const sub = h('p', { class: 'remote-sub muted' });
  const status = h('p', { class: 'remote-status muted', role: 'status' });
  const seek = h('input', { type: 'range', class: 'remote-seek seekbar', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Seek' });
  const track = h('div', { class: 'seek-track' }, seek);
  const bubble = seekPreview(track);
  const cur = h('span', { class: 'time' }, '0:00');
  const left = h('span', { class: 'time' }, '');
  const play = h('button', { type: 'button', class: 'rbtn rbtn-play remote-play', 'aria-label': 'Pause', onClick: () => togglePlay() }, icon('pause', { size: 34 }));
  const back10 = h('button', { type: 'button', class: 'rbtn remote-back10', 'aria-label': 'Back 10 seconds', title: 'Back 10 seconds', onClick: () => castCommand('skip', { by: -10 }) }, icon('replay', { size: 30 }));
  const fwd10 = h('button', { type: 'button', class: 'rbtn remote-fwd10', 'aria-label': 'Forward 10 seconds', title: 'Forward 10 seconds', onClick: () => castCommand('skip', { by: 10 }) }, icon('forward10', { size: 30 }));
  const nextBtn = h('button', { type: 'button', class: 'rbtn remote-next', 'aria-label': 'Next', title: 'Next', hidden: true, onClick: () => castCommand('next') }, icon('next', { size: 28 }));
  const volume = h('input', { type: 'range', class: 'remote-volume', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'TV volume' });
  const subsBtn = button('Subtitles', { icon: 'subtitles', variant: 'ghost', onClick: () => chooseSubtitle(), attrs: { class: 'btn btn-ghost remote-subs' } });
  const audioBtn = button('Audio', { icon: 'audio', variant: 'ghost', onClick: () => chooseAudio(), attrs: { class: 'btn btn-ghost remote-audio' } });
  const stopBtn = button('Stop casting', { icon: 'close', variant: 'secondary', onClick: () => stop(), attrs: { class: 'btn btn-secondary remote-stop' } });
  const ring = h('span', { class: 'upnext-ring', 'aria-hidden': 'true' });
  const upTitle = h('p', { class: 'remote-upnext-title' });
  const upnext = h(
    'section',
    { class: 'remote-upnext', hidden: true, 'aria-label': 'Up next' },
    h('p', { class: 'remote-upnext-label muted' }, 'Up next'),
    upTitle,
    h('div', { class: 'remote-upnext-buttons' }, h('button', { type: 'button', class: 'btn btn-primary', onClick: () => castCommand('next') }, ring, icon('play'), h('span', {}, 'Play now')), h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => castCommand('cancel-up-next') }, 'Cancel')),
  );
  const queueEl = h('ol', { class: 'remote-queue', role: 'list', hidden: true });
  const lyricsEl = h('div', { class: 'remote-lyrics', hidden: true });

  el.append(
    h(
      'div',
      { class: 'remote-main' },
      artEl,
      h(
        'div',
        { class: 'remote-body' },
        device,
        title,
        sub,
        status,
        h('div', { class: 'remote-seek-wrap' }, cur, track, left),
        h('div', { class: 'remote-transport' }, back10, play, fwd10, nextBtn),
        h('div', { class: 'remote-row' }, h('span', { class: 'remote-volume-wrap' }, icon('volume', { size: 22 }), volume), subsBtn, audioBtn, stopBtn),
        upnext,
        lyricsEl,
        queueEl,
      ),
    ),
  );

  let s = first;
  let itemId = null;
  let lyrics = null;
  const scrubber = new Scrubber({ duration: () => s?.duration || 0 });
  let commitTimer = null;
  let scrubbing = false;
  let volumeHold = 0;

  function togglePlay() {
    castCommand(s.state === 'playing' || s.state === 'buffering' ? 'pause' : 'play');
  }
  async function stop() {
    await castCommand('stop');
    goBack('#/');
  }
  function chooseSubtitle() {
    const items = [{ label: 'Off', icon: s.subtitleId ? null : 'check', onSelect: () => castCommand('subtitle', { id: null }) }];
    for (const t of s.subtitles) items.push({ label: t.label, icon: s.subtitleId === t.id ? 'check' : t.kind === 'image' ? 'subtitles' : null, onSelect: () => castCommand('subtitle', { id: t.id }) });
    openSheet('Subtitles', items);
  }
  function chooseAudio() {
    openSheet('Audio', s.audio.map((a) => ({ label: [a.title || a.language || `Track ${a.index}`, a.codec?.toUpperCase(), a.channels ? `${a.channels} ch` : null].filter(Boolean).join(' · '), icon: s.audioIndex === a.index ? 'check' : null, onSelect: () => castCommand('audio', { index: a.index }) })));
  }

  // The seek bar: arrows move a marker (with the picture), and the TV jumps when you stop pressing or press OK.
  const showMarker = (t) => {
    seek.value = String(Math.floor(t));
    seek.style.setProperty('--pct', s.duration ? `${(t / s.duration) * 100}%` : '0%');
    cur.textContent = formatClock(t);
    bubble.show(t, s.duration || 0);
  };
  const commit = () => {
    clearTimeout(commitTimer);
    const t = scrubber.commit();
    scrubbing = false;
    bubble.hide();
    if (t != null) castCommand('seek', { position: t });
  };
  seek.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      scrubbing = true;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      showMarker(scrubber.press(dir, { from: castState()?.position || 0, now: Date.now(), repeat: e.repeat }));
      bubble.setStep(scrubber.lastStep > 10 ? `${dir > 0 ? '+' : '−'}${scrubber.lastStep} s` : null);
      clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, COMMIT_AFTER_MS);
    } else if (e.key === 'Enter' && scrubbing) {
      e.preventDefault();
      commit();
    }
  });
  seek.addEventListener('input', () => {
    if (scrubber.active) return;
    scrubbing = true;
    showMarker(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    if (scrubber.active) return;
    scrubbing = false;
    bubble.hide();
    castCommand('seek', { position: Number(seek.value) });
  });
  seek.addEventListener('blur', () => {
    if (scrubber.active) commit();
  });
  // Volume: Up/Down on the bar change it by 5.
  volume.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    const level = Math.max(0, Math.min(1, Math.round((Number(volume.value) + (e.key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100));
    volume.value = String(level);
    volumeHold = Date.now() + 2500;
    castCommand('volume', { level });
  });
  volume.addEventListener('change', () => {
    volumeHold = Date.now() + 2500;
    castCommand('volume', { level: Number(volume.value) });
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      goBack('#/'); // as Back and Backspace do; casting goes on
      return;
    }
    if (e.defaultPrevented || e.target.closest?.('dialog, button, a, input, textarea, select')) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  };
  window.addEventListener('keydown', onKey);

  async function loadLyrics(id) {
    lyrics = null;
    clear(lyricsEl);
    lyricsEl.hidden = true;
    const r = await api.get(`/api/items/${id}/lyrics`).catch(() => null);
    if (id !== itemId || !r?.lines?.length) return;
    lyrics = r;
    lyricsEl.hidden = false;
    lyricsEl.append(h('ol', { class: r.synced ? 'lyrics-synced' : 'lyrics-plain', role: 'list' }, r.lines.map((l) => h('li', { class: 'lyric-line' }, l.text || ' '))));
  }

  function draw(next, endedNote) {
    if (!next) {
      clearTimeout(commitTimer);
      clear(el).append(
        emptyState({
          title: endedNote ? `Casting ended on ${endedNote.deviceName}` : 'Casting stopped',
          text: endedNote?.detail || '',
          action: button('Back', { icon: 'back', autofocus: true, onClick: () => goBack('#/') }),
        }),
      );
      el.querySelector('.btn')?.focus();
      return;
    }
    s = next;
    if (s.itemId !== itemId) {
      itemId = s.itemId;
      clear(artEl).append(art(s.image, s.title, { kind: s.itemKind === 'track' ? 'square' : 'poster', eager: true }));
      setBackdrop(s.backdrop || s.image);
      bubble.setManifest(s.previews);
      if (s.itemKind === 'track') loadLyrics(s.itemId);
      else {
        lyricsEl.hidden = true;
        lyrics = null;
      }
    }
    device.replaceChildren(icon(s.kind === 'chromecast' ? 'cast' : 'tv', { size: 20 }), h('span', {}, `on ${s.deviceName}`));
    title.textContent = s.title;
    sub.textContent = s.subtitle || '';
    status.textContent = s.reconnecting ? `Reconnecting to ${s.deviceName}…` : s.state === 'buffering' ? 'Loading on the TV…' : '';
    const playing = s.state === 'playing' || s.state === 'buffering';
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    play.title = playing ? 'Pause (Space)' : 'Play (Space)';
    play.replaceChildren(icon(playing ? 'pause' : 'play', { size: 34 }));
    const total = s.duration || 0;
    seek.max = String(Math.max(1, Math.floor(total)));
    if (!scrubbing) {
      seek.value = String(Math.floor(s.position));
      seek.style.setProperty('--pct', total ? `${(s.position / total) * 100}%` : '0%');
      cur.textContent = formatClock(s.position);
    }
    left.textContent = total ? `-${formatClock(Math.max(0, total - s.position))}` : '';
    seek.setAttribute('aria-valuetext', `${formatClock(s.position)} of ${formatClock(total)}`);
    if (s.volume != null && Date.now() > volumeHold && document.activeElement !== volume) volume.value = String(s.volume);
    subsBtn.hidden = !s.subtitles.length || s.itemKind === 'track';
    audioBtn.hidden = s.audio.length < 2;
    const hasNext = Boolean(s.upNext || (s.queue && s.queue.index + 1 < s.queue.items.length));
    nextBtn.hidden = !s.queue || !hasNext;
    upnext.hidden = !s.upNext;
    if (s.upNext) {
      upTitle.textContent = s.upNext.title;
      const leftMs = Math.max(0, s.upNext.at - Date.now());
      ring.style.setProperty('--p', String(1 - Math.min(1, leftMs / 10000)));
    }
    queueEl.hidden = !s.queue;
    if (s.queue) {
      const sig = s.queue.items.map((i) => i.id).join(',') + ':' + s.queue.index;
      if (queueEl.dataset.sig !== sig) {
        queueEl.dataset.sig = sig;
        clear(queueEl).append(s.queue.items.map((i, n) => h('li', { class: `remote-queue-item${n === s.queue.index ? ' is-current' : ''}`, 'aria-current': n === s.queue.index ? 'true' : null }, h('span', { class: 'remote-queue-n muted' }, String(n + 1)), h('span', {}, i.title))));
      }
    }
    if (lyrics?.synced) {
      const lines = lyricsEl.querySelectorAll('.lyric-line');
      let idx = -1;
      lyrics.lines.forEach((l, i) => {
        if (l.at != null && l.at <= s.position + 0.3) idx = i;
      });
      lines.forEach((li, i) => li.classList.toggle('is-current', i === idx));
    }
  }
  const off = onCastChange(draw);
  // Between polls the time moves on by itself.
  const tick = setInterval(() => {
    const now = castState();
    if (now) draw(now, null);
  }, 500);
  draw(first, null);
  play.focus({ preventScroll: true });
  return () => {
    off();
    clearInterval(tick);
    clearTimeout(commitTimer);
    window.removeEventListener('keydown', onKey);
    done();
  };
}
