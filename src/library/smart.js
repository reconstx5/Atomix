// Smart playlists: a set of rules ({ field, op, value }, matched all or any), a sort and a limit, worked out each
// time the list is opened or played — never stored — and always for the viewer: their library access and Kids rules,
// their stars, hearts and plays. Songs take their year and genre from their album when they have none; episodes
// take genre, stars, heart and age rating from their show. Text is compared without case and matched literally.
import { HttpError } from '../http/router.js';

const DAY = 86400_000;
const CAP = 1000;
const MAX_RULES = 20;
const MAX_TEXT = 200;

const TEXT_OPS = ['is', 'isNot', 'contains'];
const NUMBER_OPS = ['is', 'isNot', 'gte', 'lte', 'between'];
const DATE_OPS = ['inLast', 'notInLast'];

/** Each field: its label (as the builder shows it), its type, and the ops it takes. */
const FIELDS = {
  genre: { label: 'genre', type: 'genres', ops: TEXT_OPS },
  artist: { label: 'artist', type: 'text', ops: TEXT_OPS, media: 'music' },
  albumArtist: { label: 'album artist', type: 'text', ops: TEXT_OPS, media: 'music' },
  album: { label: 'album', type: 'text', ops: TEXT_OPS, media: 'music' },
  year: { label: 'year', type: 'number', ops: [...NUMBER_OPS, 'set', 'notSet'] },
  stars: { label: 'stars', type: 'number', ops: [...NUMBER_OPS, 'set', 'notSet'] },
  favourite: { label: 'favourite', type: 'bool', ops: ['is'] },
  playCount: { label: 'play count', type: 'number', ops: NUMBER_OPS },
  lastPlayed: { label: 'last played', type: 'date', ops: [...DATE_OPS, 'set', 'notSet'] },
  added: { label: 'date added', type: 'date', ops: DATE_OPS },
  length: { label: 'length', type: 'number', ops: NUMBER_OPS },
  kind: { label: 'kind', type: 'kind', ops: ['is'], media: 'video' },
  ageRating: { label: 'age rating', type: 'number', ops: [...NUMBER_OPS, 'set', 'notSet'], media: 'video' },
};

export const SORTS = ['random', 'added', 'stars', 'mostPlayed', 'lastPlayed', 'title', 'year'];

/** The fields a media's rules may use, with labels and ops (the builder reads the same table). */
export function fieldsFor(media) {
  return Object.entries(FIELDS)
    .filter(([, f]) => !f.media || f.media === media)
    .map(([key, f]) => ({ key, label: f.label, type: f.type, ops: f.ops }));
}

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/**
 * Check a rule set and return it cleaned up (numbers as numbers, trimmed text).
 * @returns {{ match: 'all'|'any', rules: Array<{field, op, value?}>, sort: string, limit: { items?: number, minutes?: number } }}
 */
