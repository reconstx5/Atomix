// Plex Media Server. Sign-in is a plex.tv link code (src/remote/plextv.js); here: a server's sections, items,
// details, image and stream URLs (the token always in a header), timeline/scrobble reports, and ping.
import { RemoteProvider } from './provider.js';
import { plexHeaders, plexClientId } from './plextv.js';
import { RATING_COUNTRIES } from '../library/ratings.js';

const TYPES = { movie: 'movies', show: 'tv', artist: 'music' };
const PAGE = 200;
const LIST_TYPE = { movie: 1, show: 2, artist: 8 };
const HDR_TRC = new Set(['smpte2084', 'arib-std-b67']);

/** Plex writes "gb/15" for a country's rating (lower case, "uk" for Britain); "PG-13", "TV-MA" are US labels. */
function rating(s) {
  if (!s) return null;
  const m = /^([a-z]{2})\/(.+)$/i.exec(String(s).trim());
  if (!m) return String(s).trim();
  let cc = m[1].toUpperCase();
  if (cc === 'UK') cc = 'GB';
  return RATING_COUNTRIES.includes(cc) ? `${cc}:${m[2]}` : m[2];
}
const ms = (sec) => (sec ? Number(sec) * 1000 : null);
const guid = (list, scheme) => (list || []).map((g) => String(g.id || '')).find((id) => id.startsWith(`${scheme}://`))?.slice(scheme.length + 3) || null;
const people = (it) => {
  const out = (it.Director || []).map((d) => ({ name: d.tag, role: 'director' }));
  for (const r of (it.Role || []).slice(0, 8)) out.push({ name: r.tag, role: 'cast' });
  return out;
};

/** The listing's own media summary: enough to decide direct play; details() fills the real tracks. */
function listingMedia(it) {
  const m = it.Media?.[0];
  const part = m?.Part?.[0];
  if (!m || !part?.key) return null;
  return {
    container: m.container || null,
    bitrate: m.bitrate ? m.bitrate * 1000 : null,
    video: m.videoCodec ? { codec: m.videoCodec.toLowerCase(), width: m.width || null, height: m.height || null, hdr: false, bitDepth: null } : null,
    audio: m.audioCodec ? [{ index: 0, codec: m.audioCodec.toLowerCase(), channels: m.audioChannels || null, default: true }] : [],
    subtitles: [],
    plexPart: part.key,
  };
}

function detailedMedia(it) {
  const m = it.Media?.[0];
  const part = m?.Part?.[0];
  if (!m || !part?.key) return null;
  const streams = part.Stream || [];
  const v = streams.find((s) => s.streamType === 1);
  let ai = 0;
  let si = 0;
  return {
    container: m.container || part.container || null,
    bitrate: m.bitrate ? m.bitrate * 1000 : null,
    video: v
      ? { codec: String(v.codec || m.videoCodec || '').toLowerCase(), width: v.width || m.width || null, height: v.height || m.height || null, bitDepth: v.bitDepth || null, hdr: HDR_TRC.has(v.colorTrc) || /hdr|dolby vision|dovi/i.test(v.displayTitle || '') }
      : m.videoCodec ? { codec: m.videoCodec.toLowerCase(), width: m.width || null, height: m.height || null, hdr: false, bitDepth: null } : null,
    audio: streams.filter((s) => s.streamType === 2).map((s) => ({ index: ai++, codec: String(s.codec || '').toLowerCase(), channels: s.channels || null, language: s.languageCode || s.language || null, title: s.displayTitle || null, default: Boolean(s.default || s.selected) })),
    // Subtitle files on the Plex server (a stream with its own key) are left out this round: only embedded tracks.
    subtitles: streams.filter((s) => s.streamType === 3 && !s.key).map((s) => ({ index: si++, codec: String(s.codec || '').toLowerCase(), language: s.languageCode || s.language || null, title: s.displayTitle || null, forced: Boolean(s.forced), default: Boolean(s.default) })),
    plexPart: part.key,
    detailed: true,
  };
}

function shape(it, kind, parentRemoteId) {
  const duration = it.duration ? it.duration / 1000 : null;
  return {
    remoteId: String(it.ratingKey),
    kind,
    title: it.title,
    sortTitle: it.titleSort || null,
    year: it.year || null,
    overview: it.summary || null,
    tagline: it.tagline || null,
    genres: (it.Genre || []).map((g) => g.tag),
    rating: it.audienceRating ?? it.rating ?? null,
    runtime: it.duration ? Math.round(it.duration / 60000) : null,
    airDate: it.originallyAvailableAt || null,
    certification: rating(it.contentRating),
    tmdbId: guid(it.Guid, 'tmdb') ? Number(guid(it.Guid, 'tmdb')) : null,
    imdbId: guid(it.Guid, 'imdb'),
    keywords: [],
    people: people(it),
    season: kind === 'season' ? it.index ?? null : kind === 'episode' ? it.parentIndex ?? null : null,
    episode: kind === 'episode' ? it.index ?? null : null,
    artist: kind === 'track' ? it.grandparentTitle || it.originalTitle || null : kind === 'album' ? it.parentTitle || null : kind === 'artist' ? it.title : null,
    album: kind === 'track' ? it.parentTitle || null : null,
    track: kind === 'track' ? it.index ?? null : null,
    disc: kind === 'track' ? it.parentIndex ?? null : null,
    duration,
    media: ['movie', 'episode', 'track'].includes(kind) ? listingMedia(it) : null,
    images: { poster: Boolean(it.thumb), backdrop: Boolean(it.art), logo: false, posterPath: it.thumb || null, backdropPath: it.art || null },
    addedAt: ms(it.addedAt),
    updated: ms(it.updatedAt),
    parentRemoteId: parentRemoteId || (it.parentRatingKey ? String(it.parentRatingKey) : null),
  };
}

