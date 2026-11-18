// Atomix's Jellyfin API: pictures, PlaybackInfo, the stream (direct play with ranges, a connected server's title
// passed through) and progress reports for Infuse. The viewer's rules hold here too: a Kids profile gets 404 for a
// grown-up title's picture, stream and progress.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { jf, signIn } from './helpers-jellyfin-api.js';
import { fakeJellyfin, jfMovie } from './helpers-jellyfin.js';
import { toGuid } from '../src/jellyfin/ids.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let me;
let kid;
let token;
let kidToken;
let far;
let farFile;
const files = {};
const ids = {};
const g = {};

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const m = path.join(media, 'Movies');
  makeVideo(path.join(m, 'Alpha (2001)', 'Alpha (2001).mp4'));
  makeVideo(path.join(m, 'Gamma (2003)', 'Gamma (2003).mp4'));
  files.alpha = path.join(m, 'Alpha (2001)', 'Alpha (2001).mp4');
  files.delta = path.join(m, 'Delta (2004)', 'Delta (2004).mp4');
  makeVideo(files.delta);
  // A connected Jellyfin server (made up) with one film; its address and token 'tok1' must never reach Infuse.
  farFile = path.join(media, 'far.mp4');
  makeVideo(farFile, { seconds: 2 });
  far = await fakeJellyfin({ streamFile: farFile, movies: [jfMovie('m1', 'Far Film', { MediaSources: [{ Container: 'mp4', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 160, Height: 90, Index: 0 }] }] })] });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  await waitForScan(admin);
  const db = nf.app.core.db;
  ids.alpha = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Alpha'").id;
  ids.gamma = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Gamma'").id;
  ids.delta = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Delta'").id;
  db.run('UPDATE items SET duration = 600 WHERE id IN (?, ?)', ids.alpha, ids.gamma); // room for a 60 s position
  const now = Date.now();
  const server = Number(db.run("INSERT INTO servers (kind, name, url, username, secret, remote_user_id, created_at) VALUES ('jellyfin', 'Far Jellyfin', ?, 'dallas', 'tok1', 'u1', ?)", far.url, now).lastInsertRowid);
  db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('Movies (Far Jellyfin)', 'movies', '[]', '{}', ?, ?, 'lib-m')", now, server);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  ids.far = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Far Film'").id;
  g.far = toGuid('item', ids.far);
  g.delta = toGuid('item', ids.delta);
  ids.profile = db.get('SELECT id FROM profiles WHERE kids = 0 ORDER BY id').id;
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
  far?.close();
});

const auth = (t) => ({ Authorization: `MediaBrowser Token="${t}"` });

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

test('PlaybackInfo offers direct play only', { skip }, async () => {
  for (const method of ['get', 'post']) {
    const r = await me[method](`/Items/${g.alpha}/PlaybackInfo`);
    assert.equal(r.status, 200, method);
    assert.equal(r.body.MediaSources.length, 1);
    const src = r.body.MediaSources[0];
    assert.equal(src.SupportsDirectPlay, true);
    assert.equal(src.SupportsTranscoding, false);
    assert.match(r.body.PlaySessionId, /^[0-9a-f]{32}$/);
    assert.equal(src.Path, undefined);
    assert.ok(!r.text.includes(JSON.stringify(path.dirname(files.alpha)).slice(1, -1)), 'no real folder in the answer');
    assert.ok(!r.text.includes('Alpha (2001).mp4'), 'no file name in the answer');
  }
  assert.equal(nf.app.core.jellyfin.sessions.list().length, 0, 'PlaybackInfo takes no slot');
});

