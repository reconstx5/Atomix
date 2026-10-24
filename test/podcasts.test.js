// Podcasts and audiobooks on the server (v0.22 Plan B): the library types and the played rule (Task 1); the
// Podcasts service over HTTP with a fake feed server (Task 3); shared features (Task 5) join below.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, startAtomix, client, makeAudio, fakeServer } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let kid; // Mia, a Kids profile
let guest; // another account
let feed; // the fake podcast host (feed + enclosures + a directory)
const ids = {};

/**
 * A podcast host: GET /feed.xml (ETag = the episode list's version), GET /ep/<n>.mp3 (Range honoured unless
 * `noRange`), and an iTunes-like directory under /dir. `episodes` is newest last: { n, guid?, title, date, url? }.
 */
async function podcastHost() {
  const mp3 = path.join(media, 'src.mp3');
  makeAudio(mp3, { seconds: 2, tags: { title: 'x' } });
  const bytes = fs.readFileSync(mp3);
  const host = { episodes: [], version: 1, requests: [], noRange: false, explicit: true, failing: false, bytes };
  host.server = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    host.requests.push({ path: u.pathname, range: req.headers.range || null, inm: req.headers['if-none-match'] || null });
    if (host.failing) return res.writeHead(500), res.end('down');
    if (u.pathname === '/feed.xml' || u.pathname === '/feed2.xml') {
      if (u.pathname === '/feed2.xml') return res.writeHead(200, { 'content-type': 'application/rss+xml' }), res.end('<rss><channel><title>Dir Cast</title></channel></rss>');
      const etag = `"v${host.version}"`;
      if (req.headers['if-none-match'] === etag) return res.writeHead(304), res.end();
      const items = host.episodes
        .map((e) => `<item><title>${e.title}</title>${e.guid === null ? '' : `<guid>${e.guid || `g${e.n}`}</guid>`}<pubDate>${new Date(e.date).toUTCString()}</pubDate><enclosure url="${host.url}${e.url || `/ep/${e.n}.mp3`}" type="audio/mpeg" length="${bytes.length}"/></item>`)
        .join('');
      res.writeHead(200, { 'content-type': 'application/rss+xml', etag });
      return res.end(`<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Test Cast</title><itunes:author>Host Person</itunes:author><itunes:explicit>${host.explicit ? 'yes' : 'no'}</itunes:explicit><description>About tests</description>${items}</channel></rss>`);
    }
    if (u.pathname.startsWith('/ep/')) {
      const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      if (range && !host.noRange) {
        const from = Number(range[1]);
        res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}`, 'content-length': bytes.length - from });
        return res.end(bytes.subarray(from));
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': bytes.length });
      return res.end(bytes);
    }
    if (u.pathname === '/dir/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: [{ collectionId: 4242, collectionName: 'Dir Cast', artistName: 'Dir Host', artworkUrl600: `${host.url}/art.png`, feedUrl: `${host.url}/feed.xml` }] }));
    }
    if (u.pathname === '/dir/lookup') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: u.searchParams.get('id') === '4242' ? [{ collectionId: 4242, feedUrl: `${host.url}/feed2.xml` }] : [] }));
    }
    res.writeHead(404);
    res.end();
  });
  host.url = host.server.url;
  return host;
}
const day = (n) => Date.UTC(2024, 11, 31) + n * 86400000; // day(1) is 1 January 2025
const settle = () => nf.app.core.podcasts.idle();

before(async () => {
  if (!hasFfmpeg) return;
  for (const d of ['Podcasts', 'Audiobooks', 'Other']) fs.mkdirSync(path.join(media, d), { recursive: true });
  feed = await podcastHost();
  nf = await startAtomix({ ATOMIX_PODCAST_DIRECTORY: `${feed.url}/dir` });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
});

after(async () => {
  await nf?.app.stop();
  await feed?.server.close();
});

// ---- Task 1 ----
test('podcasts and audiobooks libraries can be added', { skip }, async () => {
  const p = await admin.post('/api/libraries', { name: 'Podcasts', type: 'podcasts', paths: [path.join(media, 'Podcasts')] });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.type, 'podcasts');
  ids.podcasts = p.data.id;
  const a = await admin.post('/api/libraries', { name: 'Audiobooks', type: 'audiobooks', paths: [path.join(media, 'Audiobooks')] });
  assert.equal(a.status, 200);
  ids.audiobooks = a.data.id;
  const two = await admin.post('/api/libraries', { name: 'Two', type: 'podcasts', paths: [path.join(media, 'Podcasts'), path.join(media, 'Other')] });
  assert.equal(two.status, 400);
  assert.equal(two.data.error, 'A podcasts library keeps its episodes in one folder.');
  const bad = await admin.post('/api/libraries', { name: 'Bad', type: 'photos', paths: [path.join(media, 'Other')] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /podcasts/);
});

test('a spoken title counts as played past 95%; a film past 90%', { skip }, async () => {
  const { db, library } = nf.app.core;
  const profileId = db.get('SELECT id FROM profiles LIMIT 1').id;
  const now = Date.now();
  const book = Number(db.run("INSERT INTO items (library_id, kind, title, duration, added_at, updated_at) VALUES (?, 'audiobook', 'Book', 1000, ?, ?)", ids.audiobooks, now, now).lastInsertRowid);
  const film = Number(db.run("INSERT INTO items (library_id, kind, title, duration, added_at, updated_at) VALUES (?, 'movie', 'Film', 1000, ?, ?)", ids.audiobooks, now, now).lastInsertRowid);
  assert.equal(library.saveProgress(profileId, library.get(book), 920, 1000).watched, false);
  assert.equal(library.saveProgress(profileId, library.get(book), 960, 1000).watched, true);
  assert.equal(library.saveProgress(profileId, library.get(film), 920, 1000).watched, true);
  db.run('DELETE FROM items WHERE id IN (?, ?)', book, film);
});

// ---- Task 3: the Podcasts service ----
const item = async (c, id) => (await c.get(`/api/items/${id}`)).data;
const episodes = async (id) => (await item(admin, id)).episodes;

test('only admins subscribe', { skip }, async () => {
  assert.equal((await guest.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` })).status, 403);
  assert.equal((await kid.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` })).status, 403);
});

test('subscribing reads the feed and downloads the newest 10', { skip }, async () => {
  feed.episodes = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, title: `Episode ${i + 1}`, date: day(i + 1) }));
  const r = await admin.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids.cast = r.data.id;
  assert.equal(r.data.title, 'Test Cast');
  assert.equal(r.data.author, 'Host Person');
  await settle();
  const eps = await episodes(ids.cast);
  assert.equal(eps.length, 12);
  assert.deepEqual(eps.map((e) => e.title).slice(0, 2), ['Episode 12', 'Episode 11'], 'newest first');
  assert.equal(eps.filter((e) => e.status === 'done').length, 10);
  assert.deepEqual(eps.filter((e) => e.status === 'new').map((e) => e.title), ['Episode 2', 'Episode 1']);
  const folder = path.join(media, 'Podcasts', 'Test Cast');
  assert.equal(fs.readdirSync(folder).filter((f) => f.endsWith('.mp3')).length, 10);
  assert.ok(fs.readdirSync(folder).includes('2025-01-12 Episode 12.mp3'));
  const everything = JSON.stringify([r.data, await item(admin, ids.cast)]);
  assert.ok(!everything.includes(new URL(feed.url).host), 'no feed or enclosure address reaches the browser');
  assert.equal((await admin.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` })).data.error, 'You already follow this podcast.');
});

