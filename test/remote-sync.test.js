// A connected server's libraries sync into Atomix as ordinary libraries: locked metadata, rating, media, pruning,
// unreachable servers, and the local-only jobs that skip remote titles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client, waitForScan } from './helpers.js';
import { fakeJellyfin, jfMovie } from './helpers-jellyfin.js';

let jf, nf, admin, kid;
const ids = {};
const now = Date.now();

before(async () => {
  jf = await fakeJellyfin({
    movies: [
      jfMovie('m1', 'Alien', { DateCreated: '2020-01-01T00:00:00.0000000Z', ProductionYear: 1979, OfficialRating: 'NZ-R16', Tags: ['space'], People: [{ Name: 'Ridley Scott', Type: 'Director' }], ProviderIds: { Tmdb: '348' } }),
      jfMovie('m2', 'Cartoon', { OfficialRating: 'NZ-G', DateCreated: new Date().toISOString() }),
      jfMovie('m3', 'Mystery', { OfficialRating: 'Not Rated', MediaSources: [] }),
      jfMovie('m4', 'Cable Drama', { OfficialRating: 'TV-MA' }),
    ],
    shows: [{ Id: 's1', Name: 'Far Show', ProductionYear: 2022, OfficialRating: 'NZ-G', Overview: 'A show.', Genres: ['Drama'], ImageTags: { Primary: 'x' }, Seasons: [{ Id: 'se1', Name: 'Season 1', IndexNumber: 1, ParentId: 's1', Episodes: [{ Id: 'e1', Name: 'Pilot', IndexNumber: 1, ParentIndexNumber: 1, ParentId: 'se1', RunTimeTicks: 1200 * 10000000, MediaSources: [{ Container: 'mp4', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1280, Height: 720, Index: 0 }, { Type: 'Audio', Codec: 'aac', Channels: 2, Index: 1 }] }] }, { Id: 'e2', Name: 'Second', IndexNumber: 2, ParentIndexNumber: 1, ParentId: 'se1', MediaSources: [{ Container: 'mp4', MediaStreams: [] }] }] }] }],
  });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const db = nf.app.core.db;
  ids.server = Number(db.run("INSERT INTO servers (kind, name, url, username, secret, remote_user_id, created_at) VALUES ('jellyfin', 'Fake Jellyfin', ?, 'dallas', 'tok1', 'u1', ?)", jf.url, now).lastInsertRowid);
  ids.movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('Movies (Fake Jellyfin)', 'movies', '[]', '{}', ?, ?, 'lib-m')", now, ids.server).lastInsertRowid);
  ids.tv = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('TV (Fake Jellyfin)', 'tv', '[]', '{}', ?, ?, 'lib-t')", now, ids.server).lastInsertRowid);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  ids.mia = mia.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => { await nf?.app.stop(); jf?.close(); });

const rows = (sql, ...p) => nf.app.core.db.all(sql, ...p).map((r) => ({ ...r }));

test('a sync creates remote items with locked metadata, media, rating and people', () => {
  const alien = rows("SELECT * FROM items WHERE kind = 'movie' AND title = 'Alien'")[0];
  assert.ok(alien, 'Alien synced');
  assert.equal(alien.path, `remote:${ids.server}:m1`);
  assert.equal(alien.remote_id, 'm1');
  assert.equal(alien.metadata_locked, 1);
  assert.ok(alien.metadata_at > 0);
  assert.equal(alien.min_age, 16);
  assert.equal(alien.certification, 'NZ:R16');
  assert.equal(alien.year, 1979);
  assert.equal(alien.runtime, 120);
  assert.equal(alien.duration, 7200);
  assert.equal(alien.tmdb_id, 348);
  assert.deepEqual(JSON.parse(alien.keywords), ['space']);
  assert.deepEqual(JSON.parse(alien.people), [{ name: 'Ridley Scott', role: 'director' }]);
  assert.equal(JSON.parse(alien.media).video.codec, 'h264');
  assert.match(alien.poster, /\/Items\/m1\/Images\/Primary\?tag=x$/);
  const stub = rows("SELECT * FROM items WHERE title = 'Mystery'")[0];
  assert.equal(stub.media, null);
  assert.equal(stub.min_age, null);
});

