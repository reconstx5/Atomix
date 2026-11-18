// Atomix's Jellyfin API: pictures (and, in later tasks, playback and streams) for Infuse. The viewer's rules hold
// here too: a Kids profile gets 404 for a grown-up title's picture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { jf, signIn } from './helpers-jellyfin-api.js';
import { toGuid } from '../src/jellyfin/ids.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let me;
let kid;
let token;
let kidToken;
const ids = {};
const g = {};

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const m = path.join(media, 'Movies');
  makeVideo(path.join(m, 'Alpha (2001)', 'Alpha (2001).mp4'));
  makeVideo(path.join(m, 'Gamma (2003)', 'Gamma (2003).mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  await waitForScan(admin);
  const db = nf.app.core.db;
  ids.alpha = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Alpha'").id;
  ids.gamma = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Gamma'").id;
  db.run("UPDATE items SET certification = 'R16', min_age = 16 WHERE id = ?", ids.gamma);
  db.run("UPDATE items SET certification = 'G', min_age = 0 WHERE id = ?", ids.alpha);
  for (const [k, id] of [['alpha', ids.alpha], ['gamma', ids.gamma]]) {
    // A kept copy (cache:), as downloaded artwork is: its tagged address is cached for a year (a folder's file: is not).
    makeImage(path.join(nf.app.core.images.dir, `${k}-poster.jpg`), 'red', '600x900');
    db.run('UPDATE items SET poster = ? WHERE id = ?', `cache:${k}-poster.jpg`, id);
    g[k] = toGuid('item', id);
  }
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  const secretFor = async (profileId, name) => {
    const c = client(nf.base);
    await c.post('/api/auth/login', { username: 'dallas', password: 'password123' });
    await c.post(`/api/profiles/${profileId}/select`, {});
    return (await c.post('/api/me/app-passwords', { name })).data.secret;
  };
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Infuse' })).data.secret;
  token = (await signIn(nf.base, 'dallas', secret)).token;
  me = jf(nf.base, { token });
  kidToken = (await signIn(nf.base, 'dallas', await secretFor(mia.id, 'Infuse iPad'), { deviceId: 'kid-dev' })).token;
  kid = jf(nf.base, { token: kidToken, deviceId: 'kid-dev' });
});

after(async () => {
  await nf?.app.stop();
});

test('a poster is sent, resized', { skip }, async () => {
  const r = await me.raw(`/Items/${g.alpha}/Images/Primary?maxWidth=200`, { headers: { Authorization: `MediaBrowser Token="${token}"` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\//);
  assert.ok((await r.arrayBuffer()).byteLength > 0);
  const idx = await me.raw(`/Items/${g.alpha}/Images/primary/0?fillWidth=100&tag=abc`, { headers: { Authorization: `MediaBrowser Token="${token}"` } });
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('cache-control'), /max-age=31536000/);
  const head = await me.raw(`/Items/${g.alpha}/Images/Primary`, { method: 'HEAD', headers: { Authorization: `MediaBrowser Token="${token}"` } });
  assert.equal(head.status, 200);
});

test('a missing logo is 404', { skip }, async () => {
  const hdr = { headers: { Authorization: `MediaBrowser Token="${token}"` } };
  assert.equal((await me.raw(`/Items/${g.alpha}/Images/Logo`, hdr)).status, 404);
  assert.equal((await me.raw(`/Items/${g.alpha}/Images/Banner`, hdr)).status, 404, 'a type we do not have');
  assert.equal((await me.raw(`/Items/${toGuid('item', 99999)}/Images/Primary`, hdr)).status, 404, 'an unknown title');
});

test("a Kids token gets 404 for a grown-up poster", { skip }, async () => {
  const hdr = { headers: { Authorization: `MediaBrowser Token="${kidToken}"` } };
  assert.equal((await kid.raw(`/Items/${g.alpha}/Images/Primary`, hdr)).status, 200);
  assert.equal((await kid.raw(`/Items/${g.gamma}/Images/Primary`, hdr)).status, 404);
  assert.equal((await me.raw(`/Items/${g.gamma}/Images/Primary`, { headers: { Authorization: `MediaBrowser Token="${token}"` } })).status, 200);
});

test('api_key works for images', { skip }, async () => {
  const r = await me.raw(`/Items/${g.alpha}/Images/Primary?api_key=${token}&maxWidth=120`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\//);
  assert.equal((await me.raw(`/Items/${g.alpha}/Images/Primary`)).status, 401, 'no token at all');
});
