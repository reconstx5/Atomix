// Scrobbling settings for the signed-in profile: connect ListenBrainz (a token) or Last.fm (signing in on last.fm,
// which comes back to the callback here), see what was last sent, disconnect. Nothing here returns a token, a
// session key or the Last.fm secret.
import { HttpError } from '../http/router.js';

const SERVICES = ['listenbrainz', 'lastfm'];

export function registerScrobbleRoutes(r, core) {
  const origin = (ctx) => {
    const host = (core.config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host;
    return `${core.auth.isSecure(ctx.req) ? 'https' : 'http'}://${host}`;
  };
  r.get('/api/me/scrobblers', (ctx) => ({ services: core.scrobblers.status(ctx.profile.id), lastfmReady: core.scrobblers.lastfmReady() }));
  r.put('/api/me/scrobblers/listenbrainz', async (ctx) => core.scrobblers.connectListenBrainz(ctx.profile.id, (await ctx.body()).token));
  r.post('/api/me/scrobblers/lastfm/start', (ctx) => core.scrobblers.lastfmStart(ctx.profile.id, `${origin(ctx)}/api/scrobble/lastfm/callback`));
  r.get('/api/scrobble/lastfm/callback', async (ctx) => {
    let ok = true;
    try {
      await core.scrobblers.lastfmFinish(ctx.profile.id, { token: ctx.query.token, state: ctx.query.state });
    } catch {
      ok = false;
    }
    ctx.redirect(`/#/settings/profile?lastfm=${ok ? 'ok' : 'failed'}`);
  });
  r.delete('/api/me/scrobblers/:service', (ctx) => {
    if (!SERVICES.includes(ctx.params.service)) throw new HttpError(404, 'No such service');
    core.scrobblers.disconnect(ctx.profile.id, ctx.params.service);
  });
}