test('a show syncs with its seasons and episodes under it', () => {
  const show = rows("SELECT * FROM items WHERE kind = 'show' AND title = 'Far Show'")[0];
  const season = rows("SELECT * FROM items WHERE kind = 'season' AND parent_id = ?", show.id)[0];
  assert.equal(season.season, 1);
  const eps = rows("SELECT * FROM items WHERE kind = 'episode' AND parent_id = ? ORDER BY episode", season.id);
  assert.deepEqual(eps.map((e) => [e.episode, e.show_id, e.min_age]), [[1, show.id, 0], [2, show.id, 0]]);
  assert.equal(eps[0].duration, 1200);
});

test('a Jellyfin title keeps its DateCreated as added_at; Recently added shows the server\'s recent titles first', async () => {
  assert.equal(rows("SELECT added_at FROM items WHERE title = 'Alien'")[0].added_at, Date.parse('2020-01-01T00:00:00Z'));
  const home = (await admin.get('/api/home')).data;
  const row = home.rows.find((r) => r.id === `recent-${ids.movies}`);
  const titles = row.items.map((i) => i.title);
  assert.ok(titles.indexOf('Cartoon') < titles.indexOf('Alien'), titles.join(','));
});

test('an item synced before 0.12 (remote_updated null) gets its server date once, then never moves', async () => {
  const db = nf.app.core.db;
  db.run("UPDATE items SET added_at = ?, remote_updated = NULL WHERE title = 'Alien'", Date.now());
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT added_at FROM items WHERE title = 'Alien'")[0].added_at, Date.parse('2020-01-01T00:00:00Z'));
  jf.state.movies.find((m) => m.Id === 'm1').DateCreated = '2021-06-01T00:00:00Z';
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT added_at FROM items WHERE title = 'Alien'")[0].added_at, Date.parse('2020-01-01T00:00:00Z'), 'never moves again');
  jf.state.movies.find((m) => m.Id === 'm1').DateCreated = '2020-01-01T00:00:00.0000000Z';
});

test('a changed ImageTags.Primary gives a new poster URL, bumps metadata_at, and the old cached file is forgotten', async () => {
  const images = nf.app.core.images;
  const before = rows("SELECT id, poster, metadata_at FROM items WHERE title = 'Alien'")[0];
  assert.equal((await admin.raw(`/api/items/${before.id}/image/poster`)).status, 200);
  assert.ok(images.cachedFor(before.poster), 'cached');
  jf.state.movies.find((m) => m.Id === 'm1').ImageTags = { Primary: 'z' };
  await new Promise((r) => setTimeout(r, 5));
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  const after = rows("SELECT poster, metadata_at FROM items WHERE title = 'Alien'")[0];
  assert.match(after.poster, /\?tag=z$/);
  assert.ok(after.metadata_at > before.metadata_at);
  assert.equal(images.cachedFor(before.poster), null, 'the old picture is gone from the cache');
  jf.state.movies.find((m) => m.Id === 'm1').ImageTags = { Primary: 'x' };
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
});

test('a second sync prunes what the server no longer has', async () => {
  jf.state.movies = jf.state.movies.filter((m) => m.Id !== 'm2');
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE title = 'Cartoon'")[0].n, 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE title = 'Alien'")[0].n, 1);
  assert.ok(rows('SELECT last_sync FROM servers WHERE id = ?', ids.server)[0].last_sync > now);
  jf.state.movies.push(jfMovie('m2', 'Cartoon', { OfficialRating: 'NZ-G' }));
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
});

test('a server that suddenly lists nothing keeps the titles (and says so) instead of pruning them all', async () => {
  const before = rows("SELECT COUNT(*) AS n FROM items WHERE library_id = ?", ids.movies)[0].n;
  assert.ok(before > 0);
  jf.state.emptyItems = true;
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  const st = await waitForScan(admin);
  jf.state.emptyItems = false;
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE library_id = ?", ids.movies)[0].n, before, 'nothing pruned');
  assert.match(st.error || '', /listed nothing|no titles/i);
});

test('a sync that changes nothing leaves metadata_at (and so the poster URLs) alone', async () => {
  const alien = () => rows("SELECT metadata_at, updated_at FROM items WHERE title = 'Alien'")[0];
  const was = alien();
  await new Promise((r) => setTimeout(r, 5));
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(alien().metadata_at, was.metadata_at, 'unchanged title, unchanged stamp');
  jf.state.movies.find((m) => m.Id === 'm1').Overview = 'A changed overview';
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  await waitForScan(admin);
  assert.equal(rows("SELECT overview FROM items WHERE title = 'Alien'")[0].overview, 'A changed overview');
  assert.ok(alien().metadata_at > was.metadata_at, 'a change bumps it');
});

