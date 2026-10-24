// v0.23 Plan B Task 2: the Fanart.tv plugin fills missing clear logos, backgrounds and posters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeImage, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { pickImage } from '../plugins/fanart-tv/index.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const png = path.join(tempDir(), 'art.png');
let nf, admin, tmdb, fanart;
const seen = [];
let down = false;
let tmdbArt = false;
let tmdbDown = false;
const tmdbImgs = [];
const ids = {};

const list = (name) => [{ id: '1', url: `${fanart.url}/img/${name}-fr.png`, lang: 'fr', likes: '9' }, { id: '2', url: `${fanart.url}/img/${name}-en.png`, lang: 'en', likes: '3' }];

before(async () => {
  if (!hasFfmpeg) return;
  makeImage(png, 'purple', '400x155');
  makeVideo(path.join(media, 'Movies', 'Sea Film (2020)', 'Sea Film (2020).mp4'));
  fs.writeFileSync(path.join(media, 'Movies', 'Sea Film (2020)', 'movie.nfo'), '<movie><title>Sea Film</title><year>2020</year><uniqueid type="tmdb">77</uniqueid></movie>');
  makeImage(path.join(media, 'Movies', 'Sea Film (2020)', 'poster.jpg'), 'green', '200x300');
  makeVideo(path.join(media, 'TV', 'Wave Show', 'Season 01', 'Wave.Show.S01E01.mp4'));

  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, st = 200) => (res.writeHead(st, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname.startsWith('/t/p/')) return tmdbImgs.push(u.pathname), res.writeHead(200, { 'content-type': 'image/png' }), res.end(fs.readFileSync(png));
    if (tmdbDown) return send({ status_message: 'down' }, 500);
    if (u.pathname === '/3/movie/77' && tmdbArt) return send({ id: 77, title: 'Sea Film', release_date: '2020-01-01', backdrop_path: '/tmdb-bg.png', images: { logos: [{ file_path: '/tmdb-logo.png', iso_639_1: 'en', vote_average: 5 }] } });
    if (u.pathname === '/3/movie/77') return send({ id: 77, title: 'Sea Film', release_date: '2020-01-01' });
    if (u.pathname === '/3/search/tv') return send({ results: [{ id: 501, name: 'Wave Show' }] });
    if (u.pathname === '/3/tv/501') return send({ id: 501, name: 'Wave Show', first_air_date: '2019-01-01', external_ids: { tvdb_id: 81189 } });
    return send({ results: [] });
  });
  fanart = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/img/')) return res.writeHead(200, { 'content-type': 'image/png' }), res.end(fs.readFileSync(png));
    seen.push({ url: req.url, key: req.headers['api-key'] });
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (down) return send({ error: 'busy' }, 503);
    if (u.pathname === '/v3/movies/77') return send({ name: 'Sea Film', hdmovielogo: list('logo'), moviebackground: list('bg'), movieposter: list('poster') });
    if (u.pathname === '/v3/tv/81189') return send({ name: 'Wave Show', hdtvlogo: list('tvlogo'), showbackground: list('tvbg'), tvposter: list('tvposter') });
    return send({ status: 'error', 'error message': 'Not found' }, 404);
  });
  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, ATOMIX_TMDB_IMAGE_BASE: `${tmdb.url}/t/p`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef', ATOMIX_FANART_BASE: fanart.url }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
});

after(async () => {
  await nf?.app.stop();
  await tmdb?.close();
  await fanart?.close();
});

const row = (id) => nf.app.core.db.get('SELECT * FROM items WHERE id = ?', id);
const card = async () => (await admin.get('/api/admin/plugins')).data.find((p) => p.id === 'fanart-tv');
const scan = async () => {
  await admin.post('/api/scan', {});
  await waitForScan(admin);
};

test('pickImage: metadata language, then English, then no language; most liked first', () => {
  const l = [{ url: 'fr', lang: 'fr', likes: '9' }, { url: 'none', lang: '00', likes: '8' }, { url: 'en-low', lang: 'en', likes: '2' }, { url: 'en-best', lang: 'en', likes: '5' }];
  assert.equal(pickImage(l, 'en-US'), 'en-best');
  assert.equal(pickImage(l, 'fr-FR'), 'fr');
  assert.equal(pickImage([{ url: 'none', lang: '', likes: '1' }], 'de'), 'none');
  assert.equal(pickImage([{ url: 'x', lang: 'de', likes: '1' }], 'en'), null, 'another language is not used');
  assert.equal(pickImage([], 'en'), null);
  assert.equal(pickImage(undefined, 'en'), null);
});

