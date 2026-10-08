// Playback session, streaming and add-on (plugin source) endpoints.
import { HttpError } from '../http/router.js';
import { resolveSource } from '../remote/index.js';
import { serializeItem } from './serialize.js';
import { listSubtitles } from '../stream/subtitles.js';
import { QUALITIES } from '../stream/playback.js';
import { parseJson } from '../db.js';

const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []).map((s) => s.trim().toLowerCase()).filter(Boolean);

function parseCaps(input = {}) {
  return {
    // Clients always send their capabilities; the fallback assumes a typical browser.
    video: Array.isArray(input.video) || typeof input.video === 'string' ? list(input.video) : ['h264'],
    audio: Array.isArray(input.audio) || typeof input.audio === 'string' ? list(input.audio) : ['aac', 'mp3'],
    containers: list(input.containers).length ? list(input.containers) : ['mp4'],
    hls: Boolean(input.hls),
    hdr: Boolean(input.hdr),
  };
}

/** A connected server's title → its stream URL and headers; a local file → null. 502 when the server is gone. */
export async function remoteSourceFor(core, item) {
  const src = await resolveSource({ db: core.db, providers: core.remote.providers }, item);
  if (!src.remote) return null;
  if (!src.server) throw new HttpError(404, 'The server this title came from is no longer connected.');
  if (src.server.status === 'unauthorized') throw new HttpError(502, `Can't reach ${src.server.name}: sign in again in Settings.`);
  if (!src.file || !parseJson(item.media, null)) throw new HttpError(404, `${src.server.name} has no playable file for this title.`);
  return src;
}

