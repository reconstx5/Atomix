// v0.23 Plan B Task 3: the OMDb plugin adds IMDb, Rotten Tomatoes and Metacritic scores, within a daily limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { toScores, usageAllows } from '../plugins/omdb-ratings/index.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf, admin, omdb;
const seen = [];
let badKey = false;
let limit401 = false;

function film(dir, title, imdb) {
  makeVideo(path.join(media, dir, `${title} (2020)`, `${title} (2020).mp4`));
  fs.writeFileSync(path.join(media, dir, `${title} (2020)`, 'movie.nfo'), `<movie><title>${title}</title><year>2020</year><uniqueid type="imdb">${imdb}</uniqueid></movie>`);
}

before(async () => {
  if (!hasFfmpeg) return;
  film('Films', 'Alpha', 'tt0000001');
  for (const [t, id] of [['Beta', 'tt0000002'], ['Gamma', 'tt0000003'], ['Delta', 'tt0000004']]) film('More', t, id);
  makeVideo(path.join(media, 'TV', 'Wave Show', 'Season 01', 'Wave.Show.S01E01.mp4'));
  omdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(u);
    const send = (d) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (badKey) return send({ Response: 'False', Error: 'Invalid API key!' });
    if (limit401) return res.writeHead(401, { 'content-type': 'application/json' }), res.end(JSON.stringify({ Response: 'False', Error: 'Request limit reached!' }));
    const ratings = [{ Source: 'Internet Movie Database', Value: '7.8/10' }, { Source: 'Rotten Tomatoes', Value: '93%' }, { Source: 'Metacritic', Value: '81/100' }];
    if (u.searchParams.get('i')) return send({ Response: 'True', Title: 'X', Year: '2020', imdbRating: '7.8', Ratings: ratings });
    if (u.searchParams.get('t') === 'Wave Show') return send({ Response: 'True', Title: 'Wave Show', Year: '2019–', imdbRating: '6.5', Ratings: [{ Source: 'Internet Movie Database', Value: '6.5/10' }] });
    return send({ Response: 'False', Error: 'Movie not found!' });
  });
  nf = await startAtomix({ ATOMIX_OMDB_BASE: omdb.url }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
});

after(async () => {
  await nf?.app.stop();
  await omdb?.close();
});

const card = async () => (await admin.get('/api/admin/plugins')).data.find((p) => p.id === 'omdb-ratings');
const item = async (title) => {
  const id = nf.app.core.db.get('SELECT id FROM items WHERE title = ?', title).id;
  return (await admin.get(`/api/items/${id}`)).data.item;
};
const library = async (name, type, dir) => {
  await admin.post('/api/libraries', { name, type, paths: [path.join(media, dir)] });
  await waitForScan(admin);
};

test('toScores reads OMDb ratings and skips N/A', () => {
  assert.deepEqual(toScores({ imdbRating: '7.8', Ratings: [{ Source: 'Internet Movie Database', Value: '7.8/10' }, { Source: 'Rotten Tomatoes', Value: '93%' }, { Source: 'Metacritic', Value: 'N/A' }] }), [{ source: 'imdb', value: '7.8/10' }, { source: 'rt', value: '93%' }]);
  assert.deepEqual(toScores({ imdbRating: '6.1', Ratings: [] }), [{ source: 'imdb', value: '6.1/10' }]);
  assert.deepEqual(toScores({ imdbRating: 'N/A' }), []);
});

test('usageAllows counts within a day and starts again the next', () => {
  assert.deepEqual(usageAllows({ day: '2026-10-18', count: 900 }, '2026-10-19', 900), { ok: true, usage: { day: '2026-10-19', count: 0 } });
  assert.equal(usageAllows({ day: '2026-10-19', count: 900 }, '2026-10-19', 900).ok, false);
  assert.equal(usageAllows({ day: '2026-10-19', count: 899 }, '2026-10-19', 900).ok, true);
  assert.equal(usageAllows(null, '2026-10-19', 900).ok, true);
});

