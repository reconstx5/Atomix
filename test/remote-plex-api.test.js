// Connecting Plex through the servers API: the link code, picking a server, its address, reconnect, the address
// moving, a revoked token — and the tokens never reaching the browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client, waitForScan } from './helpers.js';
import { fakePlexTv, fakePlex, plexResource, conn, plexMovie } from './helpers-plex.js';

let tv, px1, px2, px3, nf, admin;
const ids = {};
const dead = 'http://127.0.0.1:65004';
const library = { sections: [{ key: '1', title: 'Movies', type: 'movie' }], items: { 1: { 1: [plexMovie('11', 'Harbour Lights')] } } };
const devPlex = (uri) => plexResource({ name: 'Dev Plex', machineId: 'mach1', accessToken: 'acct1', connections: [conn(dead, { local: true }), conn(uri)] });

before(async () => {
  px1 = await fakePlex({ machineId: 'mach1', token: 'acct1', ...library });
  px2 = await fakePlex({ machineId: 'friend', token: 'shared1', ...library });
  tv = await fakePlexTv({
    linkAfter: 2,
    resources: [
      devPlex(px1.url),
      plexResource({ name: "Friend's Plex", machineId: 'friend', owned: false, sourceTitle: 'Friend', accessToken: 'shared1', connections: [conn(px2.url)] }),
      plexResource({ name: 'Gone Plex', machineId: 'gone', accessToken: 'acct1', connections: [conn(dead, { local: true }), conn('http://127.0.0.1:65005')] }),
    ],
  });
  nf = await startAtomix({ ATOMIX_PLEXTV_BASE: tv.url });
  nf.app.core.remote.sync.paceMs = 0;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
});
after(async () => { await nf?.app.stop(); for (const s of [tv, px1, px2, px3]) await s?.close(); });

const db = () => nf.app.core.db;
/** A linked pin: create, poll until plex.tv says linked. */
async function linkedPin() {
  const pin = (await admin.post('/api/servers/plex/pins', {})).data;
  for (let i = 0; i < 5; i++) {
    const r = (await admin.get(`/api/servers/plex/pins/${pin.pinId}`)).data;
    if (r.linked) return { ...pin, servers: r.servers };
  }
  throw new Error('never linked');
}

test('the pin flow: code, pending, linked with the server list (Yours / Shared by), and the token never reaches the browser', async () => {
  const pin = await admin.post('/api/servers/plex/pins', {});
  assert.equal(pin.status, 200, JSON.stringify(pin.data));
  assert.match(pin.data.code, /^\w{4}$/);
  assert.ok(pin.data.pinId && pin.data.expiresAt > Date.now());
  const first = (await admin.get(`/api/servers/plex/pins/${pin.data.pinId}`)).data;
  assert.equal(first.linked, false);
  const second = await admin.get(`/api/servers/plex/pins/${pin.data.pinId}`);
  assert.equal(second.data.linked, true);
  assert.deepEqual(second.data.servers, [
    { id: 'mach1', name: 'Dev Plex', owner: null, owned: true },
    { id: 'friend', name: "Friend's Plex", owner: 'Friend', owned: false },
    { id: 'gone', name: 'Gone Plex', owner: null, owned: true },
  ]);
  const text = JSON.stringify([pin.data, first, second.data]);
  assert.ok(!text.includes('acct1') && !text.includes('shared1'), 'no token in any answer');
  ids.pinA = pin.data.pinId;
});

test('plex.tv failing right after the code is linked answers 502, never 500, and the pin recovers', async () => {
  const pin = (await admin.post('/api/servers/plex/pins', {})).data;
  await admin.get(`/api/servers/plex/pins/${pin.pinId}`);
  tv.state.resourcesDown = true;
  const r1 = await admin.get(`/api/servers/plex/pins/${pin.pinId}`);
  assert.equal(r1.status, 502);
  const r2 = await admin.get(`/api/servers/plex/pins/${pin.pinId}`);
  assert.equal(r2.status, 502, 'still a clear error, not a TypeError');
  assert.equal((await admin.post('/api/servers', { kind: 'plex', pinId: pin.pinId, serverId: 'mach1' })).status, 400);
  tv.state.resourcesDown = false;
  assert.equal((await admin.get(`/api/servers/plex/pins/${pin.pinId}`)).data.linked, true);
});

