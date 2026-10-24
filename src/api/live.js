// Live TV: channels, groups, the guide, programme details, favourites, logos (through Atomix) and the admin's
// refresh and Kids groups. Stream addresses and headers never leave the server; Kids see only ticked groups.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { sendFile } from '../http/static.js';
import { QUALITIES } from '../stream/playback.js';
import { parseCaps } from './playback.js';
import { KEY_SYSTEMS } from '../live/drm.js';

const DAY = 24 * 3600_000;
const SIX_HOURS = 6 * 3600_000;
const kidsKey = (source, grp) => `${source}\u0000${grp}`;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i;

export function registerLiveRoutes(r, core) {
  const { images } = core;
  const store = () => core.live.store;
  const plugins = () => core.plugins;
  const admin = { auth: 'admin' };

  const isAdmin = (ctx) => ctx.user?.role === 'admin' && !ctx.profile?.kids;

  /** Which sources and (for Kids) which groups this viewer may see. An empty Kids set means no Live TV at all. */
  function liveViewer(ctx) {
    const sources = plugins().listLiveSources().map((s) => s.key);
    if (!ctx.viewer?.kids) return { sources, groups: null };
    const groups = new Set(store().kidsGroups(ctx.profile.id).map((g) => kidsKey(g.source, g.grp)));
    return { sources: groups.size ? sources : [], groups };
  }

  const visibleChannels = (ctx, opts = {}) => {
    const v = liveViewer(ctx);
    return store().channels({ sources: v.sources, groups: v.groups, ...opts });
  };

  function visibleChannel(ctx, id) {
    const c = store().channel(id);
    const v = liveViewer(ctx);
    const ok = c && !c.hidden && v.sources.includes(c.source) && (!v.groups || c.groups.some((g) => v.groups.has(kidsKey(c.source, g))));
    if (!ok) throw new HttpError(404, 'This channel no longer exists.');
    return c;
  }

  /**
   * Which programmes are being recorded or are scheduled to be, by channel and start (programme ids change with
   * every guide refresh). Kids never see recordings: an empty map.
   */
  function recordingMarks(ctx) {
    const marks = new Map();
    if (ctx.viewer?.kids || ctx.profile?.kids || !core.live.recordings) return marks;
    for (const r of core.db.all("SELECT channel_id, start, status FROM live_recordings WHERE status IN ('scheduled', 'recording')")) {
      const k = `${r.channel_id}\0${r.start}`;
      if (marks.get(k) !== 'recording') marks.set(k, r.status);
    }
    return marks;
  }

  const shapeProgramme = (p, marks = null) =>
    p && {
      id: p.id,
      channelId: p.channelId,
      start: p.start,
      end: p.end,
      title: p.title,
      subtitle: p.subtitle,
      description: p.description,
      categories: p.categories,
      episode: p.episode,
      image: p.image ? `/api/live/programmes/${p.id}/image` : null,
      repeat: Boolean(p.repeat),
      recording: marks?.get(`${p.channelId}\0${p.start}`) || null, // 'scheduled' | 'recording' | null
    };

  const shapeChannel = (c, { favourites, nn, marks = null } = {}) => ({
    id: c.id,
    number: c.number,
    name: c.name,
    groups: c.groups,
    logo: c.logo ? `/api/live/channels/${c.id}/logo` : null,
    radio: c.radio,
    catchup: Boolean(c.catchup) && !c.drm, // encrypted channels play live only
    catchupDays: c.drm ? 0 : Number(c.catchup?.days) || 0,
    drm: c.drm || null, // 'widevine' | 'clearkey' | 'fairplay': played in the browser, not cast
    favourite: favourites ? favourites.has(c.id) : false,
    ...(nn ? { now: shapeProgramme(nn.now, marks), next: shapeProgramme(nn.next, marks) } : {}),
  });

  /** What a programme can do now: watch live, start over (catch-up of one on now), or play it from the archive. */
  function abilities(channel, p, now = Date.now()) {
    const days = channel.drm ? 0 : Number(channel.catchup?.days) || 0; // encrypted channels: live only
    const onNow = p.start <= now && now < p.end;
    return {
      canWatchLive: onNow,
      canStartOver: onNow && days > 0 && p.start >= now - days * DAY,
      canCatchup: !onNow && p.end <= now && days > 0 && p.end > now - days * DAY,
    };
  }

  r.get('/api/live/status', (ctx) => {
    const v = liveViewer(ctx);
    const visible = v.sources.length ? store().channels({ sources: v.sources, groups: v.groups }).length : 0;
    const all = plugins().listLiveSources();
    const shown = ctx.viewer?.kids ? all.filter((s) => v.sources.includes(s.key)) : all;
    return {
      enabled: visible > 0,
      sources: shown.map((s) => {
        const st = store().sourceStatus(s.key);
        // A Kids profile counts only the channels it can see (not the source's total).
        const channels = ctx.viewer?.kids ? store().channels({ sources: [s.key], groups: v.groups }).length : st?.channels || 0;
        const out = { id: s.key, name: s.name, channels, lastOk: st?.lastOk || null };
        if (isAdmin(ctx)) {
          let summary = null;
          try {
            summary = s.source.settingsSummary?.() || null;
          } catch {
            summary = null;
          }
          Object.assign(out, { summary, error: st?.error || null, warning: st?.warning || null, unmatched: core.live.refresher.unmatchedNames(s.key).tv, unmatchedRadio: { count: st?.unmatchedRadio || 0, names: core.live.refresher.unmatchedNames(s.key).radio }, lastRefresh: st?.lastRefresh || null, groups: store().groups({ sources: [s.key] }) });
        }
        return out;
      }),
    };
  });

  r.get('/api/live/groups', (ctx) => {
    const v = liveViewer(ctx);
    return store().groups({ sources: v.sources, groups: v.groups });
  });

  r.get('/api/live/channels', (ctx) => {
    const favouritesOnly = String(ctx.query.favourites || '') === '1';
    const list = visibleChannels(ctx, { group: ctx.query.group ? String(ctx.query.group) : null, favouritesOf: favouritesOnly ? ctx.profile.id : null });
    const favourites = new Set(store().favourites(ctx.profile.id));
    const nn = store().nowNext(list.map((c) => c.id), Date.now());
    const marks = recordingMarks(ctx);
    return list.map((c) => shapeChannel(c, { favourites, nn: nn.get(c.id), marks }));
  });

  r.get('/api/live/guide', (ctx) => {
    const from = Number(ctx.query.from);
    let to = Number(ctx.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'Choose a time window');
    to = Math.min(to, from + SIX_HOURS);
    let list = visibleChannels(ctx);
    if (ctx.query.channels) {
      const want = String(ctx.query.channels).split(',').map(Number).filter(Number.isFinite);
      const byId = new Map(list.map((c) => [c.id, c]));
      list = want.map((id) => byId.get(id)).filter(Boolean);
    }
    list = list.slice(0, 200);
    const favourites = new Set(store().favourites(ctx.profile.id));
    const g = store().guide(list.map((c) => c.id), from, to);
    const programmes = {};
    const marks = recordingMarks(ctx);
    for (const c of list) programmes[c.id] = (g.get(c.id) || []).map((p) => shapeProgramme(p, marks));
    return { from, to, channels: list.map((c) => shapeChannel(c, { favourites })), programmes };
  });

  r.get('/api/live/programmes/:id', (ctx) => {
    const p = store().programme(ctx.params.id);
    if (!p) throw new HttpError(404, 'This programme is no longer in the guide.');
    let channel;
    try {
      channel = visibleChannel(ctx, p.channelId);
    } catch {
      throw new HttpError(404, 'This programme is no longer in the guide.');
    }
    const grownUp = !ctx.viewer?.kids && !ctx.profile?.kids;
    // Record: a grown-up profile, a TV channel that isn't encrypted, a programme not over yet.
    const canRecord = grownUp && !channel.radio && !channel.drm && p.end > Date.now();
    // The sheet's Cancel recording / Stop series: this airing's recording, and a series rule it belongs to.
    let recordingId = null;
    let ruleId = null;
    if (grownUp && core.live.recordings) {
      const airing = core.live.recordings.airing(channel.source, channel.key, p.start);
      recordingId = airing?.id ?? null;
      const norm = (t) => String(t ?? '').trim().toLowerCase();
      // The rule the airing came from; else the first rule this programme matches.
      ruleId = (airing?.ruleId && core.live.recordings.rule(airing.ruleId)?.id) || (core.live.recordings.rules().find((r) => r.source === channel.source && (!r.channelKey || r.channelKey === channel.key) && norm(r.title) === norm(p.title))?.id ?? null);
    }
    return { ...shapeProgramme(p, recordingMarks(ctx)), channel: shapeChannel(channel), ...abilities(channel, p), canRecord, recordingId, ruleId };
  });

  r.get('/api/live/search', (ctx) => {
    const q = String(ctx.query.q || '').trim().toLowerCase();
    if (!q) return { channels: [], programmes: [] };
    const list = visibleChannels(ctx);
    const byId = new Map(list.map((c) => [c.id, c]));
    const now = Date.now();
    const marks = recordingMarks(ctx);
    const programmes = store()
      .searchProgrammes(q, { channelIds: list.map((c) => c.id), from: now, to: now + DAY, limit: 20 })
      .map((p) => ({ ...shapeProgramme(p, marks), channel: { id: p.channelId, name: byId.get(p.channelId)?.name, number: byId.get(p.channelId)?.number } }));
    return { channels: list.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 20).map((c) => shapeChannel(c)), programmes };
  });

  /**
   * A logo or programme picture: an http(s) one is downloaded once and served from the cache; a file on this server
   * only from a folder its source declares (a logos folder), and only as an image — the playlist is someone else's
   * file and must not be able to name /etc/passwd.
   */
  async function serveImage(ctx, ref, sourceKey) {
    if (!ref) throw new HttpError(404, 'No image');
    let file = null;
    if (/^https?:\/\//i.test(ref)) {
      const cached = await images.download(ref, {}).catch(() => null);
      file = cached ? images.resolve(cached)?.file : null;
    } else if (path.isAbsolute(ref) && IMAGE_EXT.test(ref)) {
      const resolved = path.resolve(ref);
      let roots = [];
      try {
        roots = plugins().getLiveSource(sourceKey)?.imageRoots?.() || [];
      } catch {
        roots = [];
      }
      const inside = roots.filter(Boolean).some((r) => {
        const root = path.resolve(String(r));
        return resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
      });
      if (inside && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) file = resolved;
    }
    if (!file) throw new HttpError(404, 'No image');
    const ok = await sendFile(ctx.req, ctx.res, file, { cacheControl: 'private, max-age=604800' });
    if (!ok) throw new HttpError(404, 'No image');
  }

  r.get('/api/live/channels/:id/logo', (ctx) => {
    const c = visibleChannel(ctx, ctx.params.id);
    return serveImage(ctx, c.logo, c.source);
  }, { cast: 'logo' }); // v0.27: the TV showing an encrypted channel fetches its logo with its cast link

  r.get('/api/live/programmes/:id/image', (ctx) => {
    const p = store().programme(ctx.params.id);
    if (!p) throw new HttpError(404, 'No image');
    const c = visibleChannel(ctx, p.channelId);
    return serveImage(ctx, p.image, c.source);
  });

  r.put('/api/live/favourites', async (ctx) => {
    const b = await ctx.body();
    const sees = (id) => {
      try {
        visibleChannel(ctx, id);
        return true;
      } catch {
        return false;
      }
    };
    const ids = (Array.isArray(b.channelIds) ? b.channelIds : []).map(Number).filter(sees);
    // Favourites the viewer can't see right now (a channel missing from the last refresh) stay, after the new order.
    const kept = store().favourites(ctx.profile.id).filter((id) => !ids.includes(id) && !sees(id));
    store().setFavourites(ctx.profile.id, [...ids, ...kept]);
    return { channelIds: store().favourites(ctx.profile.id) };
  });

  r.post('/api/live/favourites/:id', (ctx) => {
    const c = visibleChannel(ctx, ctx.params.id);
    store().toggleFavourite(ctx.profile.id, c.id, true);
    return { channelIds: store().favourites(ctx.profile.id) };
  });

  r.delete('/api/live/favourites/:id', (ctx) => {
    store().toggleFavourite(ctx.profile.id, Number(ctx.params.id), false);
    return { channelIds: store().favourites(ctx.profile.id) };
  });

  // ---- Playing ----
  const qualityOf = (body) => {
    const q = String(body.quality || core.settings.get('defaultQuality') || 'original');
    if (!(q in QUALITIES)) throw new HttpError(400, 'Unknown quality');
    return q;
  };
  const sessionReply = (session, url, extra) => ({
    sessionId: session.id,
    mode: session.mode,
    delivery: session.delivery,
    url,
    reasons: session.reasons,
    quality: session.quality,
    ...extra,
  });

  r.post('/api/live/channels/:id/play', async (ctx) => {
    const channel = visibleChannel(ctx, ctx.params.id);
    const body = await ctx.body();
    if (channel.drm) return playEncrypted(ctx, channel, body);
    const { session, url, delivery } = await core.live.streams.startLive({
      user: ctx.user,
      profile: ctx.profile,
      channel,
      caps: parseCaps(body.caps),
      quality: qualityOf(body),
      replaces: body.replaces ? String(body.replaces) : null,
      audioOnly: Boolean(body.audioOnly),
      clientIp: core.auth.clientIp(ctx.req),
      isAdmin: isAdmin(ctx),
      behind: Math.max(0, Math.min(1800, Number(body.behind) || 0)),
    });
    const nn = store().nowNext([channel.id], Date.now()).get(channel.id);
    const extra = { live: true, duration: null, start: 0, channel: shapeChannel(channel), programme: shapeProgramme(nn.now), next: shapeProgramme(nn.next) };
    if (delivery === 'dash') {
      // The tuner's buffer, played by the browser itself: Atomix's own manifest and pieces (no provider address).
      const base = `/api/live/tuner/${session.id}`;
      return { sessionId: session.id, delivery: 'dash', mode: 'remux', manifest: `${base}/manifest.mpd`, timeUrl: `${base}/time`, rewind: true, quality: 'original', reasons: [], ...extra };
    }
    return sessionReply(session, url, { ...extra, rewind: Boolean(session.live?.tunerKey), behind: session.behind || 0 });
  });

  // ---- Watching through a tuner (v0.19): the 30-minute buffer, served to the viewer it belongs to ----
  const tunerViewer = (ctx) => core.live.streams.viewerGet(ctx.params.sid, ctx.user, ctx.profile);
  const tunerOf = (viewer) => {
    const t = core.live.tuners.get(viewer.tunerKey);
    if (!t) throw new HttpError(404, 'This channel stopped.');
    return t;
  };
  r.get('/api/live/tuner/:sid/manifest.mpd', (ctx) => {
    const viewer = tunerViewer(ctx);
    const body = tunerOf(viewer).manifest({ piecePath: 'p/', timeUrl: `/api/live/tuner/${viewer.id}/time` });
    ctx.res.writeHead(200, { 'Content-Type': 'application/dash+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    ctx.res.end(body);
  });
  r.get('/api/live/tuner/:sid/p/:file', async (ctx) => {
    const viewer = tunerViewer(ctx);
    const file = tunerOf(viewer).piecePath(ctx.params.file);
    if (!file) throw new HttpError(404, 'Not found');
    await sendFile(ctx.req, ctx.res, file, { cacheControl: 'private, max-age=60', contentType: 'video/mp4' });
  });
  r.get('/api/live/tuner/:sid/time', (ctx) => {
    tunerViewer(ctx);
    const body = new Date().toISOString();
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end(body);
  });
  r.post('/api/live/tuner/:sid/ping', (ctx) => core.live.streams.viewerPing(ctx.params.sid, ctx.user, ctx.profile));
  r.post('/api/live/tuner/:sid/stop', (ctx) => {
    tunerViewer(ctx);
    core.live.streams.viewerStop(ctx.params.sid, 'user');
    return { ok: true };
  });

  // ---- Encrypted channels: the browser plays them with its own key system; Atomix relays (src/live/drm.js) ----
  async function playEncrypted(ctx, channel, body) {
    if (body.audioOnly || channel.radio) throw new HttpError(400, "Encrypted channels can't be played as radio");
    const source = plugins().getLiveSource(channel.source);
    if (!source) throw new HttpError(404, 'This channel no longer exists.');
    const s = await core.live.drm.start({
      user: ctx.user,
      profile: ctx.profile,
      channel,
      source,
      replaces: body.replaces ? String(body.replaces) : null,
      isAdmin: isAdmin(ctx),
      clientIp: core.auth.clientIp(ctx.req),
    });
    const nn = store().nowNext([channel.id], Date.now()).get(channel.id);
    const fairplay = s.system === 'fairplay'; // v0.27: HLS, and the certificate through Atomix (it may be an address)
    return {
      sessionId: s.id,
      delivery: 'drm',
      mode: 'encrypted',
      keySystem: KEY_SYSTEMS[s.system],
      manifest: fairplay ? `/api/live/drm/${s.id}/master.m3u8` : `/api/live/drm/${s.id}/manifest.mpd`,
      licence: `/api/live/drm/${s.id}/licence`,
      ...(fairplay ? { certificate: `/api/live/drm/${s.id}/certificate` } : {}),
      serverCertificate: fairplay ? null : s.serverCertificate || null, // from the playlist (base64), for the browser's key system
      initData: s.initData || null,
      live: true,
      duration: null,
      start: 0,
      quality: 'original',
      reasons: [],
      channel: shapeChannel(channel),
      programme: shapeProgramme(nn.now),
      next: shapeProgramme(nn.next),
    };
  }

  const drmSession = (ctx) => core.live.drm.get(ctx.params.sid, ctx.user, ctx.profile);
  // v0.27: a Chromecast playing an encrypted channel fetches these with its cast link (one session's only).
  const tv = { cast: 'drm' };
  r.get('/api/live/drm/:sid/manifest.mpd', (ctx) => core.live.drm.serveManifest(ctx, drmSession(ctx)), tv);
  r.get('/api/live/drm/:sid/master.m3u8', (ctx) => core.live.drm.serveManifest(ctx, drmSession(ctx))); // FairPlay (v0.27)
  r.get('/api/live/drm/:sid/certificate', (ctx) => core.live.drm.serveCertificate(ctx, drmSession(ctx)));
  r.get('/api/live/drm/:sid/r/:rest*', (ctx) => core.live.drm.serveSegment(ctx, drmSession(ctx)), tv);
  r.post('/api/live/drm/:sid/licence', (ctx) => core.live.drm.serveLicence(ctx, drmSession(ctx)), { body: 'binary', ...tv });
  r.get('/api/live/drm/:sid/time', (ctx) => core.live.drm.serveTime(ctx, drmSession(ctx)), tv);
  r.post('/api/live/drm/:sid/ping', (ctx) => core.live.drm.ping(ctx.params.sid, ctx.user, ctx.profile));
  r.post('/api/live/drm/:sid/stop', (ctx) => {
    core.live.drm.get(ctx.params.sid, ctx.user, ctx.profile);
    core.live.drm.stop(ctx.params.sid, 'user');
    return { ok: true };
  });

  r.post('/api/live/programmes/:id/play', async (ctx) => {
    const p = store().programme(ctx.params.id);
    if (!p) throw new HttpError(404, 'This programme is no longer in the guide.');
    const channel = visibleChannel(ctx, p.channelId);
    const can = abilities(channel, p);
    if (!can.canCatchup && !can.canStartOver) throw new HttpError(400, "This programme can't be played from the archive");
    const body = await ctx.body();
    const { session, url, duration, start } = await core.live.streams.startCatchup({
      user: ctx.user,
      profile: ctx.profile,
      channel,
      programme: p,
      from: Number(body.from) || 0,
      caps: parseCaps(body.caps),
      quality: qualityOf(body),
      replaces: body.replaces ? String(body.replaces) : null,
      clientIp: core.auth.clientIp(ctx.req),
      isAdmin: isAdmin(ctx),
    });
    return sessionReply(session, url, { live: false, duration, start, channel: shapeChannel(channel), programme: shapeProgramme(p) });
  });

  // ---- Admin ----
  r.post(
    '/api/live/sources/:id/refresh',
    async (ctx) => {
      const key = decodeURIComponent(String(ctx.params.id));
      if (!plugins().getLiveSource(key)) throw new HttpError(404, 'This live source is no longer installed');
      return core.live.refresher.refresh(key, { reason: 'manual' });
    },
    admin,
  );

  const kidsProfile = (ctx) => {
    const p = core.profiles.get(ctx.user.id, Number(ctx.params.id));
    if (!p) throw new HttpError(404, 'No such profile');
    return p;
  };

  r.get('/api/profiles/:id/live-groups', (ctx) => store().kidsGroups(kidsProfile(ctx).id).map((g) => ({ source: g.source, group: g.grp })), admin);

  r.put(
    '/api/profiles/:id/live-groups',
    async (ctx) => {
      const p = kidsProfile(ctx);
      if (!p.kids) throw new HttpError(400, 'Live TV groups are for Kids profiles');
      const b = await ctx.body();
      const rows = (Array.isArray(b) ? b : Array.isArray(b?.groups) ? b.groups : [])
        .filter((g) => g && typeof g.source === 'string' && typeof g.group === 'string')
        .map((g) => ({ source: g.source, grp: g.group }));
      // { sources, groups }: only the sources the Settings page showed are replaced (others keep their ticks).
      const sources = !Array.isArray(b) && Array.isArray(b?.sources) ? b.sources.filter((k) => typeof k === 'string') : null;
      store().setKidsGroups(p.id, sources ? rows.filter((r) => sources.includes(r.source)) : rows, { sources });
      return store().kidsGroups(p.id).map((g) => ({ source: g.source, group: g.grp }));
    },
    admin,
  );

  /**
   * Home's "On now" cards: the viewer's favourites in their order, else the first 12 channels, each with what's on.
   * Pictures go through Atomix (the programme's, else the logo); nothing of the provider's address.
   */
  function homeCards(ctx, now = Date.now()) {
    if (!ctx.profile) return [];
    const favs = visibleChannels(ctx, { favouritesOf: ctx.profile.id });
    const list = (favs.length ? favs : visibleChannels(ctx)).slice(0, favs.length ? 50 : 12);
    if (!list.length) return [];
    const nn = store().nowNext(list.map((c) => c.id), now);
    return list.map((c) => {
      const p = nn.get(c.id)?.now || null;
      const logo = c.logo ? `/api/live/channels/${c.id}/logo` : null;
      return {
        kind: 'live',
        id: `live:${c.id}`,
        channelId: c.id,
        number: c.number,
        title: p?.title || c.name,
        subtitle: c.name,
        image: p?.image ? `/api/live/programmes/${p.id}/image` : logo,
        logo,
        progress: p ? Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start))) : 0,
        end: p?.end || null,
        radio: c.radio,
      };
    });
  }

  return { liveViewer, visibleChannel, visibleChannels, abilities, shapeChannel, shapeProgramme, homeCards };
}
