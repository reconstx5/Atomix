// Admin-only endpoints: dashboard, settings, plugins, folder browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { detectTools } from '../library/probe.js';

const SECRET_SETTINGS = ['tmdbApiKey'];

export function registerAdminRoutes(r, core) {
  const { db, settings, playback, scanner, plugins, config, version } = core;
  const admin = { auth: 'admin' };

  r.get(
    '/api/admin/dashboard',
    () => {
      const counts = Object.fromEntries(db.all('SELECT kind, COUNT(*) AS n FROM items GROUP BY kind').map((row) => [row.kind, row.n]));
      return {
        server: {
          version,
          node: process.version,
          platform: `${os.type()} ${os.release()} (${process.arch})`,
          uptime: Math.round(process.uptime()),
          dataDir: config.dataDir,
          memoryMb: Math.round(process.memoryUsage().rss / 1048576),
          cpus: os.cpus().length,
        },
        tools: core.tools,
        counts: {
          movies: counts.movie || 0,
          shows: counts.show || 0,
          episodes: counts.episode || 0,
          artists: counts.artist || 0,
          albums: counts.album || 0,
          tracks: counts.track || 0,
          users: db.get('SELECT COUNT(*) AS n FROM users').n,
        },
        sessions: playback.list(),
        scan: scanner.status,
        tmdbConfigured: core.metadata.tmdb.enabled(),
      };
    },
    admin,
  );

  r.post(
    '/api/admin/tools/recheck',
    async () => {
      core.tools = await detectTools(config);
      scanner.tools = core.tools;
      return core.tools;
    },
    admin,
  );

  r.post(
    '/api/admin/sessions/:sid/stop',
    (ctx) => {
      playback.stop(ctx.params.sid, 'admin');
      return { ok: true };
    },
    admin,
  );

  r.get(
    '/api/admin/settings',
    () => {
      const s = settings.all();
      for (const k of SECRET_SETTINGS) s[k] = s[k] ? '••••••••' + String(s[k]).slice(-4) : '';
      return s;
    },
    admin,
  );

  r.put(
    '/api/admin/settings',
    async (ctx) => {
      const body = await ctx.body();
      // Don't overwrite secrets with their masked placeholder.
      for (const k of SECRET_SETTINGS) if (typeof body[k] === 'string' && body[k].startsWith('••••')) delete body[k];
      if (body.maxTranscodes != null) body.maxTranscodes = Math.max(1, Math.min(32, Number(body.maxTranscodes) || 1));
      if (body.scanIntervalMinutes != null) body.scanIntervalMinutes = Math.max(0, Math.min(10080, Number(body.scanIntervalMinutes) || 0));
      settings.set(body);
      const s = settings.all();
      for (const k of SECRET_SETTINGS) s[k] = s[k] ? '••••••••' + String(s[k]).slice(-4) : '';
      return s;
    },
    admin,
  );

  // Test the TMDB key without saving anything else.
  r.post(
    '/api/admin/metadata/test',
    async () => {
      if (!core.metadata.tmdb.enabled()) throw new HttpError(400, 'No TMDB key saved yet.');
      const results = await core.metadata.tmdb.search('movie', 'The Matrix', 1999);
      return { ok: results.length > 0, sample: results[0]?.title || null };
    },
    admin,
  );

  // ---- Plugins ----
  r.get('/api/admin/plugins', () => plugins.list(), admin);

  r.post(
    '/api/admin/plugins/:id/enabled',
    async (ctx) => {
      const body = await ctx.body();
      return plugins.setEnabled(ctx.params.id, Boolean(body.enabled));
    },
    admin,
  );

  r.put(
    '/api/admin/plugins/:id/config',
    async (ctx) => plugins.setConfig(ctx.params.id, await ctx.body()),
    admin,
  );

  r.post(
    '/api/admin/plugins/:id/actions/:action',
    async (ctx) => plugins.runAction(ctx.params.id, ctx.params.action, ctx),
    admin,
  );

  r.post(
    '/api/admin/plugins/:id/reload',
    async (ctx) => {
      await plugins.unload(ctx.params.id);
      const rec = plugins.plugins.get(ctx.params.id);
      if (!rec) throw new HttpError(404, 'Unknown plugin');
      if (rec.enabled) await plugins.load(ctx.params.id);
      return plugins.describe(rec);
    },
    admin,
  );

  // ---- Folder browser (for picking library folders) ----
  r.get(
    '/api/admin/fs',
    async (ctx) => {
      const requested = String(ctx.query.path || '');
      if (!requested) {
        const roots = [];
        if (process.platform === 'win32') {
          for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
            const drive = `${letter}:\\`;
            if (fs.existsSync(drive)) roots.push({ name: drive, path: drive });
          }
        } else {
          roots.push({ name: '/', path: '/' });
          for (const p of ['/media', '/mnt', '/srv', '/data', os.homedir()]) if (fs.existsSync(p)) roots.push({ name: p, path: p });
        }
        return { path: '', parent: null, dirs: roots };
      }
      const dir = path.resolve(requested);
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        throw new HttpError(400, `Can't open ${dir}: ${err.code || err.message}`);
      }
      const dirs = entries
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !e.name.startsWith('$'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const parent = path.dirname(dir);
      return { path: dir, parent: parent === dir ? '' : parent, dirs };
    },
    admin,
  );
}
