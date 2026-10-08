// plex.tv: the link-code sign-in (a "pin" the person enters at plex.tv/link), the servers on the account, and
// choosing one of a server's addresses that answers. Nothing here touches the browser: the token stays server-side.
import crypto from 'node:crypto';
import { HttpError } from '../http/router.js';

/** This Atomix's stable device id at plex.tv and on Plex servers: made once, kept in settings. */
export function plexClientId(settings) {
  let id = settings.get('plexClientId');
  if (!id) {
    id = crypto.randomUUID();
    settings.set({ plexClientId: id });
  }
  return id;
}

/** The headers every Plex call carries. */
export function plexHeaders({ clientId, version, token, deviceName } = {}) {
  return {
    Accept: 'application/json',
    'X-Plex-Product': 'Atomix',
    'X-Plex-Version': String(version || '0'),
    'X-Plex-Client-Identifier': clientId,
    ...(deviceName ? { 'X-Plex-Device-Name': deviceName, 'X-Plex-Device': 'Atomix' } : {}),
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}

export class PlexTv {
  /** @param {{ base: string, settings: object, version: string, serverName: () => string }} opts */
  constructor({ base = 'https://plex.tv', settings, version, serverName = () => 'Atomix' }) {
    this.base = base.replace(/\/+$/, '');
    this.settings = settings;
    this.version = version;
    this.serverName = serverName;
  }
  headers(token) {
    return plexHeaders({ clientId: plexClientId(this.settings), version: this.version, token, deviceName: this.serverName() });
  }
  async call(path, { method = 'GET', token, allow404 = false } = {}) {
    let res;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers: this.headers(token), signal: AbortSignal.timeout(10000) });
    } catch (err) {
      throw new HttpError(502, `Couldn't reach plex.tv: ${err.cause?.code || (err.name === 'TimeoutError' ? 'no answer' : err.cause?.message || err.message)}`);
    }
    if (res.status === 404 && allow404) return null;
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'Plex did not accept that sign-in.');
    if (!res.ok) throw new HttpError(502, `Couldn't reach plex.tv: it answered ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new HttpError(502, "Couldn't reach plex.tv: it sent something that isn't JSON.");
    }
  }
  /** @returns {Promise<{ id: number, code: string, expiresAt: number }>} */
  async createPin() {
    const p = await this.call('/api/v2/pins?strong=false', { method: 'POST' });
    return { id: p.id, code: p.code, expiresAt: Date.parse(p.expiresAt) || Date.now() + 15 * 60 * 1000 };
  }
  /** @returns {Promise<{ authToken: string } | { pending: true, expiresAt: number } | { expired: true }>} */
  async checkPin(id) {
    const p = await this.call(`/api/v2/pins/${encodeURIComponent(id)}`, { allow404: true });
    if (!p) return { expired: true };
    if (p.authToken) return { authToken: p.authToken };
    const expiresAt = Date.parse(p.expiresAt);
    if (expiresAt && expiresAt <= Date.now()) return { expired: true };
    return { pending: true, expiresAt };
  }
  /** The account behind a token: { username }. */
  async user(token) {
    const u = await this.call('/api/v2/user', { token });
    return { username: u?.username || u?.title || null };
  }
  /** The account's Plex servers (other devices left out), each with its own access token and addresses. */
  async resources(token) {
    const list = await this.call('/api/v2/resources?includeHttps=1&includeRelay=1', { token });
    return (Array.isArray(list) ? list : [])
      .filter((r) => String(r.provides || '').split(',').includes('server'))
      .map((r) => ({ clientIdentifier: r.clientIdentifier, name: r.name, owned: Boolean(r.owned), sourceTitle: r.sourceTitle || null, accessToken: r.accessToken || token, connections: (r.connections || []).map((c) => ({ uri: String(c.uri || '').replace(/\/+$/, ''), local: Boolean(c.local), relay: Boolean(c.relay), protocol: c.protocol })) }));
  }
}

/** Local non-relay, then remote https non-relay, then any other non-relay, then the relay. */
function rank(c) {
  if (c.relay) return 3;
  if (c.local) return 0;
  if (c.protocol === 'https' || c.uri.startsWith('https:')) return 1;
  return 2;
}

/**
 * Try a server's addresses in order until one answers /identity with the same machine id.
 * @returns {Promise<{ url: string, relay: boolean } | null>}  chooseConnection.lastTried lists what was tried
 */
export async function chooseConnection(resource, { timeoutMs = 4000, onTry } = {}) {
  const ordered = [...(resource.connections || [])].map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
  const tried = [];
  chooseConnection.lastTried = tried;
  for (const c of ordered) {
    if (!c.uri || tried.includes(c.uri)) continue;
    tried.push(c.uri);
    onTry?.(c.uri);
    try {
      const res = await fetch(`${c.uri}/identity`, { headers: { Accept: 'application/json', 'X-Plex-Token': resource.accessToken }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      if (body?.MediaContainer?.machineIdentifier === resource.clientIdentifier) return { url: c.uri, relay: Boolean(c.relay) };
    } catch {
      /* the next address */
    }
  }
  return null;
}
chooseConnection.lastTried = [];
