// plex.tv: link codes, the server list, and choosing an address that answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakePlexTv, fakePlex, plexResource, conn } from './helpers-plex.js';
import { PlexTv, chooseConnection, plexClientId, plexHeaders } from '../src/remote/plextv.js';

const settingsStub = () => {
  const s = {};
  return { get: (k) => s[k], set: (o) => Object.assign(s, o), all: () => ({ ...s }) };
};
let tv, live, other, tvApi, settings;
const dead = 'http://127.0.0.1:65002';

before(async () => {
  live = await fakePlex({ machineId: 'mach1', token: 'acct1' });
  other = await fakePlex({ machineId: 'someone-else', token: 'shared1' });
  tv = await fakePlexTv({
    linkAfter: 3,
    resources: [
      plexResource({ name: 'Dev Plex', machineId: 'mach1', accessToken: 'acct1', connections: [conn(dead, { local: true }), conn(live.url)] }),
      plexResource({ name: "Friend's Plex", machineId: 'friend', owned: false, sourceTitle: 'Friend', accessToken: 'shared1', connections: [conn(dead)] }),
      { name: 'Phone', product: 'Plex for Android', provides: 'player', clientIdentifier: 'p1', connections: [] },
    ],
  });
  settings = settingsStub();
  tvApi = new PlexTv({ base: tv.url, settings, version: '0.12.0', serverName: () => 'Living room' });
});
after(async () => { await tv?.close(); await live?.close(); await other?.close(); });

test('a pin is created with Atomix\'s headers, stays pending, then links with a token', async () => {
  const pin = await tvApi.createPin();
  assert.ok(pin.id && /^\w{4}$/.test(pin.code));
  assert.ok(pin.expiresAt > Date.now());
  const call = tv.calls.find((c) => c.path === '/api/v2/pins');
  assert.equal(call.headers['x-plex-product'], 'Atomix');
  assert.equal(call.headers['x-plex-client-identifier'], settings.get('plexClientId'));
  assert.equal(call.headers['x-plex-device-name'], 'Living room');
  assert.equal(call.headers['x-plex-version'], '0.12.0');
  assert.equal((await tvApi.checkPin(pin.id)).pending, true);
  assert.equal((await tvApi.checkPin(pin.id)).pending, true);
  assert.deepEqual(await tvApi.checkPin(pin.id), { authToken: 'acct1' });
});

test('an expired pin says so', async () => {
  const quick = await fakePlexTv({ expireAfter: 0 });
  const api = new PlexTv({ base: quick.url, settings, version: '0.12.0', serverName: () => 'x' });
  const pin = await api.createPin();
  assert.deepEqual(await api.checkPin(pin.id), { expired: true });
  await quick.close();
});

test('resources keeps servers only, with owner and the server\'s own token', async () => {
  const list = await tvApi.resources('acct1');
  assert.deepEqual(list.map((r) => r.name), ['Dev Plex', "Friend's Plex"]);
  const friend = list.find((r) => r.clientIdentifier === 'friend');
  assert.equal(friend.sourceTitle, 'Friend');
  assert.equal(friend.accessToken, 'shared1', 'a shared server keeps its own token');
  assert.equal(friend.owned, false);
});

test('chooseConnection skips a dead local address and takes the working one; a relay only when nothing else answers; a mismatched machine id is refused', async () => {
  const a = await chooseConnection(plexResource({ name: 'A', machineId: 'mach1', accessToken: 'acct1', connections: [conn(dead, { local: true }), conn(live.url)] }), { timeoutMs: 1000 });
  assert.deepEqual(a, { url: live.url, relay: false });
  const b = await chooseConnection(plexResource({ name: 'B', machineId: 'mach1', accessToken: 'acct1', connections: [conn(live.url, { relay: true }), conn(dead, { local: true })] }), { timeoutMs: 1000 });
  assert.deepEqual(b, { url: live.url, relay: true }, 'the relay last, but taken when it is the only one');
  const order = [];
  const c = await chooseConnection(plexResource({ name: 'C', machineId: 'mach1', accessToken: 'shared1', connections: [conn(other.url), conn(dead, { local: true })] }), { timeoutMs: 1000, onTry: (u) => order.push(u) });
  assert.equal(c, null);
  assert.deepEqual(order, [dead, other.url], 'local first');
  assert.deepEqual(chooseConnection.lastTried, [dead, other.url]);
});

test('plexClientId is made once and kept', () => {
  const s = settingsStub();
  const a = plexClientId(s);
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(plexClientId(s), a);
  assert.equal(s.get('plexClientId'), a);
  assert.equal(plexHeaders({ clientId: a, version: '1', token: 't' })['X-Plex-Token'], 't');
});

test('plex.tv down is a 502 "Couldn\'t reach plex.tv"; a 401 is a 400', async () => {
  tv.state.down = true;
  await assert.rejects(tvApi.createPin(), (e) => e.status === 502 && /Couldn't reach plex\.tv/.test(e.message));
  tv.state.down = false;
  await assert.rejects(tvApi.resources('wrong'), (e) => e.status === 400);
  const gone = new PlexTv({ base: dead, settings, version: '0.12.0', serverName: () => 'x' });
  await assert.rejects(gone.createPin(), (e) => e.status === 502 && /Couldn't reach plex\.tv/.test(e.message));
});
