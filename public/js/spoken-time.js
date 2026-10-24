// The spoken-word player's arithmetic (v0.22): a book in several files is one timeline (each part's `start` is
// seconds from the start of the book), chapters are book times, and the sleep timer fades over its last 10 s. Pure —
// no DOM — so the Node tests check it.
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const FADE_MS = 10_000;
const AWAY_MS = 10 * 60_000; // away longer than this: start 5 s earlier
const REWIND = 5;

/**
 * The part a book time falls in, and the offset into it. With no parts (a single file), the time itself. A part whose
 * length isn't known yet (0) shares its start with the next: the time is taken as in it — and, while it is the part
 * playing (`current`), anything from its start on stays in it.
 */
export function partAt(parts, seconds, current = null) {
  const t = Math.max(0, Number(seconds) || 0);
  if (!parts?.length) return { index: 0, offset: t };
  const at = (i) => ({ index: i, offset: Math.min(t - parts[i].start, parts[i].duration || Infinity) });
  const cur = parts[current];
  if (cur && !cur.duration && t >= cur.start) return at(current);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (t < parts[i].start) continue;
    while (i > 0 && !parts[i - 1].duration && parts[i - 1].start === parts[i].start) i--; // an unknown length before it
    return at(i);
  }
  return { index: 0, offset: 0 };
}

/** A part's offset as book time. */
export function bookTime(parts, index, offset) {
  return (parts?.[index]?.start || 0) + Math.max(0, Number(offset) || 0);
}

/** The chapter playing at a book time (before the first one: the first), or null with no chapters. */
export function chapterAt(chapters, seconds) {
  if (!chapters?.length) return null;
  let index = 0;
  chapters.forEach((c, i) => {
    if (seconds >= c.start) index = i;
  });
  return { index, title: chapters[index].title };
}

/** Where to start again: the saved place, 5 s earlier when the last listen was more than 10 minutes ago. */
export function resumePoint(progress, now = Date.now()) {
  if (!progress?.position) return 0;
  const back = progress.updatedAt != null && now - progress.updatedAt > AWAY_MS ? REWIND : 0;
  return Math.max(0, progress.position - back);
}

/** "2 h 14 min left", "12 min left", "Less than a minute left". */
export function leftText(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return 'Less than a minute left';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h) return `${m} min left`;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

/** The volume during the sleep timer's last 10 seconds (linear down to 0). */
export function fadeVolume(base, msLeft) {
  if (msLeft >= FADE_MS) return base;
  return Math.max(0, base * (Math.max(0, msLeft) / FADE_MS));
}
