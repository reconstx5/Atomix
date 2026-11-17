// The Jellyfin routes a client calls before and around signing in: server info, ping, sign-in, logout, the user.
import crypto from 'node:crypto';
import { HttpError } from './index.js';
import { userDto } from './shapes.js';
import { fromGuid } from './ids.js';

// Infuse checks the server is a Jellyfin it knows; 10.10.x is the current stable line.
const VERSION = '10.10.7';
const PRODUCT = 'Jellyfin Server';

const operatingSystem = () => ({ win32: 'Windows', darwin: 'Darwin' })[process.platform] || 'Linux';

function localAddress(ctx) {
  const { core, req } = ctx;
  const host = (core.config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
  return `${core.auth.isSecure(req) ? 'https' : 'http'}://${host}/jellyfin`;
}

function publicInfo(ctx) {
  return {
    LocalAddress: localAddress(ctx),
    ServerName: ctx.core.settings.get('serverName') || 'Atomix',
    Version: VERSION,
    ProductName: PRODUCT,
    Id: ctx.serverId,
    StartupWizardCompleted: true,
  };
}

/** A Jellyfin session id for a token: made from the token's row, so it says nothing about the token itself. */
export const sessionIdOf = (tokenRow) => crypto.createHash('md5').update(`atomix-jellyfin-session:${tokenRow.id}`).digest('hex');

export function registerSystem(j) {
  j.route('GET', '/System/Info/Public', (ctx) => publicInfo(ctx), { auth: false });
  j.route('GET', '/System/Info', (ctx) => ({
    ...publicInfo(ctx),
    OperatingSystem: operatingSystem(),
    OperatingSystemDisplayName: operatingSystem(),
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: true,
    CanSelfRestart: false,
    CanLaunchWebBrowser: false,
    HasUpdateAvailable: false,
  }));
  j.route(['GET', 'POST'], '/System/Ping', () => PRODUCT, { auth: false });
  j.route('GET', '/Users/Public', () => [], { auth: false });

  j.route('POST', '/Users/AuthenticateByName', async (ctx) => {
    const { auth, appPasswords, activity } = ctx.core;
    auth.checkRateLimit(ctx.req); // the web's lockout: 429 once an address has failed 10 times
    const body = await ctx.body();
    const username = body?.Username ?? body?.username ?? '';
    const password = body?.Pw ?? body?.pw ?? body?.Password ?? body?.password ?? '';
    // Only the plain-password branch: no Subsonic token/salt or apiKey here.
    const who = appPasswords.check({ username: String(username), password: String(password) });
    if (who.error) {
      auth.recordFailure(ctx.req);
      throw new HttpError(401);
    }
    if (!who.appPassword.last_used_at) activity?.add({ type: 'app-password', userId: who.user.id, profileId: who.profile.id, text: `${who.appPassword.name} signed in for the first time`, ip: auth.clientIp(ctx.req) });
    appPasswords.touch(who.appPassword.id);
    const c = ctx.client;
    const token = j.tokens.issue({ appPasswordId: who.appPassword.id, deviceId: c.deviceId, deviceName: c.device, client: c.client, version: c.version });
    const tokenRow = j.tokens.check(token).tokenRow;
    const user = userDto(who.user, who.profile, { serverId: ctx.serverId });
    return {
      User: user,
      SessionInfo: { Id: sessionIdOf(tokenRow), UserId: user.Id, UserName: user.Name, DeviceId: c.deviceId, DeviceName: c.device, Client: c.client, ApplicationVersion: c.version, ServerId: ctx.serverId },
      AccessToken: token,
      ServerId: ctx.serverId,
    };
  }, { auth: false });

  j.route('POST', '/Sessions/Logout', (ctx) => {
    j.sessions?.stop?.(ctx.tokenRow.id); // Task 6: frees the token's stream slot
    j.tokens.logout(ctx.token);
    return null;
  });

  j.route('GET', '/Users/Me', (ctx) => userDto(ctx.user, ctx.profile, { serverId: ctx.serverId }));
  j.route('GET', '/Users/{userId}', (ctx) => {
    const id = fromGuid(ctx.params.userId);
    if (!id || id.kind !== 'user' || id.id !== ctx.profile.id) throw new HttpError(404);
    return userDto(ctx.user, ctx.profile, { serverId: ctx.serverId });
  });
}

