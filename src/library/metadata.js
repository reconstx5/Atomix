// Metadata providers: local artwork, TMDB, plus any registered by plugins.
// Providers run in priority order (lowest number first); earlier providers
// win, later ones only fill in fields that are still empty.
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../log.js';
import { parseSeasonFolder, sortTitle } from './parser.js';
import { parseJson } from '../db.js';
import { certToAge, pickMovieCertification, pickTvCertification } from './ratings.js';

const log = logger('metadata');
const FIELDS = [
  'title', 'originalTitle', 'year', 'overview', 'tagline', 'genres', 'rating', 'runtime', 'airDate',
  'poster', 'backdrop', 'logo', 'tmdbId', 'imdbId', 'certification',
];
// Kodi calls the transparent title artwork "clearlogo"; Plex/Jellyfin use "logo".
const LOGO_NAMES = ['clearlogo', 'logo'];

/**
 * Pick the best TMDB logo: the metadata language first, then English, then
 * language-less artwork; most votes wins within a language.
 */
export function pickLogo(logos, language = 'en-US') {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const order = [lang, 'en', null];
  const rank = (l) => {
    const i = order.indexOf(l?.iso_639_1 ?? null);
    return i === -1 ? order.length : i;
  };
  const usable = (logos || []).filter((l) => l?.file_path && !/\.svg$/i.test(l.file_path));
  usable.sort((a, b) => rank(a) - rank(b) || (b.vote_average || 0) - (a.vote_average || 0));
  return usable.length && rank(usable[0]) < order.length ? usable[0].file_path : null;
}
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.tbn'];

function findImage(dir, names) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const name of names) {
    for (const ext of IMAGE_EXTS) {
      const hit = lower.get((name + ext).toLowerCase());
      if (hit) return path.join(dir, hit);
    }
  }
  return null;
}

/** Built-in: artwork files next to the media (Kodi/Plex naming). */
export const localArtworkProvider = {
  id: 'local-artwork',
  name: 'Local artwork',
  priority: 5,
  kinds: ['movie', 'show', 'season', 'episode', 'album', 'artist'],
  async fetch(item, ctx) {
    if (item.kind === 'album' && item.path) {
      const dir = item.path.split('::album::')[0];
      return { poster: findImage(dir, ['cover', 'folder', 'front', 'album', 'albumart', 'albumartlarge', 'thumb']) };
    }
    if (item.kind === 'artist') {
      // Artists have no folder of their own in the database; look next to one of their albums.
      const albums = ctx.db?.all(`SELECT path FROM items WHERE parent_id = ? AND kind = 'album'`, item.id) || [];
      for (const a of albums) {
        const albumDir = a.path.split('::album::')[0];
        const artistDir = path.dirname(albumDir);
        // Loose files in the library folder itself have no artist folder.
        if (ctx.libraryRoots.some((r) => [albumDir, artistDir].some((d) => path.resolve(r) === path.resolve(d)))) continue;
        const poster = findImage(artistDir, ['artist', 'folder', 'poster']);
        const backdrop = findImage(artistDir, ['fanart', 'backdrop']);
        const logo = findImage(artistDir, LOGO_NAMES);
        if (poster || backdrop || logo) return { poster, backdrop, logo };
      }
      return null;
    }
    if (item.kind === 'movie' && item.path) {
      const dir = path.dirname(item.path);
      const base = path.parse(item.path).name;
      const ownFolder = !ctx.libraryRoots.some((r) => path.resolve(r) === path.resolve(dir));
      const posterNames = [`${base}-poster`, `${base}`];
      const fanartNames = [`${base}-fanart`, `${base}-backdrop`];
      const logoNames = LOGO_NAMES.map((n) => `${base}-${n}`);
      if (ownFolder) {
        posterNames.push('poster', 'folder', 'cover', 'movie');
        fanartNames.push('fanart', 'backdrop', 'background');
        logoNames.push(...LOGO_NAMES);
      }
      return { poster: findImage(dir, posterNames), backdrop: findImage(dir, fanartNames), logo: findImage(dir, logoNames) };
    }
    if (item.kind === 'show' && item.path) {
      return {
        poster: findImage(item.path, ['poster', 'folder', 'cover', 'show']),
        backdrop: findImage(item.path, ['fanart', 'backdrop', 'background']),
        logo: findImage(item.path, LOGO_NAMES),
      };
    }
    if (item.kind === 'season' && ctx.show?.path) {
      const n = String(item.season).padStart(2, '0');
      const names = item.season === 0 ? ['season-specials-poster', 'season00-poster', 'specials'] : [`season${n}-poster`, `season${n}`, `season${item.season}-poster`];
      let poster = findImage(ctx.show.path, names);
      if (!poster) {
        try {
          for (const e of fs.readdirSync(ctx.show.path, { withFileTypes: true })) {
            if (e.isDirectory() && parseSeasonFolder(e.name) === item.season) {
              poster = findImage(path.join(ctx.show.path, e.name), ['poster', 'folder', 'cover']);
              if (poster) break;
            }
          }
        } catch {
          /* ignore */
        }
      }
      return { poster };
    }
    if (item.kind === 'episode' && item.path) {
      const dir = path.dirname(item.path);
      const base = path.parse(item.path).name;
      return { poster: findImage(dir, [`${base}-thumb`, base]) };
    }
    return null;
  },
};

