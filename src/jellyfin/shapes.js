// Atomix rows -> the JSON shapes Jellyfin clients (Infuse and friends) read. Pure: no database, no server.
// Nothing here ever carries a file path, a connected server's address or a token.
import { createHash } from 'node:crypto';
import { toGuid } from './ids.js';

export const TICKS = 10_000_000;

const TYPES = { movie: 'Movie', show: 'Series', season: 'Season', episode: 'Episode' };
const PLAYABLE = new Set(['movie', 'episode']);

const json = (s, fallback) => {
  if (s == null || s === '') return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
};
const ticks = (seconds) => Math.round((Number(seconds) || 0) * TICKS);
const iso = (ms) => new Date(ms).toISOString();
const personId = (name) => toGuid('person', createHash('sha1').update(String(name)).digest('hex').slice(0, 16));
const tagOf = (row) => String(row.metadata_at || row.updated_at || 0);

function extensionOf(p) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(p || ''));
  return m ? m[1].toLowerCase() : null;
}

function videoRange(v) {
  if (!v) return 'SDR';
  if (v.dolbyVision) return 'DOVI';
  if (v.colour?.transfer === 'arib-std-b67') return 'HLG';
  if (v.hdr || v.colour?.transfer === 'smpte2084') return 'HDR10';
  return 'SDR';
}

export function userData(progress, rating, row, counts = {}, stats = {}) {
  const position = Number(progress?.position) || 0;
  const out = {
    PlaybackPositionTicks: ticks(position),
    PlayCount: Number(stats?.playCount) || (progress?.watched ? 1 : 0),
    Played: Boolean(progress?.watched),
    IsFavorite: Boolean(rating?.favourite),
    Key: toGuid('item', row.id),
  };
  const last = stats?.lastPlayed ?? (progress?.updated_at || null);
  if (last) out.LastPlayedDate = iso(last);
  if (counts?.unplayed != null) out.UnplayedItemCount = counts.unplayed;
  const length = Number(progress?.duration) || Number(row.duration) || 0;
  if (position > 0 && length > 0) out.PlayedPercentage = Math.min(100, (position / length) * 100);
  return out;
}

/** `subtitles` is listSubtitles()'s output; only sidecar and downloaded files become external streams. */
export function mediaSources(row, { subtitles = [], canDownload = false, base = '/jellyfin' } = {}) {
  const media = json(row.media, null) || {};
  const id = toGuid('item', row.id);
  const streams = [];
  let next = 0;
  const v = media.video;
  if (v) {
    streams.push({
      Type: 'Video', Index: next++, Codec: v.codec, IsDefault: true, IsExternal: false, Width: v.width, Height: v.height,
      BitDepth: v.bitDepth, VideoRange: videoRange(v), RealFrameRate: v.fps || undefined, Profile: v.profile || undefined,
    });
  }
  const audio = media.audio || [];
  audio.forEach((a, i) => {
    streams.push({
      Type: 'Audio', Index: a.index ?? next, Codec: a.codec, Language: a.language || undefined, Title: a.title || undefined,
      Channels: a.channels, IsDefault: a.default != null ? Boolean(a.default) : i === 0, IsExternal: false,
    });
    next = Math.max(next, (a.index ?? next) + 1);
  });
  for (const s of media.subtitles || []) {
    streams.push({
      Type: 'Subtitle', Index: s.index ?? next, Codec: s.codec, Language: s.language || undefined, Title: s.title || undefined,
      IsDefault: Boolean(s.default), IsForced: Boolean(s.forced), IsExternal: false,
    });
    next = Math.max(next, (s.index ?? next) + 1);
  }
  for (const s of subtitles) {
    if (s.source === 'embedded') continue;
    const index = next++;
    streams.push({
      Type: 'Subtitle', Index: index, Codec: 'webvtt', Language: s.language || undefined, Title: s.label || undefined,
      IsDefault: false, IsForced: Boolean(s.forced), IsExternal: true, DeliveryMethod: 'External',
      DeliveryUrl: `${base}/Videos/${id}/${id}/Subtitles/${index}/0/Stream.vtt`,
    });
  }
  const ext = extensionOf(row.path);
  return [{
    Id: id, Protocol: 'File', Type: 'Default', Name: row.title, Container: ext || (media.container || '').split(',')[0] || undefined,
    Size: row.size ?? undefined, Bitrate: media.bitrate || undefined, RunTimeTicks: ticks(row.duration),
    IsRemote: false, SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
    SupportsProbing: false, ReadAtNativeFramerate: false, RequiresOpening: false, RequiresClosing: false,
    MediaStreams: streams, MediaAttachments: [], Formats: [], RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: (streams.find((s) => s.Type === 'Audio' && s.IsDefault) || streams.find((s) => s.Type === 'Audio'))?.Index,
    CanDownload: Boolean(canDownload),
  }];
}

