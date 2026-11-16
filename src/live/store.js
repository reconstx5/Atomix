// Live TV storage: the channels and programmes live sources (plugins) hand over, favourite channels per profile,
// the channel groups a Kids profile may see, and each source's last refresh. Sources never touch these tables.
import { parseJson } from '../db.js';

const kidsKey = (source, grp) => `${source}\u0000${grp}`;

function channelRow(r) {
  return {
    id: r.id,
    source: r.source,
    key: r.key,
    number: r.number,
    name: r.name,
    groups: parseJson(r.groups, []),
    logo: r.logo || null,
    radio: Boolean(r.radio),
    guideId: r.guide_id || null,
    catchup: parseJson(r.catchup, null),
    hidden: Boolean(r.hidden) || r.missing_since != null, // missing from the last refresh: not shown, not playable
    drm: r.drm ? r.drm.split(',')[0] : null, // the first system (what single-system code reads); drmSystems has them all
    drmSystems: r.drm ? r.drm.split(',') : null,
    appUrl: r.app_url || null,
    appName: r.app_name || null,
    adminAppUrl: r.admin_app_url || null,
    adminAppName: r.admin_app_name || null,
  };
}

function programmeRow(r) {
  return {
    id: r.id,
    channelId: r.channel_id,
    start: r.start,
    end: r.end,
    title: r.title,
    subtitle: r.subtitle || null,
    description: r.description || null,
    categories: parseJson(r.categories, []),
    episode: r.episode || null,
    image: r.image || null,
    repeat: Boolean(r.repeat),
  };
}

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

const DRM_SYSTEMS = new Set(['widevine', 'clearkey', 'fairplay', 'playready']); // the key systems a channel may name
/** 'widevine,playready' (known names only, in order, no repeats) from drmSystems, else from a single drm name; NULL = plain. */
function drmList(c) {
  const raw = Array.isArray(c.drmSystems) ? c.drmSystems : c.drm ? [c.drm] : [];
  const out = [...new Set(raw.filter((n) => DRM_SYSTEMS.has(n)))];
  return out.length ? out.join(',') : null;
}
const httpsOrNull = (u) => {
  try {
    return new URL(String(u)).protocol === 'https:' ? String(u) : null;
  } catch {
    return null;
  }
};
const MISSING_KEEP_MS = 7 * 86400_000; // a channel gone from the playlist is kept (hidden) this long

export class LiveStore {
  constructor(db) {
    this.db = db;
  }

