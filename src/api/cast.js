// Casting: the device list, adding a TV by address (admins), and the remote — start a cast, poll it, command it.
import { HttpError } from '../http/router.js';
import { baseUrlFor } from '../cast/devices.js';
import { DLNA_ENCRYPTED, CANT_CAST_ENCRYPTED, castableChannel } from '../cast/sessions.js';

export { DLNA_ENCRYPTED };

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
    const live = liveTarget(ctx, body);
    if (!queue && body.itemId == null && !live) throw new HttpError(400, 'Choose something to cast.');
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
      live,
    });
  });

  /**
   * A channel (`liveChannelId`) or an archived programme (`catchupProgrammeId`), checked as this viewer sees Live TV.
   * The TV's channel up/down walk the viewer's channels (TV only, in number order), each checked again on the way.
   */
  function liveTarget(ctx, body) {
    if (body.liveChannelId == null && body.catchupProgrammeId == null) return null;
    const routes = core.live.routes;
    const who = { viewer: ctx.viewer, profile: ctx.profile, user: ctx.user };
    const visible = (id) => routes.visibleChannel(who, id);
    if (body.liveChannelId != null) {
      const channel = visible(body.liveChannelId);
      // Encrypted channels with Widevine, PlayReady or ClearKey play on a Chromecast (the TV's system is chosen when the
      // cast starts, v0.28); a FairPlay-only channel never.
      if (channel.drm && !castableChannel(channel)) throw new HttpError(400, CANT_CAST_ENCRYPTED);
      if (channel.radio) throw new HttpError(400, "Radio stations can't be cast yet");
      const order = () => routes.visibleChannels(who).filter((c) => !c.radio).map((c) => c.id);
      return { kind: 'live', channel, order, visible };
    }
    const programme = core.live.store.programme(body.catchupProgrammeId);
    if (!programme) throw new HttpError(404, 'This programme is no longer in the guide.');
    const channel = visible(programme.channelId);
    if (channel.drm) throw new HttpError(400, CANT_CAST_ENCRYPTED); // encrypted channels are live only
    const can = routes.abilities(channel, programme);
    if (!can.canCatchup && !can.canStartOver) throw new HttpError(400, "This programme can't be played from the archive");
    return { kind: 'catchup', channel, programme, visible };
  }

  r.get('/api/cast/sessions/current', (ctx) => manager().current(ctx.user, ctx.viewer) ?? undefined);

  r.post('/api/cast/sessions/:id/:command', async (ctx) => {
    const body = await ctx.body();
    return manager().command(ctx.params.id, { user: ctx.user, viewer: ctx.viewer }, ctx.params.command, body);
  });
}
