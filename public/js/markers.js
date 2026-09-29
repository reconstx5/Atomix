// What the player should do about intros and credits (pure, shared with tests).

/** The Skip intro button goes away this many seconds before the intro ends. */
export const HIDE_BEFORE_END = 2;

/** The intro range to offer skipping, kept inside the video, or null. */
export function introRange(markers, duration) {
  const m = markers?.intro;
  if (!m || !(m.end > m.start)) return null;
  const start = Math.max(0, m.start);
  const end = duration > 0 ? Math.min(m.end, duration) : m.end;
  return end - start > HIDE_BEFORE_END ? { start, end } : null;
}

export const inIntro = (range, t) => Boolean(range) && t >= range.start && t < range.end - HIDE_BEFORE_END;

/** How much of the intro is left (1 → 0), for the thin bar on the button. */
export const introLeft = (range, t) => (range ? Math.max(0, Math.min(1, (range.end - t) / (range.end - range.start))) : 0);

/** When Up next should appear: when the credits start, or null (= at the very end). */
export function upNextAt(markers, duration) {
  const c = markers?.credits;
  if (!c || !(c.start > 0)) return null;
  if (duration > 0 && c.start >= duration - 1) return null;
  return c.start;
}

/** "0:42", "1:02:03", "92" or "1:32.5" → seconds; null if it isn't a time. */
export function parseClock(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return null;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

/**
 * Whether the Skip intro button may take focus: only when nothing the viewer is
 * using has it (the player itself, the video or the page), never from a control.
 */
export function focusIsFree(active, root) {
  return !active || active === root || active.tagName === 'BODY' || active.tagName === 'VIDEO';
}

/**
 * Up next at the credits: start once when playback reaches `at`; seeking back to
 * well before the credits (more than a second) arms it again.
 */
export function creditsStep({ at, now, armed }) {
  if (at == null) return { armed, start: false };
  if (now < at - 1) return { armed: true, start: false };
  if (now < at) return { armed, start: false };
  return { armed: false, start: armed };
}

/**
 * The position to save for "continue watching": once playback reaches the credits
 * (or the end), the episode counts as finished, so leaving from Up next marks it watched.
 */
export function reportedPosition({ position, duration, ended, markers }) {
  if (!(duration > 0)) return position;
  const credits = upNextAt(markers, duration);
  return ended || (credits != null && position >= credits) ? duration : position;
}