  /**
   * Upsert by (source, key) so ids — and the favourites that point at them — survive a reorder or a rename. A channel
   * missing from this refresh is hidden, and deleted once it has been missing for 7 days (a provider's glitch
   * doesn't cost anyone their favourites).
   */
  replaceChannels(source, channels, { now = Date.now() } = {}) {
    const db = this.db;
    return db.transaction(() => {
      const rowsBefore = db.all('SELECT id, key, missing_since FROM live_channels WHERE source = ?', source);
      const existing = new Map(rowsBefore.map((r) => [r.key, r.id]));
      const missingSince = new Map(rowsBefore.map((r) => [r.key, r.missing_since]));
      const seen = new Set();
      let added = 0;
      let updated = 0;
      channels.forEach((c, i) => {
        if (seen.has(c.key)) return;
        seen.add(c.key);
        const appUrl = httpsOrNull(c.appUrl);
        const values = [
          c.number ?? null,
          String(c.name),
          JSON.stringify(Array.isArray(c.group) ? c.group : Array.isArray(c.groups) ? c.groups : []),
          c.logo || null,
          c.radio ? 1 : 0,
          c.guideId || null,
          c.catchup ? JSON.stringify(c.catchup) : null,
          drmList(c),
          appUrl,
          appUrl ? String(c.appName || '').slice(0, 80) || null : null,
          i,
          now,
        ];
        if (existing.has(c.key)) {
          db.run('UPDATE live_channels SET number = ?, name = ?, groups = ?, logo = ?, radio = ?, guide_id = ?, catchup = ?, drm = ?, app_url = ?, app_name = ?, sort = ?, updated_at = ?, missing_since = NULL WHERE id = ?', ...values, existing.get(c.key));
          updated++;
        } else {
          db.run('INSERT INTO live_channels (number, name, groups, logo, radio, guide_id, catchup, drm, app_url, app_name, sort, updated_at, source, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...values, source, c.key);
          added++;
        }
      });
      let removed = 0;
      for (const [key, id] of existing) {
        if (seen.has(key)) continue;
        const since = missingSince.get(key);
        if (since == null) db.run('UPDATE live_channels SET missing_since = ? WHERE id = ?', now, id);
        else if (now - since > MISSING_KEEP_MS) {
          db.run('DELETE FROM live_channels WHERE id = ?', id);
          removed++;
        }
      }
      return { added, updated, removed };
    });
  }

  /**
   * Replace a source's programmes inside [from, to): a guide id may feed several channels (an SD and an HD copy).
   * A big guide is hundreds of thousands of rows and node:sqlite is synchronous, so the work goes in chunks with a
   * pause between them (playback keeps flowing): the new rows go in first and the old ones come out after, so the
   * guide is never empty while a refresh runs. Returns how many rows were stored and the names of channels left with
   * no programmes in the window.
   */
  async replaceProgrammes(source, programmes, { from, to, chunk = 4000 }) {
    const db = this.db;
    const chans = db.all('SELECT id, name, guide_id, radio FROM live_channels WHERE source = ? AND hidden = 0 AND missing_since IS NULL ORDER BY sort', source);
    const byGuide = new Map();
    for (const c of chans) {
      if (!c.guide_id) continue;
      if (!byGuide.has(c.guide_id)) byGuide.set(c.guide_id, []);
      byGuide.get(c.guide_id).push(c.id);
    }
    const lastOld = db.get('SELECT COALESCE(MAX(id), 0) AS m FROM live_programmes').m;
    const filled = new Set();
    let stored = 0;
    const rows = [];
    for (const p of programmes) {
      if (!(p.end > from && p.start < to) || !(p.end > p.start)) continue;
      const ids = byGuide.get(p.guideId);
      if (!ids) continue;
      for (const id of ids) rows.push([id, p]);
    }
    const yieldNow = () => new Promise((r) => setImmediate(r));
    for (let i = 0; i < rows.length; i += chunk) {
      db.transaction(() => {
        for (const [id, p] of rows.slice(i, i + chunk)) {
          db.run(
            'INSERT INTO live_programmes (channel_id, start, end, title, subtitle, description, categories, episode, image, repeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id,
            p.start,
            p.end,
            String(p.title || 'Untitled'),
            p.subtitle || null,
            p.description || null,
            p.categories?.length ? JSON.stringify(p.categories) : null,
            p.episode || null,
            p.image || null,
            p.repeat ? 1 : 0,
          );
          filled.add(id);
          stored++;
        }
      });
      await yieldNow();
    }
    // The old rows of this window, a chunk at a time.
    for (;;) {
      const res = db.run(
        `DELETE FROM live_programmes WHERE id IN (
           SELECT p.id FROM live_programmes p JOIN live_channels c ON c.id = p.channel_id
           WHERE c.source = ? AND p.id <= ? AND p.end > ? AND p.start < ? LIMIT ?)`,
        source,
        lastOld,
        from,
        to,
        chunk * 2,
      );
      if (!res.changes) break;
      await yieldNow();
    }
    const left = chans.filter((c) => !filled.has(c.id));
    const unmatched = { tv: left.filter((c) => !c.radio).map((c) => c.name), radio: left.filter((c) => c.radio).map((c) => c.name) };
    return { stored, unmatched };
  }

  /**
   * Visible channels of the given sources. `groups`: a Kids allow-list of "source\0group" keys (null = everything);
   * `group`: one group name; `favouritesOf`: only that profile's favourites, in their order.
   */
  channels({ sources, groups = null, group = null, favouritesOf = null } = {}) {
    if (!sources?.length) return [];
    let rows;
    if (favouritesOf != null) {
      rows = this.db.all(
        `SELECT c.* FROM live_channels c JOIN live_favourites f ON f.channel_id = c.id AND f.profile_id = ?
         WHERE c.hidden = 0 AND c.missing_since IS NULL AND c.source IN (${placeholders(sources.length)}) ORDER BY f.position, c.sort`,
        favouritesOf,
        ...sources,
      );
    } else {
      rows = this.db.all(`SELECT * FROM live_channels WHERE hidden = 0 AND missing_since IS NULL AND source IN (${placeholders(sources.length)}) ORDER BY source, number IS NULL, number, sort`, ...sources);
    }
    let out = rows.map(channelRow);
    if (groups) out = out.filter((c) => c.groups.some((g) => groups.has(kidsKey(c.source, g))));
    if (group) out = out.filter((c) => c.groups.includes(group));
    return out;
  }

  /** An admin's link for a channel ({} clears it: back to the playlist's or built-in link). */
  setAppLink(id, link) {
    if (link) this.db.run('UPDATE live_channels SET admin_app_url = ?, admin_app_name = ? WHERE id = ?', link.url, link.name || null, Number(id));
    else this.db.run('UPDATE live_channels SET admin_app_url = NULL, admin_app_name = NULL WHERE id = ?', Number(id));
  }

  channel(id) {
    const r = this.db.get('SELECT * FROM live_channels WHERE id = ?', Number(id));
    return r ? channelRow(r) : null;
  }

  /** Group names in playlist order of first appearance (only groups the allow-list lets through). */
  groups({ sources, groups = null } = {}) {
    const seen = [];
    for (const c of this.channels({ sources })) {
      for (const g of c.groups) {
        if (groups && !groups.has(kidsKey(c.source, g))) continue;
        if (!seen.includes(g)) seen.push(g);
      }
    }
    return seen;
  }

  /** What's on at `at` (start ≤ at < end) and the programme after it, per channel — two rows per channel at most. */
  nowNext(channelIds, at) {
    const out = new Map(channelIds.map((id) => [id, { now: null, next: null }]));
    if (!channelIds.length) return out;
    const rows = this.db.all(
      `SELECT * FROM (
         SELECT p.*, ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY start) AS rn FROM live_programmes p
         WHERE channel_id IN (${placeholders(channelIds.length)}) AND end > ? AND start < ?
       ) WHERE rn <= 2 ORDER BY channel_id, start`,
      ...channelIds,
      at,
      at + 2 * 86400_000,
    );
    // Per channel: "now" is the first row when it covers `at`; "next" is the first that starts after now ends
    // (or after `at` when nothing is on).
    for (const r of rows) {
      const slot = out.get(r.channel_id);
      if (!slot || slot.next) continue;
      if (!slot.now && r.start <= at && at < r.end) slot.now = programmeRow(r);
      else if (r.start >= (slot.now ? slot.now.end : at)) slot.next = programmeRow(r);
    }
    return out;
  }

  /** Programmes overlapping [from, to), per channel, ordered by start. */
  guide(channelIds, from, to) {
    const out = new Map(channelIds.map((id) => [id, []]));
    if (!channelIds.length) return out;
    const rows = this.db.all(
      `SELECT * FROM live_programmes WHERE channel_id IN (${placeholders(channelIds.length)}) AND end > ? AND start < ? ORDER BY channel_id, start`,
      ...channelIds,
      from,
      to,
    );
    for (const r of rows) out.get(r.channel_id)?.push(programmeRow(r));
    return out;
  }

  programme(id) {
    const r = this.db.get('SELECT * FROM live_programmes WHERE id = ?', Number(id));
    return r ? programmeRow(r) : null;
  }

  /** Programmes whose title matches, on the given channels, within [from, to). */
  searchProgrammes(q, { channelIds, from, to, limit = 20 }) {
    if (!channelIds?.length || !String(q || '').trim()) return [];
    return this.db
      .all(
        `SELECT * FROM live_programmes WHERE channel_id IN (${placeholders(channelIds.length)}) AND end > ? AND start < ? AND title LIKE ? ESCAPE '\\' ORDER BY start LIMIT ?`,
        ...channelIds,
        from,
        to,
        `%${String(q).trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`,
        limit,
      )
      .map(programmeRow);
  }

  favourites(profileId) {
    return this.db.all('SELECT channel_id FROM live_favourites WHERE profile_id = ? ORDER BY position, channel_id', profileId).map((r) => r.channel_id);
  }

  setFavourites(profileId, ids) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM live_favourites WHERE profile_id = ?', profileId);
      [...new Set(ids.map(Number))].forEach((id, i) => {
        if (this.db.get('SELECT 1 AS ok FROM live_channels WHERE id = ?', id)) this.db.run('INSERT INTO live_favourites (profile_id, channel_id, position) VALUES (?, ?, ?)', profileId, id, i);
      });
    });
  }

  toggleFavourite(profileId, channelId, on) {
    if (!on) return this.db.run('DELETE FROM live_favourites WHERE profile_id = ? AND channel_id = ?', profileId, channelId);
    const pos = this.db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM live_favourites WHERE profile_id = ?', profileId).p;
    this.db.run('INSERT OR IGNORE INTO live_favourites (profile_id, channel_id, position) VALUES (?, ?, ?)', profileId, channelId, pos);
  }

  kidsGroups(profileId) {
    return this.db.all('SELECT source, grp FROM live_kids_groups WHERE profile_id = ? ORDER BY source, grp', profileId).map((r) => ({ source: r.source, grp: r.grp }));
  }

  /** Replace a Kids profile's ticked groups: all of them, or only those of `sources` when given. */
  setKidsGroups(profileId, rows, { sources = null } = {}) {
    this.db.transaction(() => {
      if (sources) for (const src of sources) this.db.run('DELETE FROM live_kids_groups WHERE profile_id = ? AND source = ?', profileId, src);
      else this.db.run('DELETE FROM live_kids_groups WHERE profile_id = ?', profileId);
      for (const r of rows) this.db.run('INSERT OR IGNORE INTO live_kids_groups (profile_id, source, grp) VALUES (?, ?, ?)', profileId, String(r.source), String(r.grp));
    });
  }

  /** A refresh's outcome. A failure keeps the last good counts and time; a success clears the error. */
  recordRefresh(sourceId, { ok, channels, programmes, unmatched, unmatchedNames = null, warning = null, error = null }) {
    const now = Date.now();
    this.db.run('INSERT OR IGNORE INTO live_sources (id) VALUES (?)', sourceId);
    if (ok) {
      this.db.run(
        'UPDATE live_sources SET last_refresh = ?, last_ok = ?, channels = ?, programmes = ?, unmatched = ?, warning = ?, error = NULL WHERE id = ?',
        now,
        now,
        channels ?? 0,
        programmes ?? 0,
        unmatched ?? 0,
        warning,
        sourceId,
      );
      if (unmatchedNames) this.db.run('UPDATE live_sources SET unmatched_names = ? WHERE id = ?', JSON.stringify(unmatchedNames), sourceId);
    } else {
      this.db.run('UPDATE live_sources SET last_refresh = ?, error = ? WHERE id = ?', now, error || 'The refresh failed', sourceId);
    }
  }

  sourceStatus(sourceId) {
    const r = this.db.get('SELECT * FROM live_sources WHERE id = ?', sourceId);
    if (!r) return null;
    const names = parseJson(r.unmatched_names, null) || {};
    return {
      id: r.id,
      lastRefresh: r.last_refresh,
      lastOk: r.last_ok,
      channels: r.channels,
      programmes: r.programmes,
      unmatched: r.unmatched,
      unmatchedNames: { tv: names.tv || [], radio: names.radio || [] },
      unmatchedRadio: names.radioCount || 0,
      warning: r.warning || null,
      error: r.error || null,
    };
  }

  /** The furthest programme end for a source (to know when the guide is running out). */
  guideEnd(source) {
    return this.db.get('SELECT MAX(p.end) AS e FROM live_programmes p JOIN live_channels c ON c.id = p.channel_id WHERE c.source = ?', source)?.e || null;
  }

  hasChannels(source) {
    return Boolean(this.db.get('SELECT 1 AS ok FROM live_channels WHERE source = ? LIMIT 1', source));
  }

  /** Drop programmes that ended before `before` or start after `after`. */
  prune(before, after) {
    this.db.run('DELETE FROM live_programmes WHERE end < ? OR start > ?', before, after);
  }
}