test('a second check with the same ETag costs nothing', { skip }, async () => {
  const before = feed.requests.length;
  const r = await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.found, 0);
  await settle();
  const after = feed.requests.slice(before);
  assert.deepEqual(after.map((x) => x.path), ['/feed.xml']);
  assert.equal(after[0].inm, '"v1"');
});

test('an explicit feed is 18 unless an admin rated it', { skip }, async () => {
  assert.equal((await kid.get(`/api/items/${ids.cast}`)).status, 404);
  assert.equal((await admin.patch(`/api/items/${ids.cast}/details`, { changes: { certification: 'G' } })).status, 200);
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  assert.equal((await kid.get(`/api/items/${ids.cast}`)).status, 200, 'the rating survives the next check');
  assert.equal((await kid.get(`/api/items/${ids.cast}`)).data.feed, undefined, 'no feed status for Kids');
});

test('a new episode is found and the oldest kept-set member moves out', { skip }, async () => {
  assert.equal((await admin.patch(`/api/podcasts/${ids.cast}`, { keep: 3, deletePlayed: true })).status, 200);
  let eps = await episodes(ids.cast);
  const ep10 = eps.find((e) => e.title === 'Episode 10');
  const ep9 = eps.find((e) => e.title === 'Episode 9');
  await admin.post(`/api/items/${ep10.id}/watched`, { watched: true }); // played: its file may go
  feed.episodes.push({ n: 13, title: 'Episode 13', date: day(13) });
  feed.version++;
  const r = await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  assert.equal(r.data.found, 1);
  await settle();
  eps = await episodes(ids.cast);
  const by = Object.fromEntries(eps.map((e) => [e.title, e]));
  assert.equal(by['Episode 13'].status, 'done');
  assert.equal(by['Episode 10'].status, 'new', 'played and outside the newest 3: its file is deleted');
  assert.equal(by['Episode 9'].status, 'done', 'unplayed: kept');
  assert.ok(!fs.existsSync(path.join(media, 'Podcasts', 'Test Cast', '2025-01-10 Episode 10.mp3')));
  assert.ok(ep9);
});