test('connecting a picked server stores url, the server\'s token, the machine id, extra, and lists available libraries', async () => {
  const res = await admin.post('/api/servers', { kind: 'plex', pinId: ids.pinA, serverId: 'mach1' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  ids.dev = res.data.id;
  assert.deepEqual([res.data.kind, res.data.name, res.data.url, res.data.username], ['plex', 'Dev Plex', px1.url, 'dallas']);
  assert.deepEqual(res.data.available, [{ remoteId: '1', name: 'Movies', type: 'movies' }]);
  assert.ok(!JSON.stringify(res.data).includes('acct1'));
  const row = db().get('SELECT * FROM servers WHERE id = ?', ids.dev);
  assert.deepEqual([row.secret, row.remote_user_id], ['acct1', 'mach1']);
  assert.deepEqual(JSON.parse(row.extra), { accountToken: 'acct1', relay: false });
});

test('a used or unknown pin: poll → { expired: true }; POST /api/servers with it → 400', async () => {
  assert.deepEqual((await admin.get(`/api/servers/plex/pins/${ids.pinA}`)).data, { expired: true });
  assert.deepEqual((await admin.get('/api/servers/plex/pins/999999')).data, { expired: true });
  const again = await admin.post('/api/servers', { kind: 'plex', pinId: ids.pinA, serverId: 'friend' });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /code/i);
});

test('a shared server is stored with its own token, not the account\'s', async () => {
  const pin = await linkedPin();
  const res = await admin.post('/api/servers', { kind: 'plex', pinId: pin.pinId, serverId: 'friend' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(db().get('SELECT secret FROM servers WHERE id = ?', res.data.id).secret, 'shared1');
  ids.friend = res.data.id;
});

test('two quick picks of the same server (a double press) connect it once', async () => {
  const pin = await linkedPin();
  const pin2 = await linkedPin();
  const before = db().get("SELECT COUNT(*) AS n FROM servers WHERE remote_user_id = 'friend'").n;
  db().run("DELETE FROM servers WHERE remote_user_id = 'friend'");
  const [a, b] = await Promise.all([
    admin.post('/api/servers', { kind: 'plex', pinId: pin.pinId, serverId: 'friend' }),
    admin.post('/api/servers', { kind: 'plex', pinId: pin2.pinId, serverId: 'friend' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM servers WHERE remote_user_id = 'friend'").n, 1);
  ids.friend = (a.status === 200 ? a : b).data.id;
  assert.equal(before, 1);
});

test('the same machine twice is a 409 "is already connected."', async () => {
  const pin = await linkedPin();
  const res = await admin.post('/api/servers', { kind: 'plex', pinId: pin.pinId, serverId: 'mach1' });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'Dev Plex is already connected.');
});

test('no address answers is a 400 naming the addresses; the pin stays usable', async () => {
  const pin = await linkedPin();
  const res = await admin.post('/api/servers', { kind: 'plex', pinId: pin.pinId, serverId: 'gone' });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, `Couldn't reach Gone Plex at any of its addresses (${dead}, http://127.0.0.1:65005)`);
  assert.equal((await admin.get(`/api/servers/plex/pins/${pin.pinId}`)).data.linked, true, 'still usable');
});

test('reconnect with a fresh pin updates the token and resets status; an account that can\'t see the server is a 400', async () => {
  db().run("UPDATE servers SET status = 'unauthorized' WHERE id = ?", ids.dev);
  const pin = await linkedPin();
  const res = await admin.post(`/api/servers/${ids.dev}/reconnect`, { pinId: pin.pinId });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'ok');
  const saved = tv.state.resources;
  tv.state.resources = saved.filter((r) => r.clientIdentifier !== 'mach1');
  const pin2 = await linkedPin();
  const bad = await admin.post(`/api/servers/${ids.dev}/reconnect`, { pinId: pin2.pinId });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "That Plex account can't see Dev Plex.");
  tv.state.resources = saved;
});

test('a revoked token at sync marks the server unauthorized and prunes nothing', async () => {
  await admin.put(`/api/servers/${ids.dev}/libraries`, { remoteIds: ['1'] });
  await waitForScan(admin);
  ids.movies = db().get('SELECT id FROM libraries WHERE server_id = ?', ids.dev).id;
  assert.equal(db().get('SELECT COUNT(*) AS n FROM items WHERE library_id = ?', ids.movies).n, 1);
  px1.state.token = 'rotated';
  await admin.post(`/api/servers/${ids.dev}/sync`, {});
  await waitForScan(admin);
  assert.equal(db().get('SELECT status FROM servers WHERE id = ?', ids.dev).status, 'unauthorized');
  assert.equal(db().get('SELECT COUNT(*) AS n FROM items WHERE library_id = ?', ids.movies).n, 1);
  px1.state.token = 'acct1';
  db().run("UPDATE servers SET status = 'ok' WHERE id = ?", ids.dev);
});

test('a server whose address moved is found again through plex.tv at sync, and its url is updated', async () => {
  px3 = await fakePlex({ machineId: 'mach1', token: 'acct1', ...library });
  await px1.close();
  px1 = null;
  tv.state.resources = tv.state.resources.map((r) => (r.clientIdentifier === 'mach1' ? devPlex(px3.url) : r));
  await admin.post(`/api/servers/${ids.dev}/sync`, {});
  const st = await waitForScan(admin);
  assert.equal(st.error, null, String(st.error));
  const row = db().get('SELECT url, status FROM servers WHERE id = ?', ids.dev);
  assert.deepEqual([row.url, row.status], [px3.url, 'ok']);
});

test('a Plex reconnect to a new address syncs, so artwork points at the new address', async () => {
  const px4 = await fakePlex({ machineId: 'mach1', token: 'acct1', ...library });
  tv.state.resources = tv.state.resources.map((r) => (r.clientIdentifier === 'mach1' ? devPlex(px4.url) : r));
  await px3.close();
  px3 = px4;
  const pin = await linkedPin();
  assert.equal((await admin.post(`/api/servers/${ids.dev}/reconnect`, { pinId: pin.pinId })).status, 200);
  await waitForScan(admin);
  const poster = db().get('SELECT poster FROM items WHERE library_id = ?', ids.movies).poster;
  assert.ok(poster.startsWith(`${px4.url}/`), poster);
});

test('/api/servers never shows extra or secret; relay is shown', async () => {
  db().run('UPDATE servers SET extra = ? WHERE id = ?', JSON.stringify({ accountToken: 'acct1', relay: true }), ids.friend);
  const list = (await admin.get('/api/servers')).data;
  const text = JSON.stringify(list);
  assert.ok(!text.includes('acct1') && !text.includes('shared1') && !text.includes('extra') && !text.includes('secret'));
  assert.equal(list.find((s) => s.id === ids.friend).relay, true);
  assert.equal(list.find((s) => s.id === ids.dev).relay, undefined);
});
