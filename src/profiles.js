// Profiles: several people (or kids) sharing one account, Netflix-style.
// Each profile has its own watch history and preferences; Kids profiles
// only see titles up to an age rating. Accounts can also be limited to
// certain libraries by an admin.
import { HttpError } from './http/router.js';
import { hashPassword, verifyPassword } from './auth.js';
import { parseJson } from './db.js';

export const AVATARS = ['ember', 'teal', 'violet', 'gold', 'rose', 'sky', 'lime', 'slate'];
const DEFAULT_KIDS_AGE = 10;

export function publicProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar || AVATARS[row.id % AVATARS.length],
    kids: Boolean(row.kids),
    maxAge: row.kids ? (row.max_age ?? DEFAULT_KIDS_AGE) : null,
    allowUnrated: Boolean(row.allow_unrated),
    libraries: parseJson(row.libraries, null),
    hasPin: Boolean(row.pin_hash),
    isPrimary: Boolean(row.is_primary),
    prefs: parseJson(row.prefs, {}),
  };
}

function cleanLibraryList(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new HttpError(400, 'libraries must be a list of library ids, or null for all.');
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

export class Profiles {
  constructor({ db, auth }) {
    this.db = db;
    this.auth = auth;
    this.pinAttempts = new Map(); // `${userId}:${profileId}` -> { count, reset }
  }

  list(userId) {
    return this.db.all('SELECT * FROM profiles WHERE user_id = ? ORDER BY is_primary DESC, created_at, id', userId);
  }

  get(userId, id) {
    return this.db.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', Number(id), userId);
  }

  /** Make sure every account has a main profile (new accounts, old databases). */
  ensurePrimary(user) {
    const existing = this.db.get('SELECT * FROM profiles WHERE user_id = ? AND is_primary = 1', user.id);
    if (existing) return existing;
    const res = this.db.run(
      'INSERT INTO profiles (user_id, name, prefs, is_primary, created_at) VALUES (?, ?, ?, 1, ?)',
      user.id,
      user.display_name || user.username,
      user.prefs || '{}',
      Date.now(),
    );
    return this.db.get('SELECT * FROM profiles WHERE id = ?', Number(res.lastInsertRowid));
  }

  /**
   * The profile this session is using. Picks one automatically when there's
   * only one and it has no PIN; otherwise returns null (the app shows a picker).
   */
  active(user) {
    if (user.session_profile_id) {
      const p = this.get(user.id, user.session_profile_id);
      if (p) return p;
    }
    const all = this.list(user.id);
    if (!all.length) {
      const p = this.ensurePrimary(user);
      this.auth.setSessionProfile(user.token_hash, p.id);
      return p;
    }
    if (all.length === 1 && !all[0].pin_hash) {
      this.auth.setSessionProfile(user.token_hash, all[0].id);
      return all[0];
    }
    return null;
  }

  /** Who is watching, as used by every library query. */
  viewer(user, profile) {
    const accountLibs = parseJson(user.library_access, null);
    const profileLibs = profile ? parseJson(profile.libraries, null) : null;
    let libraryIds = accountLibs;
    if (profileLibs) libraryIds = accountLibs ? profileLibs.filter((id) => accountLibs.includes(id)) : profileLibs;
    const kids = Boolean(profile?.kids);
    return {
      userId: user.id,
      profileId: profile?.id || 0,
      kids,
      maxAge: kids ? (profile.max_age ?? DEFAULT_KIDS_AGE) : null,
      allowUnrated: kids ? Boolean(profile.allow_unrated) : true,
      libraryIds,
    };
  }

  async validate(data, { creating }) {
    const out = {};
    if (creating || data.name !== undefined) {
      const name = String(data.name ?? '').trim().slice(0, 30);
      if (!name) throw new HttpError(400, 'Give the profile a name.');
      out.name = name;
    }
    if (data.avatar !== undefined) out.avatar = AVATARS.includes(data.avatar) ? data.avatar : '';
    if (data.kids !== undefined) out.kids = data.kids ? 1 : 0;
    if (data.maxAge !== undefined) {
      const age = data.maxAge == null ? null : Number(data.maxAge);
      if (age != null && (!Number.isInteger(age) || age < 0 || age > 18)) throw new HttpError(400, 'maxAge must be between 0 and 18.');
      out.max_age = age;
    }
    if (data.allowUnrated !== undefined) out.allow_unrated = data.allowUnrated ? 1 : 0;
    if (data.libraries !== undefined) out.libraries = JSON.stringify(cleanLibraryList(data.libraries));
    if (data.pin !== undefined) {
      if (data.pin === null || data.pin === '') out.pin_hash = null;
      else {
        if (!/^\d{4,8}$/.test(String(data.pin))) throw new HttpError(400, 'A PIN is 4 to 8 digits.');
        out.pin_hash = await hashPassword(String(data.pin));
      }
    }
    if (out.libraries === 'null') out.libraries = null;
    return out;
  }

  async create(userId, data) {
    if (this.list(userId).length >= 12) throw new HttpError(400, 'That’s the most profiles one account can have (12).');
    const fields = await this.validate(data, { creating: true });
    const cols = { user_id: userId, created_at: Date.now(), is_primary: 0, ...fields };
    const keys = Object.keys(cols);
    const res = this.db.run(`INSERT INTO profiles (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cols[k]));
    return this.db.get('SELECT * FROM profiles WHERE id = ?', Number(res.lastInsertRowid));
  }

  async update(userId, id, data) {
    const row = this.get(userId, id);
    if (!row) throw new HttpError(404, 'Profile not found');
    const fields = await this.validate(data, { creating: false });
    if (row.is_primary && fields.kids) throw new HttpError(400, "The main profile can't be a Kids profile.");
    const keys = Object.keys(fields);
    if (keys.length) this.db.run(`UPDATE profiles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), row.id);
    return this.get(userId, id);
  }

  remove(userId, id) {
    const row = this.get(userId, id);
    if (!row) throw new HttpError(404, 'Profile not found');
    if (row.is_primary) throw new HttpError(400, "The main profile can't be deleted.");
    this.db.run('DELETE FROM profiles WHERE id = ?', row.id);
  }

  async select(user, id, pin, req) {
    const row = this.get(user.id, id);
    if (!row) throw new HttpError(404, 'Profile not found');
    if (row.pin_hash) {
      const key = `${user.id}:${row.id}`;
      const now = Date.now();
      const tries = this.pinAttempts.get(key);
      if (tries && tries.reset > now && tries.count >= 5) throw new HttpError(429, 'Too many wrong PINs. Wait a few minutes and try again.');
      const ok = pin != null && (await verifyPassword(String(pin), row.pin_hash));
      if (!ok) {
        if (!tries || tries.reset < now) this.pinAttempts.set(key, { count: 1, reset: now + 5 * 60 * 1000 });
        else tries.count++;
        throw new HttpError(403, pin ? 'Wrong PIN.' : 'This profile needs its PIN.', { code: 'PIN_REQUIRED' });
      }
      this.pinAttempts.delete(key);
    }
    this.auth.setSessionProfile(this.auth.sessionHash(req), row.id);
    return row;
  }
}