test('a kept episode is downloaded and never deleted', { skip }, async () => {
  const ep1 = (await episodes(ids.cast)).find((e) => e.title === 'Episode 1');
  assert.equal((await admin.put(`/api/podcasts/episodes/${ep1.id}/keep`, { kept: true })).status, 200);
  await settle();
  await admin.post(`/api/items/${ep1.id}/watched`, { watched: true });
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  const again = (await episodes(ids.cast)).find((e) => e.title === 'Episode 1');
  assert.deepEqual({ status: again.status, kept: again.kept }, { status: 'done', kept: true });
});

test('a missing file is downloaded again', { skip }, async () => {
  const file = path.join(media, 'Podcasts', 'Test Cast', '2025-01-13 Episode 13.mp3');
  fs.rmSync(file);
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  assert.ok(fs.existsSync(file));
  assert.equal((await episodes(ids.cast)).find((e) => e.title === 'Episode 13').status, 'done');
});

test('a download resumes from its .part', { skip }, async () => {
  const folder = path.join(media, 'Podcasts', 'Test Cast');
  for (const [noRange, n] of [[false, 14], [true, 15]]) {
    feed.noRange = noRange;
    const part = path.join(folder, `${new Date(day(n)).toISOString().slice(0, 10)} Episode ${n}.mp3.part`);
    fs.writeFileSync(part, feed.bytes.subarray(0, 1000));
    feed.episodes.push({ n, title: `Episode ${n}`, date: day(n) });
    feed.version++;
    const before = feed.requests.length;
    await admin.post(`/api/podcasts/${ids.cast}/check`, {});
    await settle();
    const got = feed.requests.slice(before).find((x) => x.path === `/ep/${n}.mp3`);
    assert.equal(got.range, 'bytes=1000-');
    assert.ok(!fs.existsSync(part), 'no .part left');
    assert.deepEqual(fs.readFileSync(part.replace(/\.part$/, '')), feed.bytes, noRange ? 'a server ignoring Range: started over' : 'resumed');
  }
  feed.noRange = false;
});

test("an episode whose enclosure address changes isn't downloaded twice", { skip }, async () => {
  const e16 = { n: 16, title: 'Episode 16', date: day(16) };
  feed.episodes.push(e16);
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  e16.url = '/ep/16.mp3?moved=1';
  feed.version++;
  const before = feed.requests.length;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  assert.ok(!feed.requests.slice(before).some((x) => x.path === '/ep/16.mp3'), 'not downloaded again');
  assert.equal((await episodes(ids.cast)).filter((e) => e.title === 'Episode 16').length, 1);
  // Two items with no GUID and different enclosures are two episodes.
  feed.episodes.push({ n: 17, guid: null, title: 'Same title', date: day(17) }, { n: 18, guid: null, title: 'Same title', date: day(17) });
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  assert.equal((await episodes(ids.cast)).filter((e) => e.title === 'Same title').length, 2);
});

test('a download that can\'t be written fails with a sentence and is retried', { skip }, async () => {
  const target = path.join(media, 'Podcasts', 'Test Cast', '2025-01-19 Episode 19.mp3');
  fs.mkdirSync(target); // a folder where the file should go
  feed.episodes.push({ n: 19, title: 'Episode 19', date: day(19) });
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  let e = (await episodes(ids.cast)).find((x) => x.title === 'Episode 19');
  assert.equal(e.status, 'failed');
  assert.equal(typeof (await item(admin, e.id)).item, 'object');
  fs.rmdirSync(target);
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  await settle();
  e = (await episodes(ids.cast)).find((x) => x.title === 'Episode 19');
  assert.equal(e.status, 'done');
});

