// Watch together in the player: follow the room's state (an event stream), and tell the room what this person does.
// The room is the truth: this player plays or pauses with it, seeks when it's more than 2 s out, says when it's ready
// after a play or a seek, and when it's buffering. Changes the player makes because the room said so are not sent back.
import { api } from './api.js';

const DRIFT = 2; // seconds
const QUIET_MS = 800; // after applying the room's state, the video's own events are ours, not the person's
const SETTLE_MS = 4000; // after a seek, a converted stream restarts: its pause while it loads isn't "buffering"

/**
 * @param {{ code, member, video: HTMLVideoElement, currentTime: () => number, seekTo: (t, opts) => void,
 *   onState?: (state) => void, onRemoved?: (sentence) => void, onNext?: (itemId) => void, onClosed?: (sentence) => void }} o
 */
export function joinTogether(o) {
  const { code, member, video } = o;
  let state = null;
  let offset = 0; // server clock − ours
  let quietUntil = 0;
  let waitingReady = false;
  let closed = false;
  let lastSeekAt = 0;
  const path = (action) => `/api/together/${encodeURIComponent(code)}/${action}`;
  const act = (action, body = {}) => api.post(path(action), { member, ...body }).catch((err) => o.onError?.(err.message));
  const quiet = () => (quietUntil = Date.now() + QUIET_MS);
  const target = (s) => (s.playing ? s.position + (Date.now() + offset - s.at) / 1000 : s.position);

  function apply(s) {
    if (s.removed) {
      close();
      return o.onRemoved?.(s.removed);
    }
    const first = !state;
    state = s;
    offset = s.serverNow - Date.now();
    o.onState?.(s);
    if (o.itemId && s.itemId !== o.itemId) return o.onNext?.(s.itemId);
    const want = target(s);
    if (first || Math.abs(o.currentTime() - want) > DRIFT) {
      quiet();
      lastSeekAt = Date.now();
      o.seekTo(want, { remote: true });
    }
    const me = s.members.find((m) => m.you);
    if (s.waitingFor.length && me && !me.ready) {
      waitingReady = true;
      if (!video.paused) (quiet(), video.pause());
      if (video.readyState >= 3 && !o.restarting?.()) sendReady(); // a converted stream restarting: its new one says
    } else if (s.playing && video.paused) {
      quiet();
      video.play().catch(() => {});
    } else if (!s.playing && !s.waitingFor.length && !video.paused) {
      quiet();
      video.pause();
    }
  }
  function sendReady() {
    if (!waitingReady || o.restarting?.()) return; // the old stream's events don't count while a new one is coming
    waitingReady = false;
    act('ready');
  }

  const events = new EventSource(`${path('events')}?member=${encodeURIComponent(member)}`);
  events.addEventListener('state', (e) => {
    try {
      apply(JSON.parse(e.data));
    } catch {
      /* a bad message: the next one puts it right */
    }
  });
  events.addEventListener('error', async () => {
    if (closed || events.readyState !== EventSource.CLOSED) return; // it reconnects on its own
    // Closed for good: the room ended, or this member was dropped (a phone asleep for a while). Join again as a new
    // member and carry on with that one; if the room is gone, say so.
    close();
    const r = await fetch(path('join'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    const again = r?.ok ? await r.json().catch(() => null) : null;
    if (again?.member) o.onRejoined?.(again.member);
    else o.onClosed?.(again === null && r && r.status !== 404 ? (await r.json().catch(() => ({}))).error || 'This Watch together room has ended.' : 'This Watch together room has ended.');
  });

  // What the person does comes from the player (its play/pause button and keys, its seeks), not from the video's
  // events: those also fire when the player restarts a converted stream on its own.
  const onReady = () => sendReady();
  let bufferTimer = null;
  const onWaiting = () => {
    if (!state?.playing) return;
    clearTimeout(bufferTimer);
    if (Date.now() - lastSeekAt < SETTLE_MS) return;
    bufferTimer = setTimeout(() => video.readyState < 3 && !video.paused && Date.now() - lastSeekAt >= SETTLE_MS && act('buffering'), 1000);
  };
  const onEnded = () => act('ended');
  video.addEventListener('canplay', onReady);
  video.addEventListener('playing', onReady);
  video.addEventListener('seeked', onReady);
  video.addEventListener('waiting', onWaiting);
  video.addEventListener('ended', onEnded);
  // Drift: every 5 s while the room plays.
  const drift = setInterval(() => {
    if (!state?.playing || video.paused) return;
    const want = target(state);
    if (Math.abs(o.currentTime() - want) > DRIFT && Date.now() - lastSeekAt > SETTLE_MS) {
      quiet();
      lastSeekAt = Date.now();
      o.seekTo(want, { remote: true });
    }
  }, 5000);

  function close() {
    if (closed) return;
    closed = true;
    events.close();
    clearInterval(drift);
    clearTimeout(bufferTimer);
    video.removeEventListener('canplay', onReady);
    video.removeEventListener('playing', onReady);
    video.removeEventListener('seeked', onReady);
    video.removeEventListener('waiting', onWaiting);
    video.removeEventListener('ended', onEnded);
  }
  return {
    act,
    /** The room's next title for this member (the show's next episode, or the playlist's next), if the room knows one. */
    next: () => state?.nextItemId ?? null,
    /** The person moved the playhead (the player's own seek, not one the room asked for). */
    localSeek: (t) => {
      if (!state || Date.now() <= quietUntil) return;
      lastSeekAt = Date.now();
      act('seek', { position: t });
    },
    /** A converted stream's restart failed: no new stream will say ready, so say it now (the room needn't wait). */
    restartFailed: () => sendReady(),
    /** The person pressed play or pause. */
    localPlay: () => state && act('play', { position: o.currentTime() }),
    localPause: () => state && act('pause', { position: o.currentTime() }),
    leave: async () => {
      await act('leave');
      close();
    },
    close,
    get state() {
      return state;
    },
  };
}

/** Start a room for a title; resolves with { code, member, itemId }. */
export const startRoom = (itemId, { position = 0, playing = false, listId = null } = {}) => api.post('/api/together', { itemId, position, playing, listId });
/** Join one by its code; resolves with { code, member, itemId }. */
export const joinRoom = (code) => api.post(`/api/together/${encodeURIComponent(String(code).trim().toUpperCase())}/join`, {});

/** The strip's sentence for the room's latest news. */
export function newsLine(s) {
  if (!s) return '';
  if (s.waitingFor.length) return `Waiting for ${s.waitingFor.join(', ')}…`;
  if (s.ended) return 'The room has finished this title';
  const l = s.last;
  if (!l) return 'Watching together';
  const verb = { played: 'pressed play', paused: 'paused', seeked: 'skipped', joined: 'joined', left: 'left', next: 'started the next episode', ended: 'finished' }[l.action] || l.action;
  return `${l.name} ${verb}`;
}
