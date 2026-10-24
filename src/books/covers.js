// A book's or a comic's cover (v0.22): the picture from inside the file, scaled by ffmpeg to 600 px wide and kept
// in the cache (cacheDir/books/<id>-cover.jpg). When ffmpeg can't read it, the picture is kept as it came.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';
import { sniffImage } from '../library/images.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

/** @returns {Promise<string|null>} an image reference (`file:<path>`), or null when `bytes` isn't a picture */
export async function bookCover(config, itemId, bytes) {
  const type = bytes && sniffImage(bytes);
  if (!type || !EXT[type]) return null;
  const dir = path.join(config.cacheDir, 'books');
  await fs.promises.mkdir(dir, { recursive: true });
  const src = path.join(dir, `${itemId}-cover-src.${EXT[type]}`);
  const out = path.join(dir, `${itemId}-cover.jpg`);
  await fs.promises.writeFile(src, bytes);
  try {
    await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', "scale='min(600,iw)':-2", '-frames:v', '1', '-q:v', '3', out], { timeout: 30000 });
    await fs.promises.rm(src, { force: true });
    return `file:${out}`;
  } catch {
    return `file:${src}`;
  }
}

/** Remove a title's cached cover (the title went). */
export function forgetCover(config, itemId) {
  const dir = path.join(config.cacheDir, 'books');
  for (const name of [`${itemId}-cover.jpg`, ...Object.values(EXT).map((e) => `${itemId}-cover-src.${e}`)]) fs.rmSync(path.join(dir, name), { force: true });
}
