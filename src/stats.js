// Stats from play history: hours watched (films, episodes) and listened (songs) this week / month / year, the most
// played films, shows, artists and songs (counted plays only), and when — a day-of-week × hour grid in the viewer's
// own time. Hours come from listened time, so a skipped song's seconds count but it never tops a list.
import { HttpError } from './http/router.js';
import { SPOKEN_KINDS } from './library/kinds.js';

const DAY = 86400_000;
export const RANGES = { week: 7, month: 30, year: 365 };
const hours = (s) => Math.round(((s || 0) / 3600) * 10) / 10;

/**
 * @param {{ range?: 'week'|'month'|'year', tzOffset?: number (minutes, as the browser's getTimezoneOffset), now?: number }} o
 */
/** The weekday (Monday 0) and hour of `ms` in an IANA zone, at that moment's own offset (summer time included). */
function zoneParts(tz) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  } catch {
    return null; // not a zone Intl knows: the fixed offset instead
  }
  const DAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return (ms) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return [DAYS[parts.weekday], Number(parts.hour) % 24];
  };
}

export function profileStats(db, profileId, { range = 'week', tzOffset = 0, tz = null, now = Date.now() } = {}) {
  if (!RANGES[range]) throw new HttpError(400, 'Choose a week, a month or a year.');
  const since = now - RANGES[range] * DAY;
  const rows = db.all(
    `SELECT p.started_at, p.seconds, p.counted, p.pages, i.id, i.kind, i.title, i.show_id, s.title AS show_title
     FROM plays p JOIN items i ON i.id = p.item_id LEFT JOIN items s ON s.id = i.show_id
     WHERE p.profile_id = ? AND p.started_at >= ?`,
    profileId,
    since,
  );
  let watched = 0;
  let listened = 0;
  let read = 0; // v0.22: books and comics
  let pages = 0;
  const inZone = tz ? zoneParts(String(tz)) : null; // each play at its own date's offset
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const tally = { films: new Map(), shows: new Map(), artists: new Map(), songs: new Map() };
  const bump = (map, id, title) => {
    const t = map.get(id) || { id, title, plays: 0 };
    t.plays++;
    map.set(id, t);
  };
  for (const r of rows) {
    const song = r.kind === 'track' || SPOKEN_KINDS.has(r.kind); // listening: songs, podcast episodes, audiobooks
    const reading = r.kind === 'book' || r.kind === 'comic';
    if (reading) {
      read += r.seconds;
      pages += r.pages || 0;
    } else if (song) listened += r.seconds;
    else watched += r.seconds;
    if (inZone) {
      const [d, hr] = inZone(r.started_at);
      grid[d][hr] += r.seconds;
    } else {
      const local = new Date(r.started_at - Number(tzOffset || 0) * 60_000);
      grid[(local.getUTCDay() + 6) % 7][local.getUTCHours()] += r.seconds;
    }
    if (!r.counted) continue;
    if (r.kind === 'movie') bump(tally.films, r.id, r.title);
    else if (r.kind === 'episode' && r.show_id) bump(tally.shows, r.show_id, r.show_title);
    else if (song) {
      bump(tally.songs, r.id, r.title);
      if (r.show_id) bump(tally.artists, r.show_id, r.show_title);
    }
  }
  const top = (map) => [...map.values()].sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title)).slice(0, 10);
  return {
    range,
    watchedHours: hours(watched),
    listenedHours: hours(listened),
    readHours: hours(read),
    pagesRead: pages,
    topFilms: top(tally.films),
    topShows: top(tally.shows),
    topArtists: top(tally.artists),
    topSongs: top(tally.songs),
    grid: grid.map((d) => d.map(hours)),
  };
}

/** Every profile's hours (watched + listened) for the last week, month and year. */
export function householdStats(db, { now = Date.now() } = {}) {
  const sum = (pid, days) => db.get('SELECT COALESCE(SUM(seconds), 0) AS s FROM plays WHERE profile_id = ? AND started_at >= ?', pid, now - days * DAY).s;
  return db
    .all('SELECT p.id, p.name, p.kids FROM profiles p ORDER BY p.created_at, p.id')
    .map((p) => ({ profileId: p.id, name: p.name, kids: Boolean(p.kids), week: hours(sum(p.id, 7)), month: hours(sum(p.id, 30)), year: hours(sum(p.id, 365)) }));
}
