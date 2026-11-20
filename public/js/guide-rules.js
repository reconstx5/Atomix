// The Live TV guide's decisions, with no page (tested in test/guide-rules.test.js): the window in view, the days and
// the ruler, which programmes are drawn where, the one tab stop, where an arrow key goes (and when it moves the window),
// which guide requests are still needed, the groups, how many rows a ?channel= link needs, and the phone list's
// "the last pick wins" guard.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const SPAN = 2.5 * HOUR; // what's in view
export const STEP = 2 * HOUR; // Earlier / Later, and an arrow off the edge
export const PAGE = 50; // rows drawn at a time

/** The half hour at or before `now`, minus 30 minutes: where the window starts. */
export const windowStart = (now) => Math.floor(now / (30 * MIN)) * 30 * MIN - 30 * MIN;

/** Local midnight of the day `t` is in. */
export const dayStart = (t) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

/** The Day picker: `maxDays` back to a week on; Today, Yesterday and Tomorrow by name, else the date. */
export function dayOptions(now, maxDays, weekday) {
  const out = [];
  for (let d = -maxDays; d <= 7; d++) {
    const t = dayStart(now) + d * DAY;
    out.push({ value: String(t), label: d === 0 ? 'Today' : d === -1 ? 'Yesterday' : d === 1 ? 'Tomorrow' : new Date(t).toLocaleDateString(undefined, { weekday, day: 'numeric', month: 'short' }) });
  }
  return out;
}

/** The longest catch-up of the channels, in days (at least 1): how far back the Day picker goes. */
export const maxCatchupDays = (channels) => Math.max(1, ...channels.map((c) => c.catchupDays || 0));

/** The ruler's times: every 30 minutes in view. */
export function rulerTicks(from) {
  const out = [];
  for (let t = from; t < from + SPAN; t += 30 * MIN) out.push(t);
  return out;
}

/** The now line: hidden when now isn't in view, else how far across (0..1). */
export const nowLine = (now, from) => ({ hidden: !(now >= from && now < from + SPAN), x: (now - from) / SPAN });

/** Where `t` is across the window, as a style value ("40%"). */
export const pct = (t, from) => `${((t - from) / SPAN) * 100}%`;

/** The programmes in view, by start, each with its left and width (cut to the window). */
export function cellsInWindow(programmes, from) {
  return programmes
    .filter((p) => p.end > from && p.start < from + SPAN)
    .sort((a, b) => a.start - b.start)
    .map((p) => {
      const left = Math.max(p.start, from);
      const right = Math.min(p.end, from + SPAN);
      return { p, left: pct(left, from), width: `calc(${((right - left) / SPAN) * 100}% - 4px)` };
    });
}

/** The grid's one tab stop: the first programme on now (in row order), else the first row's first cell. */
export function tabStop(rows) {
  for (const r of rows) {
    const i = r.cells.findIndex((c) => c.state === 'now');
    if (i >= 0) return { channel: r.channel, index: i };
  }
  return rows.length && rows[0].cells.length ? { channel: rows[0].channel, index: 0 } : null;
}

/** The cell covering `at`, else the one starting nearest to it; -1 when there are none. */
export function cellAt(cells, at) {
  const hit = cells.findIndex((c) => c.start <= at && at < c.end);
  if (hit >= 0) return hit;
  let best = -1;
  cells.forEach((c, i) => {
    if (best < 0 || Math.abs(c.start - at) < Math.abs(cells[best].start - at)) best = i;
  });
  return best;
}

/**
 * Where an arrow key goes from cell `cellIndex` of row `rowIndex`. `rows`: { channel, cells: { start, end }[] } as
 * drawn (an empty row's one cell has start and end = from). `column`: the time Up/Down keep (set by the first Up/Down
 * after a Left/Right, so Up undoes Down). Returns null for the page's usual navigation (Up from the first row, Down
 * from the last, other keys); { focus: { channel, at }, column } to move within the window; or
 * { moveWindow, focus, column: null } to move the window by STEP and stay on this channel.
 */
export function arrowMove({ key, rows, rowIndex, cellIndex, from, column }) {
  const row = rows[rowIndex];
  const cell = row?.cells[cellIndex];
  if (!cell) return null;
  const start = cell.start ?? from;
  const end = cell.end ?? from;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const other = rows[rowIndex + (key === 'ArrowDown' ? 1 : -1)];
    if (!other) return null;
    const col = column == null || column < from || column >= from + SPAN ? Math.max(start, from) : column;
    return { focus: { channel: other.channel, at: col }, column: col };
  }
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const dir = key === 'ArrowRight' ? 1 : -1;
  const next = row.cells[cellIndex + dir];
  if (next) return { focus: { channel: row.channel, at: next.start + 1 }, column: null };
  if (dir < 0) return { moveWindow: from - STEP, focus: { channel: row.channel, at: start - 1 }, column: null };
  return { moveWindow: from + STEP, focus: { channel: row.channel, at: Math.max(end, from + SPAN - STEP) }, column: null };
}

/**
 * The guide requests still needed to draw `ids` for the window at `from` (an hour either side), given what was
 * fetched: [lo, hi, Set(ids)][]. The route takes 6 hours and 200 channels at a time. `record`: `fetched` with these
 * requests noted (keep it once they have all answered).
 */
export function guideRequests(fetched, ids, from) {
  const lo = from - HOUR;
  const hi = from + SPAN + HOUR;
  const need = ids.filter((id) => !fetched.some(([a, b, set]) => a <= lo && b >= hi && set.has(id)));
  const requests = [];
  const record = [...fetched];
  for (let i = 0; i < need.length; i += 200) {
    const part = need.slice(i, i + 200);
    for (let t = lo; t < hi; t += 6 * HOUR) requests.push({ from: t, to: Math.min(hi, t + 6 * HOUR), ids: part });
    record.push([lo, hi, new Set(part)]);
  }
  return { requests, record: requests.length ? record : fetched };
}

/** The Group picker: All, Favourites when any channel is one, then the groups. */
export const groupOptions = (all, names) => ['All', ...(all.some((c) => c.favourite) ? ['Favourites'] : []), ...names];

/** The channels of a group (All: every one). */
export const channelsForGroup = (all, group) => (group === 'All' ? all : group === 'Favourites' ? all.filter((c) => c.favourite) : all.filter((c) => c.groups.includes(group)));

/** Rows to draw at first: enough pages to reach the ?channel= one, else one page. */
export function initialRows(shown, wantId) {
  const idx = wantId == null ? -1 : shown.findIndex((c) => c.id === wantId);
  return idx >= 0 ? Math.min(shown.length, Math.ceil((idx + 1) / PAGE) * PAGE) : Math.min(PAGE, shown.length);
}

/** Spoken after a channel's name: an encrypted channel, and (v0.28) one this device can't play. */
export const encWords = (c) => (c.drm ? ', encrypted' : '') + (c.unplayable ? ", can't play here" : '');

/** A last-pick guard: each call gives a current() that is true until the next call (an older answer is dropped). */
export function latest() {
  let n = 0;
  return () => {
    const mine = ++n;
    return () => mine === n;
  };
}