export class PlexProvider extends RemoteProvider {
  constructor({ kind = 'plex', version, settings }) {
    super({ kind, version });
    this.settings = settings;
  }
  static rating = rating;
  headers(server) {
    return plexHeaders({ clientId: plexClientId(this.settings), version: this.version, token: server.secret });
  }
  get(server, path) {
    return this.request(server, `${server.url}${path}`, { headers: this.headers(server) });
  }
  async libraries(server) {
    const r = await this.get(server, '/library/sections');
    return (r?.MediaContainer?.Directory || []).filter((d) => TYPES[d.type]).map((d) => ({ remoteId: String(d.key), name: d.title, type: TYPES[d.type] }));
  }
  async *items(server, library, kind, parentRemoteId = null) {
    if (LIST_TYPE[kind]) {
      let start = 0;
      for (;;) {
        const q = new URLSearchParams({ type: String(LIST_TYPE[kind]), includeGuids: '1', 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(PAGE) });
        const r = await this.get(server, `/library/sections/${encodeURIComponent(library.remote_id)}/all?${q}`);
        const page = r?.MediaContainer?.Metadata || [];
        for (const it of page) yield shape(it, kind, null);
        start += page.length;
        const total = r?.MediaContainer?.totalSize;
        if (!page.length || (total != null && start >= total)) break;
      }
      return;
    }
    const r = await this.get(server, `/library/metadata/${encodeURIComponent(parentRemoteId)}/children?includeGuids=1`);
    for (const it of r?.MediaContainer?.Metadata || []) yield shape(it, kind, parentRemoteId);
  }
  /** The title's real tracks (audio, embedded subtitles, bit depth, HDR) from its own metadata page. */
  async details(server, item) {
    const r = await this.get(server, `/library/metadata/${encodeURIComponent(item.remoteId)}`);
    const it = r?.MediaContainer?.Metadata?.[0];
    return it ? detailedMedia(it) : null;
  }
  imageUrl(server, item, type) {
    const p = type === 'poster' ? item.images?.posterPath : type === 'backdrop' ? item.images?.backdropPath : null;
    if (!p) return null;
    const url = /^https?:\/\//i.test(p) ? p : `${server.url}${p.startsWith('/') ? '' : '/'}${p}`;
    return { url, headers: this.imageHeaders(server, url) };
  }
  streamUrl(server, item) {
    const part = item.media?.plexPart;
    return { url: part ? `${server.url}${part}` : null, headers: this.headers(server) };
  }
  /** One player per Atomix playback session: two people on the same title are two players, and one's stop is its own. */
  sessionHeaders(server, sessionId) {
    const headers = this.headers(server);
    if (!sessionId) return headers;
    return { ...headers, 'X-Plex-Client-Identifier': `${headers['X-Plex-Client-Identifier']}-${sessionId}`, 'X-Plex-Session-Identifier': String(sessionId) };
  }
  async timeline(server, item, state, { position = 0, duration = 0, sessionId = null } = {}) {
    const q = new URLSearchParams({ ratingKey: String(item.remoteId), key: `/library/metadata/${item.remoteId}`, state, time: String(Math.round((position || 0) * 1000)), duration: String(Math.round((duration || 0) * 1000)) });
    await this.request(server, `${server.url}/:/timeline?${q}`, { headers: this.sessionHeaders(server, sessionId), raw: true });
  }
  async reportStart(server, item, p) {
    await this.timeline(server, item, 'playing', p);
  }
  /** Position while playing; at the end, the scrobble marks it watched (the stop comes with the session's end). */
  async reportProgress(server, item, { position, duration, watched, paused, sessionId } = {}) {
    if (watched) {
      const q = new URLSearchParams({ key: String(item.remoteId), identifier: 'com.plexapp.plugins.library' });
      await this.request(server, `${server.url}/:/scrobble?${q}`, { headers: this.sessionHeaders(server, sessionId), raw: true });
      return;
    }
    await this.timeline(server, item, paused ? 'paused' : 'playing', { position, duration, sessionId });
  }
  async reportStop(server, item, p) {
    await this.timeline(server, item, 'stopped', p);
  }
  async ping(server) {
    try {
      const id = await this.get(server, '/identity');
      if (server.remote_user_id && id?.MediaContainer?.machineIdentifier !== server.remote_user_id) return { ok: false, detail: `${server.url} is a different Plex server now`, unreachable: true };
      await this.get(server, '/library/sections');
      return { ok: true, detail: server.name };
    } catch (err) {
      return err.status === 401 ? { ok: false, detail: 'unauthorized' } : { ok: false, detail: err.message, unreachable: true };
    }
  }
}
