// Home you can arrange (v0.22) over HTTP: the household default, a profile's own copy, reset, who may change what;
// pinned rows (Task 2) and web apps (Task 3) join below.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeImage, startAtomix, client, waitForScan, fakeServer } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin; // dallas, adult admin
let kid; // Mia, kids profile on dallas's account
let guest; // another account
let site; // a web site with a picture and a page labelled one
const ids = {};
const keys = async (c) => (await c.get('/api/home')).data.rows.map((r) => r.key);

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  for (const [folder, rating, genre] of [['Cartoon (2020)', 'NZ:G', 'Animation'], ['Scary (2018)', 'R16', 'Horror'], ['Spooky (2019)', 'R16', 'Horror']]) {
    makeVideo(path.join(m, folder, `${folder}.mp4`), { seconds: 1 });
    fs.writeFileSync(path.join(m, folder, `${folder}.nfo`), `<movie><title>${folder.replace(/ \(\d+\)$/, '')}</title><mpaa>${rating}</mpaa><genre>${genre}</genre></movie>`);
  }
  const png = path.join(media, 'logo.png');
  makeImage(png, 'blue', '64x64');
  site = await fakeServer((req, res) => {
    if (req.url === '/logo.png') return res.writeHead(200, { 'content-type': 'image/png' }), res.end(fs.readFileSync(png));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>a page, not a picture</html>');
  });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title] = it.id;
  await admin.put(`/api/watchlist/${ids.Cartoon}`);
  ids.list = (await admin.post('/api/lists', { kind: 'video', name: 'Friday' })).data.id;
  await admin.post(`/api/lists/${ids.list}/items`, { itemId: ids.Cartoon });
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  ids.mia = mia.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
});

after(async () => {
  await nf?.app.stop();
  await site?.close();
});

test('/api/home rows carry key', { skip }, async () => {
  const rows = (await admin.get('/api/home')).data.rows;
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.equal(typeof r.key, 'string', JSON.stringify(r.title));
  assert.ok(rows.some((r) => r.key === `recent-${ids.movies}`));
});

test('a profile follows the household until it changes something, and Reset brings the household back', { skip }, async () => {
  assert.equal((await admin.get('/api/home/layout')).data.source, 'default');
  assert.equal((await admin.put('/api/admin/home-layout', { layout: { order: [{ key: 'lists' }, { key: 'watchlist' }, { key: `recent-${ids.movies}` }] } })).status, 200);
  let got = (await admin.get('/api/home/layout')).data;
  assert.equal(got.source, 'household');
  // The editor lists every row (Continue watching and listening too, empty here: nothing placed before them, so they stay first).
  assert.deepEqual(got.rows.map((r) => r.key).filter((k) => !k.startsWith('continue')).slice(0, 3), ['lists', 'watchlist', `recent-${ids.movies}`]);
  assert.deepEqual((await keys(admin)).slice(0, 3), ['lists', 'watchlist', `recent-${ids.movies}`]);
  assert.equal((await admin.put('/api/home/layout', { layout: { order: [{ key: 'watchlist' }, { key: 'lists', hidden: true }] } })).status, 200);
  got = (await admin.get('/api/home/layout')).data;
  assert.equal(got.source, 'profile');
  assert.equal(got.rows.find((r) => r.key === 'lists').hidden, true, 'hidden rows are still listed for the editor');
  assert.ok(!(await keys(admin)).includes('lists'));
  assert.equal((await admin.del('/api/home/layout')).status, 200);
  assert.equal((await admin.get('/api/home/layout')).data.source, 'household');
  assert.equal((await keys(admin))[0], 'lists');
  await admin.put('/api/admin/home-layout', { layout: null });
});

test("household changes don't move a profile's own order", { skip }, async () => {
  await admin.put('/api/home/layout', { layout: { order: [{ key: 'lists' }, { key: `recent-${ids.movies}` }] } });
  await admin.put('/api/admin/home-layout', { layout: { order: [{ key: `recent-${ids.movies}` }, { key: 'lists' }, { key: 'watchlist' }] } });
  const k = await keys(admin);
  // The profile's own order stands; the Watchlist (not in the profile's copy) goes to its default place: it is built
  // before Playlists with nothing placed ahead of it, so it comes first.
  assert.deepEqual(k.slice(0, 3), ['watchlist', 'lists', `recent-${ids.movies}`]);
  await admin.del('/api/home/layout');
  await admin.put('/api/admin/home-layout', { layout: null });
});