test('with no key the card asks for one and nothing is requested', { skip }, async () => {
  await admin.post('/api/admin/plugins/fanart-tv/enabled', { enabled: true });
  assert.equal((await card()).status, 'Paste your free Fanart.tv personal key to start.');
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await waitForScan(admin);
  await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] });
  await waitForScan(admin);
  ids.film = nf.app.core.db.get("SELECT id FROM items WHERE kind = 'movie'").id;
  ids.show = nf.app.core.db.get("SELECT id FROM items WHERE kind = 'show'").id;
  assert.equal(row(ids.film).logo, null);
  assert.equal(seen.length, 0);
});

test('adding the key later fills titles scanned before it', { skip }, async () => {
  await admin.put('/api/admin/plugins/fanart-tv/config', { apiKey: 'FKEY' });
  assert.equal((await card()).status, null);
  assert.equal(row(ids.film).metadata_at, null, 'offered again');
  await scan();
  assert.ok(row(ids.film).logo, 'a logo now');
  const asked = seen.find((s) => s.url.startsWith('/v3/movies/77'));
  assert.equal(asked.key, 'FKEY');
  assert.ok(seen.every((s) => !s.url.includes('FKEY')), 'the key is never in the address');
});

test("a film's logo, background and poster fill only where TMDB and the folder left gaps", { skip }, async () => {
  const film = row(ids.film);
  assert.match(film.poster, /^file:.*poster\.jpg$/, "the folder's own poster stays");
  assert.ok(film.logo && film.backdrop);
  const logoFile = nf.app.core.metadata.images.resolve(film.logo).file;
  assert.ok(fs.existsSync(logoFile));
});

test('a show is looked up by the TheTVDB id TMDB passed', { skip }, async () => {
  assert.ok(seen.some((s) => s.url.startsWith('/v3/tv/81189')));
  assert.ok(row(ids.show).logo);
});

test('a second scan asks nothing (kept in storage); Refresh info asks again', { skip }, async () => {
  const before = seen.length;
  nf.app.core.db.run('UPDATE items SET metadata_at = NULL WHERE id = ?', ids.film);
  await scan();
  assert.equal(seen.length, before, 'from storage');
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  assert.equal(seen.length, before + 1, 'Refresh info asks again');
});

test('switched-off kinds of artwork are left alone', { skip }, async () => {
  await admin.put('/api/admin/plugins/fanart-tv/config', { fillLogo: false });
  nf.app.core.db.run('UPDATE items SET logo = NULL WHERE id = ?', ids.film);
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  assert.equal(row(ids.film).logo, null);
  assert.ok(row(ids.film).backdrop, 'backgrounds are still filled');
  await admin.put('/api/admin/plugins/fanart-tv/config', { fillLogo: true });
});

test('Fanart.tv down: the scan finishes and the logo comes at the next scan', { skip }, async () => {
  down = true;
  nf.app.core.db.run('UPDATE items SET logo = NULL, metadata_at = NULL WHERE id = ?', ids.show);
  nf.app.core.db.run('UPDATE items SET metadata_at = 1 WHERE id != ?', ids.show);
  // Kept results are asked again only by Refresh info, so the show's kept answer is dropped here.
  await admin.post(`/api/items/${ids.show}/refresh`, {});
  assert.equal(row(ids.show).logo, null, 'down: no logo, no error');
  assert.equal((await admin.get('/api/scan/status')).status, 200);
  down = false;
  await scan(); // the scan:complete of this scan offers it again…
  await scan(); // …and this one fills it
  assert.ok(row(ids.show).logo, 'filled once it answers');
});

test("TMDB's artwork wins over Fanart.tv's, and stays when TMDB is down for a refresh (review fix F1)", { skip }, async () => {
  tmdbArt = true;
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  const withTmdb = row(ids.film);
  assert.ok(tmdbImgs.some((p) => p.endsWith('/tmdb-logo.png')), "TMDB's logo was taken");
  assert.ok(withTmdb.logo && withTmdb.backdrop);
  const tmdbLogo = withTmdb.logo;
  const tmdbBackdrop = withTmdb.backdrop;
  tmdbDown = true;
  await admin.post(`/api/items/${ids.film}/refresh`, {});
  const after = row(ids.film);
  assert.equal(after.logo, tmdbLogo, "TMDB's logo stays while TMDB can't be reached");
  assert.equal(after.backdrop, tmdbBackdrop, "TMDB's background stays too");
  tmdbDown = false;
  tmdbArt = false;
});
