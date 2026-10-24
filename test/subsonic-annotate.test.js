// Music apps changing things: stars (Atomix's hearts), ratings (Atomix's stars), scrobble calls (play history) and
// playlists — the same data as Atomix's own; smart playlists read-only; only the owner edits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let sam; // a second grown-up profile, with its own app password
let auth;
let samAuth;
let kidAuth;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  for (const [n, title] of [[1, 'Opening'], [2, 'Closer'], [3, 'Encore']]) {
    makeAudio(path.join(media, 'Music', 'The Band', 'First Record', `0${n} ${title}.mp3`), { tags: { title, artist: 'The Band', album: 'First Record', track: `${n}/3`, genre: 'Rock' } });
  }
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(admin);
  const one = (sql, ...p) => nf.app.core.db.get(sql, ...p)?.id;
  for (const t of ['Opening', 'Closer', 'Encore']) ids[t] = one("SELECT id FROM items WHERE kind = 'track' AND title = ?", t);
  ids.album = one("SELECT id FROM items WHERE kind = 'album'");
  ids.artist = one("SELECT id FROM items WHERE kind = 'artist'");
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data.secret;
  auth = () => tokenAuth('dallas', secret);
  const samP = (await admin.post('/api/profiles', { name: 'Sam', avatar: 'blue' })).data;
  sam = client(nf.base);
  await sam.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await sam.post(`/api/profiles/${samP.id}/select`, {});
  const ss = (await sam.post('/api/me/app-passwords', { name: 'Laptop' })).data.secret;
  samAuth = () => tokenAuth('dallas', ss);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  const ks = (await kid.post('/api/me/app-passwords', { name: 'Tablet' })).data.secret;
  kidAuth = () => tokenAuth('dallas', ks);
});

after(async () => {
  await nf?.app.stop();
});

const call = async (method, params = {}, who = auth) => (await rest(nf.base, method, { ...who(), ...params })).body;
const ok = async (...a) => {
  const b = await call(...a);
  assert.equal(b.status, 'ok', JSON.stringify(b));
  return b;
};
const errOf = async (...a) => (await call(...a)).error;

test("star and rating are the same data as Atomix's", { skip }, async () => {
  await ok('star', { id: `tr-${ids.Opening}`, albumId: `al-${ids.album}`, artistId: `ar-${ids.artist}` });
  for (const id of [ids.Opening, ids.album, ids.artist]) assert.equal((await admin.get(`/api/items/${id}`)).data.item.favourite, true, String(id));
  assert.equal((await sam.get(`/api/items/${ids.Opening}`)).data.item.favourite, false, "another profile's hearts are its own");
  await ok('setRating', { id: `tr-${ids.Opening}`, rating: 4 });
  assert.equal((await admin.get(`/api/items/${ids.Opening}`)).data.item.stars, 4);
  await ok('setRating', { id: `al-${ids.album}`, rating: 0 });
  await ok('setRating', { id: `tr-${ids.Opening}`, rating: 0 });
  assert.equal((await admin.get(`/api/items/${ids.Opening}`)).data.item.stars, null);
  await ok('unstar', { id: `tr-${ids.Opening}` });
  assert.equal((await admin.get(`/api/items/${ids.Opening}`)).data.item.favourite, false);
  assert.equal((await errOf('setRating', { id: `tr-${ids.Opening}`, rating: 7 })).code, 0);
  assert.equal((await errOf('setRating', { id: `tr-${ids.Opening}` })).code, 10);
  assert.equal((await errOf('star', { id: 'tr-999999' })).code, 70);
});

test('scrobble writes play history once', { skip }, async () => {
  const core = nf.app.core;
  core.db.run('DELETE FROM plays');
  const counted = [];
  core.plays.onCounted((e) => counted.push(e));
  await ok('scrobble', { id: `tr-${ids.Closer}`, submission: 'false' });
  let rows = core.db.all('SELECT * FROM plays WHERE item_id = ?', ids.Closer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].counted, 0);
  const at = Date.now() - 60_000;
  await ok('scrobble', { id: `tr-${ids.Closer}`, time: at });
  rows = core.db.all('SELECT * FROM plays WHERE item_id = ?', ids.Closer);
  assert.equal(rows.length, 1, 'the now-playing play is the one counted');
  assert.equal(rows[0].counted, 1);
  assert.equal(counted.length, 1);
  assert.equal(counted[0].client, 'Phone');
  await ok('scrobble', { id: `tr-${ids.Closer}`, time: Date.now() });
  assert.equal(core.db.get('SELECT COUNT(*) AS n FROM plays WHERE item_id = ? AND counted = 1', ids.Closer).n, 2, 'a second scrobble is a second play');
  assert.equal(counted.length, 2);
  // Several at once (an app catching up after being offline), each at its own time.
  await ok('scrobble', { id: [`tr-${ids.Opening}`, `tr-${ids.Encore}`], time: [at - 600_000, at - 300_000] });
  const op = core.db.get('SELECT started_at FROM plays WHERE item_id = ? AND counted = 1', ids.Opening);
  assert.equal(op.started_at, at - 600_000);
  assert.equal((await admin.get(`/api/items/${ids.album}`)).data.tracks.find((t) => t.id === ids.Closer).playCount, 2);
});

