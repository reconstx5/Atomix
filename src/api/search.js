// Search helpers (v0.24): each profile's recent searches; suggestions as you type; the genre and library tiles shown
// before typing; and the genre and person pages' titles. Everything goes through the viewer's visibility, so a Kids
// profile sees only what its rules allow. The full results stay at GET /api/search (src/api/library.js).
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { serializeItem } from './serialize.js';
import { keyMatch, queryKeys, rankTitle } from '../library/searchkey.js';

const KEEP = 10;
const MAX_QUERY = 200;
const SUGGEST = 8;
const SUGGEST_KINDS = ['movie', 'show', 'artist', 'album', 'podcast', 'audiobook', 'book', 'comic', 'series'];
const ROLE = { director: 'Director', creator: 'Creator', cast: 'Actor' };
const join = (...parts) => parts.filter((p) => p != null && p !== '').join(' · ');

/** A suggestion's second line: what it is, and its year, artist or author when known. */
function subtitle(row, libType) {
  const kind = row.kind === 'series' ? (libType === 'comics' ? 'comic' : 'book') : row.kind;
  switch (kind) {
    case 'movie': return join('Film', row.year);
    case 'show': return join('TV show', row.year);
    case 'artist': return 'Artist';
    case 'album': return join('Album', row.artist);
    case 'podcast': return 'Podcast';
    case 'audiobook': return join('Audiobook', row.author);
    case 'book': return join('Book', row.author);
    case 'comic': return 'Comic';
    default: return '';
  }
}

/** A route's :name, decoded (400 when it isn't valid percent-encoding). */
function nameParam(raw) {
  try {
    const name = decodeURIComponent(String(raw)).trim();
    if (!name) throw new Error('empty');
    return name.slice(0, MAX_QUERY);
  } catch {
    throw new HttpError(400, 'That name could not be read.');
  }
}

