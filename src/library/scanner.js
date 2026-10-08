// Walks library folders, keeps the items table in sync with what's on disk,
// then probes new files and fetches their metadata.
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../log.js';
import { parseJson } from '../db.js';
import { probe } from './probe.js';
import { removeAllDownloaded } from '../stream/subtitles.js';
import { AUDIO_EXTS, parseTrack, normaliseTags } from './music.js';
import { run } from './probe.js';
import crypto from 'node:crypto';
import { isRemotePath } from '../remote/index.js';
import {
  VIDEO_EXTS, SKIP_MEDIA_DIRS, EXTRA_DIR_KINDS, extraKindOf, parseMovie, parseEpisode, parseSeasonFolder, splitTitleYear, sortTitle,
} from './parser.js';

const log = logger('scanner');
const SKIP_DIRS = new Set(['@eadir', '$recycle.bin', 'system volume information', '.trash', 'lost+found', '#recycle', '.@__thumb']);

export async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Whether any folder between the library root and the file is an extras folder (Featurettes/… or nested below one). */
function underExtrasDir(root, file) {
  const rel = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
  return rel.some((seg) => EXTRA_DIR_KINDS.has(seg.toLowerCase()));
}

async function walk(root, out = [], seen = new Set(), exts = VIDEO_EXTS, top = root) {
  // Remember real paths so symlinked folders can't send us round in circles.
  try {
    const real = await fs.promises.realpath(root);
    if (seen.has(real)) return out;
    seen.add(real);
  } catch {
    return out;
  }
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    log.warn(`Cannot read ${root}: ${err.message}`);
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(full)).isDirectory();
      } catch {
        continue; // broken link
      }
    }
    if (isDir) {
      const lower = e.name.toLowerCase();
      if (SKIP_DIRS.has(lower) || SKIP_MEDIA_DIRS.has(lower)) continue;
      await walk(full, out, seen, exts, top);
    } else if (e.isFile() || e.isSymbolicLink()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!exts.has(ext)) continue;
      try {
        const st = await fs.promises.stat(full);
        if (!st.isFile()) continue;
        // Scene-style sample clips: "movie.2019.1080p-sample.mkv", "sample-movie.mkv"
        const stem = path.parse(e.name).name;
        if ((/(^|[._-])sample$/i.test(stem) || /^sample[._-]/i.test(stem)) && st.size < 300 * 1024 * 1024) continue;
        const extra = exts === VIDEO_EXTS ? extraKindOf(full) : null;
        // A file under an extras folder that isn't itself an extra (nested deeper) is nothing.
        if (!extra && exts === VIDEO_EXTS && underExtrasDir(top, full)) continue;
        out.push({ file: full, size: st.size, mtime: Math.floor(st.mtimeMs), extra });
      } catch {
        /* broken symlink etc. */
      }
    }
  }
  return out;
}

export class Scanner {
  constructor({ db, config, settings, metadata, hooks, tools }) {
    this.db = db;
    this.config = config;
    this.settings = settings;
    this.metadata = metadata;
    this.hooks = hooks;
    this.tools = tools; // { ffprobe: { available } }
    this.queue = [];
    this.status = { running: false, library: null, phase: 'idle', done: 0, total: 0, added: 0, removed: 0, startedAt: null, finishedAt: null, error: null };
    this.timer = null;
  }

  schedule() {
    clearInterval(this.timer);
    clearInterval(this.remoteTimer);
    this.timer = null;
    this.remoteTimer = null;
    const minutes = Number(this.settings.get('scanIntervalMinutes')) || 0;
    if (minutes > 0) {
      this.timer = setInterval(() => this.scanAll({ local: true }).catch((e) => log.error(e)), minutes * 60 * 1000);
      this.timer.unref();
    }
    const hours = Number(this.settings.get('remoteSyncHours')) || 0;
    if (hours > 0) {
      this.remoteTimer = setInterval(() => this.scanAll({ remote: true }).catch((e) => log.error(e)), hours * 3600 * 1000);
      this.remoteTimer.unref();
    }
  }

  /** Queue a scan; concurrent requests are merged. */
  /** Every library, or only folder ones ({ local: true }) / connected-server ones ({ remote: true }). */
  scanAll(opts = {}) {
    const { local, remote, ...rest } = opts;
    const libs = this.db.all('SELECT * FROM libraries ORDER BY id').filter((l) => (local ? !l.server_id : remote ? Boolean(l.server_id) : true));
    return Promise.all(libs.map((l) => this.enqueue(l.id, rest)));
  }

