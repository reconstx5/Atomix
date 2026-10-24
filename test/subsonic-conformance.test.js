// Every Subsonic method Atomix answers, called the way Symfonium and Amperfy call them (u + t + s + v=1.16.1 + c,
// JSON then XML), checking the answer is "ok" and carries the fields those apps read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let auth;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const dir = path.join(media, 'Music', 'The Band', 'First Record');
  makeAudio(path.join(dir, '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/2', genre: 'Rock', date: '1985' } });
  makeAudio(path.join(dir, '02 Closer.mp3'), { tags: { title: 'Closer', artist: 'The Band', album: 'First Record', track: '2/2', genre: 'Rock', date: '1985' } });
  makeImage(path.join(dir, 'cover.jpg'));
  nf = await startAtomix();
  const admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.folder = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  const db = nf.app.core.db;
  ids.artist = db.get("SELECT id FROM items WHERE kind = 'artist'").id;
  ids.album = db.get("SELECT id FROM items WHERE kind = 'album'").id;
  ids.song = db.get("SELECT id FROM items WHERE kind = 'track' AND title = 'Opening'").id;
  ids.song2 = db.get("SELECT id FROM items WHERE kind = 'track' AND title = 'Closer'").id;
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Symfonium' })).data.secret;
  auth = () => ({ ...tokenAuth('dallas', secret), c: 'Symfonium' });
});

after(async () => {
  await nf?.app.stop();
});

/** [method, params, (body) => fields to check] — in the order an app's first sync calls them. */
const CALLS = () => [
  ['ping', {}, () => true],
  ['getLicense', {}, (b) => b.license.valid],
  ['getOpenSubsonicExtensions', {}, (b) => b.openSubsonicExtensions.length === 4],
  ['getUser', { username: 'dallas' }, (b) => b.user.username === 'dallas' && b.user.streamRole === true],
  ['getMusicFolders', {}, (b) => b.musicFolders.musicFolder[0].id === ids.folder],
  ['getScanStatus', {}, (b) => typeof b.scanStatus.scanning === 'boolean'],
  ['getIndexes', {}, (b) => b.indexes.index[0].artist[0].id === `ar-${ids.artist}`],
  ['getArtists', {}, (b) => b.artists.index[0].artist[0].albumCount === 1],
  ['getArtist', { id: `ar-${ids.artist}` }, (b) => b.artist.album[0].id === `al-${ids.album}`],
  ['getArtistInfo2', { id: `ar-${ids.artist}` }, (b) => Array.isArray(b.artistInfo2.similarArtist)],
  ['getAlbum', { id: `al-${ids.album}` }, (b) => b.album.song.length === 2 && b.album.song[0].albumId === `al-${ids.album}`],
  ['getAlbumInfo2', { id: `al-${ids.album}` }, (b) => 'albumInfo' in b],
  ['getSong', { id: `tr-${ids.song}` }, (b) => b.song.title === 'Opening' && b.song.duration > 0],
  ['getMusicDirectory', { id: `al-${ids.album}` }, (b) => b.directory.child.length === 2],
  ['getGenres', {}, (b) => b.genres.genre[0].value === 'Rock'],
  ['getSongsByGenre', { genre: 'Rock', count: 10 }, (b) => b.songsByGenre.song.length === 2],
  ['getAlbumList', { type: 'newest', size: 10 }, (b) => b.albumList.album[0].isDir === true],
  ['getAlbumList2', { type: 'alphabeticalByName', size: 500, offset: 0 }, (b) => b.albumList2.album[0].songCount === 2],
  ['getRandomSongs', { size: 5 }, (b) => b.randomSongs.song.length === 2],
  ['search2', { query: 'open' }, (b) => b.searchResult2.song[0].title === 'Opening'],
  ['search3', { query: '', artistCount: 500, albumCount: 500, songCount: 500 }, (b) => b.searchResult3.song.length === 2],
  ['star', { id: `tr-${ids.song}` }, () => true],
  ['getStarred', {}, (b) => b.starred.song[0].id === `tr-${ids.song}`],
  ['getStarred2', {}, (b) => b.starred2.song[0].starred],
  ['unstar', { id: `tr-${ids.song}` }, () => true],
  ['setRating', { id: `tr-${ids.song}`, rating: 4 }, () => true],
  ['scrobble', { id: `tr-${ids.song}`, submission: 'false' }, () => true],
  ['scrobble', { id: `tr-${ids.song}`, time: Date.now() }, () => true],
  ['getNowPlaying', {}, (b) => Array.isArray(b.nowPlaying.entry)],
  ['createPlaylist', { name: 'Sync test', songId: [`tr-${ids.song}`, `tr-${ids.song2}`] }, (b) => b.playlist.entry.length === 2],
  ['getPlaylists', {}, (b) => b.playlists.playlist.some((p) => p.name === 'Sync test')],
  ['getLyrics', { artist: 'The Band', title: 'Opening' }, (b) => 'lyrics' in b],
  ['getLyricsBySongId', { id: `tr-${ids.song}` }, (b) => Array.isArray(b.lyricsList.structuredLyrics)],
];

test('every method answers ok in JSON and XML', { skip }, async () => {
  let playlist = null;
  for (const [method, params, check] of CALLS()) {
    const j = await rest(nf.base, method, { ...auth(), ...params }, { f: 'json' });
    assert.equal(j.body?.status, 'ok', `${method} (json): ${JSON.stringify(j.body)}`);
    assert.ok(check(j.body), `${method}: ${JSON.stringify(j.body).slice(0, 400)}`);
    if (method === 'createPlaylist') playlist = j.body.playlist.id;
    if (['star', 'unstar', 'scrobble', 'createPlaylist', 'setRating'].includes(method)) continue; // changes: once is enough
    const x = await rest(nf.base, method, { ...auth(), ...params }, { f: 'xml' });
    assert.match(x.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<subsonic-response xmlns="http:\/\/subsonic\.org\/restapi" status="ok"/, `${method} (xml)`);
  }
  for (const [method, params] of [['getPlaylist', { id: playlist }], ['updatePlaylist', { playlistId: playlist, name: 'Renamed' }], ['deletePlaylist', { id: playlist }]]) {
    assert.equal((await rest(nf.base, method, { ...auth(), ...params })).body.status, 'ok', method);
  }
});

test('the streaming methods send bytes', { skip }, async () => {
  const q = (method, params) => `${nf.base}/rest/${method}?${new URLSearchParams({ ...auth(), ...params })}`;
  const s = await fetch(q('stream', { id: `tr-${ids.song}`, maxBitRate: 0, format: 'raw', estimateContentLength: 'true' }));
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await s.arrayBuffer()).byteLength > 1000);
  const d = await fetch(q('download', { id: `tr-${ids.song}` }));
  assert.ok((await d.arrayBuffer()).byteLength > 1000);
  const c = await fetch(q('getCoverArt', { id: `al-${ids.album}`, size: 512 }));
  assert.match(c.headers.get('content-type'), /^image\//);
  await c.arrayBuffer();
});
