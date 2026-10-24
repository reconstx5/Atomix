// Music apps browsing: artists, albums, songs, folders, genres, album lists, random songs, starred, search and
// now playing — in JSON and XML, with the viewer's own numbers, and only what the profile may see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let auth; // dallas's app password params
let kidAuth;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const song = (artist, album, n, title, extra = {}, root = 'Music') =>
    makeAudio(path.join(media, root, artist, album, `0${n} ${title}.mp3`), { tags: { title, artist, album, track: `${n}/2`, ...extra } });
  song('The Band', 'First Record', 1, 'Opening', { genre: 'Rock', date: '1985' });
  song('The Band', 'First Record', 2, 'Closer', { genre: 'Rock', date: '1985' });
  song('The Band', 'Second Record', 1, 'Return', { genre: 'Pop', date: '1992' });
  song('Other Folk', 'Quiet Songs', 1, 'Hush', { genre: 'Folk', date: '2001' }, 'Grown');
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  ids.grown = (await admin.post('/api/libraries', { name: 'Grown-up music', type: 'music', paths: [path.join(media, 'Grown')] })).data.id;
  await waitForScan(admin);
  const db = nf.app.core.db;
  const one = (sql, ...p) => db.get(sql, ...p)?.id;
  ids.band = one("SELECT id FROM items WHERE kind = 'artist' AND title = 'The Band'");
  ids.folk = one("SELECT id FROM items WHERE kind = 'artist' AND title = 'Other Folk'");
  ids.first = one("SELECT id FROM items WHERE kind = 'album' AND title = 'First Record'");
  ids.second = one("SELECT id FROM items WHERE kind = 'album' AND title = 'Second Record'");
  ids.quiet = one("SELECT id FROM items WHERE kind = 'album' AND title = 'Quiet Songs'");
  for (const t of ['Opening', 'Closer', 'Return', 'Hush']) ids[t] = one("SELECT id FROM items WHERE kind = 'track' AND title = ?", t);
  db.run('UPDATE items SET added_at = ? WHERE id = ?', Date.now() + 1000, ids.second); // the newest album
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data.secret;
  auth = () => tokenAuth('dallas', secret);
  // Mia (Kids) may use the Music library only: Quiet Songs, in Grown-up music, is out of her reach.
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', libraries: [ids.music] })).data;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  const kidSecret = (await kid.post('/api/me/app-passwords', { name: 'Tablet' })).data.secret;
  kidAuth = () => tokenAuth('dallas', kidSecret);
});

after(async () => {
  await nf?.app.stop();
});

