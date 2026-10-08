// One still frame for an extra (a tenth of the way in), kept with the other artwork in data/images.
import path from 'node:path';
import { run } from '../library/probe.js';

export async function makeThumb({ ffmpegPath, imagesDir, item, onSpawn, timeout = 2 * 60 * 1000 }) {
  const name = `thumb-${item.id}-${item.size ?? 0}-${item.mtime ?? 0}.jpg`;
  const at = Math.max(0, Math.min((item.duration || 0) * 0.1, 600));
  await run(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', at.toFixed(2), '-i', item.path, '-map', '0:V:0', '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(imagesDir, name)],
    { timeout, onSpawn },
  );
  return `cache:${name}`;
}
