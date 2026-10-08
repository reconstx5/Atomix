// The servers API: connecting, choosing libraries, syncing, reconnecting, removing — admin only, secrets never
// returned, and this Atomix refusing to connect to itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client, waitForScan } from './helpers.js';
import { fakeJellyfin, jfMovie } from './helpers-jellyfin.js';

let jf, nf, admin, viewer;
const ids = {};

before(async () => {
  jf = await fakeJellyfin({
    movies: [jfMovie('m1', 'Alien', { OfficialRating: 'NZ-R16' }), jfMovie('m2', 'Cartoon', { OfficialRating: 'NZ-G' })],
    shows: [{ Id: 's1', Name: 'Far Show', OfficialRating: 'NZ-G', Seasons: [{ Id: 'se1', Name: 'Season 1', IndexNumber: 1, ParentId: 's1', Episodes: [{ Id: 'e1', Name: 'Pilot', IndexNumber: 1, ParentIndexNumber: 1, ParentId: 'se1', MediaSources: [{ Container: 'mp4', MediaStreams: [] }] }] }] }],
  });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/users', { username: 'sam', password: 'sampass123', role: 'user' });
  viewer = client(nf.base);
  await viewer.post('/api/auth/login', { username: 'sam', password: 'sampass123' });
});
after(async () => { await nf?.app.stop(); jf?.close(); });

const db = () => nf.app.core.db;

