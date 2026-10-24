// Library browsing, item details, artwork, progress and scanning endpoints.
import { shiftVtt } from '../stream/vttshift.js';
import fs from 'node:fs';
import { recordProgress } from '../library/progress.js';
import path from 'node:path';
import { HttpError, readBody } from '../http/router.js';
import { sendFile, mimeFor } from '../http/static.js';
import { serializeItem, serializeLibrary } from './serialize.js';
import { listSubtitles, getSubtitleVtt, saveDownloaded, deleteDownloaded } from '../stream/subtitles.js';
import { parseJson } from '../db.js';
import { isRemotePath, resolveSource } from '../remote/index.js';
import { proxyRemoteFile } from '../stream/remotefile.js';
import { sendArtwork } from '../library/artwork.js';
import { logger } from '../log.js';
import { ensureSearchKeys, keyMatch } from '../library/searchkey.js';
import { applyLayout, checkedLayout } from '../home/layout.js';
import { homeRows, groupByKey } from '../home/rows.js';
import { bookParts, bookChapters, placeOnBook } from '../library/audiobooks.js';
import { AUDIO_KINDS } from '../library/kinds.js';
import { EDITABLE, editDetails, detailValues, lockedFields, ARTWORK_TYPES, UPLOAD_MAX, artworkOptions, previewRef, setArtwork, isTmdbPath } from '../library/editing.js';

const log = logger('api');
const LIBRARY_TYPES = ['movies', 'tv', 'music', 'podcasts', 'audiobooks', 'books', 'comics'];

/** Load an item the current viewer is allowed to see (404 otherwise, so hidden titles stay hidden). */
function requireItem(core, id, viewer) {
  const item = core.library.get(id);
  if (!item || (viewer && !core.library.canSee(viewer, item))) throw new HttpError(404, 'This title no longer exists.');
  return item;
}

function cleanPaths(paths) {
  const list = [].concat(paths || []).map((p) => String(p).trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, 'Add at least one folder.');
  for (const p of list) {
    if (!path.isAbsolute(p)) throw new HttpError(400, `"${p}" is not a full path (e.g. D:\\Movies or /media/movies).`);
    if (!fs.existsSync(p)) throw new HttpError(400, `The server can't find the folder "${p}".`);
    if (!fs.statSync(p).isDirectory()) throw new HttpError(400, `"${p}" is a file, not a folder.`);
  }
  return [...new Set(list.map((p) => path.resolve(p)))];
}

/** Library options an admin can set. Only known keys are kept, as booleans. */
function cleanOptions(input, current = {}) {
  const previews = input && typeof input === 'object' && 'previews' in input ? Boolean(input.previews) : current.previews;
  return { previews: previews ?? true, ...(current.remoteGone ? { remoteGone: true } : {}) }; // the sync's flag is not the admin's to set
}

