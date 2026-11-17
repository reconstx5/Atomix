// The title page's rules (views/item.js), kept apart so Node can test them (test/item-rules.test.js).
import { formatClock } from './dom.js';

/** Where to resume: null with no progress, when watched or under 30 s in; `left` is null with no duration. */
export function resumeInfo(item) {
  const p = item.progress;
  if (!p || p.watched || p.position < 30) return null;
  const dur = p.duration || item.duration;
  return { position: p.position, left: dur ? Math.max(0, dur - p.position) : null };
}

/** The season a show opens on: the address's (when it is the show's), the next episode's, the first numbered, the first. */
export function selectedSeasonId(seasons, { query = {}, nextEpisode } = {}) {
  const asked = Number(query.season);
  if (asked && seasons.some((s) => s.id === asked)) return asked;
  if (seasons.some((s) => s.id === nextEpisode?.parentId)) return nextEpisode.parentId;
  return seasons.find((s) => s.season > 0)?.id ?? seasons[0]?.id ?? null;
}

/** The episode Orbit's row opens at (and its story describes): the one to resume, else the first unwatched, else the first. */
export function rowStartEpisode(episodes) {
  return episodes.find((e) => resumeInfo(e)) || episodes.find((e) => !e.progress?.watched) || episodes[0];
}

const INTRO_SOURCE = { audio: 'found automatically', chapter: 'from chapters', manual: 'set by hand' };

/** The admin line saying where an episode's intro is. */
export function introText(markers) {
  const m = markers?.intro;
  if (!m) return 'Intro not found yet';
  if (m.none) return 'No intro';
  return `Intro ${formatClock(m.start)}–${formatClock(m.end)} · ${INTRO_SOURCE[m.source] || ''}`;
}

/** A show is watched when nothing in it is left; anything else by its own progress. */
export function isWatched(item) {
  return item.kind === 'show' ? item.unwatched === 0 : Boolean(item.progress?.watched);
}