test('the stream sends the original with ranges', { skip }, async () => {
  const bytes = fs.readFileSync(files.alpha);
  const r = await me.raw(`/Videos/${g.alpha}/stream?static=true`, { headers: { ...auth(token), Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(got.length, 100);
  assert.ok(got.equals(bytes.subarray(0, 100)));
  const ext = await me.raw(`/Videos/${g.alpha}/stream.mp4?static=true&api_key=${token}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(ext.status, 206);
  assert.ok(Buffer.from(await ext.arrayBuffer()).equals(bytes.subarray(100, 200)));
  await me.post('/Sessions/Playing/Stopped', { ItemId: g.alpha });
  const head = await me.raw(`/Videos/${g.alpha}/stream`, { method: 'HEAD', headers: auth(token) });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), bytes.length);
  assert.equal(nf.app.core.jellyfin.sessions.list().length, 0, 'a HEAD opens no session');
});

test('a missing file is 404', { skip }, async () => {
  // Windows: a background job after the scan (ffmpeg reading the file) may hold it open for a while.
  for (let tries = 0; ; tries++) {
    try {
      fs.rmSync(files.delta);
      break;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      if (tries > 300) throw err;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  const r = await me.raw(`/Videos/${g.delta}/stream`, { headers: auth(token) });
  assert.equal(r.status, 404);
  assert.equal(nf.app.core.jellyfin.sessions.list().length, 0, 'a missing file takes no slot');
});

test('progress lands in Atomix', { skip }, async () => {
  const p = await me.post('/Sessions/Playing/Progress', { ItemId: g.alpha, PositionTicks: 600_000_000, IsPaused: false, PlaySessionId: 'x' });
  assert.equal(p.status, 204);
  let web = (await admin.get(`/api/items/${ids.alpha}`)).data.item;
  assert.equal(web.progress.position, 60);
  assert.equal(web.progress.watched, false);
  // The older form, with the position in the query.
  const older = await me.post(`/Users/${toGuid('user', ids.profile)}/PlayingItems/${g.alpha}/Progress`, {}, { PositionTicks: 900_000_000 });
  assert.equal(older.status, 204);
  web = (await admin.get(`/api/items/${ids.alpha}`)).data.item;
  assert.equal(web.progress.position, 90);
  const s = await me.post('/Sessions/Playing/Stopped', { ItemId: g.alpha, PositionTicks: 590 * 10_000_000 });
  assert.equal(s.status, 204);
  web = (await admin.get(`/api/items/${ids.alpha}`)).data.item;
  assert.equal(web.progress.watched, true);
});

test('connected-server title passes through and leaks nothing', { skip }, async () => {
  const port = `:${new URL(far.url).port}`;
  const clean = (text, what) => {
    assert.ok(!text.includes(port), `${what} carries the far port`);
    assert.ok(!text.includes('tok1'), `${what} carries the far token`);
  };
  const item = await me.get(`/Items/${g.far}`);
  assert.equal(item.status, 200);
  clean(item.text, 'item JSON');
  const info = await me.post(`/Items/${g.far}/PlaybackInfo`);
  assert.equal(info.status, 200);
  assert.equal(info.body.MediaSources[0].SupportsDirectPlay, true);
  clean(info.text, 'PlaybackInfo');
  const r = await me.raw(`/Videos/${g.far}/stream?static=true`, { headers: auth(token) });
  assert.equal(r.status, 200);
  clean(JSON.stringify([...r.headers]), 'stream headers');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(farFile)));
  const ranged = await me.raw(`/Videos/${g.far}/stream`, { headers: { ...auth(token), Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(fs.readFileSync(farFile).subarray(0, 10)));
  await me.post('/Sessions/Playing/Stopped', { ItemId: g.far });
});

test("a Kids token can't stream or report a grown-up title", { skip }, async () => {
  const progressOf = () => nf.app.core.db.all('SELECT profile_id, position, watched FROM progress WHERE item_id = ?', ids.gamma);
  const was = progressOf();
  assert.equal((await kid.raw(`/Videos/${g.gamma}/stream`, { headers: { ...auth(kidToken), Range: 'bytes=0-99' } })).status, 404);
  assert.equal((await kid.post(`/Items/${g.gamma}/PlaybackInfo`)).status, 404);
  assert.equal((await kid.post('/Sessions/Playing/Progress', { ItemId: g.gamma, PositionTicks: 600_000_000 })).status, 404);
  assert.equal((await kid.post('/Sessions/Playing/Stopped', { ItemId: g.gamma, PositionTicks: 5_900_000_000 })).status, 404);
  assert.deepEqual(progressOf(), was, "the R16 film's progress is unchanged");
  assert.equal(nf.app.core.jellyfin.sessions.list().length, 0, 'no slot taken');
});
