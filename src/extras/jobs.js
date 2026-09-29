// The two background jobs, wired to ffmpeg, the database and the previews folder.
import { parseJson } from '../db.js';
import { generatePreviews, removePreviews } from './previews.js';
import { runIntroJob } from './intros.js';

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
    intros(seasonId, { signal, onSpawn }) {
      return runIntroJob({ seasonId, store, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, signal, onSpawn });
    },
  };
}
