// Reading on the server (v0.22 Plan D Task 4): an EPUB's files with a script-free policy, comic pages (big ones scaled
// once), the place in a book or comic (with the device it was read on), Continue reading, stats, search, reading
// lists and downloads (a CBR arrives as a CBZ).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, tempDir, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { writeStoredZip } from '../src/books/zip-write.js';
import { openZip } from '../src/books/zip.js';
import { imageSize } from '../src/books/image-size.js';
import { makeEpub } from './helpers-books.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const FAKE_7Z = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-7z.mjs');
const media = tempDir();
let nf;
let admin;
let mia;
const ids = {};
const CAPS = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'] };

before(async () => {
  if (!hasFfmpeg) return;
  const pic = path.join(media, 'p.jpg');
  makeImage(pic, 'green', '300x450');
  const big = path.join(media, 'big.jpg');
  makeImage(big, 'blue', '300x4500');
  await makeEpub(path.join(media, 'Books', 'Sea Story.epub'), { title: 'Sea Story', author: 'Ann Author', cover: pic });
  await makeEpub(path.join(media, 'Books', 'Dark Book.epub'), { title: 'Dark Book', author: 'Dee Dark' });
  const info = (f) => ({ name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo>${Object.entries(f).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</ComicInfo>`) });
  fs.mkdirSync(path.join(media, 'Comics', 'Tall'), { recursive: true });
  await writeStoredZip(path.join(media, 'Comics', 'Tall', 'Tall 1.cbz'), [{ name: '01.jpg', file: pic }, { name: '02.jpg', file: big }, { name: '03.jpg', file: pic }, info({ Series: 'Tall', Number: '1', AgeRating: 'Everyone' })]);
  await writeStoredZip(path.join(media, 'Comics', 'Tall', 'Tall 2.cbz'), [{ name: '01.jpg', file: pic }, info({ Series: 'Tall', Number: '2', AgeRating: 'Everyone' })]);
  await writeStoredZip(path.join(media, 'Comics', 'Tall', 'Tall 3.cbz'), [{ name: '01.jpg', file: pic }, info({ Series: 'Tall', Number: '3', AgeRating: 'Adults Only 18+' })]);
  const rar = path.join(media, 'Comics', 'Night', 'Night 1.cbr');
  fs.mkdirSync(path.dirname(rar), { recursive: true });
  fs.writeFileSync(rar, 'Rar! (a stand-in)');
  const b64 = fs.readFileSync(pic).toString('base64');
  fs.writeFileSync(`${rar}.json`, JSON.stringify({ entries: { '01.jpg': b64, '02.jpg': b64 } }));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.put('/api/admin/settings', { archiveToolPath: FAKE_7Z });
  ids.books = (await admin.post('/api/libraries', { name: 'Books', type: 'books', paths: [path.join(media, 'Books')] })).data.id;
  ids.comics = (await admin.post('/api/libraries', { name: 'Comics', type: 'comics', paths: [path.join(media, 'Comics')] })).data.id;
  await waitForScan(admin);
  for (const r of nf.app.core.db.all("SELECT i.id, i.title, i.issue, s.title AS series FROM items i LEFT JOIN items s ON s.id = i.show_id WHERE i.kind IN ('book', 'comic')")) ids[r.series ? `${r.series} ${r.issue}` : r.title] = r.id;
  await admin.patch(`/api/items/${ids['Dark Book']}/details`, { changes: { certification: 'R18' } });
  const p = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', allowUnrated: true })).data;
  mia = client(nf.base);
  await mia.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await mia.post(`/api/profiles/${p.id}/select`, {});
});

after(async () => {
  await nf?.app.stop();
});

test('a chapter answers with the script-free CSP and nosniff', { skip }, async () => {
  const r = await admin.raw(`/api/books/${ids['Sea Story']}/file/OEBPS/text/ch1.xhtml`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/xhtml\+xml/);
  const csp = r.headers.get('content-security-policy');
  const own = `${nf.base}/api/books/${ids['Sea Story']}/file/`;
  for (const part of ["default-src 'none'", `img-src ${own} data:`, `style-src ${own} 'unsafe-inline'`, `font-src ${own}`, "script-src 'none'", "form-action 'none'", "frame-src 'none'", 'sandbox allow-same-origin']) assert.ok(csp.includes(part), `${part} in ${csp}`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await r.text(), /Chapter One/);
  const pic = await admin.raw(`/api/books/${ids['Sea Story']}/file/OEBPS/images/cover.jpg`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
});

test("a name outside the book's index is 404, including ../ and %2e%2e", { skip }, async () => {
  const id = ids['Sea Story'];
  for (const p of ['OEBPS/text/missing.xhtml', '..%2F..%2Fetc%2Fpasswd', '%2e%2e/%2e%2e/etc/passwd', 'OEBPS/..%2F..%2Fsecret']) {
    assert.equal((await admin.raw(`/api/books/${id}/file/${p}`)).status, 404, p);
  }
  assert.equal((await admin.raw(`/api/books/${ids['Tall 1']}/file/01.jpg`)).status, 404, 'a comic is not a book');
  assert.equal((await mia.raw(`/api/books/${ids['Dark Book']}/file/OEBPS/text/ch1.xhtml`)).status, 404, "Mia can't open a book above her age");
});

test('a big comic page is scaled once; ?full=1 gives the original', { skip }, async () => {
  const url = `/api/comics/${ids['Tall 1']}/pages/1`;
  const r = await admin.raw(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  const scaled = imageSize(Buffer.from(await r.arrayBuffer()));
  assert.equal(Math.max(scaled.width, scaled.height), 2400);
  const dir = path.join(nf.app.core.config.cacheDir, 'comic-pages');
  const cached = fs.readdirSync(dir);
  assert.equal(cached.length, 1, 'kept once');
  await admin.raw(url);
  assert.deepEqual(fs.readdirSync(dir), cached, 'and not made again');
  const full = imageSize(Buffer.from(await (await admin.raw(`${url}?full=1`)).arrayBuffer()));
  assert.equal(full.height, 4500);
  const small = imageSize(Buffer.from(await (await admin.raw(`/api/comics/${ids['Tall 1']}/pages/0`)).arrayBuffer()));
  assert.deepEqual(small, { width: 300, height: 450 });
  assert.equal((await admin.raw(`/api/comics/${ids['Tall 1']}/pages/3`)).status, 404);
  const rar = await admin.raw(`/api/comics/${ids['Night 1']}/pages/1`);
  assert.equal(rar.status, 200, 'a CBR page through 7-Zip');
  assert.equal((await mia.raw(`/api/comics/${ids['Tall 3']}/pages/0`)).status, 404);
});

test('progress keeps the locator and the device; past the last page is Read; 99% is not', { skip }, async () => {
  const id = ids['Sea Story'];
  const send = (b) => admin.post(`/api/items/${id}/progress`, b);
  assert.equal((await send({ position: 42, duration: 100, locator: { chapter: 2, offset: 120 }, device: 'phone' })).status, 200);
  let p = (await admin.get(`/api/items/${id}`)).data.item.progress;
  assert.deepEqual([p.position, p.locator, p.device, p.watched], [42, { chapter: 2, offset: 120 }, 'phone', false]);
  assert.equal(typeof p.updatedAt, 'number');
  await send({ position: 99, duration: 100, locator: { chapter: 3, offset: 9000 }, device: 'tablet' });
  p = (await admin.get(`/api/items/${id}`)).data.item.progress;
  assert.equal(p.watched, false);
  assert.equal(p.device, 'tablet');
  await send({ position: 100, duration: 100, locator: { chapter: 3, offset: 9999 }, device: 'tablet', watched: true });
  assert.equal((await admin.get(`/api/items/${id}`)).data.item.progress.watched, true);
  // Odd values are not kept: an unknown device, a locator that isn't one.
  await send({ position: 10, duration: 100, locator: 'x'.repeat(5000), device: 'toaster' });
  p = (await admin.get(`/api/items/${id}`)).data.item.progress;
  assert.deepEqual([p.locator, p.device], [null, null]);
  const c = ids['Tall 1'];
  await admin.post(`/api/items/${c}/progress`, { position: 1, duration: 3, locator: { page: 1 }, device: 'computer' });
  p = (await admin.get(`/api/items/${c}`)).data.item.progress;
  assert.deepEqual([p.position, p.duration, p.locator], [1, 3, { page: 1 }]);
});

test('Continue reading follows the Kids rules', { skip }, async () => {
  const continued = async (c) => (await c.get('/api/home')).data.rows.find((r) => r.key === 'continue-reading')?.items.map((i) => i.title) || [];
  // dallas read Tall 1 to the end, has Tall 3 (18) open, Dark Book (R18) open.
  await admin.post(`/api/items/${ids['Tall 1']}/progress`, { position: 3, duration: 3, locator: { page: 2 }, watched: true });
  await admin.post(`/api/items/${ids['Dark Book']}/progress`, { position: 20, duration: 100, locator: { chapter: 1, offset: 0 } });
  const mine = await continued(admin);
  assert.ok(mine.includes('Dark Book'), JSON.stringify(mine));
  assert.ok(mine.some((t) => /Tall 2/.test(t)), `the next issue after a finished one: ${JSON.stringify(mine)}`);
  // Mia: her own place in Dark Book (written straight to the database) never shows; nor Tall 3.
  const miaId = nf.app.core.db.get("SELECT id FROM profiles WHERE name = 'Mia'").id;
  nf.app.core.db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 20, 100, 0, ?)', miaId, ids['Dark Book'], Date.now());
  nf.app.core.db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 3, 3, 1, ?)', miaId, ids['Tall 2'], Date.now());
  const hers = await continued(mia);
  assert.ok(!hers.includes('Dark Book') && !hers.some((t) => /Tall 3/.test(t)), JSON.stringify(hers));
});

test('stats count pages and time read', { skip }, async () => {
  const { plays } = nf.app.core;
  const real = plays.now;
  let t = Date.now();
  plays.now = () => t;
  try {
    const id = ids['Sea Story'];
    await admin.post(`/api/items/${id}/progress`, { position: 1, duration: 100, locator: { chapter: 0, offset: 0 }, pages: 0 });
    t += 100_000;
    await admin.post(`/api/items/${id}/progress`, { position: 3, duration: 100, locator: { chapter: 0, offset: 900 }, pages: 4 });
    t += 100_000;
    await admin.post(`/api/items/${id}/progress`, { position: 5, duration: 100, locator: { chapter: 0, offset: 1800 }, pages: 3 });
  } finally {
    plays.now = real;
  }
  const s = (await admin.get('/api/me/stats?range=week')).data;
  assert.equal(s.pagesRead, 7);
  assert.equal(s.readHours, 0.1, '200 s read (a gap over 2 minutes would count as 2 minutes)');
});

test('search finds books and comics within the rules', { skip }, async () => {
  assert.deepEqual((await admin.get('/api/search?q=Sea')).data.books.map((b) => b.title), ['Sea Story']);
  assert.deepEqual((await admin.get('/api/search?q=Dark')).data.books.map((b) => b.title), ['Dark Book']);
  assert.deepEqual((await mia.get('/api/search?q=Dark')).data.books, []);
  const comics = (await admin.get('/api/search?q=Tall')).data.comics.map((c) => c.title);
  assert.ok(comics.includes('Tall'), `the series: ${JSON.stringify(comics)}`);
  assert.ok(!(await mia.get('/api/search?q=Tall 3')).data.comics.some((c) => c.id === ids['Tall 3']));
});

test('a reading list takes books and comics, not films', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'reading', name: 'To read' })).data;
  assert.equal(list.kind, 'reading');
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids['Sea Story'] })).status, 204);
  assert.equal((await admin.post(`/api/lists/${list.id}/items`, { itemId: ids['Tall 2'] })).status, 204);
  const songs = (await admin.post('/api/lists', { kind: 'music', name: 'Songs' })).data;
  const r = await admin.post(`/api/lists/${songs.id}/items`, { itemId: ids['Sea Story'] });
  assert.equal(r.status, 400);
});

async function ready(jobId) {
  for (let i = 0; i < 100; i++) {
    const [j] = (await admin.get(`/api/downloads/jobs?ids=${jobId}`)).data;
    if (j?.status === 'ready') return j;
    if (j?.status === 'failed') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('not ready');
}

test('a CBR downloads as a CBZ that openZip reads; an EPUB downloads as itself', { skip }, async () => {
  const calls = path.join(media, 'Comics', 'Night', 'Night 1.cbr.calls');
  const before = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0;
  const d = (await admin.post('/api/downloads', { itemIds: [ids['Night 1'], ids['Sea Story']], caps: CAPS })).data;
  assert.deepEqual(d.items.map((i) => i.format), ['cbz', 'epub']);
  await ready(d.items[0].jobId);
  const cbz = path.join(media, 'got.cbz');
  fs.writeFileSync(cbz, Buffer.from(await (await admin.raw(`/api/downloads/${d.items[0].jobId}/file`)).arrayBuffer()));
  const z = await openZip(cbz);
  assert.deepEqual([...z.entries.keys()], ['01.jpg', '02.jpg']);
  await z.close();
  const made = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).slice(before);
  assert.deepEqual(made, ['l', 'x'], 'its list (for the names) and one extraction for the whole comic, not one run per page');
  assert.equal(fs.readdirSync(path.join(nf.app.core.config.cacheDir)).filter((n) => n.startsWith('pack-')).length, 0, 'the extracted pages are gone');
  await ready(d.items[1].jobId);
  const epub = Buffer.from(await (await admin.raw(`/api/downloads/${d.items[1].jobId}/file`)).arrayBuffer());
  assert.ok(epub.equals(fs.readFileSync(path.join(media, 'Books', 'Sea Story.epub'))), 'the book as it is');
});
