// Several key systems per channel and provider-app links in the channels API (v0.28).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, fakeServer } from './helpers.js';
import { providerLink } from '../src/live/applinks.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
let nf, admin, kid, upstream, ids;

before(async () => {
  upstream = await fakeServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = upstream.url;
  process.env.LIVE_TEST_MULTI = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  const kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  await admin.put(`/api/profiles/${kidId}/live-groups`, [{ source: KEY, group: 'Kids' }, { source: KEY, group: 'Movies' }]);
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_MULTI;
  await nf?.app.stop();
  await upstream?.close();
});

const byName = async (c, name) => (await c.get('/api/live/channels')).data.find((x) => x.name === name);

test('drm is a list of systems, null for a plain channel', async () => {
  assert.deepEqual((await byName(admin, 'Both')).drm, ['widevine', 'playready']);
  assert.deepEqual((await byName(admin, 'Solo')).drm, ['widevine']);
  assert.deepEqual((await byName(admin, 'Junk')).drm, ['playready'], 'unknown names and repeats dropped');
  assert.equal((await byName(admin, 'One')).drm, null);
});

test('the playlist\'s link, and the built-in TVNZ+ link by name', async () => {
  const both = await byName(admin, 'Both');
  assert.deepEqual([both.appUrl, both.appName], ['https://provider.example/app', 'Provider']);
  const tv = await byName(admin, 'TVNZ 2');
  assert.deepEqual([tv.appUrl, tv.appName], ['https://www.tvnz.co.nz', 'TVNZ+']);
  const one = await byName(admin, 'One');
  assert.deepEqual([one.appUrl, one.appName], [null, null]);
});

test('providerLink precedence and the built-in names', () => {
  for (const n of ['TVNZ 1', 'tvnz1', 'TVNZ 2', 'TVNZ2', 'DUKE', 'TVNZ DUKE', 'tvnz duke']) assert.deepEqual(providerLink({ name: n }), { url: 'https://www.tvnz.co.nz', name: 'TVNZ+' }, n);
  assert.equal(providerLink({ name: 'TVNZ 3' }), null);
  assert.equal(providerLink({ name: 'One' }), null);
  assert.deepEqual(providerLink({ name: 'TVNZ 1', appUrl: 'https://a.example', appName: 'A' }), { url: 'https://a.example', name: 'A' });
  assert.deepEqual(providerLink({ name: 'One', appUrl: 'https://a.example', adminAppUrl: 'https://b.example', adminAppName: 'B' }), { url: 'https://b.example', name: 'B' }, 'admin wins');
  assert.deepEqual(providerLink({ name: 'One', appUrl: 'https://a.example', appName: null }), { url: 'https://a.example', name: 'the provider\'s app' });
  assert.equal(providerLink({ name: 'One', appUrl: 'http://a.example', appName: 'A' }), null, 'https only');
});

test('admin sets, replaces and clears a link; it survives a refresh', async () => {
  const id = ids.Both;
  const put = (b) => admin.put(`/api/live/channels/${id}/app-link`, b);
  assert.equal((await put({ url: 'http://x' })).status, 400);
  assert.equal((await put({ url: 'javascript:alert(1)', name: 'X' })).status, 400);
  assert.equal((await kid.put(`/api/live/channels/${id}/app-link`, { url: 'https://y', name: 'Y' })).status, 403);
  const r = await put({ url: 'https://y.example', name: 'Y' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.appUrl, r.data.appName], ['https://y.example', 'Y']);
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  const after = await byName(admin, 'Both');
  assert.deepEqual([after.appUrl, after.appName], ['https://y.example', 'Y'], 'kept after a refresh');
  const cleared = await put({});
  assert.equal(cleared.status, 200);
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  const back = await byName(admin, 'Both');
  assert.deepEqual([back.appUrl, back.appName], ['https://provider.example/app', 'Provider'], 'back to the playlist link');
});

