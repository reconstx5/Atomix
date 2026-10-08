// The Jellyfin/Emby provider against a pretend server: sign-in, library mapping, item shape, URLs with the token in a
// header only, progress calls, ping, and URL normalising.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeJellyfin, jfMovie } from './helpers-jellyfin.js';
import { JellyfinProvider } from '../src/remote/jellyfin.js';
import { normaliseUrl } from '../src/remote/urls.js';

let jf, provider, server;
before(async () => {
  jf = await fakeJellyfin({
    pageSize: 1,
    movies: [
      jfMovie('m1', 'Alien', {
        ProductionYear: 1979, OfficialRating: 'NZ-R16', Tags: ['space'], ProviderIds: { Tmdb: '348', Imdb: 'tt0078748' },
        People: [{ Name: 'Ridley Scott', Type: 'Director' }, { Name: 'Sigourney Weaver', Type: 'Actor' }, { Name: 'Someone', Type: 'Writer' }],
        MediaSources: [{ Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080, VideoRange: 'HDR', BitDepth: 10, Index: 0 }, { Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', Index: 1 }, { Type: 'Subtitle', Codec: 'subrip', Language: 'eng', Index: 2 }] }],
      }),
      jfMovie('m2', 'Stub', { OfficialRating: 'Not Rated', MediaSources: [], ImageTags: {}, BackdropImageTags: [] }),
    ],
  });
  provider = new JellyfinProvider({ kind: 'jellyfin', version: '0.11.0' });
  server = { id: 1, kind: 'jellyfin', name: 'Fake Jellyfin', url: jf.url, username: 'dallas', secret: 'tok1', remote_user_id: 'u1' };
});
after(() => jf?.close());

test('connect: a good sign-in gives the token, user id and server name; a bad one is a 401 HttpError', async () => {
  const r = await provider.connect({ url: jf.url, username: 'dallas', password: '4321' });
  assert.deepEqual(r, { secret: 'tok1', remoteUserId: 'u1', serverName: 'Fake Jellyfin' });
  const auth = jf.calls.find((c) => c.path === '/Users/AuthenticateByName');
  assert.match(auth.headers.authorization, /^MediaBrowser Client="Atomix", Device="Atomix", DeviceId="[^"]+", Version="0\.11\.0"$/);
  await assert.rejects(provider.connect({ url: jf.url, username: 'dallas', password: 'nope' }), (e) => e.status === 401);
  const emby = new JellyfinProvider({ kind: 'emby', version: '0.11.0' });
  await emby.connect({ url: jf.url, username: 'dallas', password: '4321' });
  assert.ok(jf.calls.at(-1).headers['x-emby-authorization']);
});

test('libraries: only movies, tvshows and music views, mapped to Atomix types', async () => {
  assert.deepEqual(await provider.libraries(server), [{ remoteId: 'lib-m', name: 'Movies', type: 'movies' }, { remoteId: 'lib-t', name: 'TV Shows', type: 'tv' }]);
});

test('items: pages through movies and shapes them', async () => {
  const items = [];
  for await (const it of provider.items(server, { remote_id: 'lib-m' }, 'movie')) items.push(it);
  assert.equal(items.length, 2, 'two pages of one');
  const a = items[0];
  assert.equal(a.remoteId, 'm1');
  assert.equal(a.kind, 'movie');
  assert.equal(a.runtime, 120);
  assert.equal(a.year, 1979);
  assert.equal(a.certification, 'NZ:R16');
  assert.deepEqual(a.people, [{ name: 'Ridley Scott', role: 'director' }, { name: 'Sigourney Weaver', role: 'cast' }]);
  assert.deepEqual(a.keywords, ['space']);
  assert.equal(a.tmdbId, 348);
  assert.equal(a.imdbId, 'tt0078748');
  assert.equal(a.media.container, 'mkv');
  assert.equal(a.media.video.codec, 'hevc');
  assert.equal(a.media.video.hdr, true);
  assert.equal(a.media.video.bitDepth, 10, 'decide() needs it for 10-bit H.264');
  assert.equal(a.media.audio[0].channels, 2);
  assert.equal(a.media.subtitles.length, 1);
  assert.deepEqual([a.images.poster, a.images.backdrop, a.images.logo], [true, true, false]);
  const b = items[1];
  assert.equal(b.media, null);
  assert.equal(b.certification, 'Not Rated');
  assert.deepEqual([b.images.poster, b.images.backdrop, b.images.logo], [false, false, false]);
});

test('items: music comes from /Artists/AlbumArtists, albums by AlbumArtistIds, tracks under the album', async () => {
  jf.state.views.push({ Id: 'lib-mu', Name: 'Music', CollectionType: 'music' });
  jf.state.artists.push({ Id: 'ar1', Name: 'Far Band', Type: 'MusicArtist', ImageTags: { Primary: 'p' }, Albums: [{ Id: 'al1', Name: 'Far Record', Type: 'MusicAlbum', ProductionYear: 2001, ImageTags: { Primary: 'p' }, Tracks: [{ Id: 't1', Name: 'Far Song', Type: 'Audio', IndexNumber: 1, ParentIndexNumber: 1, RunTimeTicks: 200 * 10000000, Artists: ['Far Band'], Album: 'Far Record', MediaSources: [{ Container: 'mp3', MediaStreams: [{ Type: 'Audio', Codec: 'mp3', Channels: 2, Index: 0 }] }] }] }] });
  const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };
  assert.ok((await provider.libraries(server)).some((l) => l.type === 'music'));
  const artists = await collect(provider.items(server, { remote_id: 'lib-mu' }, 'artist'));
  assert.deepEqual(artists.map((a) => [a.remoteId, a.title]), [['ar1', 'Far Band']]);
  const albums = await collect(provider.items(server, { remote_id: 'lib-mu' }, 'album', 'ar1'));
  assert.deepEqual(albums.map((a) => [a.remoteId, a.title, a.year]), [['al1', 'Far Record', 2001]]);
  const tracks = await collect(provider.items(server, { remote_id: 'lib-mu' }, 'track', 'al1'));
  assert.deepEqual(tracks.map((t) => [t.remoteId, t.title, t.track, t.artist, t.album, t.duration]), [['t1', 'Far Song', 1, 'Far Band', 'Far Record', 200]]);
  assert.equal(tracks[0].media.container, 'mp3');
});

test('items: pages to the end even when the server leaves out TotalRecordCount', async () => {
  jf.state.noTotal = true;
  const items = [];
  for await (const it of provider.items(server, { remote_id: 'lib-m' }, 'movie')) items.push(it);
  jf.state.noTotal = false;
  assert.equal(items.length, 2);
});

test('imageUrl/streamUrl carry the token in a header, never in the URL', () => {
  const img = provider.imageUrl(server, { remoteId: 'm1', kind: 'movie', images: { poster: true, tags: { poster: 'x' } } }, 'poster');
  assert.match(img.url, /\/Items\/m1\/Images\/Primary\?tag=x$/, 'the server\'s image tag: a changed picture is a new URL');
  assert.match(img.headers.Authorization, /Token="tok1"/);
  assert.ok(!img.url.includes('tok1'));
  assert.equal(provider.imageUrl(server, { remoteId: 'm2', kind: 'movie', images: { poster: false } }, 'poster'), null);
  const s = provider.streamUrl(server, { remoteId: 'm1', kind: 'movie' });
  assert.match(s.url, /\/Videos\/m1\/stream\?static=true$/);
  assert.match(provider.streamUrl(server, { remoteId: 't1', kind: 'track' }).url, /\/Audio\/t1\/stream\?static=true$/);
  assert.ok(!s.url.includes('tok1') && /Token="tok1"/.test(s.headers.Authorization));
});

test('reportStart, reportProgress (paused too), watched, and reportStop', async () => {
  jf.calls.length = 0;
  await provider.reportStart(server, { remoteId: 'm1' }, { position: 0, duration: 100 });
  await provider.reportProgress(server, { remoteId: 'm1' }, { position: 30, duration: 100, watched: false });
  await provider.reportProgress(server, { remoteId: 'm1' }, { position: 5, duration: 100, watched: false, paused: true });
  await provider.reportProgress(server, { remoteId: 'm1' }, { position: 95, duration: 100, watched: true });
  await provider.reportStop(server, { remoteId: 'm1' }, { position: 96, duration: 100 });
  const paths = jf.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['POST /Sessions/Playing', 'POST /Sessions/Playing/Progress', 'POST /Sessions/Playing/Progress', 'POST /Users/u1/PlayedItems/m1', 'POST /Sessions/Playing/Stopped'], 'an early position is a progress, never a stop');
  assert.equal(jf.calls[0].body.PlayMethod, 'DirectStream');
  assert.equal(jf.calls[2].body.IsPaused, true);
  assert.equal(jf.calls[4].body.PositionTicks, 960000000);
  jf.calls.splice(0, 1);
  assert.equal(jf.calls[0].body.PositionTicks, 300000000);
  assert.equal(jf.calls[0].body.ItemId, 'm1');
});