test('only admins set the household; a Kids profile arranges its own', { skip }, async () => {
  const layout = { order: [{ key: 'watchlist' }] };
  assert.equal((await kid.put('/api/admin/home-layout', { layout })).status, 403);
  assert.equal((await guest.put('/api/admin/home-layout', { layout })).status, 403);
  assert.equal((await kid.put('/api/home/layout', { layout })).status, 200);
  assert.equal((await kid.get('/api/home/layout')).data.source, 'profile');
  assert.equal((await admin.get('/api/home/layout')).data.source, 'default', "Mia's copy is hers");
  await kid.del('/api/home/layout');
});

test('a bad layout is refused before saving', { skip }, async () => {
  const many = { order: Array.from({ length: 81 }, (_, i) => ({ key: `k${i}` })) };
  assert.equal((await admin.put('/api/home/layout', { layout: many })).status, 400);
  assert.equal((await admin.put('/api/home/layout', { layout: { order: [{ key: 'x'.repeat(81) }] } })).status, 400);
  assert.equal((await admin.get('/api/home/layout')).data.source, 'default');
});

// ---- Pinned rows (Task 2) ----
const pinned = async (c, key) => (await c.get('/api/home')).data.rows.find((r) => r.key === key);

test('a pinned genre row shows only that genre, titled "<Genre> in <Library>"', { skip }, async () => {
  const pin = { key: 'pin-0a1b2c3d', type: 'genre', libraryId: ids.movies, genre: 'Horror' };
  // The editor saves every row's place, the pin first here.
  const order = [{ key: pin.key }, { key: 'continue' }, { key: 'watchlist' }, { key: 'lists' }, { key: `recent-${ids.movies}` }];
  assert.equal((await admin.put('/api/home/layout', { layout: { order, pins: [pin] } })).status, 200);
  const row = await pinned(admin, pin.key);
  assert.equal(row.title, 'Horror in Movies');
  assert.deepEqual(row.items.map((i) => i.title).sort(), ['Scary', 'Spooky']);
  assert.equal((await admin.get('/api/home')).data.rows[0].key, pin.key, 'placed where the arrangement says');
  await admin.del('/api/home/layout');
});

test("a pinned row keeps a Kids profile's rules", { skip }, async () => {
  const pin = { key: 'pin-1a2b3c4d', type: 'library', libraryId: ids.movies, sort: 'added' };
  assert.equal((await kid.put('/api/home/layout', { layout: { order: [{ key: pin.key }], pins: [pin] } })).status, 200);
  const row = await pinned(kid, pin.key);
  assert.equal(row.title, 'Recently added in Movies');
  assert.deepEqual(row.items.map((i) => i.title), ['Cartoon']);
  // The household pins a Horror row: Mia (following the household) gets no row at all, not an empty one.
  await kid.del('/api/home/layout');
  const horror = { key: 'pin-2a2b3c4d', type: 'genre', libraryId: ids.movies, genre: 'Horror' };
  await admin.put('/api/admin/home-layout', { layout: { order: [{ key: horror.key }], pins: [horror] } });
  assert.equal(await pinned(kid, horror.key), undefined);
  assert.ok(await pinned(admin, horror.key));
  await admin.put('/api/admin/home-layout', { layout: null });
});

test('a pinned playlist that goes away disappears, and the editor lists it as not available', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'video', name: 'Gone soon' })).data;
  await admin.post(`/api/lists/${list.id}/items`, { itemId: ids.Cartoon });
  const pin = { key: 'pin-3a2b3c4d', type: 'list', listId: list.id };
  assert.equal((await admin.put('/api/home/layout', { layout: { order: [{ key: pin.key }], pins: [pin] } })).status, 200);
  assert.equal((await pinned(admin, pin.key)).title, 'Gone soon');
  await admin.del(`/api/lists/${list.id}`);
  assert.equal(await pinned(admin, pin.key), undefined);
  const ed = (await admin.get('/api/home/layout')).data.rows.find((r) => r.key === pin.key);
  assert.deepEqual({ title: ed.title, unavailable: ed.unavailable }, { title: 'Not available', unavailable: true });
  await admin.del('/api/home/layout');
});

