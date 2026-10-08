// The Plex provider against a pretend Plex Media Server: sections, paging, the field mapping, ratings, music,
// details, image and stream URLs with the token in a header, timeline/scrobble, and ping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakePlex, plexMovie } from './helpers-plex.js';
import { PlexProvider } from '../src/remote/plex.js';

const settings = (() => { const s = { plexClientId: 'client-1' }; return { get: (k) => s[k], set: (o) => Object.assign(s, o) }; })();
let px, provider, server;
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

before(async () => {
  px = await fakePlex({
    pageSize: 1,
    totalSize: false,
    sections: [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV Shows', type: 'show' }, { key: '3', title: 'Music', type: 'artist' }, { key: '4', title: 'Photos', type: 'photo' }],
    items: {
      1: { 1: [
        plexMovie('11', 'Alien', { year: 1979, contentRating: 'gb/15', duration: 7020000, Guid: [{ id: 'tmdb://348' }, { id: 'imdb://tt0078748' }], Media: [{ container: 'mkv', bitrate: 9000, videoCodec: 'hevc', width: 1920, height: 1080, audioCodec: 'eac3', audioChannels: 6, Part: [{ id: 11, key: '/library/parts/11/1700000000/file.mkv' }] }], Role: Array.from({ length: 10 }, (_, i) => ({ tag: `Actor ${i}` })) }),
        plexMovie('12', 'Teen', { contentRating: 'PG-13', thumb: 'https://metadata-static.plex.tv/abc/poster.jpg' }),
        plexMovie('13', 'Bare', { contentRating: null, Media: undefined, thumb: undefined, art: undefined }),
      ] },
      2: { 2: [{ ratingKey: '20', type: 'show', title: 'Far Show', year: 2022, contentRating: 'TV-MA', summary: 'A show.', addedAt: 1700000000, updatedAt: 1700000000, thumb: '/library/metadata/20/thumb/1' }] },
      3: { 8: [{ ratingKey: '30', type: 'artist', title: 'Far Band', addedAt: 1700000000, updatedAt: 1700000000, thumb: '/library/metadata/30/thumb/1' }] },
    },
    children: {
      20: [{ ratingKey: '21', type: 'season', title: 'Season 1', index: 1, parentRatingKey: '20' }],
      21: [{ ratingKey: '22', type: 'episode', title: 'Pilot', index: 1, parentIndex: 1, duration: 1500000, addedAt: 1700000000, updatedAt: 1700000000, Media: [{ container: 'mp4', videoCodec: 'h264', width: 1280, height: 720, audioCodec: 'aac', audioChannels: 2, Part: [{ key: '/library/parts/22/1/file.mp4' }] }] }],
      30: [{ ratingKey: '31', type: 'album', title: 'Far Record', year: 2001, parentTitle: 'Far Band', thumb: '/library/metadata/31/thumb/1' }],
      31: [{ ratingKey: '32', type: 'track', title: 'Far Song', index: 3, parentIndex: 1, grandparentTitle: 'Far Band', parentTitle: 'Far Record', duration: 200000, Media: [{ container: 'mp3', audioCodec: 'mp3', audioChannels: 2, Part: [{ key: '/library/parts/32/1/file.mp3' }] }] }],
    },
    details: {
      11: plexMovie('11', 'Alien', { Media: [{ container: 'mkv', Part: [{ key: '/library/parts/11/1700000000/file.mkv', Stream: [
        { streamType: 1, codec: 'hevc', bitDepth: 10, width: 1920, height: 1080, colorTrc: 'smpte2084', displayTitle: '4K HDR10' },
        { streamType: 2, codec: 'eac3', channels: 6, languageCode: 'eng', displayTitle: 'English (EAC3 5.1)', default: true },
        { streamType: 2, codec: 'aac', channels: 2, languageCode: 'fra', displayTitle: 'Français' },
        { streamType: 3, codec: 'srt', languageCode: 'eng', displayTitle: 'English', forced: false },
        { streamType: 3, codec: 'srt', languageCode: 'spa', displayTitle: 'Español (external)', key: '/library/streams/99' },
      ] }] }] }),
    },
  });
  provider = new PlexProvider({ kind: 'plex', version: '0.12.0', settings });
  server = { id: 1, kind: 'plex', name: 'Dev Plex', url: px.url, secret: 'srv1', remote_user_id: 'mach1', extra: null };
});
after(() => px?.close());

test('libraries maps movie/show/artist and skips photo', async () => {
  assert.deepEqual(await provider.libraries(server), [{ remoteId: '1', name: 'Movies', type: 'movies' }, { remoteId: '2', name: 'TV Shows', type: 'tv' }, { remoteId: '3', name: 'Music', type: 'music' }]);
  const call = px.calls.find((c) => c.path === '/library/sections');
  assert.equal(call.headers['x-plex-token'], 'srv1');
  assert.equal(call.headers['x-plex-product'], 'Atomix');
  assert.equal(call.headers['x-plex-client-identifier'], 'client-1');
});

test('items page through a section (pages of one, no totalSize) and map fields', async () => {
  const movies = await collect(provider.items(server, { remote_id: '1' }, 'movie'));
  assert.deepEqual(movies.map((m) => m.title), ['Alien', 'Teen', 'Bare'], 'read to the first empty page');
  const a = movies[0];
  assert.equal(a.remoteId, '11');
  assert.equal(a.year, 1979);
  assert.equal(a.runtime, 117);
  assert.equal(a.duration, 7020);
  assert.equal(a.certification, 'GB:15');
  assert.equal(a.tmdbId, 348);
  assert.equal(a.imdbId, 'tt0078748');
  assert.deepEqual(a.people.slice(0, 2), [{ name: 'Mara Quill', role: 'director' }, { name: 'Actor 0', role: 'cast' }]);
  assert.equal(a.people.filter((p) => p.role === 'cast').length, 8);
  assert.equal(a.addedAt, 1700000000000);
  assert.equal(a.updated, 1710000000000);
  assert.equal(a.media.plexPart, '/library/parts/11/1700000000/file.mkv');
  assert.equal(a.media.video.codec, 'hevc');
  assert.equal(a.media.audio[0].channels, 6);
  assert.equal(a.images.poster, true);
  assert.equal(a.genres[0], 'Drama');
  assert.equal(movies[2].media, null, 'no Media, no file');
  assert.equal(movies[2].images.poster, false);
});

test('ratings: gb/15 → GB:15, uk/12A → GB:12A, PG-13, TV-MA and NR stay', () => {
  const r = PlexProvider.rating;
  assert.deepEqual([r('gb/15'), r('uk/12A'), r('nz/R16'), r('PG-13'), r('TV-MA'), r('NR'), r(null)], ['GB:15', 'GB:12A', 'NZ:R16', 'PG-13', 'TV-MA', 'NR', null]);
});

test('shows → seasons → episodes and artists → albums → tracks through /children', async () => {
  const shows = await collect(provider.items(server, { remote_id: '2' }, 'show'));
  assert.equal(shows[0].certification, 'TV-MA');
  const seasons = await collect(provider.items(server, { remote_id: '2' }, 'season', shows[0].remoteId));
  assert.equal(seasons[0].season, 1);
  const eps = await collect(provider.items(server, { remote_id: '2' }, 'episode', seasons[0].remoteId));
  assert.deepEqual([eps[0].season, eps[0].episode, eps[0].duration], [1, 1, 1500]);
  const artists = await collect(provider.items(server, { remote_id: '3' }, 'artist'));
  assert.equal(artists[0].title, 'Far Band');
  const albums = await collect(provider.items(server, { remote_id: '3' }, 'album', artists[0].remoteId));
  assert.deepEqual([albums[0].title, albums[0].year, albums[0].artist], ['Far Record', 2001, 'Far Band']);
  const tracks = await collect(provider.items(server, { remote_id: '3' }, 'track', albums[0].remoteId));
  assert.deepEqual([tracks[0].title, tracks[0].track, tracks[0].disc, tracks[0].artist, tracks[0].album, tracks[0].duration], ['Far Song', 3, 1, 'Far Band', 'Far Record', 200]);
  assert.equal(tracks[0].media.container, 'mp3');
});

test('details fills video bit depth and HDR, audio and embedded subtitles; external subtitle streams are left out', async () => {
  const [a] = await collect(provider.items(server, { remote_id: '1' }, 'movie'));
  const media = await provider.details(server, a);
  assert.deepEqual([media.video.bitDepth, media.video.hdr, media.video.width], [10, true, 1920]);
  assert.deepEqual(media.audio.map((x) => [x.index, x.codec, x.channels, x.language, x.default]), [[0, 'eac3', 6, 'eng', true], [1, 'aac', 2, 'fra', false]]);
  assert.deepEqual(media.subtitles.map((x) => [x.index, x.codec, x.language]), [[0, 'srt', 'eng']]);
  assert.equal(media.plexPart, '/library/parts/11/1700000000/file.mkv');
  assert.equal(media.container, 'mkv');
});

test('image URLs carry Plex\'s timestamp and the token in a header; an absolute thumb on another host is used as-is with no token', async () => {
  const movies = await collect(provider.items(server, { remote_id: '1' }, 'movie'));
  const img = provider.imageUrl(server, movies[0], 'poster');
  assert.equal(img.url, `${px.url}/library/metadata/11/thumb/1700000000`);
  assert.equal(img.headers['X-Plex-Token'], 'srv1');
  assert.ok(!img.url.includes('srv1'));
  const ext = provider.imageUrl(server, movies[1], 'poster');
  assert.equal(ext.url, 'https://metadata-static.plex.tv/abc/poster.jpg');
  assert.deepEqual(provider.imageHeaders(server, ext.url), {}, 'never the token to another host');
  assert.equal(provider.imageHeaders(server, img.url)['X-Plex-Token'], 'srv1');
  assert.equal(provider.imageUrl(server, movies[2], 'poster'), null);
});

test('streamUrl is the server address plus the part key; the token in a header, never in the URL', () => {
  const s = provider.streamUrl(server, { remoteId: '11', kind: 'movie', media: { plexPart: '/library/parts/11/1700000000/file.mkv' } });
  assert.equal(s.url, `${px.url}/library/parts/11/1700000000/file.mkv`);
  assert.equal(s.headers['X-Plex-Token'], 'srv1');
  assert.ok(!s.url.includes('srv1'));
});

test('two sessions on the same Plex title use two client identifiers and session identifiers', async () => {
  px.calls.length = 0;
  const base = provider.headers(server)['X-Plex-Client-Identifier'];
  await provider.reportStart(server, { remoteId: '11' }, { position: 1, duration: 7020, sessionId: 'aaa111' });
  await provider.reportStart(server, { remoteId: '11' }, { position: 2, duration: 7020, sessionId: 'bbb222' });
  await provider.reportStop(server, { remoteId: '11' }, { position: 3, duration: 7020, sessionId: 'aaa111' });
  const h = px.calls.map((c) => [c.query.state, c.headers['x-plex-client-identifier'], c.headers['x-plex-session-identifier']]);
  assert.deepEqual(h, [
    ['playing', `${base}-aaa111`, 'aaa111'],
    ['playing', `${base}-bbb222`, 'bbb222'],
    ['stopped', `${base}-aaa111`, 'aaa111'],
  ]);
  // Without a session (older callers), the plain identifier as before.
  px.calls.length = 0;
  await provider.reportStart(server, { remoteId: '11' }, { position: 1, duration: 7020 });
  assert.equal(px.calls[0].headers['x-plex-client-identifier'], base);
  assert.equal(px.calls[0].headers['x-plex-session-identifier'], undefined);
});

test('timeline playing/paused/stopped and scrobble are sent with ms times and the ratingKey', async () => {
  px.calls.length = 0;
  await provider.reportStart(server, { remoteId: '11' }, { position: 30, duration: 7020 });
  await provider.reportProgress(server, { remoteId: '11' }, { position: 40, duration: 7020, paused: true });
  await provider.reportStop(server, { remoteId: '11' }, { position: 50, duration: 7020 });
  await provider.reportProgress(server, { remoteId: '11' }, { position: 7000, duration: 7020, watched: true });
  const calls = px.calls.map((c) => [c.path, c.query.state || null, c.query.time || null]);
  assert.deepEqual(calls, [
    ['/:/timeline', 'playing', '30000'],
    ['/:/timeline', 'paused', '40000'],
    ['/:/timeline', 'stopped', '50000'],
    ['/:/scrobble', null, null],
  ]);
  assert.equal(px.calls[0].query.ratingKey, '11');
  assert.equal(px.calls[0].query.key, '/library/metadata/11');
  assert.equal(px.calls[0].query.duration, '7020000');
  assert.equal(px.calls[3].query.key, '11');
  assert.equal(px.calls[3].query.identifier, 'com.plexapp.plugins.library');
  assert.equal(px.calls[0].headers['x-plex-token'], 'srv1');
});

test('ping: ok; a dead address; a 401 is unauthorized; a different machine id is not ok', async () => {
  assert.deepEqual(await provider.ping(server), { ok: true, detail: 'Dev Plex' });
  const dead = await provider.ping({ ...server, url: 'http://127.0.0.1:65003' });
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /ECONNREFUSED/);
  assert.deepEqual(await provider.ping({ ...server, secret: 'wrong' }), { ok: false, detail: 'unauthorized' });
  const other = await provider.ping({ ...server, remote_user_id: 'not-this-one' });
  assert.equal(other.ok, false);
  assert.match(other.detail, /different Plex server/);
});