/** Built-in: The Movie Database (https://www.themoviedb.org). Needs a free API key. */
export class TmdbProvider {
  constructor({ config, settings }) {
    this.id = 'tmdb';
    this.name = 'TMDB';
    this.priority = 50;
    this.kinds = ['movie', 'show', 'season', 'episode'];
    this.config = config;
    this.settings = settings;
    this.cache = new Map();
  }

  get key() {
    return this.settings.get('tmdbApiKey') || this.config.initialTmdbKey || '';
  }

  enabled() {
    return Boolean(this.key);
  }

  async request(pathname, params = {}) {
    const key = this.key;
    if (!key) return null;
    // After a rejected key, pause for a minute instead of failing once per item.
    if (this.rejectedKey === key && Date.now() < this.rejectedUntil) throw new Error('TMDB rejected the API key (401). Check Settings → Server → Metadata.');
    const url = new URL(this.config.tmdbBase + pathname);
    const headers = { Accept: 'application/json' };
    // v4 "read access tokens" are JWTs; v3 keys are 32 hex characters.
    if (key.length > 40) headers.Authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);
    url.searchParams.set('language', this.settings.get('metadataLanguage') || 'en-US');
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);

    const cacheKey = url.toString().replace(/api_key=[^&]+/, '');
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.data;

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (res.status === 404) return null;
      if (res.status === 401) {
        this.rejectedKey = key;
        this.rejectedUntil = Date.now() + 60000;
        throw new Error('TMDB rejected the API key (401). Check Settings → Server → Metadata.');
      }
      if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
      const data = await res.json();
      this.cache.set(cacheKey, { data, expires: Date.now() + 6 * 3600 * 1000 });
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
      return data;
    }
    throw new Error('TMDB rate limit');
  }

  img(p, size) {
    return p ? `${this.config.tmdbImageBase}/${size}${p}` : null;
  }

  /** Languages for TMDB artwork: the metadata language, English, and language-less images. */
  imageLanguages() {
    const lang = String(this.settings.get('metadataLanguage') || 'en').slice(0, 2).toLowerCase();
    return [...new Set([lang, 'en', 'null'])].join(',');
  }

  async search(kind, query, year) {
    if (kind === 'movie') {
      let data = await this.request('/search/movie', { query, year });
      if (year && !data?.results?.length) data = await this.request('/search/movie', { query });
      return (data?.results || []).map((r) => ({
        tmdbId: r.id,
        title: r.title,
        year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
        overview: r.overview,
        poster: this.img(r.poster_path, 'w185'),
      }));
    }
    let data = await this.request('/search/tv', { query, first_air_date_year: year });
    if (year && !data?.results?.length) data = await this.request('/search/tv', { query });
    return (data?.results || []).map((r) => ({
      tmdbId: r.id,
      title: r.name,
      year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
      overview: r.overview,
      poster: this.img(r.poster_path, 'w185'),
    }));
  }

  async findByImdb(imdbId, kind) {
    const data = await this.request(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' });
    const hit = kind === 'movie' ? data?.movie_results?.[0] : data?.tv_results?.[0];
    return hit?.id || null;
  }

  async fetch(item, ctx) {
    if (!this.enabled()) return null;
    if (item.kind === 'movie') {
      let id = ctx.tmdbId ?? ctx.merged.tmdbId ?? item.tmdb_id;
      if (!id && ctx.merged.imdbId) id = await this.findByImdb(ctx.merged.imdbId, 'movie');
      if (!id) {
        const results = await this.search('movie', ctx.merged.title || item.title, ctx.merged.year || item.year);
        id = results[0]?.tmdbId;
      }
      if (!id) return null;
      const m = await this.request(`/movie/${id}`, { append_to_response: 'release_dates,images', include_image_language: this.imageLanguages() });
      if (!m) return null;
      return {
        tmdbId: m.id,
        imdbId: m.imdb_id || null,
        title: m.title,
        originalTitle: m.original_title !== m.title ? m.original_title : null,
        year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
        overview: m.overview || null,
        tagline: m.tagline || null,
        genres: (m.genres || []).map((g) => g.name),
        rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
        runtime: m.runtime || null,
        airDate: m.release_date || null,
        poster: this.img(m.poster_path, 'w500'),
        backdrop: this.img(m.backdrop_path, 'w1280'),
        logo: this.img(pickLogo(m.images?.logos, this.settings.get('metadataLanguage')), 'w500'),
        certification: pickMovieCertification(m.release_dates, this.settings.get('ratingCountry')),
      };
    }
    if (item.kind === 'show') {
      let id = ctx.tmdbId ?? ctx.merged.tmdbId ?? item.tmdb_id;
      if (!id && ctx.merged.imdbId) id = await this.findByImdb(ctx.merged.imdbId, 'tv');
      if (!id) {
        const results = await this.search('tv', ctx.merged.title || item.title, ctx.merged.year || item.year);
        id = results[0]?.tmdbId;
      }
      if (!id) return null;
      const s = await this.request(`/tv/${id}`, { append_to_response: 'external_ids,content_ratings,images', include_image_language: this.imageLanguages() });
      if (!s) return null;
      return {
        tmdbId: s.id,
        imdbId: s.external_ids?.imdb_id || null,
        title: s.name,
        originalTitle: s.original_name !== s.name ? s.original_name : null,
        year: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null,
        overview: s.overview || null,
        tagline: s.tagline || null,
        genres: (s.genres || []).map((g) => g.name),
        rating: s.vote_average ? Math.round(s.vote_average * 10) / 10 : null,
        runtime: s.episode_run_time?.[0] || null,
        airDate: s.first_air_date || null,
        poster: this.img(s.poster_path, 'w500'),
        backdrop: this.img(s.backdrop_path, 'w1280'),
        logo: this.img(pickLogo(s.images?.logos, this.settings.get('metadataLanguage')), 'w500'),
        certification: pickTvCertification(s.content_ratings, this.settings.get('ratingCountry')),
      };
    }
    if (item.kind === 'season' || item.kind === 'episode') {
      const showId = ctx.show?.tmdb_id;
      if (!showId || item.season == null) return null;
      const season = await this.request(`/tv/${showId}/season/${item.season}`);
      if (!season) return null;
      if (item.kind === 'season') {
        return {
          overview: season.overview || null,
          airDate: season.air_date || null,
          poster: this.img(season.poster_path, 'w500'),
        };
      }
      const ep = (season.episodes || []).find((e) => e.episode_number === item.episode);
      if (!ep) return null;
      return {
        tmdbId: ep.id,
        title: ep.name || null,
        overview: ep.overview || null,
        airDate: ep.air_date || null,
        rating: ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : null,
        runtime: ep.runtime || null,
        poster: this.img(ep.still_path, 'w400'),
      };
    }
    return null;
  }
}

