// Playlists, the Watchlist and collections.
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';

export function registerListRoutes(r, core) {
  const { lists, collections, library, images } = core;

  const visible = (ctx, id) => {
    const list = lists.get(id);
    if (!list || !lists.visibleTo(list, ctx.viewer)) throw new HttpError(404, 'No such list');
    return list;
  };
  const own = (ctx, id) => {
    const list = visible(ctx, id);
    if (list.profile_id !== ctx.profile.id) throw new HttpError(403, 'Only the profile that made this playlist can change it.');
    return list;
  };
  const shape = (list, ctx) => ({ id: list.id, kind: list.kind, name: list.name, shared: Boolean(list.shared), own: list.profile_id === ctx.profile.id, items: lists.items(list.id, ctx.viewer) });

  r.get('/api/lists', (ctx) => lists.forProfile(ctx.profile, ctx.viewer));
  r.post('/api/lists', async (ctx) => {
    const b = await ctx.body();
    return shape(lists.create(ctx.profile.id, { kind: b.kind, name: b.name }), ctx);
  });
  r.get('/api/lists/:id', (ctx) => shape(visible(ctx, ctx.params.id), ctx));
  r.patch('/api/lists/:id', async (ctx) => {
    const list = own(ctx, ctx.params.id);
    const b = await ctx.body();
    if (b.name !== undefined) lists.rename(list.id, b.name);
    if (b.shared !== undefined) {
      if (ctx.profile.kids) throw new HttpError(403, "Kids profiles can't share playlists.");
      lists.setShared(list.id, Boolean(b.shared));
    }
    return shape(lists.get(list.id), ctx);
  });
  r.delete('/api/lists/:id', (ctx) => {
    lists.remove(own(ctx, ctx.params.id).id);
  });
  r.post('/api/lists/:id/items', async (ctx) => {
    const list = own(ctx, ctx.params.id);
    const b = await ctx.body();
    if (b.seasonId) {
      if (list.kind !== 'video') throw new HttpError(400, 'Seasons go in video playlists.');
      const season = library.get(Number(b.seasonId));
      if (!season || !library.canSee(ctx.viewer, season)) throw new HttpError(404, 'No such season');
      lists.addSeason(list.id, season.id);
      return;
    }
    const item = library.get(Number(b.itemId));
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'No such title');
    if (!lists.add(list.id, item.id)) {
      if (lists.contains(ctx.profile.id, item.id).lists.includes(list.id)) return; // already there: fine
      throw new HttpError(400, list.kind === 'music' ? 'A song playlist takes songs.' : 'A video playlist takes films and episodes (add a season for a show).');
    }
  });
  r.delete('/api/lists/:id/items/:itemId', (ctx) => {
    lists.removeItem(own(ctx, ctx.params.id).id, ctx.params.itemId);
  });
  r.put('/api/lists/:id/items/:itemId/position', async (ctx) => {
    const b = await ctx.body();
    lists.move(own(ctx, ctx.params.id).id, ctx.params.itemId, Number(b.position));
  });

  r.put('/api/watchlist/:itemId', (ctx) => {
    const item = library.get(Number(ctx.params.itemId));
    if (!item || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'No such title');
    if (!['movie', 'show'].includes(item.kind)) throw new HttpError(400, 'The Watchlist takes films and shows.');
    lists.add(lists.watchlist(ctx.profile.id).id, item.id);
  });
  r.delete('/api/watchlist/:itemId', (ctx) => {
    lists.removeItem(lists.watchlist(ctx.profile.id).id, ctx.params.itemId);
  });

  // ?all=1 (admins, Settings): hidden and empty collections too, with every member whatever the profile may watch.
  const everything = (ctx) => ctx.user.role === 'admin' && !ctx.profile.kids && ctx.query.all === '1';
  r.get('/api/collections', (ctx) => collections.list(ctx.viewer, { includeHidden: everything(ctx), everything: everything(ctx) }));
  r.get('/api/collections/:id', (ctx) => {
    const c = collections.get(ctx.params.id, ctx.viewer, { everything: everything(ctx) });
    if (!c) throw new HttpError(404, 'No such collection');
    return c;
  });
  r.get('/api/collections/:id/image/:type', async (ctx) => {
    const c = collections.row(ctx.params.id);
    const type = ctx.params.type === 'backdrop' ? 'backdrop' : 'poster';
    const resolved = images.resolve(c?.[type]);
    if (!resolved) throw new HttpError(404, 'No image');
    if (resolved.url) return ctx.redirect(resolved.url);
    const ok = await sendFile(ctx.req, ctx.res, resolved.file, { cacheControl: 'private, max-age=604800' });
    if (!ok) throw new HttpError(404, 'Image missing');
  });
  r.post('/api/collections', async (ctx) => collections.create(await ctx.body()), { auth: 'admin' });
  r.patch('/api/collections/:id', async (ctx) => collections.update(ctx.params.id, await ctx.body()), { auth: 'admin' });
  r.delete('/api/collections/:id', (ctx) => {
    collections.remove(ctx.params.id);
  }, { auth: 'admin' });

  r.get('/api/playback/next', (ctx) => {
    const list = visible(ctx, ctx.query.list);
    const next = lists.nextIn(list.id, ctx.query.after, ctx.viewer);
    return { next: next ? library.withProgress([next], ctx.viewer)[0] : null };
  });
}
