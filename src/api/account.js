// Setup, sign-in, profile and user management endpoints.
import { HttpError } from '../http/router.js';
import { hashPassword, verifyPassword, validatePassword, validateUsername, publicUser } from '../auth.js';
import { serializeCookie } from '../http/router.js';
import { publicProfile } from '../profiles.js';
import { parseJson } from '../db.js';
import crypto from 'node:crypto';
import { profileStats } from '../stats.js';
import { logger } from '../log.js';

const log = logger('setup');
const playerLog = logger('player');

const PREF_KEYS = {
  spokenSpeed: 'number', // v0.22: books and podcasts (0.75–3), and their skips in seconds
  spokenBack: 'number',
  spokenForward: 'number',
  readerText: 'number', // v0.22 Plan D: the EPUB reader's text size (%), line spacing, font, theme, margins; comics' fit
  readerSpacing: 'number',
  readerFont: 'string',
  readerTheme: 'string',
  readerMargins: 'string',
  comicFit: 'string',
  theme: 'string',
  accent: 'string',
  subtitleSize: 'number',
  subtitleLanguage: 'string',
  audioLanguage: 'string',
  autoplayNext: 'boolean',
  skipIntros: 'boolean',
  cardPreviews: 'boolean', // v0.28 card motion: cards play a short clip after resting (on unless turned off)
  levelVolume: 'boolean', // v0.28: even out volume between songs (on unless turned off)
  quality: 'string',
  reduceMotion: 'boolean',
  reduceEffects: 'boolean', // before v0.29; Glass 'solid' replaces it (still read)
  glass: 'string', // v0.29 visual refresh B: 'clear' | 'tinted' | 'solid'
  oled: 'boolean',
  contrast: 'string', // 'more' | 'normal' (unset = follow the system)
  textScale: 'number', // 1 | 1.15 | 1.3
  pinnedLibraries: 'ids', // ordered library ids shown in the menu; the rest go under More
  musicVolume: 'number', // Now Playing's volume, 0–1
};

