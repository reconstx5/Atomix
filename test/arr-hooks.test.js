// Download apps (v0.28): Sonarr, Radarr and Lidarr tell Atomix when a download lands, and Atomix scans the library
// holding it at once. The webhook address carries a key an admin copies from Settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { arrPaths, librariesFor } from '../src/api/hooks.js';

let nf, admin, media;
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  media = tempDir();
  fs.mkdirSync(path.join(media, 'TV'), { recursive: true });
  makeVideo(path.join(media, 'Movies', 'First Film (2020)', 'First Film (2020).mp4'), { seconds: 2 });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] });
  await waitForScan(admin);
});
after(async () => nf?.app.stop());

test('the folders a Sonarr, Radarr or Lidarr message names', () => {
  assert.deepEqual(arrPaths({ eventType: 'Download', series: { path: '/tv/Bay Show' }, episodeFile: { path: '/tv/Bay Show/Season 01/x.mkv' } }), ['/tv/Bay Show', '/tv/Bay Show/Season 01']);
  assert.deepEqual(arrPaths({ eventType: 'Download', movie: { folderPath: '/films/Heat (1995)' }, movieFile: { path: '/films/Heat (1995)/Heat.mkv' } }), ['/films/Heat (1995)']);
  assert.deepEqual(arrPaths({ eventType: 'AlbumDownload', artist: { path: '/music/Lorde' } }), ['/music/Lorde']);
  assert.deepEqual(arrPaths({ eventType: 'Test' }), []);
});

test('which libraries a path belongs to (Windows and Linux separators, any case on Windows paths)', () => {
  const libs = [
    { id: 1, type: 'movies', paths: ['D:\\Media\\Movies'] },
    { id: 2, type: 'tv', paths: ['/srv/tv'] },
  ];
  assert.deepEqual(librariesFor(['d:/media/movies/Heat (1995)'], libs, 'movie'), [1]);
  assert.deepEqual(librariesFor(['/srv/tv/Bay Show'], libs, 'series'), [2]);
  assert.deepEqual(librariesFor(['/srv/tvshows/Bay Show'], libs, 'series'), [2], 'not under a root: the libraries of that kind');
  assert.deepEqual(librariesFor(['/elsewhere'], libs, 'other'), []);
});

test('a webhook with the right key scans the library at once; a wrong key is refused', { skip }, async () => {
  const k = await admin.get('/api/admin/arr');
  assert.equal(k.status, 200);
  assert.match(k.data.key, /^[A-Za-z0-9_-]{24,}$/);
  const bare = (key, body) => fetch(`${nf.base}/api/hooks/arr?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await bare('wrong', { eventType: 'Test' })).status, 401);
  const t = await bare(k.data.key, { eventType: 'Test' });
  assert.equal(t.status, 200, 'Sonarr\'s Test button works');
  makeVideo(path.join(media, 'TV', 'Bay Show', 'Season 01', 'Bay Show - S01E01.mp4'), { seconds: 2 });
  const r = await bare(k.data.key, { eventType: 'Download', series: { path: path.join(media, 'TV', 'Bay Show') }, episodeFile: { path: path.join(media, 'TV', 'Bay Show', 'Season 01', 'Bay Show - S01E01.mp4') } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).libraries, ['TV']);
  await waitForScan(admin);
  const shows = (await admin.get('/api/libraries/2/items')).data.items;
  assert.ok(shows.some((s) => s.title === 'Bay Show'), 'the new show is in the library');
  const again = await admin.post('/api/admin/arr/key', {});
  assert.notEqual(again.data.key, k.data.key, 'a new key');
  assert.equal((await bare(k.data.key, { eventType: 'Test' })).status, 401, 'the old key stops working');
});

test('the key is never in the settings an admin page reads, and can\'t be set through them', { skip }, async () => {
  const s = (await admin.get('/api/admin/settings')).data;
  assert.equal(JSON.stringify(s).includes((await admin.get('/api/admin/arr')).data.key), false);
  await admin.put('/api/admin/settings', { arrKey: 'chosen-by-hand-1234567890' });
  const bare = await fetch(`${nf.base}/api/hooks/arr?key=chosen-by-hand-1234567890`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"eventType":"Test"}' });
  assert.equal(bare.status, 401);
});

test('the request address: an http(s) address or nothing; signed-in grown-ups see it in the status', { skip }, async () => {
  assert.equal((await admin.put('/api/admin/settings', { requestUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { requestUrl: 'http://192.168.1.20:5055/' })).status, 200);
  assert.equal((await admin.get('/api/status')).data.requestUrl, 'http://192.168.1.20:5055');
  assert.equal((await admin.put('/api/admin/settings', { requestUrl: '' })).status, 200);
  assert.equal((await admin.get('/api/status')).data.requestUrl, null);
});