test('clearing an admin link shows the playlist link at once (no refresh); {} on a channel without one changes nothing', async () => {
  const id = ids.Both;
  const put = (b) => admin.put(`/api/live/channels/${id}/app-link`, b);
  const link = async () => {
    const c = await byName(admin, 'Both');
    return [c.appUrl, c.appName];
  };
  assert.equal((await put({})).status, 200);
  assert.deepEqual(await link(), ['https://provider.example/app', 'Provider'], 'no admin link: {} leaves the playlist link');
  await put({ url: 'https://y.example', name: 'Y' });
  assert.deepEqual(await link(), ['https://y.example', 'Y']);
  await put({});
  assert.deepEqual(await link(), ['https://provider.example/app', 'Provider'], 'straight after the clear');
  const tv = ids['TVNZ 2'];
  await admin.put(`/api/live/channels/${tv}/app-link`, { url: 'https://z.example', name: 'Z' });
  await admin.put(`/api/live/channels/${tv}/app-link`, {});
  const t = await byName(admin, 'TVNZ 2');
  assert.deepEqual([t.appUrl, t.appName], ['https://www.tvnz.co.nz', 'TVNZ+'], 'back to the built-in link');
});

test('Kids profiles get no link anywhere', async () => {
  const tv = await byName(kid, 'TVNZ DUKE');
  assert.ok(tv, 'visible to Kids');
  assert.deepEqual([tv.appUrl, tv.appName], [null, null]);
  assert.deepEqual(tv.drm, ['widevine']);
  const search = (await kid.get('/api/live/search?q=duke')).data.channels;
  assert.deepEqual([search[0].appUrl, search[0].appName], [null, null]);
});

test('the On now card carries drm and the link', async () => {
  const row = (await admin.get('/api/home')).data.rows.find((r) => r.id === 'live-now');
  const solo = row.items.find((c) => c.subtitle === 'TVNZ 2');
  assert.deepEqual([solo.drm, solo.appUrl, solo.appName], [['widevine'], 'https://www.tvnz.co.nz', 'TVNZ+']);
  await admin.put('/api/live/favourites', { channelIds: [ids.Both, ids.One] });
  const fav = (await admin.get('/api/home')).data.rows.find((r) => r.id === 'live-now').items;
  assert.deepEqual(fav[0].drm, ['widevine', 'playready']);
  assert.equal(fav[0].appName, 'Provider');
  assert.equal(fav[1].drm, null);
  assert.equal(fav[1].appUrl, null);
  const kidRow = (await kid.get('/api/home')).data.rows.find((r) => r.id === 'live-now');
  for (const c of kidRow?.items || []) assert.deepEqual([c.appUrl, c.appName], [null, null]);
});

test('admins see whether a channel\'s link is their own (appLinkAdmin); nobody else gets the field', async () => {
  const id = ids.Both;
  const put = (b) => admin.put(`/api/live/channels/${id}/app-link`, b);
  await put({});
  assert.equal((await byName(admin, 'Both')).appLinkAdmin, false, 'the playlist\'s link');
  assert.equal((await byName(admin, 'TVNZ 2')).appLinkAdmin, false, 'the built-in link');
  const r = await put({ url: 'https://y.example', name: 'Y' });
  assert.equal(r.data.appLinkAdmin, true, 'in the reply to a save');
  assert.equal((await byName(admin, 'Both')).appLinkAdmin, true);
  assert.equal((await put({})).data.appLinkAdmin, false);
  assert.equal('appLinkAdmin' in (await byName(kid, 'Both')), false, 'a Kids profile');
  // A viewer who isn't an admin.
  await admin.post('/api/users', { username: 'sam', password: 'password123', role: 'user' });
  const sam = client(nf.base);
  await sam.post('/api/auth/login', { username: 'sam', password: 'password123' });
  const samProfile = (await sam.get('/api/profiles')).data[0]?.id;
  if (samProfile) await sam.post(`/api/profiles/${samProfile}/select`, {});
  await admin.put(`/api/live/channels/${id}/app-link`, { url: 'https://y.example', name: 'Y' });
  const seen = await byName(sam, 'Both');
  assert.ok(seen, 'sam sees the channel');
  assert.equal('appLinkAdmin' in seen, false, 'not an admin');
  await put({});
});
