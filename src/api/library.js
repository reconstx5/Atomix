// Library browsing, item details, artwork, progress and scanning endpoints.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { sendFile, mimeFor } from '../http/static.js';
import { serializeItem, serializeLibrary } from './serialize.js';
import { listSubtitles, getSubtitleVtt, saveDownloaded, deleteDownloaded } from '../stream/subtitles.js';
import { parseJson } from '../db.js';
import { logger } from '../log.js';

const log = logger('api');

/** Load an item the current viewer is allowed to see (404 otherwise, so hidden titles stay hidden). */
function requireItem(core, id, viewer) {
  const item = core.library.get(id);
  if (!item || (viewer && !core.library.canSee(viewer, item))) throw new HttpError(404, 'Item not found');
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

async function withTimeout(promise, ms, fallback) {
  let timer;
  const t = new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  try {
    return await Promise.race([promise, t]);
  } finally {
    clearTimeout(timer);
  }
}

/** Library options an admin can set. Only known keys are kept, as booleans. */
function cleanOptions(input, current = {}) {
  const previews = input && typeof input === 'object' && 'previews' in input ? Boolean(input.previews) : current.previews;
  return { previews: previews ?? true };
}

export function registerLibraryRoutes(r, core) {
  const { db, library, scanner, metadata, config, images, plugins } = core;

  const counts = () =>
    Object.fromEntries(
      db
        .all(`SELECT library_id, COUNT(*) AS n FROM items WHERE kind IN ('movie','show','album') GROUP BY library_id`)
        .map((row) => [row.library_id, row.n]),
    );

  // ---- Libraries ----
  const visibleLibrary = (ctx, id) => {
    const lib = library.visibleLibraries(ctx.viewer).find((l) => l.id === Number(id));
    if (!lib) throw new HttpError(404, 'Library not found');
    return lib;
  };

  r.get('/api/libraries', (ctx) => {
    const c = counts();
    return library.visibleLibraries(ctx.viewer).map((l) => serializeLibrary(l, c));
  });

  r.post(
    '/api/libraries',
    async (ctx) => {
      const body = await ctx.body();
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) throw new HttpError(400, 'Give the library a name.');
      if (!['movies', 'tv', 'music'].includes(body.type)) throw new HttpError(400, 'Type must be "movies", "tv" or "music".');
      const paths = cleanPaths(body.paths);
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
      if (!lib) throw new HttpError(404, 'Library not found');
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
    const kind = lib.type === 'movies' ? 'movie' : lib.type === 'tv' ? 'show' : q.view === 'artists' ? 'artist' : 'album';
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
    });
    return { library: serializeLibrary(lib), items: library.withProgress(rows, ctx.viewer) };
  });

  r.get('/api/libraries/:id/genres', (ctx) => library.genres(visibleLibrary(ctx, ctx.params.id).id, ctx.viewer));

  // ---- Scanning ----
  r.post(
    '/api/libraries/:id/scan',
    async (ctx) => {
      const body = await ctx.body();
      const lib = db.get('SELECT id FROM libraries WHERE id = ?', Number(ctx.params.id));
      if (!lib) throw new HttpError(404, 'Library not found');
      scanner.enqueue(lib.id, { refreshMetadata: Boolean(body.refreshMetadata) }).catch((e) => log.error(e.message));
      return { queued: true };
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

  r.get('/api/scan/status', () => ({ ...scanner.status, queued: scanner.queue.filter((q) => !q.started).length }), { profile: false });

  // ---- Home ----
  r.get('/api/home', async (ctx) => {
    const viewer = ctx.viewer;
    const rows = [];
    const seen = new Set();
    const cont = [...library.continueWatching(viewer, 20), ...library.nextUp(viewer, 20)].filter((i) => {
      const key = i.kind === 'episode' ? `show:${i.show_id}` : `item:${i.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (cont.length) rows.push({ id: 'continue', title: 'Continue watching', style: 'landscape', items: library.withProgress(cont, viewer) });

    const libs = library.visibleLibraries(viewer);
    for (const lib of libs) {
      if (lib.type === 'movies') {
        const items = library.recentlyAdded({ viewer, kind: 'movie', libraryId: lib.id, limit: 24 });
        if (items.length) rows.push({ id: `recent-${lib.id}`, title: `Recently added in ${lib.name}`, style: 'poster', libraryId: lib.id, items: library.withProgress(items, viewer) });
      } else if (lib.type === 'tv') {
        const shows = library.list({ viewer, libraryId: lib.id, kind: 'show', sort: 'added', limit: 24 });
        if (shows.length) rows.push({ id: `recent-${lib.id}`, title: `Latest in ${lib.name}`, style: 'poster', libraryId: lib.id, items: library.withProgress(shows, viewer) });
      } else if (lib.type === 'music') {
        const albums = library.list({ viewer, libraryId: lib.id, kind: 'album', sort: 'added', limit: 24 });
        if (albums.length) rows.push({ id: `recent-${lib.id}`, title: `New albums in ${lib.name}`, style: 'square', libraryId: lib.id, items: library.withProgress(albums, viewer) });
      }
    }

    for (const row of plugins.homeRows) {
      try {
        const items = await withTimeout(Promise.resolve(row.items(viewer)), 5000, []);
        if (!items?.length) continue;
        // Plugins get the viewer too, but double-check nothing hidden slips through.
        const rowsFromDb = items.filter((i) => i && i.library_id !== undefined && library.canSee(viewer, i));
        const plainCards = items.filter((i) => i && i.library_id === undefined);
        if (viewer.kids && plainCards.length && !rowsFromDb.length) continue; // unrated outside content
        const cards = rowsFromDb.length ? library.withProgress(rowsFromDb, viewer) : plainCards;
        if (!cards.length) continue;
        rows.push({ id: row.key, title: row.title, style: row.style, items: cards, plugin: row.owner.replace('plugin:', '') });
      } catch (err) {
        log.warn(`Home row ${row.key} failed: ${err.message}`);
      }
    }

    // Hero: something recent with nice artwork.
    const vis = library.visibility(viewer);
    const heroRow = db.get(
      `SELECT * FROM items i WHERE i.kind IN ('movie','show') AND i.backdrop IS NOT NULL AND ${vis.sql}
       ORDER BY CASE WHEN i.added_at > ? THEN 0 ELSE 1 END, RANDOM() LIMIT 1`,
      ...vis.params,
      Date.now() - 14 * 86400 * 1000,
    ) || db.get(`SELECT * FROM items i WHERE i.kind IN ('movie','show') AND ${vis.sql} ORDER BY RANDOM() LIMIT 1`, ...vis.params);
    const hero = heroRow ? serializeItem(heroRow, { full: false, progress: library.progressFor(viewer.profileId, [heroRow.id]).get(heroRow.id) || null }) : null;
    if (hero) hero.tagline = heroRow.tagline;
    return { hero, rows, libraries: libs.map((l) => serializeLibrary(l)) };
  });

  // ---- Search ----
  r.get('/api/search', (ctx) => {
    const q = String(ctx.query.q || '').trim();
    if (q.length < 2) return { movies: [], shows: [], episodes: [], artists: [], albums: [], tracks: [] };
    const viewer = ctx.viewer;
    const find = (kind, limit) => library.withProgress(library.list({ viewer, kind, search: q, sort: 'title', limit }), viewer);
    const vis = library.visibility(viewer);
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const episodes = db.all(
      `SELECT i.*, s.title AS show_title, s.backdrop AS show_backdrop, s.poster AS show_poster, s.logo AS show_logo, s.metadata_at AS show_meta
       FROM items i JOIN items s ON s.id = i.show_id
       WHERE i.kind = 'episode' AND i.title LIKE ? ESCAPE '\\' AND ${vis.sql} ORDER BY s.sort_title, i.season, i.episode LIMIT 30`,
      like,
      ...vis.params,
    );
    return {
      movies: find('movie', 60),
      shows: find('show', 60),
      episodes: library.withProgress(episodes, viewer),
      artists: find('artist', 30),
      albums: find('album', 60),
      tracks: library.withProgress(library.tracks({ viewer, search: q, sort: 'title', limit: 50 }), viewer),
    };
  });

  // ---- Items ----
  r.get('/api/items/:id', (ctx) => {
    const viewer = ctx.viewer;
    const row = requireItem(core, ctx.params.id, viewer);
    const progress = library.progressFor(viewer.profileId, [row.id]).get(row.id) || null;
    const item = serializeItem(row, { full: true, progress });
    const out = { item };
    if (row.show_id) {
      const show = library.get(row.show_id);
      out.show = serializeItem(show, { full: false });
    }
    if (row.kind === 'show') {
      const seasons = library.list({ viewer, parentId: row.id, kind: 'season', sort: 'title' });
      out.seasons = library.withProgress(seasons, viewer);
      const next = library.nextUp(viewer, 50).find((e) => e.show_id === row.id)
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
    return out;
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
    let ref = row[type];
    // Tracks use their album's cover.
    if (!ref && row.kind === 'track' && row.parent_id) ref = library.get(row.parent_id)?.[type];
    const resolved = images.resolve(ref);
    if (!resolved) throw new HttpError(404, 'No image');
    if (resolved.url) return ctx.redirect(resolved.url);
    const ok = await sendFile(ctx.req, ctx.res, resolved.file, { cacheControl: 'private, max-age=604800' });
    if (!ok) throw new HttpError(404, 'Image missing');
  });

  // Direct play: the original file, with range requests.
  r.get('/api/items/:id/file', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    if (!row.path || !['movie', 'episode', 'track'].includes(row.kind)) throw new HttpError(400, 'Not a playable item');
    const type = mimeFor(row.path);
    const ok = await sendFile(ctx.req, ctx.res, row.path, { cacheControl: 'private, no-cache', contentType: type });
    if (!ok) throw new HttpError(404, 'The file is missing on the server — try rescanning the library.');
  });

  // Saving a copy of the file is for grown-up profiles only (Kids profiles can still watch).
  r.get(
    '/api/items/:id/download',
    async (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (!row.path || !['movie', 'episode', 'track'].includes(row.kind)) throw new HttpError(400, 'Not a playable item');
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
    return { subtitle, subtitles: listSubtitles(row, config) };
  });

  r.delete(
    '/api/items/:id/subtitles/:sub',
    (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      if (!/^d\d+$/.test(ctx.params.sub)) throw new HttpError(400, 'Only downloaded subtitles can be removed.');
      if (!deleteDownloaded(config, row, ctx.params.sub)) throw new HttpError(404, 'Subtitle not found');
      return { ok: true, subtitles: listSubtitles(row, config) };
    },
    { auth: 'admin' },
  );

  r.get('/api/items/:id/subtitles/:sub', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const subId = ctx.params.sub.replace(/\.vtt$/, '');
    if (!/^[sed]\d+$/.test(subId)) throw new HttpError(400, 'Bad subtitle id');
    const vtt = await getSubtitleVtt(row, subId, config);
    if (vtt == null) throw new HttpError(404, 'Subtitle not found');
    ctx.res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
    ctx.res.end(vtt);
  });

  r.post('/api/items/:id/watched', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const body = await ctx.body();
    const n = library.setWatched(ctx.viewer.profileId, row, body.watched !== false);
    return { ok: true, updated: n };
  });

  r.post('/api/items/:id/progress', async (ctx) => {
    const row = requireItem(core, ctx.params.id, ctx.viewer);
    const body = await ctx.body();
    if (body.sessionId) core.playback.heartbeat(body.sessionId, ctx.user, body);
    const result = library.saveProgress(ctx.viewer.profileId, row, body.position, body.duration);
    await core.hooks.emit('playback:progress', { user: ctx.user, viewer: ctx.viewer, item: row, position: Number(body.position), watched: result.watched });
    return result;
  });

  // ---- Metadata fixes (admin) ----
  r.post(
    '/api/items/:id/refresh',
    async (ctx) => {
      const row = requireItem(core, ctx.params.id, ctx.viewer);
      let updated = await metadata.refresh(row, { force: true });
      if (row.kind === 'show' || row.kind === 'season') {
        const kids = db.all(`SELECT * FROM items WHERE ${row.kind === 'show' ? 'show_id' : 'parent_id'} = ? ORDER BY season, episode`, row.id);
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
      const body = await ctx.body();
      const tmdbId = Number(body.tmdbId);
      if (!tmdbId) throw new HttpError(400, 'Pick a match');
      let updated = await metadata.refresh(row, { force: true, tmdbId, clear: true });
      if (row.kind === 'show') {
        const kids = db.all(`SELECT * FROM items WHERE show_id = ? ORDER BY season, episode`, row.id);
        for (const k of kids) await metadata.refresh(k, { force: true, clear: true });
        updated = library.get(row.id);
      }
      return serializeItem(updated, { full: true });
    },
    { auth: 'admin' },
  );
}
