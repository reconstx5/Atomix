// App passwords: what a music app signs in to Atomix's Subsonic API with. One per app and profile, 24 random
// letters and digits, shown once when made. They are kept as they are (not hashed): Subsonic's token sign-in sends
// md5(password + salt), which can only be checked against the password itself. Revoking one signs that app out on
// its very next call. An app password never signs in to the web.
import crypto from 'node:crypto';
import { HttpError } from '../http/router.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LIMIT = 20;

export function makeSecret(length = 24) {
  const out = [];
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out.push(ALPHABET[b % 62]); // 248 = 62 × 4: no bias
    }
  }
  return out.join('');
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export class AppPasswords {
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
  }
  list(profileId) {
    return this.db
      .all('SELECT id, name, created_at, last_used_at FROM app_passwords WHERE profile_id = ? AND revoked = 0 ORDER BY created_at, id', profileId)
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null }));
  }
  create(profileId, name) {
    const clean = String(name ?? '').trim().slice(0, 60);
    if (!clean) throw new HttpError(400, "Give it a name, like the app's.");
    if (this.db.get('SELECT COUNT(*) AS n FROM app_passwords WHERE profile_id = ? AND revoked = 0', profileId).n >= LIMIT) throw new HttpError(400, `A profile can have ${LIMIT} app passwords. Revoke one first.`);
    const secret = makeSecret();
    const id = Number(this.db.run('INSERT INTO app_passwords (profile_id, name, secret, created_at) VALUES (?, ?, ?, ?)', profileId, clean, secret, this.now()).lastInsertRowid);
    return { id, name: clean, secret };
  }
  revoke(profileId, id) {
    const r = this.db.run('UPDATE app_passwords SET revoked = 1 WHERE id = ? AND profile_id = ? AND revoked = 0', Number(id), profileId);
    if (!r.changes) throw new HttpError(404, 'That app password is already gone.');
  }
  touch(id) {
    this.db.run('UPDATE app_passwords SET last_used_at = ? WHERE id = ?', this.now(), id);
  }

  /**
   * Who a Subsonic request signs in as.
   * @returns {{ user, profile, appPassword } | { error: 10|40|43|44, missing?: string }}
   */
  check({ username, token, salt, password, apiKey }) {
    const found = (row) => {
      if (!row) return null;
      const profile = this.db.get('SELECT * FROM profiles WHERE id = ?', row.profile_id);
      const user = profile && this.db.get('SELECT * FROM users WHERE id = ?', profile.user_id);
      return user ? { user, profile, appPassword: row } : null;
    };
    if (apiKey != null) {
      if (username != null) return { error: 43 };
      // Every key is compared in constant time (no lookup by the key itself, no early exit).
      let match = null;
      for (const row of this.db.all('SELECT * FROM app_passwords WHERE revoked = 0')) if (same(row.secret, apiKey) && !match) match = row;
      return found(match) || { error: 44 };
    }
    if (username == null) return { error: 10, missing: 'u' };
    if (password == null && (token == null || salt == null)) return { error: 10, missing: token != null ? 's' : 'p' };
    const user = this.db.get('SELECT * FROM users WHERE username = ?', String(username));
    const rows = user ? this.db.all('SELECT a.* FROM app_passwords a JOIN profiles p ON p.id = a.profile_id WHERE p.user_id = ? AND a.revoked = 0', user.id) : [];
    let plain = password;
    if (plain != null && String(plain).startsWith('enc:')) {
      const hex = String(plain).slice(4);
      plain = /^(?:[0-9a-f]{2})*$/i.test(hex) ? Buffer.from(hex, 'hex').toString('utf8') : '';
    }
    let match = null;
    for (const row of rows) {
      // Every row is compared (no early exit), so timing doesn't say which profile a password belongs to.
      const ok = plain != null ? same(row.secret, plain) : same(md5(row.secret + String(salt)), String(token).toLowerCase());
      if (ok && !match) match = row;
    }
    return found(match) || { error: 40 };
  }
}
