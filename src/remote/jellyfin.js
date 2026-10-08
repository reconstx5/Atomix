// Jellyfin, and Emby (the same API with a different header name).
import crypto from 'node:crypto';
import { RemoteProvider } from './provider.js';
import { normaliseUrl } from './urls.js';
import { RATING_COUNTRIES } from '../library/ratings.js';

const TICK = 10000000;
const TYPES = { movies: 'movies', tvshows: 'tv', music: 'music' };
const FIELDS = 'DateCreated,Overview,Genres,Taglines,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,PremiereDate,ProviderIds,People,Tags,MediaSources,MediaStreams,ImageTags,BackdropImageTags,SortName,ParentId,IndexNumber,ParentIndexNumber,AlbumArtist,Artists,Album';
const JF_KIND = { movie: 'Movie', show: 'Series', season: 'Season', episode: 'Episode', artist: 'MusicArtist', album: 'MusicAlbum', track: 'Audio' };

export class JellyfinProvider extends RemoteProvider {
  headerName() {
    return this.kind === 'emby' ? 'X-Emby-Authorization' : 'Authorization';
  }
  authHeader(token, deviceId = 'atomix') {
    const base = `MediaBrowser Client="Atomix", Device="Atomix", DeviceId="${deviceId}", Version="${this.version}"`;
    return { [this.headerName()]: token ? `MediaBrowser Token="${token}", Client="Atomix", Device="Atomix", DeviceId="${deviceId}", Version="${this.version}"` : base };
  }
  headers(server) {
    return this.authHeader(server.secret, `atomix-${server.id ?? 'new'}`);
  }
  async connect({ url, username, password }) {
    const base = normaliseUrl(url);
    const r = await this.request({ name: 'The server' }, `${base}/Users/AuthenticateByName`, { method: 'POST', body: { Username: username, Pw: password }, headers: this.authHeader(null, `atomix-${crypto.randomBytes(4).toString('hex')}`) });
    if (!r?.AccessToken || !r.User?.Id) throw Object.assign(new Error('Sign-in failed'), { status: 401 });
    return { secret: r.AccessToken, remoteUserId: r.User.Id, serverName: r.ServerName || base };
  }
  async libraries(server) {
    const r = await this.request(server, `${server.url}/Users/${server.remote_user_id}/Views`, { headers: this.headers(server) });
    return (r?.Items || []).filter((v) => TYPES[v.CollectionType]).map((v) => ({ remoteId: v.Id, name: v.Name, type: TYPES[v.CollectionType] }));
  }
  async *items(server, library, kind, parentRemoteId = null) {
    const parent = parentRemoteId || library.remote_id;
    let start = 0;
    for (;;) {
      // Music is not a folder tree in Jellyfin: album artists come from /Artists/AlbumArtists, and an artist's albums
      // are found by AlbumArtistIds across the library; only an album's tracks are its real children.
      let url;
      if (kind === 'artist') {
        const q = new URLSearchParams({ ParentId: library.remote_id, Fields: FIELDS, StartIndex: String(start), Limit: '200', SortBy: 'SortName' });
        url = `${server.url}/Artists/AlbumArtists?${q}`;
      } else if (kind === 'album') {
        const q = new URLSearchParams({ ParentId: library.remote_id, AlbumArtistIds: parentRemoteId, IncludeItemTypes: 'MusicAlbum', Recursive: 'true', Fields: FIELDS, StartIndex: String(start), Limit: '200', SortBy: 'ProductionYear,SortName' });
        url = `${server.url}/Users/${server.remote_user_id}/Items?${q}`;
      } else {
        const q = new URLSearchParams({ ParentId: parent, IncludeItemTypes: JF_KIND[kind], Recursive: parentRemoteId ? 'false' : 'true', Fields: FIELDS, StartIndex: String(start), Limit: '200', SortBy: kind === 'track' ? 'ParentIndexNumber,IndexNumber' : 'SortName' });
        url = `${server.url}/Users/${server.remote_user_id}/Items?${q}`;
      }
      const r = await this.request(server, url, { headers: this.headers(server) });
      const page = r?.Items || [];
      for (const it of page) yield shape(it, kind, parentRemoteId);
      start += page.length;
      // Stop when the server's total (when it gives one) is reached, else at the first empty page: a server that caps
      // pages below our Limit still gets read to the end.
      if (!page.length || (r?.TotalRecordCount != null && start >= r.TotalRecordCount)) break;
    }
  }
  imageUrl(server, item, type) {
    if (!item.images?.[type]) return null;
    const path = type === 'poster' ? 'Images/Primary' : type === 'backdrop' ? 'Images/Backdrop/0' : 'Images/Logo';
    // The server's image tag: a picture changed there is a new URL here, so the cache fetches it again.
    const tag = item.images?.tags?.[type];
    return { url: `${server.url}/Items/${encodeURIComponent(item.remoteId)}/${path}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`, headers: this.headers(server) };
  }
  streamUrl(server, item) {
    const kind = item.kind === 'track' ? 'Audio' : 'Videos';
    return { url: `${server.url}/${kind}/${encodeURIComponent(item.remoteId)}/stream?static=true`, headers: this.headers(server) };
  }
  async reportStart(server, item, { position = 0 } = {}) {
    await this.request(server, `${server.url}/Sessions/Playing`, { method: 'POST', headers: this.headers(server), body: { ItemId: item.remoteId, PositionTicks: Math.round(position * TICK), PlayMethod: 'DirectStream', CanSeek: true } });
  }
  async reportProgress(server, item, { position, watched, paused } = {}) {
    const ticks = Math.round((position || 0) * TICK);
    const h = this.headers(server);
    if (watched) return void (await this.request(server, `${server.url}/Users/${server.remote_user_id}/PlayedItems/${encodeURIComponent(item.remoteId)}`, { method: 'POST', headers: h, body: {} }));
    await this.request(server, `${server.url}/Sessions/Playing/Progress`, { method: 'POST', headers: h, body: { ItemId: item.remoteId, PositionTicks: ticks, IsPaused: Boolean(paused) } });
  }
  async reportStop(server, item, { position = 0 } = {}) {
    await this.request(server, `${server.url}/Sessions/Playing/Stopped`, { method: 'POST', headers: this.headers(server), body: { ItemId: item.remoteId, PositionTicks: Math.round(position * TICK) } });
  }
  async ping(server) {
    try {
      const info = await this.request(server, `${server.url}/System/Info/Public`);
      await this.request(server, `${server.url}/Users/Me`, { headers: this.headers(server) });
      return { ok: true, detail: info?.ServerName || server.name };
    } catch (err) {
      return { ok: false, detail: err.status === 401 ? 'unauthorized' : err.message };
    }
  }
}

