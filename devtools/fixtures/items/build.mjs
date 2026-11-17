// Writes the made-up title-page answers (`<id>.json`, what GET /api/items/:id returns) used by item-fixtures.mjs.
// Shapes follow src/api/library.js (GET /api/items/:id) and src/api/serialize.js. Run: node devtools/fixtures/items/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ADDED = 1794848673750;
const art = (type, id) => `/fake-art/${type}-${id}.svg`;

function base(id, kind, title, extra = {}) {
  return {
    id, kind, libraryId: 1, parentId: null, showId: null, title, sortTitle: title.toLowerCase(), year: null, season: null, episode: null,
    overview: null, genres: [], rating: null, runtime: null, airDate: null, duration: null, poster: null, backdrop: null, logo: null,
    addedAt: ADDED, tint: null, tintWide: null, progress: null, playCount: 0, lastPlayed: null, stars: null, favourite: false, ...extra,
  };
}
function full(item) {
  return { tagline: null, originalTitle: null, tmdbId: null, imdbId: null, scores: null, media: null, fileName: null, size: null, metadataLocked: false, certification: null, minAge: null, lockedFields: [], ...item };
}
const MEDIA_4K = { resolution: '4K', width: 3840, height: 2160, videoCodec: 'hevc', hdr: true, hdrFormat: 'dolby-vision', atmos: true, bitDepth: 10, container: 'matroska,webm', bitrate: 42000000, audio: [{ index: 1, codec: 'truehd', channels: 8, language: 'eng', title: 'Atmos', default: true }, { index: 2, codec: 'ac3', channels: 6, language: 'fra', title: null, default: false }], subtitles: 2 };
const MEDIA_HD = { resolution: '1080p', width: 1920, height: 1080, videoCodec: 'h264', hdr: false, hdrFormat: null, atmos: false, bitDepth: 8, container: 'mov,mp4,m4a,3gp,3g2,mj2', bitrate: 8000000, audio: [{ index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: true }], subtitles: 0 };
const film = (id, title, extra = {}) => base(id, 'movie', title, { year: 2020 + (id % 5), duration: 6000, runtime: 100, poster: art('poster', id), backdrop: art('backdrop', id), ...extra });
const movieOut = (item, extra = {}) => ({ item: full(item), subtitles: [], collection: null, inWatchlist: false, inLists: [], similar: [], extras: [], trailer: null, ...extra });

const files = {};

// 900001: a film with everything.
files[900001] = movieOut(
  film(900001, 'The Lighthouse Keeper', {
    overview: 'A keeper on a remote island finds a message in the lamp room that should not exist.',
    tagline: 'Every light hides a shadow.', genres: ['Drama', 'Mystery', 'Thriller'], rating: 7.8, certification: 'M',
    logo: art('logo', 900001), media: MEDIA_4K, fileName: 'The Lighthouse Keeper (2021).mkv', size: 52_000_000_000, originalTitle: 'Le Gardien du phare',
  }),
  {
    subtitles: [{ id: 'e1', label: 'English', language: 'eng' }, { id: 'e2', label: 'Français', language: 'fra' }],
    trailer: { kind: 'youtube', key: 'abc123', name: 'Trailer' },
    extras: [
      base(900101, 'extra', 'Making the island', { parentId: 900001, duration: 600, poster: art('backdrop', 900101) }),
      base(900102, 'extra', 'Deleted scenes', { parentId: 900001, duration: 420, poster: art('backdrop', 900102) }),
    ],
    collection: {
      id: 77, name: 'The Keeper Collection', owned: 3, total: 4,
      items: [film(900111, 'The First Light'), { ...film(900001, 'The Lighthouse Keeper'), isCurrent: true }, film(900112, 'The Last Light')].map((i) => ({ isCurrent: false, ...i })),
    },
    similar: [film(900121, 'Tide Line'), film(900122, 'Fog Bank'), film(900123, 'Salt Wind'), film(900124, 'North Cape')],
    inWatchlist: true,
  },
);
// 900002: part-watched.
files[900002] = movieOut(film(900002, 'Night Ferry', { overview: 'Two strangers share the last crossing of the year.', genres: ['Drama'], media: MEDIA_HD, fileName: 'Night Ferry (2022).mp4', size: 3_400_000_000, progress: { position: 1800, duration: 6000, watched: false, updatedAt: ADDED } }));
// 900003: no pictures, no overview.
files[900003] = movieOut(base(900003, 'movie', 'Untitled Home Movie', { duration: 1200 }));
// 900004: a logo that fails to load.
files[900004] = movieOut(film(900004, 'Broken Signal', { overview: 'The logo for this one never arrives.', logo: art('logo', 404), media: MEDIA_HD }));
// 900005: a film from a connected server.
files[900005] = movieOut(film(900005, 'Borrowed Time', { overview: 'Streams from a friend’s server.', remote: true, media: MEDIA_HD, fileName: 'Borrowed Time.mkv', serverName: 'Sam’s Atomix' }));

