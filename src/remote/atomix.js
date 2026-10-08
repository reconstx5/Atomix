// Another Atomix: signed in with an Atomix account; the session cookie is kept in memory per server.
import { HttpError } from '../http/router.js';
import { RemoteProvider } from './provider.js';
import { normaliseUrl } from './urls.js';

const cookies = new Map(); // server id → cookie

export class AtomixProvider extends RemoteProvider {
  /** Sign in and pick a profile; returns the cookie. */
  async signIn(server, { username = server.username, password = server.secret, url = server.url } = {}) {
    const res = await this.request(server, `${url}/api/auth/login`, { method: 'POST', body: { username, password }, raw: true });
    if (res.status === 401 || res.status === 400) throw new HttpError(401, 'That sign-in was not accepted.');
    if (!res.ok) throw new HttpError(502, `${server.name || 'The server'} answered ${res.status}.`);
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw new HttpError(502, 'The server gave no session.');
    const profiles = await this.request(server, `${url}/api/profiles`, { headers: { cookie } });
    const usable = (profiles || []).find((p) => !p.kids && !p.hasPin) || null;
    if (!usable) throw new HttpError(400, 'Make a profile without a PIN for Atomix to use.');
    const sel = await this.request(server, `${url}/api/profiles/${usable.id}/select`, { method: 'POST', body: {}, headers: { cookie }, raw: true });
    const fresh = (sel.headers.get('set-cookie') || '').split(';')[0] || cookie;
    if (server.id != null) cookies.set(server.id, fresh);
    return { cookie: fresh, profile: usable };
  }
  async connect({ url, username, password }) {
    const base = normaliseUrl(url);
    const status = await this.request({ name: 'The server' }, `${base}/api/status`).catch(() => null);
    if (!status?.name && !status?.serverName) throw new HttpError(502, 'That address is not an Atomix server.');
    const { profile } = await this.signIn({ name: status.serverName || status.name, url: base }, { username, password, url: base });
    return { secret: password, remoteUserId: String(profile.id), serverName: status.serverName || status.name || base };
  }
  /** Sign in when there is no session yet (after a restart or a reconnect) so stream/image headers carry a cookie. */
  async ensureSession(server) {
    if (!cookies.get(server.id)) await this.signIn(server);
  }
  /** Drop the session for a server (it was removed, or reconnected with a new password). */
  forget(server) {
    cookies.delete(server.id);
  }
  headers(server) {
    const c = cookies.get(server.id);
    return c ? { cookie: c } : {};
  }
  /** A call with the cookie; on 401 sign in once more, then give up as unauthorized. */
  async call(server, path, opts = {}) {
    if (!cookies.get(server.id)) await this.signIn(server);
    try {
      return await this.request(server, `${server.url}${path}`, { ...opts, headers: { ...this.headers(server), ...(opts.headers || {}) } });
    } catch (err) {
      if (err.status !== 401) throw err;
      cookies.delete(server.id);
      await this.signIn(server); // throws 401 when the stored password no longer works
      return this.request(server, `${server.url}${path}`, { ...opts, headers: { ...this.headers(server), ...(opts.headers || {}) } });
    }
  }
  async libraries(server) {
    const libs = await this.call(server, '/api/libraries');
    return (libs || []).filter((l) => ['movies', 'tv', 'music'].includes(l.type)).map((l) => ({ remoteId: String(l.id), name: l.name, type: l.type }));
  }
  async *items(server, library, kind, parentRemoteId = null) {
    if (kind === 'movie' || kind === 'show' || kind === 'artist') {
      const view = kind === 'artist' ? '&view=artists' : '';
      let offset = 0;
      for (;;) {
        const page = await this.call(server, `/api/libraries/${library.remote_id}/items?limit=500&offset=${offset}${view}`);
        const rows = page?.items || [];
        // Movies need the full page for their media; shows for their rating (the list carries neither). Artists need nothing more.
        for (const r of rows) yield kind === 'artist' ? shape(r, kind, parentRemoteId) : await this.full(server, r, kind, parentRemoteId);
        offset += rows.length;
        if (!rows.length || rows.length < 500) break;
      }
      return;
    }
    if (kind === 'season') {
      for (const r of (await this.call(server, `/api/items/${parentRemoteId}/children`)) || []) yield shape(r, 'season', parentRemoteId);
      return;
    }
    if (kind === 'episode') {
      for (const r of (await this.call(server, `/api/items/${parentRemoteId}/children`)) || []) yield await this.full(server, r, 'episode', parentRemoteId);
      return;
    }
    if (kind === 'album') {
      const artist = await this.call(server, `/api/items/${parentRemoteId}`);
      for (const r of artist?.albums || []) yield shape(r, 'album', parentRemoteId);
      return;
    }
    if (kind === 'track') {
      const album = await this.call(server, `/api/items/${parentRemoteId}`);
      for (const r of album?.tracks || []) yield shape(r, 'track', parentRemoteId);
    }
  }
  /** Movies and episodes need the full item for its media summary: one call each, paced. */
  async full(server, row, kind, parentRemoteId) {
    const d = await this.call(server, `/api/items/${row.id}`);
    await new Promise((r) => setTimeout(r, this.paceMs ?? 50));
    return shape({ ...row, ...(d?.item || {}) }, kind, parentRemoteId);
  }
  imageUrl(server, item, type) {
    if (!item.images?.[type]) return null;
    // The far ?v= is its metadata stamp: a picture changed there is a new URL here, so the cache fetches it again.
    const v = /[?&]v=(\d+)/.exec(String(item.images?.[`${type}Url`] || ''))?.[1];
    return { url: `${server.url}/api/items/${encodeURIComponent(item.remoteId)}/image/${type}${v ? `?v=${v}` : ''}`, headers: this.headers(server) };
  }
  streamUrl(server, item) {
    return { url: `${server.url}/api/items/${encodeURIComponent(item.remoteId)}/file`, headers: this.headers(server) };
  }
  async reportProgress(server, item, { position, duration }) {
    await this.call(server, `/api/items/${encodeURIComponent(item.remoteId)}/progress`, { method: 'POST', body: { position, duration } });
  }
  async ping(server) {
    try {
      const s = await this.request(server, `${server.url}/api/status`);
      await this.call(server, '/api/me');
      return { ok: true, detail: s?.serverName || s?.name || server.name };
    } catch (err) {
      return { ok: false, detail: err.status === 401 ? 'unauthorized' : err.message };
    }
  }
}