const call = async (method, params = {}, who = auth, opts) => {
  const r = await rest(nf.base, method, { ...who(), ...params }, opts);
  if (opts?.f !== null && opts?.f !== 'xml') assert.equal(r.body?.status, 'ok', `${method}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const code = async (method, params, who = auth) => (await rest(nf.base, method, { ...who(), ...params })).body.error?.code;

test('artists, albums and songs in JSON and XML', { skip }, async () => {
  const a = await call('getArtists');
  assert.equal(a.artists.ignoredArticles, 'The A');
  const letters = a.artists.index.map((i) => i.name);
  assert.deepEqual(letters, ['B', 'O']);
  const band = a.artists.index[0].artist[0];
  assert.deepEqual(band, { ...band, id: `ar-${ids.band}`, name: 'The Band', albumCount: 2, coverArt: `ar-${ids.band}` });
  const ar = await call('getArtist', { id: `ar-${ids.band}` });
  assert.deepEqual(ar.artist.album.map((x) => x.name).sort(), ['First Record', 'Second Record']);
  const al = await call('getAlbum', { id: `al-${ids.first}` });
  assert.equal(al.album.name, 'First Record');
  assert.equal(al.album.songCount, 2);
  assert.equal(al.album.year, 1985);
  assert.equal(al.album.genre, 'Rock');
  assert.equal(al.album.artistId, `ar-${ids.band}`);
  const s = al.album.song;
  assert.deepEqual(s.map((x) => x.title), ['Opening', 'Closer']);
  assert.equal(s[0].id, `tr-${ids.Opening}`);
  assert.equal(s[0].parent, `al-${ids.first}`);
  assert.equal(s[0].track, 1);
  assert.equal(s[0].discNumber, 1);
  assert.equal(s[0].isDir, false);
  assert.equal(s[0].type, 'music');
  assert.equal(s[0].coverArt, `al-${ids.first}`);
  assert.equal(s[0].suffix, 'mp3');
  assert.equal(s[0].contentType, 'audio/mpeg');
  assert.ok(s[0].duration >= 1 && Number.isInteger(s[0].duration));
  assert.ok(s[0].bitRate > 0 && Number.isInteger(s[0].bitRate));
  assert.equal(s[0].path, 'The Band/First Record/01 Opening.mp3');
  assert.ok(!JSON.stringify(al).includes(media), 'no server paths');
  const x = await rest(nf.base, 'getAlbum', { ...auth(), id: `al-${ids.first}` }, { f: 'xml' });
  assert.match(x.text, /<album [^>]*name="First Record"[^>]*><song [^>]*title="Opening"[^>]*\/><song [^>]*title="Closer"[^>]*\/><\/album>/);
  const one = await call('getSong', { id: `tr-${ids.Return}` });
  assert.equal(one.song.album, 'Second Record');
  assert.equal(await code('getSong', { id: 'tr-999999' }), 70);
  assert.equal(await code('getSong', { id: `al-${ids.first}` }), 70, 'a song id is a song id');
  assert.equal(await code('getAlbum', {}), 10);
  const idx = await call('getIndexes');
  assert.deepEqual(idx.indexes.index.map((i) => i.name), ['B', 'O']);
  const info = await call('getArtistInfo2', { id: `ar-${ids.band}` });
  assert.ok('artistInfo2' in info);
  assert.ok('albumInfo' in (await call('getAlbumInfo2', { id: `al-${ids.first}` })));
});

test('a Kids app password sees only what the kid may', { skip }, async () => {
  for (const id of [ids.Hush, ids.Opening, ids.quiet, ids.folk]) await admin.put(`/api/items/${id}/rating`, { favourite: true });
  const hidden = [`al-${ids.quiet}`, `tr-${ids.Hush}`];
  const seen = JSON.stringify([
    await call('getArtists', {}, kidAuth),
    await call('getIndexes', {}, kidAuth),
    await call('getArtist', { id: `ar-${ids.band}` }, kidAuth),
    await call('getAlbumList2', { type: 'alphabeticalByName', size: 50 }, kidAuth),
    await call('getRandomSongs', { size: 50 }, kidAuth),
    await call('search3', { query: '' }, kidAuth),
    await call('getStarred2', {}, kidAuth),
    await call('getGenres', {}, kidAuth),
    await call('getSongsByGenre', { genre: 'Folk' }, kidAuth),
  ]);
  for (const h of hidden) assert.ok(!seen.includes(`"${h}"`), h);
  assert.ok(!seen.includes('"Folk"'), "the kid's genres don't list Folk");
  assert.equal(await code('getAlbum', { id: `al-${ids.quiet}` }, kidAuth), 70);
  assert.equal(await code('getSong', { id: `tr-${ids.Hush}` }, kidAuth), 70);
  // Other Folk has only grown-up albums: hidden from the kid's artist list.
  assert.ok(!seen.includes(`"ar-${ids.folk}"`));
});

test('album lists by type', { skip }, async () => {
  const names = async (params) => (await call('getAlbumList2', params)).albumList2.album.map((a) => a.name);
  assert.equal((await names({ type: 'newest' }))[0], 'Second Record');
  const core = nf.app.core;
  const profileId = core.db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  for (const t of ['Hush', 'Hush', 'Closer']) {
    const r = core.plays.report({ profileId, item: core.library.get(ids[t]), position: 0, watched: false, client: 'x' });
    core.db.run('UPDATE plays SET counted = 1, updated_at = updated_at - 7 * 3600000 WHERE id = ?', r.playId); // separate, counted plays
  }
  core.db.run('UPDATE plays SET updated_at = ? WHERE item_id = ?', Date.now(), ids.Closer);
  assert.equal((await names({ type: 'frequent' }))[0], 'Quiet Songs');
  assert.equal((await names({ type: 'recent' }))[0], 'First Record');
  await admin.put(`/api/items/${ids.quiet}/rating`, { favourite: false });
  await admin.put(`/api/items/${ids.second}/rating`, { favourite: true });
  assert.deepEqual(await names({ type: 'starred' }), ['Second Record']);
  assert.deepEqual(await names({ type: 'byYear', fromYear: 1980, toYear: 1995 }), ['First Record', 'Second Record']);
  assert.deepEqual(await names({ type: 'byYear', fromYear: 1995, toYear: 1980 }), ['Second Record', 'First Record'], 'from > to: newest first');
  assert.deepEqual(await names({ type: 'byGenre', genre: 'Rock' }), ['First Record']);
  await admin.put(`/api/items/${ids.quiet}/rating`, { stars: 5 });
  assert.equal((await names({ type: 'highest' }))[0], 'Quiet Songs');
  assert.deepEqual(await names({ type: 'alphabeticalByName', size: 1, offset: 1 }), ['Quiet Songs']);
  assert.deepEqual(await names({ type: 'alphabeticalByArtist' }), ['First Record', 'Second Record', 'Quiet Songs'], 'The Band (as Band) before Other Folk');
  assert.equal(await code('getAlbumList2', {}), 10);
  const old = await call('getAlbumList', { type: 'newest' });
  assert.equal(old.albumList.album[0].title, 'Second Record', 'the old list uses directory entries');
  assert.equal(old.albumList.album[0].isDir, true);
});

test("the viewer's own numbers", { skip }, async () => {
  await admin.put(`/api/items/${ids.Closer}/rating`, { stars: 3, favourite: true });
  const s = (await call('getSong', { id: `tr-${ids.Closer}` })).song;
  assert.equal(s.playCount, 1);
  assert.match(s.played, /^\d{4}-\d\d-\d\dT/);
  assert.equal(s.userRating, 3);
  assert.match(s.starred, /^\d{4}-\d\d-\d\dT/);
  const k = (await call('getSong', { id: `tr-${ids.Closer}` }, kidAuth)).song;
  assert.equal(k.playCount, 0);
  assert.equal(k.userRating, undefined);
  assert.equal(k.starred, undefined);
  assert.equal(k.played, undefined);
});

test('folders and directories', { skip }, async () => {
  const f = await call('getMusicFolders');
  assert.deepEqual(f.musicFolders.musicFolder, [{ id: ids.grown, name: 'Grown-up music' }, { id: ids.music, name: 'Music' }]);
  assert.deepEqual((await call('getMusicFolders', {}, kidAuth)).musicFolders.musicFolder, [{ id: ids.music, name: 'Music' }]);
  const root = await call('getMusicDirectory', { id: `mf-${ids.music}` });
  assert.deepEqual(root.directory.child.map((c) => c.title), ['The Band']);
  assert.equal(await code('getMusicDirectory', { id: `mf-${ids.grown}` }, kidAuth), 70);
  assert.deepEqual((await call('getArtists', { musicFolderId: ids.grown })).artists.index.map((i) => i.name), ['O']);
  const art = await call('getMusicDirectory', { id: `ar-${ids.band}` });
  assert.equal(art.directory.name, 'The Band');
  assert.ok(art.directory.child.every((c) => c.isDir === true && c.id.startsWith('al-')));
  const alb = await call('getMusicDirectory', { id: `al-${ids.first}` });
  assert.deepEqual(alb.directory.child.map((c) => c.title), ['Opening', 'Closer']);
  assert.equal(alb.directory.parent, `ar-${ids.band}`);
  assert.equal(await code('getMusicDirectory', { id: 'mf-999' }), 70);
  const filtered = await call('getArtists', { musicFolderId: 999 });
  assert.deepEqual(filtered.artists.index || [], []);
});

test('genres and search', { skip }, async () => {
  const g = (await call('getGenres')).genres.genre;
  const rock = g.find((x) => x.value === 'Rock');
  assert.equal(rock.songCount, 2);
  assert.equal(rock.albumCount, 1);
  assert.deepEqual((await call('getSongsByGenre', { genre: 'Rock' })).songsByGenre.song.map((s) => s.title).sort(), ['Closer', 'Opening']);
  const r = await call('search3', { query: 'open' });
  assert.deepEqual(r.searchResult3.song.map((s) => s.title), ['Opening']);
  const none = await call('search3', { query: 'record', songCount: 0 });
  assert.equal((none.searchResult3.song || []).length, 0);
  assert.equal(none.searchResult3.album.length, 2);
  const all = await call('search3', { query: '""', artistCount: 10, albumCount: 10, songCount: 10 });
  assert.equal(all.searchResult3.song.length, 4);
  const old = await call('search2', { query: 'band' });
  assert.equal(old.searchResult2.artist[0].name, 'The Band');
  const page = await call('search3', { query: '', songCount: 2, songOffset: 2 });
  assert.equal(page.searchResult3.song.length, 2);
});

test('now playing', { skip }, async () => {
  const core = nf.app.core;
  const profileId = core.db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  core.db.run('DELETE FROM plays');
  core.plays.report({ profileId, item: core.library.get(ids.Opening), position: 5, client: 'x' });
  core.db.run('UPDATE plays SET updated_at = ? WHERE item_id = ?', Date.now() - 2 * 60_000, ids.Opening);
  core.plays.report({ profileId, item: core.library.get(ids.Return), position: 5, client: 'x' });
  core.db.run('UPDATE plays SET updated_at = ? WHERE item_id = ?', Date.now() - 20 * 60_000, ids.Return);
  const n = (await call('getNowPlaying')).nowPlaying.entry;
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Opening');
  assert.equal(n[0].username, 'dallas');
  assert.equal(n[0].minutesAgo, 2);
  assert.equal(n[0].playerId, 0);
  assert.equal(n[0].playerName, 'x');
});

test('review fixes: genres are counted in SQL, over every song', { skip }, async () => {
  const db = nf.app.core.db;
  const before = (await call('getGenres')).genres.genre.find((g) => g.value === 'Rock');
  assert.deepEqual({ songCount: before.songCount, albumCount: before.albumCount }, { songCount: 2, albumCount: 1 });
  let q = 0;
  const all = db.all;
  db.all = (sql, ...p) => {
    if (/FROM items i JOIN items al/.test(sql) && !/GROUP BY/.test(sql)) q++;
    return all(sql, ...p);
  };
  try {
    await call('getGenres');
  } finally {
    db.all = all;
  }
  assert.equal(q, 0, 'no per-song rows are loaded');
});

