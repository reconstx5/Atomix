// Wires every part of NodeFlix together and creates the HTTP server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { logger, setLogLevel } from './log.js';
import { openDatabase } from './db.js';
import { Settings } from './settings.js';
import { Hooks } from './hooks.js';
import { Auth } from './auth.js';
import { Router, HttpError, createContext, sendJson } from './http/router.js';
import { sendFile, safeJoin } from './http/static.js';
import { detectTools } from './library/probe.js';
import { ImageCache } from './library/images.js';
import { MetadataManager } from './library/metadata.js';
import { Library } from './library/queries.js';
import { Scanner } from './library/scanner.js';
import { PlaybackManager } from './stream/playback.js';
import { PluginManager } from './plugins.js';
import { Themes } from './themes.js';
import { Profiles } from './profiles.js';
import { registerAccountRoutes } from './api/account.js';
import { registerLibraryRoutes } from './api/library.js';
import { registerPlaybackRoutes } from './api/playback.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerExtrasRoutes } from './api/extras.js';
import { ExtrasStore } from './extras/store.js';
import { makeJobs } from './extras/jobs.js';
import { TaskRunner } from './tasks.js';

const log = logger('server');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};

export async function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  setLogLevel(config.logLevel);

  const db = openDatabase(config.dbFile);
  const settings = new Settings(db);
  if (config.initialTmdbKey && !settings.get('tmdbApiKey')) settings.set({ tmdbApiKey: config.initialTmdbKey });

  const hooks = new Hooks();
  const tools = await detectTools(config);
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    log.warn('ffmpeg/ffprobe not found — only browser-friendly files (MP4/WebM) will play and media info will be limited.');
    log.warn('Install ffmpeg (Windows: winget install Gyan.FFmpeg) or set NODEFLIX_FFMPEG / NODEFLIX_FFPROBE.');
  }
  const images = new ImageCache(config);
  const metadata = new MetadataManager({ db, config, settings, images, hooks });
  const library = new Library(db);
  const router = new Router();
  const auth = new Auth({ db, config });
  const themes = new Themes(config);
  const core = { config, db, settings, hooks, tools, images, metadata, library, router, auth, themes, version };
  core.profiles = new Profiles({ db, auth });
  core.scanner = new Scanner({ db, config, settings, metadata, hooks, tools });
  core.playback = new PlaybackManager({ db, config, settings, hooks, tools: () => core.tools });
  core.plugins = new PluginManager(core);
  core.extras = new ExtrasStore(db);
  core.tasks = new TaskRunner({
    store: core.extras,
    settings,
    tools: () => core.tools,
    // Converting video needs the CPU; converting music is light enough to share it.
    busy: () => [...core.playback.sessions.values()].some((s) => s.mode !== 'direct' && !s.audioOnly),
    jobs: makeJobs({ store: core.extras, config, tools: () => core.tools }),
    previewsDir: config.previewsDir,
  });
  hooks.on('item:added', ({ item }) => core.tasks.prioritise(item));
  hooks.on('scan:complete', () => {
    core.tasks.sweep();
    core.tasks.kick();
  });
  hooks.on('playback:start', () => core.tasks.interruptIfBusy());

  registerAccountRoutes(router, core);
  registerLibraryRoutes(router, core);
  registerPlaybackRoutes(router, core);
  registerAdminRoutes(router, core);
  registerExtrasRoutes(router, core);
  await core.plugins.loadAll();

  settings.onChange((changed) => {
    if ('scanIntervalMinutes' in changed) core.scanner.schedule();
    if ('previewsEnabled' in changed || 'introDetection' in changed) core.tasks.kick();
  });

  async function handleApi(req, res, url) {
    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Unknown API endpoint');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = match;

    // CSRF protection: state-changing requests must be JSON from our own origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let host;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        const expected = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
        if (host !== expected) throw new HttpError(403, 'Cross-origin request blocked');
      }
      const type = String(req.headers['content-type'] || '');
      if (!type.startsWith('application/json')) throw new HttpError(415, 'Send requests as application/json');
    }

    const ctx = createContext(req, res, url, params, { core });
    if (route.auth !== 'none') {
      ctx.user = auth.resolve(req);
      if (!ctx.user) throw new HttpError(401, 'Please sign in.');
      ctx.profile = core.profiles.active(ctx.user);
      ctx.viewer = core.profiles.viewer(ctx.user, ctx.profile);
      if (route.profile && !ctx.profile) throw new HttpError(428, 'Choose who is watching first.', { code: 'PROFILE_REQUIRED' });
      if ((route.auth === 'admin' || route.adult) && ctx.profile?.kids) throw new HttpError(403, 'Switch to a grown-up profile to do that.');
      if (route.auth === 'admin' && ctx.user.role !== 'admin') throw new HttpError(403, 'Only admins can do that.');
    }
    const result = await route.handler(ctx);
    if (!res.headersSent && !res.writableEnded) {
      if (result === undefined) sendJson(res, 204, null);
      else sendJson(res, 200, result);
    }
  }

  async function handleStatic(req, res, url) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }
    if (pathname.startsWith('/themes/')) {
      const file = safeJoin(config.themesDir, pathname.slice('/themes/'.length));
      if (file && /\.(css|json|png|jpe?g|svg|webp|woff2?)$/i.test(file) && (await sendFile(req, res, file, { cacheControl: 'no-cache' }))) return;
      res.writeHead(404).end();
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = safeJoin(config.publicDir, rel);
    if (file && !rel.endsWith('/') && (await sendFile(req, res, file, { cacheControl: rel === 'index.html' ? 'no-cache' : 'no-cache' }))) return;
    // SPA fallback for anything that isn't a file request.
    if (!path.extname(rel)) {
      await sendFile(req, res, path.join(config.publicDir, 'index.html'), { cacheControl: 'no-cache' });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await handleStatic(req, res, url);
      else res.writeHead(405).end();
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !err.status ? 'Something went wrong on the server.' : err.message, details: err.details });
      else res.destroy();
    }
  });
  server.requestTimeout = 0; // long-lived video streams
  server.headersTimeout = 60000;

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    core.scanner.schedule();
    if (overrides.backgroundTasks !== false) core.tasks.start();
    await hooks.emit('server:ready', { port: server.address().port });
    // Pick up anything that changed while the server was off.
    const libs = db.get('SELECT COUNT(*) AS n FROM libraries').n;
    if (libs && !overrides.skipStartupScan) setTimeout(() => core.scanner.scanAll().catch((e) => log.error(e.message)), 5000).unref();
    return server.address();
  }

  async function stop() {
    await core.tasks.stop(); // before the database closes
    for (const s of [...core.playback.sessions.keys()]) core.playback.stop(s, 'shutdown');
    for (const id of core.plugins.plugins.keys()) await core.plugins.unload(id);
    await new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    db.close();
  }

  return { server, core, config, start, stop };
}
