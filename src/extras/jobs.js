// The two background jobs, wired to ffmpeg, the database and the previews folder.
import { parseJson } from '../db.js';
import { generatePreviews, removePreviews } from './previews.js';
import { runIntroJob } from './intros.js';
import { makeThumb } from './thumbs.js';
import { probe } from '../library/probe.js';

export function makeJobs({ store, config, tools }) {
  return {
    async previews(item, { signal, onSpawn }) {
      const filters = tools()?.filters || {};
      const layout = await generatePreviews({
        ffmpegPath: config.ffmpegPath,
        dir: config.previewsDir,
        item,
        media: parseJson(item.media, null),
        hdrFilters: Boolean(filters.zscale && filters.tonemap),
        onSpawn,
      });
      signal?.throwIfAborted();
      // False when the title was removed while ffmpeg worked: don't keep its pictures.
      if (!store.saveJob(item, 'previews', { status: 'done', data: layout })) removePreviews(config.previewsDir, item.id);
    },
    async thumb(item, { signal, onSpawn }) {
      const ref = await makeThumb({ ffmpegPath: config.ffmpegPath, imagesDir: config.imagesDir, item, onSpawn });
      signal?.throwIfAborted();
      if (store.saveJob(item, 'thumb', { status: 'done' })) store.db.run('UPDATE items SET poster = ? WHERE id = ?', ref, item.id);
    },
    /** Reads a song's tags again for embedded lyrics (songs scanned before 0.10); marks it checked either way. */
    async lyrics(item, { signal }) {
      let found = null;
      try {
        const fresh = await probe(config.ffprobePath, item.path);
        found = fresh?.tags?.lyrics || null;
      } catch {
        // unreadable now: still marked, so it isn't retried every scan
      }
      signal?.throwIfAborted();
      const row = store.db.get('SELECT media FROM items WHERE id = ?', item.id);
      if (!row) return;
      const media = parseJson(row.media, null) || {};
      media.tags = { ...(media.tags || {}), ...(found ? { lyrics: found } : {}), lyricsChecked: true };
      store.db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), item.id);
    },
    intros(seasonId, { signal, onSpawn }) {
      return runIntroJob({ seasonId, store, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, signal, onSpawn });
    },
  };
}