// Jellyfin writes "NZ-R16" for a country-prefixed rating; "TV-MA", "PG-13" and "NC-17" are US labels, not prefixes.
const rating = (s) => {
  if (!s) return null;
  const m = /^([A-Za-z]{2})-(.+)$/.exec(s);
  return m && RATING_COUNTRIES.includes(m[1].toUpperCase()) ? `${m[1].toUpperCase()}:${m[2]}` : s;
};
const people = (list) => {
  const out = [];
  for (const p of list || []) if (p.Type === 'Director') out.push({ name: p.Name, role: 'director' });
  let cast = 0;
  for (const p of list || []) if (p.Type === 'Actor' && cast++ < 8) out.push({ name: p.Name, role: 'cast' });
  return out;
};
function media(it) {
  const src = it.MediaSources?.[0];
  if (!src) return null;
  const streams = src.MediaStreams || it.MediaStreams || [];
  const v = streams.find((s) => s.Type === 'Video');
  let ai = 0;
  let si = 0;
  return {
    container: (src.Container || '').toLowerCase() || null,
    duration: src.RunTimeTicks ? src.RunTimeTicks / TICK : it.RunTimeTicks ? it.RunTimeTicks / TICK : null,
    video: v ? { codec: (v.Codec || '').toLowerCase(), profile: v.Profile || null, width: v.Width, height: v.Height, hdr: /hdr|hlg|dolby/i.test(v.VideoRange || v.VideoRangeType || ''), bitDepth: v.BitDepth || null } : null,
    audio: streams.filter((s) => s.Type === 'Audio').map((s) => ({ index: ai++, streamIndex: s.Index, codec: (s.Codec || '').toLowerCase(), channels: s.Channels || null, layout: s.ChannelLayout || null, language: s.Language || null, title: s.DisplayTitle || null, default: Boolean(s.IsDefault) })),
    subtitles: streams.filter((s) => s.Type === 'Subtitle').map((s) => ({ index: si++, streamIndex: s.Index, codec: (s.Codec || '').toLowerCase(), language: s.Language || null, title: s.DisplayTitle || null, default: Boolean(s.IsDefault), forced: Boolean(s.IsForced) })),
  };
}
function shape(it, kind, parentRemoteId) {
  const m = media(it);
  return {
    remoteId: it.Id,
    kind,
    title: it.Name,
    sortTitle: it.SortName || null,
    year: it.ProductionYear || null,
    overview: it.Overview || null,
    tagline: it.Taglines?.[0] || null,
    genres: it.Genres || [],
    rating: it.CommunityRating != null ? Math.round(it.CommunityRating * 10) / 10 : null,
    runtime: it.RunTimeTicks ? Math.round(it.RunTimeTicks / TICK / 60) : null,
    airDate: it.PremiereDate ? it.PremiereDate.slice(0, 10) : null,
    certification: rating(it.OfficialRating),
    tmdbId: it.ProviderIds?.Tmdb ? Number(it.ProviderIds.Tmdb) : null,
    imdbId: it.ProviderIds?.Imdb || null,
    keywords: (it.Tags || []).map((t) => String(t).toLowerCase()),
    people: people(it.People),
    season: kind === 'season' ? it.IndexNumber ?? null : kind === 'episode' ? it.ParentIndexNumber ?? null : null,
    episode: kind === 'episode' ? it.IndexNumber ?? null : null,
    artist: it.AlbumArtist || it.Artists?.[0] || null,
    album: it.Album || null,
    track: kind === 'track' ? it.IndexNumber ?? null : null,
    disc: kind === 'track' ? it.ParentIndexNumber ?? null : null,
    duration: it.RunTimeTicks ? it.RunTimeTicks / TICK : null,
    media: m,
    images: { poster: Boolean(it.ImageTags?.Primary), backdrop: Boolean(it.BackdropImageTags?.length), logo: Boolean(it.ImageTags?.Logo), tags: { poster: it.ImageTags?.Primary || null, backdrop: it.BackdropImageTags?.[0] || null, logo: it.ImageTags?.Logo || null } },
    addedAt: it.DateCreated ? Date.parse(it.DateCreated) || null : null,
    updated: null,
    parentRemoteId: parentRemoteId || it.ParentId || null,
  };
}
