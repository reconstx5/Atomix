// Casting: the device list, adding a TV by address (admins), and the remote — start a cast, poll it, command it.
import { HttpError } from '../http/router.js';
import { baseUrlFor } from '../cast/devices.js';

const admin = { auth: 'admin' };
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

export function registerCastRoutes(r, core) {
  const { settings, config } = core;
  const devices = () => core.cast.devices;
  const manager = () => core.cast.manager;

  r.get('/api/cast/devices', async (ctx) => {
    const enabled = Boolean(settings.get('castEnabled'));
    // The server's home-network address, and a network scan on demand, are for admins; everyone else sees the list.
    const isAdmin = ctx.user.role === 'admin' && !ctx.profile?.kids;
    const found = baseUrlFor(null, { settings: settings.all(), config, port: core.listening?.port || config.port });
    const baseUrl = isAdmin ? found : null;
    if (!enabled) return { enabled, baseUrl, reachable: Boolean(found), devices: [] };
    const list = await devices().list({ refresh: isAdmin && ctx.query.refresh === '1' });
    // A device on this machine (a dev mock, a TV app on the same box) is reachable even with no home-network address.
    const local = list.some((d) => /^(127\.|localhost$)/.test(d.kind === 'chromecast' ? d.host : hostOf(d.location)));
    return {
      enabled,
      baseUrl,
      reachable: Boolean(found) || local,
      devices: list.map((d) => ({ id: d.id, kind: d.kind, name: d.name, model: d.model || null, manual: Boolean(d.manual), busy: manager().busy(d.id) })),
    };
  });

  r.post(
    '/api/cast/devices',
    async (ctx) => {
      const body = await ctx.body();
      const d = await devices().addManual({ kind: body.kind, address: String(body.address || ''), name: body.name });
      return { id: d.id, kind: d.kind, name: d.name, model: d.model || null, manual: true, busy: false };
    },
    admin,
  );

  r.delete(
    '/api/cast/devices/:id',
    (ctx) => {
      devices().remove(ctx.params.id);
      return { ok: true };
    },
    admin,
  );

  r.post('/api/cast/sessions', async (ctx) => {
    const body = await ctx.body();
    if (!body.deviceId) throw new HttpError(400, 'Choose a TV.');
    const queue = body.queue && Array.isArray(body.queue.itemIds) ? { itemIds: body.queue.itemIds, index: body.queue.index } : null;
    if (!queue && body.itemId == null) throw new HttpError(400, 'Choose something to cast.');
    return manager().start({
      user: ctx.user,
      profile: ctx.profile,
      viewer: ctx.viewer,
      deviceId: String(body.deviceId),
      itemId: body.itemId,
      queue,
      position: body.position,
      audioIndex: body.audioIndex,
      subtitle: body.subtitle ? String(body.subtitle) : null,
    });
  });

  r.get('/api/cast/sessions/current', (ctx) => manager().current(ctx.user, ctx.viewer) ?? undefined);

  r.post('/api/cast/sessions/:id/:command', async (ctx) => {
    const body = await ctx.body();
    return manager().command(ctx.params.id, { user: ctx.user, viewer: ctx.viewer }, ctx.params.command, body);
  });
}