test('ping: ok, unreachable, unauthorized', async () => {
  assert.deepEqual(await provider.ping(server), { ok: true, detail: 'Fake Jellyfin' });
  const dead = await provider.ping({ ...server, url: 'http://127.0.0.1:65001' });
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /ECONNREFUSED/, 'the real cause, not "no answer"');
  assert.deepEqual(await provider.ping({ ...server, secret: 'wrong' }), { ok: false, detail: 'unauthorized' });
});

test('ratings: a country prefix becomes CC:label, but US TV-/PG-/NC- ratings stay as they are', async () => {
  const seen = {};
  jf.state.movies.push(jfMovie('r1', 'Cable', { OfficialRating: 'TV-MA' }), jfMovie('r2', 'Teen', { OfficialRating: 'PG-13' }), jfMovie('r3', 'Adult', { OfficialRating: 'NC-17' }), jfMovie('r4', 'Kids TV', { OfficialRating: 'TV-Y7' }), jfMovie('r5', 'Aussie', { OfficialRating: 'AU-MA15+' }));
  for await (const it of provider.items(server, { remote_id: 'lib-m' }, 'movie')) seen[it.remoteId] = it.certification;
  assert.deepEqual([seen.r1, seen.r2, seen.r3, seen.r4, seen.r5], ['TV-MA', 'PG-13', 'NC-17', 'TV-Y7', 'AU:MA15+']);
  jf.state.movies = jf.state.movies.filter((m) => !/^r\d$/.test(m.Id));
});

test('normaliseUrl', () => {
  assert.equal(normaliseUrl('jelly.local:8096'), 'https://jelly.local:8096');
  assert.equal(normaliseUrl('http://10.0.0.5:8096/'), 'http://10.0.0.5:8096');
  assert.equal(normaliseUrl('https://x/jellyfin/'), 'https://x/jellyfin');
  assert.equal(normaliseUrl('  HTTPS://Example.com  '), 'https://example.com');
  assert.throws(() => normaliseUrl('not a url'), (e) => e.status === 400);
  assert.throws(() => normaliseUrl(''), (e) => e.status === 400);
});
