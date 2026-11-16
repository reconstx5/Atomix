import fs from 'node:fs';
// The two background jobs, wired to ffmpeg, the database and the previews folder.
import { parseJson } from '../db.js';
import { generatePreviews, removePreviews } from './previews.js';
import { runIntroJob } from './intros.js';
import { INTRODB_BASE } from './community.js';
import { measureLoudness } from '../library/loudness.js';
import { makeThumb } from './thumbs.js';
import { makeClip, clipStart } from './clips.js';
import { probe } from '../library/probe.js';
import { extractEmbeddedTracks } from '../stream/subtitles.js';

export function makeJobs({ store, config, tools, settings = null }) {
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
    // v0.28 card motion: 5 silent seconds for cards, from the local trailer when there is one. Not made for HDR
    // this ffmpeg can't tone-map (marked "none", so it isn't retried).
    async clip(item, { signal, onSpawn } = {}) {
      const trailer = store.db.get("SELECT * FROM items WHERE kind = 'extra' AND extra_kind = 'trailer' AND parent_id = ? AND path IS NOT NULL AND path NOT LIKE 'remote:%' AND duration > 0 ORDER BY id LIMIT 1", item.id);
      const useTrailer = Boolean(trailer && fs.existsSync(trailer.path));
      const src = useTrailer ? trailer : item;
      // An unplugged drive (or a file moved away): the runner records it as failed with this reason, so it is listed
      // with the other failed jobs (retried from there, or redone when the file changes) instead of looping here.
      if (!fs.existsSync(src.path)) throw new Error("The file isn't there (is the drive unplugged?)");
      const media = parseJson(src.media, null) || parseJson(item.media, null);
      const filters = tools()?.filters || {};
      const hdr = Boolean(media?.video?.hdr);
      if (hdr && !(filters.zscale && filters.tonemap)) {
        store.saveJob(item, 'clip', { status: 'none' });
        return;
      }
      const start = clipStart(src, useTrailer ? null : store.playbackMarkers(item.id), useTrailer);
      await makeClip({ ffmpegPath: config.ffmpegPath, dir: config.previewsDir, itemId: item.id, file: src.path, start, hdrFilter: hdr ? 'zscale' : null, onSpawn });
      signal?.throwIfAborted();
      if (!store.saveJob(item, 'clip', { status: 'done', data: { source: useTrailer ? 'trailer' : 'title', start } })) removePreviews(config.previewsDir, item.id);
    },
    /** Reads a song's tags again for embedded lyrics (songs scanned before 0.10); marks it checked either way. */
    async lyrics(item, { signal }) {
      let found = null;
      try {
        const fresh = await probe(config.ffprobePath, item.path);
        found = fresh?.tags?.lyrics || null;
      } catch (err) {
        if (err.code === 'ENOENT' && String(err.syscall).startsWith('spawn')) return; // no ffprobe: left unchecked, so it's read once ffprobe is there
        // unreadable now: still marked, so it isn't retried every scan
      }
      signal?.throwIfAborted();
      const row = store.db.get('SELECT media FROM items WHERE id = ?', item.id);
      if (!row) return;
      const media = parseJson(row.media, null) || {};
      media.tags = { ...(media.tags || {}), ...(found ? { lyrics: found } : {}), lyricsChecked: true };
      store.db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), item.id);
      store.lyricsChecked?.();
    },
    /** Extracts a title's embedded text subtitles into the cache (so the player never waits on a demux); marks it done. */
    async subtitles(item, { signal, onSpawn }) {
      if (!fs.existsSync(item.path)) return; // an unplugged drive: left for a later scan, not marked
      try {
        await extractEmbeddedTracks(item, config, { signal, onSpawn });
      } catch (err) {
        if (signal?.aborted) throw err;
        // A file ffmpeg can't read: the on-demand route will say so; the title is still marked so this isn't retried every scan.
      }
      store.db.run("UPDATE items SET media = json_set(media, '$.subtitlesExtracted', json('true')) WHERE id = ?", item.id);
    },
    // v0.28: a song's loudness for even volume; one that can't be measured is marked so it isn't retried every time.
    async loudness(item, { signal, onSpawn } = {}) {
      if (!fs.existsSync(item.path)) return;
      let found = null;
      try {
        found = await measureLoudness(config.ffmpegPath, item.path, { signal, onSpawn });
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      store.db.run("UPDATE items SET media = json_set(media, '$.loudness', json(?)) WHERE id = ?", JSON.stringify(found || { none: true }), item.id);
    },
    intros(seasonId, { signal, onSpawn }) {
      // v0.28: TheIntroDB's shared timestamps fill gaps unless an admin turned them off.
      const community = settings?.get('communityTimestamps') === false ? null : { base: INTRODB_BASE };
      return runIntroJob({ seasonId, store, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, signal, onSpawn, community });
    },
  };
}
