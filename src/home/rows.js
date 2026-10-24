// The rows Home can show, each with a stable key (v0.22). For Home itself a row is built only when it has something
// in it; for the "Arrange home" editor every row this viewer could have is listed (empty ones too, without items).
import { logger } from '../log.js';
import { pinRow } from './pins.js';

const log = logger('home');

async function withTimeout(promise, ms, fallback) {
  let timer;
  const t = new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  try {
    return await Promise.race([promise, t]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} core
 * @param {object} ctx the request (ctx.viewer, ctx.profile)
 * @param {{editor?: boolean, pins?: object[]}} [opts] editor: list every row, without items; pins: the arrangement's pinned rows
 * @returns {Promise<{key: string, id: string, title: string, style: string, items: object[], libraryId?: number}[]>} in build order
 */
export async function homeRows(core, ctx, { editor = false, pins = [] } = {}) {
  const { library, plugins } = core;
  const viewer = ctx.viewer;
  const rows = [];
  const add = (row) => {
    if (editor) rows.push({ ...row, items: [] });
    else if (row.items.length) rows.push(row);
  };
  const lazy = (fn) => (editor ? [] : fn()); // the editor needs no items

  add({
    key: 'continue',
    id: 'continue',
    title: 'Continue watching',
    style: 'landscape',
    items: lazy(() => {
      const seen = new Set();
      const cont = [...library.continueWatching(viewer, 20), ...library.nextUp(viewer, 20)].filter((i) => {
        const key = i.kind === 'episode' ? `show:${i.show_id}` : `item:${i.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return library.withProgress(cont, viewer);
    }),
  });
  add({ key: 'continue-reading', id: 'continue-reading', title: 'Continue reading', style: 'poster', items: lazy(() => library.withProgress(library.continueReading(viewer, 20), viewer)) });
  add({ key: 'continue-listening', id: 'continue-listening', title: 'Continue listening', style: 'square', items: lazy(() => library.withProgress(library.continueListening(viewer, 20), viewer)) });
  // Live TV: what's on the viewer's channels (absent when Live TV is off for them, for the editor too).
  const onNow = core.live?.routes?.homeCards(ctx) || [];
  if (onNow.length) rows.push({ key: 'live-now', id: 'live-now', title: 'On now', style: 'landscape', items: editor ? [] : onNow });
  add({
    key: 'watchlist',
    id: 'watchlist',
    title: 'My Watchlist',
    style: 'poster',
    items: lazy(() => {
      const wl = core.lists.rows(core.lists.watchlist(viewer.profileId).id).filter((i) => library.canSee(viewer, i)).sort((a, b) => b.list_added_at - a.list_added_at);
      return library.withProgress(wl, viewer);
    }),
  });
  add({ key: 'lists', id: 'lists', title: 'Playlists', style: 'list', items: lazy(() => core.lists.forProfile(ctx.profile, viewer).filter((l) => l.kind !== 'watchlist' && l.count > 0)) });

  for (const lib of library.visibleLibraries(viewer)) {
    const base = { key: `recent-${lib.id}`, id: `recent-${lib.id}`, libraryId: lib.id };
    if (lib.type === 'movies') add({ ...base, title: `Recently added in ${lib.name}`, style: 'poster', items: lazy(() => library.withProgress(library.recentlyAdded({ viewer, kind: 'movie', libraryId: lib.id, limit: 24 }), viewer)) });
    else if (lib.type === 'tv') add({ ...base, title: `Latest in ${lib.name}`, style: 'poster', items: lazy(() => library.withProgress(library.list({ viewer, libraryId: lib.id, kind: 'show', sort: 'added', limit: 24 }), viewer)) });
    else if (lib.type === 'music') add({ ...base, title: `New albums in ${lib.name}`, style: 'square', items: lazy(() => library.withProgress(library.list({ viewer, libraryId: lib.id, kind: 'album', sort: 'added', limit: 24 }), viewer)) });
  }

  // "Because you watched …" rows move and hide together (one key).
  if (editor) rows.push({ key: 'picks', id: 'picks', title: 'Because you watched…', style: 'poster', items: [] });
  else for (const p of core.picks.becauseYouWatched(viewer)) rows.push({ key: 'picks', id: `picks-${p.seed.id}`, title: `Because you watched ${p.seed.title}`, style: 'poster', seed: p.seed, items: p.items });

  for (const row of plugins.homeRows) {
    const base = { key: `plugin:${row.key}`, id: row.key, title: row.title, style: row.style, plugin: row.owner.replace('plugin:', '') };
    if (editor) {
      rows.push({ ...base, items: [] });
      continue;
    }
    try {
      const result = await withTimeout(Promise.resolve(row.items(viewer)), 5000, []);
      // v0.23: a row may give its own title for this viewer: { title, items }.
      const own = result && !Array.isArray(result) && Array.isArray(result.items) ? result : null;
      const items = own ? own.items : result;
      const title = own && typeof own.title === 'string' && own.title.trim() ? own.title.trim().slice(0, 120) : base.title;
      if (!items?.length) continue;
      // Plugins get the viewer too, but double-check nothing hidden slips through.
      const rowsFromDb = items.filter((i) => i && i.library_id !== undefined && library.canSee(viewer, i));
      const plainCards = items.filter((i) => i && i.library_id === undefined);
      if (viewer.kids && plainCards.length && !rowsFromDb.length) continue; // unrated outside content
      let cards = rowsFromDb.length ? library.withProgress(rowsFromDb, viewer) : plainCards;
      // v0.23: a short note on a card ("4 episodes left"), kept through serializing.
      if (rowsFromDb.length) {
        cards = cards.map((c, i) => {
          const note = typeof rowsFromDb[i].note === 'string' ? rowsFromDb[i].note.trim().slice(0, 80) : '';
          return note ? { ...c, note } : c;
        });
      }
      if (cards.length) rows.push({ ...base, title, items: cards });
    } catch (err) {
      log.warn(`Home row ${row.key} failed: ${err.message}`);
    }
  }
  // Pinned rows: the viewer's rules every time; one that is gone stays in the editor as "Not available" (to remove).
  for (const pin of pins) {
    const row = pinRow(pin, core, viewer);
    if (editor) rows.push(row ? { ...row, pin, items: [] } : { key: pin.key, id: pin.key, title: 'Not available', style: 'poster', pin, unavailable: true, items: [] });
    else if (row?.items.length) rows.push(row);
  }
  // The household's web apps (a Kids profile: only those marked for Kids); listed in the editor only when there are some.
  const apps = core.webApps.list({ kids: Boolean(viewer.kids) });
  if (apps.length) rows.push({ key: 'web-apps', id: 'web-apps', title: 'Web apps', style: 'apps', items: editor ? [] : apps });
  return rows;
}

/** applyLayout works on keys; several rows share 'picks', so they are grouped for it and spread back after. */
export function groupByKey(rows) {
  const groups = [];
  const at = new Map();
  for (const r of rows) {
    if (!at.has(r.key)) {
      at.set(r.key, { key: r.key, rows: [] });
      groups.push(at.get(r.key));
    }
    at.get(r.key).rows.push(r);
  }
  return groups;
}