  enqueue(libraryId, opts = {}) {
    const existing = this.queue.find((q) => q.libraryId === libraryId && !q.started);
    if (existing) return existing.promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
    this.queue.push({ libraryId, opts, promise, resolve, reject, started: false });
    this.pump();
    return promise;
  }

  async pump() {
    if (this.status.running) return;
    const job = this.queue.find((q) => !q.started);
    if (!job) return;
    job.started = true;
    this.status.running = true;
    try {
      const result = await this.scanLibrary(job.libraryId, job.opts);
      job.resolve(result);
    } catch (err) {
      log.error(`Scan failed: ${err.stack || err.message}`);
      this.status.error = err.message;
      job.reject(err);
    } finally {
      this.queue = this.queue.filter((q) => q !== job);
      this.status.running = false;
      this.status.phase = 'idle';
      this.status.finishedAt = Date.now();
      this.pump();
    }
  }

  setPhase(phase, total = 0) {
    Object.assign(this.status, { phase, done: 0, total });
  }

  async scanLibrary(libraryId, { refreshMetadata = false } = {}) {
    const lib = this.db.get('SELECT * FROM libraries WHERE id = ?', libraryId);
    if (!lib) return null;
    const roots = parseJson(lib.paths, []);
    Object.assign(this.status, { library: lib.name, libraryId, added: 0, removed: 0, error: null, startedAt: Date.now() });
    log.info(`Scanning "${lib.name}" (${roots.length} folder${roots.length === 1 ? '' : 's'})`);
    await this.hooks.emit('scan:start', { library: lib });

    // A connected server's library: the sync reads the server instead of folders.
    if (lib.server_id) {
      if (!this.remote) throw new Error('Connected servers are not set up');
      const scanId = Date.now();
      const firstScan = !lib.last_scan;
      const newItems = [];
      this.setPhase('Reading the server');
      const r = await this.remote.syncLibrary(lib, { scanId, firstScan, newItems, status: this.status });
      this.status.added = newItems.length;
      this.status.removed = r.removed;
      this.db.run('UPDATE libraries SET last_scan = ? WHERE id = ?', Date.now(), lib.id);
      for (const id of newItems) {
        const item = this.db.get('SELECT * FROM items WHERE id = ?', id);
        if (item) await this.hooks.emit('item:added', { item, library: lib, firstScan });
      }
      log.info(`Finished "${lib.name}": ${r.files} titles from the server, ${newItems.length} new, ${r.removed} removed`);
      await this.hooks.emit('scan:complete', { library: lib, added: newItems.length, removed: r.removed, firstScan });
      return { files: r.files, added: newItems.length, removed: r.removed };
    }

    this.setPhase('Finding files');
    const reachable = [];
    const files = [];
    for (const root of roots) {
      try {
        const st = await fs.promises.stat(root);
        if (!st.isDirectory()) throw new Error('not a folder');
        reachable.push(root);
        for (const f of await walk(root, [], new Set(), lib.type === 'music' ? AUDIO_EXTS : VIDEO_EXTS)) files.push({ ...f, root });
      } catch (err) {
        log.warn(`Skipping unreachable folder ${root}: ${err.message} (existing items kept)`);
      }
    }

    const scanId = Date.now();
    const firstScan = !lib.last_scan;
    const newItems = [];
    const extrasFound = lib.type === 'music' ? [] : files.filter((f) => f.extra);
    const mainFiles = lib.type === 'music' ? files : files.filter((f) => !f.extra);
    if (lib.type === 'music') {
      newItems.push(...(await this.scanMusic(lib, mainFiles, scanId, firstScan)));
    } else {
      this.setPhase('Updating library', mainFiles.length);
      this.db.transaction(() => {
        for (const f of mainFiles) {
          const added = lib.type === 'movies' ? this.upsertMovie(lib, f, scanId, firstScan) : this.upsertEpisode(lib, f, scanId, firstScan);
          if (added) newItems.push(added);
          this.status.done++;
        }
      });
    }
    if (extrasFound.length) {
      this.setPhase('Finding extras', extrasFound.length);
      this.db.transaction(() => {
        for (const f of extrasFound) {
          const owner = this.ownerOf(lib, f, mainFiles);
          if (!owner) {
            log.debug(`No owner for extra ${f.file}`);
            continue;
          }
          this.upsertExtra(lib, f, owner, scanId); // never "new content": not counted, not announced
          this.status.done++;
        }
      });
    }

    // Remove things that disappeared (only under folders we could actually read),
    // and anything left over from folders that were taken out of the library.
    const removed = this.prune(lib, reachable, scanId, roots);
    this.status.added = newItems.length;
    this.status.removed = removed;

    await this.probePending(lib.id);
    if (lib.type === 'music') await this.extractAlbumArt(lib.id);
    await this.fetchMetadata(lib.id, refreshMetadata);

    this.db.run('UPDATE libraries SET last_scan = ? WHERE id = ?', Date.now(), lib.id);
    for (const id of newItems) {
      const item = this.db.get('SELECT * FROM items WHERE id = ?', id);
      if (item) await this.hooks.emit('item:added', { item, library: lib, firstScan });
    }
    log.info(`Finished "${lib.name}": ${files.length} files, ${newItems.length} new, ${removed} removed`);
    await this.hooks.emit('scan:complete', { library: lib, added: newItems.length, removed, firstScan });
    return { files: files.length, added: newItems.length, removed };
  }

