// The activity log: what happened on the server, in plain sentences — sign-ins (and failed ones), Quick Connect,
// app passwords, plays started and finished, Watch together, recordings, scans, settings changed (names only),
// users and profiles added or removed. Admins read it in Settings → Activity; it's kept 30 days. No password,
// token or provider address is ever written here.
import { logger } from './log.js';

const log = logger('activity');
const KEEP = 30 * 86400_000;
const PAGE = 50;

export class Activity {
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
  }
  add({ type, userId = null, profileId = null, text, ip = null }) {
    try {
      this.db.run('INSERT INTO activity (at, type, user_id, profile_id, text, ip) VALUES (?, ?, ?, ?, ?, ?)', this.now(), String(type), userId, profileId, String(text).slice(0, 300), ip ? String(ip).slice(0, 64) : null);
    } catch (err) {
      log.warn(`couldn't log activity: ${err.message}`); // never stops what was happening
    }
  }
  /**
   * @param {{ type?: string, profileId?: number, day?: string ('YYYY-MM-DD', server local), before?: number, limit?: number }} q
   * @returns {{ entries: Array<{ id, at, type, user, profile, text, ip }>, more: boolean }}
   */
  list({ type, profileId, day, before, limit = PAGE } = {}) {
    const where = [];
    const params = [];
    if (type) where.push('a.type = ?') && params.push(String(type));
    if (profileId) where.push('a.profile_id = ?') && params.push(Number(profileId));
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const [y, m, d] = day.split('-').map(Number);
      const from = new Date(y, m - 1, d).getTime();
      where.push('a.at >= ? AND a.at < ?') && params.push(from, new Date(y, m - 1, d + 1).getTime());
    }
    if (before) where.push('a.id < ?') && params.push(Number(before));
    const rows = this.db.all(
      `SELECT a.*, u.username AS user_name, p.name AS profile_name FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN profiles p ON p.id = a.profile_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    return {
      entries: rows.slice(0, limit).map((r) => ({ id: r.id, at: r.at, type: r.type, user: r.user_name ?? null, profile: r.profile_name ?? null, text: r.text, ip: r.ip })),
      more: rows.length > limit,
    };
  }
  prune() {
    this.db.run('DELETE FROM activity WHERE at < ?', this.now() - KEEP);
  }
}
