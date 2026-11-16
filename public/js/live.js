// Live TV in the browser: fetching channels and the guide, captions for programmes, the channel order used for
// channel up/down, and starting a channel (TV in the player, radio in the music player). The parts that need no
// page are tested in Node (test/live-client.test.js).
import { api } from './api.js';
import { channelPlayable, deviceNow, unplayableHere, deviceSoon, mayHide, showAllNow } from './dash/playable.js';

const DAY = 86400_000;
let statusCache = null;
let order = [];

export async function liveStatus({ fresh = false } = {}) {
  if (!statusCache || fresh) statusCache = api.get('/api/live/status').catch(() => ({ enabled: false, sources: [] }));
  return statusCache;
}
export function forgetLiveStatus() {
  statusCache = null;
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
// Each listed channel's protection (v0.28: its list of systems), remembered so the player can check this device has one
// of them before asking for a stream (a player opened from Live TV, the guide or search has no channel list of its own yet).
const protections = new Map();
/** v0.28: a channel's `drm` is a list of systems (or null); code that compares one system name reads the first. */
export const firstDrm = (drm) => (drm === undefined ? undefined : Array.isArray(drm) ? drm[0] || null : drm || null);
/** v0.28: a TV can play Widevine, PlayReady or ClearKey; FairPlay-only channels can't be cast. Takes a list, a name or null. */
export const castableDrm = (drm) => (Array.isArray(drm) ? drm : drm ? [drm] : []).some((d) => d === 'widevine' || d === 'playready' || d === 'clearkey');
// v0.28: the whole list is kept (the player asks about all of a channel's systems); an older string stays as it is.
const keepDrm = (drm) => (drm === undefined ? undefined : Array.isArray(drm) ? (drm.length ? drm : null) : drm || null);
const remember = (list) => {
  for (const c of Array.isArray(list) ? list : []) if (c && c.id != null) protections.set(Number(c.id), keepDrm(c.drm));
  return list;
};
/** A channel's protection (its list of systems, an older single name, or null), or undefined when no list has named it. */
export const protectionOf = (id) => protections.get(Number(id));
export const channels = ({ group, favourites } = {}) => api.get(`/api/live/channels${qs({ group, favourites: favourites ? 1 : null })}`).then(remember);
export const groups = () => api.get('/api/live/groups');
export const guide = (from, to, channelIds) => api.get(`/api/live/guide${qs({ from: Math.round(from), to: Math.round(to), channels: channelIds?.length ? channelIds.join(',') : null })}`);
export const programme = (id) => api.get(`/api/live/programmes/${id}`);
export const search = (q) => api.get(`/api/live/search${qs({ q })}`);
/**
 * v0.28: search's On TV without the channels this device can't play (and their programmes), unless the switch is on.
 * A programme names only its channel, so the channel list is asked once when one's protection isn't known yet.
 */
export async function onTvHere(tv) {
  if (!tv) return tv;
  remember(tv.channels);
  if (!mayHide() || showAllNow()) return tv;
  const progDrm = (p) => protectionOf(p.channel?.id);
  if (tv.programmes.some((p) => p.channel?.id != null && progDrm(p) === undefined)) await channels().catch(() => null);
  const device = await deviceSoon([...tv.channels, ...tv.programmes.map((p) => ({ drm: progDrm(p) }))]);
  if (!device) return tv;
  return { ...tv, channels: tv.channels.filter((c) => channelPlayable(c.drm, device)), programmes: tv.programmes.filter((p) => channelPlayable(progDrm(p), device)) };
}
// Recordings (v0.19)
export const recordProgramme = (id, opts = {}) => api.post(`/api/live/programmes/${id}/record`, opts);
export const cancelRecording = (id, { onlyActive = false } = {}) => api.del(`/api/live/recordings/${id}${onlyActive ? '?only=active' : ''}`);
export const stopRecording = (id) => api.post(`/api/live/recordings/${id}/stop`, {});
export const retryRecording = (id) => api.post(`/api/live/recordings/${id}/retry`, {});
export const recordingsList = () => api.get('/api/live/recordings');
export const updateRule = (id, fields) => api.patch(`/api/live/rules/${id}`, fields);
export const stopSeries = (id) => api.del(`/api/live/rules/${id}`);
/** ", recording scheduled" / ", recording" for a programme's spoken name. */
export const recordingWords = (p) => (p?.recording === 'recording' ? ', recording' : p?.recording === 'scheduled' ? ', recording scheduled' : '');
export const setFavourite = (id, on) => (on ? api.post(`/api/live/favourites/${id}`, {}) : api.del(`/api/live/favourites/${id}`));

const clock = (ms) => {
  const d = new Date(ms);
  const h = d.getHours();
  return { text: `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`, half: h < 12 ? 'AM' : 'PM' };
};

/** "7:00 – 7:30 PM" (both halves named when the programme crosses noon or midnight). */
export function programmeTimes(p) {
  const a = clock(p.start);
  const b = clock(p.end);
  return a.half === b.half ? `${a.text} – ${b.text} ${b.half}` : `${a.text} ${a.half} – ${b.text} ${b.half}`;
}

/** "7:30 PM" */
export function clockTime(ms) {
  const c = clock(ms);
  return `${c.text} ${c.half}`;
}

/** How far through a programme `now` is, 0..1. */
export function programmeProgress(p, now = Date.now()) {
  if (!p || !(p.end > p.start)) return 0;
  return Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start)));
}

