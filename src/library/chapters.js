// Chapters for the player (v0.20): from the stored probe (`media.chapters`, since 0.15). Items probed before then are
// re-read once in the background; what's found (or [] when nothing is) is written into `media`, so the next playback
// has them and nothing reads that file again.
import fs from 'node:fs';
import { readChapters } from '../extras/intros.js';
import { parseJson } from '../db.js';

/** media → [{ start, end, title }], titled "Chapter N" when the file gives no name. */
export function chapterList(media) {
  return (Array.isArray(media?.chapters) ? media.chapters : [])
    .map((c) => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, title: c.title || null }))
    .filter((c) => c.end > c.start)
    .map((c, i) => ({ ...c, title: c.title || `Chapter ${i + 1}` }));
}

export class Chapters {
  constructor({ db, config, log = null }) {
    this.db = db;
    this.config = config;
    this.log = log;
    this.read = (file) => readChapters(config.ffprobePath, file); // replaced in tests to count reads
    this.pending = new Set();
  }

  /** The item's chapters now; when its probe predates stored chapters, read them in the background (once). */
  forItem(item, media) {
    if (media && !media.error && !('chapters' in media) && item.path && !this.pending.has(item.id) && fs.existsSync(item.path)) this.backfill(item).catch(() => {});
    return chapterList(media);
  }

  async backfill(item) {
    this.pending.add(item.id);
    try {
      let chapters;
      try {
        chapters = (await this.read(item.path))
          .map((c) => ({ start: Number(c.start_time) || 0, end: Number(c.end_time) || 0, title: c.tags?.title || null }))
          .filter((c) => c.end > c.start);
      } catch (err) {
        // Couldn't read (a timeout, a busy disk): nothing stored, so a later play tries again — never "no chapters".
        this.log?.debug?.(`chapters: ${err.message}`);
        return;
      }
      // Read the row again: a scan may have replaced its media while ffprobe ran.
      const media = parseJson(this.db.get('SELECT media FROM items WHERE id = ?', item.id)?.media, null);
      if (media && !media.error && !('chapters' in media)) this.db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify({ ...media, chapters }), item.id);
    } catch (err) {
      this.log?.warn?.(`chapters: couldn't save (${err.message})`);
    } finally {
      this.pending.delete(item.id);
    }
  }
}