export function validateRules(media, input = {}) {
  if (media !== 'music' && media !== 'video') throw new HttpError(400, 'A smart playlist is for songs or for videos.');
  const rules = input.rules === undefined ? [] : input.rules;
  if (!Array.isArray(rules)) throw new HttpError(400, 'Add some rules, or none for everything.');
  if (rules.length > MAX_RULES) throw new HttpError(400, `A smart playlist has at most ${MAX_RULES} rules.`);
  const clean = rules.map((r, i) => {
    const n = i + 1;
    const f = FIELDS[r?.field];
    if (!f || (f.media && f.media !== media)) throw new HttpError(400, `Rule ${n}: Atomix doesn't know "${String(r?.field ?? '').slice(0, 40)}".`);
    if (!f.ops.includes(r.op)) throw new HttpError(400, `Rule ${n}: "${String(r.op ?? '').slice(0, 40)}" doesn't work with ${f.label}.`);
    const out = { field: r.field, op: r.op };
    if (r.op === 'set' || r.op === 'notSet') return out;
    if (f.type === 'text' || f.type === 'genres') {
      const v = typeof r.value === 'string' ? r.value.trim() : '';
      if (!v || v.length > MAX_TEXT) throw new HttpError(400, `Rule ${n}: give some text (${MAX_TEXT} characters at most).`);
      out.value = v;
    } else if (f.type === 'bool') {
      if (typeof r.value !== 'boolean') throw new HttpError(400, `Rule ${n}: choose yes or no.`);
      out.value = r.value;
    } else if (f.type === 'kind') {
      if (r.value !== 'movie' && r.value !== 'episode') throw new HttpError(400, `Rule ${n}: choose Film or Episode.`);
      out.value = r.value;
    } else if (f.type === 'date') {
      const d = num(r.value);
      if (!Number.isInteger(d) || d < 1 || d > 3650) throw new HttpError(400, `Rule ${n}: give a number of days.`);
      out.value = d;
    } else if (r.op === 'between') {
      const [a, b] = Array.isArray(r.value) ? r.value.map(num) : [];
      if (!(Array.isArray(r.value) && r.value.length === 2 && Number.isFinite(a) && Number.isFinite(b) && a <= b)) throw new HttpError(400, `Rule ${n}: give two numbers, lowest first.`);
      out.value = [a, b];
    } else {
      const v = num(r.value);
      if (!Number.isFinite(v)) throw new HttpError(400, `Rule ${n}: give a number.`);
      out.value = v;
    }
    return out;
  });
  const sort = input.sort === undefined ? 'random' : input.sort;
  if (!SORTS.includes(sort)) throw new HttpError(400, 'Choose how to sort.');
  const lim = input.limit || {};
  const limit = {};
  if (lim.items !== undefined && lim.items !== null) {
    const v = num(lim.items);
    if (!Number.isInteger(v) || v < 1 || v > CAP) throw new HttpError(400, 'Give a limit of 1 to 1000 items or 1 to 10000 minutes.');
    limit.items = v;
  } else if (lim.minutes !== undefined && lim.minutes !== null) {
    const v = num(lim.minutes);
    if (!Number.isInteger(v) || v < 1 || v > 10000) throw new HttpError(400, 'Give a limit of 1 to 1000 items or 1 to 10000 minutes.');
    limit.minutes = v;
  }
  return { match: input.match === 'any' ? 'any' : 'all', rules: clean, sort, limit };
}

/** The columns each media's rules and sorts read, worked out once per row (inner query). */
function columns(media) {
  if (media === 'music') {
    return {
      from: 'FROM items i JOIN items al ON al.id = i.parent_id LEFT JOIN items ar ON ar.id = i.show_id LEFT JOIN user_ratings ur ON ur.item_id = i.id AND ur.profile_id = ?',
      kinds: "i.kind = 'track'",
      extra: `al.title AS album_title, al.poster AS album_poster, al.metadata_at AS album_meta,
        CASE WHEN i.genres IS NULL OR i.genres = '[]' THEN al.genres ELSE i.genres END AS s_genres,
        COALESCE(i.year, al.year) AS s_year, i.artist AS s_artist, ar.title AS s_albumArtist, al.title AS s_album`,
    };
  }
  return {
    from: `FROM items i LEFT JOIN items sh ON sh.id = i.show_id
      LEFT JOIN user_ratings ur ON ur.item_id = CASE WHEN i.kind = 'episode' THEN i.show_id ELSE i.id END AND ur.profile_id = ?`,
    kinds: "i.kind IN ('movie', 'episode')",
    extra: `CASE WHEN i.kind = 'episode' AND (i.genres IS NULL OR i.genres = '[]') THEN sh.genres ELSE i.genres END AS s_genres,
      COALESCE(i.year, CAST(substr(i.air_date, 1, 4) AS INTEGER), sh.year) AS s_year,
      COALESCE(i.min_age, sh.min_age) AS s_ageRating, i.kind AS s_kind`,
  };
}

