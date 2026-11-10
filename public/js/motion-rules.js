// Atomix's motion, "Capture" (v0.28): the rules that need no page, so they can be tested on their own.
// The idea comes from the Atomix mark: the selected thing is the nucleus and settles into place; going deeper
// comes toward you, Back goes the other way, and moving between sections is a flat fade.

/**
 * How much moves on this device: 'full', 'reduce' (fades and the focus ring, nothing grows or travels) or 'none'
 * (the ring appears at once, nothing animates). `modern`: the browser has the features the motion is built on —
 * old TV browsers don't, and there the plain page is the experience.
 */
export function motionTier({ systemReduce, profileReduce, modern }) {
  if (!modern) return 'none';
  return systemReduce || profileReduce ? 'reduce' : 'full';
}

/** How the remote scrolls the selection into view: smoothly for a single press, at once while a key is held. */
export function scrollBehavior({ tier, repeat }) {
  return tier === 'full' && !repeat ? 'smooth' : 'auto';
}

/** The address changed to `now`: the pages visited afterwards (a new list) and whether this was Back. */
export function historyStep(visited, now) {
  if (visited.length > 1 && visited[visited.length - 2] === now) return { visited: visited.slice(0, -1), dir: 'back' };
  if (visited[visited.length - 1] === now) return { visited, dir: 'none' };
  return { visited: [...visited, now], dir: 'forward' };
}

/**
 * The screen change to play: 'open' (a card was opened: its poster leads the way in), 'back' (the reverse),
 * 'section' (a flat crossfade) or 'none'. Only between two pages, on browsers with view transitions.
 */
export function pickTransition({ tier, supported, dir, fromPage, toPage, opened }) {
  if (tier === 'none' || !supported || !fromPage || !toPage || dir === 'none') return 'none';
  const kind = dir === 'back' ? 'back' : opened ? 'open' : 'section';
  return tier === 'reduce' ? 'section' : kind;
}

// The signature curve: a spring that leaves at speed (it answers the key press at once), then overshoots its move by
// under a tenth and settles, so a selected card "locks in" rather than just stopping (on a card grown 8%, the overshoot
// is about half a percent of its size). Settled by the end. Used for scale only: colours and fades never overshoot.
const ZETA = 0.65; // damping ratio
const OMEGA = 7.5 / ZETA; // settled (within 0.1%) by the end
const START = 5; // the speed it leaves at
function spring(t) {
  const wd = OMEGA * Math.sqrt(1 - ZETA * ZETA);
  return 1 - Math.exp(-ZETA * OMEGA * t) * (Math.cos(wd * t) + ((ZETA * OMEGA - START) / wd) * Math.sin(wd * t));
}
const STEPS = 48;
export const SETTLE_POINTS = Array.from({ length: STEPS + 1 }, (_, i) => (i === STEPS ? 1 : Math.round(spring(i / STEPS) * 1000) / 1000));
/** The curve as CSS (the linear() easing function). */
export const SETTLE_EASING = `linear(${SETTLE_POINTS.join(', ')})`;
