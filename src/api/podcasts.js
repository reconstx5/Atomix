// Podcast routes (v0.22): subscribing (by feed address or from the directory), checking, keep settings, keeping an
// episode, unsubscribing — admins only (on a grown-up profile). Listening is through the usual item routes.
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';

export function registerPodcastRoutes(r, core) {
  const admin = { auth: 'admin' };
  const pods = () => core.podcasts;
  r.get('/api/podcasts/directory', (ctx) => pods().directory(ctx.query.q), admin);
  r.get(
    '/api/podcasts/directory/:id/art',
    async (ctx) => {
      const file = await pods().directoryArt(ctx.params.id);
      if (!file || !(await sendFile(ctx.req, ctx.res, file, { cacheControl: 'private, max-age=600' }))) throw new HttpError(404, 'No image');
    },
    admin,
  );
  r.post(
    '/api/podcasts',
    async (ctx) => {
      const b = await ctx.body();
      const row = await pods().subscribe({ libraryId: b.libraryId, feedUrl: b.feedUrl, directoryId: b.directoryId });
      return core.library.withProgress([row], ctx.viewer)[0];
    },
    admin,
  );
  r.post(
    '/api/podcasts/check-all',
    () => {
      const checked = core.db.get('SELECT COUNT(*) AS n FROM podcast_feeds').n;
      pods().checkAll().catch(() => {});
      return { checked };
    },
    admin,
  );
  r.post('/api/podcasts/:id/check', (ctx) => pods().check(ctx.params.id), admin);
  r.patch('/api/podcasts/:id', async (ctx) => pods().setKeep(ctx.params.id, await ctx.body()), admin);
  r.delete(
    '/api/podcasts/:id',
    async (ctx) => {
      await pods().unsubscribe(ctx.params.id);
      return { ok: true };
    },
    admin,
  );
  r.put(
    '/api/podcasts/episodes/:id/keep',
    async (ctx) => {
      pods().keepEpisode(ctx.params.id, (await ctx.body()).kept !== false);
      return { ok: true };
    },
    admin,
  );
}