test("a pin the profile can't see is refused", { skip }, async () => {
  const pin = { key: 'pin-4a2b3c4d', type: 'list', listId: ids.list }; // dallas's own, not shared
  const res = await kid.put('/api/home/layout', { layout: { order: [{ key: pin.key }], pins: [pin] } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "That playlist isn't available to this profile.");
  const bad = await admin.put('/api/home/layout', { layout: { order: [], pins: [{ key: 'pin-5a2b3c4d', type: 'library', libraryId: ids.movies, sort: 'loudest' }] } });
  assert.equal(bad.status, 400, 'an unknown sort');
  assert.equal((await admin.put('/api/home/layout', { layout: { order: [], pins: [{ key: 'nope', type: 'list', listId: ids.list }] } })).status, 400, 'a pin key must be pin-<hex>');
});

// ---- Web apps (Task 3) ----
test("web apps are admins' to add, and show as a row", { skip }, async () => {
  assert.equal((await guest.post('/api/admin/web-apps', { name: 'Nope', url: 'https://example.com/' })).status, 403);
  assert.equal((await kid.post('/api/admin/web-apps', { name: 'Nope', url: 'https://example.com/' })).status, 403);
  const r = await admin.post('/api/admin/web-apps', { name: 'ReelShort', url: 'https://www.reelshort.com/', imageUrl: `${site.url}/logo.png` });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'ReelShort');
  assert.match(r.data.image, /^\/api\/web-apps\/\d+\/image$/);
  const row = (await admin.get('/api/home')).data.rows.find((x) => x.key === 'web-apps');
  assert.equal(row.title, 'Web apps');
  assert.equal(row.style, 'apps');
  assert.deepEqual(row.items.map((a) => [a.name, a.url]), [['ReelShort', 'https://www.reelshort.com/']]);
  const img = await admin.raw(r.data.image);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\/png/);
  assert.ok(!(await guest.get('/api/home')).data.rows.find((x) => x.key === 'web-apps').items[0].url.includes(site.url), 'only the site address, never the picture source');
  await admin.del(`/api/admin/web-apps/${r.data.id}`);
});

test('a javascript: address is refused', { skip }, async () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'example.com']) {
    const r = await admin.post('/api/admin/web-apps', { name: 'Bad', url });
    assert.equal(r.status, 400, url);
    assert.equal(r.data.error, 'Web app addresses start with https:// or http://.');
  }
});

test('Kids see only Kids web apps; their pictures too', { skip }, async () => {
  const a = (await admin.post('/api/admin/web-apps', { name: 'Grown', url: 'https://grown.example/', imageUrl: `${site.url}/logo.png` })).data;
  const b = (await admin.post('/api/admin/web-apps', { name: 'Cartoons', url: 'https://kids.example/', kids: true })).data;
  const row = (await kid.get('/api/home')).data.rows.find((x) => x.key === 'web-apps');
  assert.deepEqual(row.items.map((x) => x.name), ['Cartoons']);
  assert.equal((await kid.raw(a.image)).status, 404, "a grown-up app's picture isn't served to Mia");
  assert.equal((await kid.get('/api/admin/web-apps')).status, 403);
  await admin.del(`/api/admin/web-apps/${a.id}`);
  await admin.del(`/api/admin/web-apps/${b.id}`);
  assert.ok(!(await admin.get('/api/home')).data.rows.some((x) => x.key === 'web-apps'), 'no apps, no row');
});

test("a picture that isn't a picture is dropped (the app is still saved)", { skip }, async () => {
  const r = await admin.post('/api/admin/web-apps', { name: 'Odd', url: 'https://odd.example/', imageUrl: `${site.url}/page.png` });
  assert.equal(r.status, 200);
  assert.equal(r.data.image, null);
  assert.equal(typeof r.data.imageError, 'string');
  const listed = (await admin.get('/api/admin/web-apps')).data.find((x) => x.id === r.data.id);
  assert.equal(listed.imageError, undefined, 'the error is only in the answer to the admin who saved it');
  await admin.del(`/api/admin/web-apps/${r.data.id}`);
});

