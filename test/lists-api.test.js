// Playlists, the Watchlist, collections and picks over HTTP: profile isolation, sharing, the kids rules,
// the Home rows, and playing through a video list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan, fakeServer } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let tmdb;
let admin; // dallas, the adult admin
let guest; // another user
let kid; // Mia, a kids profile on dallas's account
const ids = {};
const nfo = (dir, base, xml) => fs.writeFileSync(path.join(dir, `${base}.nfo`), xml);

let dropped = false; // TMDB moves Aliens out of the series
before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  for (const [folder, rating] of [['Alien (1979)', 'R16'], ['Aliens (1986)', 'R16'], ['Cartoon (2020)', 'NZ:G'], ['Scary (2018)', 'R16']]) {
    makeVideo(path.join(m, folder, `${folder}.mp4`));
    nfo(path.join(m, folder), folder, `<movie><title>${folder.replace(/ \(\d+\)$/, '')}</title><mpaa>${rating}</mpaa></movie>`);
  }
  const t = path.join(media, 'TV');
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E02.mp4'));
  fs.writeFileSync(path.join(t, 'Show', 'tvshow.nfo'), '<tvshow><title>Show</title><mpaa>NZ:G</mpaa></tvshow>');
  const mu = path.join(media, 'Music', 'The Band', 'First Record');
  makeAudio(path.join(mu, '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/2' } });
  makeAudio(path.join(mu, '02 Closer.mp3'), { tags: { title: 'Closer', artist: 'The Band', album: 'First Record', track: '2/2' } });

  tmdb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/3/search/movie') {
      const q = (u.searchParams.get('query') || '').toLowerCase();
      if (q === 'alien') return send({ results: [{ id: 348, title: 'Alien', release_date: '1979-05-25' }] });
      if (q === 'aliens') return send({ results: [{ id: 679, title: 'Aliens', release_date: '1986-07-18' }] });
      return send({ results: [] });
    }
    const series = { id: 8091, name: 'Alien Collection', poster_path: null, backdrop_path: null };
    if (u.pathname === '/3/movie/348') return send({ id: 348, title: 'Alien', release_date: '1979-05-25', genres: [{ name: 'Horror' }, { name: 'Sci-Fi' }], belongs_to_collection: series, keywords: { keywords: [{ name: 'space' }, { name: 'android' }] }, credits: { cast: [{ name: 'Sigourney Weaver', order: 0 }], crew: [{ name: 'Ridley Scott', job: 'Director' }] } });
    if (u.pathname === '/3/movie/679') return send({ id: 679, title: 'Aliens', release_date: '1986-07-18', genres: [{ name: 'Action' }, { name: 'Sci-Fi' }], belongs_to_collection: dropped ? null : series, keywords: { keywords: [{ name: 'space' }, { name: 'marines' }] }, credits: { cast: [{ name: 'Sigourney Weaver', order: 0 }], crew: [{ name: 'James Cameron', job: 'Director' }] } });
    if (u.pathname === '/3/collection/8091') return send({ id: 8091, name: 'Alien Collection', overview: 'Xenomorphs.', parts: [{ id: 348, title: 'Alien', release_date: '1979-05-25' }, { id: 679, title: 'Aliens', release_date: '1986-07-18' }, { id: 8077, title: 'Alien³', release_date: '1992-05-22' }] });
    if (u.pathname === '/3/search/tv') return send({ results: [] });
    return send({ results: [] }, u.pathname.startsWith('/3/search') ? 200 : 404);
  });
  nf = await startAtomix({ ATOMIX_TMDB_BASE: `${tmdb.url}/3`, TMDB_API_KEY: '0123456789abcdef0123456789abcdef' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title] = it.id;
  for (const it of (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items) ids[it.title] = it.id;
  const show = (await admin.get(`/api/items/${ids.Show}`)).data;
  ids.season = show.seasons[0].id;
  const eps = (await admin.get(`/api/items/${ids.season}`)).data.episodes;
  ids.E1 = eps[0].id;
  ids.E2 = eps[1].id;
  const tracks = (await admin.get(`/api/libraries/${ids.music}/items?view=tracks`)).data.items;
  ids.track1 = tracks[0].id;
  // A kids profile on the same account, and another user.
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
  await tmdb?.close();
});

test('the Watchlist: toggle, item flags, the Home row', { skip }, async () => {
  assert.equal((await admin.put(`/api/watchlist/${ids.Alien}`)).status, 204);
  assert.equal((await admin.get(`/api/items/${ids.Alien}`)).data.inWatchlist, true);
  const home = (await admin.get('/api/home')).data;
  const row = home.rows.find((r) => r.id === 'watchlist');
  assert.equal(row.title, 'My Watchlist');
  assert.deepEqual(row.items.map((i) => i.title), ['Alien']);
  assert.equal((await admin.del(`/api/watchlist/${ids.Alien}`)).status, 204);
  assert.ok(!(await admin.get('/api/home')).data.rows.some((r) => r.id === 'watchlist'));
  assert.equal((await admin.put(`/api/watchlist/${ids.E1}`)).status, 400, 'episodes are not for the Watchlist');
});

