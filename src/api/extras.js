// Seek-bar preview pictures, intro corrections, and the background task status.
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';

export function registerExtrasRoutes(r, core) {
  const { db, library, extras, tasks, config } = core;
  const admin = { auth: 'admin' };

  // v0.28 card motion: a title's preview sheets (a show: its first episode that has them), or 404.
  r.get('/api/items/:id/previews', (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Not found');
    let manifest = null;
    if (item.kind === 'show') {
      const eps = db.all("SELECT id FROM items WHERE show_id = ? AND kind = 'episode' ORDER BY season = 0, season, episode LIMIT 6", item.id);
      for (const e of eps) {
        const ep = library.get(e.id);
        if (ep && library.canSee(ctx.viewer, ep) && (manifest = extras.previewManifest(ep))) break;
      }
    } else if (['movie', 'episode', 'extra'].includes(item.kind)) manifest = extras.previewManifest(item);
    if (!manifest) throw new HttpError(404, 'No previews for this title yet');
    ctx.res.setHeader('Cache-Control', 'private, max-age=300');
    return manifest;
  });

  r.get('/api/items/:id/previews/:n', async (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Not found');
    const manifest = extras.previewManifest(item);
    const n = Number(ctx.params.n);
    if (!manifest || !Number.isInteger(n) || n < 1 || n > manifest.sheets) throw new HttpError(404, 'No preview here');
    const ok = await sendFile(ctx.req, ctx.res, path.join(config.previewsDir, String(item.id), `${n}.jpg`), { cacheControl: 'private, max-age=31536000, immutable' });
    if (!ok) throw new HttpError(404, 'No preview here');
  });

  // v0.28 card motion: the title's 5 s silent clip (Range, cached a day); follows the title's visibility.
  r.get('/api/items/:id/clip', async (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Not found');
    const none = new HttpError(404, 'No preview clip for this title.');
    if (extras.clipVersion(item) == null) throw none;
    const ok = await sendFile(ctx.req, ctx.res, path.join(config.previewsDir, String(item.id), 'clip.mp4'), { cacheControl: 'private, max-age=86400', contentType: 'video/mp4' });
    if (!ok) throw none;
  });

  const episode = (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || item.kind !== 'episode' || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Episode not found');
    return item;
  };
  const restOfSeason = (ep) => db.all("SELECT id, duration FROM items WHERE parent_id = ? AND kind = 'episode'", ep.parent_id);

  r.put(
    '/api/items/:id/markers/intro',
    async (ctx) => {
      const ep = episode(ctx);
      const body = await ctx.body();
      const targets = body.applyToSeason ? restOfSeason(ep) : [ep];
      if (body.none) {
        for (const t of targets) extras.setMarker(t.id, 'intro', { start: null, end: null, source: 'manual' });
        return extras.markers(ep.id);
      }
      const start = Number(body.start);
      const end = Number(body.end);
      if (body.start == null || body.end == null || !Number.isFinite(start) || !Number.isFinite(end)) throw new HttpError(400, 'Enter when the intro starts and ends.');
      if (start < 0) throw new HttpError(400, "The intro can't start before the episode does.");
      if (end <= start) throw new HttpError(400, 'The intro must end after it starts.');
      if (ep.duration && end > ep.duration) throw new HttpError(400, 'The intro must end before the episode does.');
      for (const t of targets) {
        if (t.duration && end > t.duration) continue; // too short for these times; leave it alone
        extras.setMarker(t.id, 'intro', { start, end, source: 'manual' });
      }
      return extras.markers(ep.id);
    },
    admin,
  );

  r.delete(
    '/api/items/:id/markers/intro',
    (ctx) => {
      const ep = episode(ctx);
      extras.deleteMarker(ep.id, 'intro');
      extras.clearIntroJobs(ep.parent_id);
      tasks.kick();
      return extras.markers(ep.id);
    },
    admin,
  );

  r.post(
    '/api/items/:id/markers/detect',
    (ctx) => {
      const ep = episode(ctx);
      extras.deleteMarker(ep.id, 'intro', { sources: ['audio'] });
      extras.clearIntroJobs(ep.parent_id);
      tasks.kick();
      return extras.markers(ep.id);
    },
    admin,
  );

  r.get('/api/admin/tasks', () => tasks.status(), admin);
  r.post(
    '/api/admin/tasks/retry',
    () => {
      const retried = extras.retryFailed();
      tasks.kick();
      return { retried };
    },
    admin,
  );
}
