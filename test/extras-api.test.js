// End to end: scan a library, let the background jobs run, then check previews
// and intro markers through the API, with the access rules for kids and non-admins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeEpisode, startNodeFlix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const CAPS = { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } };
let nf;
let admin;
let viewer;
const ids = {};

async function waitForTasks(c, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const t = (await c.get('/api/admin/tasks')).data;
    if (!t.running && !t.queued.previews && !t.queued.intros) return t;
    if (Date.now() > end) throw new Error(`background tasks did not finish: ${JSON.stringify(t)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
/** Start playback, then stop it at once (a converting session would pause the jobs). */
async function play(c, id) {
  const r = await c.post(`/api/items/${id}/playback`, CAPS);
  if (r.data?.sessionId) await c.post(`/api/playback/${r.data.sessionId}/stop`, {});
  return r;
}
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 0.5, `${what}: ${actual} is not within 0.5 s of ${expected}`);

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  makeVideo(path.join(m, "Bob's Whānau Film (2020)", "Bob's Whānau Film (2020).mp4"), { seconds: 40 });
  const s1 = path.join(media, 'TV', 'Theme Show', 'Season 01');
  makeEpisode(path.join(s1, 'Theme.Show.S01E01.mp4'), { themeAt: 6, seed: 1 });
  makeEpisode(path.join(s1, 'Theme.Show.S01E02.mkv'), { themeAt: 17, seed: 3, audioCodec: 'mp3', gain: 0.5, lowpass: 3000 });
  makeEpisode(path.join(s1, 'Theme.Show.S01E03.mkv'), { seed: 5, chapters: [[0, 5, 'Recap'], [5, 20, 'Opening'], [20, 80, 'Part 1'], [80, 100, 'End Credits']] });

  nf = await startNodeFlix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] })).data.id;
  await waitForScan(admin);
  await waitForTasks(admin);
  const movie = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items[0];
  ids.movie = movie.id;
  ids.movieTitle = movie.title;
  const show = (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items[0];
  const season = (await admin.get(`/api/items/${show.id}`)).data.seasons[0];
  const eps = (await admin.get(`/api/items/${season.id}`)).data.episodes;
  [ids.e1, ids.e2, ids.e3] = eps.map((e) => e.id);

  await admin.post('/api/users', { username: 'viewer', password: 'password123' });
  viewer = client(nf.base);
  await viewer.post('/api/auth/login', { username: 'viewer', password: 'password123' });
});

after(async () => {
  await nf?.app.stop();
});

test('previews are made after a scan and follow the title’s access rules', { skip }, async () => {
  const r = await play(admin, ids.movie);
  assert.equal(r.status, 200);
  const p = r.data.previews;
  assert.deepEqual([p.interval, p.width, p.columns, p.rows, p.count, p.sheets], [5, 320, 10, 10, 8, 1]);
  assert.deepEqual(r.data.markers, { intro: null, credits: null });
  const img = await admin.raw(p.url.replace('{n}', '1'));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal((await admin.raw(p.url.replace('{n}', '2'))).status, 404, 'only one sheet');
  assert.equal((await admin.raw(`/api/items/${ids.movie}/previews/abc`)).status, 404);
  assert.equal((await viewer.raw(p.url.replace('{n}', '1'))).status, 200, 'any viewer allowed to see the title');
  assert.deepEqual((await admin.get('/api/admin/tasks')).data.failed, []);
});

test('intros come from the shared theme tune, or from chapters', { skip }, async () => {
  const m1 = (await play(admin, ids.e1)).data.markers;
  near(m1.intro.start, 6, 'E01 start');
  near(m1.intro.end, 26, 'E01 end');
  assert.equal(m1.credits, null);
  const m2 = (await play(admin, ids.e2)).data.markers;
  near(m2.intro.start, 17, 'E02 start');
  near(m2.intro.end, 37, 'E02 end');
  const m3 = (await play(admin, ids.e3)).data.markers;
  assert.deepEqual(m3, { intro: { start: 5, end: 20 }, credits: { start: 80, end: 100 } });

  assert.equal((await admin.get(`/api/items/${ids.e1}`)).data.markers.intro.source, 'audio', 'admins see where it came from');
  assert.equal((await viewer.get(`/api/items/${ids.e1}`)).data.markers, undefined, 'other people do not');
});

test('admins can correct an intro; nobody else can', { skip }, async () => {
  const url = `/api/items/${ids.e1}/markers/intro`;
  assert.equal((await viewer.put(url, { start: 1, end: 30 })).status, 403);
  let r = await admin.put(url, { start: 30, end: 20 });
  assert.deepEqual([r.status, r.data.error], [400, 'The intro must end after it starts.']);
  assert.equal((await admin.put(url, { start: 0, end: 500 })).status, 400, 'past the end of the episode');
  assert.equal((await admin.put(url, {})).status, 400);

  r = await admin.put(url, { start: 10, end: 40, applyToSeason: true });
  assert.deepEqual(r.data.intro, { start: 10, end: 40, source: 'manual' });
  for (const id of [ids.e2, ids.e3]) assert.deepEqual((await admin.get(`/api/items/${id}`)).data.markers.intro, { start: 10, end: 40, source: 'manual' });

  r = await admin.put(url, { none: true });
  assert.deepEqual(r.data.intro, { none: true, source: 'manual' });
  assert.equal((await play(admin, ids.e1)).data.markers.intro, null, 'no Skip button');

  r = await admin.del(url);
  assert.equal(r.data.intro, null);
  await waitForTasks(admin);
  const again = (await admin.get(`/api/items/${ids.e1}`)).data.markers.intro;
  assert.equal(again.source, 'audio', 'found again automatically');
  near(again.start, 6, 'E01 start');
  assert.equal((await admin.get(`/api/items/${ids.e2}`)).data.markers.intro.source, 'manual', 'hand-set times elsewhere are kept');

  assert.equal((await admin.post(`/api/items/${ids.movie}/markers/detect`, {})).status, 404, 'movies have no intro markers');
});

test('the task status shows failures, and they can be retried', { skip }, async () => {
  assert.equal((await viewer.get('/api/admin/tasks')).status, 403);
  const row = nf.app.core.db.get('SELECT * FROM items WHERE id = ?', ids.movie);
  nf.app.core.extras.saveJob(row, 'previews', { status: 'failed', error: 'moov atom not found' });
  let t = (await admin.get('/api/admin/tasks')).data;
  assert.match(ids.movieTitle, /Whānau/, 'the awkward file name was scanned');
  assert.deepEqual(t.failed.map((f) => [f.title, f.error]), [[ids.movieTitle, 'moov atom not found']]);
  assert.deepEqual((await admin.post('/api/admin/tasks/retry', {})).data, { retried: 1 });
  t = await waitForTasks(admin);
  assert.deepEqual(t.failed, []);
  assert.ok((await play(admin, ids.movie)).data.previews, 'made again');
  const tools = (await admin.get('/api/admin/dashboard')).data.tools;
  assert.equal(typeof tools.filters.zscale, 'boolean');
});

test('a kids profile cannot fetch pictures from titles it cannot see', { skip }, async () => {
  const url = (await play(admin, ids.movie)).data.previews.url.replace('{n}', '1');
  const kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data.id;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'admin', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  assert.equal((await kid.raw(url)).status, 404, 'unrated title: hidden, so 404, not 403');
  assert.equal((await kid.put(`/api/items/${ids.e1}/markers/intro`, { none: true })).status, 403);
});
