// Turns a connected server's library into items: the scanner hands a library with a server_id here.
import { logger } from '../log.js';
import { certToAge } from '../library/ratings.js';
import { sortTitle } from '../library/parser.js';
import { remotePath } from './index.js';
import { parseJson } from '../db.js';
import { chooseConnection } from './plextv.js';

const log = logger('remote');

export class RemoteSync {
  constructor({ db, settings, providers, scanner, images = null, plextv = null }) {
    Object.assign(this, { db, settings, providers, scanner, images, plextv });
  }
  /** A Plex server that no longer answers at its address: ask plex.tv where that same machine is now, once. */
  async refreshPlexAddress(server) {
    const extra = parseJson(server.extra, {});
    if (server.kind !== 'plex' || !extra?.accountToken || !this.plextv) return false;
    try {
      const resource = (await this.plextv.resources(extra.accountToken)).find((r) => r.clientIdentifier === server.remote_user_id);
      if (!resource) return false;
      const choice = await chooseConnection(resource);
      if (!choice || choice.url === server.url) return false;
      this.db.run('UPDATE servers SET url = ?, extra = ? WHERE id = ?', choice.url, JSON.stringify({ ...extra, relay: choice.relay }), server.id);
      log.info(`${server.name} moved: now at ${choice.url}`);
      server.url = choice.url;
      return true;
    } catch (err) {
      log.warn(`Couldn't ask plex.tv where ${server.name} is now: ${err.message}`);
      return false;
    }
  }
  server(lib) {
    return this.db.get('SELECT * FROM servers WHERE id = ?', lib.server_id);
  }
  setStatus(server, status, detail = null) {
    this.db.run('UPDATE servers SET status = ?, status_detail = ? WHERE id = ?', status, detail, server.id);
  }
  /** @returns {Promise<{ files: number, added: number, removed: number }>} throws with the server's name when it can't be reached */
  async syncLibrary(lib, { scanId, firstScan, newItems, status }) {
    const server = this.server(lib);
    const provider = server && this.providers.for(server.kind);
    if (!provider) throw new Error(`No server for "${lib.name}"`);
    let ping = await provider.ping(server);
    if (!ping.ok && ping.unreachable && (await this.refreshPlexAddress(server))) ping = await provider.ping(server);
    if (!ping.ok) {
      this.setStatus(server, ping.detail === 'unauthorized' ? 'unauthorized' : 'unreachable', ping.detail);
      throw new Error(ping.detail === 'unauthorized' ? `${server.name} no longer accepts the sign-in` : `Couldn't reach ${server.name}: ${ping.detail}`);
    }
    // A library removed on the server: keep what we have and say so, until the admin unticks it.
    const far = await provider.libraries(server);
    const options = parseJson(lib.options, {});
    if (!far.some((l) => l.remoteId === lib.remote_id)) {
      if (!options.remoteGone) this.db.run('UPDATE libraries SET options = ? WHERE id = ?', JSON.stringify({ ...options, remoteGone: true }), lib.id);
      this.db.run('UPDATE servers SET status = ?, status_detail = NULL, last_sync = ? WHERE id = ?', 'ok', Date.now(), server.id);
      log.warn(`"${lib.name}" is no longer on ${server.name}; keeping its titles`);
      return { files: 0, removed: 0 };
    }
    if (options.remoteGone) {
      delete options.remoteGone;
      this.db.run('UPDATE libraries SET options = ? WHERE id = ?', JSON.stringify(options), lib.id);
    }
    const country = this.settings.get('ratingCountry');
    let count = 0;
    const put = async (it, parent) => {
      const now = Date.now();
      const title = it.title || it.remoteId;
      const itemPath = remotePath(server.id, it.remoteId);
      const existing = this.db.get('SELECT id, media, remote_updated, poster, backdrop, logo FROM items WHERE library_id = ? AND kind = ? AND path = ?', lib.id, it.kind, itemPath);
      // Media: Plex's listing lacks the real tracks, so its details are asked for — but only when the title is new,
      // changed on the server, or was never detailed (a failed request last time). Otherwise the stored tracks stay.
      let media = it.media || null;
      let remoteUpdated = it.updated ?? 0;
      if (provider.details && ['movie', 'episode', 'track'].includes(it.kind) && it.media) {
        const stored = parseJson(existing?.media, null);
        const changed = !existing || !stored?.detailed || (it.updated != null && existing.remote_updated !== it.updated);
        if (changed) {
          try {
            media = (await provider.details(server, it)) || media;
            if (this.paceMs ?? 25) await new Promise((r) => setTimeout(r, this.paceMs ?? 25));
          } catch (err) {
            log.warn(`Couldn't read the details of "${title}" on ${server.name}: ${err.message}`);
            remoteUpdated = existing?.remote_updated ?? null; // asked again next sync
            if (stored?.detailed) media = stored; // keep the real tracks rather than the listing's summary
          }
        } else media = stored;
      }
      const fields = {
        library_id: lib.id,
        kind: it.kind,
        path: itemPath,
        remote_id: it.remoteId,
        parent_id: parent?.id ?? null,
        show_id: it.kind === 'season' || it.kind === 'album' ? parent?.id ?? null : it.kind === 'episode' || it.kind === 'track' ? parent?.show_id ?? null : null,
        title,
        sort_title: it.sortTitle || sortTitle(title),
        year: it.year,
        overview: it.overview,
        tagline: it.tagline,
        genres: JSON.stringify(it.genres || []),
        rating: it.rating,
        runtime: it.runtime,
        air_date: it.airDate,
        season: it.season,
        episode: it.kind === 'track' ? it.track : it.episode,
        artist: it.artist,
        duration: it.duration,
        media: media ? JSON.stringify(media) : null,
        size: null,
        mtime: null,
        // Seasons and episodes rarely carry their own rating: they take the show's.
        certification: it.certification || parent?.certification || null,
        min_age: it.certification ? certToAge(it.certification, country) : parent?.min_age ?? null,
        tmdb_id: it.tmdbId,
        imdb_id: it.imdbId,
        keywords: JSON.stringify(it.keywords || []),
        people: JSON.stringify(it.people || []),
        poster: provider.imageUrl(server, it, 'poster')?.url || null,
        backdrop: provider.imageUrl(server, it, 'backdrop')?.url || null,
        logo: provider.imageUrl(server, it, 'logo')?.url || null,
        remote_updated: remoteUpdated,
        metadata_at: now,
        metadata_locked: 1,
        added_at: it.addedAt || now, // the server's own date, so "Recently added" means recently added there
        updated_at: now,
        seen_scan: scanId,
      };
      // A picture the server replaced: the old cached file goes.
      if (existing && this.images) for (const k of ['poster', 'backdrop', 'logo']) if (existing[k] && existing[k] !== fields[k]) this.images.forget(existing[k]);
      // Synced before 0.12 (no remote_updated yet): take the server's added date once; it never moves after that.
      if (existing && existing.remote_updated == null && it.addedAt) this.db.run('UPDATE items SET added_at = ? WHERE id = ?', it.addedAt, existing.id);
      const r = this.scanner.upsertItem(fields);
      // Everything but the identity is the server's to change — but only write when something did change: a big
      // library is thousands of titles every few hours, and a bumped metadata_at makes every poster URL new.
      const { library_id, kind, path, added_at, seen_scan, metadata_at, updated_at, ...rest } = fields;
      const cols = Object.keys(rest);
      const cur = r.created ? null : this.db.get(`SELECT ${cols.join(', ')} FROM items WHERE id = ?`, r.id);
      if (r.created || cols.some((c) => (cur[c] ?? null) !== (rest[c] ?? null))) {
        this.db.run(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}, metadata_at = ?, updated_at = ? WHERE id = ?`, ...cols.map((c) => rest[c]), now, now, r.id);
      }
      if (r.created && ['movie', 'episode', 'track'].includes(it.kind)) newItems.push(r.id);
      count++;
      status.done = count;
      return this.db.get('SELECT id, show_id, certification, min_age FROM items WHERE id = ?', r.id);
    };
    const children = async (kind, parentRow, parentRemoteId, deeper) => {
      for await (const it of provider.items(server, lib, kind, parentRemoteId)) {
        const row = await put(it, parentRow);
        if (deeper) await deeper(row, it.remoteId);
      }
    };
    if (lib.type === 'movies') await children('movie', null, null);
    else if (lib.type === 'tv') await children('show', null, null, (show, sid) => children('season', show, sid, (season, seid) => children('episode', season, seid)));
    else await children('artist', null, null, (artist, aid) => children('album', artist, aid, (album, alid) => children('track', album, alid)));
    // A server that lists nothing where there were titles is more likely mid-rescan (or a changed permission) than empty:
    // keep what we have, like the local scanner does when a folder is unreachable.
    const had = this.db.get('SELECT COUNT(*) AS n FROM items WHERE library_id = ?', lib.id).n;
    if (count === 0 && had > 0) {
      this.db.run('UPDATE servers SET status = ?, status_detail = NULL, last_sync = ? WHERE id = ?', 'ok', Date.now(), server.id);
      throw new Error(`${server.name} listed nothing in "${lib.name}"; keeping its ${had} titles`);
    }
    const removed = this.scanner.prune(lib, [remotePath(server.id, '')], scanId, [remotePath(server.id, '')]);
    this.db.run('UPDATE servers SET status = ?, status_detail = NULL, last_sync = ? WHERE id = ?', 'ok', Date.now(), server.id);
    log.info(`Synced "${lib.name}" from ${server.name}: ${count} titles, ${removed} gone`);
    return { files: count, removed };
  }
}
