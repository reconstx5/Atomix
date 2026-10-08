// Lyrics for a song: a .lrc (or .txt) beside it, then the song's tags, then LRCLIB (free, no key), remembered per song.
import fs from 'node:fs';
import { parseJson } from './db.js';
import { parseLrc } from '../public/js/lrc.js';
import { logger } from './log.js';

const log = logger('lyrics');
const MONTH = 30 * 24 * 3600 * 1000;

export class Lyrics {
  constructor({ db, settings, version = '0', base = 'https://lrclib.net/api', timeoutMs = 10000, fetchFn = fetch }) {
    Object.assign(this, { db, settings, version, base, timeoutMs, fetchFn });
    this.inflight = new Map();
  }
  shape(row) {
    if (!row || row.source === 'none' || !row.text) return null;
    const p = parseLrc(row.text);
    return { synced: Boolean(row.synced) && p.synced, lines: p.lines, source: row.source };
  }
  save(itemId, source, text, { synced = false, fileMtime = null } = {}) {
    this.db.run(
      'INSERT INTO lyrics (item_id, source, synced, text, file_mtime, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET source = excluded.source, synced = excluded.synced, text = excluded.text, file_mtime = excluded.file_mtime, fetched_at = excluded.fetched_at',
      itemId, source, synced ? 1 : 0, text, fileMtime, Date.now(),
    );
    return this.db.get('SELECT * FROM lyrics WHERE item_id = ?', itemId);
  }
  /** `<song>.lrc` or `<song>.txt` beside the file, with its mtime. */
  fileBeside(track) {
    if (!track.path) return null;
    const stem = track.path.replace(/\.[^./\\]+$/, '');
    for (const ext of ['.lrc', '.txt']) {
      try {
        const st = fs.statSync(stem + ext);
        if (st.isFile()) return { file: stem + ext, mtime: Math.floor(st.mtimeMs) };
      } catch {
        /* next */
      }
    }
    return null;
  }
  /** @returns {Promise<{ synced: boolean, lines: { at: number | null, text: string }[], source: string } | null>} */
  async get(track) {
    const stored = this.db.get('SELECT * FROM lyrics WHERE item_id = ?', track.id);
    const f = this.fileBeside(track);
    if (f) {
      if (stored?.source === 'file' && stored.file_mtime === f.mtime) return this.shape(stored);
      const text = fs.readFileSync(f.file, 'utf8');
      return this.shape(this.save(track.id, 'file', text, { synced: parseLrc(text).synced, fileMtime: f.mtime }));
    }
    if (stored && stored.source !== 'file' && !(stored.source === 'none' && Date.now() - stored.fetched_at > MONTH)) return this.shape(stored);
    const tagText = parseJson(track.media, null)?.tags?.lyrics;
    if (tagText) return this.shape(this.save(track.id, 'tags', String(tagText), { synced: parseLrc(tagText).synced }));
    if (!this.settings.get('onlineLyrics')) return null;
    if (!this.inflight.has(track.id)) this.inflight.set(track.id, this.fromLrclib(track).finally(() => this.inflight.delete(track.id)));
    return this.inflight.get(track.id);
  }
  async fromLrclib(track) {
    const album = track.parent_id ? this.db.get('SELECT title FROM items WHERE id = ?', track.parent_id)?.title : null;
    const q = new URLSearchParams({ artist_name: track.artist || '', track_name: track.title || '' });
    if (album) q.set('album_name', album);
    if (track.duration) q.set('duration', String(Math.round(track.duration)));
    try {
      const res = await this.fetchFn(`${this.base}/get?${q}`, {
        headers: { 'user-agent': `Atomix/${this.version} (https://github.com/reconstx5/Atomix)` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 200) {
        const body = await res.json();
        if (body.syncedLyrics) return this.shape(this.save(track.id, 'lrclib', body.syncedLyrics, { synced: true }));
        if (body.plainLyrics) return this.shape(this.save(track.id, 'lrclib', body.plainLyrics, { synced: false }));
      } else if (res.status !== 404) log.warn(`LRCLIB answered ${res.status} for "${track.title}"`);
    } catch (err) {
      log.warn(`LRCLIB unreachable for "${track.title}": ${err.message}`);
    }
    this.save(track.id, 'none', null);
    return null;
  }
}
