// Podcasts in music apps (v0.22): getPodcasts and getNewestPodcasts, read-only (subscribing stays in Atomix). A
// channel's `url` is always '' — the feed address stays on the server. Audiobooks are not shown to music apps.
import path from 'node:path';
import { parseJson } from '../db.js';

const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
const TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav' };
const STATUS = { done: 'completed', downloading: 'downloading', queued: 'downloading', failed: 'error', new: 'new', unsupported: 'skipped' };

function episode(row) {
  const ext = path.extname(row.path || '').slice(1).toLowerCase();
  return {
    id: `pe-${row.id}`,
    streamId: row.path ? `pe-${row.id}` : undefined,
    channelId: `pc-${row.show_id}`,
    title: row.title,
    description: row.overview || '',
    publishDate: iso(row.published_at),
    status: row.path ? 'completed' : STATUS[row.status] || 'new',
    duration: row.duration ? Math.round(row.duration) : undefined,
    contentType: row.path ? TYPES[ext] || 'audio/mpeg' : undefined,
    suffix: row.path ? ext || undefined : undefined,
    size: row.size ?? undefined,
    coverArt: `pc-${row.show_id}`,
    isDir: false,
    type: 'podcast',
    bitRate: parseJson(row.media, {})?.bitrate ? Math.round(parseJson(row.media, {}).bitrate / 1000) : undefined,
  };
}

export function registerPodcasts(s) {
  const shows = (ctx) => ctx.core.db.all("SELECT * FROM items WHERE kind = 'podcast' ORDER BY sort_title COLLATE NOCASE, id").filter((r) => ctx.core.library.canSee(ctx.viewer, r));
  const episodes = (ctx, showId) =>
    ctx.core.db
      .all("SELECT i.*, e.status FROM items i JOIN podcast_episodes e ON e.item_id = i.id WHERE i.show_id = ? AND i.kind = 'podcast_episode' ORDER BY i.published_at IS NULL, i.published_at DESC, i.id DESC", showId)
      .filter((r) => ctx.core.library.canSee(ctx.viewer, r));

  s.method('getPodcasts', (ctx) => {
    const withEpisodes = String(ctx.params.get('includeEpisodes') ?? 'true') !== 'false';
    const only = /^pc-(\d+)$/.exec(String(ctx.params.get('id') || ''))?.[1];
    const channel = shows(ctx)
      .filter((r) => !only || r.id === Number(only))
      .map((r) => ({
        id: `pc-${r.id}`,
        url: '',
        title: r.title,
        description: r.overview || '',
        coverArt: `pc-${r.id}`,
        originalImageUrl: '',
        status: 'completed',
        ...(withEpisodes ? { episode: episodes(ctx, r.id).map(episode) } : {}),
      }));
    return { podcasts: { channel } };
  });

  s.method('getNewestPodcasts', (ctx) => {
    const count = Math.max(1, Math.min(100, Number(ctx.params.get('count')) || 20));
    const visible = new Set(shows(ctx).map((r) => r.id));
    const rows = ctx.core.db
      .all("SELECT i.*, e.status FROM items i JOIN podcast_episodes e ON e.item_id = i.id WHERE i.kind = 'podcast_episode' AND i.path IS NOT NULL ORDER BY i.published_at DESC, i.id DESC LIMIT 500")
      .filter((r) => visible.has(r.show_id) && ctx.core.library.canSee(ctx.viewer, r))
      .slice(0, count);
    return { newestPodcasts: { episode: rows.map(episode) } };
  });
}
