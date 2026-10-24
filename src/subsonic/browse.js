// Browsing for music apps: folders, artists (by letter), albums, songs, directories, genres, album lists, random
// songs, starred, search and now playing. Every query goes through the viewer's visibility (library access, Kids
// rules), and the viewer's own numbers (plays, stars, heart) come in two extra queries per answer, not one per row.
import { SubsonicError } from './envelope.js';
import { song, album, albumDir, artist, mineFor, needId, parseId, sortName, ARTICLES } from './shapes.js';
import { musicFolders } from './system.js';
import { keyMatch, ensureSearchKeys } from '../library/searchkey.js';

const MAX = 500;
/** How much a list without paging answers at most (v0.21: when one is cut there, its container says `truncated`, an
 *  extra attribute apps ignore, and the log says which). Settable for the tests. */
export const LIMITS = { artists: 5000, starred: MAX, playlist: 5000 };
const warned = new Set();
export function cutAt(rows, limit, what, log = console) {
  if (rows.length <= limit) return { rows, truncated: false };
  if (!warned.has(what)) {
    warned.add(what);
    log.warn?.(`Music apps: ${what} cut at ${limit} (the app is told the list goes on)`);
  }
  return { rows: rows.slice(0, limit), truncated: true };
}

/** The SQL a method builds on: songs, albums and artists the viewer may see, optionally in one music folder. */
export function queries(core, viewer, folderId = null) {
  const { db, library } = core;
  const pid = viewer.profileId || 0;
  const folders = musicFolders(core, viewer).map((l) => l.id);
  const allowed = folderId == null ? folders : folders.includes(Number(folderId)) ? [Number(folderId)] : [];
  const scope = (a) => {
    const vis = library.visibility(viewer, a);
    const lib = allowed.length ? `${a}.library_id IN (${allowed.map(() => '?').join(',')})` : '0';
    return { sql: `${vis.sql} AND ${lib}`, params: [...vis.params, ...allowed] };
  };
  const ts = scope('t');
  const songGenres = "CASE WHEN i.genres IS NULL OR i.genres = '[]' THEN al.genres ELSE i.genres END";

  function songs({ where = '1', params = [], order = 'al.sort_title COLLATE NOCASE, i.season, i.episode, i.id', limit = MAX, offset = 0 } = {}) {
    const s = scope('i');
    return db.all(
      `SELECT i.*, al.title AS album_title, al.year AS album_year, al.genres AS album_genres, ar.title AS album_artist, ${songGenres} AS song_genres
       FROM items i JOIN items al ON al.id = i.parent_id LEFT JOIN items ar ON ar.id = i.show_id
       WHERE i.kind = 'track' AND ${s.sql} AND (${where}) ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...s.params, ...params, limit, offset,
    );
  }
  function albums({ where = '1', params = [], order = 'al.sort_title COLLATE NOCASE, al.id', limit = MAX, offset = 0, having = '' } = {}) {
    const s = scope('al');
    return db.all(
      `SELECT al.*, ar.title AS artist_name,
         (SELECT COUNT(*) FROM items t WHERE t.parent_id = al.id AND t.kind = 'track' AND ${ts.sql}) AS song_count,
         (SELECT COALESCE(SUM(t.duration), 0) FROM items t WHERE t.parent_id = al.id AND t.kind = 'track' AND ${ts.sql}) AS total_duration,
         (SELECT COALESCE(SUM(p.counted), 0) FROM plays p JOIN items t ON t.id = p.item_id WHERE t.parent_id = al.id AND p.profile_id = ?) AS play_count,
         (SELECT MAX(p.updated_at) FROM plays p JOIN items t ON t.id = p.item_id WHERE t.parent_id = al.id AND p.profile_id = ?) AS last_played,
         ur.stars AS my_stars, COALESCE(ur.favourite, 0) AS my_favourite
       FROM items al LEFT JOIN items ar ON ar.id = al.parent_id LEFT JOIN user_ratings ur ON ur.item_id = al.id AND ur.profile_id = ?
       WHERE al.kind = 'album' AND ${s.sql} AND (${where}) ${having ? `AND ${having}` : ''}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...ts.params, ...ts.params, pid, pid, pid, ...s.params, ...params, limit, offset,
    );
  }
  function artists({ where = '1', params = [], limit = 5000, offset = 0 } = {}) {
    const s = scope('al');
    // An artist is listed when the viewer may see at least one of its albums.
    return db.all(
      `SELECT ar.*, COUNT(al.id) AS album_count FROM items ar JOIN items al ON al.parent_id = ar.id AND al.kind = 'album' AND ${s.sql}
       WHERE ar.kind = 'artist' AND (${where}) GROUP BY ar.id ORDER BY ar.title COLLATE NOCASE LIMIT ? OFFSET ?`,
      ...s.params, ...params, limit, offset,
    );
  }
  /** Each genre the viewer's songs have (a song's own, else its album's), counted in one query. */
  function genreCounts() {
    const s = scope('i');
    return db.all(
      `SELECT g.value AS value, COUNT(*) AS songs, COUNT(DISTINCT i.parent_id) AS albums
       FROM items i JOIN items al ON al.id = i.parent_id, json_each(${songGenres}) g
       WHERE i.kind = 'track' AND ${s.sql} GROUP BY g.value ORDER BY g.value`,
      ...s.params,
    );
  }
  const mine = (rows) => mineFor(db, pid, rows.map((r) => r.id));
  return { songs, albums, artists, mine, genreCounts, folders: allowed, songGenres };
}

