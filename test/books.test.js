// Books (v0.22 Plan D Task 2): an EPUB's metadata, table of contents and cover; series from calibre or EPUB 3
// collections (a book without one stands alone); a damaged file is skipped, not fatal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { makeEpub } from './helpers-books.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const root = path.join(media, 'Books');
let nf;
let admin;
let lib;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const pic = path.join(media, 'cover.jpg');
  makeImage(pic, 'blue', '300x450');
  await makeEpub(path.join(root, 'Ann Author', 'Sea Story.epub'), { title: 'Sea Story', author: 'Ann Author', description: 'A tale of the sea.', language: 'en-NZ', date: '2018-05-01', cover: pic });
  await makeEpub(path.join(root, 'Old Book.epub'), { title: 'Old Book', author: 'Ed Old', ncx: true, cover: pic, chapters: ['Start', 'End'] });
  await makeEpub(path.join(root, 'Corey', 'Leviathan Wakes.epub'), { title: 'Leviathan Wakes', author: 'James Corey', series: 'The Expanse', seriesIndex: '1' });
  await makeEpub(path.join(root, 'Corey', 'Calibans War.epub'), { title: "Caliban's War", author: 'James Corey', collection: { name: 'The Expanse', position: '2' } });
  fs.writeFileSync(path.join(root, 'Broken.epub'), Buffer.from('PK\u0003\u0004 not really a zip'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  lib = (await admin.post('/api/libraries', { name: 'Books', type: 'books', paths: [root] })).data;
  await waitForScan(admin);
  for (const r of nf.app.core.db.all("SELECT id, title FROM items WHERE kind IN ('book', 'series')")) ids[r.title] = r.id;
});

after(async () => {
  await nf?.app.stop();
});

const get = async (id) => (await admin.get(`/api/items/${id}`)).data;

test("an EPUB's title, author, description, language and cover", { skip }, async () => {
  const d = await get(ids['Sea Story']);
  assert.equal(d.item.kind, 'book');
  assert.equal(d.item.author, 'Ann Author');
  assert.equal(d.item.overview, 'A tale of the sea.');
  assert.equal(d.item.language, 'en-NZ');
  assert.equal(d.item.year, 2018);
  assert.ok(d.item.poster, 'a cover');
  const pic = await admin.raw(d.item.poster);
  assert.equal(pic.status, 200);
  assert.match(pic.headers.get('content-type'), /image/);
});

test('EPUB 3 nav and EPUB 2 NCX tables of contents', { skip }, async () => {
  const sea = await get(ids['Sea Story']);
  assert.deepEqual(sea.toc.map((t) => [t.title, t.level]), [['One', 0], ['Part of One', 1], ['Two', 0], ['Three', 0]]);
  assert.equal(sea.toc[1].href, 'text/ch1.xhtml#part');
  assert.equal(sea.spineCount, 3);
  const old = await get(ids['Old Book']);
  assert.deepEqual(old.toc.map((t) => t.title), ['Start', 'End']);
  assert.ok(old.item.poster, 'an EPUB 2 cover from <meta name="cover">');
});

test('calibre:series and belongs-to-collection make a series item; a book without one stands alone', { skip }, async () => {
  const series = await get(ids['The Expanse']);
  assert.equal(series.item.kind, 'series');
  const one = await get(ids['Leviathan Wakes']);
  const two = await get(ids["Caliban's War"]);
  assert.equal(one.item.showId, ids['The Expanse']);
  assert.equal(two.item.showId, ids['The Expanse']);
  assert.deepEqual([one.item.issue, two.item.issue], ['1', '2']);
  assert.equal((await get(ids['Sea Story'])).item.showId, null, 'the author folder is not a series');
  const listed = (await admin.get(`/api/libraries/${lib.id}/items`)).data.items.map((i) => i.title).sort();
  assert.deepEqual(listed, ['Old Book', 'Sea Story', 'The Expanse'], 'the library shows series and books on their own');
  assert.deepEqual(series.books.map((b) => b.title), ['Leviathan Wakes', "Caliban's War"], 'a series lists its books in order');
});

test('a damaged EPUB is skipped, the rest are added', { skip }, async () => {
  assert.equal(ids.Broken, undefined);
  assert.equal(nf.app.core.db.get("SELECT COUNT(*) AS n FROM items WHERE kind = 'book'").n, 4);
});