test('a film gets IMDb, Rotten Tomatoes and Metacritic scores by its IMDb id', { skip }, async () => {
  await admin.post('/api/admin/plugins/omdb-ratings/enabled', { enabled: true });
  assert.equal((await card()).status, 'Paste your free OMDb key to start.');
  await admin.put('/api/admin/plugins/omdb-ratings/config', { apiKey: 'OKEY', dailyLimit: 50 });
  assert.equal((await card()).status, null);
  await library('Films', 'movies', 'Films');
  assert.deepEqual((await item('Alpha')).scores, [{ source: 'imdb', value: '7.8/10' }, { source: 'rt', value: '93%' }, { source: 'metacritic', value: '81/100' }]);
  const asked = seen.find((u) => u.searchParams.get('i') === 'tt0000001');
  assert.equal(asked.searchParams.get('apikey'), 'OKEY');
});

test('without an IMDb id it asks by title, year and type', { skip }, async () => {
  await library('TV', 'tv', 'TV');
  const asked = seen.find((u) => u.searchParams.get('t') === 'Wave Show');
  assert.equal(asked.searchParams.get('type'), 'series');
  assert.deepEqual((await item('Wave Show')).scores, [{ source: 'imdb', value: '6.5/10' }]);
});

test('the daily limit stops lookups and the titles wait', { skip }, async () => {
  const before = seen.length; // 2 lookups so far today
  await admin.put('/api/admin/plugins/omdb-ratings/config', { dailyLimit: 3 });
  await library('More', 'movies', 'More');
  assert.equal(seen.length, before + 1, 'one more, then the limit');
  assert.equal((await card()).status, "Today's limit of 3 lookups is used up; scores carry on tomorrow.");
  const missing = nf.app.core.library.list({ kind: 'movie', missingScores: true });
  assert.equal(missing.length, 2);
  // Review fix F2: the waiting titles are not offered again at every scan while the limit is used up.
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  for (const m of missing) assert.notEqual(nf.app.core.db.get('SELECT metadata_at FROM items WHERE id = ?', m.id).metadata_at, null, m.title);
  assert.equal(seen.length, before + 1, 'and nothing more is asked');
});

test('once lookups are allowed again, the waiting titles are offered at the next scan (review fix F2)', { skip }, async () => {
  const before = seen.length;
  await admin.put('/api/admin/plugins/omdb-ratings/config', { dailyLimit: 4 }); // room for one more today
  await admin.post('/api/scan', {});
  await waitForScan(admin); // offers them…
  await admin.post('/api/scan', {});
  await waitForScan(admin); // …and this one asks, within the limit
  assert.equal(seen.length, before + 1);
  assert.equal(nf.app.core.library.list({ kind: 'movie', missingScores: true }).length, 1);
});

test('Fetch missing scores works through titles with none and reports it', { skip }, async () => {
  await admin.put('/api/admin/plugins/omdb-ratings/config', { dailyLimit: 10 });
  const r = await admin.post('/api/admin/plugins/omdb-ratings/actions/fetch-missing', {});
  assert.equal(r.data.message, 'Fetching scores for 1 title in the background.');
  let status;
  for (let i = 0; i < 100 && !/^Last fetch/.test(status || ''); i++) {
    await new Promise((res) => setTimeout(res, 100));
    status = (await card()).status;
  }
  assert.equal(status, 'Last fetch: scores for 1 of 1 title.');
  assert.equal(nf.app.core.library.list({ kind: 'movie', missingScores: true }).length, 0);
  assert.equal((await admin.post('/api/admin/plugins/omdb-ratings/actions/fetch-missing', {})).data.message, 'No titles are missing scores.');
});

test('a refused key says so on the card', { skip }, async () => {
  badKey = true;
  const id = nf.app.core.db.get("SELECT id FROM items WHERE title = 'Alpha'").id;
  await admin.post(`/api/items/${id}/refresh`, {});
  assert.equal((await card()).status, 'OMDb refused the key. Check it in the settings below.');
  assert.ok((await item('Alpha')).scores?.length, 'the scores it had stay');
  badKey = false;
});

test("OMDb's 401 that says the limit is reached is the limit, not a refused key (review fix F4)", { skip }, async () => {
  limit401 = true;
  const id = nf.app.core.db.get("SELECT id FROM items WHERE title = 'Beta'").id;
  await admin.post(`/api/items/${id}/refresh`, {});
  assert.equal((await card()).status, "Today's limit of 10 lookups is used up; scores carry on tomorrow.");
  limit401 = false;
});
