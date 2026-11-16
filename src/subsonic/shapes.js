// How Atomix's songs, albums and artists look to a music app: Subsonic's "child" (a song or a directory),
// "AlbumID3" and "ArtistID3", with the viewer's own play count, last played, stars and heart. Ids carry their kind
// (tr-, al-, ar-, pl-, sp-, mf-). A song's path is made up from its artist, album and file name — never where the file
// really is on the server.
import path from 'node:path';
import { parseJson } from '../db.js';
import { SubsonicError } from './envelope.js';
import { replayGainOf } from '../library/loudness.js';

const TYPES = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff', ape: 'audio/x-ape', wv: 'audio/x-wavpack', mka: 'audio/x-matroska', webm: 'audio/webm' };
const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
const firstGenre = (...lists) => {
  for (const l of lists) {
    const g = parseJson(l, []);
    if (g.length) return g[0];
  }
  return undefined;
};

/** "tr-12" → { kind: 'tr', id: 12 } when its kind is one of `kinds`; else null. */
export function parseId(raw, kinds) {
  const m = /^([a-z]{2})-(\d+)$/.exec(String(raw ?? ''));
  if (!m || !kinds.includes(m[1])) return null;
  return { kind: m[1], id: Number(m[2]) };
}

/** Like parseId, but a bad or missing id is Subsonic's "not found" (or "missing" when absent). */
export function needId(params, name, kinds, what) {
  const raw = params.need(name);
  const id = parseId(raw, kinds);
  if (!id) throw new SubsonicError(70, `${what} not found`);
  return id;
}

/**
 * The viewer's own numbers for these items: Map<id, { playCount, lastPlayed, stars, favourite, ratedAt }>.
 * Two queries for any number of items.
 */
export function mineFor(db, profileId, ids) {
  const out = new Map();
  if (!profileId || !ids.length) return out;
  const list = [...new Set(ids)];
  const marks = list.map(() => '?').join(',');
  for (const r of db.all(`SELECT item_id, SUM(counted) AS n, MAX(updated_at) AS last FROM plays WHERE profile_id = ? AND item_id IN (${marks}) GROUP BY item_id`, profileId, ...list)) {
    out.set(r.item_id, { playCount: r.n || 0, lastPlayed: r.last });
  }
  for (const r of db.all(`SELECT item_id, stars, favourite, updated_at FROM user_ratings WHERE profile_id = ? AND item_id IN (${marks})`, profileId, ...list)) {
    out.set(r.item_id, { ...(out.get(r.item_id) || {}), stars: r.stars, favourite: Boolean(r.favourite), ratedAt: r.updated_at });
  }
  return out;
}

const annotate = (out, m) => {
  if (m?.stars) out.userRating = m.stars;
  if (m?.favourite) out.starred = iso(m.ratedAt);
  return out;
};

/** A song row (with album_title, album_year, album_genres, album_artist) as a Subsonic child. */
export function song(row, mine) {
  const ext = path.extname(row.path || '').slice(1).toLowerCase();
  const media = parseJson(row.media, {});
  const m = mine?.get(row.id);
  const artistDir = row.album_artist || row.artist || 'Unknown artist';
  const out = {
    id: `tr-${row.id}`,
    parent: `al-${row.parent_id}`,
    isDir: false,
    title: row.title,
    album: row.album_title ?? undefined,
    artist: row.artist || row.album_artist || undefined,
    track: row.episode ?? undefined,
    discNumber: row.season ?? undefined,
    year: row.year || row.album_year || undefined,
    genre: firstGenre(row.genres, row.album_genres),
    coverArt: `al-${row.parent_id}`,
    size: row.size ?? undefined,
    contentType: TYPES[ext] || 'application/octet-stream',
    suffix: ext || undefined,
    duration: row.duration ? Math.round(row.duration) : undefined,
    bitRate: media.bitrate ? Math.round(media.bitrate / 1000) : undefined,
    path: `${artistDir}/${row.album_title || 'Unknown album'}/${path.basename(row.path || `${row.title}.${ext}`)}`.replace(/\\/g, '/'),
    albumId: `al-${row.parent_id}`,
    artistId: row.show_id ? `ar-${row.show_id}` : undefined,
    type: 'music',
    isVideo: false,
    playCount: m?.playCount || 0,
    created: iso(row.added_at),
  };
  if (m?.lastPlayed) out.played = iso(m.lastPlayed);
  const rg = replayGainOf(media.loudness); // v0.28: OpenSubsonic replayGain, so apps level songs too
  if (rg) out.replayGain = rg;
  return annotate(out, m);
}

/** An album row (with artist_name, song_count, total_duration) as AlbumID3. */
export function album(row, mine) {
  const m = mine?.get(row.id);
  return annotate(
    {
      id: `al-${row.id}`,
      name: row.title,
      artist: row.artist_name || row.artist || undefined,
      artistId: row.parent_id ? `ar-${row.parent_id}` : undefined,
      coverArt: `al-${row.id}`,
      songCount: row.song_count || 0,
      duration: Math.round(row.total_duration || 0),
      playCount: row.play_count || 0,
      created: iso(row.added_at),
      year: row.year || undefined,
      genre: firstGenre(row.genres),
    },
    m,
  );
}

/** An album as an old-style directory entry (getAlbumList, getMusicDirectory, search2, getStarred). */
export function albumDir(row, mine) {
  const a = album(row, mine);
  return { id: a.id, parent: a.artistId, isDir: true, title: a.name, name: a.name, album: a.name, artist: a.artist, year: a.year, genre: a.genre, coverArt: a.coverArt, playCount: a.playCount, created: a.created, userRating: a.userRating, starred: a.starred };
}

/** An artist row (with album_count) as ArtistID3. */
export function artist(row, mine) {
  return annotate({ id: `ar-${row.id}`, name: row.title, coverArt: `ar-${row.id}`, albumCount: row.album_count || 0 }, mine?.get(row.id));
}

/** Sorting name with the articles Subsonic ignores ("The Band" → "Band"). */
export const ARTICLES = 'The A';
export const sortName = (name) => String(name || '').replace(/^(the|a)\s+/i, '');
