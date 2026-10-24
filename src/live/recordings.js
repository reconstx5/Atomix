// Live TV recordings storage (migration 18): scheduled, running and finished recordings and the series rules that
// schedule them. A recording keeps its own copy of the programme's fields (programme ids change on every guide
// refresh). Only the scheduler and the recordings routes use this.

const MIN = 60_000;
const ACTIVE = "('scheduled', 'recording')";

/** "S2 E5" / "S2E5" / "s12e80" → { season, episode }; "E7" → { season: null, episode: 7 }; anything else → null. */
export function episodeNumbers(text) {
  if (!text) return null;
  const both = /\bS(\d+)\s*E(\d+)\b/i.exec(String(text));
  if (both) return { season: Number(both[1]), episode: Number(both[2]) };
  const only = /\bE(\d+)\b/i.exec(String(text));
  return only ? { season: null, episode: Number(only[1]) } : null;
}

const FIELDS = {
  profileId: 'profile_id',
  source: 'source',
  channelKey: 'channel_key',
  channelId: 'channel_id',
  channelName: 'channel_name',
  programmeId: 'programme_id',
  title: 'title',
  episodeTitle: 'episode_title',
  season: 'season',
  episode: 'episode',
  plot: 'plot',
  start: 'start',
  end: 'end',
  pre: 'pre',
  post: 'post',
  status: 'status',
  error: 'error',
  gapSeconds: 'gap_seconds',
  path: 'path',
  itemId: 'item_id',
  ruleId: 'rule_id',
  part: 'part',
  workDir: 'work_dir', // v0.21: where its pieces are, kept from its start (the recordings folder may change)
};

function recordingRow(r) {
  if (!r) return null;
  const out = { id: r.id, createdAt: r.created_at };
  for (const [k, col] of Object.entries(FIELDS)) out[k] = r[col] ?? null;
  out.gapSeconds = r.gap_seconds || 0;
  out.part = r.part || 1;
  return out;
}

function ruleRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    profileId: r.profile_id,
    source: r.source,
    channelKey: r.channel_key ?? null,
    title: r.title,
    newOnly: Boolean(r.new_only),
    keep: r.keep || 0,
    createdAt: r.created_at,
  };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

