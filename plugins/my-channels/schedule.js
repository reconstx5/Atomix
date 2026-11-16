// Your own channels (v0.28): the rules that need no server — reading the channel lines, the repeating schedule, and
// the playout list ffmpeg reads. A channel's schedule is its titles one after another, repeated for ever from EPOCH,
// so any moment maps to a title and how far into it (the guide and the stream always agree).
export const EPOCH = Date.UTC(2026, 0, 1);
const TYPES = new Set(['library', 'genre', 'collection', 'playlist', 'show']);

/** A short stable key for a channel name. */
export function keyOf(name) {
  let h = 2166136261;
  for (const ch of name.toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return `mc-${h.toString(36)}`;
}

/** The settings text → { channels: [{ key, name, rule: { type, value }, order }], problems: [sentence] }. */
export function parseChannels(text) {
  const channels = [];
  const problems = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const m = /^(.+?)\s*=\s*(library|genre|collection|playlist|show)\s+(.+?)(\s*,\s*in order)?$/i.exec(line);
      if (!m || !TYPES.has(m[2].toLowerCase())) {
        problems.push(`Line ${i + 1} isn’t a channel: write it as “Name = library Movies”.`);
        return;
      }
      const name = m[1].trim().slice(0, 60);
      if (channels.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        problems.push(`Line ${i + 1}: there’s already a channel called “${name}”.`);
        return;
      }
      channels.push({ key: keyOf(name), name, rule: { type: m[2].toLowerCase(), value: m[3].trim() }, order: m[4] ? 'order' : 'shuffle' });
    });
  return { channels, problems };
}

/** A small seeded random number generator (the same seed, the same shuffle). */
function rng(seed) {
  let s = 0;
  for (const ch of seed) s = (Math.imul(s, 31) + ch.codePointAt(0)) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The titles in the order the channel plays them: as given, or shuffled the same way every time for `seed`. */
export function buildCycle(items, order, seed) {
  const list = items.filter((i) => i.duration > 0);
  if (order === 'order') return list;
  const rand = rng(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const total = (cycle) => cycle.reduce((s, i) => s + i.duration, 0);

/** What is on at `t` (ms): { index, item, offset (seconds into it) }, or null for an empty channel. */
export function nowPlaying(cycle, t) {
  const len = total(cycle);
  if (!cycle.length || !(len > 0)) return null;
  let pos = (((t - EPOCH) / 1000) % len + len) % len;
  for (let index = 0; index < cycle.length; index++) {
    if (pos < cycle[index].duration) return { index, item: cycle[index], offset: Math.round(pos * 1000) / 1000 };
    pos -= cycle[index].duration;
  }
  return { index: 0, item: cycle[0], offset: 0 };
}

/** The guide from `from` to `to` (ms): back-to-back programmes, the first from its real start. */
export function programmesFor(cycle, from, to) {
  const now = nowPlaying(cycle, from);
  if (!now) return [];
  const out = [];
  let start = from - now.offset * 1000;
  let i = now.index;
  while (start < to && out.length < 2000) {
    const item = cycle[i];
    const end = start + item.duration * 1000;
    out.push({ start: Math.round(start), end: Math.round(end), itemId: item.id, title: item.title, item });
    start = end;
    i = (i + 1) % cycle.length;
  }
  return out;
}

/** ffmpeg's concat list: the title on now from where it is, then the next ones. */
export function concatList(entries) {
  const quote = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
  return `ffconcat version 1.0\n${entries.map((e) => `file ${quote(e.path)}\n${e.inpoint > 0 ? `inpoint ${e.inpoint}\n` : ''}`).join('')}`;
}