/** The far Atomix sends a media *summary*; rebuild the shape decide() reads (streamIndex is unknown: ffmpeg maps by order). */
function fromSummary(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    container: s.container || null,
    bitrate: s.bitrate || null,
    video: s.videoCodec || s.width ? { codec: s.videoCodec || null, width: s.width || null, height: s.height || null, hdr: Boolean(s.hdr), bitDepth: s.bitDepth || null } : null,
    audio: (s.audio || []).map((a, i) => ({ index: a.index ?? i, streamIndex: null, codec: a.codec, channels: a.channels, language: a.language, title: a.title, default: Boolean(a.default) })),
    subtitles: Array.isArray(s.subtitles) ? s.subtitles : Array.from({ length: Number(s.subtitles) || 0 }, (_, i) => ({ index: i, streamIndex: null, codec: null, language: null, title: null, default: false, forced: false })),
  };
}

function shape(r, kind, parentRemoteId) {
  const m = fromSummary(r.media);
  return {
    remoteId: String(r.id),
    kind,
    title: r.title,
    sortTitle: null,
    year: r.year ?? null,
    overview: r.overview ?? null,
    tagline: r.tagline ?? null,
    genres: r.genres || [],
    rating: r.rating ?? null,
    runtime: r.runtime ?? null,
    airDate: r.airDate ?? null,
    certification: r.certification ?? null,
    tmdbId: r.tmdbId ?? null,
    imdbId: r.imdbId ?? null,
    keywords: r.keywords || [],
    people: r.people || [],
    season: r.season ?? null,
    episode: r.episode ?? null,
    artist: r.artist ?? null,
    album: r.albumTitle ?? null,
    track: kind === 'track' ? r.episode ?? r.track ?? null : null,
    disc: kind === 'track' ? r.season ?? null : null,
    duration: r.duration ?? null,
    media: m,
    images: { poster: Boolean(r.poster), backdrop: Boolean(r.backdrop), logo: Boolean(r.logo), posterUrl: r.poster || null, backdropUrl: r.backdrop || null, logoUrl: r.logo || null },
    addedAt: r.addedAt || null,
    updated: null,
    parentRemoteId: parentRemoteId || (r.parentId != null ? String(r.parentId) : null),
  };
}
