// Artwork in Edit details (admins): TMDB's choices (shown through Atomix), an upload checked by its bytes, or an
// address downloaded once. Each choice is stored in the image cache and locks that picture against refreshes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeImage, makeAudio, startAtomix, client, waitForScan, fakeServer } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let tmdb;
let site;
let admin;
const ids = {};
const pngFile = path.join(tempDir(), 'p.png');
let png;

before(async () => {
  if (!hasFfmpeg) return;
  makeImage(pngFile, 'teal', '100x150');
  png = fs.readFileSync(pngFile);
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Pictured (2010)', 'Pictured (2010).mp4'), { seconds: 2 });
  makeAudio(path.join(media, 'Music', 'Band', 'Record', '01 Song.mp3'), { tags: { title: 'Song', artist: 'Band', album: 'Record' } });
  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname.startsWith('/t/p/')) return res.writeHead(200, { 'content-type': 'image/png' }), res.end(png);
    if (u.pathname === '/3/search/movie') return send({ results: [{ id: 301, title: 'Pictured', release_date: '2010-01-01' }] });
    if (u.pathname === '/3/movie/301') return send({ id: 301, title: 'Pictured', release_date: '2010-01-01', poster_path: '/orig.png', backdrop_path: '/origb.png' });
    if (u.pathname === '/3/movie/301/images') {
      return send({
        posters: [
          { file_path: '/p1.png', width: 1000, height: 1500, iso_639_1: 'en', vote_average: 5 },
          { file_path: '/p2.png', width: 2000, height: 3000, iso_639_1: 'fr', vote_average: 4 },
        ],
        backdrops: [{ file_path: '/b1.png', width: 1920, height: 1080, iso_639_1: null }],
        logos: [{ file_path: '/l1.png', width: 800, height: 310, iso_639_1: 'en' }],
      });
    }
    return send({ results: [] });
  });
  site = await fakeServer((req, res) => {
    if (req.url === '/pic.png') return res.writeHead(200, { 'content-type': 'image/png' }), res.end(png);
    if (req.url === '/liar.png') return res.writeHead(200, { 'content-type': 'image/png' }), res.end('<html>a sign-in page, labelled a picture</html>');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not a picture</html>');
  });
  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, ATOMIX_TMDB_IMAGE_BASE: `${tmdb.url}/t/p`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(admin);
  ids.film = (await admin.get(`/api/libraries/${lib}/items`)).data.items[0].id;
  ids.album = nf.app.core.db.get("SELECT id FROM items WHERE kind = 'album'").id;
});
after(async () => {
  await nf?.app.stop();
  await tmdb?.close();
  await site?.close();
});

const row = (id) => nf.app.core.db.get('SELECT * FROM items WHERE id = ?', id);
const cached = () => fs.readdirSync(nf.app.core.config.imagesDir).length;
const upload = (id, type, buf) => admin.raw(`/api/items/${id}/artwork/${type}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });

test('options are listed from TMDB with their sizes, shown through Atomix', { skip }, async () => {
  const r = await admin.get(`/api/items/${ids.film}/artwork`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.poster.length, 2);
  assert.deepEqual(
    r.data.poster.map(({ path: p, width, height, language }) => ({ p, width, height, language })),
    [
      { p: '/p1.png', width: 1000, height: 1500, language: 'en' },
      { p: '/p2.png', width: 2000, height: 3000, language: 'fr' },
    ],
  );
  assert.equal(r.data.poster[0].url, `/api/items/${ids.film}/artwork/preview?path=%2Fp1.png`);
  assert.equal(r.data.backdrop[0].language, null);
  assert.equal(r.data.logo.length, 1);
  assert.ok(!JSON.stringify(r.data).includes(tmdb.url), "TMDB's address isn't sent");
  const pv = await admin.raw(r.data.poster[0].url);
  assert.equal(pv.status, 200);
  assert.equal(pv.headers.get('content-type'), 'image/png');
  assert.equal((await admin.raw(`/api/items/${ids.film}/artwork/preview?path=..%2Fetc`)).status, 400);
  assert.deepEqual((await admin.get(`/api/items/${ids.album}/artwork`)).data, { poster: [], backdrop: [], logo: [] }, 'nothing to pick without TMDB');
});

test('picking a TMDB poster stores it and locks it', { skip }, async () => {
  const r = await admin.put(`/api/items/${ids.film}/artwork/poster`, { tmdbPath: '/p2.png' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(row(ids.film).poster, /^cache:/);
  assert.ok(JSON.parse(row(ids.film).locked_fields).includes('poster'));
  assert.ok(r.data.lockedFields.includes('poster'));
  assert.equal((await admin.raw(r.data.poster)).status, 200);
  assert.equal((await admin.put(`/api/items/${ids.film}/artwork/poster`, { tmdbPath: 'https://evil.example/x.png' })).status, 400);
  assert.equal((await admin.put(`/api/items/${ids.film}/artwork/banner`, { tmdbPath: '/p1.png' })).status, 404);
});

test('uploads are checked by their bytes', { skip }, async () => {
  const backdropBefore = row(ids.film).backdrop;
  let r = await upload(ids.film, 'backdrop', png);
  assert.equal(r.status, 200, await r.text());
  const stored = row(ids.film).backdrop;
  assert.match(stored, /^cache:/);
  assert.notEqual(stored, backdropBefore);
  assert.ok(JSON.parse(row(ids.film).locked_fields).includes('backdrop'));
  const n = cached();
  r = await upload(ids.film, 'logo', Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'Use a JPEG, PNG or WebP picture.');
  r = await upload(ids.film, 'logo', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'Use a JPEG, PNG or WebP picture.');
  r = await upload(ids.film, 'logo', Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)]));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, 'Pictures can be 10 MB at most.');
  assert.equal(cached(), n, 'nothing stored either time');
  assert.equal(row(ids.film).logo, null);
  // Not JSON: a cross-site form can't send it.
  r = await admin.raw(`/api/items/${ids.film}/artwork/logo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: png });
  assert.notEqual(r.status, 200);
});

test('an address is downloaded once; a page that is not a picture is refused', { skip }, async () => {
  let r = await admin.put(`/api/items/${ids.album}/artwork/poster`, { url: `${site.url}/pic.png` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(row(ids.album).poster, /^cache:/);
  r = await admin.put(`/api/items/${ids.album}/artwork/backdrop`, { url: `${site.url}/page` });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "That address isn't a picture.");
  assert.equal(row(ids.album).backdrop, null);
  assert.equal((await admin.put(`/api/items/${ids.album}/artwork/poster`, { url: 'file:///etc/passwd' })).data.error, "That address isn't a picture.");
});

test('a refresh afterwards keeps the chosen poster', { skip }, async () => {
  const chosen = row(ids.film).poster;
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  assert.equal(row(ids.film).poster, chosen);
  await admin.patch(`/api/items/${ids.film}/details`, { unlock: ['poster'] });
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  assert.notEqual(row(ids.film).poster, chosen, 'unlocked, it follows TMDB again');
});

// ---- v0.21 tidy-up ----
test('an address labelled a picture whose bytes are not one is refused, and nothing is kept', { skip }, async () => {
  const before = fs.readdirSync(nf.app.core.config.imagesDir).length;
  const r = await admin.put(`/api/items/${ids.album}/artwork/backdrop`, { url: `${site.url}/liar.png` });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "That address isn't a picture.");
  assert.equal(row(ids.album).backdrop, null);
  const after = fs.readdirSync(nf.app.core.config.imagesDir).length;
  assert.equal(after, before, 'no file kept for it');
});
