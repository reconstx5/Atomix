// Profiles, Kids mode and library access — written before the feature existed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let tmdb;
let admin; // device 1: the parent
const ids = {};

const nfo = (dir, base, xml) => fs.writeFileSync(path.join(dir, `${base}.nfo`), xml);

before(async () => {
  if (!hasFfmpeg) return;
  // Movies with ratings coming from different places
  const m = path.join(media, 'Movies');
  makeVideo(path.join(m, 'Cartoon (2020)', 'Cartoon (2020).mp4'));
  nfo(path.join(m, 'Cartoon (2020)'), 'Cartoon (2020)', '<movie><title>Cartoon</title><mpaa>NZ:G</mpaa></movie>');
  makeVideo(path.join(m, 'Family Film (2019)', 'Family Film (2019).mp4'));
  nfo(path.join(m, 'Family Film (2019)'), 'Family Film (2019)', '<movie><title>Family Film</title><mpaa>Rated PG</mpaa></movie>');
  makeVideo(path.join(m, 'Scary Movie (2018)', 'Scary Movie (2018).mp4')); // rated R16 by (fake) TMDB
  makeVideo(path.join(m, 'Home Video (2021)', 'Home Video (2021).mp4')); // no rating anywhere
  // TV: a kids show and a grown-up show (ratings from tvshow.nfo)
  const t = path.join(media, 'TV');
  makeVideo(path.join(t, 'Kids Show', 'Season 01', 'Kids.Show.S01E01.mp4'));
  fs.writeFileSync(path.join(t, 'Kids Show', 'tvshow.nfo'), '<tvshow><title>Kids Show</title><mpaa>TV-Y7</mpaa></tvshow>');
  makeVideo(path.join(t, 'Crime Drama', 'Season 01', 'Crime.Drama.S01E01.mp4'));
  fs.writeFileSync(path.join(t, 'Crime Drama', 'tvshow.nfo'), '<tvshow><title>Crime Drama</title><mpaa>TV-MA</mpaa></tvshow>');

  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/3/search/movie') return send({ results: /scary/i.test(u.searchParams.get('query')) ? [{ id: 5, title: 'Scary Movie' }] : [] });
    if (u.pathname === '/3/movie/5') {
      return send({ id: 5, title: 'Scary Movie', release_date: '2018-10-31', release_dates: { results: [{ iso_3166_1: 'NZ', release_dates: [{ certification: 'R16', type: 3 }] }] } });
    }
    return send({ results: [] });
  });

  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'parent', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  await waitForScan(admin);
  const movies = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items;
  for (const it of movies) ids[it.title] = it.id;
  const shows = (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items;
  for (const it of shows) ids[it.title] = it.id;
});

after(async () => {
  await nf?.app.stop();
  await tmdb?.close();
});

test('ratings are stored from NFO and TMDB', { skip }, async () => {
  const get = async (title) => (await admin.get(`/api/items/${ids[title]}`)).data.item;
  assert.equal((await get('Cartoon')).certification, 'NZ:G');
  assert.equal((await get('Scary Movie')).certification, 'NZ:R16');
  assert.equal((await get('Scary Movie')).minAge, 16);
  assert.equal((await get('Family Film')).minAge, 8);
  assert.equal((await get('Home Video')).minAge, null);
  assert.equal((await get('Crime Drama')).minAge, 17);
});

test('a single profile is picked automatically', { skip }, async () => {
  const status = (await admin.get('/api/status')).data;
  assert.equal(status.profile.name, 'parent');
  assert.equal(status.profileRequired, false);
  const profiles = (await admin.get('/api/profiles')).data;
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].isPrimary, true);
});

