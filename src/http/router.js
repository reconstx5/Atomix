// A tiny router built on node:http — enough for a JSON API plus streaming.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:(\w+)(\*)?/g, (_, key, star) => {
      keys.push(key);
      return star ? '/(.*)' : '/([^/]+)';
    });
  return { regex: new RegExp(`^${source || ''}/?$`), keys };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * @param {string} method  GET | POST | PUT | PATCH | DELETE | *
   * @param {string} pattern e.g. /api/items/:id
   * @param {(ctx) => any} handler  return a value to send it as JSON
   * @param {{auth?: 'none'|'user'|'admin', profile?: boolean, adult?: boolean, owner?: string}} options
   */
  add(method, pattern, handler, options = {}) {
    const { regex, keys } = compile(pattern);
    const route = {
      method: method.toUpperCase(),
      pattern,
      regex,
      keys,
      handler,
      auth: options.auth ?? 'user',
      // Most endpoints need to know which profile is watching; account-level ones don't.
      profile: options.profile ?? true,
      // Blocked while a Kids profile is active (admin routes always are).
      adult: options.adult ?? false,
      // 'binary': the body may also be application/octet-stream (a DRM licence request from the browser's key system).
      // A cross-site form can't send that type, and a cross-origin fetch of it needs a preflight Atomix never grants.
      body: options.body ?? 'json',
      owner: options.owner,
      // A media route a TV may fetch with a cast link instead of a session cookie ('file'|'stream'|'subtitle'|'image').
      cast: options.cast,
    };
    this.routes.push(route);
    return route;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  removeByOwner(owner) {
    this.routes = this.routes.filter((r) => r.owner !== owner);
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== '*' && route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = m[i + 1];
        }
      });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) str += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.httpOnly !== false) str += '; HttpOnly';
  str += `; SameSite=${opts.sameSite || 'Lax'}`;
  if (opts.secure) str += '; Secure';
  return str;
}

export function readBody(req, limit = 1024 * 1024, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // A body that trickles in forever would hold the request open; 30 s is plenty for a JSON body.
    const timer = setTimeout(() => {
      reject(new HttpError(408, 'Request body took too long'));
      req.resume(); // whatever else trickles in is dropped; the answer goes out and the connection closes after it
    }, timeoutMs);
    timer.unref?.();
    let over = false;
    req.on('data', (c) => {
      if (over) return; // drained, not kept: the 413 reaches the client, then the connection closes
      size += c.length;
      if (size > limit) {
        over = true;
        clearTimeout(timer);
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Builds the per-request context handed to route handlers. */
export function createContext(req, res, url, params, extras) {
  let bodyPromise;
  const ctx = {
    req,
    res,
    url,
    params,
    query: Object.fromEntries(url.searchParams),
    user: null,
    ...extras,
    async body() {
      if (!bodyPromise) {
        bodyPromise = readBody(req, 1024 * 1024, { timeoutMs: ctx.bodyTimeoutMs || 30000 }).then((buf) => {
          if (!buf.length) return {};
          try {
            return JSON.parse(buf.toString('utf8'));
          } catch {
            throw new HttpError(400, 'Invalid JSON body');
          }
        });
      }
      return bodyPromise;
    },
    json(data, status = 200) {
      sendJson(res, status, data);
    },
    setCookie(cookie) {
      const prev = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
    },
    redirect(location, status = 302) {
      res.writeHead(status, { Location: location });
      res.end();
    },
  };
  return ctx;
}
