// Fanart.tv (v0.23): fills missing clear logos, backgrounds and posters. Runs after TMDB (priority 60), so only what
// TMDB, the folder and .nfo files left empty is filled. Films by TMDB (or IMDb) id, shows by the TheTVDB id TMDB
// passes on, artists and albums by the MusicBrainz ids the MusicBrainz plugin passes on.
// API: https://fanart.tv/api-docs/api-v3/ — the key goes in the "api-key" header, never in the address.
import { createService, baseLanguage } from '../_lib/service.js';

const NO_KEY = 'Paste your free Fanart.tv personal key to start.';
const NO_LANG = new Set(['', '00', 'none']);

/** The best picture: the metadata language first, then English, then none; most liked first within each. */
export function pickImage(list, language) {
  if (!Array.isArray(list) || !list.length) return null;
  const want = [baseLanguage(language), 'en'];
  const rank = (img) => {
    const lang = String(img?.lang ?? '').toLowerCase();
    if (lang === want[0]) return 0;
    if (lang === want[1]) return 1;
    if (NO_LANG.has(lang)) return 2;
    return 3;
  };
  const best = list
    .filter((img) => img?.url && rank(img) < 3)
    .sort((a, b) => rank(a) - rank(b) || (Number(b.likes) || 0) - (Number(a.likes) || 0))[0];
  return best?.url || null;
}

// What each kind reads from Fanart.tv's answer: logo (in order of preference), backdrop, poster.
const FIELDS = {
  movie: { logo: ['hdmovielogo', 'movielogo'], backdrop: ['moviebackground'], poster: ['movieposter'] },
  show: { logo: ['hdtvlogo', 'clearlogo'], backdrop: ['showbackground'], poster: ['tvposter'] },
  artist: { logo: ['hdmusiclogo', 'musiclogo'], backdrop: ['artistbackground'], poster: ['artistthumb'] },
  album: { poster: ['albumcover'] },
};

const filled = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);

export function setup(api) {
  const svc = createService(api, {
    name: 'Fanart.tv',
    base: () => process.env.ATOMIX_FANART_BASE || 'https://webservice.fanart.tv',
    headers: () => ({ 'api-key': api.config.apiKey || '', 'User-Agent': `Atomix/${api.version || '0'}` }),
  });
  svc.start();
  let key = api.config.apiKey || '';
  api.setStatus(key ? null : NO_KEY);
  api.onConfigChange((cfg) => {
    const next = cfg.apiKey || '';
    api.setStatus(next ? null : NO_KEY);
    if (next && next !== key) {
      svc.ok();
      api.metadata.offerAgain(); // titles scanned before the key get it at the next scan
    }
    key = next;
  });

  /** Fanart.tv's answer for one title, kept in storage: { logo?: [...], backdrop?: [...], poster?: [...] } lists. */
  async function lookup(kind, id, force) {
    return svc.cached(`${kind}:${id}`, { force }, async () => {
      const path = { movie: `/v3/movies/${id}`, show: `/v3/tv/${id}`, artist: `/v3/music/${id}`, album: `/v3/music/albums/${id}` }[kind];
      const data = await svc.json(path);
      svc.ok();
      if (!data) return null;
      const src = kind === 'album' ? data.albums?.[id] || {} : data;
      const out = {};
      for (const [field, names] of Object.entries(FIELDS[kind])) {
        const list = names.map((n) => src[n]).find((l) => Array.isArray(l) && l.length);
        if (list) out[field] = list.map((i) => ({ url: i.url, lang: i.lang, likes: i.likes }));
      }
      return Object.keys(out).length ? out : null;
    });
  }

  api.registerMetadataProvider({
    id: 'fanart-tv',
    name: 'Fanart.tv',
    priority: 60,
    kinds: ['movie', 'show', 'artist', 'album'],
    async fetch(item, ctx) {
      const cfg = api.config;
      if (!cfg.apiKey) return null;
      const m = ctx.merged || {};
      const id =
        item.kind === 'movie' ? m.tmdbId ?? item.tmdb_id ?? m.imdbId ?? item.imdb_id
        : item.kind === 'show' ? m.tvdbId
        : item.kind === 'artist' ? m.musicbrainzArtistId
        : m.musicbrainzId;
      if (!id) return null;
      // Albums and artists: the row's own picture (a cover embedded in the songs) counts as filled too.
      const own = item.kind === 'album' || item.kind === 'artist';
      const wanted = Object.keys(FIELDS[item.kind]).filter(
        (f) => cfg[`fill${f[0].toUpperCase()}${f.slice(1)}`] !== false && !filled(m[f]) && !(own && filled(item[f])),
      );
      if (!wanted.length) return null;
      try {
        const found = await lookup(item.kind, id, Boolean(ctx.force));
        if (!found) return null;
        const out = {};
        for (const f of wanted) {
          const url = pickImage(found[f], api.metadataLanguage);
          if (url) out[f] = url;
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
