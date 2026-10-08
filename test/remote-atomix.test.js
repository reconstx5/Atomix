// The Atomix provider against a real second Atomix started in-process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { AtomixProvider } from '../src/remote/atomix.js';
import { resolveSource } from '../src/remote/index.js';

let far, farAdmin, provider, server;
const media = tempDir();
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  makeVideo(path.join(media, 'Movies', 'Far Film (2018)', 'Far Film (2018).mp4'));
  makeVideo(path.join(media, 'TV', 'Far Show', 'Season 01', 'Far.Show.S01E01.mp4'));
  makeAudio(path.join(media, 'Music', 'Far Band', 'Far Record', '01 Far Song.mp3'), { tags: { title: 'Far Song', artist: 'Far Band', album: 'Far Record', track: '1/1' } });
  far = await startAtomix();
  farAdmin = client(far.base);
  await farAdmin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await farAdmin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await farAdmin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] });
  await farAdmin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(farAdmin);
  // A second account whose only profiles need a PIN (the Review-Focus case).
  await farAdmin.post('/api/users', { username: 'guest', password: 'guestpass1', role: 'user' });
  const guest = client(far.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  const gp = (await guest.get('/api/profiles')).data;
  await guest.patch(`/api/profiles/${gp[0].id}`, { pin: '1111' });
  provider = new AtomixProvider({ kind: 'atomix', version: '0.11.0' });
  server = { id: 1, kind: 'atomix', name: 'Far Atomix', url: far.base, username: 'dallas', secret: 'password123', remote_user_id: null };
});
after(async () => far?.app.stop());

test('connect signs in, picks the first PIN-less non-kids profile, and gives its id', { skip }, async () => {
  const r = await provider.connect({ url: far.base, username: 'dallas', password: 'password123' });
  assert.equal(r.secret, 'password123');
  assert.ok(r.remoteUserId);
  assert.ok(r.serverName);
  server.remote_user_id = r.remoteUserId;
  await assert.rejects(provider.connect({ url: far.base, username: 'dallas', password: 'wrong' }), (e) => e.status === 401);
  await assert.rejects(provider.connect({ url: far.base, username: 'guest', password: 'guestpass1' }), (e) => e.status === 400 && /without a PIN/.test(e.message));
});

test('libraries lists the far libraries with their types', { skip }, async () => {
  const libs = await provider.libraries(server);
  assert.deepEqual(libs.map((l) => l.type).sort(), ['movies', 'music', 'tv']);
  assert.ok(libs.every((l) => l.remoteId && l.name));
});

test('items shape movies, shows, seasons, episodes, artists, albums and tracks with media and images', { skip }, async () => {
  const libs = await provider.libraries(server);
  const lib = (type) => ({ remote_id: libs.find((l) => l.type === type).remoteId });
  const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };
  const movies = await collect(provider.items(server, lib('movies'), 'movie'));
  assert.equal(movies.length, 1);
  assert.equal(movies[0].title, 'Far Film');
  assert.ok(movies[0].media?.video, 'media from the far /api/items/:id');
  assert.ok(movies[0].duration > 0);
  far.app.core.db.run("UPDATE items SET certification = 'NZ:R16', min_age = 16 WHERE kind = 'show'");
  const shows = await collect(provider.items(server, lib('tv'), 'show'));
  assert.equal(shows[0].title, 'Far Show');
  assert.equal(shows[0].certification, 'NZ:R16', 'a show carries its rating (kids rules need it)');
  const seasons = await collect(provider.items(server, lib('tv'), 'season', shows[0].remoteId));
  assert.equal(seasons[0].season, 1);
  const eps = await collect(provider.items(server, lib('tv'), 'episode', seasons[0].remoteId));
  assert.deepEqual([eps[0].season, eps[0].episode], [1, 1]);
  const artists = await collect(provider.items(server, lib('music'), 'artist'));
  assert.equal(artists[0].title, 'Far Band');
  const albums = await collect(provider.items(server, lib('music'), 'album', artists[0].remoteId));
  assert.equal(albums[0].title, 'Far Record');
  const tracks = await collect(provider.items(server, lib('music'), 'track', albums[0].remoteId));
  assert.deepEqual([tracks[0].title, tracks[0].artist, tracks[0].album, tracks[0].track], ['Far Song', 'Far Band', 'Far Record', 1]);
  assert.ok(tracks[0].duration > 0);
});

