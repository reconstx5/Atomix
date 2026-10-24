// v0.15.0: picks that scan less and forget less, static caching that means it, kids/admin data stays put,
// private addresses refused for servers and TVs, settings enums checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf, admin, kid, guest, film, collectionId;

before(async () => {
  if (!hasFfmpeg) return;
  const dir = tempDir();
  makeVideo(path.join(dir, 'Alien (1979).mp4'), { seconds: 2 });
  makeVideo(path.join(dir, 'Aliens (1986).mp4'), { seconds: 2 });
  nf = await startAtomix();
  await nf.app.core.tasks.stop();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.put('/api/admin/settings', { previewsEnabled: false, introDetection: false });
  const lib = (await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [dir] })).data;
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const items = (await admin.get(`/api/libraries/${lib.id}/items`)).data.items;
  film = items[0];
  // An adult-rated collection a kid can't see.
  nf.app.core.db.run("UPDATE items SET min_age = 18, certification = 'R18' WHERE id IN (?, ?)", items[0].id, items[1].id);
  collectionId = (await admin.post('/api/collections', { name: 'Alien films', itemIds: items.map((i) => i.id) })).data.id;
  const posterFile = path.join(nf.app.core.images.dir, 'passover-poster.png');
  fs.mkdirSync(path.dirname(posterFile), { recursive: true });
  fs.writeFileSync(posterFile, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e0a3c73b0000000049454e44ae426082', 'hex'));
  nf.app.core.db.run('UPDATE collections SET poster = ? WHERE id = ?', 'cache:passover-poster.png', collectionId);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
});

after(async () => { await nf?.app.stop(); });

test('picks candidates select only the scoring columns', { skip }, () => {
  const picks = nf.app.core.picks;
  const sqls = [];
  const orig = picks.db.all.bind(picks.db);
  picks.db.all = (sql, ...a) => { sqls.push(sql); return orig(sql, ...a); };
  try {
    picks.clear();
    picks.similar(film.id, { profileId: null, kids: false, maxAge: null, allowUnrated: true, libraryIds: null });
  } finally {
    picks.db.all = orig;
  }
  const cand = sqls.find((q) => /FROM items i WHERE i.kind IN \('movie', 'show'\)/.test(q));
  assert.ok(cand, 'the candidates query ran');
  assert.doesNotMatch(cand, /i\.\*/, 'no SELECT i.*');
  assert.doesNotMatch(cand, /overview|media\b/, 'no heavy columns');
});

test('a playlist change does not clear the picks cache; a scan does', { skip }, async () => {
  const picks = nf.app.core.picks;
  picks.clear();
  picks.similar(film.id, { profileId: null, kids: false, maxAge: null, allowUnrated: true, libraryIds: null });
  assert.ok(picks.cache.size > 0);
  const list = (await admin.post('/api/lists', { kind: 'video', name: 'Friday' })).data;
  await admin.post(`/api/lists/${list.id}/items`, { itemId: film.id });
  assert.ok(picks.cache.size > 0, 'still cached after a playlist change');
  await nf.app.core.hooks.emit('scan:complete', { library: { id: 1 }, added: 0, removed: 0, firstScan: false });
  assert.equal(picks.cache.size, 0, 'a scan clears it');
});

test('the page and its scripts revalidate every load (no stale modules after an update); pictures are cached', { skip }, async () => {
  const page = await admin.raw('/index.html');
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const js = await admin.raw('/js/app.js');
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  assert.ok(js.headers.get('etag'));
  const again = await admin.raw('/js/app.js', { headers: { 'if-none-match': js.headers.get('etag') } });
  assert.equal(again.status, 304);
  const img = await admin.raw('/img/favicon.svg');
  assert.match(img.headers.get('cache-control'), /^public, max-age=\d+/);
});

test('/api/status omits the server list for a kids profile on an admin account', { skip }, async () => {
  assert.ok(Array.isArray((await admin.get('/api/status')).data.servers), 'the admin sees it');
  assert.equal((await kid.get('/api/status')).data.servers, undefined);
});

test('/api/scan/status is a stub for viewers', { skip }, async () => {
  const full = (await admin.get('/api/scan/status')).data;
  assert.ok('phase' in full);
  const stub = (await guest.get('/api/scan/status')).data;
  assert.deepEqual(Object.keys(stub), ['running']);
});

test('a missing title, library and collection each answer 404 with the plain-words sentence', { skip }, async () => {
  const missing = async (path) => { const r = await admin.raw(path); return [r.status, (await r.json()).error]; };
  assert.deepEqual(await missing('/api/items/99999'), [404, 'This title no longer exists.']);
  assert.deepEqual(await missing('/api/libraries/99999/items'), [404, 'This library no longer exists.']);
  assert.deepEqual(await missing('/api/collections/99999'), [404, 'This collection no longer exists.']);
});

test('a kid cannot fetch the poster of a collection they cannot see', { skip }, async () => {
  assert.equal((await kid.raw(`/api/collections/${collectionId}/image/poster`)).status, 404);
  assert.notEqual((await admin.raw(`/api/collections/${collectionId}/image/poster`)).status, 404);
});

test('adding a server or DLNA device at a private or loopback address is refused', { skip }, async () => {
  // Loopback stays allowed (a Jellyfin on this machine is a normal setup); link-local and the unspecified address are not.
  for (const url of ['http://169.254.169.254/', 'http://[fe80::1]:8096', 'http://0.0.0.0:8096']) {
    const r = await admin.post('/api/servers', { kind: 'jellyfin', url, username: 'a', password: 'b' });
    assert.equal(r.status, 400, url);
    assert.equal(r.data.error, 'That address points at this server or a private network.', url);
  }
  const d = await admin.post('/api/cast/devices', { kind: 'dlna', address: 'http://169.254.10.10/desc.xml' });
  assert.equal(d.status, 400);
  assert.equal(d.data.error, 'That address points at this server or a private network.');
});

test('settings reject an unknown hwAccel, x264Preset, a relative vaapiDevice or an odd maxSoftwareHeight', { skip }, async () => {
  assert.equal((await admin.put('/api/admin/settings', { hwAccel: 'cuda' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { x264Preset: 'turbo' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { vaapiDevice: 'renderD128' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { maxSoftwareHeight: 999 })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { hwAccel: 'nvenc', x264Preset: 'fast', vaapiDevice: '/dev/dri/renderD129', maxSoftwareHeight: 720 })).status, 200);
  const s = (await admin.get('/api/admin/settings')).data;
  assert.equal(s.maxSoftwareHeight, 720);
  await admin.put('/api/admin/settings', { hwAccel: 'none', x264Preset: 'veryfast', maxSoftwareHeight: 1080 });
});
