// Converts DB rows into the JSON shape the web UI (and plugins) consume.
import { parseJson } from '../db.js';
import { EXTRA_CAPTIONS } from '../library/parser.js';
import { isRemotePath } from '../remote/index.js';

export function imageUrl(item, type) {
  const ref = type === 'backdrop' ? item.backdrop : type === 'logo' ? item.logo : item.poster;
  if (!ref) return null;
  return `/api/items/${item.id}/image/${type}?v=${item.metadata_at || item.updated_at || 0}`;
}

function mediaSummary(media) {
  if (!media || media.error) return null;
  const v = media.video;
  const res = v?.height ? (v.height >= 2000 ? '4K' : v.height >= 1000 ? '1080p' : v.height >= 700 ? '720p' : v.height >= 560 ? '576p' : 'SD') : null;
  return {
    resolution: res,
    width: v?.width || null,
    height: v?.height || null,
    videoCodec: v?.codec || null,
    hdr: Boolean(v?.hdr),
    bitDepth: v?.bitDepth || null,
    container: media.container,
    bitrate: media.bitrate,
    audio: (media.audio || []).map((a) => ({
      index: a.index,
      codec: a.codec,
      channels: a.channels,
      language: a.language,
      title: a.title,
      default: a.default,
    })),
    subtitles: (media.subtitles || []).length,
  };
}

/**
 * @param {object} row  items row
 * @param {object} [extra] { progress, full }
 */
export function serializeItem(row, extra = {}) {
  if (!row) return null;
  const media = extra.full ? parseJson(row.media, null) : null;
  const out = {
    id: row.id,
    kind: row.kind,
    libraryId: row.library_id,
    parentId: row.parent_id,
    showId: row.show_id,
    title: row.title,
    sortTitle: row.sort_title ?? null, // v0.25: the A–Z rail's letters follow the list's own order
    year: row.year,
    season: row.season,
    episode: row.episode,
    overview: row.overview,
    genres: parseJson(row.genres, []),
    rating: row.rating,
    runtime: row.runtime,
    airDate: row.air_date,
    duration: row.duration,
    poster: imageUrl(row, 'poster'),
    backdrop: imageUrl(row, 'backdrop'),
    logo: imageUrl(row, 'logo'),
    addedAt: row.added_at,
  };
  if (isRemotePath(row.path)) out.remote = true;
  if (row.extra_kind) {
    out.extraKind = row.extra_kind;
    out.caption = EXTRA_CAPTIONS[row.extra_kind] || 'Extra';
  }
  if (row.artist) out.artist = row.artist;
  // v0.22: podcasts and audiobooks
  if (row.author) out.author = row.author;
  if (row.narrator) out.narrator = row.narrator;
  if (row.published_at) out.publishedAt = row.published_at;
  // v0.22 Plan D: books and comics
  if (row.issue != null) out.issue = row.issue;
  if (row.page_count != null) out.pageCount = row.page_count;
  if (row.reading_dir) out.readingDir = row.reading_dir;
  if (row.kind === 'comic' && row.page_count == null && /"format":"cb[r7]"/.test(row.media || '')) out.needsTool = 'Install 7-Zip to read this';
  if (row.album_title !== undefined) {
    out.albumTitle = row.album_title;
    out.albumPoster = row.album_poster ? `/api/items/${row.parent_id}/image/poster?v=${row.album_meta || 0}` : null;
    if (!out.poster) out.poster = out.albumPoster;
  }
  if (row.show_title) out.showTitle = row.show_title;
  if (row.show_backdrop !== undefined) {
    out.showBackdrop = row.show_backdrop ? `/api/items/${row.show_id}/image/backdrop?v=${row.show_meta || 0}` : null;
    out.showPoster = row.show_poster ? `/api/items/${row.show_id}/image/poster?v=${row.show_meta || 0}` : null;
    out.showLogo = row.show_logo ? `/api/items/${row.show_id}/image/logo?v=${row.show_meta || 0}` : null;
  }
  if (extra.progress !== undefined) {
    const p = extra.progress;
    out.progress = p ? { position: p.position, duration: p.duration, watched: Boolean(p.watched), updatedAt: p.updated_at } : null;
    // v0.22: where in a book or comic, and on what kind of device it was read
    if (p && (p.locator !== undefined || p.device !== undefined)) Object.assign(out.progress, { locator: parseJson(p.locator, null), device: p.device ?? null });
  }
  if (extra.mine) {
    // The viewer's own numbers: counted plays (films, episodes and songs only), last played, stars and heart.
    const m = extra.mine;
    out.playCount = ['movie', 'episode', 'track'].includes(row.kind) ? m.playCount || 0 : null;
    out.lastPlayed = m.lastPlayed ?? null;
    out.stars = m.stars ?? null;
    out.favourite = Boolean(m.favourite);
  }
  if (row.unwatched_count !== undefined && row.unwatched_count !== null) out.unwatched = row.unwatched_count;
  if (row.child_count !== undefined) out.childCount = row.child_count;
  if (extra.full) {
    out.tagline = row.tagline;
    out.originalTitle = row.original_title;
    out.tmdbId = row.tmdb_id;
    out.imdbId = row.imdb_id;
    out.scores = parseJson(row.scores, null); // v0.23: outside scores from a metadata plugin
    out.media = mediaSummary(media);
    out.fileName = row.path && !row.path.includes('::') && !isRemotePath(row.path) ? row.path.split(/[\\/]/).pop() : null;
    out.size = row.size;
    out.metadataLocked = Boolean(row.metadata_locked);
    out.certification = row.certification || null;
    out.minAge = row.min_age ?? null;
  }
  return out;
}

export function serializeLibrary(row, counts = {}, { recordingsId = null } = {}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    paths: parseJson(row.paths, []),
    lastScan: row.last_scan,
    count: counts[row.id] || 0,
    serverId: row.server_id || null,
    serverName: row.server_name || null,
    remoteId: row.remote_id || null,
    options: { previews: true, ...parseJson(row.options, {}) },
    recordings: row.id === recordingsId, // the Live TV recordings library (its own icon in Orbit)
  };
}
