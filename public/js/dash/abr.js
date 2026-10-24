// Choosing a quality level for the DASH player: start sensibly, go up only with buffer to spare, come down at once
// when the buffer runs low, and never above what the screen can show. Pure.

const FIRST_PICK_BPS = 1_000_000;
const UP_BUFFER = 10;
const DOWN_BUFFER = 4;
const SAFETY = 0.7;

/**
 * @param {{ id, bandwidth, height?: number|null }[]} reps
 * @param {{ throughputBps?: number|null, bufferedSec?: number, maxHeight?: number, current?: object|null }} state
 */
export function pickRepresentation(reps, { throughputBps = null, bufferedSec = 0, maxHeight = Infinity, current = null } = {}) {
  const sorted = [...reps].sort((a, b) => a.bandwidth - b.bandwidth);
  // The screen's cap, rounded up to a level: a 600 px window still gets the 720 level, not 540.
  const heights = sorted.map((r) => r.height).filter((h) => h > 0);
  const capLevel = heights.filter((h) => h >= maxHeight).sort((a, b) => a - b)[0] ?? Infinity;
  const allowed = sorted.filter((r) => !(r.height > 0) || r.height <= capLevel);
  const pool = allowed.length ? allowed : sorted.slice(0, 1);
  const lowest = pool[0];

  let target;
  if (throughputBps == null) target = pool.find((r) => r.bandwidth >= FIRST_PICK_BPS) || lowest;
  else target = [...pool].reverse().find((r) => r.bandwidth <= throughputBps * SAFETY) || lowest;
  if (!current) return target;

  const cur = sorted.find((r) => r.id === current.id) || current;
  if (!pool.some((r) => r.id === cur.id)) return target; // the screen got smaller (or the level went away)
  if (target.bandwidth > cur.bandwidth) return bufferedSec >= UP_BUFFER ? target : cur;
  if (target.bandwidth < cur.bandwidth) return bufferedSec < DOWN_BUFFER ? target : cur;
  return cur;
}