const shapeSongs = (q, rows) => {
  const m = q.mine(rows);
  return rows.map((r) => song(r, m));
};
const shapeAlbums = (q, rows, as = album) => {
  const m = q.mine(rows);
  return rows.map((r) => as(r, m));
};
const shapeArtists = (q, rows) => {
  const m = q.mine(rows);
  return rows.map((r) => artist(r, m));
};

/** Artists grouped by their first letter (articles ignored; anything not a letter under "#"). */
function byLetter(list) {
  const groups = new Map();
  for (const a of [...list].sort((x, y) => sortName(x.name).localeCompare(sortName(y.name), undefined, { sensitivity: 'base' }))) {
    const c = sortName(a.name).charAt(0).toUpperCase();
    const key = /\p{L}/u.test(c) ? c.normalize('NFD').charAt(0) : '#';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups].map(([name, artistList]) => ({ name, artist: artistList }));
}

const genreIs = (expr) => `EXISTS (SELECT 1 FROM json_each(${expr}) g WHERE g.value = ?)`;

export function registerBrowse(s) {
  const qFor = (ctx) => queries(ctx.core, ctx.viewer, ctx.params.get('musicFolderId'));

  s.method('getMusicFolders', ({ core, viewer }) => ({ musicFolders: { musicFolder: musicFolders(core, viewer).map((l) => ({ id: l.id, name: l.name })) } }));

  const allArtists = (q) => cutAt(q.artists({ limit: LIMITS.artists + 1 }), LIMITS.artists, 'artists');
  s.method('getArtists', (ctx) => {
    const q = qFor(ctx);
    const { rows, truncated } = allArtists(q);
    return { artists: { ignoredArticles: ARTICLES, index: byLetter(shapeArtists(q, rows)), ...(truncated ? { truncated } : {}) } };
  });
  s.method('getIndexes', (ctx) => {
    const q = qFor(ctx);
    const last = ctx.core.db.get("SELECT MAX(updated_at) AS t FROM items WHERE kind IN ('artist','album','track')").t || 0;
    const ifModified = Number(ctx.params.get('ifModifiedSince') || 0);
    if (ifModified && ifModified >= last) return { indexes: { lastModified: last, ignoredArticles: ARTICLES } };
    const { rows, truncated } = allArtists(q);
    const index = byLetter(shapeArtists(q, rows)).map((g) => ({ name: g.name, artist: g.artist.map((a) => ({ id: a.id, name: a.name, starred: a.starred, userRating: a.userRating })) }));
    return { indexes: { lastModified: last, ignoredArticles: ARTICLES, index, ...(truncated ? { truncated } : {}) } };
  });

  const oneArtist = (q, id) => {
    const row = q.artists({ where: 'ar.id = ?', params: [id] })[0];
    if (!row) throw new SubsonicError(70, 'Artist not found');
    return row;
  };
  const oneAlbum = (q, id) => {
    const row = q.albums({ where: 'al.id = ?', params: [id] })[0];
    if (!row) throw new SubsonicError(70, 'Album not found');
    return row;
  };

  s.method('getArtist', (ctx) => {
    const q = qFor(ctx);
    const { id } = needId(ctx.params, 'id', ['ar'], 'Artist');
    const row = oneArtist(q, id);
    const albums = q.albums({ where: 'al.parent_id = ?', params: [id], order: 'al.year, al.sort_title COLLATE NOCASE' });
    return { artist: { ...artist(row, q.mine([row])), album: shapeAlbums(q, albums) } };
  });
  s.method('getArtistInfo2', (ctx) => {
    const q = qFor(ctx);
    const row = oneArtist(q, needId(ctx.params, 'id', ['ar'], 'Artist').id);
    return { artistInfo2: { biography: row.overview || undefined, similarArtist: [] } };
  });
  s.method('getArtistInfo', (ctx) => {
    const q = qFor(ctx);
    const row = oneArtist(q, needId(ctx.params, 'id', ['ar'], 'Artist').id);
    return { artistInfo: { biography: row.overview || undefined, similarArtist: [] } };
  });

  const albumWithSongs = (q, id) => {
    const row = oneAlbum(q, id);
    const songs = q.songs({ where: 'i.parent_id = ?', params: [id], order: 'i.season, i.episode, i.sort_title COLLATE NOCASE, i.id' });
    return { ...album(row, q.mine([row])), song: shapeSongs(q, songs) };
  };
  s.method('getAlbum', (ctx) => ({ album: albumWithSongs(qFor(ctx), needId(ctx.params, 'id', ['al'], 'Album').id) }));
  s.method('getAlbumInfo2', (ctx) => {
    const row = oneAlbum(qFor(ctx), needId(ctx.params, 'id', ['al'], 'Album').id);
    return { albumInfo: { notes: row.overview || undefined } };
  });
  s.method('getAlbumInfo', (ctx) => {
    const row = oneAlbum(qFor(ctx), needId(ctx.params, 'id', ['al'], 'Album').id);
    return { albumInfo: { notes: row.overview || undefined } };
  });

  s.method('getSong', (ctx) => {
    const q = qFor(ctx);
    const { id } = needId(ctx.params, 'id', ['tr'], 'Song');
    const rows = q.songs({ where: 'i.id = ?', params: [id] });
    if (!rows.length) throw new SubsonicError(70, 'Song not found');
    return { song: shapeSongs(q, rows)[0] };
  });

  s.method('getMusicDirectory', (ctx) => {
    const q = qFor(ctx);
    const id = needId(ctx.params, 'id', ['mf', 'ar', 'al'], 'Folder');
    if (id.kind === 'mf') {
      if (!q.folders.includes(id.id)) throw new SubsonicError(70, 'Folder not found');
      const lib = ctx.core.db.get('SELECT name FROM libraries WHERE id = ?', id.id);
      const scoped = queries(ctx.core, ctx.viewer, id.id);
      const child = shapeArtists(scoped, scoped.artists()).map((a) => ({ id: a.id, parent: `mf-${id.id}`, isDir: true, title: a.name, artist: a.name, coverArt: a.coverArt, starred: a.starred, userRating: a.userRating }));
      return { directory: { id: `mf-${id.id}`, name: lib.name, child } };
    }
    if (id.kind === 'ar') {
      const row = oneArtist(q, id.id);
      const child = shapeAlbums(q, q.albums({ where: 'al.parent_id = ?', params: [id.id], order: 'al.year, al.sort_title COLLATE NOCASE' }), albumDir);
      return { directory: { id: `ar-${row.id}`, parent: `mf-${row.library_id}`, name: row.title, child } };
    }
    const a = albumWithSongs(q, id.id);
    return { directory: { id: a.id, parent: a.artistId, name: a.name, child: a.song } };
  });

  s.method('getGenres', (ctx) => {
    const q = qFor(ctx);
    const genre = q.genreCounts().map((r) => ({ value: r.value, songCount: r.songs, albumCount: r.albums }));
    return { genres: { genre } };
  });

  s.method('getSongsByGenre', (ctx) => {
    const q = qFor(ctx);
    const genre = ctx.params.need('genre');
    const rows = q.songs({ where: genreIs(q.songGenres), params: [genre], limit: ctx.params.int('count', 10, { min: 0, max: MAX }), offset: ctx.params.int('offset', 0, { min: 0 }) });
    return { songsByGenre: { song: shapeSongs(q, rows) } };
  });

  function albumList(ctx) {
    const q = qFor(ctx);
    const p = ctx.params;
    const type = p.need('type');
    const size = p.int('size', 10, { min: 0, max: MAX });
    const offset = p.int('offset', 0, { min: 0 });
    const page = { limit: size, offset };
    const byName = 'al.sort_title COLLATE NOCASE, al.id';
    switch (type) {
      case 'random':
        return q.albums({ ...page, order: 'RANDOM()' });
      case 'newest':
        return q.albums({ ...page, order: 'al.added_at DESC, al.id DESC' });
      case 'frequent':
        return q.albums({ ...page, having: 'play_count > 0', order: `play_count DESC, ${byName}` });
      case 'recent':
        return q.albums({ ...page, having: 'last_played IS NOT NULL', order: `last_played DESC, ${byName}` });
      case 'starred':
        return q.albums({ ...page, having: 'my_favourite = 1', order: byName });
      case 'highest':
        return q.albums({ ...page, having: 'my_stars IS NOT NULL', order: `my_stars DESC, ${byName}` });
      case 'alphabeticalByName':
        return q.albums({ ...page, order: byName });
      case 'alphabeticalByArtist': {
        const art = "CASE WHEN lower(ar.title) LIKE 'the %' THEN substr(ar.title, 5) WHEN lower(ar.title) LIKE 'a %' THEN substr(ar.title, 3) ELSE ar.title END";
        return q.albums({ ...page, order: `${art} COLLATE NOCASE, al.year, ${byName}` });
      }
      case 'byYear': {
        const from = p.int('fromYear', undefined);
        const to = p.int('toYear', undefined);
        if (from === undefined) throw new SubsonicError(10, 'Required parameter is missing: fromYear');
        if (to === undefined) throw new SubsonicError(10, 'Required parameter is missing: toYear');
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        return q.albums({ ...page, where: 'al.year BETWEEN ? AND ?', params: [lo, hi], order: `al.year ${from <= to ? 'ASC' : 'DESC'}, ${byName}` });
      }
      case 'byGenre': {
        const genre = p.need('genre');
        return q.albums({ ...page, where: `(${genreIs('al.genres')} OR EXISTS (SELECT 1 FROM items t, json_each(t.genres) g WHERE t.parent_id = al.id AND t.kind = 'track' AND g.value = ?))`, params: [genre, genre], order: byName });
      }
      default:
        throw new SubsonicError(0, `Atomix doesn't know the album list "${String(type).slice(0, 40)}"`);
    }
  }
  s.method('getAlbumList2', (ctx) => {
    const rows = albumList(ctx);
    return { albumList2: { album: shapeAlbums(qFor(ctx), rows) } };
  });
  s.method('getAlbumList', (ctx) => {
    const rows = albumList(ctx);
    return { albumList: { album: shapeAlbums(qFor(ctx), rows, albumDir) } };
  });

  s.method('getRandomSongs', (ctx) => {
    const q = qFor(ctx);
    const p = ctx.params;
    const where = [];
    const params = [];
    if (p.get('genre')) where.push(genreIs(q.songGenres)) && params.push(p.get('genre'));
    const yr = 'COALESCE(i.year, al.year)';
    if (p.get('fromYear')) where.push(`${yr} >= ?`) && params.push(p.int('fromYear'));
    if (p.get('toYear')) where.push(`${yr} <= ?`) && params.push(p.int('toYear'));
    const rows = q.songs({ where: where.join(' AND ') || '1', params, order: 'RANDOM()', limit: p.int('size', 10, { min: 0, max: MAX }) });
    return { randomSongs: { song: shapeSongs(q, rows) } };
  });

  function starred(ctx, as) {
    const q = qFor(ctx);
    const pid = ctx.viewer.profileId || 0;
    const fav = (a) => `EXISTS (SELECT 1 FROM user_ratings r WHERE r.item_id = ${a}.id AND r.profile_id = ${Number(pid)} AND r.favourite = 1)`;
    const n = LIMITS.starred;
    const ar = cutAt(q.artists({ where: fav('ar'), limit: n + 1 }), n, 'starred artists');
    const al = cutAt(q.albums({ where: fav('al'), limit: n + 1 }), n, 'starred albums');
    const so = cutAt(q.songs({ where: fav('i'), limit: n + 1 }), n, 'starred songs');
    return {
      artist: shapeArtists(q, ar.rows),
      album: shapeAlbums(q, al.rows, as),
      song: shapeSongs(q, so.rows),
      ...(ar.truncated || al.truncated || so.truncated ? { truncated: true } : {}),
    };
  }
  s.method('getStarred2', (ctx) => ({ starred2: starred(ctx, album) }));
  s.method('getStarred', (ctx) => {
    const st = starred(ctx, albumDir);
    return { starred: { ...st, artist: st.artist.map((a) => ({ id: a.id, name: a.name, starred: a.starred })) } };
  });

  function search(ctx, as) {
    const q = qFor(ctx);
    const p = ctx.params;
    const text = String(p.get('query') ?? '').replace(/^"+|"+$/g, '').trim(); // "" (Symfonium's sync) is everything
    const n = (name, d = 20) => p.int(`${name}Count`, d, { min: 0, max: MAX });
    const o = (name) => p.int(`${name}Offset`, 0, { min: 0 });
    // v0.24: accents, case, punctuation and a leading "the" ignored, as in Atomix's own search — on the stored keys
    // (a title's), so only a song's artist is keyed per row.
    const keys = keyMatch('x', text).params;
    if (text) ensureSearchKeys(ctx.core.db);
    const keyed = (c) => ({ 'ar.title': 'ar.search_key', 'al.title': 'al.search_key', 'i.title': 'i.search_key' })[c] || `atomix_key(${c})`;
    const match = (cols) => (!text ? '1' : keys.length ? `(${cols.flatMap((c) => keys.map(() => `${keyed(c)} LIKE ?`)).join(' OR ')})` : '0');
    const args = (k) => (text ? Array.from({ length: k }, () => keys).flat() : []);
    const ar = n('artist') ? q.artists({ where: match(['ar.title']), params: args(1), limit: n('artist'), offset: o('artist') }) : [];
    const al = n('album') ? q.albums({ where: match(['al.title', 'ar.title']), params: args(2), limit: n('album'), offset: o('album') }) : [];
    const so = n('song') ? q.songs({ where: match(['i.title', 'i.artist', 'al.title']), params: args(3), order: 'i.title COLLATE NOCASE, i.id', limit: n('song'), offset: o('song') }) : [];
    return { artist: shapeArtists(q, ar), album: shapeAlbums(q, al, as), song: shapeSongs(q, so) };
  }
  s.method('search3', (ctx) => ({ searchResult3: search(ctx, album) }));
  s.method('search2', (ctx) => {
    const r = search(ctx, albumDir);
    return { searchResult2: { ...r, artist: r.artist.map((a) => ({ id: a.id, name: a.name, starred: a.starred })) } };
  });

  s.method('getNowPlaying', (ctx) => {
    const q = qFor(ctx);
    const now = Date.now();
    const recent = ctx.core.db.all(
      `SELECT p.item_id, p.updated_at, p.client, pr.name AS profile_name FROM plays p JOIN profiles pr ON pr.id = p.profile_id JOIN items i ON i.id = p.item_id
       WHERE i.kind = 'track' AND p.updated_at >= ? AND pr.user_id = ? AND p.id = (SELECT p2.id FROM plays p2 WHERE p2.profile_id = p.profile_id ORDER BY p2.updated_at DESC LIMIT 1)
       ORDER BY p.updated_at DESC`,
      now - 10 * 60_000,
      ctx.user.id,
    );
    const rows = recent.length ? q.songs({ where: `i.id IN (${recent.map(() => '?').join(',')})`, params: recent.map((r) => r.item_id) }) : [];
    const shaped = new Map(shapeSongs(q, rows).map((x) => [x.id, x]));
    const entry = recent
      .filter((r) => shaped.has(`tr-${r.item_id}`))
      .map((r) => ({ ...shaped.get(`tr-${r.item_id}`), username: r.profile_name, minutesAgo: Math.floor((now - r.updated_at) / 60_000), playerId: 0, playerName: r.client }));
    return { nowPlaying: { entry } };
  });
}

export { parseId };