test('kids profiles only see age-appropriate titles', { skip }, async () => {
  const r = await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' });
  assert.equal(r.status, 200);
  ids.kid = r.data.id;
  assert.equal(r.data.kids, true);

  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'parent', password: 'password123' });
  // Two profiles now, so this device has to choose.
  assert.equal((await kid.get('/api/status')).data.profileRequired, true);
  assert.equal((await kid.get(`/api/libraries/${ids.movies}/items`)).status, 428);
  assert.equal((await kid.post(`/api/profiles/${ids.kid}/select`, {})).status, 200);

  const movies = (await kid.get(`/api/libraries/${ids.movies}/items`)).data.items.map((i) => i.title).sort();
  assert.deepEqual(movies, ['Cartoon', 'Family Film']);
  const shows = (await kid.get(`/api/libraries/${ids.tv}/items`)).data.items.map((i) => i.title);
  assert.deepEqual(shows, ['Kids Show']);

  assert.equal((await kid.get(`/api/items/${ids['Scary Movie']}`)).status, 404);
  assert.equal((await kid.get(`/api/items/${ids['Home Video']}/file`)).status, 404);
  assert.equal((await kid.post(`/api/items/${ids['Scary Movie']}/playback`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } })).status, 404);
  assert.equal((await kid.get(`/api/items/${ids['Scary Movie']}/image/poster`)).status, 404);

  const crime = (await admin.get(`/api/items/${ids['Crime Drama']}`)).data;
  const season = (await admin.get(`/api/items/${crime.seasons[0].id}`)).data;
  assert.equal((await kid.get(`/api/items/${season.episodes[0].id}`)).status, 404, 'episodes inherit the show rating');

  const search = (await kid.get('/api/search?q=movie')).data;
  assert.equal(search.movies.length, 0);
  const home = (await kid.get('/api/home')).data;
  const seen = home.rows.flatMap((row) => row.items.map((i) => i.title));
  assert.ok(!seen.includes('Scary Movie') && !seen.includes('Crime Drama') && !seen.includes('Home Video'));
  if (home.hero) assert.ok(['Cartoon', 'Family Film', 'Kids Show'].includes(home.hero.title));

  // Kids can't reach admin screens, account settings, profile management or add-ons
  assert.equal((await kid.get('/api/admin/dashboard')).status, 403);
  assert.equal((await kid.post('/api/me/password', { current: 'password123', password: 'newpassword1' })).status, 403);
  assert.equal((await kid.post('/api/profiles', { name: 'Sneaky' })).status, 403);
  assert.equal((await kid.patch(`/api/profiles/${ids.kid}`, { maxAge: 18 })).status, 403);
  assert.deepEqual((await kid.get('/api/sources')).data, []);
  // Watching a suitable title is fine; taking a copy of the file is a grown-up thing.
  assert.equal((await kid.get(`/api/items/${ids.Cartoon}/file`, { range: 'bytes=0-1' })).status, 206);
  assert.equal((await kid.get(`/api/items/${ids.Cartoon}/download`)).status, 403);
  assert.equal((await admin.get(`/api/items/${ids.Cartoon}/download`)).status, 200);
  ids.kidClient = kid;
});

test('allowing unrated titles for a kids profile', { skip }, async () => {
  await admin.patch(`/api/profiles/${ids.kid}`, { allowUnrated: true });
  const movies = (await ids.kidClient.get(`/api/libraries/${ids.movies}/items`)).data.items.map((i) => i.title).sort();
  assert.deepEqual(movies, ['Cartoon', 'Family Film', 'Home Video']);
  await admin.patch(`/api/profiles/${ids.kid}`, { allowUnrated: false });
});

test('PINs protect a profile', { skip }, async () => {
  const primary = (await admin.get('/api/profiles')).data.find((p) => p.isPrimary);
  let r = await admin.patch(`/api/profiles/${primary.id}`, { pin: '12' });
  assert.equal(r.status, 400, 'PIN must be 4–8 digits');
  r = await admin.patch(`/api/profiles/${primary.id}`, { pin: '4321' });
  assert.equal(r.data.hasPin, true);
  assert.equal(r.data.pin, undefined, 'never send the PIN back');

  const kid = ids.kidClient;
  assert.equal((await kid.post(`/api/profiles/${primary.id}/select`, {})).status, 403);
  assert.equal((await kid.post(`/api/profiles/${primary.id}/select`, { pin: '0000' })).status, 403);
  assert.equal((await kid.post(`/api/profiles/${primary.id}/select`, { pin: '4321' })).status, 200);
  assert.equal((await kid.get('/api/admin/dashboard')).status, 200, 'back on the parent profile');
  await kid.post(`/api/profiles/${ids.kid}/select`, {});
});

