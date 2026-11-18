// Atomix's Jellyfin API (/jellyfin/…) for Infuse and other Jellyfin apps. Like src/subsonic/: its own small handler,
// not the JSON /api/ router. Answers are Jellyfin's JSON (PascalCase) with Jellyfin's status codes; error bodies are
// `{}`. A signed-in request carries a Jellyfin token (made at AuthenticateByName from an app password); the token's
// app password names the profile, and that profile's viewer (library access, Kids rules) decides what it can see.
//
// Tokens arrive in headers and in `api_key`/`ApiKey` query strings: no log line here prints a header, and the
// trace switch (ATOMIX_JELLYFIN_TRACE=1) prints the query with those values as ***.
import { readBody, sendJson, HttpError } from '../http/router.js';
import { logger } from '../log.js';
import { JellyfinTokens, readToken, readClient } from './tokens.js';

export { HttpError };

const log = logger('jellyfin');
const BODY_LIMIT = 1024 * 1024;
const TOUCH_EVERY_MS = 60_000; // a token's and its app password's "last used" is written at most once a minute
const SECRET_KEYS = /^(api_?key|token|x-emby-token|x-mediabrowser-token|pw|password)$/i;

/**
 * An error's text for a log line: any network address (a connected server's, with its token) as <address>, any
 * token=/api_key=/X-Emby-Token: style value as ***, and any 64-hex as ***. Stack frames (file://) stay readable.
 */
export function redactError(err) {
  return String(err?.stack || err)
    .replace(/\b(?:https?|wss?|rtmps?|rtsp|udp|ftp):\/\/[^\s'"<>)]+/gi, '<address>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<address>') // a bare IPv4 (ECONNREFUSED 10.0.0.5:8096)
    .replace(/\b(api_?key|apikey|access_?token|token|x-emby-token|x-mediabrowser-token|x-plex-token|authorization|pw|password|secret)(\s*[=:]\s*)("[^"]*"|[^\s&,;)'"]+)/gi, '$1$2***')
    .replace(/[0-9a-f]{64}/gi, '***');
}

/** The request's path and query for a log line, with every token-carrying value as *** (and any 64-hex too). */
export function redactUrl(url) {
  const parts = [];
  for (const [k, v] of url.searchParams) parts.push(`${k}=${SECRET_KEYS.test(k) ? '***' : v}`);
  const line = url.pathname + (parts.length ? `?${parts.join('&')}` : '');
  return line.replace(/[0-9a-f]{64}/gi, '***');
}

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .split('/')
    // A `{name}` may be a whole segment or part of one ('stream.{ext}').
    .map((seg) =>
      seg
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (m) {
            keys.push(m[1]);
            return '([^/]+)';
          }
          return part.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
        })
        .join(''),
    )
    .join('/');
  return { regex: new RegExp(`^${source}/?$`, 'i'), keys };
}

export class Jellyfin {
  constructor(core) {
    this.core = core;
    this.routes = [];
    this.tokens = new JellyfinTokens({ db: core.db });
    this.sessions = null; // Task 6: the playing sessions (one stream slot per token)
  }

  /**
   * Register a route. `pattern` is the path after /jellyfin (and an optional /emby), any capitals, with `{name}`
   * segments. `fn(ctx)` returns an object (sent as JSON 200), null/undefined (204), or answers `ctx.res` itself.
   */
  route(method, pattern, fn, { auth = true, adult = false } = {}) {
    const methods = [].concat(method).map((m) => m.toUpperCase());
    this.routes.push({ methods, pattern, fn, auth, adult, ...compile(pattern) });
  }

  serverId() {
    return this.core.settings.get('jellyfinServerId');
  }

  /** The best route for a path: the one with the fewest {name} segments, so '/Users/Me' wins over '/Users/{userId}'. */
  match(method, rest) {
    let found = null;
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(rest);
      if (!m) continue;
      pathMatched = true;
      const ok = r.methods.includes(method) || (method === 'HEAD' && r.methods.includes('GET'));
      if (!ok) continue;
      if (found && found.route.keys.length <= r.keys.length) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      found = { route: r, params };
    }
    return found || (pathMatched ? { methodNotAllowed: true } : null);
  }

  /** Signs a request in by its token. A bad token is null (401) and never counts toward the sign-in lockout. */
  signedIn(req, url) {
    const token = readToken(req, url);
    const who = token ? this.tokens.check(token) : null;
    if (!who) return null;
    const now = Date.now();
    if (!who.tokenRow.last_used_at || now - who.tokenRow.last_used_at > TOUCH_EVERY_MS) {
      this.tokens.touch(who.tokenRow.id);
      this.core.appPasswords.touch(who.appPassword.id);
    }
    return { ...who, token };
  }

  async handle(req, res, url) {
    const started = Date.now();
    const method = req.method.toUpperCase();
    if (this.core.config.jellyfinTrace) {
      res.once('close', () => log.info(`${method} ${redactUrl(url)} → ${res.statusCode} ${Date.now() - started}ms`));
    }
    const rest = url.pathname.replace(/^\/jellyfin/i, '').replace(/^\/emby(?=\/|$)/i, '') || '/';
    const found = this.match(method, rest);
    try {
      if (!found) throw new HttpError(404);
      if (found.methodNotAllowed) throw new HttpError(405);
      const { route, params } = found;
      let bodyPromise;
      const ctx = {
        core: this.core,
        req,
        res,
        url,
        query: Object.fromEntries([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v])),
        params,
        body: () => {
          bodyPromise ||= readBody(req, BODY_LIMIT, { timeoutMs: 15000 }).then((buf) => {
            if (!buf.length) return {};
            try {
              return JSON.parse(buf.toString('utf8'));
            } catch {
              throw new HttpError(400);
            }
          });
          return bodyPromise;
        },
        user: null,
        profile: null,
        viewer: null,
        token: null,
        tokenRow: null,
        appPassword: null,
        client: readClient(req),
        serverId: this.serverId(),
        redirect: (location) => res.writeHead(302, { Location: location }).end(),
      };
      if (route.auth) {
        const who = this.signedIn(req, url);
        if (!who) throw new HttpError(401);
        Object.assign(ctx, who, { viewer: this.core.profiles.viewer(who.user, who.profile) });
        if (route.adult && who.profile?.kids) throw new HttpError(403);
      }
      ctx.route = route.pattern;
      const out = await route.fn(ctx);
      if (res.headersSent || res.writableEnded) return;
      if (out == null) res.writeHead(204).end();
      else sendJson(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // Logged by method and route only: the address can carry a token (api_key), and an error from a connected
      // server's fetch can carry that server's address and token, so addresses and token values are taken out.
      if (status >= 500) log.error(`${method} ${found?.route?.pattern || 'unknown route'} failed: ${redactError(err)}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (status === 408 || status === 413) {
        res.setHeader('Connection', 'close');
        res.once('finish', () => setTimeout(() => req.destroy(), 1000).unref());
      }
      sendJson(res, status, {});
    }
  }
}