test("playlists: create, add, reorder, share; a kid sees a shared list only when it is safe; others can't edit", { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'video', name: 'Friday' })).data;
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Cartoon })).status, 204);
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { seasonId: ids.season })).status, 204);
  let got = (await admin.get(`/api/lists/${list.id}`)).data;
  assert.deepEqual(got.items.map((i) => i.title), ['Cartoon', 'Episode 1', 'Episode 2']);
  await admin.put(`/api/lists/${list.id}/items/${ids.Cartoon}/position`, { position: 2 });
  got = (await admin.get(`/api/lists/${list.id}`)).data;
  assert.deepEqual(got.items.map((i) => i.id), [ids.E1, ids.E2, ids.Cartoon]);
  assert.equal((await guest.patch(`/api/lists/${list.id}`, { name: 'Mine' })).status, 404, 'not shared: not even visible');
  assert.equal((await guest.get(`/api/lists/${list.id}`)).status, 404);
  await admin.patch(`/api/lists/${list.id}`, { shared: true });
  assert.equal((await guest.get(`/api/lists/${list.id}`)).status, 200);
  assert.equal((await guest.post(`/api/lists/${list.id}/items`, { itemId: ids.Alien })).status, 403);
  assert.equal((await guest.patch(`/api/lists/${list.id}`, { name: 'Mine' })).status, 403);
  assert.equal((await kid.get(`/api/lists/${list.id}`)).status, 200, 'all kid-safe');
  await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Scary });
  assert.equal((await kid.get(`/api/lists/${list.id}`)).status, 404, 'one R16 film hides it');
  assert.ok(!(await kid.get('/api/lists')).data.some((l) => l.id === list.id));
  assert.ok((await guest.get('/api/lists')).data.some((l) => l.id === list.id && l.own === false && l.ownerName === 'dallas'));
  const home = (await admin.get('/api/home')).data;
  assert.ok(home.rows.find((r) => r.id === 'lists')?.items.some((c) => c.name === 'Friday'));
  assert.equal((await kid.patch(`/api/lists/${(await kid.post('/api/lists', { kind: 'video', name: 'Mine' })).data.id}`, { shared: true })).status, 403, 'kids cannot share');
  ids.list = list.id;
});

test('a song playlist takes tracks only', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'music', name: 'Chill' })).data;
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.track1 })).status, 204);
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Alien })).status, 400);
});

test("playing a video list: next comes from the list and skips what the viewer can't see", { skip }, async () => {
  const s = (await admin.post(`/api/items/${ids.E1}/playback`, { listId: ids.list, caps: {} })).data;
  assert.equal(s.next.id, ids.E2);
  const s2 = (await admin.post(`/api/items/${ids.E2}/playback`, { listId: ids.list, caps: {} })).data;
  assert.equal(s2.next.id, ids.Cartoon);
  const n = (await admin.get(`/api/playback/next?list=${ids.list}&after=${ids.Cartoon}`)).data;
  assert.equal(n.next.title, 'Scary');
  assert.equal((await admin.get(`/api/playback/next?list=${ids.list}&after=${ids.Scary}`)).data.next, null);
  for (const sid of [s.sessionId, s2.sessionId]) await admin.post(`/api/playback/${sid}/stop`, {});
});

test("collections: the film's page, the list, admin edits, kids", { skip }, async () => {
  const alien = (await admin.get(`/api/items/${ids.Alien}`)).data;
  assert.equal(alien.collection.name, 'Alien Collection');
  assert.deepEqual(alien.collection.items.map((i) => i.title), ['Alien', 'Aliens']);
  assert.equal(alien.collection.total, 3);
  assert.deepEqual(alien.collection.missing, [{ title: 'Alien³', year: 1992 }]);
  assert.deepEqual(alien.collection.items.map((i) => [i.title, i.isCurrent]), [['Alien', true], ['Aliens', false]], 'the item page marks the current film in its collection');
  assert.ok(alien.similar.some((i) => i.title === 'Aliens'));
  const all = (await admin.get('/api/collections')).data;
  assert.equal(all.length, 1);
  const made = (await admin.post('/api/collections', { name: 'Family night', itemIds: [ids.Cartoon, ids.Show] })).data;
  assert.equal((await admin.get('/api/collections')).data.length, 2);
  assert.equal((await kid.get('/api/collections')).data.length, 1, 'the Alien films are R16');
  assert.equal((await guest.post('/api/collections', { name: 'x' })).status, 403);
  await admin.patch(`/api/collections/${made.id}`, { name: 'Family films', itemIds: [ids.Show, ids.Cartoon] });
  assert.deepEqual((await admin.get(`/api/collections/${made.id}`)).data.items.map((i) => i.title), ['Show', 'Cartoon']);
  assert.equal((await admin.del(`/api/collections/${all[0].id}`)).status, 400, "TMDB ones can't be deleted");
  assert.equal((await admin.del(`/api/collections/${made.id}`)).status, 204);
});

test('Home: Because you watched rows after the library rows, kid-safe for kids', { skip }, async () => {
  await admin.post(`/api/items/${ids.Alien}/progress`, { position: 30, duration: 100 });
  const home = (await admin.get('/api/home')).data;
  const byw = home.rows.filter((r) => r.id.startsWith('picks-'));
  assert.equal(byw[0].title, 'Because you watched Alien');
  assert.ok(byw[0].items.some((i) => i.title === 'Aliens'));
  const idx = (id) => home.rows.findIndex((r) => r.id === id);
  assert.ok(idx(`picks-${ids.Alien}`) > idx(`recent-${ids.movies}`));
  assert.ok(!(await kid.get('/api/home')).data.rows.some((r) => r.id.startsWith('picks-')), 'Mia has watched nothing');
});

test('a film TMDB drops from its series is detached on refresh', { skip }, async () => {
  dropped = true;
  try {
    const r = await admin.post(`/api/items/${ids.Aliens}/refresh`, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const aliens = (await admin.get(`/api/items/${ids.Aliens}`)).data;
    assert.equal(aliens.collection, null, 'no "Part of" any more');
    const alien = (await admin.get(`/api/items/${ids.Alien}`)).data;
    assert.equal(alien.collection.owned, 1);
    assert.deepEqual(alien.collection.items.map((i) => i.title), ['Alien']);
  } finally {
    dropped = false;
  }
});
