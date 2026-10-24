// Downloading into the app (v0.21): the server prepares a copy (Plan A), then this device fetches it in pieces written
// at their byte offsets, so a lost connection or a closed app resumes where it stopped. Two at a time, only while the
// app is open. Each profile's downloads are its own.
import { api, ApiError } from '../api.js';
import { detectCaps } from '../caps.js';
import { openStore } from './store.js';

const PIECE = 8 * 1024 * 1024;
const POLL_MS = 3000;
const AT_ONCE = 2;
const FULL = 'This device is out of space for downloads';
const EXTS = { mp4: 'mp4', webm: 'webm', audio: 'm4a', epub: 'epub', cbz: 'cbz' };

const events = new EventTarget();
let profileId = null;
let storeP = null;
const store = () => (storeP ||= openStore());
const active = new Map(); // "<profileId>:<itemId>" → { stop: boolean }
const key = (pid, itemId) => `${pid}:${itemId}`;
let deviceGb = 20;
let persistAsked = false;

// v0.22: one tab runs the downloads (a Web Lock held while it is open); the others say "Downloading in another tab",
// hear its changes on a channel, and take over when it closes.
const LOCK = 'atomix-downloads';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('atomix-downloads') : null;
let lock = typeof navigator !== 'undefined' && navigator.locks ? 'none' : 'held'; // 'none' | 'asking' | 'waiting' | 'held'
const local = (itemId) => events.dispatchEvent(new CustomEvent('change', { detail: { itemId } }));
const emit = (itemId) => {
  local(itemId);
  channel?.postMessage({ change: itemId ?? null });
};
let release = null;
// Held while the tab is open — or until a phone freezes it in the background (it lets go, and asks again on resume).
const hold = () => new Promise((resolve) => (release = resolve));
function claim() {
  if (lock !== 'none') return;
  lock = 'asking';
  const run = () => {
    lock = 'held';
    local(null);
    pump();
    return hold();
  };
  navigator.locks
    .request(LOCK, { ifAvailable: true }, (got) => {
      if (got) return run();
      lock = 'waiting';
      local(null);
      askIfSeen();
      navigator.locks.request(LOCK, run).catch(() => {});
      return null;
    })
    .catch(() => {
      lock = 'held'; // no locks after all: this tab downloads
      pump();
    });
}
/** Let another tab have the downloads (they carry on from where they stopped there), then queue to have them back. */
function handOver() {
  if (lock !== 'held' || !release) return;
  for (const run of active.values()) run.stop = true;
  lock = 'none';
  release();
  release = null;
  local(null);
  setTimeout(() => profileId != null && claim(), 1000); // behind the tab that asked
}
const seen = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
/** A waiting tab that is being looked at asks for the downloads; a holder in the background gives them up. */
const askIfSeen = () => lock === 'waiting' && seen() && channel?.postMessage({ want: true });
if (typeof document !== 'undefined') {
  document.addEventListener('freeze', handOver); // a phone freezing this tab: it couldn't download anyway
  document.addEventListener('resume', () => pump());
  document.addEventListener('visibilitychange', () => {
    if (seen()) askIfSeen();
    else if (lock === 'held') channel?.postMessage({ hidden: true }); // a tab being looked at may take over
  });
}
channel?.addEventListener('message', ({ data }) => {
  if (!data) return;
  if ('change' in data) local(data.change);
  if (data.pump && lock === 'held') pump(); // a download started (or resumed) in another tab
  if (data.want && lock === 'held' && !seen()) handOver();
  if (data.hidden) askIfSeen();
  if (data.stop && lock === 'held') {
    const run = active.get(data.stop);
    if (run) run.stop = true;
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The server out of reach (no connection, a proxy's 5xx, something that isn't Atomix answering): wait, don't fail. */
const unreachable = (err) => !(err instanceof ApiError) || err.status >= 500;

// Every function below is handed the profile its download belongs to: who is watching may change while a piece is
// on its way, and the piece still belongs where it started.
async function update(pid, itemId, changes) {
  const next = await (await store()).patch(pid, itemId, changes);
  if (next) emit(itemId);
  return next;
}
/** A change that a pause (made meanwhile) keeps its status through. */
const progress = (pid, itemId, changes) => update(pid, itemId, (cur) => (cur.status === 'paused' ? { ...changes, status: 'paused' } : changes));

/** Is there room for this download: the browser's quota for what's still to come, and the server's per-device limit
 *  for the whole of it (this download itself counted once). */
async function room(e, offset) {
  const s = await store();
  let others = 0;
  for (const x of await s.all()) if (!(x.profileId === e.profileId && x.itemId === e.itemId)) others += x.bytes || x.size || 0;
  const est = (await navigator.storage.estimate?.()) || {};
  const free = est.quota != null ? est.quota - (est.usage || 0) : Infinity;
  return e.size - offset <= free && others + e.size <= deviceGb * 1024 ** 3;
}

async function details(itemId) {
  const d = await api.get(`/api/items/${itemId}`).catch(() => null);
  if (!d?.item) return null; // not reachable now: asked again when the download next runs
  const it = d.item;
  const out = {
    title: it.title,
    kind: it.kind,
    year: it.year ?? null,
    season: it.season ?? null,
    episode: it.episode ?? null,
    showId: it.showId ?? d?.show?.id ?? null,
    showTitle: d?.show?.title ?? it.showTitle ?? null,
    parentId: it.parentId ?? null,
    albumTitle: it.albumTitle ?? null,
    artist: it.artist ?? null,
    duration: it.duration ?? null,
    overview: it.overview ?? null,
    position: it.progress?.position ?? 0,
    positionAt: it.progress?.updatedAt ?? null,
    watched: Boolean(it.progress?.watched),
    detailsAt: Date.now(),
  };
  // v0.22: a book's part keeps its book (title, author, every part and chapter, the book's place), so the Downloads
  // page groups the parts and plays them as one book; an episode keeps its podcast's name.
  let bookPoster = null;
  if (it.kind === 'chapter' || it.kind === 'audiobook') {
    const b = it.kind === 'audiobook' ? d : await api.get(`/api/items/${it.parentId}`).catch(() => null);
    if (b?.item) {
      const bp = b.item.progress;
      out.book = { id: b.item.id, title: b.item.title, author: b.item.author || null, parts: b.parts || [], chapters: b.chapters || [], position: bp?.position ?? 0, positionAt: bp?.updatedAt ?? null, watched: Boolean(bp?.watched) };
      out.artist = b.item.author || null;
      bookPoster = b.item.poster || null;
    }
  }
  if (it.kind === 'podcast_episode') out.publishedAt = it.publishedAt ?? null;
  // v0.22 Plan D: what the readers need with no connection — a book's reading order and contents, a comic's pages,
  // its series and which way it reads — and the place known when it came.
  if (it.kind === 'book') Object.assign(out, { spine: d.spine || [], toc: d.toc || [], opfDir: d.opfDir || '', author: it.author || null });
  if (it.kind === 'comic') Object.assign(out, { pages: d.pages || [], pageCount: it.pageCount ?? null, issue: it.issue ?? null, readingDir: d.show?.readingDir || it.readingDir || null, seriesId: d.show?.id ?? null });
  if (it.kind === 'book' || it.kind === 'comic') out.progress = it.progress || null;
  // A small poster to show offline (the server's own artwork, kept as a picture in the index).
  const poster = it.poster || it.albumPoster || bookPoster || d?.show?.poster;
  if (poster) {
    try {
      const r = await fetch(poster, { credentials: 'same-origin' });
      if (r.ok) out.poster = await r.blob();
    } catch {
      /* no picture: the page shows the title */
    }
  }
  return out;
}

async function fetchSubtitles(e) {
  const s = await store();
  const subs = await api.get(`/api/downloads/${e.jobId}/subtitles`).catch(() => []);
  const kept = [];
  for (const sub of Array.isArray(subs) ? subs : []) {
    try {
      const r = await fetch(sub.url, { credentials: 'same-origin' });
      if (!r.ok) continue;
      await s.writeFile(e.profileId, `${e.itemId}.${sub.id}.vtt`, await r.blob());
      kept.push({ id: sub.id, label: sub.label, language: sub.language });
    } catch {
      /* a subtitle that didn't come: the film still plays */
    }
  }
  return kept;
}

/** One download's pieces, from what is already on the device (when it is this same copy) to the end. */
async function fetchPieces(pid, itemId, run) {
  const s = await store();
  let e = await s.get(pid, itemId);
  if (!e) return 'gone';
  let wait = 2000;
  const backoff = async () => {
    await progress(pid, itemId, { status: 'waiting' });
    await sleep(wait);
    wait = Math.min(60000, wait * 2);
  };
  // The bytes on the device count only when they were written for this copy (its job and its size); anything else —
  // half a file from a cancelled or failed download, a copy the server made again — starts over.
  let offset = e.fileJob === e.jobId && e.fileSize === e.size ? await s.bytesOnDisk(pid, itemId, e.ext) : -1;
  if (offset < 0 || offset > e.size) {
    await s.removeFiles(pid, itemId);
    offset = 0;
  }
  e = await update(pid, itemId, { fileJob: e.jobId, fileSize: e.size });
  if (!e) return 'gone';
  if (!(await room(e, offset))) return fail(pid, itemId, FULL, true);
  e = await progress(pid, itemId, { status: 'downloading', bytes: offset, error: null });
  if (!e) return 'gone';
  if (e.status === 'paused') return 'stopped';
  while (offset < e.size && !run.stop) {
    const end = Math.min(e.size, offset + downloads.pieceBytes) - 1;
    let r;
    let buf;
    try {
      r = await fetch(`/api/downloads/${e.jobId}/file`, { headers: { range: `bytes=${offset}-${end}` }, credentials: 'same-origin' });
      if (r.status === 206) buf = await r.arrayBuffer();
    } catch {
      // No connection (or it dropped mid-piece): wait, longer each time, while the app is open.
      await backoff();
      continue;
    }
    if (run.stop) break; // cancelled, paused or another profile while this piece came: it isn't written
    if (r.status === 404) {
      // The prepared copy went (the server keeps them a while): ask for it again.
      await progress(pid, itemId, { status: 'preparing', progress: 0 });
      return 'again';
    }
    if (r.status === 401) {
      await update(pid, itemId, { status: 'paused', error: 'Sign in to Atomix to carry on' });
      return 'stopped';
    }
    if (r.status === 403) return fail(pid, itemId, (await r.json().catch(() => ({}))).error || "Downloads aren't switched on for this account.");
    const total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') || '')?.[1]);
    if (r.status === 200 || r.status === 416 || (r.status === 206 && total !== e.size)) {
      // Not the same copy any more (a new one was prepared): start this one again from the beginning.
      await s.removeFiles(pid, itemId);
      await progress(pid, itemId, { bytes: 0, fileJob: null, status: 'preparing', progress: 0 });
      return 'again';
    }
    if (r.status !== 206) {
      await backoff(); // a proxy's 502 while Atomix restarts, and the like: the pieces so far stay
      continue;
    }
    const length = buf.byteLength; // read first: the buffer is handed to the writer and is empty afterwards
    try {
      await s.writeAt(pid, itemId, e.ext, offset, buf);
    } catch (err) {
      if (err?.name === 'QuotaExceededError') return fail(pid, itemId, FULL, true);
      if (run.stop) break;
      await backoff();
      continue;
    }
    wait = 2000;
    offset += length;
    e = await progress(pid, itemId, { status: 'downloading', bytes: offset });
    if (!e) return 'gone';
    if (e.status === 'paused') run.stop = true;
  }
  await s.closeFile(pid, itemId, e.ext);
  if (run.stop) return 'stopped';
  if ((await s.bytesOnDisk(pid, itemId, e.ext)) !== e.size) {
    await s.removeFiles(pid, itemId);
    await progress(pid, itemId, { bytes: 0, fileJob: null, status: 'preparing' });
    return 'again';
  }
  const subtitles = ['movie', 'episode'].includes(e.kind) ? await fetchSubtitles(e) : []; // films and episodes have them
  const now = Date.now();
  await update(pid, itemId, { status: 'ready', bytes: e.size, subtitles, downloadedAt: now, checkedAt: now, error: null });
  return 'done';
}

async function fail(pid, itemId, error, removeFile = false) {
  const s = await store();
  if (removeFile) {
    await s.removeFiles(pid, itemId);
    await update(pid, itemId, { bytes: 0, fileJob: null });
  }
  await update(pid, itemId, { status: 'failed', error });
  return 'failed';
}

/** Ask the server (again) for the copy, then follow it until it's ready. */
async function prepared(pid, itemId, run) {
  const s = await store();
  let wait = POLL_MS;
  const backoff = async () => {
    await progress(pid, itemId, { status: 'waiting' });
    await sleep(wait);
    wait = Math.min(60000, wait * 2);
  };
  for (;;) {
    if (run.stop) return null;
    const e = await s.get(pid, itemId);
    if (!e || e.status === 'paused') return null;
    let jobs;
    try {
      jobs = await api.get(`/api/downloads/jobs?ids=${e.jobId}`);
      if (!Array.isArray(jobs)) throw new TypeError('Not an answer from Atomix');
    } catch (err) {
      if (unreachable(err)) {
        await backoff();
        continue;
      }
      return fail(pid, itemId, err.message), null;
    }
    wait = POLL_MS;
    const job = jobs[0];
    if (!job || job.status === 'gone') {
      // The job went (the server answers "gone", or — before v0.22 — left it out): ask for it again.
      let r;
      try {
        r = await api.post('/api/downloads', { itemIds: [itemId], quality: e.quality, caps: detectCaps() });
      } catch (err) {
        if (unreachable(err)) {
          await backoff();
          continue;
        }
        return fail(pid, itemId, err.message), null;
      }
      const again = r?.items?.[0];
      if (!again) return fail(pid, itemId, "This title can't be downloaded any more."), null;
      await progress(pid, itemId, { jobId: again.jobId, status: 'preparing' });
      continue;
    }
    if (job.status === 'failed') return fail(pid, itemId, job.error || "Couldn't download"), null;
    if (job.status === 'ready') {
      const next = await progress(pid, itemId, { status: 'downloading', size: job.size, ext: job.ext || EXTS[e.format] || 'bin', progress: 1 });
      return next?.status === 'paused' ? null : next;
    }
    await progress(pid, itemId, { status: 'preparing', progress: job.progress || 0 });
    await sleep(POLL_MS);
  }
}

async function runOne(pid, itemId) {
  const run = { stop: false };
  active.set(key(pid, itemId), run);
  try {
    // Its details (for the page and the player offline), if the app closed before they came.
    const e0 = await (await store()).get(pid, itemId);
    if (e0 && !e0.detailsAt) details(itemId).then((d) => d && update(pid, itemId, d));
    for (;;) {
      const e = await prepared(pid, itemId, run);
      if (!e || run.stop) return;
      const r = await fetchPieces(pid, itemId, run);
      if (r !== 'again') return;
    }
  } finally {
    active.delete(key(pid, itemId));
    pump();
  }
}

/** Start the next waiting downloads of who's watching, two at a time. */
async function pump() {
  const pid = profileId;
  if (pid == null) return;
  if (lock !== 'held') {
    claim();
    if (lock !== 'held') return channel?.postMessage({ pump: true }); // the tab that holds it starts this
  }
  const s = await store();
  const queue = (await s.list(pid)).filter((e) => ['preparing', 'downloading', 'waiting'].includes(e.status) && !active.has(key(pid, e.itemId))).reverse();
  for (const e of queue) {
    if (active.size >= AT_ONCE || pid !== profileId) break;
    runOne(pid, e.itemId);
  }
}

export const downloads = {
  events,
  pieceBytes: PIECE,
  get profileId() {
    return profileId;
  },
  /** Another tab is running the downloads (v0.22). */
  get elsewhere() {
    return lock === 'waiting';
  },
  /** Downloads follow who's watching; the server's per-device limit comes with the status answer. */
  setProfile(profile, limits = null) {
    profileId = profile?.id ?? null;
    if (limits?.deviceGb) deviceGb = limits.deviceGb;
    for (const run of active.values()) run.stop = true;
    if (profileId != null) pump();
  },
  async start({ itemIds, listId } = {}, quality) {
    if (profileId == null) throw new Error('Choose who is watching first.');
    const pid = profileId;
    if (!persistAsked) {
      // Ask once per open that the browser keeps these files under storage pressure (it may say no).
      persistAsked = true;
      navigator.storage?.persist?.().catch(() => {});
    }
    const r = await api.post('/api/downloads', { itemIds, listId, quality, caps: detectCaps() });
    const s = await store();
    let added = 0;
    for (const it of r.items) {
      const have = await s.get(pid, it.itemId);
      if (have && have.status !== 'failed') continue;
      if (have) await s.remove(pid, it.itemId); // a failed one's half file doesn't carry over
      await s.put({ profileId: pid, itemId: it.itemId, jobId: it.jobId, title: it.title, kind: it.kind, format: it.format, quality: it.kind === 'track' ? null : quality, size: it.size || 0, bytes: 0, status: 'preparing', progress: it.progress || 0, addedAt: Date.now() + added });
      added++;
      emit(it.itemId);
      details(it.itemId).then((d) => d && update(pid, it.itemId, d));
    }
    pump();
    return { added, skipped: r.skipped };
  },
  async pause(itemId) {
    const run = active.get(key(profileId, itemId));
    if (run) run.stop = true;
    else channel?.postMessage({ stop: key(profileId, itemId) });
    await update(profileId, itemId, (cur) => (['ready', 'failed', 'expired'].includes(cur.status) ? null : { status: 'paused' }));
  },
  async resume(itemId) {
    await update(profileId, itemId, (cur) => (cur.status === 'paused' ? { status: 'downloading', error: null } : null));
    pump();
  },
  async cancel(itemId) {
    return this.remove(itemId);
  },
  /** Remove a download (this profile's, unless another is named) and its files. */
  async remove(itemId, pid = profileId) {
    const run = active.get(key(pid, itemId));
    if (run) run.stop = true;
    else channel?.postMessage({ stop: key(pid, itemId) });
    const s = await store();
    await s.remove(pid, itemId);
    emit(itemId);
  },
  async state(itemId) {
    const e = profileId == null ? null : await (await store()).get(profileId, itemId);
    if (!e) return null;
    return { profileId: e.profileId, status: e.status, progress: e.progress || 0, bytes: e.bytes || 0, size: e.size || 0, error: e.error || null };
  },
  /** At boot: carry on with the downloads a closed app left unfinished. */
  resumeAll() {
    pump();
  },
};
