// Connected servers (Jellyfin, Emby, Plex, another Atomix): connect, choose libraries, sync, reconnect, remove.
// Plex signs in with a plex.tv link code: the pins below hold its token server-side until a server is picked.
// Admin only. The stored secret (token or password) is never part of any answer.
import os from 'node:os';
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { normaliseUrl } from '../remote/urls.js';
import { chooseConnection } from '../remote/plextv.js';
import { logger } from '../log.js';

const log = logger('servers');
const KINDS = ['jellyfin', 'emby', 'atomix', 'plex'];
const PIN_TTL = 30 * 60 * 1000;

export function serializeServer(row, libraries = []) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.url,
    username: row.username,
    status: row.status,
    statusDetail: row.status_detail || null,
    lastSync: row.last_sync || null,
    libraries: libraries.map((l) => ({ id: l.id, name: l.name, type: l.type, remoteId: l.remote_id, gone: Boolean(parseJson(l.options, {}).remoteGone) })),
    ...(parseJson(row.extra, {})?.relay ? { relay: true } : {}),
  };
}

/** True when `url` points at this Atomix: its own port on a loopback name or one of this machine's addresses. */
export function isSelf(url, { port, host } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const targetPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!port || targetPort !== Number(port)) return false;
  const name = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(name)) return true;
  if (host && name === String(host).toLowerCase()) return true;
  if (name === os.hostname().toLowerCase()) return true;
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.address.toLowerCase() === name) return true;
  return false;
}

