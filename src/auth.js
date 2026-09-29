// Password hashing (scrypt), sessions, and login rate limiting.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, parseCookies, serializeCookie } from './http/router.js';
import { parseJson } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'nf_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (password.length > 256) throw new HttpError(400, 'Password is too long.');
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
    throw new HttpError(400, 'Username must be 2–32 characters: letters, numbers, dot, dash or underscore.');
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    libraryAccess: parseJson(row.library_access, null),
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };
}

export class Auth {
  constructor({ db, config }) {
    this.db = db;
    this.config = config;
    this.attempts = new Map(); // ip -> { count, reset }
    setInterval(() => this.cleanup(), 60 * 60 * 1000).unref();
  }

  clientIp(req) {
    if (this.config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  }

  isSecure(req) {
    if (req.socket.encrypted) return true;
    return this.config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  checkRateLimit(req) {
    const ip = this.clientIp(req);
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (entry && entry.reset > now && entry.count >= 10) {
      const mins = Math.ceil((entry.reset - now) / 60000);
      throw new HttpError(429, `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }

  recordFailure(req) {
    const ip = this.clientIp(req);
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || entry.reset < now) this.attempts.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
    else entry.count++;
  }

  async login(ctx, username, password) {
    this.checkRateLimit(ctx.req);
    const row = this.db.get('SELECT * FROM users WHERE username = ?', String(username || ''));
    // Always run a hash so response timing doesn't reveal whether a user exists.
    const ok = row
      ? await verifyPassword(String(password || ''), row.password_hash)
      : (await hashPassword('timing-equaliser'), false);
    if (!ok) {
      this.recordFailure(ctx.req);
      throw new HttpError(401, 'Wrong username or password.');
    }
    this.attempts.delete(this.clientIp(ctx.req));
    this.db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), row.id);
    const token = this.createSession(row.id, ctx.req);
    ctx.setCookie(
      serializeCookie(SESSION_COOKIE, token, {
        maxAge: this.config.sessionDays * 86400,
        secure: this.isSecure(ctx.req),
      }),
    );
    return { user: publicUser(row), token };
  }

  createSession(userId, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(token),
      userId,
      now,
      now + this.config.sessionDays * 86400 * 1000,
      String(req.headers['user-agent'] || '').slice(0, 300),
      this.clientIp(req),
    );
    return token;
  }

  tokenFrom(req) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  }

  /** Returns the signed-in user row for a request, or null. */
  resolve(req) {
    const token = this.tokenFrom(req);
    if (!token) return null;
    const row = this.db.get(
      `SELECT u.*, s.expires_at, s.token_hash, s.profile_id AS session_profile_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) {
      this.db.run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
      return null;
    }
    // Sliding expiry: extend sessions that are more than a day old.
    const full = this.config.sessionDays * 86400 * 1000;
    if (row.expires_at - now < full - 86400 * 1000) {
      this.db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + full, row.token_hash);
    }
    return row;
  }

  sessionHash(req) {
    const token = this.tokenFrom(req);
    return token ? sha256(token) : null;
  }

  setSessionProfile(tokenHash, profileId) {
    if (tokenHash) this.db.run('UPDATE sessions SET profile_id = ? WHERE token_hash = ?', profileId, tokenHash);
  }

  logout(ctx) {
    const token = this.tokenFrom(ctx.req);
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    ctx.setCookie(serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: this.isSecure(ctx.req) }));
  }

  revokeUserSessions(userId, exceptToken) {
    if (exceptToken) this.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, sha256(exceptToken));
    else this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  cleanup() {
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    const now = Date.now();
    for (const [ip, e] of this.attempts) if (e.reset < now) this.attempts.delete(ip);
  }
}