// 900010: a show with 3 seasons; 900011 all watched; next episode in 900012.
const show = base(900010, 'show', 'Coastal Watch', { overview: 'A small coastguard station and the town it keeps safe.', genres: ['Drama', 'Crime'], year: 2019, poster: art('poster', 900010), backdrop: art('backdrop', 900010), logo: art('logo', 900010), playCount: null });
const ep = (id, seasonId, s, e, extra = {}) => base(id, 'episode', `Episode title ${s}.${e}`, { libraryId: 2, parentId: seasonId, showId: 900010, season: s, episode: e, duration: 2700, airDate: `2019-0${s}-0${e}`, overview: `What happens in season ${s}, episode ${e}.`, poster: art('backdrop', id), ...extra });
const watched = { position: 2700, duration: 2700, watched: true, updatedAt: ADDED };
const seasons = [
  { id: 900011, s: 1, eps: [1, 2, 3].map((e) => ep(900200 + e, 900011, 1, e, { progress: watched, playCount: 1 })), overview: null },
  // Season 2: long enough to scroll Orbit's row; episodes 1-5 watched, 6 part-watched (where the row opens).
  { id: 900012, s: 2, eps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((e) => ep(900210 + e, 900012, 2, e, e === 6 ? { progress: { position: 900, duration: 2700, watched: false, updatedAt: ADDED } } : e < 6 ? { progress: watched, playCount: 1 } : {})), overview: 'Season two moves the station to the harbour.' },
  { id: 900013, s: 3, eps: [1, 2, 3].map((e) => ep(900220 + e, 900013, 3, e)), overview: null },
];
const seasonItem = (s) => base(s.id, 'season', `Season ${s.s}`, { libraryId: 2, parentId: 900010, showId: 900010, season: s.s, sortTitle: String(s.s).padStart(4, '0'), overview: s.overview, playCount: null, poster: art('poster', s.id) });
files[900010] = {
  item: full({ ...show, episodeCount: 9 }),
  seasons: seasons.map((s) => ({ ...seasonItem(s), unwatched: s.eps.filter((x) => !x.progress?.watched).length, childCount: s.eps.length })),
  nextEpisode: seasons[1].eps[5],
  collection: null, inWatchlist: false, inLists: [], similar: [film(900121, 'Tide Line')], extras: [], trailer: null,
};
for (const s of seasons) files[s.id] = { item: full(seasonItem(s)), show: base(900010, 'show', 'Coastal Watch'), episodes: s.eps.map((e) => ({ ...e, childCount: null })) };

// 900014: a show with no seasons. 900015: one season (900016) with no episodes.
files[900014] = { item: full({ ...base(900014, 'show', 'Pilot Only', { overview: 'Nothing here yet.' }), episodeCount: 0 }), seasons: [], collection: null, inWatchlist: false, inLists: [], similar: [], extras: [], trailer: null };
files[900015] = { item: full({ ...base(900015, 'show', 'Empty Season', { overview: 'One season, no episodes.' }), episodeCount: 0 }), seasons: [{ ...base(900016, 'season', 'Season 1', { parentId: 900015, showId: 900015, season: 1 }), unwatched: 0, childCount: 0 }], collection: null, inWatchlist: false, inLists: [], similar: [], extras: [], trailer: null };
files[900016] = { item: full(base(900016, 'season', 'Season 1', { parentId: 900015, showId: 900015, season: 1 })), show: base(900015, 'show', 'Empty Season'), episodes: [] };

// 900020: an episode with an intro found automatically, and a next episode.
files[900020] = {
  item: full(ep(900020, 900012, 2, 3, { title: 'The Long Night', media: MEDIA_HD, fileName: 'Coastal Watch S02E03.mkv', size: 1_200_000_000 })),
  show: base(900010, 'show', 'Coastal Watch', { poster: art('poster', 900010), backdrop: art('backdrop', 900010) }),
  subtitles: [{ id: 'e1', label: 'English', language: 'eng' }],
  markers: { intro: { start: 42, end: 92, source: 'audio' } },
  nextEpisode: seasons[2].eps[0],
  season: base(900012, 'season', 'Season 2', { parentId: 900010, showId: 900010, season: 2 }),
};

// 900030: an album with two discs; 900031: its artist.
const track = (id, disc, n, extra = {}) => base(id, 'track', `Song ${disc}-${n}`, { libraryId: 3, parentId: 900030, showId: 900031, season: disc, episode: n, duration: 180 + n * 7, artist: 'The Tidewaters', albumTitle: 'Low Water', ...extra });
// Two discs, long enough that a song near the end can be scrolled to the middle (?track=900340 is disc 2's 14th).
const tracks = [...Array.from({ length: 14 }, (_, i) => track(900301 + i, 1, i + 1)), ...Array.from({ length: 14 }, (_, i) => track(900327 + i, 2, i + 1))];
const artist = base(900031, 'artist', 'The Tidewaters', { libraryId: 3, poster: art('poster', 900031), backdrop: art('backdrop', 900031), overview: 'A folk band from the coast.', genres: ['Folk'] });
const album = (id, title, year) => base(id, 'album', title, { libraryId: 3, parentId: 900031, year, poster: art('poster', id) });
files[900030] = { item: full({ ...album(900030, 'Low Water', 2018), genres: ['Folk'], duration: tracks.reduce((a, t) => a + t.duration, 0), childCount: tracks.length }), tracks, artist };
files[900031] = { item: full({ ...artist, childCount: 2, duration: tracks.reduce((a, t) => a + t.duration, 0) }), albums: [album(900030, 'Low Water', 2018), album(900032, 'High Tide', 2021)], tracks };

// 900040–900042: pages that stay with their own older modules.
files[900040] = { item: full(base(900040, 'book', 'Charts and Currents', { libraryId: 4, author: 'M. Rowe', poster: art('poster', 900040), overview: 'A sailor’s notebook.' })), toc: [], spineCount: 0, spine: [], opfDir: '' };
files[900041] = { item: full(base(900041, 'podcast', 'Shipping Forecast Hour', { libraryId: 5, poster: art('poster', 900041), overview: 'Weekly.' })), episodes: [] };
files[900042] = { item: full(base(900042, 'audiobook', 'The Sea Road', { libraryId: 6, author: 'J. Keel', poster: art('poster', 900042), duration: 36000 })), parts: [], chapters: [] };

for (const [id, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(data, null, 1)}\n`);
console.log(`${Object.keys(files).length} fixtures written`);
