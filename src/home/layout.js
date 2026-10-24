// Home you can arrange (v0.22): an arrangement is an ordered list of row keys (some hidden) plus pinned rows.
// The household's (an admin's) is the default; a profile keeps its own copy only once it changes something.
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { validatePin, checkPinVisible } from './pins.js';

/** The order /api/home builds its rows in ('*' = every key with that prefix, in the order they were built). */
export const DEFAULT_ORDER = ['continue', 'continue-listening', 'continue-reading', 'live-now', 'watchlist', 'lists', 'recent-*', 'picks', 'plugin:*', 'web-apps'];

const MAX_ENTRIES = 80;
const MAX_PINS = 20;
const MAX_KEY = 80;

/**
 * Rows in the arrangement's order, hidden ones removed. A row the arrangement doesn't name (a library added later,
 * a new kind of row) goes right after the nearest row built before it that the arrangement does place — or first.
 * @template {{key: string}} R
 * @param {R[]} rows in build order
 * @param {{order: {key: string, hidden?: boolean}[]}|null} layout
 * @returns {R[]}
 */
export function applyLayout(rows, layout) {
  if (!layout?.order?.length) return rows;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const hidden = new Set();
  const placed = [];
  for (const e of layout.order) {
    if (!byKey.has(e.key) || placed.includes(e.key)) continue;
    placed.push(e.key);
    if (e.hidden) hidden.add(e.key);
  }
  rows.forEach((r, i) => {
    if (placed.includes(r.key)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = placed.indexOf(rows[j].key);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    placed.splice(at, 0, r.key);
  });
  return placed.filter((k) => !hidden.has(k)).map((k) => byKey.get(k));
}

/** Pin shapes are checked by pins.js; this checks the arrangement itself. Null means "none". */
export function validateLayout(x, checkPin = (p) => p) {
  if (x == null) return null;
  const bad = (why) => {
    throw new HttpError(400, `That arrangement can't be saved: ${why}.`);
  };
  if (typeof x !== 'object' || !Array.isArray(x.order)) bad('it has no order');
  if (x.order.length > MAX_ENTRIES) bad(`more than ${MAX_ENTRIES} rows`);
  const seen = new Set();
  const order = x.order.map((e) => {
    const key = e?.key;
    if (typeof key !== 'string' || !key || key.length > MAX_KEY) bad('a row has a bad name');
    if (seen.has(key)) bad('a row is in it twice');
    seen.add(key);
    return { key, hidden: e.hidden === true };
  });
  const pins = x.pins == null ? [] : x.pins;
  if (!Array.isArray(pins)) bad('its pinned rows are not a list');
  if (pins.length > MAX_PINS) bad(`more than ${MAX_PINS} pinned rows`);
  // A profile's copy remembers which of the household's pins it removed, so they don't come back.
  const removed = x.removed == null ? [] : x.removed;
  if (!Array.isArray(removed) || removed.length > 40 || removed.some((k) => typeof k !== 'string' || !/^pin-[0-9a-f]{8,32}$/.test(k))) bad('its removed rows are wrong');
  return { order, pins: pins.map((p) => checkPin(p)), ...(removed.length ? { removed } : {}) };
}

export class HomeLayouts {
  constructor(db) {
    this.db = db;
  }
  #read(row) {
    return row ? parseJson(row.layout, null) : null;
  }
  household() {
    return this.#read(this.db.get('SELECT layout FROM home_layouts WHERE profile_id IS NULL'));
  }
  profile(profileId) {
    return this.#read(this.db.get('SELECT layout FROM home_layouts WHERE profile_id = ?', profileId));
  }
  /** @returns {{layout: object|null, source: 'profile'|'household'|'default'}} */
  effective(profileId) {
    const own = profileId != null ? this.profile(profileId) : null;
    const house = this.household();
    if (own) {
      // Pinned rows the household added since (and this profile didn't remove) reach it too.
      const named = new Set([...(own.pins || []).map((p) => p.key), ...(own.removed || [])]);
      const extra = (house?.pins || []).filter((p) => !named.has(p.key));
      return { layout: extra.length ? { ...own, pins: [...(own.pins || []), ...extra] } : own, source: 'profile' };
    }
    return house ? { layout: house, source: 'household' } : { layout: null, source: 'default' };
  }
  saveHousehold(layout) {
    this.db.run('DELETE FROM home_layouts WHERE profile_id IS NULL');
    if (layout) this.db.run('INSERT INTO home_layouts (profile_id, layout, updated_at) VALUES (NULL, ?, ?)', JSON.stringify(layout), Date.now());
  }
  saveProfile(profileId, layout) {
    if (!layout) return this.resetProfile(profileId);
    this.db.run(
      'INSERT INTO home_layouts (profile_id, layout, updated_at) VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at',
      profileId,
      JSON.stringify(layout),
      Date.now(),
    );
  }
  resetProfile(profileId) {
    this.db.run('DELETE FROM home_layouts WHERE profile_id = ?', profileId);
  }
}

/** A layout as saved: its shape checked, and every pin one the saving profile may see (or it's refused, 400). */
export function checkedLayout(x, core, viewer, known = []) {
  const layout = validateLayout(x, validatePin);
  // Only pins new to this arrangement are checked: one already saved whose playlist has gone (or that the household
  // pinned and this profile can't see) is kept as it is — Home leaves it off — so it never blocks saving the rest.
  const saved = new Set(known.map((p) => JSON.stringify(validatePin(p))));
  for (const pin of layout?.pins || []) if (!saved.has(JSON.stringify(pin))) checkPinVisible(pin, core, viewer);
  return layout;
}