export function registerPlaybackRoutes(r, core) {
  const { library, playback, plugins, settings, auth } = core;

  const remoteSource = (item) => remoteSourceFor(core, item);

  r.post('/api/items/:id/playback', async (ctx) => {
    const item = library.get(ctx.params.id);
    if (!item || !['movie', 'episode', 'track', 'extra'].includes(item.kind) || !library.canSee(ctx.viewer, item)) throw new HttpError(404, 'Nothing to play here');
    const body = await ctx.body();
    const media = parseJson(item.media, null);
    const quality = String(body.quality || settings.get('defaultQuality') || 'original');
    if (!(quality in QUALITIES)) throw new HttpError(400, 'Unknown quality');
    let burn = body.burnSubtitle != null && body.burnSubtitle !== '' ? Number(body.burnSubtitle) : null;
    if (burn != null && !media?.subtitles?.some((s) => s.index === burn)) burn = null;

    // `resume: true` (and no explicit start) continues from the saved position.
    const progress = library.progressFor(ctx.viewer.profileId, [item.id]).get(item.id) || null;
    let start = Math.max(0, Number(body.start) || 0);
    let resumed = false;
    if (body.resume && body.start == null && progress && !progress.watched && progress.position > 30) {
      start = progress.position;
      resumed = true;
    }

    const { session, url } = playback.create({
      user: ctx.user,
      profile: ctx.profile,
      item,
      caps: parseCaps(body.caps),
      source: await remoteSource(item),
      start,
      audioIndex: body.audioIndex != null && body.audioIndex !== '' ? Number(body.audioIndex) : null,
      quality,
      burnSubtitle: burn,
      forceTranscode: Boolean(body.forceTranscode),
      replaces: body.replaces,
      clientIp: auth.clientIp(ctx.req),
    });

    const listId = body.listId ? Number(body.listId) : null;
    const list = listId ? core.lists.get(listId) : null;
    const next = item.kind === 'track' || item.kind === 'extra' ? null : list && core.lists.visibleTo(list, ctx.viewer) ? core.lists.nextIn(list.id, item.id, ctx.viewer) : library.nextEpisode(item);
    const show = item.show_id ? library.get(item.show_id) : null;
    const parent = item.kind === 'extra' ? library.get(item.parent_id) : null;
    return {
      sessionId: session.id,
      parent: parent ? { id: parent.id, title: parent.title, kind: parent.kind } : undefined,
      mode: session.mode,
      delivery: session.delivery,
      url,
      start: session.mode === 'direct' ? start : session.start,
      resumed,
      duration: item.duration || media?.duration || null,
      reasons: session.reasons,
      quality,
      audioIndex: session.audio?.index ?? null,
      audioTracks: (media?.audio || []).map((a) => ({ index: a.index, codec: a.codec, channels: a.channels, language: a.language, title: a.title, default: a.default })),
      subtitles: listSubtitles(item, core.config),
      subtitleProviders: plugins.listSubtitleProviders(),
      item: serializeItem(item, { progress }),
      show: show ? serializeItem(show) : null,
      next: next ? serializeItem(next) : null,
      listId: list && core.lists.visibleTo(list, ctx.viewer) ? list.id : null,
      previews: item.kind === 'track' ? null : core.extras.previewManifest(item),
      markers: item.kind === 'episode' ? core.extras.playbackMarkers(item.id) : { intro: null, credits: null },
    };
  });

  r.post('/api/playback/:sid/stop', async (ctx) => {
    const s = playback.sessions.get(ctx.params.sid);
    if (s && s.userId === ctx.user.id) playback.stop(s.id, 'user');
    return { ok: true };
  });

  r.post('/api/playback/:sid/ping', async (ctx) => {
    const body = await ctx.body();
    playback.heartbeat(ctx.params.sid, ctx.user, body);
    return { ok: true };
  });

  r.get('/api/stream/:sid', (ctx) => playback.streamProgressive(ctx, ctx.params.sid), { cast: 'stream' });
  r.get('/api/hls/:sid/:file', (ctx) => playback.serveHls(ctx, ctx.params.sid, ctx.params.file), { cast: 'stream' });

  // AirPlay: the Apple TV fetches the media itself, so the player swaps to a cast link for its own session.
  r.post('/api/playback/:sid/cast-link', (ctx) => {
    const s = playback.sessions.get(ctx.params.sid);
    if (!s || s.userId !== ctx.user.id) throw new HttpError(404, 'No such playback session.');
    return { token: core.cast.links.issue({ sessionId: s.id, itemId: s.itemId, userId: ctx.user.id, profileId: ctx.profile?.id ?? null }) };
  });

  // ---- Add-on sources registered by plugins ----
  // Add-on content isn't age-rated, so Kids profiles only get it if a parent allows unrated titles.
  const sourcesAllowed = (viewer) => !viewer.kids || viewer.allowUnrated;

  r.get('/api/sources', (ctx) => (sourcesAllowed(ctx.viewer) ? plugins.listSources() : []));

  r.get('/api/sources/:plugin/:source/browse', async (ctx) => {
    if (!sourcesAllowed(ctx.viewer)) throw new HttpError(404, 'Add-ons are turned off for this profile.');
    const src = plugins.getSource(ctx.params.plugin, ctx.params.source);
    const result = await src.browse(String(ctx.query.path || ''), { user: ctx.user, viewer: ctx.viewer, query: ctx.query });
    return {
      source: { id: src.id, pluginId: src.pluginId, name: src.name || src.id, description: src.description || '', searchable: Boolean(src.searchable) },
      title: result?.title || src.name || src.id,
      items: (result?.items || []).map((i) => ({
        id: String(i.id ?? i.path ?? ''),
        kind: i.kind === 'folder' ? 'folder' : 'video',
        title: String(i.title || 'Untitled'),
        subtitle: i.subtitle || null,
        overview: i.overview || null,
        poster: i.poster || null,
        backdrop: i.backdrop || null,
        path: i.path ?? null,
        year: i.year || null,
      })),
      next: result?.next || null,
    };
  });

  r.post('/api/sources/:plugin/:source/resolve', async (ctx) => {
    if (!sourcesAllowed(ctx.viewer)) throw new HttpError(404, 'Add-ons are turned off for this profile.');
    const src = plugins.getSource(ctx.params.plugin, ctx.params.source);
    if (typeof src.resolve !== 'function') throw new HttpError(400, 'This source cannot play items');
    const body = await ctx.body();
    const out = await src.resolve(String(body.id || ''), { user: ctx.user, viewer: ctx.viewer });
    if (!out?.url) throw new HttpError(404, 'Nothing playable found for that item');
    if (!/^https?:\/\//i.test(out.url) && !out.url.startsWith('/')) throw new HttpError(500, 'Source returned an invalid URL');
    return {
      url: out.url,
      title: out.title || null,
      poster: out.poster || null,
      backdrop: out.backdrop || null,
      duration: out.duration || null,
      subtitles: (out.subtitles || []).map((s, i) => ({ id: `x${i}`, label: s.label || s.language || `Track ${i + 1}`, language: s.language || null, url: s.url, kind: 'text' })),
    };
  });
}
