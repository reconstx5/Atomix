// Browsing for Jellyfin apps (Infuse): the viewer's film and TV libraries (Views), items in a library, a show or a
// season (paged, sorted, filtered), one item, a show's seasons and episodes, Resume, Next Up and Latest.
//
// Every read goes through the viewer: library.visibility() in SQL for lists, library.canSee() for one row, so a Kids
// profile's age limit and a profile's library access hold everywhere. A hidden title is 404 and absent from every
// list. Only film and TV libraries are seen through this API. The viewer's own numbers (progress, plays, heart) come
// in three queries per page, never one per row.
import { HttpError } from './index.js';
import { itemDto, libraryDto } from './shapes.js';
import { listSubtitles } from '../stream/subtitles.js';
import { fromGuid } from './ids.js';
import { ensureSearchKeys, keyMatch } from '../library/searchkey.js';

const MAX = 5000; // the most one page answers (Infuse pages with StartIndex/Limit)
const VIDEO_LIBRARIES = new Set(['movies', 'tv']);
const VIDEO_KINDS = ['movie', 'show', 'season', 'episode'];
const TOP_KINDS = ['movie', 'show'];
const KIND_OF = { movie: 'movie', series: 'show', season: 'season', episode: 'episode' };
const BY_EPISODE = 'COALESCE(i.season, 0), COALESCE(i.episode, 0), i.id';

// Jellyfin's SortName for seasons and episodes is their number, so a season's episodes come in order.
const SORT_NAME = "(CASE WHEN i.kind IN ('season','episode') THEN printf('%06d%06d', COALESCE(i.season, 0), COALESCE(i.episode, 0)) ELSE COALESCE(i.sort_title, i.title) END) COLLATE NOCASE";
const SORTS = {
  sortname: SORT_NAME,
  datecreated: 'i.added_at',
  premieredate: 'COALESCE(i.air_date, CAST(i.year AS TEXT))',
  productionyear: 'i.year',
  communityrating: 'i.rating',
  dateplayed: 'pp.updated_at',
  random: 'RANDOM()',
};

// The viewer's progress row is `pp`, their rating row `ur` (joined in select()); `?` is the profile id.
const UNWATCHED_EPISODE = `EXISTS (SELECT 1 FROM items e LEFT JOIN progress pe ON pe.item_id = e.id AND pe.profile_id = ?
  WHERE e.kind = 'episode' AND (e.show_id = i.id OR e.parent_id = i.id) AND COALESCE(pe.watched, 0) = 0)`;
const FILTERS = {
  isplayed: { sql: `((i.kind IN ('movie','episode') AND COALESCE(pp.watched, 0) = 1) OR (i.kind IN ('show','season') AND NOT ${UNWATCHED_EPISODE}))`, pid: true },
  isunplayed: { sql: `((i.kind IN ('movie','episode') AND COALESCE(pp.watched, 0) = 0) OR (i.kind IN ('show','season') AND ${UNWATCHED_EPISODE}))`, pid: true },
  isresumable: { sql: "(i.kind IN ('movie','episode') AND COALESCE(pp.watched, 0) = 0 AND COALESCE(pp.position, 0) > 30)" },
  isfavorite: { sql: 'COALESCE(ur.favourite, 0) = 1' },
};

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const isTrue = (s) => String(s).toLowerCase() === 'true';

function paging(q) {
  const start = Math.max(0, parseInt(q.startindex, 10) || 0);
  const limit = parseInt(q.limit, 10);
  return { start, limit: limit > 0 ? Math.min(limit, MAX) : MAX };
}

/** The kinds IncludeItemTypes names (null when it is absent; an empty array when it names nothing we have). */
function includedKinds(q) {
  if (!q.includeitemtypes) return null;
  return [...new Set(list(q.includeitemtypes).map((t) => KIND_OF[t.toLowerCase()]).filter(Boolean))];
}

/** A `{userId}` in the path must be the token's own profile. */
export function ownUser(ctx) {
  if (ctx.params.userId == null) return;
  const id = fromGuid(ctx.params.userId);
  if (!id || id.kind !== 'user' || id.id !== ctx.profile.id) throw new HttpError(404);
}

/** The viewer's film and TV libraries. */
function videoLibraries(ctx) {
  return ctx.core.library.visibleLibraries(ctx.viewer).filter((l) => VIDEO_LIBRARIES.has(l.type));
}

/** The row a Jellyfin item id names, when the viewer may see it; otherwise 404. (Tasks 5–8 use this too.) */
export function ensureVisible(ctx, guid) {
  const id = fromGuid(guid);
  if (!id || id.kind !== 'item') throw new HttpError(404);
  const row = ctx.core.library.get(id.id);
  if (!row || !ctx.core.library.canSee(ctx.viewer, row)) throw new HttpError(404);
  return row;
}

