// Clear logos (the transparent title artwork Kodi skins show instead of plain text):
// from a clearlogo.png next to the media, or from TMDB. Written before the feature existed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, makeImage, startAtomix, client, waitForScan, fakeServer } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const png = path.join(tempDir(), 'logo.png');
let nf;
let tmdb;
let admin;
const ids = {};
const requests = [];

before(async () => {
  if (!hasFfmpeg) return;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white@0.0:s=400x155,format=rgba', '-frames:v', '1', png]);
  const m = path.join(media, 'Movies');
  // A movie with its own clear logo in the folder
  makeVideo(path.join(m, 'Local Logo (2020)', 'Local Logo (2020).mp4'));
  fs.copyFileSync(png, path.join(m, 'Local Logo (2020)', 'clearlogo.png'));
  // A movie whose logo comes from TMDB
  makeVideo(path.join(m, 'Online Logo (2021)', 'Online Logo (2021).mp4'));
  const t = path.join(media, 'TV');
  makeVideo(path.join(t, 'Logo Show', 'Season 01', 'Logo.Show.S01E01.mp4'));
  makeImage(path.join(t, 'Logo Show', 'fanart.jpg'), 'navy', '320x180');
  fs.copyFileSync(png, path.join(t, 'Logo Show', 'logo.png'));

  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname.startsWith('/t/p/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(fs.readFileSync(png));
    }
    if (u.pathname === '/3/search/movie') return send({ results: /online/i.test(u.searchParams.get('query')) ? [{ id: 77, title: 'Online Logo' }] : [] });
    if (u.pathname === '/3/movie/77') {
      return send({
        id: 77,
        title: 'Online Logo',
        release_date: '2021-01-01',
        images: {
          logos: [
            { file_path: '/fr.png', iso_639_1: 'fr', vote_average: 9 },
            { file_path: '/none.png', iso_639_1: null, vote_average: 8 },
            { file_path: '/en-low.png', iso_639_1: 'en', vote_average: 2 },
            { file_path: '/en-best.png', iso_639_1: 'en', vote_average: 5.5 },
          ],
        },
      });
    }
    return send({ results: [] });
  });

  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, ATOMIX_TMDB_IMAGE_BASE: `${tmdb.url}/t/p`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title] = it;
  for (const it of (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items) ids[it.title] = it;
});

after(async () => {
  await nf?.app.stop();
  await tmdb?.close();
});

test('a clearlogo.png next to a movie is used', { skip }, async () => {
  const movie = ids['Local Logo'];
  assert.ok(movie.logo, 'listed items carry a logo URL');
  const img = await admin.raw(movie.logo);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('TMDB logos: the best one in the metadata language wins', { skip }, async () => {
  assert.ok(requests.some((r) => r.startsWith('/3/movie/77') && /append_to_response=[^&]*images/.test(r) && /include_image_language=en(%2C|,)/.test(r)), 'logos are requested with the movie');
  const movie = (await admin.get(`/api/items/${ids['Online Logo'].id}`)).data.item;
  assert.ok(movie.logo);
  assert.equal((await admin.raw(movie.logo)).status, 200);
  assert.ok(requests.includes('/t/p/w500/en-best.png'), 'English logo with the most votes');
});

test('shows use logo.png, and episodes carry their show’s logo', { skip }, async () => {
  const show = (await admin.get(`/api/items/${ids['Logo Show'].id}`)).data;
  assert.ok(show.item.logo);
  // Half-watch the episode so it shows up under "Continue watching".
  const season = (await admin.get(`/api/items/${show.seasons[0].id}`)).data;
  await admin.post(`/api/items/${season.episodes[0].id}/progress`, { position: 60, duration: 600 });
  const home = (await admin.get('/api/home')).data;
  const eps = home.rows.flatMap((r) => r.items).filter((i) => i.kind === 'episode');
  assert.ok(eps.length, 'an episode row on the home screen');
  assert.ok(eps.every((e) => e.showLogo), 'episodes know their show’s logo');
});

test('titles without a logo say so', { skip }, async () => {
  assert.equal((await admin.get(`/api/items/${ids['Logo Show'].id}`)).data.seasons[0].logo ?? null, null);
  assert.equal((await admin.raw(`/api/items/${ids['Logo Show'].id}/image/nonsense`)).status, 404);
});