const COL = { year: 's_year', stars: 's_stars', playCount: 's_playCount', lastPlayed: 's_lastPlayed', added: 'added_at', length: 's_length', ageRating: 's_ageRating', artist: 's_artist', albumArtist: 's_albumArtist', album: 's_album', kind: 's_kind', favourite: 's_favourite' };
const like = (v) => `%${v.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** One rule → SQL over the inner query's columns, with its parameters. */
function ruleSql(rule, now) {
  const f = FIELDS[rule.field];
  const v = rule.value;
  if (f.type === 'genres') {
    const any = (cond) => `EXISTS (SELECT 1 FROM json_each(s_genres) g WHERE ${cond})`;
    if (rule.op === 'is') return [any('lower(g.value) = lower(?)'), [v]];
    if (rule.op === 'isNot') return [`NOT ${any('lower(g.value) = lower(?)')}`, [v]];
    return [any("g.value LIKE ? ESCAPE '\\'"), [like(v)]];
  }
  const c = COL[rule.field];
  if (rule.op === 'set') return [`${c} IS NOT NULL`, []];
  if (rule.op === 'notSet') return [`${c} IS NULL`, []];
  if (f.type === 'text') {
    if (rule.op === 'is') return [`lower(${c}) = lower(?)`, [v]];
    if (rule.op === 'isNot') return [`lower(COALESCE(${c}, '')) != lower(?)`, [v]];
    return [`${c} LIKE ? ESCAPE '\\'`, [like(v)]];
  }
  if (f.type === 'bool') return [`${c} = ?`, [v ? 1 : 0]];
  if (f.type === 'kind') return [`${c} = ?`, [v]];
  if (f.type === 'date') {
    const since = now - v * DAY;
    return rule.op === 'inLast' ? [`${c} >= ?`, [since]] : [`(${c} IS NULL OR ${c} < ?)`, [since]];
  }
  switch (rule.op) {
    case 'is': return [`${c} = ?`, [v]];
    case 'isNot': return [`(${c} IS NULL OR ${c} != ?)`, [v]];
    case 'gte': return [`${c} >= ?`, [v]];
    case 'lte': return [`${c} <= ?`, [v]];
    default: return [`${c} BETWEEN ? AND ?`, v];
  }
}

const ORDER = {
  random: null, // seeded, below
  added: 'added_at DESC',
  stars: 's_stars IS NULL, s_stars DESC',
  mostPlayed: 's_playCount DESC',
  lastPlayed: 's_lastPlayed IS NULL, s_lastPlayed DESC',
  title: null,
  year: 's_year IS NULL, s_year DESC',
};

/**
 * The list's items for this viewer, in the list's order and within its limit.
 * @param {object} list a lists row (media, rules JSON)
 * @param {{ seed?: number, now?: number }} [opts] seed: the shuffle for sort 'random' (same seed, same order)
 */
export function smartRows(db, library, list, viewer, { seed = 0, now = Date.now() } = {}) {
  let set;
  try {
    set = validateRules(list.media, typeof list.rules === 'string' ? JSON.parse(list.rules || '{}') : list.rules || {});
  } catch {
    return []; // a stored set that no longer checks out (a field removed in a later version) lists nothing
  }
  const pid = viewer?.profileId || 0;
  const cols = columns(list.media);
  const vis = library.visibility(viewer, 'i');
  const inner = `SELECT i.*, ${cols.extra},
      ur.stars AS s_stars, COALESCE(ur.favourite, 0) AS s_favourite,
      (SELECT COUNT(*) FROM plays p WHERE p.profile_id = ? AND p.item_id = i.id AND p.counted = 1) AS s_playCount,
      (SELECT MAX(p.updated_at) FROM plays p WHERE p.profile_id = ? AND p.item_id = i.id) AS s_lastPlayed,
      COALESCE(i.duration, i.runtime * 60) / 60.0 AS s_length
    ${cols.from} WHERE ${cols.kinds} AND ${vis.sql}`;
  const params = [pid, pid, pid, ...vis.params];
  const parts = set.rules.map((r) => ruleSql(r, now));
  const where = parts.length ? parts.map(([s]) => `(${s})`).join(set.match === 'any' ? ' OR ' : ' AND ') : '1';
  for (const [, p] of parts) params.push(...p);
  // Songs by their title (a song's sort title is its track number); films and episodes by their sort title.
  const byTitle = list.media === 'music' ? 'title COLLATE NOCASE, id' : 'COALESCE(sort_title, title) COLLATE NOCASE, id';
  // Shuffle: each seed picks its own odd multiplier, so ids land in a different order per seed (but always the same
  // order for the same seed — what the page showed is what Up next follows).
  const mult = Number((BigInt(((Math.abs(Math.trunc(Number(seed) || 0)) % 2147483647) * 2) + 1) * 2654435761n) % 4294967296n);
  const order = set.sort === 'random' ? `((id * ${mult}) % 4294967296), id` : ORDER[set.sort] ? `${ORDER[set.sort]}, ${byTitle}` : byTitle;
  const take = set.limit.items || CAP;
  const rows = db.all(`SELECT * FROM (${inner}) WHERE ${where} ORDER BY ${order} LIMIT ?`, ...params, take);
  if (!set.limit.minutes) return rows;
  const out = [];
  let total = 0;
  for (const r of rows) {
    const len = (r.s_length || 0) * 60;
    if (out.length && total + len > set.limit.minutes * 60) break;
    out.push(r);
    total += len;
  }
  return out;
}