  /** The movie or show row an extra belongs to (spec §4.2), or null. */
  ownerOf(lib, f, mainFiles) {
    const extraDir = path.dirname(f.file);
    const isFolderExtra = EXTRA_DIR_KINDS.has(path.basename(extraDir).toLowerCase());
    if (lib.type === 'movies') {
      const folder = isFolderExtra ? path.dirname(extraDir) : extraDir;
      const films = mainFiles.filter((x) => path.dirname(x.file) === folder);
      let file = null;
      if (films.length === 1) file = films[0];
      else if (!isFolderExtra && films.length > 1) {
        // The film whose name the extra carries: an exact match on the suffix-stripped name, else the longest
        // film name the extra's name starts with (so "Toy Story 2-trailer" goes to Toy Story 2, not Toy Story).
        const stem = path.parse(f.file).name.toLowerCase();
        const stripped = stem.replace(/-[a-z]+$/, '');
        const named = films.map((x) => ({ x, name: path.parse(x.file).name.toLowerCase() }));
        file = named.find((n) => n.name === stripped)?.x
          || named.filter((n) => stem.startsWith(n.name)).sort((a, b) => b.name.length - a.name.length)[0]?.x
          || null;
      }
      return file ? this.db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'movie' AND path = ?", lib.id, file.file) : null;
    }
    // TV: the show is the first folder under the root.
    const rel = path.relative(f.root, f.file).split(path.sep);
    if (rel.length < 2) return null;
    const showPath = path.join(f.root, rel[0]);
    return this.db.get("SELECT * FROM items WHERE library_id = ? AND kind = 'show' AND path = ?", lib.id, showPath) || null;
  }

  upsertExtra(lib, f, owner, scanId) {
    const now = Date.now();
    const showId = owner.kind === 'show' ? owner.id : null;
    const r = this.upsertItem({
      library_id: lib.id,
      kind: 'extra',
      extra_kind: f.extra.kind,
      parent_id: owner.id,
      show_id: showId,
      path: f.file,
      title: f.extra.title,
      sort_title: sortTitle(f.extra.title),
      size: f.size,
      mtime: f.mtime,
      certification: owner.certification,
      min_age: owner.min_age,
      added_at: now,
      updated_at: now,
      seen_scan: scanId,
    });
    // The owner's rating can change between scans; keep extras in step.
    this.db.run('UPDATE items SET parent_id = ?, show_id = ?, certification = ?, min_age = ? WHERE id = ?', owner.id, showId, owner.certification, owner.min_age, r.id);
    return r.created ? r.id : null;
  }