test('playlists round trip', { skip }, async () => {
  const made = await ok('createPlaylist', { name: 'Road trip', songId: [`tr-${ids.Opening}`, `tr-${ids.Closer}`] });
  const pid = made.playlist.id;
  assert.match(pid, /^pl-\d+$/);
  assert.deepEqual(made.playlist.entry.map((e) => e.title), ['Opening', 'Closer']);
  const listId = Number(pid.slice(3));
  let web = (await admin.get(`/api/lists/${listId}`)).data;
  assert.equal(web.kind, 'music');
  assert.deepEqual(web.items.map((i) => i.title), ['Opening', 'Closer']);
  await ok('updatePlaylist', { playlistId: pid, name: 'Road trip 2', songIdToAdd: `tr-${ids.Encore}`, songIndexToRemove: 0 });
  web = (await admin.get(`/api/lists/${listId}`)).data;
  assert.equal(web.name, 'Road trip 2');
  assert.deepEqual(web.items.map((i) => i.title), ['Closer', 'Encore']);
  await ok('updatePlaylist', { playlistId: pid, public: 'true' });
  assert.equal((await admin.get(`/api/lists/${listId}`)).data.shared, true);
  // createPlaylist with playlistId replaces its songs, in order.
  await ok('createPlaylist', { playlistId: pid, songId: [`tr-${ids.Encore}`, `tr-${ids.Opening}`] });
  assert.deepEqual((await admin.get(`/api/lists/${listId}`)).data.items.map((i) => i.title), ['Encore', 'Opening']);
  const listed = (await ok('getPlaylists')).playlists.playlist.find((p) => p.id === pid);
  assert.equal(listed.name, 'Road trip 2');
  assert.equal(listed.songCount, 2);
  assert.equal(listed.owner, 'dallas');
  assert.equal(listed.public, true);
  assert.equal(listed.readonly, false);
  assert.equal(listed.coverArt, pid);
  const got = (await ok('getPlaylist', { id: pid })).playlist;
  assert.deepEqual(got.entry.map((e) => e.title), ['Encore', 'Opening']);
  ids.shared = pid;
  const other = (await ok('createPlaylist', { name: 'Gone soon', songId: `tr-${ids.Opening}` })).playlist.id;
  await ok('deletePlaylist', { id: other });
  assert.equal((await admin.get(`/api/lists/${Number(other.slice(3))}`)).status, 404);
  assert.equal((await errOf('createPlaylist', {})).code, 10);
});

test('smart lists are read-only playlists', { skip }, async () => {
  const smart = (await admin.post('/api/lists', { kind: 'smart', name: 'All rock', media: 'music', rules: { match: 'all', rules: [{ field: 'genre', op: 'is', value: 'Rock' }], sort: 'title', limit: {} } })).data;
  await admin.post('/api/lists', { kind: 'smart', name: 'Films', media: 'video', rules: { rules: [] } });
  const sid = `sp-${smart.id}`;
  const all = (await ok('getPlaylists')).playlists.playlist;
  const entry = all.find((p) => p.id === sid);
  assert.equal(entry.name, 'All rock');
  assert.equal(entry.readonly, true);
  assert.equal(entry.songCount, 3);
  assert.ok(!all.some((p) => p.name === 'Films'), 'video smart lists are not music playlists');
  assert.deepEqual((await ok('getPlaylist', { id: sid })).playlist.entry.map((e) => e.title), ['Closer', 'Encore', 'Opening']);
  assert.equal((await errOf('updatePlaylist', { playlistId: sid, name: 'x' })).code, 50);
  assert.equal((await errOf('deletePlaylist', { id: sid })).code, 50);
  assert.equal((await errOf('createPlaylist', { playlistId: sid, songId: `tr-${ids.Opening}` })).code, 50);
});

test("others' playlists", { skip }, async () => {
  const mine = (await ok('createPlaylist', { name: 'Private', songId: `tr-${ids.Opening}` })).playlist.id;
  const seen = (await ok('getPlaylists', {}, samAuth)).playlists.playlist;
  const shared = seen.find((p) => p.id === ids.shared);
  assert.ok(shared, "a shared list is listed for another profile");
  assert.equal(shared.readonly, true);
  assert.equal(shared.owner, 'dallas');
  assert.ok(!seen.some((p) => p.id === mine), 'a private one is not');
  assert.equal((await errOf('getPlaylist', { id: mine }, samAuth)).code, 70);
  assert.equal((await errOf('updatePlaylist', { playlistId: ids.shared, name: 'Mine now' }, samAuth)).code, 50);
  assert.equal((await errOf('deletePlaylist', { id: ids.shared }, samAuth)).code, 50);
  // A Kids profile can make its own playlists but not share them.
  const kids = (await ok('createPlaylist', { name: 'Mia mix', songId: `tr-${ids.Opening}` }, kidAuth)).playlist.id;
  assert.equal((await errOf('updatePlaylist', { playlistId: kids, public: 'true' }, kidAuth)).code, 50);
  assert.equal((await errOf('updatePlaylist', { playlistId: kids, public: 'true' }, kidAuth)).message, "Kids profiles can't share playlists.");
});

