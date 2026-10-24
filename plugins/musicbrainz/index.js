// MusicBrainz (v0.23): an album's first-release year, genres and Cover Art Archive cover — only where the album
// has none (a cover in its folder or embedded in its songs always stays) — and the MusicBrainz ids Fanart.tv looks
// albums and artists up by. At most one request a second, with a User-Agent saying who is asking.
// API: https://musicbrainz.org/doc/MusicBrainz_API — covers: https://musicbrainz.org/doc/Cover_Art_Archive/API
import { createService } from '../_lib/service.js';

const SKIP_ARTISTS = new Set(['various artists', 'unknown artist']);

/** A Lucene phrase: "…" with \ and " escaped. */
export const luceneQuote = (s) => `"${String(s ?? '').replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** A name for comparing: lower case, & → and, (…) and […] parts, punctuation and a leading "the " gone. */
export function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

const capital = (s) => s[0].toUpperCase() + s.slice(1);
const filled = (v) => v != null && v !== '' && v !== '[]' && !(Array.isArray(v) && !v.length);

export function setup(api) {
  const userAgent = () => {
    const contact = String(api.config.contact || '').trim();
    return contact ? `Atomix/${api.version || '0'} ( ${contact} )` : `Atomix/${api.version || '0'}`;
  };
  const svc = createService(api, {
    name: 'MusicBrainz',
    base: () => process.env.ATOMIX_MUSICBRAINZ_BASE || 'https://musicbrainz.org',
    gapMs: 1000,
    headers: () => ({ 'User-Agent': userAgent() }),
  });
  const art = createService(api, {
    name: 'The Cover Art Archive',
    base: () => process.env.ATOMIX_COVERART_BASE || 'https://coverartarchive.org',
    headers: () => ({ 'User-Agent': `Atomix/${api.version || '0'}` }), // the contact email is for MusicBrainz only
  });
  svc.start();
  const coverBase = () => (process.env.ATOMIX_COVERART_BASE || 'https://coverartarchive.org').replace(/\/$/, '');

  /** The release group that is this album: { id, year, genres, front } or null. */
  async function findAlbum(title, artist, force) {
    const various = SKIP_ARTISTS.has(normName(artist)) || !artist;
    return svc.cached(`rg:${normName(artist)}|${normName(title)}`, { force }, async () => {
      const query = `releasegroup:${luceneQuote(title)}${various ? '' : ` AND artist:${luceneQuote(artist)}`}`;
      const found = await svc.json('/ws/2/release-group/', { query: { query, limit: 5, fmt: 'json' } });
      svc.ok();
      const rg = (found?.['release-groups'] || []).find(
        (g) =>
          Number(g.score) >= 90 &&
          normName(g.title) === normName(title) &&
          (various || (g['artist-credit'] || []).some((c) => normName(c?.name ?? c?.artist?.name) === normName(artist))),
      );
      if (!rg?.id) return null;
      const full = await svc.json(`/ws/2/release-group/${encodeURIComponent(rg.id)}`, { query: { inc: 'genres', fmt: 'json' } });
      const genres = (full?.genres || [])
        .filter((g) => g?.name && Number(g.count) > 0)
        .sort((a, b) => Number(b.count) - Number(a.count))
        .slice(0, 3)
        .map((g) => capital(g.name));
      return { id: rg.id, year: Number.parseInt(String(rg['first-release-date'] || ''), 10) || null, genres };
    });
  }

  /** Whether the Cover Art Archive has a front cover for the release group (kept, like the rest). */
  async function hasFront(id, force) {
    return svc.cached(`front:${id}`, { force }, async () => {
      const list = await art.json(`/release-group/${encodeURIComponent(id)}`);
      return (list?.images || []).some((i) => i?.front) ? true : null;
    });
  }

  async function findArtist(name, force) {
    return svc.cached(`ar:${normName(name)}`, { force }, async () => {
      const found = await svc.json('/ws/2/artist/', { query: { query: `artist:${luceneQuote(name)}`, limit: 5, fmt: 'json' } });
      svc.ok();
      const a = (found?.artists || []).find((x) => Number(x.score) >= 90 && normName(x.name) === normName(name));
      return a?.id || null;
    });
  }

  api.registerMetadataProvider({
    id: 'musicbrainz',
    name: 'MusicBrainz',
    priority: 55,
    kinds: ['album', 'artist'],
    async fetch(item, ctx) {
      const force = Boolean(ctx.force);
      try {
        if (item.kind === 'artist') {
          if (!item.title || SKIP_ARTISTS.has(normName(item.title))) return null;
          const id = await findArtist(item.title, force);
          return id ? { musicbrainzArtistId: id } : null;
        }
        if (!item.title) return null;
        const rg = await findAlbum(item.title, item.artist, force);
        if (!rg) return null;
        const out = { musicbrainzId: rg.id };
        if (!filled(item.year) && rg.year) out.year = rg.year;
        if (!filled(item.genres) && rg.genres.length) out.genres = rg.genres;
        // A cover in the album's folder (ctx.merged) or embedded in its songs (the row) always stays.
        if (!filled(item.poster) && !filled(ctx.merged?.poster)) {
          try {
            if (await hasFront(rg.id, force)) out.poster = `${coverBase()}/release-group/${rg.id}/front-500`;
          } catch (err) {
            svc.failed(item, err);
          }
        }
        return out;
      } catch (err) {
        svc.failed(item, err);
        return null;
      }
    },
  });

  return () => svc.flush();
}