/** 'now' | 'upcoming' | 'catchup' (aired, still in the channel's archive) | 'aired'. */
export function programmeState(p, now, channel) {
  if (now < p.start) return 'upcoming';
  if (now < p.end) return 'now';
  const days = channel?.catchup ? Number(channel.catchupDays) || 0 : 0;
  return days > 0 && p.end > now - days * DAY ? 'catchup' : 'aired';
}

export const channelLabel = (c) => (c.number != null ? `${c.number} ${c.name}` : c.name);

/** The order channel up/down walks: the channels last listed on the Channels page (its group), else all. */
export function setZapOrder(ids) {
  order = [...ids];
}
export function zapOrder() {
  return order;
}
/** v0.28: channel up/down skips channels this device can't play (`ok`); when no other one plays, it stays. */
const playsHere = (id) => channelPlayable(protectionOf(id), deviceNow());
export function neighbour(id, dir, ok = playsHere) {
  if (!order.length) return id;
  const i = order.indexOf(Number(id));
  if (i < 0) return order.find(ok) ?? order[0];
  for (let step = 1; step < order.length; step++) {
    const next = order[(((i + dir * step) % order.length) + order.length) % order.length];
    if (ok(next)) return next;
  }
  return order[i];
}

/** Where a playing session is pinged and stopped: an encrypted channel's own address, else the playback session's. */
export const sessionPath = (s) => (s?.delivery === 'drm' ? `/api/live/drm/${s.sessionId}` : s?.delivery === 'dash' ? `/api/live/tuner/${s.sessionId}` : `/api/playback/${s?.sessionId}`);

/**
 * Coalesces quick channel changes: a request waits `settleMs` for another; only the last one starts. Starts never
 * overlap (a provider allowing one stream would refuse the second): a press made while an earlier start is still
 * running waits for it, and when that earlier start was overtaken its stream is stopped (`onStale`, awaited) before
 * the newer one starts.
 */
export function zapQueue(start, { settleMs = 400, onStale = () => {} } = {}) {
  let seq = 0;
  let timer = null;
  let pending = [];
  let inflight = Promise.resolve();
  return {
    request(id) {
      const mine = ++seq;
      clearTimeout(timer);
      for (const p of pending) p(null);
      return new Promise((resolve, reject) => {
        pending = [resolve];
        timer = setTimeout(() => {
          pending = [];
          const run = inflight.then(async () => {
            if (mine !== seq) return resolve(null); // overtaken while waiting its turn
            let out;
            try {
              out = await start(id);
            } catch (err) {
              if (mine === seq) reject(err);
              else resolve(null);
              return;
            }
            if (mine !== seq) {
              await Promise.resolve(onStale(out)).catch(() => {});
              resolve(null);
            } else resolve(out);
          });
          inflight = run.catch(() => {});
        }, settleMs);
      });
    },
    /** Leaving the player: a pending zap never starts; one already starting is stopped when it lands. */
    cancel() {
      ++seq;
      clearTimeout(timer);
      for (const p of pending) p(null);
      pending = [];
    },
  };
}

/** When a programme ends: the next one if it's on now (started, not over), else nothing (a gap in the guide). */
export const takeOver = (next, now) => (next && next.start <= now && next.end > now ? next : null);

/** Start a channel: TV opens the player, radio plays in the music player. */
export async function playChannel(channel) {
  if (channel.radio) {
    const { music } = await import('./music.js');
    return music.playLive(channel);
  }
  if (channel.drm !== undefined) protections.set(Number(channel.id), keepDrm(channel.drm));
  // v0.28: a channel this device can't play (listed with the switch on, or typed by number) shows why instead.
  if (unplayableHere(channel.drm ?? protectionOf(channel.id))) return (await import('./ui/cant-play.js')).openCantPlay(channel);
  location.hash = `#/live/play/${channel.id}`;
}