test('a feed that keeps failing says so to admins only', { skip }, async () => {
  feed.failing = true;
  feed.version++;
  for (let i = 0; i < 3; i++) await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  const status = (await item(admin, ids.cast)).feed;
  assert.match(status.error, /^Couldn't reach the feed \(3 tries since [A-Z][a-z]+day\)$/);
  assert.equal(status.failures, 3);
  assert.equal((await kid.get(`/api/items/${ids.cast}`)).data.feed, undefined);
  feed.failing = false;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  assert.equal((await item(admin, ids.cast)).feed.error, null, 'a good check clears it');
});

test('a feed failing its third check raises a problem; a good check clears it (v0.23)', { skip }, async () => {
  const seen = [];
  nf.app.core.hooks.on('server:problem', (p) => seen.push(['problem', p]));
  nf.app.core.hooks.on('server:recovered', (p) => seen.push(['recovered', p]));
  feed.failing = true;
  for (let i = 0; i < 2; i++) {
    feed.version++;
    await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  }
  assert.equal(seen.length, 0, 'nothing at the 1st and 2nd failure');
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  const raised = seen.find(([k, p]) => k === 'problem' && p.kind === 'podcast-feed');
  assert.match(raised?.[1].text || '', /^The feed for .+ has failed 3 checks in a row\.$/);
  feed.failing = false;
  feed.version++;
  await admin.post(`/api/podcasts/${ids.cast}/check`, {});
  assert.ok(seen.some(([k, p]) => k === 'recovered' && p.kind === 'podcast-feed'));
});

test('the directory search goes through Atomix', { skip }, async () => {
  const r = await admin.get('/api/podcasts/directory?q=dir');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, [{ id: 4242, name: 'Dir Cast', author: 'Dir Host', artwork: '/api/podcasts/directory/4242/art' }]);
  assert.equal((await kid.get('/api/podcasts/directory?q=dir')).status, 403);
  // Subscribing by the directory's id finds the feed through /lookup (feed2.xml: a second show).
  const sub = await admin.post('/api/podcasts', { libraryId: ids.podcasts, directoryId: 4242 });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  assert.ok(feed.requests.some((x) => x.path === '/dir/lookup'));
  await settle();
  assert.equal((await admin.del(`/api/podcasts/${sub.data.id}`)).status, 200);
});

test('unsubscribing removes the show and its files', { skip }, async () => {
  assert.equal((await admin.del(`/api/podcasts/${ids.cast}`)).status, 200);
  assert.equal((await admin.get(`/api/items/${ids.cast}`)).status, 404);
  assert.ok(!fs.existsSync(path.join(media, 'Podcasts', 'Test Cast')) || !fs.readdirSync(path.join(media, 'Podcasts', 'Test Cast')).some((f) => f.endsWith('.mp3')));
});

// ---- Final review fixes ----
const fresh = async (episodes) => {
  feed.episodes = episodes;
  feed.explicit = false;
  feed.version++;
  const r = await admin.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await settle();
  return r.data.id;
};

test("a file that can't be written fails the episode, not the server", { skip }, async () => {
  const folder = path.join(media, 'Podcasts', 'Test Cast');
  fs.mkdirSync(path.join(folder, '2025-02-01 Full Disk.mp3.part'), { recursive: true }); // writing it fails (EISDIR)
  const id = await fresh([{ n: 40, title: 'Full Disk', date: day(32) }]);
  const e = (await episodes(id))[0];
  assert.equal(e.status, 'failed');
  assert.equal((await admin.get('/api/status')).status, 200, 'still up');
  fs.rmSync(path.join(folder, '2025-02-01 Full Disk.mp3.part'), { recursive: true });
  ids.fresh = id;
});

test('episodes queued or downloading when the server stopped are downloaded after a restart', { skip }, async () => {
  const p = nf.app.core.podcasts;
  const ep = (await episodes(ids.fresh))[0];
  await p.stop();
  nf.app.core.db.run("UPDATE podcast_episodes SET status = 'downloading' WHERE item_id = ?", ep.id);
  p.start();
  await settle();
  assert.equal((await episodes(ids.fresh))[0].status, 'done');
});