/**
 * Film and TV rows the viewer may see, matching `where` (SQL on `i`, the show `sh`, the viewer's progress `pp` and
 * rating `ur`), with each show's and season's episode counts. The page and its total come through the same WHERE.
 */
function select(ctx, { where = [], params = [], order = SORT_NAME, start = 0, limit = MAX, count = true } = {}) {
  const { db, library } = ctx.core;
  const pid = ctx.viewer.profileId || 0;
  const libs = videoLibraries(ctx).map((l) => l.id);
  if (!libs.length) return { rows: [], total: 0 };
  const vis = library.visibility(ctx.viewer);
  const conds = [vis.sql, `i.library_id IN (${libs.map(() => '?').join(',')})`, `i.kind IN (${VIDEO_KINDS.map(() => '?').join(',')})`, ...where];
  const condParams = [...vis.params, ...libs, ...VIDEO_KINDS, ...params];
  const from = `FROM items i LEFT JOIN items sh ON sh.id = i.show_id
    LEFT JOIN progress pp ON pp.item_id = i.id AND pp.profile_id = ?
    LEFT JOIN user_ratings ur ON ur.item_id = i.id AND ur.profile_id = ?
    WHERE ${conds.map((c) => `(${c})`).join(' AND ')}`;
  const rows = db.all(
    `SELECT i.*, sh.title AS show_title ${library.countColumns()} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    pid, pid, pid, ...condParams, limit, start,
  );
  const total = count ? db.get(`SELECT COUNT(*) AS n ${from}`, pid, pid, ...condParams).n : rows.length;
  return { rows, total };
}

/** Rows -> Jellyfin items, with the viewer's progress, plays and heart fetched once for the whole page. */
function dtos(ctx, rows, { withSubtitles = false } = {}) {
  const { library, ratings } = ctx.core;
  const pid = ctx.viewer.profileId || 0;
  const ids = rows.map((r) => r.id);
  const progress = library.progressFor(pid, ids);
  const stats = library.statsFor(pid, ids);
  const rated = ratings.get(pid, ids);
  return rows.map((r) => itemDto(r, {
    serverId: ctx.serverId,
    progress: progress.get(r.id) || null,
    stats: stats.get(r.id) || {},
    rating: rated.get(r.id) || null,
    counts: ['show', 'season'].includes(r.kind) ? { children: r.child_count ?? 0, unplayed: r.unwatched_count ?? 0 } : {},
    fields: ctx.query.fields,
    kids: Boolean(ctx.profile?.kids),
    // Sidecar files are read from the disk, so only a single item (not a list page) lists them.
    subtitles: withSubtitles ? listSubtitles(r, ctx.core.config) : [],
  }));
}

const paged = (ctx, rows, total, start = 0) => ({ Items: dtos(ctx, rows), TotalRecordCount: total, StartIndex: start });

function orderOf(q, fallback = SORT_NAME) {
  const by = list(q.sortby).map((s) => s.toLowerCase()).filter((s) => SORTS[s]);
  if (!by.length) return `${fallback}, i.id`;
  const orders = list(q.sortorder).map((s) => (s.toLowerCase().startsWith('desc') ? 'DESC' : 'ASC'));
  const parts = by.map((s, n) => `${SORTS[s]} ${orders[n] || orders[0] || 'ASC'}`);
  return `${parts.join(', ')}, ${SORT_NAME}, i.id`;
}

/** GET /Items: what ParentId, Recursive, IncludeItemTypes and the filters ask for, paged. */
function items(ctx) {
  const q = ctx.query;
  const pid = ctx.viewer.profileId || 0;
  const where = [];
  const params = [];
  const recursive = isTrue(q.recursive);
  let kinds = includedKinds(q);
  const wide = recursive || Boolean(q.ids) || Boolean(q.searchterm);

  if (q.parentid) {
    const parent = fromGuid(q.parentid);
    if (parent?.kind === 'library') {
      if (!videoLibraries(ctx).some((l) => l.id === parent.id)) throw new HttpError(404);
      where.push('i.library_id = ?');
      params.push(parent.id);
      kinds ||= wide ? VIDEO_KINDS : TOP_KINDS;
    } else {
      const row = ensureVisible(ctx, q.parentid);
      if (row.kind === 'show' && recursive) {
        where.push('i.show_id = ?');
        params.push(row.id);
        kinds ||= ['season', 'episode'];
      } else if (row.kind === 'show') {
        where.push('i.parent_id = ?');
        params.push(row.id);
        kinds = (kinds || ['season']).filter((k) => k === 'season');
      } else if (row.kind === 'season') {
        where.push('i.parent_id = ?');
        params.push(row.id);
        kinds = (kinds || ['episode']).filter((k) => k === 'episode');
      } else {
        kinds = []; // a film or an episode has no children here
      }
    }
  } else {
    kinds ||= wide ? VIDEO_KINDS : TOP_KINDS;
  }
  if (!kinds.length) return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
  where.push(`i.kind IN (${kinds.map(() => '?').join(',')})`);
  params.push(...kinds);

  if (q.ids) {
    const wanted = list(q.ids).map(fromGuid).filter((x) => x?.kind === 'item').map((x) => x.id);
    if (!wanted.length) where.push('0');
    else {
      where.push(`i.id IN (${wanted.map(() => '?').join(',')})`);
      params.push(...wanted);
    }
  }
  if (q.searchterm) {
    ensureSearchKeys(ctx.core.db);
    const m = keyMatch('i.search_key', q.searchterm);
    where.push(m.sql);
    params.push(...m.params);
  }
  const filters = list(q.filters).map((f) => f.toLowerCase());
  if (q.isfavorite != null) filters.push(isTrue(q.isfavorite) ? 'isfavorite' : 'notfavorite');
  for (const f of filters) {
    if (f === 'notfavorite') where.push('COALESCE(ur.favourite, 0) = 0');
    const known = FILTERS[f];
    if (!known) continue;
    where.push(known.sql);
    if (known.pid) params.push(pid);
  }
  const since = (s) => {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  };
  if (q.mindatelastsaved && since(q.mindatelastsaved) != null) {
    where.push('i.updated_at >= ?');
    params.push(since(q.mindatelastsaved));
  }
  if (q.mindatelastsavedforuser && since(q.mindatelastsavedforuser) != null) {
    const ms = since(q.mindatelastsavedforuser);
    where.push('(pp.updated_at >= ? OR ur.updated_at >= ?)');
    params.push(ms, ms);
  }

  const { start, limit } = paging(q);
  const { rows, total } = select(ctx, { where, params, order: orderOf(q), start, limit });
  return paged(ctx, rows, total, start);
}

/** One item by id: a film, show, season or episode the viewer may see, or one of their film/TV libraries. */
function oneItem(ctx) {
  const id = fromGuid(ctx.params.itemId);
  if (id?.kind === 'library') {
    const lib = videoLibraries(ctx).find((l) => l.id === id.id);
    if (!lib) throw new HttpError(404);
    return libraryDto(lib, ctx.serverId);
  }
  const row = ensureVisible(ctx, ctx.params.itemId);
  const { rows } = select(ctx, { where: ['i.id = ?'], params: [row.id], limit: 1, count: false });
  if (!rows.length) throw new HttpError(404); // not a film/TV title
  return dtos(ctx, rows, { withSubtitles: true })[0];
}

/** One visible film or TV row as a Jellyfin item (404 for anything else); the played and heart writes answer its UserData. */
export function dtoOf(ctx, row) {
  const { rows } = select(ctx, { where: ['i.id = ?'], params: [row.id], limit: 1, count: false });
  if (!rows.length) throw new HttpError(404);
  return dtos(ctx, rows)[0];
}

function showOf(ctx) {
  const show = ensureVisible(ctx, ctx.params.seriesId);
  if (show.kind !== 'show') throw new HttpError(404);
  return show;
}

/** Rows from Atomix's own lists, kept to the viewer's film and TV libraries (and one library, when asked). */
function inLibraries(ctx, rows, libraryId = null) {
  const libs = new Set(videoLibraries(ctx).map((l) => l.id));
  return rows.filter((r) => libs.has(r.library_id) && (libraryId == null || r.library_id === libraryId));
}

/** ParentId on Resume/Latest: a film/TV library the viewer has (404 otherwise), or null. */
function parentLibrary(ctx) {
  if (!ctx.query.parentid) return null;
  const id = fromGuid(ctx.query.parentid);
  const lib = id?.kind === 'library' && videoLibraries(ctx).find((l) => l.id === id.id);
  if (!lib) throw new HttpError(404);
  return lib;
}

function latest(ctx) {
  const q = ctx.query;
  const { db, library } = ctx.core;
  const viewer = ctx.viewer;
  const lib = parentLibrary(ctx);
  const limit = Math.min(parseInt(q.limit, 10) > 0 ? parseInt(q.limit, 10) : 20, 100);
  const kinds = includedKinds(q);
  const libs = lib ? [lib] : videoLibraries(ctx);
  const group = q.groupitems == null || isTrue(q.groupitems);
  const entries = [];
  if (libs.some((l) => l.type === 'movies') && (!kinds || kinds.includes('movie'))) {
    for (const r of inLibraries(ctx, library.recentlyAdded({ viewer, kind: 'movie', libraryId: lib?.id, limit }), lib?.id)) entries.push({ row: r, at: r.added_at });
  }
  if (libs.some((l) => l.type === 'tv') && (!kinds || kinds.includes('show') || kinds.includes('episode'))) {
    if (group) {
      // Episodes grouped to their show (Jellyfin's GroupItems=true): shows by their newest visible episode.
      const vis = library.visibility(viewer);
      const libIds = libs.filter((l) => l.type === 'tv').map((l) => l.id);
      const newest = db.all(
        `SELECT i.show_id AS id, MAX(i.added_at) AS at FROM items i
         WHERE i.kind = 'episode' AND i.show_id IS NOT NULL AND i.library_id IN (${libIds.map(() => '?').join(',')}) AND ${vis.sql}
         GROUP BY i.show_id ORDER BY at DESC LIMIT ?`,
        ...libIds, ...vis.params, limit,
      );
      const at = new Map(newest.map((n) => [n.id, n.at]));
      if (newest.length) {
        const { rows } = select(ctx, { where: [`i.kind = 'show'`, `i.id IN (${newest.map(() => '?').join(',')})`], params: newest.map((n) => n.id), count: false });
        for (const r of rows) entries.push({ row: r, at: at.get(r.id) });
      }
    } else {
      for (const r of inLibraries(ctx, library.recentlyAdded({ viewer, kind: 'episode', libraryId: lib?.id, limit }), lib?.id)) entries.push({ row: r, at: r.added_at });
    }
  }
  entries.sort((a, b) => b.at - a.at);
  return dtos(ctx, entries.slice(0, limit).map((e) => e.row));
}

export function registerBrowse(j) {
  const both = (pattern, fn) => {
    j.route('GET', pattern, fn);
    j.route('GET', `/Users/{userId}${pattern}`, (ctx) => (ownUser(ctx), fn(ctx)));
  };

  const views = (ctx) => {
    const libs = videoLibraries(ctx);
    return { Items: libs.map((l) => libraryDto(l, ctx.serverId)), TotalRecordCount: libs.length, StartIndex: 0 };
  };
  j.route('GET', '/UserViews', views);
  j.route('GET', '/Users/{userId}/Views', (ctx) => (ownUser(ctx), views(ctx)));

  both('/Items', items);
  both('/Items/{itemId}', oneItem);

  const resume = (ctx) => {
    const lib = parentLibrary(ctx);
    const { start, limit } = paging(ctx.query);
    const rows = inLibraries(ctx, ctx.core.library.continueWatching(ctx.viewer, MAX), lib?.id);
    return paged(ctx, rows.slice(start, start + limit), rows.length, start);
  };
  j.route('GET', '/UserItems/Resume', resume);
  j.route('GET', '/Users/{userId}/Items/Resume', (ctx) => (ownUser(ctx), resume(ctx)));

  both('/Items/Latest', latest);

  j.route('GET', '/Shows/NextUp', (ctx) => {
    const q = ctx.query;
    const { library } = ctx.core;
    const { start, limit } = paging(q);
    let rows;
    if (q.seriesid) {
      const id = fromGuid(q.seriesid);
      const next = id?.kind === 'item' ? library.nextUpFor(ctx.viewer, id.id) : null;
      rows = next ? [next] : [];
    } else {
      rows = library.nextUp(ctx.viewer, 100); // one query per started show, so at most 100 shows
    }
    // nextUp/nextUpFor check the show and the watched episodes, not the next one: each (at most 100) is checked here.
    rows = inLibraries(ctx, rows).filter((r) => library.canSee(ctx.viewer, r));
    return paged(ctx, rows.slice(start, start + limit), rows.length, start);
  });

  j.route('GET', '/Shows/{seriesId}/Seasons', (ctx) => {
    const show = showOf(ctx);
    const { start, limit } = paging(ctx.query);
    const { rows, total } = select(ctx, { where: [`i.kind = 'season'`, 'i.parent_id = ?'], params: [show.id], order: BY_EPISODE, start, limit });
    return paged(ctx, rows, total, start);
  });

  j.route('GET', '/Shows/{seriesId}/Episodes', (ctx) => {
    const show = showOf(ctx);
    const q = ctx.query;
    const where = [`i.kind = 'episode'`, 'i.show_id = ?'];
    const params = [show.id];
    if (q.seasonid) {
      const season = fromGuid(q.seasonid);
      if (season?.kind !== 'item') throw new HttpError(404);
      where.push('i.parent_id = ?');
      params.push(season.id);
    } else if (q.season != null && q.season !== '' && Number.isInteger(Number(q.season))) {
      where.push('i.season = ?');
      params.push(Number(q.season));
    }
    const { start, limit } = paging(q);
    const { rows, total } = select(ctx, { where, params, order: BY_EPISODE, start, limit });
    return paged(ctx, rows, total, start);
  });
}
