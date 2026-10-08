// A pretend Jellyfin (or Emby) server for the remote tests: sign-in, views, paged items, images, streams, progress.
import fs from 'node:fs';
import { fakeServer } from './helpers.js';

const TICK = 10000000;

/** @param {{ movies?: object[], shows?: object[], streamFile?: string }} data — items use Jellyfin's own field names */
export async function fakeJellyfin(data = {}) {
  const state = {
    movies: data.movies || [],
    shows: data.shows || [],
    artists: data.artists || [], // [{ Id, Name, Albums: [{ Id, Name, Tracks: [...] }] }] — Jellyfin's album artists
    calls: [],
    token: 'tok1',
    hung: [],
    views: [{ Id: 'lib-m', Name: 'Movies', CollectionType: 'movies' }, { Id: 'lib-t', Name: 'TV Shows', CollectionType: 'tvshows' }, { Id: 'lib-x', Name: 'Photos', CollectionType: 'homevideos' }],
    streamFile: data.streamFile || null,
    png: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'),
  };
  const authed = (req) => (req.headers.authorization || req.headers['x-emby-authorization'] || '').includes(`Token="${state.token}"`);
  const server = await fakeServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    let body = '';
    for await (const c of req) body += c;
    state.calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: body ? JSON.parse(body) : null });
    if (u.pathname === '/System/Info/Public') return send({ ServerName: 'Fake Jellyfin', Version: '10.9' });
    if (u.pathname === '/Users/AuthenticateByName') {
      const b = JSON.parse(body || '{}');
      if (b.Username === 'dallas' && b.Pw === '4321') return send({ AccessToken: state.token, User: { Id: 'u1', Name: 'dallas' }, ServerName: 'Fake Jellyfin' });
      return send({}, 401);
    }
    if (!authed(req)) return send({}, 401);
    if (u.pathname === '/Users/Me') return send({ Id: 'u1' });
    if (u.pathname === '/Users/u1/Views') return send({ Items: state.views });
    if (u.pathname === '/Artists/AlbumArtists') return send({ Items: state.artists.map(({ Albums, ...a }) => a), TotalRecordCount: state.artists.length, StartIndex: 0 });
    if (u.pathname === '/Users/u1/Items') {
      const type = u.searchParams.get('IncludeItemTypes');
      const parent = u.searchParams.get('ParentId');
      let all = [];
      if (type === 'Movie') all = state.movies;
      else if (type === 'Series') all = state.shows;
      else if (type === 'Season') all = (state.shows.find((s) => s.Id === parent)?.Seasons || []);
      else if (type === 'Episode') all = state.shows.flatMap((s) => s.Seasons || []).find((se) => se.Id === parent)?.Episodes || [];
      else if (type === 'MusicAlbum') all = (state.artists.find((a) => a.Id === u.searchParams.get('AlbumArtistIds'))?.Albums || []).map(({ Tracks, ...al }) => al); // albums hang off the artist by AlbumArtistIds, never ParentId
      else if (type === 'Audio') all = state.artists.flatMap((a) => a.Albums || []).find((al) => al.Id === parent)?.Tracks || [];
      else if (type === 'MusicArtist') all = []; // a real Jellyfin answers nothing useful here: artists come from /Artists/AlbumArtists
      const start = Number(u.searchParams.get('StartIndex') || 0);
      const limit = Number(u.searchParams.get('Limit') || 200);
      const page = data.pageSize ? Math.min(limit, data.pageSize) : limit;
      if (state.emptyItems) return send({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
      return send({ Items: all.slice(start, start + page), ...(state.noTotal ? {} : { TotalRecordCount: all.length }), StartIndex: start });
    }
    let m;
    if ((m = /^\/Items\/([^/]+)\/Images\/(Primary|Backdrop|Logo)/.exec(u.pathname))) {
      // An image on a CDN: the server sends the client elsewhere (the tests check the sign-in stays behind).
      if (state.imageRedirect) {
        res.writeHead(302, { location: state.imageRedirect });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(state.png);
    }
    if ((m = /^\/(Videos|Audio)\/([^/]+)\/stream$/.exec(u.pathname))) {
      if (state.forbidStream) return send({}, 403);
      if (!state.streamFile) return send({}, 404);
      // /slow: the server takes the request and never answers (the tests check Atomix gives up and lets go).
      if (state.streamSlow) {
        state.slow = (state.slow || 0) + 1;
        res.on('close', () => (state.slowClosed = (state.slowClosed || 0) + 1));
        return;
      }
      // /redir-same and /redir-other: the stream is somewhere else.
      if (state.streamRedirect && !u.searchParams.has('real')) {
        res.writeHead(302, { location: state.streamRedirect });
        return res.end();
      }
      const st = fs.statSync(state.streamFile);
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range && Number(range[1]) >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': st.size, 'accept-ranges': 'bytes' });
        return res.end();
      }
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Number(range[2]) : st.size - 1;
        res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': to - from + 1, 'content-range': `bytes ${from}-${to}/${st.size}`, 'accept-ranges': 'bytes' });
        return fs.createReadStream(state.streamFile, { start: from, end: to }).pipe(res);
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': st.size, 'accept-ranges': 'bytes' });
      return fs.createReadStream(state.streamFile).pipe(res);
    }
    if (u.pathname === '/Sessions/Playing' || u.pathname === '/Sessions/Playing/Progress' || u.pathname === '/Sessions/Playing/Stopped' || /^\/Users\/u1\/PlayedItems\//.test(u.pathname)) {
      if (state.hang) return void state.hung.push(() => send({}, 204)); // answers only when released
      return send({}, 204);
    }
    send({ error: 'not found ' + u.pathname }, 404);
  });
  return { ...server, state, calls: state.calls, ticks: (s) => s * TICK };
}

/** A Jellyfin-shaped movie. */
export function jfMovie(id, name, extra = {}) {
  return {
    Id: id, Name: name, SortName: name.toLowerCase(), ProductionYear: 2020, Overview: `${name} overview`, Genres: ['Drama'], Taglines: [],
    RunTimeTicks: 7200 * TICK, OfficialRating: 'NZ-G', CommunityRating: 7.5, PremiereDate: '2020-05-01T00:00:00Z',
    ProviderIds: {}, People: [], Tags: [], ImageTags: { Primary: 'x' }, BackdropImageTags: ['y'],
    MediaSources: [{ Container: 'mp4', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1280, Height: 720, VideoRange: 'SDR', Index: 0 }, { Type: 'Audio', Codec: 'aac', Channels: 2, Language: 'eng', Index: 1 }] }],
    ...extra,
  };
}
