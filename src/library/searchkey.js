// Search matching (v0.24): accents, case, punctuation and a leading "the" are ignored. Each item keeps a key of its
// title and original title in items.search_key (letters and digits only, lower-case, no accents). The key starts NULL
// and a title change resets it (a pure-SQL trigger, migration 29); ensureSearchKeys() fills the missing ones just
// before a search, so every write path — and anything writing the database directly — needs nothing new.

/** Lower-case words with accents and punctuation gone: "Schindler's List" → "schindlers list", "Spider-Man" → "spider man". */
export function searchWords(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The key: searchWords without its spaces ("Spider-Man: No Way Home" → "spidermannowayhome"). */
export const searchKey = (text) => searchWords(text).replace(/ /g, '');

const withoutThe = (words) => words.replace(/^the (?=\S)/, '');

/** The keys a query matches on: itself, and without a leading "the". Empty when nothing is left to match. */
export function queryKeys(q) {
  const words = searchWords(q);
  return [...new Set([words, withoutThe(words)].map((w) => w.replace(/ /g, '')).filter(Boolean))];
}

/**
 * How well a title matches a query: 0 it starts with it, 1 one of its words starts it, 2 it contains it, 3 not at all.
 * Both are compared with and without a leading "the".
 */
export function rankTitle(title, q) {
  const keys = queryKeys(q);
  if (!keys.length) return 3;
  const full = searchWords(title);
  let best = 3;
  for (const words of new Set([full, withoutThe(full)])) {
    const list = words.split(' ');
    const key = list.join('');
    for (const k of keys) {
      if (key.startsWith(k)) return 0;
      if (list.some((_, i) => i > 0 && list.slice(i).join('').startsWith(k))) best = Math.min(best, 1);
      else if (key.includes(k)) best = Math.min(best, 2);
    }
  }
  return best;
}

/** `atomix_key(text)` in SQL on this connection. */
export function registerSearchKey(db) {
  db.function('atomix_key', { deterministic: true }, (s) => (s == null ? null : searchKey(String(s))));
}

/** Fill the keys of titles added or renamed since the last search (a partial index makes it free when none are). */
export function ensureSearchKeys(db) {
  try {
    db.run("UPDATE items SET search_key = atomix_key(title) || '|' || COALESCE(atomix_key(original_title), '') WHERE search_key IS NULL");
  } catch {
    // The database is busy (a scan, an outside writer): search with the keys there are; the rest fill next time.
  }
}

/** A WHERE fragment for a stored key (title|original) that starts with a query's key, with or without "the". */
export function keyPrefix(column, q) {
  const keys = queryKeys(q);
  if (!keys.length) return { sql: '0', params: [] };
  const likes = keys.flatMap((k) => [`${k}%`, `%|${k}%`, `the${k}%`]);
  return { sql: `(${likes.map(() => `${column} LIKE ?`).join(' OR ')})`, params: likes };
}

/**
 * A WHERE fragment matching `column` (a key, or `atomix_key(x)`) against a query's keys. Keys are letters and digits
 * only, so LIKE needs no escaping. No keys (a query of only punctuation): matches nothing.
 */
export function keyMatch(column, q) {
  const keys = queryKeys(q);
  if (!keys.length) return { sql: '0', params: [] };
  return { sql: `(${keys.map(() => `${column} LIKE ?`).join(' OR ')})`, params: keys.map((k) => `%${k}%`) };
}
