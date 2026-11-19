// Admin-only endpoints: dashboard, settings, plugins, folder browser.
import { householdStats } from '../stats.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { checkedLayout } from '../home/layout.js';
import { parseJson } from '../db.js';
import { detectTools } from '../library/probe.js';
import { detectArchiveTool, ARCHIVE_CANDIDATES } from '../books/archive-tool.js';

/** An absolute folder Atomix can make (if needed) and write a file in. */
function writableFolder(dir) {
  if (!path.isAbsolute(dir)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.atomix-write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

const SECRET_SETTINGS = ['tmdbApiKey', 'lastfmSecret'];

const HW_ACCELS = ['none', 'nvenc', 'qsv', 'vaapi', 'videotoolbox', 'amf'];
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
const SOFTWARE_HEIGHTS = [720, 1080, 1440, 2160];

export function registerAdminRoutes(r, core) {
  const { db, settings, playback, scanner, plugins, config, version } = core;
  const admin = { auth: 'admin' };

  // ---- Web apps (v0.22): shortcut tiles to sites with no API, kept by admins ----
  r.get('/api/admin/web-apps', () => core.webApps.list(), admin);
  r.post('/api/admin/web-apps', async (ctx) => core.webApps.add(await ctx.body()), admin);
  r.patch('/api/admin/web-apps/:id', async (ctx) => core.webApps.update(ctx.params.id, await ctx.body()), admin);
  r.delete(
    '/api/admin/web-apps/:id',
    (ctx) => {
      core.webApps.remove(ctx.params.id);
      return { ok: true };
    },
    admin,
  );

  // ---- The household's Home arrangement (v0.22): the default every profile follows until it changes its own ----
  r.get('/api/admin/home-layout', () => ({ layout: core.home.household() }), admin);
  r.put(
    '/api/admin/home-layout',
    async (ctx) => {
      core.home.saveHousehold(checkedLayout((await ctx.body()).layout, core, ctx.viewer, core.home.household()?.pins || []));
      return { ok: true };
    },
    admin,
  );

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
        sessions: [...playback.list(), ...(core.live?.drm?.list() || []), ...(core.live?.streams?.viewerList?.() || []), ...(core.jellyfin?.sessions?.list() || [])],
        downloadsPreparing: core.downloads?.preparingCount() ?? 0, // v0.21
        // Live TV tuners in use (v0.19): the channel, who's watching it, and (Plan B) what it's recording.
        tuners: (core.live?.tuners?.list() || []).filter((t) => t.holders.length).map((t) => ({
          channel: t.label,
          viewers: t.holders.filter((h) => h.kind !== 'recording').map((h) => core.live.streams.holderInfo(h)?.username).filter(Boolean),
          recording: t.holders.find((h) => h.kind === 'recording')?.title || null,
        })),
        // The next 3 recordings to start (v0.19).
        nextRecordings: (core.live?.recordings?.list({ status: 'scheduled' }) || []).slice(0, 3).map((x) => ({ id: x.id, title: x.title, channel: x.channelName, start: x.start, end: x.end })),
        scan: scanner.status,
        tmdbConfigured: core.metadata.tmdb.enabled(),
        servers: db.all('SELECT id, name, kind, status, status_detail, last_sync FROM servers ORDER BY name').map((s) => ({ id: s.id, name: s.name, kind: s.kind, status: s.status, statusDetail: s.status_detail || null, lastSync: s.last_sync || null })),
      };
    },
    admin,
  );

  r.post(
    '/api/admin/tools/recheck',
    async () => {
      core.tools = await detectTools(config, settings);
      scanner.tools = core.tools;
      return core.tools;
    },
    admin,
  );

  r.post(
    '/api/admin/sessions/:sid/stop',
    (ctx) => {
      if (core.live?.drm?.sessions.has(ctx.params.sid)) core.live.drm.stop(ctx.params.sid, 'admin');
      else if (core.live?.streams?.viewers.has(ctx.params.sid)) core.live.streams.viewerStop(ctx.params.sid, 'admin', 'An admin stopped this stream.');
      else if (core.jellyfin?.sessions?.stopById(ctx.params.sid)) { /* an Infuse or other Jellyfin app's stream */ }
      else playback.stop(ctx.params.sid, 'admin');
      return { ok: true };
    },
    admin,
  );

  r.get(
    '/api/admin/settings',
    () => {
      const s = settings.all();
      for (const k of SECRET_SETTINGS) s[k] = s[k] ? '••••••••' + String(s[k]).slice(-4) : '';
      delete s.arrKey; // v0.28: read from /api/admin/arr only
      s.recordingsDirDefault = config.recordingsDir; // where Live TV recordings go when the folder is left empty
      return s;
    },
    admin,
  );

  // v0.27: the secure address (Settings → Server): its mode, address, and why it isn't running if it isn't.
  r.get('/api/admin/https', () => {
    const st = core.https?.state() || { mode: 'off', listening: false, secureUrl: null, sentence: null, command: null, name: null, port: null };
    return { ...st, own: st.mode === 'own' && st.listening ? { caDownload: '/tls/atomix-home-ca.crt', profileDownload: '/tls/atomix-home-ca.mobileconfig' } : null };
  }, { auth: 'admin' });

  // Dashboard → Household: every profile's hours this week, month and year.
  r.get('/api/admin/stats', () => householdStats(core.db), { auth: 'admin' });
  // Every account's profiles (Settings → Activity's filter): id, name and whose.
  r.get('/api/admin/profiles', () => core.db.all('SELECT p.id, p.name, u.username AS owner FROM profiles p JOIN users u ON u.id = p.user_id ORDER BY u.username COLLATE NOCASE, p.created_at, p.id'), { auth: 'admin' });

  // Settings → Activity: newest first, 50 at a time, filtered by type, profile and day.
  r.get('/api/admin/activity', (ctx) => core.activity.list({ type: ctx.query.type || null, profileId: ctx.query.profile ? Number(ctx.query.profile) : null, day: ctx.query.day || null, before: ctx.query.before ? Number(ctx.query.before) : null }), { auth: 'admin' });

  r.put(
    '/api/admin/settings',
    async (ctx) => {
      const body = await ctx.body();
      // Don't overwrite secrets with their masked placeholder.
      for (const k of SECRET_SETTINGS) if (typeof body[k] === 'string' && body[k].startsWith('••••')) delete body[k];
      delete body.plexClientId; // this Atomix's device id at plex.tv: made once, never changed by hand
      delete body.arrKey; // v0.28: the download apps' webhook key, made and replaced only by /api/admin/arr
      if (body.castEnabled !== undefined) body.castEnabled = body.castEnabled !== false && body.castEnabled !== 'false';
      if (body.castBaseUrl !== undefined) {
        const v = String(body.castBaseUrl ?? '').trim();
        if (!v) body.castBaseUrl = null;
        else {
          let u;
          try {
            u = new URL(v);
          } catch {
            u = null;
          }
          if (!u || !/^https?:$/.test(u.protocol) || u.search || u.hash) throw new HttpError(400, 'Enter the address TVs use as http://<address>:<port>, like http://192.168.1.20:8787.');
          body.castBaseUrl = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
        }
      }
      if (body.requestUrl !== undefined) {
        // v0.28: where "Request it" on Search goes (Seerr and friends): an http(s) address, or nothing.
        const v = String(body.requestUrl ?? '').trim();
        if (v) {
          let u = null;
          try {
            u = new URL(v);
          } catch {}
          if (!u || !/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Enter the request page as an address starting with http:// or https://, like http://192.168.1.20:5055.');
          body.requestUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
        } else body.requestUrl = '';
      }
      if (body.maxTranscodes != null) body.maxTranscodes = Math.max(1, Math.min(32, Number(body.maxTranscodes) || 1));
      // These go straight into ffmpeg's command line: only the known values.
      if (body.hwAccel != null && !HW_ACCELS.includes(body.hwAccel)) throw new HttpError(400, `Hardware acceleration must be one of ${HW_ACCELS.join(', ')}.`);
      if (body.x264Preset != null && !X264_PRESETS.includes(body.x264Preset)) throw new HttpError(400, `The x264 preset must be one of ${X264_PRESETS.join(', ')}.`);
      if (body.vaapiDevice != null && body.vaapiDevice !== '' && !/^\/[^\0]+$/.test(String(body.vaapiDevice))) throw new HttpError(400, 'The VA-API device must be a full path, like /dev/dri/renderD128.');
      if (body.maxSoftwareHeight != null && !SOFTWARE_HEIGHTS.includes(Number(body.maxSoftwareHeight))) throw new HttpError(400, 'Max software conversion height must be 720, 1080, 1440 or 2160.');
      if (body.maxSoftwareHeight != null) body.maxSoftwareHeight = Number(body.maxSoftwareHeight);
      if (body.scanIntervalMinutes != null) body.scanIntervalMinutes = Math.max(0, Math.min(10080, Number(body.scanIntervalMinutes) || 0));
      if (body.remoteSyncHours != null) body.remoteSyncHours = Math.max(0, Math.min(168, Number(body.remoteSyncHours) || 0));
      if (body.pickerIdleMinutes !== undefined) {
        // One of the five choices (a number, or the same as a string from a form); anything else is the default.
        const v = typeof body.pickerIdleMinutes === 'number' || (typeof body.pickerIdleMinutes === 'string' && body.pickerIdleMinutes.trim() !== '') ? Number(body.pickerIdleMinutes) : NaN;
        body.pickerIdleMinutes = [0, 15, 30, 60, 240].includes(v) ? v : 30;
      }
      if (body.recordingsDir !== undefined) {
        const v = String(body.recordingsDir ?? '').trim();
        if (v) {
          // Not the data folder or anywhere in it (its default recordings folder aside), not a drive's top level.
          const full = path.resolve(v);
          const data = path.resolve(config.dataDir);
          const rel = path.relative(data, full);
          const inData = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
          if ((inData && full !== path.resolve(config.recordingsDir)) || full === path.parse(full).root) throw new HttpError(400, "Pick a folder that isn't the Atomix data folder or a drive's top level");
        }
        if (v && !writableFolder(v)) throw new HttpError(400, "Atomix can't write to that folder");
        body.recordingsDir = v;
      }
      if (body.downloadsDir !== undefined) {
        const v = String(body.downloadsDir ?? '').trim();
        const inside = (root) => {
          const rel = path.relative(path.resolve(root), path.resolve(v));
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        };
        if (v && db.all('SELECT paths FROM libraries').some((l) => parseJson(l.paths, []).some(inside))) throw new HttpError(400, 'Pick a folder outside your libraries (they would be scanned as titles).');
        if (v && !writableFolder(v)) throw new HttpError(400, "Atomix can't write to that folder");
        body.downloadsDir = v;
      }
      if (body.httpsPort != null && Number(body.httpsPort) === Number(core.listening?.port ?? config.port)) throw new HttpError(400, "Pick a port that isn't the one Atomix already uses");
      const before = settings.all();
      settings.set(body);
      // v0.27: the secure address follows at once (the answer comes once it has started, stopped or said why not).
      if (body.httpsMode !== undefined || body.httpsPort !== undefined) await core.https?.apply();
      if (body.quickConnect === false) core.quickConnect?.clear(); // codes approved but not yet collected go too
      if (body.archiveToolPath !== undefined) {
        // v0.22: a new 7-Zip/unrar path is looked for at once (Settings → Server then says what was found).
        core.tools = { ...core.tools, archive: await detectArchiveTool([String(settings.get('archiveToolPath') || '').trim(), ...ARCHIVE_CANDIDATES]) };
        scanner.tools = core.tools;
      }
      const after = settings.all();
      const changed = Object.keys(body).filter((k) => k in after && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length) core.activity?.add({ type: 'settings', userId: ctx.user.id, profileId: ctx.profile?.id ?? null, text: `${ctx.user.username} changed ${changed.join(', ')}`, ip: core.auth.clientIp(ctx.req) });
      const s = settings.all();
      for (const k of SECRET_SETTINGS) s[k] = s[k] ? '••••••••' + String(s[k]).slice(-4) : '';
      s.recordingsDirDefault = config.recordingsDir; // where Live TV recordings go when the folder is left empty
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
