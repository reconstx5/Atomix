// Watch together over HTTP: start or join a room, the room's event stream (Server-Sent Events), and the members'
// actions. Any signed-in profile may join a room for a title it may see.
import { HttpError } from '../http/router.js';
import { Rooms } from '../together.js';

const ACTIONS = ['play', 'pause', 'seek', 'ready', 'buffering', 'ended', 'next', 'leave'];

export function registerTogetherRoutes(r, core) {
  const rooms = (core.together = new Rooms({
    library: core.library,
    nextOf: (room, current, viewer) => (room.listId ? core.lists.nextIn(room.listId, current.id, viewer || room.members.values().next().value?.viewer) : core.library.nextEpisode(current)),
    viewerOf: (m) => {
      const user = core.db.get('SELECT * FROM users WHERE id = ?', m.userId);
      const profile = user && core.profiles.get(user.id, m.profileId);
      return user && profile ? core.profiles.viewer(user, profile) : null;
    },
  }));
  setInterval(() => rooms.tick(), 1000).unref();
  const streams = new Set(); // open event streams, ended when Atomix stops (server.close waits for them otherwise)
  core.closeTogetherStreams = () => {
    for (const res of streams) res.end();
    streams.clear();
  };
  const who = (ctx) => ({ user: ctx.user, profile: ctx.profile, viewer: ctx.viewer });

  r.post('/api/together', async (ctx) => {
    const b = await ctx.body();
    const item = core.library.get(Number(b.itemId));
    if (!item || !core.library.canSee(ctx.viewer, item)) throw new HttpError(404, 'This title no longer exists.');
    const out = rooms.create({ ...who(ctx), item, position: Number(b.position) || 0, playing: b.playing === true, listId: b.listId && core.lists.get(Number(b.listId)) && core.lists.visibleTo(core.lists.get(Number(b.listId)), ctx.viewer) ? Number(b.listId) : null });
    core.activity?.add({ type: 'together', userId: ctx.user.id, profileId: ctx.profile.id, text: `${ctx.profile.name} started Watch together for ${item.title}`, ip: core.auth.clientIp(ctx.req) });
    return { code: out.room.code, member: out.member.id, itemId: item.id };
  });
  r.post('/api/together/:code/join', (ctx) => {
    const before = rooms.get(ctx.params.code).members.size;
    const out = rooms.join(ctx.params.code, who(ctx));
    if (rooms.get(out.room.code).members.size > before) core.activity?.add({ type: 'together', userId: ctx.user.id, profileId: ctx.profile.id, text: `${ctx.profile.name} joined Watch together`, ip: core.auth.clientIp(ctx.req) });
    return { code: out.room.code, member: out.member.id, itemId: out.room.itemId };
  });

  /** A member of this room, and of this profile. */
  const mine = (ctx, code, memberId) => {
    const room = rooms.get(code);
    const m = rooms.member(room, memberId);
    if (m.profileId !== ctx.profile.id || m.userId !== ctx.user.id) throw new HttpError(403, "You're not in this room.");
    return m;
  };

  r.get('/api/together/:code/events', (ctx) => {
    mine(ctx, ctx.params.code, ctx.query.member);
    const { res, req } = ctx;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    const send = (state) => res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    const off = rooms.connect(ctx.params.code, ctx.query.member, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    streams.add(res);
    const done = () => {
      clearInterval(ping);
      streams.delete(res);
      off();
    };
    req.on('close', done);
    res.on('close', done);
  });

  for (const action of ACTIONS) {
    r.post(`/api/together/:code/${action}`, async (ctx) => {
      const b = await ctx.body();
      mine(ctx, ctx.params.code, b.member);
      if (action === 'next') {
        const item = core.library.get(Number(b.itemId));
        if (!item || !core.library.canSee(ctx.viewer, item)) throw new HttpError(404, 'This title no longer exists.');
      }
      return rooms.act(ctx.params.code, b.member, action, b) || { ok: true };
    });
  }
}
