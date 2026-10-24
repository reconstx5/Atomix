// Playlists for music apps: Atomix's song playlists (pl-<id>) and song smart playlists (sp-<id>, worked out for the
// viewer and read-only). The profile's own, plus those others share; only the profile that made one changes it.
import { SubsonicError } from './envelope.js';
import { song, mineFor, parseId } from './shapes.js';
import { queries, LIMITS } from './browse.js';

const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
const NOT_YOURS = 'Only the profile that made this playlist can change it.';

export function registerPlaylists(s) {
  const isSongList = (l) => l && (l.kind === 'music' || (l.kind === 'smart' && l.media === 'music'));
  const sid = (l) => `${l.kind === 'smart' ? 'sp' : 'pl'}-${l.id}`;

  /** A playlist the viewer may open, by its Subsonic id. */
  function find(ctx, raw) {
    const id = parseId(raw, ['pl', 'sp']);
    const list = id && ctx.core.lists.get(id.id);
    const right = list && (id.kind === 'sp' ? list.kind === 'smart' && list.media === 'music' : list.kind === 'music');
    if (!right || !ctx.core.lists.visibleTo(list, ctx.viewer)) throw new SubsonicError(70, 'Playlist not found');
    return list;
  }
  /** One the viewer may change: its own, and not smart. */
  function own(ctx, raw) {
    const list = find(ctx, raw);
    if (list.kind === 'smart' || list.profile_id !== ctx.profile.id) throw new SubsonicError(50, NOT_YOURS);
    return list;
  }

  /** The list's songs the viewer may see, in its order, as Subsonic songs. */
  function entries(ctx, list) {
    const ids = ctx.core.lists.rows(list.id, ctx.viewer).filter((r) => r.kind === 'track').map((r) => r.id);
    if (!ids.length) return [];
    const q = queries(ctx.core, ctx.viewer);
    const rows = new Map(q.songs({ where: `i.id IN (${ids.map(() => '?').join(',')})`, params: ids, limit: ids.length }).map((r) => [r.id, r]));
    const all = ids.map((id) => rows.get(id)).filter(Boolean);
    const kept = all.slice(0, LIMITS.playlist);
    const mine = mineFor(ctx.core.db, ctx.viewer.profileId, kept.map((r) => r.id));
    const out = kept.map((r) => song(r, mine));
    out.truncated = all.length > kept.length; // getPlaylist says so (the API has no paging here)
    return out;
  }

  function shape(ctx, list, withEntries = false) {
    const songs = entries(ctx, list);
    const owner = ctx.core.db.get('SELECT name FROM profiles WHERE id = ?', list.profile_id)?.name || '';
    const out = {
      id: sid(list),
      name: list.name,
      owner,
      public: Boolean(list.shared),
      songCount: songs.length,
      duration: songs.reduce((t, x) => t + (x.duration || 0), 0),
      created: iso(list.created_at),
      changed: iso(list.updated_at),
      coverArt: sid(list),
      readonly: list.kind === 'smart' || list.profile_id !== ctx.profile.id,
    };
    if (withEntries) {
      out.entry = songs;
      if (songs.truncated) out.truncated = true;
    }
    return out;
  }

  /** Songs to add, by id: only ones the viewer may see (others are skipped). */
  function songIds(ctx, raws) {
    const q = queries(ctx.core, ctx.viewer);
    return raws
      .map((raw) => parseId(raw, ['tr']))
      .filter(Boolean)
      .filter((id) => q.songs({ where: 'i.id = ?', params: [id.id] }).length)
      .map((id) => id.id);
  }

  s.method('getPlaylists', (ctx) => {
    const lists = ctx.core.lists.forProfile(ctx.profile, ctx.viewer).filter((l) => isSongList(l));
    return { playlists: { playlist: lists.map((l) => shape(ctx, ctx.core.lists.get(l.id))) } };
  });
  s.method('getPlaylist', (ctx) => ({ playlist: shape(ctx, find(ctx, ctx.params.need('id')), true) }));

  s.method('createPlaylist', (ctx) => {
    const { lists } = ctx.core;
    const p = ctx.params;
    const add = songIds(ctx, p.all('songId'));
    let list;
    if (p.get('playlistId')) {
      list = own(ctx, p.get('playlistId'));
      for (const r of lists.rows(list.id)) lists.removeItem(list.id, r.id);
    } else {
      list = lists.create(ctx.profile.id, { kind: 'music', name: p.need('name') });
    }
    for (const id of add) lists.add(list.id, id);
    return { playlist: shape(ctx, lists.get(list.id), true) };
  });

  s.method('updatePlaylist', (ctx) => {
    const { lists } = ctx.core;
    const p = ctx.params;
    const list = own(ctx, p.need('playlistId'));
    if (p.has('public')) {
      if (ctx.profile.kids && p.bool('public')) throw new SubsonicError(50, "Kids profiles can't share playlists.");
      lists.setShared(list.id, p.bool('public'));
    }
    if (p.get('name')) lists.rename(list.id, p.get('name'));
    // An index counts the songs the app was shown (getPlaylist's entries), not every row the list holds.
    const shown = entries(ctx, list);
    const remove = [...new Set(p.all('songIndexToRemove').map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n < shown.length).sort((a, b) => b - a);
    for (const n of remove) lists.removeItem(list.id, parseId(shown[n].id, ['tr']).id);
    for (const id of songIds(ctx, p.all('songIdToAdd'))) lists.add(list.id, id);
    return {};
  });

  s.method('deletePlaylist', (ctx) => {
    ctx.core.lists.remove(own(ctx, ctx.params.need('id')).id);
    return {};
  });
}
