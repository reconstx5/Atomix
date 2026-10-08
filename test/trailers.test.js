// Trailers: the TMDB pick, and the item's `trailer` field (local file first, YouTube as the fallback, never for kids).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { pickTrailer } from '../src/library/metadata.js';

const v = (o) => ({ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', published_at: '2020-01-01T00:00:00Z', key: 'k', name: 'n', ...o });

test('pickTrailer: YouTube trailers only; official, then the metadata language, then English, then newest', () => {
  assert.equal(pickTrailer([v({ site: 'Vimeo' })], 'en-US'), null);
  assert.equal(pickTrailer([v({ type: 'Clip' })], 'en-US'), null);
  assert.deepEqual(pickTrailer([v({ type: 'Teaser', key: 't' })], 'en-US'), { site: 'youtube', key: 't', name: 'n' }, 'a teaser when there is no trailer');
  assert.equal(pickTrailer([v({ official: false, key: 'fan' }), v({ key: 'off' })], 'en-US').key, 'off');
  assert.equal(pickTrailer([v({ iso_639_1: 'en', key: 'en' }), v({ iso_639_1: 'fr', key: 'fr' })], 'fr-FR').key, 'fr');
  assert.equal(pickTrailer([v({ iso_639_1: 'de', key: 'de' }), v({ iso_639_1: 'en', key: 'en' })], 'fr-FR').key, 'en');
  assert.equal(pickTrailer([v({ key: 'old', published_at: '2019-01-01T00:00:00Z' }), v({ key: 'new', published_at: '2021-01-01T00:00:00Z' })], 'en-US').key, 'new');
  assert.equal(pickTrailer(undefined, 'en-US'), null);
});

// ---- The trailer field, through the API ----
let nf, admin, kid, tmdb;
const media = tempDir();
const ids = {};
const skip = !hasFfmpeg && 'ffmpeg not installed';

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  makeVideo(path.join(m, 'Solo (2020)', 'Solo (2020).mp4'));
  makeVideo(path.join(m, 'Solo (2020)', 'Solo (2020)-trailer.mp4'));
  fs.writeFileSync(path.join(m, 'Solo (2020)', 'Solo (2020).nfo'), '<movie><title>Solo</title><mpaa>R16</mpaa></movie>');
  makeVideo(path.join(m, 'Bare (2021)', 'Bare (2021).mp4'));
  fs.writeFileSync(path.join(m, 'Bare (2021)', 'Bare (2021).nfo'), '<movie><title>Bare</title><mpaa>NZ:G</mpaa></movie>');
  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/3/search/movie') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      return send({ results: q === 'bare' ? [{ id: 77, title: 'Bare', release_date: '2021-01-01' }] : q === 'solo' ? [{ id: 78, title: 'Solo', release_date: '2020-01-01' }] : [] });
    }
    if (u.pathname === '/3/movie/77') return send({ id: 77, title: 'Bare', release_date: '2021-01-01', genres: [], videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', key: 'abc123', name: 'Official' }] } });
    if (u.pathname === '/3/movie/78') return send({ id: 78, title: 'Solo', release_date: '2020-01-01', genres: [], videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, iso_639_1: 'en', key: 'solo999', name: 'Solo trailer' }] } });
    return send({ results: [] }, u.pathname.startsWith('/3/search') ? 200 : 404);
  });
  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title.toLowerCase()] = it.id;
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => { await nf?.app.stop(); tmdb?.close(); });

test('the trailer field: local wins, YouTube is the fallback, kids get local only, the switch turns YouTube off', { skip }, async () => {
  const solo = (await admin.get(`/api/items/${ids.solo}`)).data;
  assert.equal(solo.trailer.kind, 'local');
  assert.equal(solo.trailer.itemId, solo.extras.find((e) => e.extraKind === 'trailer').id);
  assert.deepEqual((await admin.get(`/api/items/${ids.bare}`)).data.trailer, { kind: 'youtube', key: 'abc123', name: 'Official' });
  assert.equal((await kid.get(`/api/items/${ids.bare}`)).data.trailer, null, 'no YouTube for kids');
  assert.equal((await kid.get(`/api/items/${ids.solo}`)).status, 404, 'Solo is R16: hidden entirely');
  await admin.put('/api/admin/settings', { onlineTrailers: false });
  assert.equal((await admin.get(`/api/items/${ids.bare}`)).data.trailer, null);
  await admin.put('/api/admin/settings', { onlineTrailers: true });
  const home = (await admin.get('/api/home')).data;
  assert.ok(home.hero === null || 'trailer' in home.hero);
  const res = await admin.raw('/');
  assert.match(res.headers.get('content-security-policy'), /frame-src https:\/\/www\.youtube-nocookie\.com/);
});