export class Recordings {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.statusListeners = [];
  }
  /** fn(row, previousStatus) after a recording's status changes (the activity log listens). */
  onStatus(fn) {
    this.statusListeners.push(fn);
  }

  add(row) {
    const cols = [];
    const vals = [];
    for (const [k, col] of Object.entries(FIELDS)) {
      if (row[k] === undefined) continue;
      cols.push(col);
      vals.push(typeof row[k] === 'boolean' ? Number(row[k]) : row[k]);
    }
    cols.push('created_at');
    vals.push(this.now());
    const res = this.db.run(`INSERT INTO live_recordings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...vals);
    return Number(res.lastInsertRowid);
  }

  get(id) {
    return recordingRow(this.db.get('SELECT * FROM live_recordings WHERE id = ?', Number(id)));
  }

  update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!FIELDS[k]) throw new Error(`Unknown recording field ${k}`);
      sets.push(`${FIELDS[k]} = ?`);
      vals.push(v ?? null);
    }
    const was = fields.status !== undefined ? this.db.get('SELECT status FROM live_recordings WHERE id = ?', Number(id))?.status : undefined;
    if (sets.length) this.db.run(`UPDATE live_recordings SET ${sets.join(', ')} WHERE id = ?`, ...vals, Number(id));
    const row = this.get(id);
    if (was !== undefined && row && was !== row.status) for (const fn of this.statusListeners) fn(row, was);
    return row;
  }

  remove(id) {
    this.db.run('DELETE FROM live_recordings WHERE id = ?', Number(id));
  }

  list({ status = null, ruleId = null } = {}) {
    const where = [];
    const vals = [];
    if (status) {
      where.push('status = ?');
      vals.push(status);
    }
    if (ruleId != null) {
      where.push('rule_id = ?');
      vals.push(ruleId);
    }
    return this.db.all(`SELECT * FROM live_recordings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start, id`, ...vals).map(recordingRow);
  }

  /** The scheduled or running recording of this airing, if any. */
  airing(source, channelKey, start) {
    return recordingRow(this.db.get(`SELECT * FROM live_recordings WHERE source = ? AND channel_key = ? AND start = ? AND status IN ${ACTIVE} ORDER BY id LIMIT 1`, source, channelKey, start));
  }

  /** Scheduled recordings whose padded start has come. */
  due(now) {
    return this.db.all("SELECT * FROM live_recordings WHERE status = 'scheduled' AND start - pre * ? <= ? ORDER BY start, id", MIN, now).map(recordingRow);
  }

  /** Running recordings whose padded end has come. */
  ending(now) {
    return this.db.all("SELECT * FROM live_recordings WHERE status = 'recording' AND end + post * ? <= ? ORDER BY start, id", MIN, now).map(recordingRow);
  }

  /**
   * Scheduled or running recordings of a source whose programme overlaps [from, to). Padding isn't counted: a
   * recording in its late minutes gives way to the next one (the scheduler ends it early).
   */
  overlapping(source, from, to, exceptId = null) {
    return this.db
      .all(`SELECT * FROM live_recordings WHERE source = ? AND status IN ${ACTIVE} AND start < ? AND end > ? AND id IS NOT ? ORDER BY start, id`, source, to, from, exceptId)
      .map(recordingRow);
  }

  /**
   * Is this programme already scheduled or recorded? The same airing (channel + start, any status: a cancelled airing
   * stays cancelled); else, unless that one failed, the same episode number of the rule or of a show of the same title,
   * or the same title + episode title.
   */
  exists({ ruleId = null, source, channelKey, start, season = null, episode = null, title, episodeTitle = null }) {
    if (this.db.get('SELECT 1 FROM live_recordings WHERE source = ? AND channel_key = ? AND start = ?', source, channelKey, start)) return true;
    if (episode != null) {
      // The same episode of the rule — or of the same show by any rule (two rules for one show record it once).
      const rows = this.db.all("SELECT rule_id, title FROM live_recordings WHERE source = ? AND season IS ? AND episode = ? AND status != 'failed'", source, season, episode);
      if (rows.some((r) => (ruleId != null && r.rule_id === ruleId) || norm(r.title) === norm(title))) return true;
    }
    if (episodeTitle) {
      const rows = this.db.all("SELECT title, episode_title FROM live_recordings WHERE source = ? AND episode_title IS NOT NULL AND status != 'failed'", source);
      if (rows.some((r) => norm(r.title) === norm(title) && norm(r.episode_title) === norm(episodeTitle))) return true;
    }
    return false;
  }

  rules() {
    return this.db.all('SELECT * FROM live_series_rules ORDER BY id').map(ruleRow);
  }

  rule(id) {
    return ruleRow(this.db.get('SELECT * FROM live_series_rules WHERE id = ?', Number(id)));
  }

  addRule({ profileId, source, channelKey = null, title, newOnly = true, keep = 0 }) {
    const res = this.db.run(
      'INSERT INTO live_series_rules (profile_id, source, channel_key, title, new_only, keep, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      profileId,
      source,
      channelKey,
      String(title).trim(),
      newOnly ? 1 : 0,
      keep,
      this.now(),
    );
    return Number(res.lastInsertRowid);
  }

  updateRule(id, fields) {
    const map = { keep: 'keep', newOnly: 'new_only', channelKey: 'channel_key' };
    for (const [k, v] of Object.entries(fields)) {
      if (!map[k]) continue;
      this.db.run(`UPDATE live_series_rules SET ${map[k]} = ? WHERE id = ?`, typeof v === 'boolean' ? Number(v) : v ?? null, Number(id));
    }
    return this.rule(id);
  }

  deleteRule(id) {
    this.db.run('DELETE FROM live_series_rules WHERE id = ?', Number(id));
  }
}
