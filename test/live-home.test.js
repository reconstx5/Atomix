// Home's "On now" row (GET /api/home): what's on the viewer's channels, favourites first, nothing for a Kids profile
// without ticked groups, and no provider address in it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, fakeServer } from './helpers.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
let nf, admin, kid, kidId, upstream, ids;

before(async () => {
  upstream = await fakeServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = upstream.url;
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  await nf?.app.stop();
  await upstream?.close();
});

const onNow = async (c) => (await c.get('/api/home')).data.rows.find((r) => r.id === 'live-now');

test('"On now" lists the channels with what\'s on, as landscape live cards', async () => {
  const home = (await admin.get('/api/home')).data;
  const row = home.rows.find((r) => r.id === 'live-now');
  assert.ok(row, JSON.stringify(home.rows.map((r) => r.id)));
  assert.equal(row.title, 'On now');
  assert.equal(row.style, 'landscape');
  assert.equal(home.rows.findIndex((r) => r.id === 'live-now'), home.rows.findIndex((r) => r.id === 'continue') + 1, 'right after Continue watching (or first)');
  assert.deepEqual(row.items.map((c) => c.channelId), [ids.One, ids.Two, ids.Three, ids['Radio Waves']]);
  const one = row.items[0];
  assert.equal(one.kind, 'live');
  assert.equal(one.id, `live:${ids.One}`);
  assert.equal(one.title, 'One 0');
  assert.equal(one.subtitle, 'One');
  assert.match(one.image, /^\/api\/live\/(programmes\/\d+\/image|channels\/\d+\/logo)$/);
  assert.ok(one.progress >= 0 && one.progress <= 1);
  assert.equal(one.radio, false);
  assert.equal(row.items[3].radio, true);
  const text = JSON.stringify(row);
  assert.ok(!text.includes(upstream.url) && !text.includes('secretpw'), 'no provider address');
});

test('with favourites, the row is the favourites in their order', async () => {
  await admin.put('/api/live/favourites', { channelIds: [ids.Three, ids.One] });
  assert.deepEqual((await onNow(admin)).items.map((c) => c.channelId), [ids.Three, ids.One]);
  await admin.put('/api/live/favourites', { channelIds: [] });
});

test('a Kids profile sees no row without ticked groups, and only its groups\' channels with them', async () => {
  assert.equal(await onNow(kid), undefined);
  await admin.put(`/api/profiles/${kidId}/live-groups`, [{ source: KEY, group: 'Kids' }]);
  assert.deepEqual((await onNow(kid)).items.map((c) => c.channelId), [ids.Two]);
  await admin.put(`/api/profiles/${kidId}/live-groups`, []);
});

test('no row when Live TV has no channels for anyone', async () => {
  const before = await onNow(admin);
  assert.ok(before);
  nf.app.core.db.run('UPDATE live_channels SET hidden = 1');
  try {
    assert.equal(await onNow(admin), undefined);
  } finally {
    nf.app.core.db.run('UPDATE live_channels SET hidden = 0');
  }
});
