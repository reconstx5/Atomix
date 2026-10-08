// Setup, sign-in, profile and user management endpoints.
import { HttpError } from '../http/router.js';
import { hashPassword, verifyPassword, validatePassword, validateUsername, publicUser } from '../auth.js';
import { publicProfile } from '../profiles.js';
import { parseJson } from '../db.js';
import crypto from 'node:crypto';
import { logger } from '../log.js';

const log = logger('setup');

const PREF_KEYS = {
  theme: 'string',
  accent: 'string',
  subtitleSize: 'number',
  subtitleLanguage: 'string',
  audioLanguage: 'string',
  autoplayNext: 'boolean',
  skipIntros: 'boolean',
  quality: 'string',
  reduceMotion: 'boolean',
  reduceEffects: 'boolean',
  musicVolume: 'number', // Now Playing's volume, 0–1
};

function cleanPrefs(input, current) {
  const out = { ...current };
  for (const [k, type] of Object.entries(PREF_KEYS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === null || v === '') {
      delete out[k];
      continue;
    }
    if (type === 'number' && Number.isFinite(Number(v))) out[k] = Number(v);
    if (type === 'boolean') out[k] = Boolean(v);
    if (type === 'string') out[k] = String(v).slice(0, 64);
  }
  if (out.accent && !/^#[0-9a-f]{6}$/i.test(out.accent)) delete out.accent;
  if (out.musicVolume != null) out.musicVolume = Math.max(0, Math.min(1, out.musicVolume));
  return out;
}

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

function libraryAccessJson(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new HttpError(400, 'libraryAccess must be a list of library ids, or null for all libraries.');
  return JSON.stringify([...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))]);
}

