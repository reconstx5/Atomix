// Atomix's Subsonic API (/rest/<method>[.view]) for phone and desktop music apps: Symfonium, Amperfy, play:Sub,
// Feishin… Not the JSON /api/ router: Subsonic takes query or form parameters, signs in with an app password on every
// request, and answers HTTP 200 with its own envelope. The app password's profile is who's listening: its library
// access and Kids rules apply to every method through the same viewer the web uses.
import { readBody, HttpError } from '../http/router.js';
import { logger } from '../log.js';
import { envelope, send, SubsonicError, MESSAGES } from './envelope.js';

const log = logger('subsonic');
const FORM_LIMIT = 64 * 1024;

class Params {
  constructor(entries) {
    this.map = new Map();
    for (const [k, v] of entries) {
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(v);
    }
  }
  get(name) {
    return this.map.get(name)?.[0] ?? null;
  }
  all(name) {
    return this.map.get(name) || [];
  }
  has(name) {
    return this.map.has(name);
  }
  /** A required parameter (error 10 when it's missing). */
  need(name) {
    const v = this.get(name);
    if (v === null || v === '') throw new SubsonicError(10, `Required parameter is missing: ${name}`);
    return v;
  }
  int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
    const v = this.get(name);
    const n = v === null || v === '' ? fallback : Number(v);
    if (n === undefined || n === null) return n;
    if (!Number.isFinite(n)) throw new SubsonicError(0, `${name} must be a number`);
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }
  bool(name, fallback = false) {
    const v = this.get(name);
    return v === null ? fallback : v === 'true' || v === '1';
  }
}

export class Subsonic {
  constructor(core) {
    this.core = core;
    this.methods = new Map();
  }

  /** Register a method: fn(ctx) returns the body to merge into the envelope, or handles `ctx.res` itself. */
  method(name, fn, { auth = true } = {}) {
    this.methods.set(name, { fn, auth });
  }

  async params(req, url) {
    const entries = [...url.searchParams];
    const type = String(req.headers['content-type'] || '');
    if (req.method === 'POST' && type.startsWith('application/x-www-form-urlencoded')) {
      const buf = await readBody(req, FORM_LIMIT, { timeoutMs: 15000 });
      entries.push(...new URLSearchParams(buf.toString('utf8')));
    }
    return new Params(entries);
  }

  signIn(req, params) {
    const { auth, appPasswords } = this.core;
    try {
      auth.checkRateLimit(req);
    } catch (err) {
      throw new SubsonicError(40, err.message);
    }
    const who = appPasswords.check({ username: params.get('u'), token: params.get('t'), salt: params.get('s'), password: params.get('p'), apiKey: params.get('apiKey') });
    if (who.error) {
      if (who.error === 10) throw new SubsonicError(10, `Required parameter is missing: ${who.missing}`);
      auth.recordFailure(req);
      throw new SubsonicError(who.error, MESSAGES[who.error]);
    }
    // A success doesn't clear the address's failed attempts: an app's steady calls would otherwise reset the
    // lockout for every device behind the same address (a home router, a reverse proxy).
    if (!who.appPassword.last_used_at) this.core.activity?.add({ type: 'app-password', userId: who.user.id, profileId: who.profile.id, text: `${who.appPassword.name} signed in for the first time`, ip: auth.clientIp(req) });
    appPasswords.touch(who.appPassword.id);
    return who;
  }

  async handle(req, res, url) {
    let params = new Params([...url.searchParams]);
    const name = url.pathname.slice('/rest/'.length).replace(/\.view$/, '');
    const reply = (status, body) => send(res, params, envelope(this.core.version, status, body));
    try {
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') throw new SubsonicError(0, 'Use GET or POST');
      params = await this.params(req, url);
      const m = this.methods.get(name);
      const ctx = { core: this.core, params, req, res, user: null, profile: null, viewer: null, appPassword: null, method: name };
      if (!m || m.auth) {
        const who = this.signIn(req, params);
        Object.assign(ctx, who, { viewer: this.core.profiles.viewer(who.user, who.profile) });
      }
      if (!m) throw new SubsonicError(0, MESSAGES[0]);
      const body = await m.fn(ctx);
      if (res.headersSent || res.writableEnded) return;
      reply('ok', body || {});
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      let code = err instanceof SubsonicError ? err.code : 0;
      if (err instanceof HttpError && err.status === 404) code = 70;
      if (err instanceof HttpError && err.status === 403) code = 50;
      if (!(err instanceof SubsonicError) && !(err instanceof HttpError)) log.error(`${name}: ${err.stack || err.message}`);
      else log.debug(`${name}: ${code} ${err.message}`);
      reply('failed', { error: { code, message: err.message || MESSAGES[code] || 'Something went wrong' } });
    }
  }
}
