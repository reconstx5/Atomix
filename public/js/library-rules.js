// Orbit's Movies and TV Shows page (v0.25): the rules with no page in them — the A–Z rail's letters and jumps, what
// counts as in progress, the header's count, where the spotlight starts and what its Play button says.
// Tested in Node (test/library-rules.test.js).

/** The same key as the server's sort title (src/library/parser.js sortTitle): lower case, no leading the/a/an, no punctuation. */
export function sortKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

/** 'A'…'Z', or '#' for a digit, a symbol or another script. */
export function letterOf(item) {
  const key = item?.sortTitle ?? sortKey(item?.title);
  const ch = String(key || '').normalize('NFD').replace(/\p{M}/gu, '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(ch) ? ch : '#';
}

/** The letters with titles, in rail order: # first, then A–Z (accented titles sort last in the list, but E is E). */
export function railLetters(items) {
  const have = new Set(items.map(letterOf));
  return ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((l) => have.has(l));
}

export const jumpIndex = (items, letter) => items.findIndex((it) => letterOf(it) === letter);

export const railShown = ({ sort, q, count }) => sort === 'title' && !q && count >= 20;

export function inProgress(item) {
  if (!item) return false;
  if (item.kind === 'show') return item.unwatched > 0 && item.unwatched < item.childCount;
  const p = item.progress;
  return Boolean(p && !p.watched && p.position > 30);
}

export function posterFraction(item) {
  if (!inProgress(item)) return null;
  if (item.kind === 'show') return (item.childCount - item.unwatched) / item.childCount;
  const dur = item.progress.duration || item.duration;
  return dur ? item.progress.position / dur : null;
}

export function countLine(n, inProgressCount, [one, many]) {
  const base = `${n} ${n === 1 ? one : many}`;
  return inProgressCount > 0 ? `${base} · ${inProgressCount} in progress` : base;
}

export function spotStartItem(items, recent) {
  for (const r of recent || []) {
    const hit = items.find((it) => it.id === r.id);
    if (hit) return hit;
  }
  return items[0] || null;
}

const resumable = (p) => Boolean(p && !p.watched && p.position > 30);

/** The spotlight's primary button: { label, href, position, duration }, or null while a show's details are unknown. */
export function playFor(item, details) {
  if (!item) return null;
  if (item.kind === 'movie') {
    const p = item.progress;
    const r = resumable(p);
    return { label: r ? 'Resume' : 'Play', href: `#/play/${item.id}`, position: r ? p.position : null, duration: r ? p.duration || item.duration : null };
  }
  if (item.kind !== 'show') return null;
  const e = details?.nextEpisode;
  if (!e) return null;
  const code = `S${e.season} · E${e.episode}`;
  const r = resumable(e.progress);
  const label = r ? `Resume ${code}` : inProgress(item) ? `Play ${code}` : 'Play';
  return { label, href: `#/play/${e.id}`, position: r ? e.progress.position : null, duration: r ? e.progress.duration || e.duration : null };
}
