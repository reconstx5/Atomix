// Wires every part of Atomix together and creates the HTTP server.
import { Thumbs, referencedPictures } from './library/thumbs.js';
import { pageServer } from './http/page.js';
import { Problems, startDiskWatch } from './problems.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { logger, setLogLevel, setLogFile } from './log.js';
import { openDatabase } from './db.js';
import { Settings } from './settings.js';
import { Hooks } from './hooks.js';
import { Auth } from './auth.js';
import { Router, HttpError, createContext, sendJson } from './http/router.js';
import { sendFile, safeJoin, THEME_FILE } from './http/static.js';
import { detectTools } from './library/probe.js';
import { warmUpSubtitles } from './stream/warmup.js';
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
import { registerSearchRoutes } from './api/search.js';
import { registerPlaybackRoutes } from './api/playback.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerExtrasRoutes } from './api/extras.js';
import { registerListRoutes } from './api/lists.js';
import { registerHookRoutes } from './api/hooks.js';
import { registerServerRoutes } from './api/servers.js';
import { ExtrasStore } from './extras/store.js';
import { makeJobs } from './extras/jobs.js';
import { TaskRunner } from './tasks.js';
import { Lists } from './lists.js';
import { Plays } from './library/plays.js';
import { UserRatings } from './library/userratings.js';
import { AppPasswords } from './subsonic/apppasswords.js';
import { createSubsonic } from './subsonic/methods.js';
import { Scrobblers } from './scrobble/index.js';
import { registerScrobbleRoutes } from './api/scrobble.js';
import { registerTogetherRoutes } from './api/together.js';
import { QuickConnect } from './quickconnect.js';
import { Activity } from './activity.js';
import { PlaySettings } from './library/playsettings.js';
import { Chapters } from './library/chapters.js';
import { DownloadQueue } from './downloads/queue.js';
import { registerDownloadRoutes } from './api/downloads.js';
import { registerPodcastRoutes } from './api/podcasts.js';
import { registerBookRoutes } from './api/books.js';
import { Podcasts } from './podcasts/index.js';
import { registerShellRoutes } from './api/shell.js';
import { isJoining } from './live/recorder.js';
import { HomeLayouts } from './home/layout.js';
import { WebApps } from './home/webapps.js';
import { Collections } from './collections.js';
import { Picks } from './picks.js';
import { Lyrics } from './lyrics.js';
import { makeProviders } from './remote/index.js';
import { RemoteSync } from './remote/sync.js';
import { attachReporter } from './remote/progress.js';
import { PlexTv } from './remote/plextv.js';
import { CastLinks } from './cast/tokens.js';
import { CastDevices } from './cast/devices.js';
import { CastManager } from './cast/sessions.js';
import { registerCastRoutes } from './api/cast.js';
import { LiveStore } from './live/store.js';
import { LiveRefresher } from './live/refresh.js';
import { registerLiveRoutes } from './api/live.js';
import { registerRecordingRoutes } from './api/recordings.js';
import { TunerPool } from './live/tuner.js';
import { LiveStreams } from './live/stream.js';
import { LiveDrm } from './live/drm.js';
import { Recordings } from './live/recordings.js';
import { Scheduler } from './live/scheduler.js';
import { HttpsManager } from './tls/server.js';

const log = logger('server');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; frame-src 'self' https://www.youtube-nocookie.com",
};

/** How long a shutdown may take before the process exits anyway (more than the recordings' join wait). */
export const STOP_GRACE_MS = 15_000;