export function itemDto(row, { serverId, progress, stats, rating, counts, fields, base = '/jellyfin' } = {}) {
  const type = TYPES[row.kind] || 'Folder';
  const playable = PLAYABLE.has(row.kind);
  const tag = tagOf(row);
  const imageTags = {};
  if (row.poster) imageTags.Primary = tag;
  if (row.logo) imageTags.Logo = tag;
  if (row.backdrop) imageTags.Thumb = tag;
  const dto = {
    Name: row.title, Id: toGuid('item', row.id), ServerId: serverId, Type: type, IsFolder: !playable,
    ImageTags: imageTags, BackdropImageTags: row.backdrop ? [tag] : [],
    UserData: userData(progress, rating, row, counts, stats),
    LocationType: 'FileSystem',
  };
  if (playable) {
    dto.MediaType = 'Video';
    dto.RunTimeTicks = ticks(row.duration);
  }
  if (row.year != null) dto.ProductionYear = row.year;
  if (row.kind === 'episode') {
    dto.IndexNumber = row.episode;
    dto.ParentIndexNumber = row.season;
    if (row.show_id != null) dto.SeriesId = toGuid('item', row.show_id);
    if (row.parent_id != null) { dto.SeasonId = toGuid('item', row.parent_id); dto.ParentId = dto.SeasonId; }
    if (row.show_title) dto.SeriesName = row.show_title;
  } else if (row.kind === 'season') {
    dto.IndexNumber = row.season;
    const series = row.show_id ?? row.parent_id;
    if (series != null) { dto.SeriesId = toGuid('item', series); dto.ParentId = dto.SeriesId; }
    if (row.show_title) dto.SeriesName = row.show_title;
  } else if (row.library_id != null) {
    dto.ParentId = toGuid('library', row.library_id);
  }
  if (counts?.children != null) dto.ChildCount = counts.children;

  // The rest is cheap, so it is always sent; `fields` only matters to callers that want to trim it (Task 9).
  void fields;
  const overview = row.overview;
  if (overview) dto.Overview = overview;
  dto.Genres = json(row.genres, []);
  if (row.certification) dto.OfficialRating = String(row.certification).replace(/^[A-Za-z]{2}:/, '');
  if (row.rating != null) dto.CommunityRating = row.rating;
  const premiere = row.air_date ? (/^\d{4}-\d{2}-\d{2}$/.test(row.air_date) ? `${row.air_date}T00:00:00.0000000Z` : row.air_date) : row.year ? `${row.year}-01-01T00:00:00.0000000Z` : null;
  if (premiere) dto.PremiereDate = premiere;
  if (row.original_title) dto.OriginalTitle = row.original_title;
  dto.SortName = row.sort_title || row.title;
  if (row.studio) dto.Studios = [{ Name: row.studio, Id: personId(`studio:${row.studio}`) }];
  const roles = { director: 'Director', creator: 'Creator', cast: 'Actor' };
  dto.People = json(row.people, []).filter((p) => p?.name).map((p) => ({
    Name: p.name, Id: personId(p.name), Role: p.character || '',
    Type: roles[p.role] || 'Actor',
  }));
  const ids = {};
  if (row.tmdb_id != null) ids.Tmdb = String(row.tmdb_id);
  if (row.imdb_id) ids.Imdb = String(row.imdb_id);
  dto.ProviderIds = ids;
  if (row.added_at) dto.DateCreated = iso(row.added_at);
  if (playable) dto.MediaSources = mediaSources(row, { canDownload: false, base });
  return dto;
}

export function userDto(user, profile, { serverId } = {}) {
  return {
    Name: profile.name, Id: toGuid('user', profile.id), ServerId: serverId,
    HasPassword: true, HasConfiguredPassword: true, HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    Policy: {
      IsAdministrator: false, IsHidden: true, IsDisabled: false,
      EnableContentDownloading: !profile.kids, EnableMediaPlayback: true, EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true, EnableContentDeletion: false,
      EnableRemoteControlOfOtherUsers: false, EnableSharedDeviceControl: false, EnableAllFolders: true,
      EnableAllChannels: false, EnableAllDevices: true, EnableLiveTvAccess: false, EnableLiveTvManagement: false,
      EnablePublicSharing: false, AuthenticationProviderId: 'Atomix', PasswordResetProviderId: 'Atomix',
    },
    Configuration: {
      PlayDefaultAudioTrack: true, SubtitleLanguagePreference: '', DisplayMissingEpisodes: false,
      SubtitleMode: 'Default', EnableLocalPassword: false, HidePlayedInLatest: true, RememberAudioSelections: true,
      RememberSubtitleSelections: true, EnableNextEpisodeAutoPlay: true,
    },
  };
}

export function libraryDto(lib, serverId) {
  return {
    Name: lib.name, Id: toGuid('library', lib.id), ServerId: serverId, Type: 'CollectionFolder',
    CollectionType: lib.type === 'movies' ? 'movies' : 'tvshows', IsFolder: true, ImageTags: {},
  };
}