test("review fixes: a scrobble's own time is the listen's time, even over an open play", { skip }, async () => {
  const core = nf.app.core;
  core.db.run('DELETE FROM plays');
  await ok('scrobble', { id: `tr-${ids.Encore}`, submission: 'false' }); // opens a play now
  const at = Date.now() - 3 * 3600_000;
  const counted = [];
  core.plays.onCounted((e) => counted.push(e));
  await ok('scrobble', { id: `tr-${ids.Encore}`, time: at });
  const row = core.db.get('SELECT * FROM plays WHERE item_id = ? AND counted = 1', ids.Encore);
  assert.equal(row.started_at, at);
  assert.equal(counted.length, 1);
});

test('review fixes: now playing shows only this account', { skip }, async () => {
  const core = nf.app.core;
  await admin.post('/api/users', { username: 'neighbour', password: 'neighbour123' });
  const n = client(nf.base);
  await n.post('/api/auth/login', { username: 'neighbour', password: 'neighbour123' });
  await n.get('/api/profiles');
  const nProfile = (await n.get('/api/profiles')).data[0];
  await n.post(`/api/profiles/${nProfile.id}/select`, {});
  const ns = (await n.post('/api/me/app-passwords', { name: 'Their phone' })).data.secret;
  core.db.run('DELETE FROM plays');
  await ok('scrobble', { id: `tr-${ids.Closer}`, submission: 'false' }, () => tokenAuth('neighbour', ns));
  await ok('scrobble', { id: `tr-${ids.Opening}`, submission: 'false' }, samAuth);
  const mine = (await ok('getNowPlaying')).nowPlaying.entry;
  assert.deepEqual(mine.map((e) => e.username), ['Sam'], "another account's listening isn't shown");
  const theirs = (await ok('getNowPlaying', {}, () => tokenAuth('neighbour', ns))).nowPlaying.entry;
  assert.deepEqual(theirs.map((e) => e.title), ['Closer']);
});


// ---- v0.21 tidy-up ----
test('scrobbling several ids checks them all first (nothing recorded when one is not found)', { skip }, async () => {
  const core = nf.app.core;
  core.db.run('DELETE FROM plays');
  assert.equal((await errOf('scrobble', { id: [`tr-${ids.Opening}`, 'tr-999999'], time: [Date.now() - 1000, Date.now()] })).code, 70);
  assert.equal(core.db.get('SELECT COUNT(*) AS n FROM plays').n, 0);
});

test('songIndexToRemove counts the songs the app was shown', { skip }, async () => {
  const made = await ok('createPlaylist', { name: 'Hidden first', songId: [`tr-${ids.Opening}`, `tr-${ids.Closer}`] });
  const listId = Number(made.playlist.id.slice(3));
  // Something the app isn't shown, at the front (not a song).
  nf.app.core.db.run('INSERT INTO list_items (list_id, item_id, position, added_at) VALUES (?, ?, -1, 1)', listId, ids.album);
  assert.deepEqual((await ok('getPlaylist', { id: made.playlist.id })).playlist.entry.map((e) => e.title), ['Opening', 'Closer']);
  await ok('updatePlaylist', { playlistId: made.playlist.id, songIndexToRemove: 0 });
  assert.deepEqual((await ok('getPlaylist', { id: made.playlist.id })).playlist.entry.map((e) => e.title), ['Closer'], 'the first song the app saw');
  await ok('deletePlaylist', { id: made.playlist.id });
});

test('a list cut at its cap says there is more (truncated)', { skip }, async () => {
  const { LIMITS } = await import('../src/subsonic/browse.js');
  const was = { ...LIMITS };
  await ok('star', { id: [`tr-${ids.Opening}`, `tr-${ids.Closer}`] });
  const made = await ok('createPlaylist', { name: 'Two songs', songId: [`tr-${ids.Opening}`, `tr-${ids.Closer}`] });
  try {
    Object.assign(LIMITS, { starred: 1, playlist: 1 });
    const st = (await ok('getStarred2')).starred2;
    assert.equal(st.song.length, 1);
    assert.equal(st.truncated, true);
    const pl = (await ok('getPlaylist', { id: made.playlist.id })).playlist;
    assert.equal(pl.entry.length, 1);
    assert.equal(pl.truncated, true);
    Object.assign(LIMITS, was);
    assert.equal((await ok('getStarred2')).starred2.truncated, undefined, 'nothing said when it all fits');
  } finally {
    Object.assign(LIMITS, was);
    await ok('unstar', { id: [`tr-${ids.Opening}`, `tr-${ids.Closer}`] });
    await ok('deletePlaylist', { id: made.playlist.id });
  }
});
