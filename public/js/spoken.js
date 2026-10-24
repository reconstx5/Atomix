// Starting audiobooks and podcast episodes (v0.22). A book in several files plays as its parts in the queue, each
// carrying the book's data (parts with their start times, chapters, the whole length), so the bar shows one
// timeline; it starts where the profile left off — 5 s earlier after more than 10 minutes away.
import { api } from './api.js';
import { music } from './music.js';
import { partAt, resumePoint } from './spoken-time.js';

/** The queue entries for a book (`data` is GET /api/items/:id of an audiobook). */
export function bookEntries(data) {
  const { item, parts = [], chapters = [] } = data;
  const total = parts.reduce((s, p) => s + (p.duration || 0), 0) || item.duration || 0;
  return parts.map((p, i) => ({
    id: p.id,
    kind: p.id === item.id ? 'audiobook' : 'chapter',
    title: item.title,
    artist: item.author || null,
    poster: item.poster || null,
    duration: p.duration || null,
    spoken: { kind: 'book', bookId: item.id, title: item.title, author: item.author || null, parts, partIndex: i, chapters, total },
  }));
}

/** A podcast episode's queue entry (its show's title as the "author" line). */
export function episodeEntry(ep, show = null) {
  const host = show?.title || ep.showTitle || null;
  return {
    id: ep.id,
    kind: 'podcast_episode',
    title: ep.title,
    artist: host,
    poster: ep.poster || show?.poster || ep.showPoster || null,
    duration: ep.duration || null,
    spoken: { kind: 'episode', title: ep.title, author: host, parts: [], partIndex: 0, chapters: [], total: ep.duration || 0 },
  };
}

/** Where to start: the saved place (finished: from the start). */
const startOf = (progress) => (progress && !progress.watched ? resumePoint(progress) : 0);

/** Play a book from where the profile left off (or from `from` seconds on its timeline). */
export async function playBook(book, { data = null, from = null } = {}) {
  const d = data || (await api.get(`/api/items/${book.id}`));
  const entries = bookEntries(d);
  if (!entries.length) return;
  const start = from ?? startOf(d.item.progress);
  const { index, offset } = partAt(d.parts.length > 1 ? d.parts : [], start);
  music.playTracks(entries, d.parts.length > 1 ? index : 0, { at: offset });
}

/** Play an episode — with `list`, the episodes after it follow in that order. */
export function playEpisode(ep, { list = null, show = null, from = null } = {}) {
  const eps = list?.length ? list : [ep];
  const i = Math.max(0, eps.findIndex((e) => e.id === ep.id));
  music.playTracks(eps.map((e) => episodeEntry(e, show)), i, { at: from ?? startOf(ep.progress) });
}