export function registerSearchRoutes(r, core) {
  const { db, library } = core;
  const libTypes = () => new Map(db.all('SELECT id, type FROM libraries').map((l) => [l.id, l.type]));
  const people = (row) => parseJson(row.people, []).filter((p) => p && typeof p.name === 'string' && p.name.trim());

  // ---- Recent searches ----
  const recent = (profileId) => db.all('SELECT id, query FROM search_history WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', profileId, KEEP);

  r.get('/api/search/recent', (ctx) => recent(ctx.profile.id));

  r.post('/api/search/recent', async (ctx) => {
    const query = String((await ctx.body()).query ?? '').trim().slice(0, MAX_QUERY);
    if (!query) throw new HttpError(400, 'Type something to search for.');
    const pid = ctx.profile.id;
    db.transaction(() => {
      // A repeat goes to the top (its latest spelling kept), and only the 10 newest stay.
      db.run('DELETE FROM search_history WHERE profile_id = ? AND lower(query) = lower(?)', pid, query);
      db.run('INSERT INTO search_history (profile_id, query, created_at) VALUES (?, ?, ?)', pid, query, Date.now());
      db.run('DELETE FROM search_history WHERE profile_id = ? AND id NOT IN (SELECT id FROM search_history WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)', pid, pid, KEEP);
    });
    return recent(pid);
  });

  r.delete('/api/search/recent/:id', (ctx) => {
    const res = db.run('DELETE FROM search_history WHERE id = ? AND profile_id = ?', Number(ctx.params.id), ctx.profile.id);
    if (!res.changes) throw new HttpError(404, 'That search is no longer in your list.');
    return recent(ctx.profile.id);
  });

  r.delete('/api/search/recent', (ctx) => {
    db.run('DELETE FROM search_history WHERE profile_id = ?', ctx.profile.id);
    return [];
  });

  // ---- Suggestions as you type ----
  r.get('/api/search/suggest', (ctx) => {
    const q = String(ctx.query.q || '').trim().slice(0, MAX_QUERY);
    if (!queryKeys(q).length) return [];
    const viewer = ctx.viewer;
    const types = libTypes();
    // Titles that start with the query first, then any that contain it — each pass shortest first — so a big library
    // can't crowd the obvious match out before ranking (review fix).
    const seen = new Set();
    const rows = [
      ...library.list({ viewer, kind: SUGGEST_KINDS, search: q, searchPrefix: true, topLevel: true, sort: 'shortest', limit: 100 }),
      ...library.list({ viewer, kind: SUGGEST_KINDS, search: q, topLevel: true, sort: 'shortest', limit: 200 }),
    ].filter((row) => !seen.has(row.id) && seen.add(row.id));
    const out = rows.map((row) => ({
      rank: rankTitle(row.title, q),
      entry: { kind: row.kind, id: row.id, title: row.title, subtitle: subtitle(row, types.get(row.library_id)), poster: serializeItem(row).poster || undefined },
    }));
    // People from the cast and crew of the films and shows this viewer can see.
    const vis = library.visibility(viewer);
    // A name's own key, not the whole JSON (whose "name", "role" and "director" would match every row).
    const m = keyMatch("atomix_key(json_extract(p.value, '$.name'))", q);
    const found = new Map(); // name → { titles: Set, roles: Map(role → n) }
    for (const row of db.all(`SELECT i.id, i.people FROM items i WHERE i.kind IN ('movie', 'show') AND ${vis.sql} AND EXISTS (SELECT 1 FROM json_each(i.people) p WHERE ${m.sql}) LIMIT 2000`, ...vis.params, ...m.params)) {
      for (const p of people(row)) {
        if (rankTitle(p.name, q) === 3) continue;
        const f = found.get(p.name) || { titles: new Set(), roles: new Map() };
        f.titles.add(row.id);
        f.roles.set(p.role, (f.roles.get(p.role) || 0) + 1);
        found.set(p.name, f);
      }
    }
    for (const [name, f] of found) {
      const role = [...f.roles].sort((a, b) => b[1] - a[1])[0][0];
      const n = f.titles.size;
      out.push({ rank: rankTitle(name, q), person: true, entry: { kind: 'person', title: name, subtitle: join(ROLE[role] || 'Actor', `${n} ${n === 1 ? 'title' : 'titles'}`) } });
    }
    return out
      .filter((x) => x.rank < 3)
      .sort((a, b) => a.rank - b.rank || a.entry.title.length - b.entry.title.length || Number(Boolean(a.person)) - Number(Boolean(b.person)) || a.entry.title.localeCompare(b.entry.title))
      .slice(0, SUGGEST)
      .map((x) => x.entry);
  });

  // ---- Before typing: genre and library tiles ----
  r.get('/api/search/browse', (ctx) => {
    const vis = library.visibility(ctx.viewer);
    const genres = db.all(
      `SELECT g.value AS name, COUNT(DISTINCT i.id) AS count FROM items i, json_each(i.genres) g
       WHERE i.kind IN ('movie', 'show') AND ${vis.sql} AND trim(g.value) != '' GROUP BY g.value ORDER BY count DESC, g.value COLLATE NOCASE LIMIT 12`,
      ...vis.params,
    );
    const libraries = library.visibleLibraries(ctx.viewer).map((l) => ({ id: l.id, name: l.name, type: l.type }));
    return { genres, libraries };
  });

  // ---- A genre's and a person's films and shows ----
  r.get('/api/genres/:name/items', (ctx) => {
    const name = nameParam(ctx.params.name);
    const items = library.withProgress(library.list({ viewer: ctx.viewer, kind: ['movie', 'show'], genre: name, sort: 'title' }), ctx.viewer);
    return { name, items };
  });

  r.get('/api/people/:name/items', (ctx) => {
    const name = nameParam(ctx.params.name);
    const vis = library.visibility(ctx.viewer);
    const rows = db.all(
      `SELECT i.* FROM items i WHERE i.kind IN ('movie', 'show') AND ${vis.sql}
       AND EXISTS (SELECT 1 FROM json_each(i.people) p WHERE json_extract(p.value, '$.name') = ?) ORDER BY i.sort_title COLLATE NOCASE, i.year`,
      ...vis.params,
      name,
    );
    const items = library.withProgress(rows, ctx.viewer).map((item, i) => {
      const mine = people(rows[i]).filter((p) => p.name === name);
      const lead = mine.find((p) => p.role !== 'cast') || mine[0];
      const character = mine.find((p) => p.role === 'cast' && p.character)?.character;
      return { ...item, role: ROLE[lead?.role] || 'Actor', ...(character && lead?.role === 'cast' ? { character } : {}) };
    });
    return { name, items };
  });
}