export function registerAccountRoutes(r, core) {
  const { db, auth, settings, version } = core;
  const userCount = () => db.get('SELECT COUNT(*) AS n FROM users').n;

  // First-run protection: on a fresh server anyone who opens the page could
  // become admin. Unless they're on the same machine, require the one-time
  // code printed in the server log.
  const setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  if (userCount() === 0) {
    log.warn(`First-run setup code: ${setupCode}  (needed when setting up from another device)`);
  }
  const needsCode = (req) => !isLoopback(auth.clientIp(req));

  r.get('/api/health', () => ({ ok: true }), { auth: 'none' });

  r.get(
    '/api/status',
    (ctx) => {
      const s = settings.all();
      const row = auth.resolve(ctx.req);
      const profile = row ? core.profiles.active(row) : null;
      const profiles = row ? core.profiles.list(row.id) : [];
      const servers = row?.role === 'admin'
        ? db.all('SELECT id, name, kind, status, status_detail, last_sync FROM servers ORDER BY name').map((s) => ({ id: s.id, name: s.name, kind: s.kind, status: s.status, statusDetail: s.status_detail || null, lastSync: s.last_sync || null }))
        : undefined;
      return {
        servers,
        name: 'Atomix',
        version,
        serverName: s.serverName,
        defaultTheme: s.defaultTheme,
        loginMessage: s.loginMessage,
        setupRequired: userCount() === 0,
        setupCodeRequired: userCount() === 0 && needsCode(ctx.req),
        user: publicUser(row),
        profile: publicProfile(profile),
        profileRequired: Boolean(row && !profile),
        profileCount: profiles.length,
        profilePinned: profiles.some((p) => p.pin_hash),
        defaultQuality: s.defaultQuality,
        pickerIdleMinutes: s.pickerIdleMinutes,
      };
    },
    { auth: 'none' },
  );

  r.post(
    '/api/setup',
    async (ctx) => {
      if (userCount() > 0) throw new HttpError(409, 'Setup has already been completed.');
      const body = await ctx.body();
      if (needsCode(ctx.req)) auth.checkRateLimit(ctx.req);
      if (needsCode(ctx.req) && String(body.setupCode || '').trim().toUpperCase() !== setupCode) {
        auth.recordFailure(ctx.req);
        throw new HttpError(403, 'Wrong setup code. It is printed in the Atomix terminal window (or `docker compose logs`).');
      }
      validateUsername(body.username);
      validatePassword(body.password);
      const hash = await hashPassword(body.password);
      const res = db.run(
        'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
        body.username,
        body.displayName || body.username,
        hash,
        'admin',
        Date.now(),
      );
      core.profiles.ensurePrimary(db.get('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid)));
      if (body.serverName) settings.set({ serverName: String(body.serverName).slice(0, 60) });
      if (body.tmdbApiKey) settings.set({ tmdbApiKey: String(body.tmdbApiKey).trim() });
      const { user } = await auth.login(ctx, body.username, body.password);
      return { user };
    },
    { auth: 'none' },
  );

  r.post(
    '/api/auth/login',
    async (ctx) => {
      const body = await ctx.body();
      const { user, token } = await auth.login(ctx, body.username, body.password);
      await core.hooks.emit('user:login', { user });
      return body.wantToken ? { user, token } : { user };
    },
    { auth: 'none' },
  );

  r.post(
    '/api/auth/logout',
    (ctx) => {
      auth.logout(ctx);
      return { ok: true };
    },
    { auth: 'none' },
  );

  r.get('/api/me', (ctx) => ({ user: publicUser(ctx.user), profile: publicProfile(ctx.profile) }), { profile: false });

  // Preferences (theme, subtitles…) belong to the active profile; the display name to the account.
  r.patch('/api/me', async (ctx) => {
    const body = await ctx.body();
    if (body.prefs) {
      const prefs = cleanPrefs(body.prefs, parseJson(ctx.profile.prefs, {}));
      db.run('UPDATE profiles SET prefs = ? WHERE id = ?', JSON.stringify(prefs), ctx.profile.id);
    }
    if (body.displayName != null && !ctx.profile.kids) {
      const displayName = String(body.displayName).trim().slice(0, 40) || ctx.user.username;
      db.run('UPDATE users SET display_name = ? WHERE id = ?', displayName, ctx.user.id);
    }
    return {
      user: publicUser(db.get('SELECT * FROM users WHERE id = ?', ctx.user.id)),
      profile: publicProfile(db.get('SELECT * FROM profiles WHERE id = ?', ctx.profile.id)),
    };
  });

  // ---- Profiles ("who's watching?") ----
  r.get('/api/profiles', (ctx) => core.profiles.list(ctx.user.id).map(publicProfile), { profile: false });
  r.post('/api/profiles', async (ctx) => publicProfile(await core.profiles.create(ctx.user.id, await ctx.body())), { adult: true });
  r.patch('/api/profiles/:id', async (ctx) => publicProfile(await core.profiles.update(ctx.user.id, ctx.params.id, await ctx.body())), { adult: true });
  r.delete(
    '/api/profiles/:id',
    (ctx) => {
      core.profiles.remove(ctx.user.id, ctx.params.id);
      return { ok: true };
    },
    { adult: true },
  );
  r.post(
    '/api/profiles/:id/select',
    async (ctx) => {
      const body = await ctx.body();
      const row = await core.profiles.select(ctx.user, ctx.params.id, body.pin, ctx.req);
      return publicProfile(row);
    },
    { profile: false },
  );

  r.post('/api/me/password', async (ctx) => {
    const body = await ctx.body();
    if (!(await verifyPassword(String(body.current || ''), ctx.user.password_hash))) throw new HttpError(400, 'Your current password is wrong.');
    validatePassword(body.password);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), ctx.user.id);
    auth.revokeUserSessions(ctx.user.id, auth.tokenFrom(ctx.req));
    return { ok: true };
  }, { adult: true });

  // ---- User management (admin) ----
  r.get('/api/users', () => db.all('SELECT * FROM users ORDER BY username').map(publicUser), { auth: 'admin' });

  r.post(
    '/api/users',
    async (ctx) => {
      const body = await ctx.body();
      validateUsername(body.username);
      validatePassword(body.password);
      if (db.get('SELECT id FROM users WHERE username = ?', body.username)) throw new HttpError(409, 'That username is taken.');
      const role = body.role === 'admin' ? 'admin' : 'user';
      const res = db.run(
        'INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
        body.username,
        String(body.displayName || body.username).slice(0, 40),
        await hashPassword(body.password),
        role,
        Date.now(),
      );
      const created = db.get('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid));
      core.profiles.ensurePrimary(created);
      if (body.libraryAccess !== undefined) db.run('UPDATE users SET library_access = ? WHERE id = ?', libraryAccessJson(body.libraryAccess), created.id);
      return publicUser(db.get('SELECT * FROM users WHERE id = ?', created.id));
    },
    { auth: 'admin' },
  );

  r.patch(
    '/api/users/:id',
    async (ctx) => {
      const id = Number(ctx.params.id);
      const target = db.get('SELECT * FROM users WHERE id = ?', id);
      if (!target) throw new HttpError(404, 'User not found');
      const body = await ctx.body();
      if (body.role && body.role !== target.role) {
        if (target.role === 'admin' && db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).n <= 1) {
          throw new HttpError(400, 'You need at least one admin.');
        }
        db.run('UPDATE users SET role = ? WHERE id = ?', body.role === 'admin' ? 'admin' : 'user', id);
      }
      if (body.displayName != null) db.run('UPDATE users SET display_name = ? WHERE id = ?', String(body.displayName).slice(0, 40), id);
      if (body.libraryAccess !== undefined) db.run('UPDATE users SET library_access = ? WHERE id = ?', libraryAccessJson(body.libraryAccess), id);
      if (body.password) {
        validatePassword(body.password);
        db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), id);
        auth.revokeUserSessions(id, id === ctx.user.id ? auth.tokenFrom(ctx.req) : null);
      }
      return publicUser(db.get('SELECT * FROM users WHERE id = ?', id));
    },
    { auth: 'admin' },
  );

  r.delete(
    '/api/users/:id',
    (ctx) => {
      const id = Number(ctx.params.id);
      if (id === ctx.user.id) throw new HttpError(400, "You can't delete your own account.");
      const target = db.get('SELECT * FROM users WHERE id = ?', id);
      if (!target) throw new HttpError(404, 'User not found');
      db.run('DELETE FROM users WHERE id = ?', id);
      return { ok: true };
    },
    { auth: 'admin' },
  );

  // ---- Themes ----
  r.get('/api/themes', () => core.themes.list(), { auth: 'none' });
}
