// Seek-bar preview pictures, intro corrections, and the background task status.
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';

export function registerExtrasRoutes(r, core) {
  const { db, library, extras, tasks, config } = core;
  const admin = { auth: 'admin' };

  r.get('/api/items/:id/previews/:n', async (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Not found');
    const manifest = extras.previewManifest(item);
    const n = Number(ctx.params.n);
    if (!manifest || !Number.isInteger(n) || n < 1 || n > manifest.sheets) throw new HttpError(404, 'No preview here');
    const ok = await sendFile(ctx.req, ctx.res, path.join(config.previewsDir, String(item.id), `${n}.jpg`), { cacheControl: 'private, max-age=31536000, immutable' });
    if (!ok) throw new HttpError(404, 'No preview here');
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