export function cleanPrefs(input, current) {
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
    if (type === 'ids') {
      if (Array.isArray(v)) out[k] = [...new Set(v.filter((n) => typeof n === 'number' && Number.isInteger(n) && n > 0))].slice(0, 50);
      else delete out[k];
    }
  }
  if (out.accent && !/^#[0-9a-f]{6}$/i.test(out.accent)) delete out.accent;
  if (out.musicVolume != null) out.musicVolume = Math.max(0, Math.min(1, out.musicVolume));
  // v0.22: a speed from the player's list; skips inside their ranges.
  if (out.spokenSpeed != null && ![0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].includes(out.spokenSpeed)) delete out.spokenSpeed;
  if (out.spokenBack != null) out.spokenBack = Math.round(Math.max(5, Math.min(60, out.spokenBack)));
  if (out.spokenForward != null) out.spokenForward = Math.round(Math.max(10, Math.min(120, out.spokenForward)));
  // v0.22 Plan D: the reader's choices, each from its own list or range.
  if (out.readerText != null) out.readerText = Math.round(Math.max(80, Math.min(200, out.readerText)) / 10) * 10;
  if (out.readerSpacing != null) out.readerSpacing = Math.round(Math.max(1.2, Math.min(2, out.readerSpacing)) * 10) / 10;
  const oneOf = (k, list) => out[k] != null && !list.includes(out[k]) && delete out[k];
  oneOf('readerFont', ['book', 'serif', 'sans']);
  oneOf('readerTheme', ['light', 'sepia', 'dark', 'app']);
  oneOf('readerMargins', ['small', 'medium', 'large']);
  oneOf('comicFit', ['width', 'height', 'screen']);
  oneOf('glass', ['clear', 'tinted', 'solid']);
  oneOf('contrast', ['more', 'normal']);
  oneOf('textScale', [1, 1.15, 1.3]);
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
  // A loopback socket with a proxy header on it is a reverse proxy on this machine, and whoever is behind it
  // could be anyone on the internet: that needs the code too.
  const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'];
  // Only a loopback request addressed to this machine by name or address skips it: a proxy on this machine that
  // forwards a public name without forwarding headers (or trustProxy, which says a proxy is in front) needs it.
  const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;
  const needsCode = (req) =>
    !isLoopback(req.socket?.remoteAddress || '') || PROXY_HEADERS.some((h) => req.headers[h]) || Boolean(core.config?.trustProxy) || !LOCAL_HOST.test(String(req.headers.host || ''));
  const codeMatches = (given) => {
    const a = Buffer.from(String(given || '').trim().toUpperCase());
    const b = Buffer.from(setupCode);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  r.get('/api/health', () => ({ ok: true }), { auth: 'none' });

  r.get(
    '/api/status',
    (ctx) => {
      const s = settings.all();
      const row = auth.resolve(ctx.req);
      const profile = row ? core.profiles.active(row) : null;
      const profiles = row ? core.profiles.list(row.id) : [];
      const servers = row?.role === 'admin' && !profile?.kids
        ? db.all('SELECT id, name, kind, status, status_detail, last_sync FROM servers ORDER BY name').map((s) => ({ id: s.id, name: s.name, kind: s.kind, status: s.status, statusDetail: s.status_detail || null, lastSync: s.last_sync || null }))
        : undefined;
      return {
        servers,
        name: 'Atomix',
        version,
        serverName: s.serverName,
        defaultTheme: s.defaultTheme,
        loginMessage: s.loginMessage,
        quickConnect: s.quickConnect !== false,
        setupRequired: userCount() === 0,
        setupCodeRequired: userCount() === 0 && needsCode(ctx.req),
        user: publicUser(row),
        profile: publicProfile(profile),
        profileRequired: Boolean(row && !profile),
        profileCount: profiles.length,
        profilePinned: profiles.some((p) => p.pin_hash),
        defaultQuality: s.defaultQuality,
        pickerIdleMinutes: s.pickerIdleMinutes,
        requestUrl: row && !profile?.kids && s.requestUrl ? s.requestUrl : null, // v0.28: "Request it" on Search
        secureUrl: core.https?.secureUrlFor(ctx.req.headers.host) ?? null, // v0.27: the HTTPS address phones should use (null: none)
        // v0.21: what the installed app may keep on this device.
        downloads: row
          ? { enabled: s.downloadsEnabled !== false, allowed: s.downloadsEnabled !== false && (row.role === 'admin' || row.can_download === 1), deviceGb: s.downloadDeviceGb, offlineDays: s.downloadOfflineDays, quality: s.downloadQuality }
          : undefined,
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
      if (needsCode(ctx.req) && !codeMatches(body.setupCode)) {
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
      const ip = auth.clientIp(ctx.req);
      let out;
      try {
        out = await auth.login(ctx, body.username, body.password);
      } catch (err) {
        if (err.status === 401) {
          const known = db.get('SELECT id, username FROM users WHERE username = ?', String(body.username || ''));
          core.activity?.add({ type: 'sign-in-failed', userId: known?.id ?? null, text: known ? `Wrong password for ${known.username}` : 'Unknown username', ip });
        }
        throw err;
      }
      const { user, token } = out;
      core.activity?.add({ type: 'sign-in', userId: user.id, text: `${user.username} signed in`, ip });
      await core.hooks.emit('user:login', { user });
      return body.wantToken ? { user, token } : { user };
    },
    { auth: 'none' },
  );

  // Quick Connect: a TV gets a code (no sign-in), someone signed in approves it, the TV's poll signs it in.
  r.post(
    '/api/quickconnect',
    (ctx) => {
      if (settings.get('quickConnect') === false) throw new HttpError(403, 'Quick Connect is turned off.');
      auth.checkRateLimit(ctx.req);
      const s = core.quickConnect.start(ctx.req.headers['user-agent'], auth.clientIp(ctx.req));
      return { code: s.code, poll: s.poll, expiresAt: s.expiresAt, ttlMs: s.ttlMs };
    },
    { auth: 'none' },
  );
  // A POST with the token in the body: the token never sits in a URL (or a proxy's log), and a link can't sign a
  // browser in to someone else's account (the JSON-and-same-origin rule covers it).
  r.post(
    '/api/quickconnect/poll',
    async (ctx) => {
      const pollToken = (await ctx.body()).poll;
      if (settings.get('quickConnect') === false) {
        core.quickConnect.forget(pollToken); // turned off meanwhile: nothing more is signed in
        return { status: 'expired' };
      }
      const p = core.quickConnect.poll(pollToken);
      if (p.status !== 'approved') return { status: p.status };
      const user = db.get('SELECT * FROM users WHERE id = ?', p.userId);
      if (!user) return { status: 'expired' };
      const token = auth.createSession(user.id, ctx.req);
      ctx.setCookie(serializeCookie(auth.cookieName(ctx.req), token, { maxAge: core.config.sessionDays * 86400, secure: auth.isSecure(ctx.req) }));
      db.run('UPDATE users SET last_login = ? WHERE id = ?', Date.now(), user.id);
      return { status: 'approved', user: publicUser(user) };
    },
    { auth: 'none' },
  );
  // v0.28: a player that couldn't play says what the browser told it, so the problem can be read in the server's log
  // (a phone has no console to look at). Links' private parts (?cast=…) are cut before writing.
  const reports = new Map(); // user id -> times of recent reports
  r.post('/api/client-log', async (ctx) => {
    const now = Date.now();
    const recent = (reports.get(ctx.user.id) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) throw new HttpError(429, 'Too many reports; try again in a minute.');
    recent.push(now);
    reports.set(ctx.user.id, recent);
    const b = (await ctx.body()) || {};
    const clean = (v, n) => String(v ?? '').replace(/[?&](cast|key|token|api_key)=[^&\s;]*/gi, '').replace(/[\r\n]+/g, ' ').slice(0, n);
    const details = Array.isArray(b.details) ? b.details.slice(0, 8).map((d) => clean(d, 300)).filter(Boolean) : [];
    const item = Number.isInteger(b.itemId) ? `item ${b.itemId}: ` : b.liveChannelId != null ? `channel ${clean(b.liveChannelId, 20)}: ` : '';
    playerLog.warn(`${item}${clean(b.message, 300)}${details.length ? ` — ${details.join('; ')}` : ''} — ${clean(ctx.req.headers['user-agent'] || 'no user agent', 140)}`);
  });

  r.post('/api/quickconnect/approve', async (ctx) => {
    if (settings.get('quickConnect') === false) throw new HttpError(403, 'Quick Connect is turned off.');
    auth.checkRateLimit(ctx.req);
    const b = await ctx.body();
    const out = core.quickConnect.approve(b.code, ctx.user.id);
    if (!out) {
      auth.recordFailure(ctx.req);
      throw new HttpError(404, "That code isn't waiting. Check the TV and try again.");
    }
    // The address is the TV's (the one signed in), not the phone that approved it.
    core.activity?.add({ type: 'quick-connect', userId: ctx.user.id, profileId: ctx.profile.id, text: `${ctx.user.username} signed in ${out.device} with Quick Connect`, ip: out.ip || auth.clientIp(ctx.req) });
    return { device: out.device };
  });

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
  const said = (ctx, type, text) => core.activity?.add({ type, userId: ctx.user.id, profileId: ctx.profile?.id ?? null, text, ip: auth.clientIp(ctx.req) });
  r.post('/api/profiles', async (ctx) => {
    const p = await core.profiles.create(ctx.user.id, await ctx.body());
    said(ctx, 'users', `${ctx.user.username} added the profile ${p.name}`);
    return publicProfile(p);
  }, { adult: true });
  r.patch('/api/profiles/:id', async (ctx) => publicProfile(await core.profiles.update(ctx.user.id, ctx.params.id, await ctx.body())), { adult: true });
  r.delete(
    '/api/profiles/:id',
    (ctx) => {
      const gone = core.profiles.get(ctx.user.id, ctx.params.id);
      core.profiles.remove(ctx.user.id, ctx.params.id);
      if (gone) said(ctx, 'users', `${ctx.user.username} removed the profile ${gone.name}`);
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

  // Stats: this profile's own hours, top lists and when (any profile, Kids included — only its own).
  r.get('/api/me/stats', (ctx) => profileStats(db, ctx.profile.id, { range: ctx.query.range || 'week', tzOffset: Number(ctx.query.tz) || 0, tz: ctx.query.zone ? String(ctx.query.zone).slice(0, 64) : null }));

  // Music apps (the Subsonic API): this profile's app passwords. The password itself is shown once, when it's made.
  r.get('/api/me/app-passwords', (ctx) => core.appPasswords.list(ctx.profile.id));
  r.post('/api/me/app-passwords', async (ctx) => {
    const b = await ctx.body();
    const made = core.appPasswords.create(ctx.profile.id, b.name);
    said(ctx, 'app-password', `${ctx.user.username} made an app password for ${made.name}`);
    const host = (core.config.trustProxy && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host;
    const server = `${core.auth.isSecure(ctx.req) ? 'https' : 'http'}://${host}`;
    return { ...made, username: ctx.user.username, server, jellyfin: `${server}/jellyfin` };
  });
  r.delete('/api/me/app-passwords/:id', (ctx) => {
    const row = db.get('SELECT name FROM app_passwords WHERE id = ? AND profile_id = ? AND revoked = 0', Number(ctx.params.id), ctx.profile.id);
    core.appPasswords.revoke(ctx.profile.id, ctx.params.id);
    if (row) said(ctx, 'app-password', `${ctx.user.username} revoked ${row.name}`);
  });

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
        'INSERT INTO users (username, display_name, password_hash, role, created_at, can_download) VALUES (?, ?, ?, ?, ?, ?)',
        body.username,
        String(body.displayName || body.username).slice(0, 40),
        await hashPassword(body.password),
        role,
        Date.now(),
        role === 'admin' || body.canDownload === true ? 1 : 0,
      );
      const created = db.get('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid));
      said(ctx, 'users', `${ctx.user.username} added the user ${created.username}`);
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
        if (body.role === 'admin') db.run('UPDATE users SET can_download = 1 WHERE id = ?', id);
      }
      if (typeof body.canDownload === 'boolean') db.run('UPDATE users SET can_download = ? WHERE id = ?', body.canDownload ? 1 : 0, id);
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
      said(ctx, 'users', `${ctx.user.username} removed the user ${target.username}`);
      return { ok: true };
    },
    { auth: 'admin' },
  );

  // ---- Themes ----
  r.get('/api/themes', () => core.themes.list(), { auth: 'none' });
}