test('POST /api/servers connects, stores the row without returning the secret, and lists available libraries', async () => {
  const res = await admin.post('/api/servers', { kind: 'jellyfin', url: jf.url, username: 'dallas', password: '4321' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  ids.server = res.data.id;
  assert.equal(res.data.name, 'Fake Jellyfin');
  assert.equal(res.data.kind, 'jellyfin');
  assert.equal(res.data.status, 'ok');
  assert.equal(res.data.secret, undefined);
  assert.ok(!JSON.stringify(res.data).includes('tok1'), 'no token anywhere in the answer');
  assert.deepEqual(res.data.available, [{ remoteId: 'lib-m', name: 'Movies', type: 'movies' }, { remoteId: 'lib-t', name: 'TV Shows', type: 'tv' }]);
  assert.deepEqual(res.data.libraries, []);
  assert.equal(db().get('SELECT secret FROM servers WHERE id = ?', ids.server).secret, 'tok1');
  const list = (await admin.get('/api/servers')).data;
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes('tok1'));
  assert.equal(list[0].url, jf.url);
});

test('a bad sign-in is a 400 with the server\'s message (never a 401, which means this session), and nothing is stored', async () => {
  const res = await admin.post('/api/servers', { kind: 'jellyfin', url: jf.url, username: 'someone', password: 'nope' });
  assert.equal(res.status, 400, 'a 401 would read as this Atomix session ending');
  assert.match(res.data.error, /sign-in|password|accepted/i);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM servers').n, 1);
});

test('connecting the same server with the same account twice is refused', async () => {
  const res = await admin.post('/api/servers', { kind: 'jellyfin', url: jf.url, username: 'dallas', password: '4321' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /already connected/i);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM servers').n, 1);
});

test('connecting this Atomix to itself is refused', async () => {
  const res = await admin.post('/api/servers', { kind: 'atomix', url: nf.base, username: 'dallas', password: 'password123' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /That's this Atomix/);
  const alias = await admin.post('/api/servers', { kind: 'atomix', url: nf.base.replace('127.0.0.1', 'localhost'), username: 'dallas', password: 'password123' });
  assert.equal(alias.status, 400);
});

test('PUT libraries creates library rows (named after the server when the name is taken), queues a sync, and unticking removes a library and its items', async () => {
  const local = Number(db().run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Movies', 'movies', '[]', '{}', ?)", Date.now()).lastInsertRowid);
  const res = await admin.put(`/api/servers/${ids.server}/libraries`, { remoteIds: ['lib-m', 'lib-t'] });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.libraries.map((l) => [l.name, l.type, l.remoteId]), [['Movies (Fake Jellyfin)', 'movies', 'lib-m'], ['TV Shows', 'tv', 'lib-t']]);
  db().run('DELETE FROM libraries WHERE id = ?', local);
  await waitForScan(admin);
  const libs = (await admin.get('/api/libraries')).data.filter((l) => l.serverId === ids.server);
  assert.equal(libs.length, 2);
  assert.ok(libs.every((l) => l.serverName === 'Fake Jellyfin' && l.paths.length === 0));
  ids.movies = libs.find((l) => l.type === 'movies').id;
  assert.equal((await admin.get(`/api/libraries/${ids.movies}/items`)).data.items.length, 2, 'the sync ran');
  const again = await admin.put(`/api/servers/${ids.server}/libraries`, { remoteIds: ['lib-m'] });
  assert.deepEqual(again.data.libraries.map((l) => l.remoteId), ['lib-m']);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM libraries WHERE server_id = ?", ids.server).n, 1);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM items WHERE title = 'Far Show'").n, 0, 'its items went with it');
  assert.equal(db().get("SELECT COUNT(*) AS n FROM items WHERE library_id = ?", ids.movies).n, 2, 'the kept library is untouched');
});

test('a library that is no longer on the server is flagged in the listing', async () => {
  await admin.put(`/api/servers/${ids.server}/libraries`, { remoteIds: ['lib-m', 'lib-t'] });
  await waitForScan(admin);
  jf.state.views = jf.state.views.filter((v) => v.Id !== 'lib-t');
  await admin.post(`/api/servers/${ids.server}/sync`, {});
  await waitForScan(admin);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM items WHERE title = 'Far Show'").n, 1, 'its titles are kept');
  const list = (await admin.get('/api/servers')).data;
  const lib = list[0].libraries.find((l) => l.remoteId === 'lib-t');
  assert.ok(lib, 'still listed');
  assert.equal(lib.gone, true);
  assert.equal(list[0].libraries.find((l) => l.remoteId === 'lib-m').gone, false);
  // Renaming it in the Edit dialog keeps the flag.
  await admin.put(`/api/libraries/${lib.id}`, { name: 'Far TV' });
  await admin.put(`/api/libraries/${lib.id}`, { name: 'TV Shows' });
  assert.equal((await admin.get('/api/servers')).data[0].libraries.find((l) => l.remoteId === 'lib-t').gone, true, 'a rename keeps the flag');
  await admin.put(`/api/servers/${ids.server}/libraries`, { remoteIds: ['lib-m'] });
});

test('available lists the server’s libraries now; the dashboard lists servers', async () => {
  const av = (await admin.get(`/api/servers/${ids.server}/available`)).data;
  assert.deepEqual(av.map((l) => l.remoteId), ['lib-m']);
  const dash = (await admin.get('/api/admin/dashboard')).data;
  assert.deepEqual(dash.servers.map((s) => [s.name, s.status]), [['Fake Jellyfin', 'ok']]);
});

test('sync queues every library of the server', async () => {
  jf.state.movies.push(jfMovie('m3', 'Newcomer', { OfficialRating: 'NZ-G' }));
  const res = await admin.post(`/api/servers/${ids.server}/sync`, {});
  assert.equal(res.status, 200);
  await waitForScan(admin);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM items WHERE title = 'Newcomer'").n, 1);
});

test('a server that stopped accepting the token answers 400 on available and libraries (never 401) and is marked', async () => {
  jf.state.token = 'rotated';
  assert.equal((await admin.get(`/api/servers/${ids.server}/available`)).status, 400);
  assert.equal(db().get('SELECT status FROM servers WHERE id = ?', ids.server).status, 'unauthorized');
  db().run("UPDATE servers SET status = 'ok' WHERE id = ?", ids.server);
  assert.equal((await admin.put(`/api/servers/${ids.server}/libraries`, { remoteIds: ['lib-m'] })).status, 400);
  assert.equal(db().get('SELECT status FROM servers WHERE id = ?', ids.server).status, 'unauthorized');
  jf.state.token = 'tok1';
  db().run("UPDATE servers SET status = 'ok' WHERE id = ?", ids.server);
});

test('reconnect replaces the secret and resets status', async () => {
  db().run("UPDATE servers SET status = 'unauthorized', status_detail = 'x' WHERE id = ?", ids.server);
  jf.state.token = 'tok2';
  const bad = await admin.post(`/api/servers/${ids.server}/reconnect`, { password: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(db().get('SELECT status FROM servers WHERE id = ?', ids.server).status, 'unauthorized');
  const res = await admin.post(`/api/servers/${ids.server}/reconnect`, { password: '4321' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'ok');
  assert.equal(res.data.secret, undefined);
  assert.equal(db().get('SELECT secret FROM servers WHERE id = ?', ids.server).secret, 'tok2');
});

test('/api/status lists servers with their state for an admin only', async () => {
  const st = (await admin.get('/api/status')).data;
  assert.deepEqual(st.servers.map((s) => [s.id, s.name, s.kind, s.status]), [[ids.server, 'Fake Jellyfin', 'jellyfin', 'ok']]);
  assert.ok(st.servers[0].lastSync > 0);
  assert.equal((await viewer.get('/api/status')).data.servers, undefined);
});

test('viewers get 403 on every servers route', async () => {
  assert.equal((await viewer.get('/api/servers')).status, 403);
  assert.equal((await viewer.post('/api/servers', { kind: 'jellyfin', url: jf.url, username: 'dallas', password: '4321' })).status, 403);
  assert.equal((await viewer.put(`/api/servers/${ids.server}/libraries`, { remoteIds: [] })).status, 403);
  assert.equal((await viewer.post(`/api/servers/${ids.server}/sync`, {})).status, 403);
  assert.equal((await viewer.post(`/api/servers/${ids.server}/reconnect`, { password: 'x' })).status, 403);
  assert.equal((await viewer.del(`/api/servers/${ids.server}`)).status, 403);
});

test('DELETE removes the server, its libraries and items; the picks cache is cleared', async () => {
  nf.app.core.picks.cache.set('probe', { at: Date.now(), value: [] });
  const res = await admin.del(`/api/servers/${ids.server}`);
  assert.equal(res.status, 200);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM servers').n, 0);
  assert.equal(db().get('SELECT COUNT(*) AS n FROM libraries WHERE server_id = ?', ids.server).n, 0);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM items WHERE path LIKE 'remote:%'").n, 0);
  assert.equal(nf.app.core.picks.cache.size, 0);
  assert.equal((await admin.get(`/api/servers/${ids.server}`)).status, 404);
  assert.equal((await admin.post(`/api/servers/${ids.server}/sync`, {})).status, 404);
});

test('plexClientId cannot be set through the settings API', async () => {
  nf.app.core.settings.set({ plexClientId: 'keep-me' });
  await admin.put('/api/admin/settings', { plexClientId: 'hijacked' });
  assert.equal(nf.app.core.settings.get('plexClientId'), 'keep-me');
});
