// Seek-bar previews: one fast ffmpeg pass that decodes only keyframes and tiles a
// small frame every few seconds into JPEG sheets (10 × 10 tiles per sheet).
// Files with few keyframes give repeated tiles, which is fine for a preview.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';

export const TILE_WIDTH = 320;
export const GRID = 10;
// HDR → normal colours, only used when this ffmpeg has zscale and tonemap.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** The layout for a title's previews, or null when it can't have any. A rotated (phone) video is sized as it plays. */
export function planPreviews(duration, video) {
  if (!(duration > 0) || !(video?.width > 0) || !(video?.height > 0)) return null;
  const interval = duration < 1200 ? 5 : 10;
  const sideways = video.rotation === 90 || video.rotation === 270;
  const [w, h] = sideways ? [video.height, video.width] : [video.width, video.height];
  const height = Math.max(2, Math.round((TILE_WIDTH * h) / w / 2) * 2);
  const count = Math.max(1, Math.ceil(duration / interval));
  return { interval, width: TILE_WIDTH, height, columns: GRID, rows: GRID, count, sheets: Math.ceil(count / (GRID * GRID)) };
}

/** The ffmpeg argv for a title's sheets (pure, for tests). */
export function previewArgs({ item, plan, tonemap, tmp }) {
  // setpts=PTS-STARTPTS: count from the first picture. Files whose audio starts first (Opus/AAC
  // priming) otherwise put it at +0.007 s or so, which shifts every tile one slot late.
  // round=up: tile k is the last frame at or before k × interval (the default, near, takes the last
  // frame up to half an interval *after* it, so pictures ran up to 5 s late).
  // The tone map runs after the scale: in float at 320 px wide instead of at 4K, which is many times faster.
  // -hwaccel auto: keyframe-only decoding on the GPU where the driver allows it, otherwise software, silently.
  const vf = `setpts=PTS-STARTPTS,fps=1/${plan.interval}:round=up,scale=${plan.width}:${plan.height}${tonemap ? `,${TONEMAP}` : ''},tile=${GRID}x${GRID}`;
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-hwaccel', 'auto', '-skip_frame', 'nokey', '-i', item.path, '-map', '0:V:0', '-an', '-sn', '-dn', '-vf', vf, '-q:v', '5', '-f', 'image2', path.join(tmp, '%d.jpg')];
}

/**
 * Make `<dir>/<item.id>/1.jpg, 2.jpg…`. Writes into `<id>.tmp` first and swaps it
 * in at the end, so a half-finished run never shows. Resolves to the layout.
 */
export async function generatePreviews({ ffmpegPath, dir, item, media, hdrFilters = false, onSpawn, timeout = 30 * 60 * 1000 }) {
  const plan = planPreviews(item.duration, media?.video);
  if (!plan) throw new Error('There is no video to make previews from.');
  const final = path.join(dir, String(item.id));
  const tmp = `${final}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await run(ffmpegPath, previewArgs({ item, plan, tonemap: Boolean(media.video.hdr && hdrFilters), tmp }), { timeout, onSpawn });
    const sheets = fs.readdirSync(tmp).filter((f) => /^\d+\.jpg$/.test(f)).length;
    if (!sheets) throw new Error('ffmpeg made no pictures.');
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    return { ...plan, sheets, count: Math.min(plan.count, sheets * GRID * GRID) };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

export function removePreviews(dir, itemId) {
  fs.rmSync(path.join(dir, String(itemId)), { recursive: true, force: true });
}