export function registerServerRoutes(r, core) {
  const { db, scanner } = core;
  const admin = { auth: 'admin' };
  const providers = core.remote.providers;

  const serverRow = (id) => {
    const row = db.get('SELECT * FROM servers WHERE id = ?', Number(id));
    if (!row) throw new HttpError(404, 'No such server.');
    return row;
  };
  const libsOf = (id) => db.all('SELECT * FROM libraries WHERE server_id = ? ORDER BY name', id);
  const providerFor = (row) => {
    const p = providers.for(row.kind);
    if (!p) throw new HttpError(400, `Unknown server kind "${row.kind}".`);
    return p;
  };
  /** A sign-in the far server refused is the admin's typo, not this session ending: never a 401 to the browser. */
  const connect = (provider, args) => provider.connect(args).catch((err) => { throw err.status === 401 ? new HttpError(400, err.message) : err; });
  /** Any other call to a connected server: a 401 there marks the row unauthorized and reaches the admin as a 400. */
  const far = (row, promise) => promise.catch((err) => {
    if (err.status !== 401) throw err;
    db.run("UPDATE servers SET status = 'unauthorized', status_detail = ? WHERE id = ?", err.message, row.id);
    throw new HttpError(400, `${row.name} no longer accepts the saved sign-in. Sign in again.`);
  });
  const listening = () => ({ port: core.listening?.port || core.config.port, host: core.config.host });

  // ---- Plex: link codes. pinId → { code, expiresAt, created, token?, resources? }; the token never leaves here.
  const pins = new Map();
  const prunePins = () => { for (const [id, p] of pins) if (Date.now() - p.created > PIN_TTL) pins.delete(id); };
  const plextv = () => core.remote.plextv;
  const linkedPin = (pinId) => {
    prunePins();
    const p = pins.get(String(pinId || ''));
    if (!p?.token) throw new HttpError(400, 'That link code has expired or was already used. Start again with a new code.');
    return p;
  };
  /** The first of a resource's addresses that answers as that server, or a 400 naming what was tried. */
  const reach = async (resource) => {
    const choice = await chooseConnection(resource);
    if (!choice) throw new HttpError(400, `Couldn't reach ${resource.name} at any of its addresses (${chooseConnection.lastTried.join(', ')})`);
    return choice;
  };

  r.post(
    '/api/servers/plex/pins',
    async () => {
      prunePins();
      const pin = await plextv().createPin();
      pins.set(String(pin.id), { code: pin.code, expiresAt: pin.expiresAt, created: Date.now() });
      return { pinId: String(pin.id), code: pin.code, expiresAt: pin.expiresAt };
    },
    admin,
  );

  r.get(
    '/api/servers/plex/pins/:id',
    async (ctx) => {
      prunePins();
      const id = String(ctx.params.id);
      const p = pins.get(id);
      if (!p) return { expired: true };
      if (!p.token) {
        const check = await plextv().checkPin(id);
        if (check.expired) {
          pins.delete(id);
          return { expired: true };
        }
        if (check.pending) return { linked: false, expiresAt: check.expiresAt || p.expiresAt };
        // All three together, or none: a plex.tv failure here leaves the pin linkable again on the next poll.
        const resources = await plextv().resources(check.authToken);
        const username = (await plextv().user(check.authToken).catch(() => ({}))).username || null;
        Object.assign(p, { token: check.authToken, resources, username });
      }
      return { linked: true, servers: p.resources.map((x) => ({ id: x.clientIdentifier, name: x.name, owner: x.owned ? null : x.sourceTitle || 'someone else', owned: x.owned })) };
    },
    admin,
  );

  r.get('/api/servers', () => db.all('SELECT * FROM servers ORDER BY name').map((row) => serializeServer(row, libsOf(row.id))), admin);

  r.get('/api/servers/:id', (ctx) => {
    const row = serverRow(ctx.params.id);
    return serializeServer(row, libsOf(row.id));
  }, admin);

  r.post(
    '/api/servers',
    async (ctx) => {
      const body = await ctx.body();
      if (!KINDS.includes(body.kind)) throw new HttpError(400, 'Choose Jellyfin, Emby, Plex or Atomix.');
      if (body.kind === 'plex') return connectPlex(body);
      const url = normaliseUrl(body.url);
      if (isSelf(url, listening())) throw new HttpError(400, "That's this Atomix.");
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) throw new HttpError(400, 'Enter the username and password for that server.');
      if (db.get('SELECT 1 AS x FROM servers WHERE url = ? AND username = ? COLLATE NOCASE', url, username)) throw new HttpError(409, `${url} is already connected as ${username}.`);
      const provider = providerFor({ kind: body.kind });
      const c = await connect(provider, { url, username, password });
      const name = String(body.name || c.serverName || url).trim().slice(0, 60);
      const res = db.run(
        "INSERT INTO servers (kind, name, url, username, secret, remote_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)",
        body.kind, name, url, username, c.secret, c.remoteUserId || null, Date.now(),
      );
      const row = serverRow(Number(res.lastInsertRowid));
      const available = await provider.libraries(row).catch((err) => {
        log.warn(`Connected to ${name} but could not list its libraries: ${err.message}`);
        return [];
      });
      log.info(`Connected ${row.kind} server "${name}" at ${url}`);
      return { ...serializeServer(row, []), available };
    },
    admin,
  );

  async function connectPlex(body) {
    const pinId = String(body.pinId || '');
    const p = linkedPin(pinId);
    const resource = p.resources.find((x) => x.clientIdentifier === String(body.serverId || ''));
    if (!resource) throw new HttpError(400, 'Pick one of the servers on that Plex account.');
    if (db.get("SELECT 1 AS x FROM servers WHERE kind = 'plex' AND remote_user_id = ?", resource.clientIdentifier)) throw new HttpError(409, `${resource.name} is already connected.`);
    const choice = await reach(resource);
    // Again after the wait: a double press can have connected it meanwhile.
    if (db.get("SELECT 1 AS x FROM servers WHERE kind = 'plex' AND remote_user_id = ?", resource.clientIdentifier)) throw new HttpError(409, `${resource.name} is already connected.`);
    const name = String(body.name || resource.name).trim().slice(0, 60);
    const res = db.run(
      "INSERT INTO servers (kind, name, url, username, secret, remote_user_id, status, created_at, extra) VALUES ('plex', ?, ?, ?, ?, ?, 'ok', ?, ?)",
      name, choice.url, p.username, resource.accessToken, resource.clientIdentifier, Date.now(), JSON.stringify({ accountToken: p.token, relay: choice.relay }),
    );
    pins.delete(pinId);
    const row = serverRow(Number(res.lastInsertRowid));
    const available = await far(row, providerFor(row).libraries(row)).catch((err) => {
      log.warn(`Connected to ${name} but could not list its libraries: ${err.message}`);
      return [];
    });
    log.info(`Connected Plex server "${name}" at ${choice.url}${choice.relay ? ' (via the Plex relay)' : ''}`);
    return { ...serializeServer(row, []), available };
  }

  // The server's movie, TV and music libraries right now (for the Libraries… dialog).
  r.get(
    '/api/servers/:id/available',
    async (ctx) => {
      const row = serverRow(ctx.params.id);
      return far(row, providerFor(row).libraries(row));
    },
    admin,
  );

  r.put(
    '/api/servers/:id/libraries',
    async (ctx) => {
      const row = serverRow(ctx.params.id);
      const body = await ctx.body();
      const wanted = [...new Set((Array.isArray(body.remoteIds) ? body.remoteIds : []).map((x) => String(x)))];
      const provider = providerFor(row);
      const available = await far(row, provider.libraries(row));
      const have = libsOf(row.id);
      const added = [];
      for (const remoteId of wanted) {
        if (have.some((l) => l.remote_id === remoteId)) continue;
        const far = available.find((l) => l.remoteId === remoteId);
        if (!far) throw new HttpError(400, `${row.name} has no library "${remoteId}".`);
        // "Movies" next to your own Movies would give Home two rows of the same name: say whose it is.
        const taken = db.get('SELECT 1 AS x FROM libraries WHERE name = ? COLLATE NOCASE', far.name);
        const name = (taken ? `${far.name} (${row.name})` : far.name).slice(0, 60);
        const res = db.run(
          "INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES (?, ?, '[]', '{}', ?, ?, ?)",
          name, far.type, Date.now(), row.id, remoteId,
        );
        added.push(Number(res.lastInsertRowid));
      }
      for (const l of have) if (!wanted.includes(l.remote_id)) db.run('DELETE FROM libraries WHERE id = ?', l.id);
      for (const id of added) scanner.enqueue(id).catch((e) => log.error(e.message));
      if (have.some((l) => !wanted.includes(l.remote_id))) core.picks.clear();
      return serializeServer(row, libsOf(row.id));
    },
    admin,
  );

  r.post(
    '/api/servers/:id/sync',
    (ctx) => {
      const row = serverRow(ctx.params.id);
      for (const l of libsOf(row.id)) scanner.enqueue(l.id).catch((e) => log.error(e.message));
      return { ok: true, queued: libsOf(row.id).length };
    },
    admin,
  );

  r.post(
    '/api/servers/:id/reconnect',
    async (ctx) => {
      const row = serverRow(ctx.params.id);
      const body = await ctx.body();
      if (row.kind === 'plex') {
        // A fresh link code: the same machine among that account's servers, reached again.
        const pinId = String(body.pinId || '');
        const p = linkedPin(pinId);
        const resource = p.resources.find((x) => x.clientIdentifier === row.remote_user_id);
        if (!resource) throw new HttpError(400, `That Plex account can't see ${row.name}.`);
        const choice = await reach(resource);
        db.run(
          "UPDATE servers SET url = ?, secret = ?, username = ?, extra = ?, status = 'ok', status_detail = NULL WHERE id = ?",
          choice.url, resource.accessToken, p.username || row.username, JSON.stringify({ accountToken: p.token, relay: choice.relay }), row.id,
        );
        pins.delete(pinId);
        // A sync now: stored artwork URLs carry the server's address, and it may have just changed.
        for (const l of libsOf(row.id)) scanner.enqueue(l.id).catch((e) => log.error(e.message));
        return serializeServer(serverRow(row.id), libsOf(row.id));
      }
      const password = String(body.password || '');
      if (!password) throw new HttpError(400, 'Enter the password for that server.');
      const c = await connect(providerFor(row), { url: row.url, username: body.username ? String(body.username).trim() : row.username, password });
      db.run(
        "UPDATE servers SET secret = ?, remote_user_id = ?, username = ?, status = 'ok', status_detail = NULL WHERE id = ?",
        c.secret, c.remoteUserId || row.remote_user_id, body.username ? String(body.username).trim() : row.username, row.id,
      );
      providerFor(row).forget?.(row);
      return serializeServer(serverRow(row.id), libsOf(row.id));
    },
    admin,
  );

  r.delete(
    '/api/servers/:id',
    async (ctx) => {
      const row = serverRow(ctx.params.id);
      // Its streams stop now (ffmpeg and all, and the server is told while the row still exists), and its cached
      // artwork goes with it.
      const libIds = new Set(libsOf(row.id).map((l) => l.id));
      for (const s of [...core.playback.sessions.values()]) {
        const lib = db.get('SELECT library_id FROM items WHERE id = ?', s.itemId)?.library_id;
        if (libIds.has(lib)) core.playback.stop(s.id, 'server removed');
      }
      // Let the stop reports reach the server while its row still exists (a hung server doesn't hold Remove up long).
      if (core.remote.reporter) await Promise.race([core.remote.reporter.idle(), new Promise((r) => setTimeout(r, 5000))]);
      if (libIds.size) {
        for (const it of db.all(`SELECT poster, backdrop, logo FROM items WHERE library_id IN (${[...libIds].map(() => '?').join(',')})`, ...libIds)) {
          for (const u of [it.poster, it.backdrop, it.logo]) if (u) core.images.forget(u);
        }
      }
      db.run('DELETE FROM servers WHERE id = ?', row.id);
      providerFor(row).forget?.(row);
      core.picks.clear();
      log.info(`Removed server "${row.name}"`);
      return { ok: true };
    },
    admin,
  );
}