export function registerLibraryRoutes(r, core) {
  const { db, library, scanner, metadata, config, images, plugins, settings } = core;

  /** What the Trailer button plays: a local trailer the viewer may see, else the YouTube one (not for kids, and only with the switch on). */
  function trailerFor(row, ctx) {
    const local = db.get("SELECT id, kind, min_age, library_id, show_id FROM items WHERE kind = 'extra' AND extra_kind = 'trailer' AND parent_id = ? ORDER BY sort_title COLLATE NOCASE LIMIT 1", row.id);
    if (local && library.canSee(ctx.viewer, local)) return { kind: 'local', itemId: local.id };
    const t = parseJson(row.trailer, null);
    if (t?.site === 'youtube' && settings.get('onlineTrailers') && !ctx.profile?.kids) return { kind: 'youtube', key: t.key, name: t.name || 'Trailer' };
    return null;
  }

  const counts = () =>
    Object.fromEntries(
      db
        .all(`SELECT library_id, COUNT(*) AS n FROM items WHERE kind IN ('movie','show','album') GROUP BY library_id`)
        .map((row) => [row.library_id, row.n]),
    );

  // ---- Libraries ----
  const visibleLibrary = (ctx, id) => {
    const lib = library.visibleLibraries(ctx.viewer).find((l) => l.id === Number(id));
    if (!lib) throw new HttpError(404, 'This library no longer exists.');
    return lib;
  };

  r.get('/api/libraries', (ctx) => {
    const c = counts();
    const recordingsId = core.live?.scheduler?.recordingsLibrary()?.id ?? null;
    return library.visibleLibraries(ctx.viewer).map((l) => serializeLibrary(l, c, { recordingsId }));
  });

  r.post(
    '/api/libraries',
    async (ctx) => {
      const body = await ctx.body();
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) throw new HttpError(400, 'Give the library a name.');
      if (!LIBRARY_TYPES.includes(body.type)) throw new HttpError(400, 'Type must be "movies", "tv", "music", "podcasts", "audiobooks", "books" or "comics".');
      const paths = cleanPaths(body.paths);
      if (body.type === 'podcasts' && paths.length !== 1) throw new HttpError(400, 'A podcasts library keeps its episodes in one folder.');
      const res = db.run(
        'INSERT INTO libraries (name, type, paths, options, created_at) VALUES (?, ?, ?, ?, ?)',
        name,
        body.type,
        JSON.stringify(paths),
        JSON.stringify(cleanOptions(body.options)),
        Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      scanner.enqueue(id).catch((e) => log.error(e.message));
      return serializeLibrary(db.get('SELECT * FROM libraries WHERE id = ?', id));
    },
    { auth: 'admin' },
  );

  r.put(
    '/api/libraries/:id',
    async (ctx) => {
      const lib = db.get('SELECT * FROM libraries WHERE id = ?', Number(ctx.params.id));
      if (!lib) throw new HttpError(404, 'This library no longer exists.');
      const body = await ctx.body();
      const name = body.name != null ? String(body.name).trim().slice(0, 60) || lib.name : lib.name;
      const paths = body.paths != null ? cleanPaths(body.paths) : parseJson(lib.paths, []);
      const options = body.options != null ? cleanOptions(body.options, parseJson(lib.options, {})) : cleanOptions(null, parseJson(lib.options, {}));
      db.run('UPDATE libraries SET name = ?, paths = ?, options = ? WHERE id = ?', name, JSON.stringify(paths), JSON.stringify(options), lib.id);
      if (body.options != null) core.tasks.kick(); // previews may have just been switched on
      if (body.paths != null) scanner.enqueue(lib.id).catch((e) => log.error(e.message));
      return serializeLibrary(db.get('SELECT * FROM libraries WHERE id = ?', lib.id), counts());
    },
    { auth: 'admin' },
  );

  r.delete(
    '/api/libraries/:id',
    (ctx) => {
      db.run('DELETE FROM libraries WHERE id = ?', Number(ctx.params.id));
      return { ok: true };
    },
    { auth: 'admin' },
  );

  r.get('/api/libraries/:id/items', (ctx) => {
    const lib = visibleLibrary(ctx, ctx.params.id);
    const q = ctx.query;
    const limit = Math.min(Number(q.limit) || 5000, 10000);
    if (lib.type === 'music' && q.view === 'tracks') {
      const rows = library.tracks({ viewer: ctx.viewer, libraryId: lib.id, sort: q.sort || 'title', search: q.q, limit });
      return { library: serializeLibrary(lib), items: library.withProgress(rows, ctx.viewer) };
    }
    // v0.22: books and comics list their series and the titles that stand alone.
    const kind = lib.type === 'movies' ? 'movie' : lib.type === 'tv' ? 'show' : lib.type === 'podcasts' ? 'podcast' : lib.type === 'audiobooks' ? 'audiobook' : lib.type === 'books' ? ['series', 'book'] : lib.type === 'comics' ? ['series', 'comic'] : q.view === 'artists' ? 'artist' : 'album';
    const rows = library.list({
      viewer: ctx.viewer,
      libraryId: lib.id,
      kind,
      sort: q.sort,
      genre: q.genre,
      unwatched: q.unwatched === '1' && lib.type !== 'music',
      search: q.q,
      limit,
      offset: Number(q.offset) || 0,
      topLevel: lib.type === 'books' || lib.type === 'comics',
    });
    const items = library.withProgress(rows, ctx.viewer);
    if (lib.type === 'podcasts') {
      const counts = newEpisodeCounts(ctx.viewer, lib.id);
      for (const it of items) it.newCount = counts.get(it.id) || 0;
    }
    return { library: serializeLibrary(lib), items };
  });

  // v0.25: the library's titles this profile is part-way through, newest first: a film or episode started and not
  // finished, or a show whose next episode is waiting. Films by their own id, episodes by their show's, which carries
  // `episode`: the one part-watched, else the next one waiting.
  r.get('/api/libraries/:id/recent', (ctx) => {
    const lib = visibleLibrary(ctx, ctx.params.id);
    const pid = ctx.viewer?.profileId;
    if (!pid || (lib.type !== 'movies' && lib.type !== 'tv')) return [];
    const vis = library.visibility(ctx.viewer);
    const rows = db.all(
      `SELECT i.id, i.kind, i.show_id, p.position, p.watched, p.updated_at AS at FROM progress p JOIN items i ON i.id = p.item_id
       WHERE p.profile_id = ? AND i.library_id = ? AND i.kind IN ('movie', 'episode')
         AND ((p.watched = 0 AND p.position > 30) OR (p.watched = 1 AND i.kind = 'episode')) AND ${vis.sql}
       ORDER BY p.updated_at DESC`,
      pid,
      lib.id,
      ...vis.params,
    );
    const out = [];
    const seen = new Set();
    const waiting = new Map(); // show id → its next episode after the last watched one (null: none)
    for (const r of rows) {
      const id = r.kind === 'episode' ? r.show_id : r.id;
      if (id == null || seen.has(id)) continue;
      let episode = null; // a show's episode to play: the one part-watched, else the next one waiting
      if (r.kind === 'episode') {
        if (r.watched) {
          if (!waiting.has(id)) waiting.set(id, library.nextUpFor(ctx.viewer, id));
          episode = waiting.get(id);
          if (!episode) continue;
        } else episode = db.get('SELECT * FROM items WHERE id = ?', r.id);
      }
      seen.add(id);
      out.push(episode ? { id, at: r.at, episode: library.withProgress([episode], ctx.viewer)[0] } : { id, at: r.at });
      if (out.length >= 50) break;
    }
    return out;
  });

  // v0.22: a podcast's new episodes for this profile are its downloaded episodes not yet played, within its rules.
  const newEpisodeRows = (viewer, libraryId, limit) =>
    db
      .all(
        `SELECT i.* FROM items i LEFT JOIN progress p ON p.item_id = i.id AND p.profile_id = ?
         WHERE i.library_id = ? AND i.kind = 'podcast_episode' AND i.path IS NOT NULL AND COALESCE(p.watched, 0) = 0
         ORDER BY i.published_at IS NULL, i.published_at DESC, i.id DESC`,
        viewer?.profileId || 0,
        Number(libraryId),
      )
      .filter((r) => library.canSee(viewer, r))
      .slice(0, limit);
  function newEpisodeCounts(viewer, libraryId) {
    const counts = new Map();
    for (const r of newEpisodeRows(viewer, libraryId, Infinity)) counts.set(r.show_id, (counts.get(r.show_id) || 0) + 1);
    return counts;
  }
  r.get('/api/libraries/:id/new-episodes', (ctx) => {
    const lib = visibleLibrary(ctx, ctx.params.id);
    if (lib.type !== 'podcasts') return [];
    const rows = newEpisodeRows(ctx.viewer, lib.id, 20);
    const shows = new Map();
    for (const r of rows) {
      if (shows.has(r.show_id)) continue;
      const show = db.get('SELECT * FROM items WHERE id = ?', r.show_id);
      shows.set(r.show_id, show ? serializeItem(show, { full: false }) : null);
    }
    return library.withProgress(rows, ctx.viewer).map((e, i) => ({ ...e, showTitle: shows.get(rows[i].show_id)?.title ?? null, showPoster: shows.get(rows[i].show_id)?.poster ?? null }));
  });

  r.get('/api/libraries/:id/genres', (ctx) => library.genres(visibleLibrary(ctx, ctx.params.id).id, ctx.viewer));

  // ---- Scanning ----
  r.post(
    '/api/libraries/:id/scan',
    async (ctx) => {
      const body = await ctx.body();
      const lib = db.get('SELECT id FROM libraries WHERE id = ?', Number(ctx.params.id));
      if (!lib) throw new HttpError(404, 'This library no longer exists.');
      scanner.enqueue(lib.id, { refreshMetadata: Boolean(body.refreshMetadata) }).catch((e) => log.error(e.message));
      return { queued: true };
    },
    { auth: 'admin' },
  );

  // "Remove missing titles": a dry run counts them (for the confirmation), then a scan removes them even from a
  // folder that is now empty (normally kept, in case it's a drive that isn't connected).
  r.post(
    '/api/admin/libraries/:id/remove-missing',
    async (ctx) => {
      const body = await ctx.body();
      const lib = db.get('SELECT id FROM libraries WHERE id = ?', Number(ctx.params.id));
      if (!lib) throw new HttpError(404, 'This library no longer exists.');
      if (body.dryRun) return { count: scanner.missingCount(lib.id) };
      const result = await scanner.enqueue(lib.id, { removeMissing: true });
      return { removed: result?.removed ?? 0 };
    },
    { auth: 'admin' },
  );

  r.post(
    '/api/scan',
    async (ctx) => {
      const body = await ctx.body();
      scanner.scanAll({ refreshMetadata: Boolean(body.refreshMetadata) }).catch((e) => log.error(e.message));
      return { queued: true };
    },
    { auth: 'admin' },
  );

  r.get('/api/scan/status', (ctx) => (ctx.user?.role === 'admin' && !ctx.profile?.kids ? { ...scanner.status, queued: scanner.queue.filter((q) => !q.started).length } : { running: scanner.status.running }), { profile: false });

  // ---- Home ----
  r.get('/api/home', async (ctx) => {
    const viewer = ctx.viewer;
    const libs = library.visibleLibraries(viewer);
    const { layout } = core.home.effective(ctx.profile?.id);
    const rows = applyLayout(groupByKey(await homeRows(core, ctx, { pins: layout?.pins || [] })), layout).flatMap((g) => g.rows);

    // Hero: something recent with nice artwork.
    const vis = library.visibility(viewer);
    const heroRow = db.get(
      `SELECT * FROM items i WHERE i.kind IN ('movie','show') AND i.backdrop IS NOT NULL AND ${vis.sql}
       ORDER BY CASE WHEN i.added_at > ? THEN 0 ELSE 1 END, RANDOM() LIMIT 1`,
      ...vis.params,
      Date.now() - 14 * 86400 * 1000,
    ) || db.get(`SELECT * FROM items i WHERE i.kind IN ('movie','show') AND ${vis.sql} ORDER BY RANDOM() LIMIT 1`, ...vis.params);
    const hero = heroRow ? serializeItem(heroRow, { full: false, progress: library.progressFor(viewer.profileId, [heroRow.id]).get(heroRow.id) || null }) : null;
    if (hero) {
      hero.tagline = heroRow.tagline;
      hero.trailer = trailerFor(heroRow, ctx);
    }
    return { hero, rows, libraries: libs.map((l) => serializeLibrary(l)) };
  });

  // ---- Arrange home (v0.22) ----
  // Every row this viewer could have, in the order Home shows them (hidden ones included, marked).
  r.get('/api/home/layout', async (ctx) => {
    // ?scope=household: the household's own arrangement, for an admin editing it (rows as this admin would see them).
    const household = ctx.query.scope === 'household';
    if (household && (ctx.user?.role !== 'admin' || ctx.profile?.kids)) throw new HttpError(403, 'Only admins arrange the household’s Home.');
    const house = household ? core.home.household() : null;
    const { layout, source } = household ? { layout: house, source: house ? 'household' : 'default' } : core.home.effective(ctx.profile?.id);
    const rows = await homeRows(core, ctx, { editor: true, pins: layout?.pins || [] });
    const hidden = new Set((layout?.order || []).filter((e) => e.hidden).map((e) => e.key));
    const shown = applyLayout(rows, layout ? { ...layout, order: layout.order.map((e) => ({ key: e.key })) } : null);
    return {
      source,
      layout,
      rows: shown.map((row) => ({ key: row.key, title: row.title, hidden: hidden.has(row.key), ...(row.pin ? { pin: row.pin } : {}), ...(row.unavailable ? { unavailable: true } : {}) })),
    };
  });
  r.put('/api/home/layout', async (ctx) => {
    const own = core.home.profile(ctx.profile.id);
    const house = core.home.household();
    const layout = checkedLayout((await ctx.body()).layout, core, ctx.viewer, [...(own?.pins || []), ...(house?.pins || [])]);
    if (layout) {
      // The household's pins this save leaves out were removed by this profile: remembered, so they stay gone.
      const kept = new Set(layout.pins.map((p) => p.key));
      const removed = (house?.pins || []).map((p) => p.key).filter((k) => !kept.has(k));
      if (removed.length) layout.removed = removed;
      else delete layout.removed;
    }
    core.home.saveProfile(ctx.profile.id, layout);
    return { ok: true };
  });
  r.delete('/api/home/layout', (ctx) => {
    core.home.resetProfile(ctx.profile.id);
    return { ok: true };
  });

  r.get('/api/web-apps/:id/image', async (ctx) => {
    const file = core.webApps.pictureFor(ctx.params.id, ctx.viewer);
    if (!file || !(await sendFile(ctx.req, ctx.res, file, { cacheControl: 'private, max-age=86400' }))) throw new HttpError(404, 'No image');
  });

  // ---- Search ----
  r.get('/api/search', (ctx) => {
    const q = String(ctx.query.q || '').trim();
    if (q.length < 2) return { movies: [], shows: [], episodes: [], artists: [], albums: [], tracks: [], podcasts: [], audiobooks: [], books: [], comics: [] };
    const viewer = ctx.viewer;
    const find = (kind, limit) => library.withProgress(library.list({ viewer, kind, search: q, sort: 'title', limit }), viewer);
    const types = new Map(db.all('SELECT id, type FROM libraries').map((l) => [l.id, l.type]));
    const series = find('series', 30);
    const vis = library.visibility(viewer);
    ensureSearchKeys(db);
    const m = keyMatch('i.search_key', q); // v0.24: accents, punctuation and a leading "the" ignored
    const episodes = db.all(
      `SELECT i.*, s.title AS show_title, s.backdrop AS show_backdrop, s.poster AS show_poster, s.logo AS show_logo, s.metadata_at AS show_meta
       FROM items i JOIN items s ON s.id = i.show_id
       WHERE i.kind = 'episode' AND ${m.sql} AND ${vis.sql} ORDER BY s.sort_title, i.season, i.episode LIMIT 30`,
      ...m.params,
      ...vis.params,
    );
    return {
      movies: find('movie', 60),
      shows: find('show', 60),
      episodes: library.withProgress(episodes, viewer),
      artists: find('artist', 30),
      albums: find('album', 60),
      tracks: library.withProgress(library.tracks({ viewer, search: q, sort: 'title', limit: 50 }), viewer),
      podcasts: find('podcast', 30),
      audiobooks: find('audiobook', 30),
      // v0.22: books and comics, each library's series with them
      books: [...series.filter((x) => types.get(x.libraryId) === 'books'), ...find('book', 60)],
      comics: [...series.filter((x) => types.get(x.libraryId) === 'comics'), ...find('comic', 60)],
    };
  });

  // ---- Items ----
  r.get('/api/items/:id', (ctx) => {
    const viewer = ctx.viewer;
    const row = requireItem(core, ctx.params.id, viewer);
    const item = library.withProgress([row], viewer, { full: true })[0];
    if (ctx.user?.role === 'admin' && !ctx.profile?.kids) item.lockedFields = lockedFields(row); // v0.20 Edit details
    if (item.remote) item.serverName = db.get('SELECT s.name FROM libraries l JOIN servers s ON s.id = l.server_id WHERE l.id = ?', row.library_id)?.name || null;
    const out = { item };
    if (row.kind === 'audiobook') {
      out.parts = bookParts(db, row);
      out.chapters = bookChapters(db, row);
    }
    if (row.kind === 'book') {
      // v0.22: the table of contents and the reading order's length (the chapters themselves come from /api/books).
      const m = parseJson(row.media, {}) || {};
      out.toc = m.toc || [];
      out.spineCount = (m.spine || []).length;
      // The reading order as entries of the file (what /api/books/:id/file/ serves), and where the TOC's links point from.
      out.spine = (m.spine || []).map((s) => (m.opfDir ? `${m.opfDir}/${s.href}` : s.href));
      out.opfDir = m.opfDir || '';
      if (m.language) item.language = m.language;
    }
    if (row.kind === 'comic') out.pages = (parseJson(row.media, {}) || {}).pages || []; // the entries Downloads' CBZ has
    if (row.kind === 'series') {
      // A series' books or issues the viewer may see, in number order.
      const kids = db.all("SELECT * FROM items WHERE show_id = ? AND kind IN ('book', 'comic') ORDER BY issue_sort IS NULL, issue_sort, sort_title COLLATE NOCASE", row.id).filter((r) => library.canSee(viewer, r));
      out.books = library.withProgress(kids, viewer);
    }
    if (row.kind === 'podcast' && core.podcasts) {
      out.episodes = core.podcasts.episodesFor(row.id, viewer);
      if (ctx.user?.role === 'admin' && !ctx.profile?.kids) out.feed = core.podcasts.feedStatus(row.id); // admin data
    }
    if (row.show_id) {
      const show = library.get(row.show_id);
      out.show = serializeItem(show, { full: false });
    }
    if (row.kind === 'show') {
      const seasons = library.list({ viewer, parentId: row.id, kind: 'season', sort: 'title' });
      out.seasons = library.withProgress(seasons, viewer);
      const next = library.nextUpFor(viewer, row.id)
        || db.get(`SELECT * FROM items WHERE show_id = ? AND kind = 'episode' ORDER BY season = 0, season, episode LIMIT 1`, row.id);
      if (next) out.nextEpisode = library.withProgress([next], viewer)[0];
      const counts = db.get(`SELECT COUNT(*) AS n FROM items WHERE show_id = ? AND kind = 'episode'`, row.id);
      item.episodeCount = counts.n;
    }
    if (row.kind === 'season') {
      const eps = library.list({ viewer, parentId: row.id, kind: 'episode', sort: 'episode' });
      out.episodes = library.withProgress(eps, viewer);
    }
    if (row.kind === 'album') {
      out.tracks = library.withProgress(library.tracks({ viewer, albumId: row.id }), viewer);
      const artist = library.get(row.parent_id);
      if (artist) out.artist = serializeItem(artist);
      item.duration = out.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
      item.childCount = out.tracks.length;
    }
    if (row.kind === 'artist') {
      out.albums = library.withProgress(library.list({ viewer, parentId: row.id, kind: 'album', sort: 'year' }), viewer);
      out.tracks = library.withProgress(library.tracks({ viewer, artistId: row.id, limit: 2000 }), viewer);
      item.childCount = out.albums.length;
      item.duration = out.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    }
    if (row.kind === 'track') {
      const album = library.get(row.parent_id);
      if (album) {
        out.album = serializeItem(album);
        item.albumTitle = album.title;
        item.albumPoster = out.album.poster;
        if (!item.poster) item.poster = out.album.poster;
      }
      const artist = row.show_id ? library.get(row.show_id) : null;
      if (artist) out.artist = serializeItem(artist);
    }
    if (row.kind === 'movie' || row.kind === 'episode') {
      out.subtitles = listSubtitles(row, config);
      // Admins can see (and fix) where the intro is; the Skip button itself comes with playback.
      if (row.kind === 'episode' && ctx.user.role === 'admin' && !ctx.profile?.kids) out.markers = core.extras.markers(row.id);
      if (row.kind === 'episode') {
        const next = library.nextEpisode(row);
        if (next) out.nextEpisode = library.withProgress([next], viewer)[0];
        const season = library.get(row.parent_id);
        if (season) out.season = serializeItem(season);
      }
    }
    if (row.kind === 'movie' || row.kind === 'show') {
      out.collection = core.collections.forItem(row.id, viewer);
      // "Part of": the film you're on is marked, so its card isn't a link to this page.
      if (out.collection) out.collection.items = out.collection.items.map((i) => ({ ...i, isCurrent: i.id === row.id }));
      const c = core.lists.contains(viewer.profileId, row.id);
      out.inWatchlist = c.watchlist;
      out.inLists = c.lists;
      out.similar = core.picks.similar(row.id, viewer);
      out.extras = library.withProgress(library.extrasOf(row.id, viewer), viewer);
      out.trailer = trailerFor(row, ctx);
    }
    if (row.kind === 'extra') {
      const parent = library.get(row.parent_id);
      out.parent = parent ? { id: parent.id, title: parent.title, kind: parent.kind } : null;
    }
    return out;
  });

  // Lyrics are found when first asked for (a .lrc beside the song, its tags, then LRCLIB); 204 when there are none.
  r.get('/api/items/:id/lyrics', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (row.kind !== 'track') throw new HttpError(404, 'Only songs have lyrics');
    const r = await core.lyrics.get(row);
    return r || undefined;
  });

  r.get('/api/items/:id/children', (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const kind = row.kind === 'show' ? 'season' : 'episode';
    const rows = library.list({ viewer: ctx.viewer, parentId: row.id, kind, sort: kind === 'season' ? 'title' : 'episode' });
    return library.withProgress(rows, ctx.viewer);
  });

  r.get('/api/items/:id/image/:type', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const type = ctx.params.type;
    if (!['poster', 'backdrop', 'logo'].includes(type)) throw new HttpError(404, 'No such image');
    await sendArtwork(core, ctx, row, type);
  }, { cast: 'image' });

  // Direct play: the original file, with range requests.
  const proxyRemote = (ctx, row) => proxyRemoteFile(core, ctx, row);

  r.get('/api/items/:id/file', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (!row.path || !(['movie', 'episode', 'extra'].includes(row.kind) || AUDIO_KINDS.has(row.kind))) throw new HttpError(400, 'Not a playable item');
    if (isRemotePath(row.path)) return proxyRemote(ctx, row);
    const type = mimeFor(row.path);
    const ok = await sendFile(ctx.req, ctx.res, row.path, { cacheControl: 'private, no-cache', contentType: type });
    if (!ok) throw new HttpError(404, 'The file is missing on the server — try rescanning the library.');
  }, { cast: 'file' });

  // Saving a copy of the file is for grown-up profiles only (Kids profiles can still watch).
  r.get(
    '/api/items/:id/download',
    async (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (!row.path || !(['movie', 'episode'].includes(row.kind) || AUDIO_KINDS.has(row.kind))) throw new HttpError(400, 'Not a playable item');
      if (isRemotePath(row.path)) throw new HttpError(400, 'Downloads come from the server that holds the file.');
      ctx.res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(row.path))}`);
      const ok = await sendFile(ctx.req, ctx.res, row.path, { cacheControl: 'private, no-cache', contentType: 'application/octet-stream' });
      if (!ok) throw new HttpError(404, 'File missing');
    },
    { adult: true },
  );

  r.get('/api/items/:id/subtitles', (ctx) => listSubtitles(requireItem(core, ctx.params.id, ctx.viewer), config));

  // Online subtitle search, provided by plugins (e.g. OpenSubtitles).
  // Registered before /subtitles/:sub so "search" isn't taken for a subtitle id.
  r.get('/api/items/:id/subtitles/search', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (!['movie', 'episode'].includes(row.kind)) throw new HttpError(400, 'Only movies and episodes have subtitles.');
    const languages = String(ctx.query.languages || '').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2,3}(-[a-z]{2})?$/.test(l));
    const providers = plugins.subtitleProviders();
    const results = [];
    const errors = [];
    await Promise.all(
      providers.map(async (p) => {
        try {
          const found = (await p.search(row, { languages, viewer: ctx.viewer, show: row.show_id ? library.get(row.show_id) : null })) || [];
          for (const f of found) {
            results.push({
              provider: p.key,
              providerName: p.name || p.id,
              id: String(f.id),
              language: f.language || null,
              label: f.label || f.release || null,
              downloads: Number(f.downloads) || 0,
              hearingImpaired: Boolean(f.hearingImpaired),
              hashMatch: Boolean(f.hashMatch),
            });
          }
        } catch (err) {
          errors.push({ provider: p.key, error: err.message });
        }
      }),
    );
    results.sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.downloads - a.downloads);
    if (!results.length && errors.length && errors.length === providers.length) throw new HttpError(errors[0].error.includes('quota') ? 429 : 502, errors[0].error);
    return { providers: providers.map((p) => ({ id: p.key, name: p.name || p.id })), results, errors };
  });

  r.post('/api/items/:id/subtitles/download', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const body = await ctx.body();
    const provider = plugins.subtitleProviders().find((p) => p.key === body.provider);
    if (!provider) throw new HttpError(404, 'That subtitle provider is not available (is the plugin enabled?)');
    const got = await provider.download(row, String(body.id || ''), { viewer: ctx.viewer, show: row.show_id ? library.get(row.show_id) : null });
    if (!got?.content) throw new HttpError(502, 'The provider sent back an empty subtitle.');
    const subtitle = saveDownloaded(config, row, { ...got, provider: provider.key });
    core.cast?.manager?.subtitlesChanged(row.id); // a live cast of this title can pick it
    return { subtitle, subtitles: listSubtitles(row, config) };
  });

  r.delete(
    '/api/items/:id/subtitles/:sub',
    (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (!/^d\d+$/.test(ctx.params.sub)) throw new HttpError(400, 'Only downloaded subtitles can be removed.');
      if (!deleteDownloaded(config, row, ctx.params.sub)) throw new HttpError(404, 'Subtitle not found');
      core.cast?.manager?.subtitlesChanged(row.id);
      return { ok: true, subtitles: listSubtitles(row, config) };
    },
    { auth: 'admin' },
  );

  r.get('/api/items/:id/subtitles/:sub', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const subId = ctx.params.sub.replace(/\.vtt$/, '');
    if (!/^[sed]\d+$/.test(subId)) throw new HttpError(400, 'Bad subtitle id');
    const vtt = await getSubtitleVtt(row, subId, config, isRemotePath(row.path) ? await resolveSource({ db, providers: core.remote.providers }, row) : null, { slot: () => core.playback.extractionSlot() });
    if (vtt == null) throw new HttpError(404, 'Subtitle not found');
    // ?delay=s (v0.21): a cast's subtitle delay, the cues moved as the browser player moves them.
    const delay = Math.max(-10, Math.min(10, Number(ctx.query.delay) || 0));
    ctx.res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
    ctx.res.end(delay ? shiftVtt(vtt, delay) : vtt);
  }, { cast: 'subtitle' });

  r.post('/api/items/:id/watched', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const body = await ctx.body();
    const n = library.setWatched(ctx.viewer.profileId, row, body.watched !== false);
    return { ok: true, updated: n };
  });

  // The player's audio and subtitle delay for this profile and title (films and episodes).
  const delayable = (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (!['movie', 'episode'].includes(row.kind)) throw new HttpError(400, 'Delays are for films and episodes.');
    return row;
  };
  r.get('/api/items/:id/play-settings', (ctx) => core.playSettings.get(ctx.viewer.profileId, delayable(ctx).id));
  r.put('/api/items/:id/play-settings', async (ctx) => {
    const row = delayable(ctx);
    const b = await ctx.body();
    return core.playSettings.set(ctx.viewer.profileId, row.id, { audioDelay: b.audioDelay, subtitleDelay: b.subtitleDelay });
  });

  // Stars and hearts (any profile that can see the title). Fields left out keep their value; stars: null clears.
  r.put('/api/items/:id/rating', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (!ctx.profile) throw new HttpError(403, 'Choose a profile first.');
    const body = await ctx.body();
    return core.ratings.set(ctx.profile.id, row, { stars: body.stars, favourite: body.favourite });
  });

  r.post('/api/items/:id/progress', async (ctx) => {
    // Live TV and catch-up keep no history: the player's reports only keep the session alive.
    if (/^(live|catchup):/.test(String(ctx.params.id))) {
      const body = await ctx.body();
      if (body.sessionId) core.playback.heartbeat(String(body.sessionId), ctx.user, body);
      return { ok: true };
    }
    let row = requireItem(core, ctx.params.id, ctx.viewer);
    const body = await ctx.body();
    if (body.sessionId) core.playback.heartbeat(body.sessionId, ctx.user, body);
    let { position, duration } = body;
    ({ row, position, duration } = placeOnBook(db, library, row, position, duration)); // a book's part: the book's place
    // v0.22: a book or comic also says where (locator), on what (device), pages turned, and whether it was finished.
    const reading = { locator: body.locator, device: body.device, watched: body.watched === true, pages: body.pages };
    return recordProgress(core, { user: ctx.user, viewer: ctx.viewer, item: row, position, duration, sessionId: body.sessionId ? String(body.sessionId) : null, paused: body.paused === true, ...reading });
  });

  // ---- Metadata fixes (admin) ----
  r.post(
    '/api/items/:id/refresh',
    async (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (isRemotePath(row.path)) throw new HttpError(400, 'This title comes from a connected server; its details live there.');
      let updated = await metadata.refresh(row, { force: true });
      if (row.kind === 'show' || row.kind === 'season') {
        const kids = db.all(`SELECT * FROM items WHERE ${row.kind === 'show' ? 'show_id' : 'parent_id'} = ? AND kind IN ('season', 'episode') ORDER BY season, episode`, row.id);
        for (const k of kids) await metadata.refresh(k, { force: true });
        updated = library.get(row.id);
      }
      return serializeItem(updated, { full: true });
    },
    { auth: 'admin' },
  );

  r.get(
    '/api/items/:id/identify',
    async (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (isRemotePath(row.path)) throw new HttpError(400, 'This title comes from a connected server; its details live there.');
      if (!['movie', 'show'].includes(row.kind)) throw new HttpError(400, 'Only movies and shows can be identified.');
      if (!metadata.tmdb.enabled()) throw new HttpError(400, 'Add a TMDB API key in Settings → Server → Metadata first.');
      const query = String(ctx.query.query || row.title);
      const year = ctx.query.year ? Number(ctx.query.year) : null;
      return metadata.tmdb.search(row.kind === 'movie' ? 'movie' : 'tv', query, year);
    },
    { auth: 'admin' },
  );

  r.post(
    '/api/items/:id/identify',
    async (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (isRemotePath(row.path)) throw new HttpError(400, 'This title comes from a connected server; its details live there.');
      const body = await ctx.body();
      const tmdbId = Number(body.tmdbId);
      if (!tmdbId) throw new HttpError(400, 'Pick a match');
      let updated = await metadata.refresh(row, { force: true, tmdbId, clear: true });
      if (row.kind === 'show') {
        const kids = db.all(`SELECT * FROM items WHERE show_id = ? AND kind IN ('season', 'episode') ORDER BY season, episode`, row.id);
        for (const k of kids) await metadata.refresh(k, { force: true, clear: true });
        updated = library.get(row.id);
      }
      return serializeItem(updated, { full: true });
    },
    { auth: 'admin' },
  );

  // ---- Edit details (v0.20, admins on a grown-up profile; admin routes are closed to Kids) ----
  const editable = (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (isRemotePath(row.path)) throw new HttpError(400, 'This title comes from a connected server; its details live there.');
    if (!EDITABLE[row.kind]) throw new HttpError(400, "This title's details can't be edited.");
    return row;
  };
  const fullItem = (ctx, row) => ({ ...library.withProgress([row], ctx.viewer, { full: true })[0], lockedFields: lockedFields(row) });
  r.get(
    '/api/items/:id/details',
    (ctx) => {
      const row = editable(ctx);
      return { kind: row.kind, fields: EDITABLE[row.kind], values: detailValues(row, db), locked: lockedFields(row) };
    },
    { auth: 'admin' },
  );
  // Artwork: TMDB's choices, a preview of one, and setting a picture (from TMDB, an address, or uploaded bytes).
  const artworkType = (ctx) => {
    if (!ARTWORK_TYPES.includes(ctx.params.type)) throw new HttpError(404, 'Pictures are a poster, a background or a logo.');
    return ctx.params.type;
  };
  r.get('/api/items/:id/artwork', async (ctx) => artworkOptions(core, editable(ctx)), { auth: 'admin' });
  r.get(
    '/api/items/:id/artwork/preview',
    async (ctx) => {
      editable(ctx);
      const p = String(ctx.query.path || '');
      if (!isTmdbPath(p)) throw new HttpError(400, 'Not one of the pictures shown.');
      const ref = await previewRef(core, p);
      const file = ref && core.images.resolve(ref)?.file;
      if (!file || !(await sendFile(ctx.req, ctx.res, file, { cacheControl: 'private, max-age=604800' }))) throw new HttpError(404, 'No image');
    },
    { auth: 'admin' },
  );
  r.put(
    '/api/items/:id/artwork/:type',
    async (ctx) => {
      const row = editable(ctx);
      const type = artworkType(ctx);
      const body = await ctx.body();
      return fullItem(ctx, await setArtwork(core, row, type, { tmdbPath: body.tmdbPath ?? undefined, url: body.tmdbPath == null ? body.url : undefined }));
    },
    { auth: 'admin' },
  );
  r.post(
    '/api/items/:id/artwork/:type',
    async (ctx) => {
      const row = editable(ctx);
      const type = artworkType(ctx);
      if (!String(ctx.req.headers['content-type'] || '').startsWith('application/octet-stream')) throw new HttpError(415, 'Send the picture itself.');
      if (Number(ctx.req.headers['content-length']) > UPLOAD_MAX) throw new HttpError(413, 'Pictures can be 10 MB at most.');
      const buffer = await readBody(ctx.req, UPLOAD_MAX, { timeoutMs: 60000 }).catch((err) => {
        throw err.status === 413 ? new HttpError(413, 'Pictures can be 10 MB at most.') : err;
      });
      return fullItem(ctx, await setArtwork(core, row, type, { buffer }));
    },
    { auth: 'admin', body: 'binary' },
  );
  r.patch(
    '/api/items/:id/details',
    async (ctx) => {
      const row = editable(ctx);
      const body = await ctx.body();
      const unlock = Array.isArray(body.unlock) ? body.unlock.map(String) : [];
      return fullItem(ctx, await editDetails(core, row, body.changes && typeof body.changes === 'object' ? body.changes : {}, { unlock, clearScores: body.clearScores === true }));
    },
    { auth: 'admin' },
  );
}