test('streamUrl and imageUrl use the far routes with the cookie header', { skip }, async () => {
  const libs = await provider.libraries(server);
  const movies = [];
  for await (const x of provider.items(server, { remote_id: libs.find((l) => l.type === 'movies').remoteId }, 'movie')) movies.push(x);
  const s = provider.streamUrl(server, movies[0]);
  assert.match(s.url, /\/api\/items\/\d+\/file$/);
  assert.match(s.headers.cookie, /^atomix_session=/);
  const img = provider.imageUrl(server, { ...movies[0], images: { ...movies[0].images, poster: true, posterUrl: '/api/items/1/image/poster?v=123' } }, 'poster');
  assert.match(img.url, /\/api\/items\/\d+\/image\/poster\?v=\d+$/, 'the far ?v=: a changed picture is a new URL');
  assert.ok(movies[0].addedAt > 0, 'the far addedAt');
  assert.ok(img.headers.cookie);
});

test('reportProgress posts to the far progress route', { skip }, async () => {
  const libs = await provider.libraries(server);
  const movies = [];
  for await (const x of provider.items(server, { remote_id: libs.find((l) => l.type === 'movies').remoteId }, 'movie')) movies.push(x);
  await provider.reportProgress(server, movies[0], { position: 2, duration: 4, watched: false });
  const far1 = (await farAdmin.get(`/api/items/${movies[0].remoteId}`)).data;
  assert.equal(far1.item.progress?.position, 2);
});

test('a cold provider (after a restart) signs in before giving stream headers', { skip }, async () => {
  const fresh = new AtomixProvider({ kind: 'atomix', version: '0.11.0' });
  const cold = { ...server, id: 77 };
  assert.deepEqual(fresh.streamUrl(cold, { remoteId: '1', kind: 'movie' }).headers, {}, 'nothing yet');
  const db = { get: (sql) => (sql.includes('FROM libraries') ? { server_id: 77 } : cold) };
  const src = await resolveSource({ db, providers: { for: () => fresh } }, { path: 'remote:77:1', library_id: 1, remote_id: '1', kind: 'movie' });
  assert.match(src.headers.cookie, /^atomix_session=/, 'signed in first');
  // A wrong stored password: the source answers 502 (never a 401 to the browser) and says to sign in again.
  const wrong = new AtomixProvider({ kind: 'atomix', version: '0.11.0' });
  const bad = { ...cold, id: 78, secret: 'nope' };
  const marks = [];
  const db2 = { get: (sql) => (sql.includes('FROM libraries') ? { server_id: 78 } : bad), run: (sql, ...p) => marks.push([sql, ...p]) };
  await assert.rejects(resolveSource({ db: db2, providers: { for: () => wrong } }, { path: 'remote:78:1', library_id: 1, remote_id: '1', kind: 'movie' }), (e) => e.status === 502 && /sign in again/i.test(e.message));
  assert.ok(marks.some(([sql]) => /unauthorized/.test(sql)), 'the server is marked unauthorized');
});

test('a 401 later signs in again once, then marks unauthorized', { skip }, async () => {
  assert.equal((await provider.ping(server)).ok, true);
  // The far account's password changes (which also revokes its sessions): the first retry signs in with the stored
  // password and fails, so the server is unauthorized until an admin reconnects.
  assert.equal((await farAdmin.post('/api/me/password', { current: 'password123', password: 'changed12345' })).status, 200);
  const p = await provider.ping(server);
  assert.deepEqual(p, { ok: false, detail: 'unauthorized' });
  // With the right password stored again, a sign-in happens on its own.
  const p2 = await provider.ping({ ...server, secret: 'changed12345' });
  assert.equal(p2.ok, true);
});