// ---- The household editor (Task 4) ----
test("the household editor lists the household's arrangement; only for admins", { skip }, async () => {
  await admin.put('/api/home/layout', { layout: { order: [{ key: 'lists' }, { key: 'watchlist' }] } });
  await admin.put('/api/admin/home-layout', { layout: { order: [{ key: 'watchlist', hidden: true }, { key: 'lists' }] } });
  const got = (await admin.get('/api/home/layout?scope=household')).data;
  assert.equal(got.source, 'household');
  const k = got.rows.map((r) => r.key).filter((x) => x === 'lists' || x === 'watchlist');
  assert.deepEqual(k, ['watchlist', 'lists'], "the household's order, not dallas's own");
  assert.equal(got.rows.find((r) => r.key === 'watchlist').hidden, true);
  assert.equal((await kid.get('/api/home/layout?scope=household')).status, 403);
  await admin.del('/api/home/layout');
  await admin.put('/api/admin/home-layout', { layout: null });
});

// ---- Final review fixes ----
test("a pin the viewer can't see doesn't block saving the rest (Kids following a household pin of a private list)", { skip }, async () => {
  const pin = { key: 'pin-6a2b3c4d', type: 'list', listId: ids.list }; // dallas's own, unshared playlist
  await admin.put('/api/admin/home-layout', { layout: { order: [{ key: pin.key }, { key: 'watchlist' }, { key: `recent-${ids.movies}` }], pins: [pin] } });
  const ed = (await kid.get('/api/home/layout')).data;
  const row = ed.rows.find((r) => r.key === pin.key);
  assert.deepEqual({ unavailable: row.unavailable, hidden: row.hidden }, { unavailable: true, hidden: false }, 'unavailable, not turned into hidden');
  // Mia moves a row: the editor sends every row and pin back, the household's pin included.
  const order = ed.rows.map((r) => ({ key: r.key, hidden: r.hidden })).reverse();
  const res = await kid.put('/api/home/layout', { layout: { order, pins: ed.layout.pins } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  await kid.del('/api/home/layout');
  await admin.put('/api/admin/home-layout', { layout: null });
});

test('a saved pin whose playlist went away does not block moving the others', { skip }, async () => {
  const gone = (await admin.post('/api/lists', { kind: 'video', name: 'Short-lived' })).data;
  await admin.post(`/api/lists/${gone.id}/items`, { itemId: ids.Cartoon });
  const a = { key: 'pin-7a2b3c4d', type: 'list', listId: gone.id };
  const b = { key: 'pin-8a2b3c4d', type: 'list', listId: ids.list };
  await admin.put('/api/home/layout', { layout: { order: [{ key: a.key }, { key: b.key }], pins: [a, b] } });
  await admin.del(`/api/lists/${gone.id}`);
  const res = await admin.put('/api/home/layout', { layout: { order: [{ key: b.key }, { key: a.key }], pins: [a, b] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const fresh = { key: 'pin-9a2b3c4d', type: 'list', listId: gone.id };
  assert.equal((await admin.put('/api/home/layout', { layout: { order: [], pins: [a, b, fresh] } })).status, 400, 'a new pin of something gone is still refused');
  await admin.del('/api/home/layout');
});

test('a pinned row the household adds reaches profiles with their own arrangement; one a profile removed stays gone', { skip }, async () => {
  await admin.put('/api/home/layout', { layout: { order: [{ key: 'lists' }, { key: 'watchlist' }] } });
  const random = { key: 'pin-aa2b3c4d', type: 'library', libraryId: ids.movies, sort: 'random' };
  await admin.put('/api/admin/home-layout', { layout: { order: [{ key: random.key }], pins: [random] } });
  assert.ok((await keys(admin)).includes(random.key), "the household's new pin reaches dallas's own arrangement");
  // dallas removes it in his editor (the save leaves it out).
  const ed = (await admin.get('/api/home/layout')).data;
  await admin.put('/api/home/layout', { layout: { order: ed.rows.filter((r) => r.key !== random.key).map((r) => ({ key: r.key })), pins: [] } });
  assert.ok(!(await keys(admin)).includes(random.key), 'removed stays removed');
  const added = { key: 'pin-bb2b3c4d', type: 'library', libraryId: ids.movies, sort: 'added' };
  await admin.put('/api/admin/home-layout', { layout: { order: [{ key: random.key }, { key: added.key }], pins: [random, added] } });
  const k = await keys(admin);
  assert.ok(k.includes(added.key) && !k.includes(random.key), JSON.stringify(k));
  await admin.del('/api/home/layout');
  await admin.put('/api/admin/home-layout', { layout: null });
});
