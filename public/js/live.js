// Live TV in the browser: fetching channels and the guide, captions for programmes, the channel order used for
// channel up/down, and starting a channel (TV in the player, radio in the music player). The parts that need no
// page are tested in Node (test/live-client.test.js).
import { api } from './api.js';

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
// v0.27: each listed channel's protection, remembered so the player can check a phone can play it before asking for
// a stream (a player opened from Live TV, the guide or search has no channel list of its own yet).
const protections = new Map();
const remember = (list) => {
  for (const c of Array.isArray(list) ? list : []) if (c && c.id != null) protections.set(Number(c.id), c.drm || null);
  return list;
};
/** A channel's protection ('widevine' | 'clearkey' | 'fairplay' | null), or undefined when no list has named it. */
export const protectionOf = (id) => protections.get(Number(id));
export const channels = ({ group, favourites } = {}) => api.get(`/api/live/channels${qs({ group, favourites: favourites ? 1 : null })}`).then(remember);
export const groups = () => api.get('/api/live/groups');
export const guide = (from, to, channelIds) => api.get(`/api/live/guide${qs({ from: Math.round(from), to: Math.round(to), channels: channelIds?.length ? channelIds.join(',') : null })}`);
export const programme = (id) => api.get(`/api/live/programmes/${id}`);
export const search = (q) => api.get(`/api/live/search${qs({ q })}`);
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
export function neighbour(id, dir) {
  if (!order.length) return id;
  const i = order.indexOf(Number(id));
  if (i < 0) return order[0];
  return order[(i + dir + order.length) % order.length];
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
  if (channel.drm !== undefined) protections.set(Number(channel.id), channel.drm || null);
  location.hash = `#/live/play/${channel.id}`;
}
