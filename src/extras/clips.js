// Card preview clips: 5 silent seconds (640 px wide, H.264 Main) from the middle of a title, or from its
// local trailer, for cards that play on rest. Lives beside the seek-bar sheets: data/previews/<item>/clip.mp4.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';
import { TONEMAP } from './previews.js';

export const CLIP_SECONDS = 5;
export const CLIP_WIDTH = 640;

/** The ffmpeg argv for one clip (pure, for tests). `out` is appended when given. */
export function clipArgs({ file, start, duration = CLIP_SECONDS, width = CLIP_WIDTH, hdrFilter = null, out = null }) {
  const vf = `scale=${width}:-2,${hdrFilter ? TONEMAP : 'format=yuv420p'}`;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', String(start), '-i', file, '-t', String(duration), '-an', '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'main', '-movflags', '+faststart',
    '-map', '0:V:0', '-sn', '-dn', '-preset', 'veryfast', '-crf', '30', '-maxrate', '1200k', '-bufsize', '2400k',
    ...(out ? [out] : []),
  ];
}

/** Where to start: 35 % in (a trailer: 15 %), or just after an intro or recap that ends later, if 5 s still fit after it. */
export function clipStart(item, markers, isTrailer) {
  const d = Number(item.duration) || 0;
  if (d <= CLIP_SECONDS) return 0;
  let start = d * (isTrailer ? 0.15 : 0.35);
  if (!isTrailer) {
    for (const k of ['intro', 'recap']) {
      const end = markers?.[k]?.end;
      if (end != null && end + 1 > start && end + 1 < d - CLIP_SECONDS) start = end + 1;
    }
  }
  return Math.round(Math.min(start, d - CLIP_SECONDS) * 100) / 100;
}

/** Make `<dir>/<item id>/clip.mp4` (written beside it first, then moved in, so a half-made clip never shows). */
export async function makeClip({ ffmpegPath, dir, itemId, file, start, hdrFilter = null, onSpawn, timeout = 5 * 60 * 1000 }) {
  const folder = path.join(dir, String(itemId));
  fs.mkdirSync(folder, { recursive: true });
  const tmp = path.join(folder, 'clip.tmp.mp4');
  try {
    await run(ffmpegPath, clipArgs({ file, start, hdrFilter, out: tmp }), { timeout, onSpawn });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) throw new Error('ffmpeg made no clip.');
    fs.renameSync(tmp, path.join(folder, 'clip.mp4'));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