test("a feed without GUIDs doesn't download everything again when its addresses change", { skip }, async () => {
  await admin.del(`/api/podcasts/${ids.fresh}`);
  const eps = [{ n: 41, guid: null, title: 'No Guid A', date: day(33) }, { n: 42, guid: null, title: 'No Guid B', date: day(34) }];
  const id = await fresh(eps);
  for (const e of eps) e.url = `/ep/${e.n}.mp3?track=1`;
  feed.version++;
  const before = feed.requests.length;
  await admin.post(`/api/podcasts/${id}/check`, {});
  await settle();
  assert.equal((await episodes(id)).length, 2, 'matched by title and date');
  assert.ok(!feed.requests.slice(before).some((x) => x.path.startsWith('/ep/')), 'nothing downloaded again');
  ids.fresh = id;
});

test('two episodes with the same title on the same day get their own files', { skip }, async () => {
  feed.episodes.push({ n: 43, title: 'Bonus', date: day(35) }, { n: 44, title: 'Bonus', date: day(35) });
  feed.version++;
  await admin.post(`/api/podcasts/${ids.fresh}/check`, {});
  await settle();
  const bonus = (await episodes(ids.fresh)).filter((e) => e.title === 'Bonus');
  assert.equal(bonus.length, 2);
  const paths = bonus.map((e) => nf.app.core.db.get('SELECT path FROM items WHERE id = ?', e.id).path);
  assert.ok(paths.every(Boolean) && paths[0] !== paths[1], JSON.stringify(paths));
});

test("Kids don't see an episode's keep pin or download state", { skip }, async () => {
  await admin.patch(`/api/items/${ids.fresh}/details`, { changes: { certification: 'G' } });
  const eps = (await kid.get(`/api/items/${ids.fresh}`)).data.episodes;
  assert.ok(eps.length);
  for (const e of eps) {
    assert.equal(e.kept, undefined);
    assert.equal(e.status, undefined);
    assert.equal(typeof e.downloaded, 'boolean');
  }
});

test("unsubscribing doesn't wait for other shows' downloads", { skip }, async () => {
  const p = nf.app.core.podcasts;
  const was = { running: p.running, queue: [...p.queue] };
  p.running = true; // another show's long download
  p.queue.push(987654321);
  const t0 = Date.now();
  const done = await Promise.race([admin.del(`/api/podcasts/${ids.fresh}`).then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  p.running = was.running;
  p.queue = was.queue;
  assert.ok(done && Date.now() - t0 < 3000);
});

test('subscribing twice at once makes one podcast', { skip }, async () => {
  feed.version++;
  const [a, b] = await Promise.all([admin.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` }), admin.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(nf.app.core.db.get("SELECT COUNT(*) AS n FROM items WHERE kind = 'podcast'").n, 1);
  await settle();
  await admin.del(`/api/podcasts/${(a.status === 200 ? a : b).data.id}`);
});

// ---- Plan C Task 3: the pages' server side ----
test("a podcast's newCount counts this profile's unplayed downloaded episodes; new episodes across the library", { skip }, async () => {
  feed.episodes = [{ n: 61, title: 'New One', date: day(61) }, { n: 62, title: 'New Two', date: day(62) }];
  feed.explicit = false;
  feed.version++;
  const id = (await admin.post('/api/podcasts', { libraryId: ids.podcasts, feedUrl: `${feed.url}/feed.xml` })).data.id;
  await settle();
  const count = async () => (await admin.get(`/api/libraries/${ids.podcasts}/items`)).data.items.find((p) => p.id === id).newCount;
  assert.equal(await count(), 2);
  let fresh = (await admin.get(`/api/libraries/${ids.podcasts}/new-episodes`)).data;
  assert.deepEqual(fresh.map((e) => e.title), ['New Two', 'New One'], 'newest first');
  assert.equal(fresh[0].showTitle, 'Test Cast');
  await admin.post(`/api/items/${fresh[0].id}/watched`, { watched: true });
  assert.equal(await count(), 1);
  fresh = (await admin.get(`/api/libraries/${ids.podcasts}/new-episodes`)).data;
  assert.deepEqual(fresh.map((e) => e.title), ['New One']);
  ids.newCast = id;
});

test('check-all is for admins', { skip }, async () => {
  assert.equal((await kid.post('/api/podcasts/check-all', {})).status, 403);
  const r = await admin.post('/api/podcasts/check-all', {});
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.checked, 'number');
  await settle();
  await admin.del(`/api/podcasts/${ids.newCast}`);
});

