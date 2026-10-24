// Back online (v0.21): what was watched offline goes to the server, then the server says which downloads this profile
// may keep. Locally, a download not checked for the server's offline days stops playing, and goes a week later.
// What the app needs to open with no connection (the server's name, the themes, who is signed in) is kept here too.
import { api } from '../api.js';
import { toast, announce } from '../components.js';
import { openStore } from './store.js';
import { downloads } from './downloader.js';

const DAY = 86400_000;
const GRACE_DAYS = 7;
const SNAPSHOT_KEY = 'atomix-offline';
let storeP = null;
const store = () => (storeP ||= openStore());
let running = null;
let again = null;
let offlineDays = 30;

/** What an offline open needs, kept at each online open. */
export function keepSnapshot({ status, themes }) {
  if (!status?.user) return;
  offlineDays = Number(status.downloads?.offlineDays) || offlineDays;
  try {
    const { serverName, defaultTheme, downloads: limits } = status;
    const { id, username, role, canDownload } = status.user;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ serverName, defaultTheme, downloads: limits, user: { id, username, role, canDownload }, themes }));
  } catch {
    /* storage blocked: the app can't open offline, the downloads stay */
  }
}
export function readSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
  } catch {
    return null;
  }
}
export function forgetSnapshot() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

/** A download past the server's offline days without a check: it won't play until the device is back online. Worked
 *  out from its last check, so it holds offline too. */
export function isExpired(e, now = Date.now()) {
  if (e?.status === 'expired') return true;
  if (e?.status !== 'ready') return false;
  return now - (e.checkedAt || e.downloadedAt || e.addedAt || now) > offlineDays * DAY;
}

/** Expired downloads: past the offline days without a check they won't play; a week later they go. */
async function expire(profileId = downloads.profileId, now = Date.now()) {
  if (profileId == null) return [];
  const s = await store();
  const removed = [];
  for (const e of await s.list(profileId)) {
    const since = e.checkedAt || e.downloadedAt || e.addedAt || now;
    const age = now - since;
    if (age > (offlineDays + GRACE_DAYS) * DAY) {
      await downloads.remove(e.itemId, profileId);
      removed.push(e.itemId);
    } else if (age > offlineDays * DAY && e.status === 'ready') {
      await s.patch(profileId, e.itemId, { status: 'expired' });
      downloads.events.dispatchEvent(new CustomEvent('change', { detail: { itemId: e.itemId } }));
    }
  }
  return removed;
}

/** Send this profile's offline progress (the newest per title), then check its downloads with the server. */
async function runNow() {
  const profileId = downloads.profileId;
  if (profileId == null) return { removed: [], sent: 0 };
  const s = await store();
  // Progress: the server takes each one only when it's newer than what it has.
  const mine = (await s.pendingProgress()).filter((p) => p.profileId === profileId);
  const newest = new Map();
  for (const p of mine) if (!newest.has(p.itemId) || newest.get(p.itemId).at <= p.at) newest.set(p.itemId, p);
  let sent = 0;
  if (newest.size) {
    const entries = [...newest.values()].map(({ itemId, position, duration, at, locator, device, watched }) => ({ itemId, position, duration, at, locator, device, watched }));
    await api.post('/api/downloads/progress', { entries });
    await s.clearProgress(mine.map((p) => p.key));
    sent = entries.length;
  }
  // The check: titles the profile may no longer have go (with a toast); the rest are good for the offline days again.
  const list = await s.list(profileId);
  const removed = [];
  if (list.length) {
    const r = await api.post('/api/downloads/check', { itemIds: list.map((e) => e.itemId) });
    offlineDays = Number(r.offlineDays) || offlineDays;
    const now = Date.now();
    for (const id of r.remove || []) {
      await downloads.remove(id, profileId);
      removed.push(id);
    }
    for (const id of r.keep || []) {
      const e = list.find((x) => x.itemId === id);
      await s.patch(profileId, id, { checkedAt: now, ...(e?.status === 'expired' ? { status: 'ready' } : {}) });
      if (e?.status === 'expired') downloads.events.dispatchEvent(new CustomEvent('change', { detail: { itemId: id } }));
    }
    await refreshPlaces(s, profileId, list.filter((e) => !removed.includes(e.itemId)));
    if (removed.length) {
      const names = list.filter((e) => removed.includes(e.itemId)).map((e) => e.title);
      const msg = removed.length === 1 ? `“${names[0]}” was removed from your downloads (it's no longer available to you)` : `${removed.length} downloads were removed (they're no longer available to you)`;
      toast(msg);
      announce(msg);
    }
  }
  removed.push(...(await expire(profileId)));
  return { removed, sent };
}

/**
 * v0.22: a book's or an episode's place may have moved on another device (or online here): the downloads keep the
 * server's latest, so offline listening picks up there. One request per book or episode; one that fails keeps its place.
 */
async function refreshPlaces(s, profileId, list) {
  const spoken = list.filter((e) => ['chapter', 'audiobook', 'podcast_episode'].includes(e.kind));
  const ids = [...new Set(spoken.map((e) => e.book?.id ?? e.itemId))];
  for (const id of ids) {
    const d = await api.get(`/api/items/${id}`).catch(() => null);
    const p = d?.item?.progress;
    if (!d?.item) continue;
    const place = { position: p?.position ?? 0, positionAt: p?.updatedAt ?? null, watched: Boolean(p?.watched) };
    for (const e of spoken) {
      if (e.book?.id === id) await s.patch(profileId, e.itemId, (cur) => ({ book: { ...cur.book, ...place } }));
      else if (e.itemId === id && !e.book) await s.patch(profileId, e.itemId, place);
    }
  }
}

export const sync = {
  /** Run once at a time; a run while one is going waits for it. Offline (or the server unreachable) it only expires. */
  run() {
    // Asked during a run (a profile switch, a re-rating): one more run after it, so the answer is current.
    if (running) return (again ||= running.then(() => ((again = null), sync.run())));
    running = runNow()
      .catch(async () => ({ removed: await expire().catch(() => []), sent: 0 }))
      .finally(() => (running = null));
    return running;
  },
  expire: (profileId, now) => expire(profileId, now),
  set offlineDays(d) {
    if (Number(d) > 0) offlineDays = Number(d);
  },
};

// Every 6 hours while the app is open, and when the connection comes back.
setInterval(() => navigator.onLine && downloads.profileId != null && sync.run(), 6 * 3600_000);