test('watch progress is kept per profile', { skip }, async () => {
  const kid = ids.kidClient;
  await kid.post(`/api/items/${ids.Cartoon}/progress`, { position: 60, duration: 600 });
  const kidHome = (await kid.get('/api/home')).data;
  assert.equal(kidHome.rows[0].id, 'continue');
  const parentHome = (await admin.get('/api/home')).data;
  assert.ok(!parentHome.rows.some((row) => row.id === 'continue'), 'the parent has not started anything');
});

test('admins can limit which libraries an account sees', { skip }, async () => {
  const viewer = (await admin.post('/api/users', { username: 'friend', password: 'password123' })).data;
  let r = await admin.patch(`/api/users/${viewer.id}`, { libraryAccess: [ids.movies] });
  assert.deepEqual(r.data.libraryAccess, [ids.movies]);
  const friend = client(nf.base);
  await friend.post('/api/auth/login', { username: 'friend', password: 'password123' });
  const libs = (await friend.get('/api/libraries')).data.map((l) => l.name);
  assert.deepEqual(libs, ['Movies']);
  assert.equal((await friend.get(`/api/libraries/${ids.tv}/items`)).status, 404);
  assert.equal((await friend.get(`/api/items/${ids['Kids Show']}`)).status, 404);
  const search = (await friend.get('/api/search?q=show')).data;
  assert.equal(search.shows.length, 0);
  r = await admin.patch(`/api/users/${viewer.id}`, { libraryAccess: null });
  assert.equal(r.data.libraryAccess, null);
  assert.equal((await friend.get('/api/libraries')).data.length, 2);
});

test('profile libraries narrow what an account can see', { skip }, async () => {
  await admin.patch(`/api/profiles/${ids.kid}`, { libraries: [ids.tv] });
  const libs = (await ids.kidClient.get('/api/libraries')).data.map((l) => l.name);
  assert.deepEqual(libs, ['TV']);
  await admin.patch(`/api/profiles/${ids.kid}`, { libraries: null });
});

test('deleting profiles', { skip }, async () => {
  const primary = (await admin.get('/api/profiles')).data.find((p) => p.isPrimary);
  assert.equal((await admin.del(`/api/profiles/${primary.id}`)).status, 400, "can't delete the main profile");
  assert.equal((await admin.del(`/api/profiles/${ids.kid}`)).status, 200);
  // The device that was using it has to pick again (only one profile left, but it has a PIN).
  assert.equal((await ids.kidClient.get('/api/home')).status, 428);
});

test('existing databases are upgraded with a main profile', async () => {
  const { openDatabase } = await import('../src/db.js');
  const file = path.join(tempDir(), 'old.db');
  const old = openDatabase(file, { upTo: 1 });
  old.run(`INSERT INTO users (id, username, password_hash, role, created_at, prefs) VALUES (1, 'dallas', 'x', 'admin', 1, '{"theme":"harbour"}')`);
  old.run(`INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'M', 'movies', '[]', 1)`);
  old.run(`INSERT INTO items (id, library_id, kind, title, added_at, updated_at, path) VALUES (7, 1, 'movie', 'Old', 1, 1, '/x.mp4')`);
  old.run(`INSERT INTO progress (user_id, item_id, position, watched, updated_at) VALUES (1, 7, 99, 0, 5)`);
  old.close();
  const db = openDatabase(file);
  const profile = db.get('SELECT * FROM profiles WHERE user_id = 1');
  assert.equal(profile.name, 'dallas');
  assert.equal(profile.is_primary, 1);
  assert.equal(JSON.parse(profile.prefs).theme, 'harbour');
  const p = db.get('SELECT * FROM progress WHERE item_id = 7');
  assert.equal(p.profile_id, profile.id);
  assert.equal(p.position, 99);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM items').n, 1, 'no data lost');
  db.close();
});
