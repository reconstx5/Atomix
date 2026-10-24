// Downloads (v0.21): a device asks for copies to be prepared, follows them, fetches them in pieces, and checks now and
// then which of its downloads it may keep. Copies come from the download queue (src/downloads/queue.js).
import { AUDIO_KINDS, READING_KINDS } from '../library/kinds.js';
import { HttpError } from '../http/router.js';
import { sendFile, mimeFor } from '../http/static.js';
import { isRemotePath } from '../remote/index.js';
import { listSubtitles, getSubtitleVtt } from '../stream/subtitles.js';
import { recordProgress } from '../library/progress.js';
import { parseCaps } from './playback.js';
import { downloadFormat } from '../downloads/plan.js';
import { requireDownloads, requireAccountDownloads, FetchedOnce } from '../downloads/rules.js';
import { parseJson } from '../db.js';
import { placeOnBook } from '../library/audiobooks.js';

const MAX_TITLES = 1000; // one request prepares at most this many titles

const REMOTE = "Downloads aren't available for titles from a connected server yet.";
const PLAYABLE = new Set(['movie', 'episode', 'track', 'podcast_episode', 'chapter', 'book', 'comic']); // v0.22: an episode or a book's part on its own
const EXT_TYPES = { m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', epub: 'application/epub+zip', cbz: 'application/vnd.comicbook+zip' };

export function registerDownloadRoutes(r, core) {
  const { db, library, settings } = core;
  const fetched = new FetchedOnce(); // "<session>:<job>" — the activity line is written once per job per sign-in (kept 24 h)

  /** A title's playable titles, in order: itself, a season's or show's episodes, an album's or artist's songs. */
  function expand(row, viewer) {
    if (PLAYABLE.has(row.kind)) return [row];
    if (row.kind === 'season') return db.all("SELECT * FROM items WHERE parent_id = ? AND kind = 'episode' ORDER BY episode, id", row.id);
    if (row.kind === 'show') return db.all("SELECT * FROM items WHERE show_id = ? AND kind = 'episode' ORDER BY season = 0, season, episode, id", row.id);
    if (row.kind === 'album') return db.all("SELECT * FROM items WHERE parent_id = ? AND kind = 'track' ORDER BY season, episode, sort_title, id", row.id);
    if (row.kind === 'artist') return library.tracks({ viewer, artistId: row.id, limit: 5000 });
    // v0.22: a podcast's downloaded episodes (newest first); a book's own file, or its parts in order.
    if (row.kind === 'podcast') return db.all("SELECT * FROM items WHERE show_id = ? AND kind = 'podcast_episode' AND path IS NOT NULL ORDER BY published_at DESC, id DESC", row.id);
    if (row.kind === 'audiobook') return row.path ? [row] : db.all("SELECT * FROM items WHERE parent_id = ? AND kind = 'chapter' ORDER BY episode, id", row.id);
    // v0.22: a series' books or comics, in number order.
    if (row.kind === 'series') return db.all("SELECT * FROM items WHERE show_id = ? AND kind IN ('book', 'comic') ORDER BY issue_sort IS NULL, issue_sort, sort_title", row.id);
    return [];
  }

  /** The job, and its title, when this profile may watch it — else a 404 (a title it can't see doesn't exist for it). */
  function jobFor(ctx) {
    const job = core.downloads.get(Number(ctx.params.jobId));
    const item = job && library.get(job.item_id);
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'This download is no longer here.');
    return { job, item };
  }

  r.post('/api/downloads', async (ctx) => {
    requireDownloads(ctx.user, settings);
    const body = await ctx.body();
    const quality = ['480', '720', '1080'].includes(String(body.quality)) ? String(body.quality) : settings.get('downloadQuality') || '720';
    const caps = parseCaps(body.caps);
    let ids = (Array.isArray(body.itemIds) ? body.itemIds : []).map(Number).filter(Number.isInteger).slice(0, 500);
    if (body.listId != null) {
      // A playlist: its titles the profile may see, in the list's order.
      const list = core.lists.get(Number(body.listId));
      if (!list || !core.lists.visibleTo(list, ctx.viewer)) throw new HttpError(404, 'Playlist not found');
      ids = core.lists.rows(list.id, ctx.viewer).map((row) => row.id).slice(0, 500);
    }
    const out = [];
    const seen = new Set();
    let skipped = 0;
    for (const id of ids) {
      const row = library.get(id);
      if (!row) {
        skipped++;
        continue;
      }
      if (ids.length === 1 && PLAYABLE.has(row.kind) && isRemotePath(row.path)) throw new HttpError(400, REMOTE);
      const titles = expand(row, ctx.viewer);
      if (!titles.length) skipped++; // nothing to download here (an extra, a collection…)
      for (const t of titles) {
        if (seen.has(t.id)) continue;
        if (out.length >= MAX_TITLES) break;
        seen.add(t.id);
        if (!library.canSee(ctx.viewer, t) || isRemotePath(t.path) || !t.path) {
          skipped++;
          continue;
        }
        let format = downloadFormat(t.kind, caps);
        if (format === 'audio') {
          const media = parseJson(t.media, null);
          const codec = (media?.audio || [])[media?.defaultAudio ?? 0]?.codec;
          if (codec && caps.audio.includes(codec)) format = 'original'; // the browser plays it as it is
          else if (caps.audio.length && !caps.audio.includes('aac')) format = 'webm'; // no AAC here: Opus in WebM
        }
        const job = core.downloads.request(t, { quality: AUDIO_KINDS.has(t.kind) ? 'audio' : READING_KINDS.has(t.kind) ? 'file' : quality, format });
        out.push({ itemId: t.id, jobId: job.id, status: job.status, progress: job.progress, size: job.size ?? null, format, title: t.title, kind: t.kind });
      }
    }
    return { items: out, skipped };
  });

  r.get('/api/downloads/jobs', (ctx) => {
    requireAccountDownloads(ctx.user, settings);
    const ids = String(ctx.query.ids || '').split(',').map(Number).filter(Number.isInteger).slice(0, 500);
    // A job that went (or whose title this profile may not see) answers "gone", so the device stops asking for it.
    return ids.map((id) => {
      const j = core.downloads.get(id);
      if (!j || !library.canSee(ctx.viewer, library.get(j.item_id))) return { id, status: 'gone' };
      return { id: j.id, itemId: j.item_id, status: j.status, progress: j.progress, size: j.size ?? null, error: j.error ?? null, ext: j.status === 'ready' && j.file ? j.file.split('.').pop() : null };
    });
  });

  r.get('/api/downloads/:jobId/file', async (ctx) => {
    requireDownloads(ctx.user, settings);
    const { job, item } = jobFor(ctx);
    const file = core.downloads.fileFor(job.id);
    if (!file) throw new HttpError(404, "This download isn't ready yet.");
    const range = String(ctx.req.headers.range || '');
    const key = `${ctx.user.token_hash || ctx.user.id}:${job.id}`;
    if ((!range || /^bytes=0-/.test(range)) && fetched.first(key)) {
      core.activity?.add({ type: 'download', userId: ctx.user.id, profileId: ctx.profile?.id ?? null, text: `${ctx.user.username} downloaded ${item.title}${job.quality === 'audio' ? '' : ` (${job.quality}p)`}` });
    }
    const ext = file.split('.').pop();
    const ok = await sendFile(ctx.req, ctx.res, file, { cacheControl: 'private, no-store', contentType: EXT_TYPES[ext] || mimeFor(file) });
    if (!ok) throw new HttpError(404, "This download isn't ready yet.");
  });

  r.get('/api/downloads/:jobId/subtitles', (ctx) => {
    requireAccountDownloads(ctx.user, settings);
    const { job, item } = jobFor(ctx);
    return listSubtitles(item, core.config)
      .filter((s) => s.kind === 'text')
      .map((s) => ({ id: s.id, label: s.label, language: s.language || null, url: `/api/downloads/${job.id}/subtitles/${encodeURIComponent(s.id)}` }));
  });

  r.get('/api/downloads/:jobId/subtitles/:sub', async (ctx) => {
    requireAccountDownloads(ctx.user, settings);
    const { item } = jobFor(ctx);
    const vtt = await getSubtitleVtt(item, String(ctx.params.sub), core.config, null, { slot: () => core.playback.extractionSlot() });
    if (vtt == null) throw new HttpError(404, 'Subtitle not found');
    ctx.res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-store' });
    ctx.res.end(vtt);
  });

  // Which of a device's downloads it may keep. Answered even when downloads are off, so the device can tidy up.
  r.post('/api/downloads/check', async (ctx) => {
    const body = await ctx.body();
    const ids = (Array.isArray(body.itemIds) ? body.itemIds : []).map(Number).filter(Number.isInteger).slice(0, 5000);
    // The server's own switch only stops new downloads (an admin may turn it off for a while); an account switched
    // off, or a title the profile may no longer watch, is removed.
    const allowed = ctx.user.role === 'admin' || ctx.user.can_download === 1;
    const keep = [];
    const remove = [];
    for (const id of ids) {
      const row = library.get(id);
      (allowed && row && library.canSee(ctx.viewer, row) ? keep : remove).push(id);
    }
    return { keep, remove, offlineDays: settings.get('downloadOfflineDays') || 30 };
  });

  // Progress saved while offline: each entry counts only when it is newer than what the server already has.
  r.post('/api/downloads/progress', async (ctx) => {
    const body = await ctx.body();
    const entries = (Array.isArray(body.entries) ? body.entries : []).slice(0, 1000);
    let saved = 0;
    // v0.22: a book's part reports the book's place (as when playing online) — so two parts of one book are one title,
    // and only the later listening counts (the device keeps a row per part).
    const newest = new Map();
    for (const e of entries) {
      const found = library.get(Number(e.itemId));
      if (!found || !library.canSee(ctx.viewer, found) || !(['movie', 'episode'].includes(found.kind) || AUDIO_KINDS.has(found.kind) || READING_KINDS.has(found.kind))) continue;
      const place = placeOnBook(core.db, library, found, Number(e.position) || 0, Number(e.duration) || null);
      const at = Number(e.at) || 0;
      const was = newest.get(place.row.id);
      if (!was || at > was.at) newest.set(place.row.id, { ...place, at, locator: e.locator, device: e.device, watched: e.watched === true });
    }
    for (const { row, position, duration, at, locator, device, watched } of newest.values()) {
      const have = library.progressFor(ctx.viewer.profileId, [row.id]).get(row.id);
      if (have && have.updated_at >= at) continue;
      await recordProgress(core, { user: ctx.user, viewer: ctx.viewer, item: row, position, duration, client: 'offline', locator, device, watched });
      saved++;
    }
    return { saved };
  });
}