  upsertItem(fields) {
    const existing = this.db.get('SELECT id, size, mtime FROM items WHERE library_id = ? AND kind = ? AND path = ?', fields.library_id, fields.kind, fields.path);
    if (existing) {
      if (fields.size != null && (existing.size !== fields.size || existing.mtime !== fields.mtime)) {
        this.db.run('UPDATE items SET size = ?, mtime = ?, media = NULL, duration = NULL, seen_scan = ?, updated_at = ? WHERE id = ?', fields.size, fields.mtime, fields.seen_scan, Date.now(), existing.id);
      } else {
        this.db.run('UPDATE items SET seen_scan = ? WHERE id = ?', fields.seen_scan, existing.id);
      }
      return { id: existing.id, created: false };
    }
    const cols = Object.keys(fields);
    const res = this.db.run(
      `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => fields[c]),
    );
    return { id: Number(res.lastInsertRowid), created: true };
  }

  upsertMovie(lib, f, scanId, firstScan) {
    const { title, year } = parseMovie(f.file, f.root);
    const now = Date.now();
    const r = this.upsertItem({
      library_id: lib.id,
      kind: 'movie',
      path: f.file,
      title: title || path.parse(f.file).name,
      sort_title: sortTitle(title),
      year,
      size: f.size,
      mtime: f.mtime,
      added_at: firstScan ? Math.min(now, f.mtime) : now,
      updated_at: now,
      seen_scan: scanId,
    });
    return r.created ? r.id : null;
  }

  upsertEpisode(lib, f, scanId, firstScan) {
    const rel = path.relative(f.root, f.file);
    const parts = rel.split(path.sep);
    const ep = parseEpisode(parts[parts.length - 1]);
    if (!ep) {
      log.debug(`Could not find an episode number in ${rel}`);
      return null;
    }
    let showPath;
    let showName;
    let showYear = null;
    if (parts.length === 1) {
      showName = ep.showHint || 'Unknown show';
      showPath = `${f.root}${path.sep}::${showName.toLowerCase()}`;
    } else {
      showPath = path.join(f.root, parts[0]);
      const parsed = splitTitleYear(parts[0]);
      showName = parsed.title || parts[0];
      showYear = parsed.year;
    }
    let season = ep.season;
    if (season == null) {
      for (const dir of parts.slice(1, -1)) {
        const s = parseSeasonFolder(dir);
        if (s != null) season = s;
      }
    }
    if (season == null) season = 1;

    const now = Date.now();
    const added = firstScan ? Math.min(now, f.mtime) : now;
    const show = this.upsertItem({
      library_id: lib.id, kind: 'show', path: showPath, title: showName, sort_title: sortTitle(showName), year: showYear,
      added_at: added, updated_at: now, seen_scan: scanId,
    });
    const seasonItem = this.upsertItem({
      library_id: lib.id, kind: 'season', path: `${showPath}::season::${season}`, parent_id: show.id, show_id: show.id,
      title: season === 0 ? 'Specials' : `Season ${season}`, sort_title: String(season).padStart(4, '0'), season,
      added_at: added, updated_at: now, seen_scan: scanId,
    });
    const epTitle = ep.episodeTitle || `Episode ${ep.episode}${ep.episodeEnd ? `–${ep.episodeEnd}` : ''}`;
    const episode = this.upsertItem({
      library_id: lib.id, kind: 'episode', path: f.file, parent_id: seasonItem.id, show_id: show.id,
      title: epTitle, sort_title: String(ep.episode).padStart(5, '0'), season, episode: ep.episode,
      size: f.size, mtime: f.mtime, added_at: added, updated_at: now, seen_scan: scanId,
    });
    if (episode.created) {
      this.db.run('UPDATE items SET updated_at = ? WHERE id IN (?, ?)', now, show.id, seasonItem.id);
      // New episodes bump the show up the "recently added" list.
      if (!firstScan) this.db.run('UPDATE items SET added_at = ? WHERE id = ?', now, show.id);
    }
    return episode.created ? episode.id : null;
  }

  // ---- Music ----
  async scanMusic(lib, files, scanId, firstScan) {
    const existing = new Map(
      this.db.all(`SELECT id, path, size, mtime, parent_id FROM items WHERE library_id = ? AND kind = 'track'`, lib.id).map((r) => [r.path, r]),
    );
    const changed = files.filter((f) => {
      const e = existing.get(f.file);
      return !e || e.size !== f.size || e.mtime !== f.mtime;
    });
    const changedSet = new Set(changed);
    // Tags come from ffprobe, so new files are read before they're filed.
    this.setPhase('Reading tags', changed.length);
    const probed = new Map();
    await pool(changed, 4, async (f) => {
      let info = null;
      if (this.tools.ffprobe?.available) {
        try {
          info = await probe(this.config.ffprobePath, f.file);
        } catch (err) {
          log.warn(`ffprobe failed for ${f.file}: ${err.message.split('\n')[0]}`);
        }
      }
      probed.set(f.file, info);
      this.status.done++;
    });

    // Group new tracks into albums (same folder + same album name) to work out album artists.
    const groups = new Map();
    for (const f of changed) {
      const info = probed.get(f.file);
      const t = parseTrack(normaliseTags(info?.tags), f.file, f.root);
      const dir = path.dirname(f.file);
      const key = `${dir}::album::${(t.album || '').toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { key, dir, root: f.root, album: t.album, tracks: [] });
      groups.get(key).tracks.push({ f, t, info });
    }

    const now = Date.now();
    const added = [];
    this.setPhase('Updating library', files.length);
    this.db.transaction(() => {
      for (const f of files) {
        if (!changedSet.has(f)) this.db.run('UPDATE items SET seen_scan = ? WHERE id = ?', scanId, existing.get(f.file).id);
      }
      for (const g of groups.values()) {
        let album = this.db.get(`SELECT * FROM items WHERE library_id = ? AND kind = 'album' AND path = ?`, lib.id, g.key);
        let artistId = album?.parent_id;
        if (!album) {
          const tagged = g.tracks.find((x) => x.t.albumArtist)?.t.albumArtist;
          const artists = [...new Set(g.tracks.map((x) => x.t.artist).filter(Boolean))];
          const artistName = tagged || (artists.length === 1 ? artists[0] : artists.length > 1 && g.album ? 'Various Artists' : artists[0]) || 'Unknown artist';
          const artistPath = `${g.root}${path.sep}::artist::${artistName.toLowerCase()}`;
          let artist = this.db.get(`SELECT id FROM items WHERE library_id = ? AND kind = 'artist' AND path = ?`, lib.id, artistPath);
          if (!artist) {
            const res = this.db.run(
              `INSERT INTO items (library_id, kind, path, title, sort_title, added_at, updated_at, seen_scan) VALUES (?, 'artist', ?, ?, ?, ?, ?, ?)`,
              lib.id, artistPath, artistName, sortTitle(artistName), now, now, scanId,
            );
            artist = { id: Number(res.lastInsertRowid) };
          }
          artistId = artist.id;
          const first = g.tracks[0].t;
          const title = g.album || path.basename(g.dir) || 'Unknown album';
          const genres = [...new Set(g.tracks.flatMap((x) => x.t.genres))];
          const addedAt = firstScan ? Math.min(now, Math.max(...g.tracks.map((x) => x.f.mtime))) : now;
          const res = this.db.run(
            `INSERT INTO items (library_id, kind, parent_id, show_id, path, title, sort_title, artist, year, genres, added_at, updated_at, seen_scan)
             VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            lib.id, artistId, artistId, g.key, title, sortTitle(title), artistName, g.tracks.find((x) => x.t.year)?.t.year ?? first.year ?? null,
            JSON.stringify(genres), addedAt, now, scanId,
          );
          album = { id: Number(res.lastInsertRowid) };
        }
        for (const { f, t, info } of g.tracks) {
          const order = `${String(t.disc || 1).padStart(2, '0')}-${String(t.track ?? 999).padStart(4, '0')}`;
          const values = [t.title, order, t.artist, t.year, t.disc || 1, t.track, info?.duration || null, info ? JSON.stringify(info) : '{"error":true}', f.size, f.mtime, album.id, artistId, now, scanId];
          const old = existing.get(f.file);
          if (old) {
            this.db.run(
              `UPDATE items SET title = ?, sort_title = ?, artist = ?, year = ?, season = ?, episode = ?, duration = ?, media = ?, size = ?, mtime = ?,
                 parent_id = ?, show_id = ?, updated_at = ?, seen_scan = ? WHERE id = ?`,
              ...values, old.id,
            );
            // A re-tagged song may have lyrics now: a stored "none" (or old tag lyrics) is read again on the next open.
            this.db.run("DELETE FROM lyrics WHERE item_id = ? AND source IN ('none', 'tags')", old.id);
          } else {
            const res = this.db.run(
              `INSERT INTO items (title, sort_title, artist, year, season, episode, duration, media, size, mtime, parent_id, show_id, updated_at, seen_scan,
                 library_id, kind, path, added_at, metadata_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'track', ?, ?, ?)`,
              ...values, lib.id, f.file, firstScan ? Math.min(now, f.mtime) : now, now,
            );
            added.push(Number(res.lastInsertRowid));
          }
          this.status.done++;
        }
        this.db.run(`UPDATE items SET updated_at = ? WHERE id IN (?, ?)`, now, album.id, artistId);
      }
    });
    return added;
  }

  /** Albums without a cover image: use the picture embedded in one of their tracks. */
  async extractAlbumArt(libraryId) {
    if (!this.tools.ffmpeg?.available) return;
    const albums = this.db.all(`SELECT id FROM items WHERE library_id = ? AND kind = 'album' AND poster IS NULL`, libraryId);
    for (const album of albums) {
      const track = this.db
        .all(`SELECT path, media FROM items WHERE parent_id = ? AND kind = 'track' ORDER BY sort_title`, album.id)
        .find((t) => parseJson(t.media, {})?.coverArt);
      if (!track) continue;
      const name = `emb-${crypto.createHash('sha1').update(track.path).digest('hex')}.jpg`;
      const dest = path.join(this.config.imagesDir, name);
      try {
        if (!fs.existsSync(dest)) {
          await run(this.config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', track.path, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '3', dest], { timeout: 30000 });
        }
        this.db.run('UPDATE items SET poster = ? WHERE id = ?', `cache:${name}`, album.id);
      } catch (err) {
        log.warn(`Could not read the cover art in ${track.path}: ${err.message.split('\n')[0]}`);
      }
    }
  }

  prune(lib, reachable, scanId, roots = reachable) {
    const within = (list) => (p) => list.some((r) => p === r || p.startsWith(r.endsWith(path.sep) || isRemotePath(r) ? r : r + path.sep));
    const underReachable = within(reachable);
    const underAnyRoot = within(roots);
    const stale = this.db
      .all(`SELECT id, path FROM items WHERE library_id = ? AND kind IN ('movie','episode','track','extra') AND (seen_scan IS NULL OR seen_scan != ?)`, lib.id, scanId)
      .filter((row) => row.path && (underReachable(row.path) || !underAnyRoot(row.path)));
    if (!stale.length && !reachable.length) return 0;
    for (const row of stale) removeAllDownloaded(this.config, row.id); // subtitles fetched for it
    this.db.transaction(() => {
      for (const row of stale) this.db.run('DELETE FROM items WHERE id = ?', row.id);
      // Containers left empty: seasons/albums first, then shows/artists.
      this.db.run(`DELETE FROM items WHERE library_id = ? AND kind IN ('season','album') AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`, lib.id);
      this.db.run(`DELETE FROM items WHERE library_id = ? AND kind IN ('show','artist') AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = items.id)`, lib.id);
      // A show left with only extras (its episodes went) goes too, extras and all; it comes back with an episode.
      this.db.run(`DELETE FROM items WHERE library_id = ? AND kind = 'show' AND NOT EXISTS (SELECT 1 FROM items e WHERE e.show_id = items.id AND e.kind = 'episode')`, lib.id);
      this.db.run(`DELETE FROM items WHERE library_id = ? AND kind IN ('season','extra') AND show_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items s WHERE s.id = items.show_id)`, lib.id);
    });
    return stale.length;
  }

  async probePending(libraryId) {
    if (!this.tools.ffprobe?.available) return;
    const rows = this.db.all(`SELECT id, path FROM items WHERE library_id = ? AND kind IN ('movie','episode','extra') AND media IS NULL`, libraryId);
    if (!rows.length) return;
    this.setPhase('Reading media info', rows.length);
    await pool(rows, 3, async (row) => {
      try {
        const info = await probe(this.config.ffprobePath, row.path);
        this.db.run('UPDATE items SET media = ?, duration = ? WHERE id = ?', JSON.stringify(info), info.duration, row.id);
      } catch (err) {
        log.warn(`ffprobe failed for ${row.path}: ${err.message.split('\n')[0]}`);
        this.db.run(`UPDATE items SET media = '{"error":true}' WHERE id = ?`, row.id);
      }
      this.status.done++;
    });
  }

  async fetchMetadata(libraryId, force) {
    const where = force ? '' : 'AND metadata_at IS NULL';
    // Albums before artists: an artist's picture is found through its albums' folders.
    const top = this.db.all(`SELECT * FROM items WHERE library_id = ? AND kind IN ('movie','show','album') ${where} ORDER BY id`, libraryId);
    const children = () => this.db.all(`SELECT * FROM items WHERE library_id = ? AND kind IN ('season','episode','artist') ${where} ORDER BY show_id, season, episode`, libraryId);
    const total = top.length + (force ? 0 : children().length);
    if (!total) return;
    this.setPhase('Fetching metadata', total);
    await pool(top, 3, async (item) => {
      await this.metadata.refresh(item, { force });
      this.status.done++;
    });
    const kids = children();
    this.status.total = top.length + kids.length;
    await pool(kids, 3, async (item) => {
      await this.metadata.refresh(item, { force });
      this.status.done++;
    });
  }
}
