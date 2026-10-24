// Where a remuxed stream can really start: ffmpeg with `-c:v copy` begins at the keyframe before the time asked,
// so the player is told that time (else its clock runs ahead of the picture by up to a keyframe interval).
import { run } from '../library/probe.js';
import { headerArgs } from './ffheaders.js';

/**
 * The last keyframe at or before `start` seconds, read from the packet index only (fast), or null when ffprobe
 * can't say (then the caller keeps the time it was asked for).
 * @returns {Promise<number|null>}
 */
export async function keyframeAtOrBefore(ffprobePath, file, start, { headers = null, timeout = 10000 } = {}) {
  const from = Math.max(0, start - 10);
  try {
    const out = await run(
      ffprobePath,
      // The interval's end is exclusive (a packet at exactly `start` would be left out), so read a second past it.
      ['-v', 'error', ...(headers ? headerArgs(headers) : []), '-select_streams', 'v:0', '-read_intervals', `${from.toFixed(3)}%${(start + 1).toFixed(3)}`, '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file],
      { timeout },
    );
    let best = null;
    for (const line of out.toString('utf8').split('\n')) {
      const [pts, flags] = line.trim().split(',');
      const t = Number(pts);
      if (!Number.isFinite(t) || !/K/.test(flags || '')) continue;
      if (t <= start + 0.001 && (best == null || t > best)) best = t;
    }
    // Rounded UP to the millisecond: `-ss` at or just after the keyframe starts there; a hair before it would start
    // a whole keyframe interval earlier.
    return best == null ? null : Math.max(0, Math.ceil(best * 1000 - 1e-6) / 1000);
  } catch {
    return null;
  }
}
