// Jellyfin sign-in tokens. A token is 64 random hex, kept only as its sha256 (a 256-bit secret needs no slow hash or
// constant-time scan: one indexed lookup). Each belongs to an app password, so revoking that password ends them all.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export class JellyfinTokens {
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
  }
  issue({ appPasswordId, deviceId, deviceName, client, version }) {
    const token = crypto.randomBytes(32).toString('hex');
    const clip = (v) => (v == null ? null : String(v).slice(0, 120));
    this.db.run(
      'INSERT INTO jellyfin_tokens (app_password_id, token_hash, device_id, device_name, client, version, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      appPasswordId, sha256(token), clip(deviceId), clip(deviceName), clip(client), clip(version), this.now(), this.now(),
    );
    return token;
  }
  check(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return null;
    const tokenRow = this.db.get('SELECT * FROM jellyfin_tokens WHERE token_hash = ?', sha256(token.toLowerCase()));
    if (!tokenRow) return null;
    const appPassword = this.db.get('SELECT * FROM app_passwords WHERE id = ? AND revoked = 0', tokenRow.app_password_id);
    if (!appPassword) return null;
    const profile = this.db.get('SELECT * FROM profiles WHERE id = ?', appPassword.profile_id);
    const user = profile && this.db.get('SELECT * FROM users WHERE id = ?', profile.user_id);
    return user ? { user, profile, appPassword, tokenRow } : null;
  }
  logout(token) {
    this.db.run('DELETE FROM jellyfin_tokens WHERE token_hash = ?', sha256(String(token ?? '').toLowerCase()));
  }
  touch(id) {
    this.db.run('UPDATE jellyfin_tokens SET last_used_at = ? WHERE id = ?', this.now(), id);
  }
}

const header = (req, name) => {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};
// `MediaBrowser Client="Infuse", Device="Apple TV", Token="…"` -> { Client, Device, Token }
function mediaBrowser(req) {
  const raw = header(req, 'x-emby-authorization') || header(req, 'authorization') || '';
  if (!/^\s*(MediaBrowser|Emby)\b/i.test(raw)) return {};
  const out = {};
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

export function readToken(req, url) {
  const direct = header(req, 'x-emby-token') || header(req, 'x-mediabrowser-token');
  if (direct) return String(direct).trim();
  const t = mediaBrowser(req).token;
  if (t) return t.trim();
  const q = url?.searchParams;
  return q?.get('api_key') || q?.get('ApiKey') || q?.get('apikey') || null;
}

export function readClient(req) {
  const m = mediaBrowser(req);
  return { client: m.client ?? null, device: m.device ?? null, deviceId: m.deviceid ?? null, version: m.version ?? null };
}