const keepOldValue = (opts) => !opts.clear;

export class MetadataManager {
  constructor({ db, config, settings, images, hooks }) {
    this.db = db;
    this.settings = settings;
    this.images = images;
    this.hooks = hooks;
    this.tmdb = new TmdbProvider({ config, settings });
    this.providers = [localArtworkProvider, this.tmdb];
  }

  register(provider, owner) {
    if (!provider?.id || typeof provider.fetch !== 'function') throw new Error('Metadata provider needs an id and fetch()');
    this.providers.push({ priority: 100, kinds: ['movie', 'show', 'season', 'episode'], ...provider, owner });
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  removeByOwner(owner) {
    this.providers = this.providers.filter((p) => p.owner !== owner);
  }

  list() {
    return this.providers.map((p) => ({ id: p.id, name: p.name || p.id, priority: p.priority, owner: p.owner || 'core' }));
  }

  libraryRoots(libraryId) {
    const lib = this.db.get('SELECT paths FROM libraries WHERE id = ?', libraryId);
    return parseJson(lib?.paths, []);
  }

  /**
   * Refresh one item's metadata from all providers.
   * @param {object} item  DB row
   * @param {{force?: boolean, tmdbId?: number, clear?: boolean}} opts
   */
  async refresh(item, opts = {}) {
    if (item.metadata_locked && !opts.force) return item;
    const show = item.show_id ? this.db.get('SELECT * FROM items WHERE id = ?', item.show_id) : null;
    const ctx = { merged: {}, show, libraryRoots: this.libraryRoots(item.library_id), tmdbId: opts.tmdbId, force: opts.force, db: this.db };
    for (const provider of this.providers) {
      if (!provider.kinds.includes(item.kind)) continue;
      if (opts.tmdbId && provider.id !== 'tmdb' && provider.id !== 'local-artwork') continue;
      try {
        const result = await provider.fetch(item, ctx);
        if (!result) continue;
        for (const f of FIELDS) {
          const v = result[f];
          const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
          const have = ctx.merged[f] != null && !(Array.isArray(ctx.merged[f]) && !ctx.merged[f].length);
          if (!empty && !have) ctx.merged[f] = v;
        }
      } catch (err) {
        log.warn(`${provider.id} failed for "${item.title}": ${err.message}`);
      }
    }
    const m = ctx.merged;
    const [poster, backdrop, logo] = await Promise.all([this.images.store(m.poster), this.images.store(m.backdrop), this.images.store(m.logo)]);
    const certification = m.certification || (keepOldValue(opts) ? item.certification : null) || null;
    const minAge = certToAge(certification, this.settings?.get?.('ratingCountry'));
    const keepOld = !opts.clear;
    const pick = (newV, oldV) => (newV != null ? newV : keepOld ? oldV : null);
    const now = Date.now();
    this.db.run(
      `UPDATE items SET title = ?, original_title = ?, year = ?, overview = ?, tagline = ?, genres = ?, rating = ?,
         runtime = ?, air_date = ?, poster = ?, backdrop = ?, logo = ?, tmdb_id = ?, imdb_id = ?, metadata_at = ?, updated_at = ?,
         metadata_locked = ?, certification = ?, min_age = ?
       WHERE id = ?`,
      m.title || item.title,
      pick(m.originalTitle, item.original_title),
      pick(m.year, item.year),
      pick(m.overview, item.overview),
      pick(m.tagline, item.tagline),
      JSON.stringify(m.genres || (keepOld ? parseJson(item.genres, []) : [])),
      pick(m.rating, item.rating),
      pick(m.runtime, item.runtime),
      pick(m.airDate, item.air_date),
      poster || (keepOld ? item.poster : null),
      backdrop || (keepOld ? item.backdrop : null),
      logo || (keepOld ? item.logo ?? null : null),
      item.kind === 'episode' ? item.tmdb_id : pick(m.tmdbId, item.tmdb_id),
      pick(m.imdbId, item.imdb_id),
      now,
      now,
      opts.tmdbId ? 1 : item.metadata_locked,
      certification,
      minAge,
      item.id,
    );
    const updated = this.db.get('SELECT * FROM items WHERE id = ?', item.id);
    if (m.title && item.kind !== 'season') {
      this.db.run('UPDATE items SET sort_title = ? WHERE id = ?', sortTitle(updated.title), item.id);
    }
    await this.hooks?.emit('metadata:updated', { item: updated });
    return updated;
  }
}