export async function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  setLogLevel(config.logLevel);
  // v0.28: every console line is also kept in data/logs/atomix.log (one older copy, atomix.log.1).
  setLogFile(path.join(config.dataDir, 'logs', 'atomix.log'));
  for (const notice of config.notices || []) log.info(notice);

  const db = openDatabase(config.dbFile);
  const settings = new Settings(db);
  if (config.initialTmdbKey && !settings.get('tmdbApiKey')) settings.set({ tmdbApiKey: config.initialTmdbKey });

  const hooks = new Hooks();
  const tools = await detectTools(config, settings);
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    log.warn('ffmpeg/ffprobe not found — only browser-friendly files (MP4/WebM) will play and media info will be limited.');
    log.warn(`Looked for: ${config.ffmpegPath} and ${config.ffprobePath}. Install ffmpeg (Windows: winget install Gyan.FFmpeg, then close and reopen this window),`);
    log.warn('or put the full paths in atomix.config.json as "ffmpegPath" and "ffprobePath" (or set ATOMIX_FFMPEG / ATOMIX_FFPROBE).');
  }
  // libass's first run builds a font cache (slow on Windows): done now, in the background, not on the first cast.
  setTimeout(() => warmUpSubtitles(config, tools), 0);
  const images = new ImageCache(config);
  const metadata = new MetadataManager({ db, config, settings, images, hooks });
  const library = new Library(db);
  const router = new Router();
  const auth = new Auth({ db, config });
  const themes = new Themes(config);
  const core = { config, db, settings, hooks, tools, images, metadata, library, router, auth, themes, version };
  core.thumbs = new Thumbs({ config, tools }); // v0.24: smaller copies of artwork
  const sendPage = pageServer(config.publicDir); // v0.24: the page, with its scripts preloaded
  core.profiles = new Profiles({ db, auth });
  core.plays = new Plays({ db });
  core.ratings = new UserRatings({ db });
  core.appPasswords = new AppPasswords({ db });
  core.quickConnect = new QuickConnect();
  core.activity = new Activity({ db });
  core.playSettings = new PlaySettings({ db });
  core.chapters = new Chapters({ db, config });
  core.activity.prune();
  setInterval(() => core.activity.prune(), 86400_000).unref();
  // v0.24: the smaller copies of artwork — a minute after start, then daily. Kept: copies of pictures some title,
  // collection, web app or podcast still uses.
  const sweepThumbs = async () => {
    try {
      const referenced = referencedPictures(db, images);
      const limitBytes = (Number(settings.get('thumbCacheMB')) || 2048) * 1024 * 1024;
      await core.thumbs.sweep({ referenced, limitBytes });
    } catch (err) {
      logger('thumbs').warn(`Picture cache sweep failed: ${err.message}`);
    }
  };
  setTimeout(sweepThumbs, 60_000).unref();
  setInterval(sweepThumbs, 86400_000).unref();
  {
    // Plays started and finished (every screen: the player, casts, music apps), named by profile and title.
    const said = (verb) => ({ profileId, item, client }) => {
      const p = db.get('SELECT name, user_id FROM profiles WHERE id = ?', profileId);
      if (p) core.activity.add({ type: 'play', userId: p.user_id, profileId, text: `${p.name} ${verb} ${item.title} (${client})` });
    };
    core.plays.onStarted(said('started'));
    core.plays.onCounted(said('finished'));
  }
  hooks.on('scan:complete', ({ library: lib, added, removed }) => core.activity.add({ type: 'scan', text: `Scanned ${lib.name}: ${added} added, ${removed || 0} removed` }));
  core.scanner = new Scanner({ db, config, settings, metadata, hooks, tools });
  core.remote = { providers: makeProviders({ version, settings }), sync: null };
  core.remote.plextv = new PlexTv({ base: config.plexTvBase, settings, version, serverName: () => settings.get('serverName') || 'Atomix' });
  core.remote.sync = new RemoteSync({ db, settings, providers: core.remote.providers, scanner: core.scanner, images, plextv: core.remote.plextv });
  core.scanner.remote = core.remote.sync;
  core.remote.reporter = attachReporter(core);
  core.cast = { links: new CastLinks({ db }) };
  hooks.on('playback:stop', ({ session }) => core.cast.links.revokeSession(session.id));
  core.playback = new PlaybackManager({ db, config, settings, hooks, tools: () => core.tools });
  core.cast.devices = new CastDevices({ db, config, search: config.castDiscovery ? {} : { cast: async () => [], dlna: async () => [] } });
  core.cast.manager = new CastManager(core);
  core.plugins = new PluginManager(core);
  core.live = { store: new LiveStore(db) };
  core.live.refresher = new LiveRefresher({ store: core.live.store, plugins: core.plugins, log: logger('live') });
  core.live.tuners = new TunerPool({ config, log: logger('live') });
  core.live.streams = new LiveStreams({ store: core.live.store, plugins: core.plugins, playback: core.playback, config, log: logger('live'), tuners: config.liveTuners ? core.live.tuners : null });
  core.live.drm = new LiveDrm({ streams: core.live.streams, playback: core.playback, log: logger('live') });
  core.live.streams.encrypted = core.live.drm.sessions;
  core.live.streams.encryptedEnded = core.live.drm.ended;
  core.live.recordings = new Recordings(db);
  core.live.scheduler = new Scheduler({ store: core.live.store, recordings: core.live.recordings, streams: core.live.streams, tuners: core.live.tuners, plugins: core.plugins, settings: core.settings, config, scanner: core.scanner, db, log: logger('live') });
  core.live.refresher.onRefreshed((key) => core.live.scheduler.afterRefresh(key));
  core.live.recordings.onStatus((r) => {
    const text = { recording: `Recording ${r.title} started`, done: `Recording ${r.title} finished`, failed: `Recording ${r.title} failed: ${String(r.error || 'it stopped').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => `<address>${m.match(/[:,.;)]+$/)?.[0] || ''}`)}` }[r.status];
    if (text) core.activity?.add({ type: 'recording', profileId: r.profileId, text });
  });
  core.extras = new ExtrasStore(db);
  core.lists = new Lists({ db, library });
  core.home = new HomeLayouts(db);
  core.webApps = new WebApps({ db, images });
  core.podcasts = new Podcasts({ db, library, images, settings, config, log: logger('podcasts') });
  core.collections = new Collections({ db, library });
  metadata.setCollections(core.collections);
  // v0.23: server problems for plugins (Alerts): each part reports and clears its own.
  core.problems = new Problems({ hooks });
  for (const part of [core.scanner, core.remote.sync, core.podcasts, core.live.refresher]) part.problems = core.problems;
  core.picks = new Picks({ db, library, collections: core.collections });
  core.lyrics = new Lyrics({ db, settings, version, base: config.lrclibBase });
  const converting = () => [...core.playback.sessions.values()].some((s) => s.mode !== 'direct' && !s.audioOnly);
  // v0.21: copies for devices to download, prepared while nobody is watching a converted video or a recording joins.
  core.downloads = new DownloadQueue({ db, config, settings, hooks, tools: () => core.tools, busy: () => converting() || isJoining() });
  core.tasks = new TaskRunner({
    store: core.extras,
    settings,
    tools: () => core.tools,
    // Converting video needs the CPU; converting music is light enough to share it.
    busy: converting,
    jobs: makeJobs({ store: core.extras, config, tools: () => core.tools, settings }),
    previewsDir: config.previewsDir,
  });
  hooks.on('item:added', ({ item }) => core.tasks.prioritise(item));
  hooks.on('scan:complete', () => {
    core.extras.scanned(); // songs may need their lyrics checked again
    core.tasks.sweep();
    core.tasks.kick();
    core.picks.clear();
    // Keywords, cast and film series for titles matched before v0.9.0 (and any the scan just matched).
    metadata.enrichMissing().catch((err) => log.warn(`Keyword catch-up failed: ${err.message}`));
  });
  hooks.on('playback:start', () => {
    core.tasks.interruptIfBusy();
    core.downloads.interruptIfBusy();
  });

  registerAccountRoutes(router, core);
  registerLibraryRoutes(router, core);
  registerSearchRoutes(router, core); // v0.24: recent searches, suggestions, tiles
  registerPlaybackRoutes(router, core);
  registerAdminRoutes(router, core);
  registerExtrasRoutes(router, core);
  registerHookRoutes(router, core);
  registerListRoutes(router, core);
  registerServerRoutes(router, core);
  registerCastRoutes(router, core);
  core.live.routes = registerLiveRoutes(router, core);
  registerRecordingRoutes(router, core);
  core.subsonic = createSubsonic(core);
  core.scrobblers = new Scrobblers({ db, settings, config: { ...config, version } });
  core.plays.onStarted((e) => e.item.kind === 'track' && core.scrobblers.nowPlaying(e).catch(() => {}));
  core.plays.onCounted((e) => e.item.kind === 'track' && core.scrobblers.listen(e).catch(() => {}));
  registerScrobbleRoutes(router, core);
  registerTogetherRoutes(router, core);
  registerDownloadRoutes(router, core);
  registerPodcastRoutes(router, core);
  registerBookRoutes(router, core);
  registerShellRoutes(router, core);
  await core.plugins.loadAll();
  metadata.started = true; // v0.23: a provider registered from now on (a plugin turned on) is offered existing titles
  if (!overrides.skipLiveRefresh) core.live.refresher.start();
  core.live.scheduler.start();

  settings.onChange((changed) => {
    if ('scanIntervalMinutes' in changed || 'remoteSyncHours' in changed) core.scanner.schedule();
    if ('previewsEnabled' in changed || 'introDetection' in changed) core.tasks.kick();
    if ('downloadsCacheGb' in changed) core.downloads.cleanup(); // a lowered limit applies now, not after the next job
  });

  // v0.27.1 diagnostics for phones that can't play: which media requests arrive, and what they carry.
  const MEDIA_PATH = /^\/api\/(items\/\d+\/file|stream\/|hls\/)/;
  const isFirstMediaRequest = (req, url) => /index\.m3u8$/.test(url.pathname) || !req.headers.range || /^bytes=0-1?$/.test(String(req.headers.range));
  const mediaWho = (req, url) => {
    const names = String(req.headers.cookie || '').split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
    return `sign-in cookie: ${names.length ? names.join(', ') : 'none'}; media link: ${url?.searchParams.has('cast') ? 'yes' : 'no'}; range: ${req.headers.range || 'none'}; ${String(req.headers['user-agent'] || 'no user agent').slice(0, 90)}`;
  };

  async function handleApi(req, res, url) {
    // v0.27: a Chromecast's receiver page asking before it POSTs a licence with its cast link (CORS preflight).
    if (req.method === 'OPTIONS' && url.searchParams.get('cast')) {
      const m = router.match('POST', url.pathname);
      const link = m && !m.methodNotAllowed && m.route.cast ? core.cast.links.check(url.searchParams.get('cast'), { route: m.route.cast, itemId: m.params.id, sessionId: m.params.sid }) : null;
      if (!link) throw new HttpError(401, 'This cast link has ended.');
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    const match = router.match(req.method, url.pathname);
    if (!match) throw new HttpError(404, 'Unknown API endpoint');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = match;

    // CSRF protection: state-changing requests must be JSON from our own origin.
    // A TV's licence POST carries its cast link instead of a cookie (checked below): the receiver's origin is Google's.
    const tvPost = Boolean(route.cast && url.searchParams.get('cast'));
    if (tvPost) res.setHeader('Access-Control-Allow-Origin', '*'); // its refusals reach the receiver page too
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = tvPost ? null : req.headers.origin;
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
      const binaryOk = route.body === 'binary' && type.startsWith('application/octet-stream');
      // A TV's receiver posts the key system's bytes as they are, often with no type (its link is checked below).
      if (!tvPost && !type.startsWith('application/json') && !binaryOk) throw new HttpError(415, 'Send requests as application/json');
    }

    // A video's first request (a file, a converted stream, a playlist): one line, so a phone that can't play says on
    // the server's console whether its requests arrive and carry a sign-in. Cookie names only, never their values.
    if ((route.cast === 'file' || route.cast === 'stream') && isFirstMediaRequest(req, url)) log.info(`[media] ${req.method} ${url.pathname} — ${mediaWho(req, url)}`);
    const ctx = createContext(req, res, url, params, { core, bodyTimeoutMs: config.bodyTimeoutMs });
    const castToken = route.cast && url.searchParams.get('cast');
    if (castToken) {
      // A TV fetching with its cast link: no cookie, one item or one stream, and CORS for the Chromecast receiver.
      const link = core.cast.links.check(castToken, { route: route.cast, itemId: params.id, sessionId: params.sid });
      if (!link) throw new HttpError(401, 'This cast link has ended.');
      ctx.user = db.get('SELECT * FROM users WHERE id = ?', link.userId);
      if (!ctx.user) throw new HttpError(401, 'This cast link has ended.');
      ctx.profile = link.profileId ? core.profiles.get(ctx.user.id, link.profileId) : core.profiles.active(ctx.user);
      if (link.profileId && !ctx.profile) throw new HttpError(401, 'This cast link has ended.'); // the profile is gone
      ctx.viewer = core.profiles.viewer(ctx.user, ctx.profile);
      ctx.castLink = link;
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (route.auth !== 'none') {
      ctx.user = auth.resolve(req);
      if (!ctx.user) throw new HttpError(401, 'Please sign in.');
      ctx.profile = core.profiles.active(ctx.user);
      ctx.viewer = core.profiles.viewer(ctx.user, ctx.profile);
      if (ctx.viewer) ctx.viewer.device = ctx.user.token_hash ? ctx.user.token_hash.slice(0, 16) : null; // this sign-in (a smart list's shuffle is per device)
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
      if (file && THEME_FILE.test(file) && (await sendFile(req, res, file, { cacheControl: 'no-cache' }))) return;
      res.writeHead(404).end();
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    // The page itself names the scripts it needs (v0.24).
    if (rel === 'index.html') return void sendPage(req, res);
    const file = safeJoin(config.publicDir, rel);
    // The page itself is checked every load (it names the version); scripts, styles and pictures may be kept a few
    // minutes and are revalidated by ETag after that, so an update reaches every screen within minutes.
    if (file && !rel.endsWith('/') && (await sendFile(req, res, file, { cacheControl: /\.(png|jpe?g|svg|webp|gif|ico|woff2?|ttf)$/i.test(rel) ? 'public, max-age=86400' : 'no-cache' }))) return;
    // SPA fallback for anything that isn't a file request.
    if (!path.extname(rel)) {
      sendPage(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }

  // The app itself, for both addresses: the plain one (HTTP) and, when set up, the secure one (v0.27, src/tls/).
  const handle = async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      if (url.pathname.startsWith('/tls/') && core.https.serveCa(req, res, url)) return; // the home CA for phones (v0.27)
      if (url.pathname.startsWith('/rest/')) await core.subsonic.handle(req, res, url);
      else if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await handleStatic(req, res, url);
      else res.writeHead(405).end();
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      else if (MEDIA_PATH.test(url.pathname)) log.warn(`[media] ${status} ${req.method} ${url.pathname}: ${err.message} — ${mediaWho(req, url)}`);
      if (!res.headersSent) {
        // A body that never finished (408) or was cut off at the cap (413) leaves the request stream open: close the
        // connection once the answer is out (an endless upload would otherwise be drained forever).
        if (status === 408 || status === 413) {
          res.setHeader('Connection', 'close');
          // A moment's grace (still draining) so the client reads the answer before the reset an unread upload causes.
          res.once('finish', () => setTimeout(() => req.destroy(), 1000).unref());
        }
        sendJson(res, status, { error: status >= 500 && !err.status ? 'Something went wrong on the server.' : err.message, details: err.details });
      } else res.destroy();
    }
  };
  const server = http.createServer(handle);
  core.https = new HttpsManager({ handler: handle, settings, config, log });
  server.requestTimeout = 0; // long-lived video streams
  // Idle connections stay open longer than browsers keep them (Safari, and every iPhone browser, reuses one for up to a
  // minute): with Node's default of 5 s a POST sent on a connection just as the server closed it failed in the phone
  // as "Load failed" — WebKit doesn't retry a POST. headersTimeout must stay above keepAliveTimeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    core.listening = { port: server.address().port };
    // v0.27: the secure address, when set up (a failure is its sentence in Settings; the plain address runs regardless).
    // Not awaited: asking Tailscale for a first certificate can take minutes, and nothing else waits on it.
    core.https.apply().then((secure) => {
      if (secure.sentence) log.warn(`[https] ${secure.sentence}`);
      else if (secure.listening) log.info(`Secure address: ${secure.secureUrl}`);
    });
    core.https.renewSoon();
    core.scanner.schedule();
    if (overrides.backgroundTasks !== false) core.tasks.start();
    core.downloads.start();
    if (overrides.backgroundTasks !== false) core.podcasts.start();
    // v0.23: under 5 GB free where Atomix keeps things is a problem (checked now and hourly).
    stopDiskWatch = startDiskWatch({
      problems: core.problems,
      dirs: () => [
        { key: 'data', label: "Atomix's data", dir: config.dataDir },
        { key: 'recordings', label: 'recordings', dir: settings.get('recordingsDir') || config.recordingsDir },
        { key: 'downloads', label: 'downloads', dir: settings.get('downloadsDir') || config.downloadsDir },
      ],
    });
    await hooks.emit('server:ready', { port: server.address().port });
    // Pick up anything that changed while the server was off.
    const libs = db.get('SELECT COUNT(*) AS n FROM libraries').n;
    if (libs && !overrides.skipStartupScan) setTimeout(() => core.scanner.scanAll().catch((e) => log.error(e.message)), 5000).unref();
    // Titles matched before v0.9.0 get their keywords, cast and film series in the background (a scan runs it too).
    if (libs && !overrides.skipStartupScan) setTimeout(() => metadata.enrichMissing().catch((e) => log.warn(`Keyword catch-up failed: ${e.message}`)), 8000).unref();
    return server.address();
  }

  let stopDiskWatch = () => {};
  async function stop() {
    stopDiskWatch();
    await core.tasks.stop(); // before the database closes
    await core.downloads.stop();
    await core.podcasts.stop();
    core.live.refresher.stop();
    core.live.drm.close();
    await core.live.scheduler.stop(); // joins under way finish first (at most 10 s)
    core.live.tuners.close();
    await Promise.race([core.live.refresher.idle(), new Promise((r) => setTimeout(r, 3000))]);
    await core.cast.manager.stopAll(); // TVs are told to stop and progress is saved (at most 3 s)
    for (const s of [...core.playback.sessions.keys()]) core.playback.stop(s, 'shutdown');
    // Connected servers hear about those stops before the database closes (at most 3 s).
    if (core.remote?.reporter) await Promise.race([core.remote.reporter.idle(), new Promise((r) => setTimeout(r, 3000))]);
    core.closeTogetherStreams?.();
    for (const id of core.plugins.plugins.keys()) await core.plugins.unload(id);
    await core.https.close();
    await new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    db.close();
  }

  return { server, core, config, start, stop };
}