test('an unreachable server leaves the library as it was and marks the server', async () => {
  const db = nf.app.core.db;
  const before = rows("SELECT COUNT(*) AS n FROM items WHERE library_id = ?", ids.movies)[0].n;
  db.run("UPDATE servers SET url = 'http://127.0.0.1:1' WHERE id = ?", ids.server);
  await admin.post(`/api/libraries/${ids.movies}/scan`, {});
  const st = await waitForScan(admin);
  assert.equal(rows("SELECT COUNT(*) AS n FROM items WHERE library_id = ?", ids.movies)[0].n, before);
  assert.equal(rows('SELECT status FROM servers WHERE id = ?', ids.server)[0].status, 'unreachable');
  assert.match(st.error || '', /Fake Jellyfin/);
  db.run('UPDATE servers SET url = ? WHERE id = ?', jf.url, ids.server);
});

test('local-only jobs skip remote titles', async () => {
  const store = nf.app.core.extras;
  assert.equal(store.nextPreviewItem(), null);
  assert.equal(store.nextIntroSeason(), null);
  assert.deepEqual(await nf.app.core.metadata.enrichMissing(), { done: 0 });
});

test('remoteSyncHours schedules remote libraries apart from folder ones', async () => {
  const scanner = nf.app.core.scanner;
  nf.app.core.settings.set({ scanIntervalMinutes: 0, remoteSyncHours: 6 });
  scanner.schedule();
  assert.ok(scanner.remoteTimer, 'a remote timer');
  assert.ok(!scanner.timer, 'no folder timer');
  nf.app.core.settings.set({ remoteSyncHours: 0 });
  scanner.schedule();
  assert.ok(!scanner.remoteTimer);
  // Through the settings API: clamped, and the timer follows without a restart.
  const saved = (await admin.put('/api/admin/settings', { remoteSyncHours: 999 })).data;
  assert.equal(saved.remoteSyncHours, 168, 'at most a week');
  assert.ok(scanner.remoteTimer, 'rescheduled on change');
  await admin.put('/api/admin/settings', { remoteSyncHours: 0 });
  assert.ok(!scanner.remoteTimer);
  await admin.put('/api/admin/settings', { remoteSyncHours: 6 });
});

test('a kids profile sees the G-rated remote film and not the R16 one; an unknown rating follows allowUnrated', async () => {
  const titles = async () => (await kid.get(`/api/libraries/${ids.movies}/items`)).data.items.map((i) => i.title).sort();
  assert.deepEqual(await titles(), ['Cartoon']);
  await admin.patch(`/api/profiles/${ids.mia}`, { allowUnrated: true });
  assert.deepEqual(await titles(), ['Cartoon', 'Mystery'], 'TV-MA is rated 17, never unrated');
  await admin.patch(`/api/profiles/${ids.mia}`, { allowUnrated: false });
});

test('download, refresh and identify answer 400 for a remote title; the item says it is remote', async () => {
  const alien = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items.find((i) => i.title === 'Alien');
  const page = (await admin.get(`/api/items/${alien.id}`)).data;
  assert.equal(page.item.remote, true);
  assert.equal(page.item.fileName, null, 'the remote: path is not a file name');
  assert.equal(page.item.serverName, 'Fake Jellyfin');
  assert.ok(Array.isArray(page.subtitles), 'embedded subtitle tracks only');
  assert.equal((await admin.get(`/api/items/${alien.id}/download`)).status, 400);
  assert.equal((await admin.post(`/api/items/${alien.id}/refresh`, {})).status, 400);
  assert.equal((await admin.post(`/api/items/${alien.id}/identify`, { tmdbId: 1 })).status, 400);
});

test('serializeLibrary carries the server name', async () => {
  const libs = (await admin.get('/api/libraries')).data;
  const movies = libs.find((l) => l.id === ids.movies);
  assert.deepEqual([movies.serverId, movies.serverName, movies.remoteId], [ids.server, 'Fake Jellyfin', 'lib-m']);
});
