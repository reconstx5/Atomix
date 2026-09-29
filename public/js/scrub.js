// Scrubbing the seek bar with a remote: arrow presses move a marker (with a
// preview picture) and the video only jumps when you press OK or stop pressing.
// That also means one ffmpeg restart per scrub on converted streams, instead of
// one per press. Pure: the player passes the time in, so this is easy to test.

// [held for at least (ms), seconds per press], longest hold first.
export const STEPS = [
  [4000, 60],
  [1500, 30],
  [0, 10],
];
export const COMMIT_AFTER_MS = 1000;
const HOLD_GAP_MS = 250; // presses closer together than this count as holding the button

export class Scrubber {
  constructor({ duration = () => 0 } = {}) {
    this.duration = duration;
    this.reset();
  }

  reset() {
    this.active = false;
    this.target = 0;
    this.dir = 0;
    this.heldSince = 0;
    this.lastPress = -Infinity;
  }

  /** An arrow press: `dir` is −1 or +1, `from` the playing position when a scrub begins. */
  press(dir, { from, now, repeat = false }) {
    if (!this.active) {
      this.active = true;
      this.target = from;
    }
    const held = dir === this.dir && (repeat || now - this.lastPress < HOLD_GAP_MS);
    if (!held) this.heldSince = now;
    this.dir = dir;
    this.lastPress = now;
    const step = STEPS.find(([ms]) => now - this.heldSince >= ms)[1];
    const total = this.duration();
    const max = total > 0 ? Math.max(0, total - 1) : Infinity;
    this.target = Math.max(0, Math.min(max, this.target + dir * step));
    return this.target;
  }

  /** True once the viewer has stopped pressing for long enough. */
  due(now) {
    return this.active && now - this.lastPress >= COMMIT_AFTER_MS;
  }

  /** Finish: the time to jump to, or null if there's no scrub in progress. */
  commit() {
    if (!this.active) return null;
    const t = this.target;
    this.reset();
    return t;
  }

  cancel() {
    const was = this.active;
    this.reset();
    return was;
  }
}
