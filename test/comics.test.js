// Comics (v0.22 Plan D Task 3): CBZ with ComicInfo, issue numbers from file names, folders of pictures, CBR through
// 7-Zip (a fake one here) or listed with "Install 7-Zip to read this", and age ratings under the Kids rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, tempDir, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { writeStoredZip } from '../src/books/zip-write.js';
import { parseComicInfo, ageFor } from '../src/books/comicinfo.js';
import { archiveEntry, archiveList, detectArchiveTool } from '../src/books/archive-tool.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const FAKE_7Z = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-7z.mjs');
const media = tempDir();
const root = path.join(media, 'Comics');
let nf;
let admin;
let lib;
let mia;
let leo;
let pages;
const ids = {};

const info = (fields) => Buffer.from(`<?xml version="1.0"?><ComicInfo>${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</ComicInfo>`);
async function cbz(file, { comicInfo = null, pageNames = ['01.jpg', '02.jpg', '03.jpg'] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const files = pageNames.map((name, i) => ({ name, file: pages[i % pages.length] }));
  if (comicInfo) files.push({ name: 'ComicInfo.xml', data: info(comicInfo) });
  files.push({ name: '__MACOSX/._01.jpg', data: Buffer.from('junk') });
  await writeStoredZip(file, files);
}
const fake = (file, spec) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'Rar!\u001a\u0007\u0000 (a stand-in)');
  fs.writeFileSync(`${file}.json`, JSON.stringify(spec));
};

before(async () => {
  if (!hasFfmpeg) return;
  pages = ['red', 'green', 'blue'].map((c) => {
    const f = path.join(media, `${c}.jpg`);
    makeImage(f, c, '200x300');
    return f;
  });
  await cbz(path.join(root, 'Saga', 'Saga 012 (2013).cbz'));
  await cbz(path.join(root, 'Saga', 'Saga Annual 2.cbz'));
  await cbz(path.join(root, 'Saga', 'Saga 1.5.cbz'));
  await cbz(path.join(root, 'Manga', 'Vol 1.cbz'), { comicInfo: { Series: 'Blade Manga', Number: '1', Summary: 'A sword story.', Year: '2020', AgeRating: 'Teen', Manga: 'YesAndRightToLeft' } });
  await cbz(path.join(root, 'Kids', 'Bunny 1.cbz'), { comicInfo: { Series: 'Bunny', Number: '1', AgeRating: 'Everyone' } });
  await cbz(path.join(root, 'Mixed', 'Mixed 1.cbz'), { comicInfo: { Series: 'Mixed', Number: '1' } });
  await cbz(path.join(root, 'Mixed', 'Mixed 2.cbz'), { comicInfo: { Series: 'Mixed', Number: '2', AgeRating: 'Adults Only 18+' } });
  // A series whose first issue is for adults and whose second is for ten-year-olds: its cover must be the second's.
  const scary = [path.join(media, 'scary-red.jpg'), path.join(media, 'scary-green.jpg')];
  makeImage(scary[0], 'red', '210x300');
  makeImage(scary[1], 'green', '220x300');
  fs.mkdirSync(path.join(root, 'Scary'), { recursive: true });
  await writeStoredZip(path.join(root, 'Scary', 'Scary 1.cbz'), [{ name: '01.jpg', file: scary[0] }, { name: 'ComicInfo.xml', data: info({ Series: 'Scary', Number: '1', AgeRating: 'Adults Only 18+' }) }]);
  await writeStoredZip(path.join(root, 'Scary', 'Scary 2.cbz'), [{ name: '01.jpg', file: scary[1] }, { name: 'ComicInfo.xml', data: info({ Series: 'Scary', Number: '2', AgeRating: 'Everyone 10+' }) }]);
  for (const [i, c] of ['red', 'green', 'blue'].entries()) makeImage(path.join(root, 'Sketchbook', `page ${i + 1}.jpg`), c, '120x160');
  makeImage(path.join(root, 'Covers Only', 'cover.jpg'), 'red', '100x100');
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  fake(path.join(root, 'Night', 'Night 3.cbr'), { entries: { '02.jpg': b64(pages[1]), '01.jpg': b64(pages[0]), 'ComicInfo.xml': info({ Series: 'Night', Number: '3' }).toString('base64') } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  // No 7-Zip on the first scan (this machine has none; the setting is empty).
  lib = (await admin.post('/api/libraries', { name: 'Comics', type: 'comics', paths: [root] })).data;
  await waitForScan(admin);
  const kidsClient = async (name, allowUnrated) => {
    const p = (await admin.post('/api/profiles', { name, kids: true, maxAge: 10, avatar: 'teal', allowUnrated })).data;
    const c = client(nf.base);
    await c.post('/api/auth/login', { username: 'dallas', password: 'password123' });
    await c.post(`/api/profiles/${p.id}/select`, {});
    return c;
  };
  mia = await kidsClient('Mia', false);
  leo = await kidsClient('Leo', true);
});

after(async () => {
  await nf?.app.stop();
});

const rows = () => {
  for (const r of nf.app.core.db.all("SELECT id, kind, title FROM items WHERE kind IN ('comic', 'series')")) ids[`${r.kind}:${r.title}`] = r.id;
  return ids;
};
/** A comic by its series' name and its number. */
const comic = (series, issue) => nf.app.core.db.get("SELECT c.id FROM items c JOIN items s ON s.id = c.show_id WHERE c.kind = 'comic' AND s.title = ? AND c.issue = ?", series, issue)?.id;
const get = async (id, c = admin) => (await c.get(`/api/items/${id}`)).data;

test('ComicInfo series, number, age rating and manga direction', { skip }, async () => {
  const ci = parseComicInfo(info({ Series: 'S', Number: '7', Title: 'T', Summary: 'Sum', Year: '1999', AgeRating: 'Mature 17+', Manga: 'YesAndRightToLeft', PageCount: '24' }).toString());
  assert.deepEqual(ci, { series: 'S', number: '7', title: 'T', summary: 'Sum', year: 1999, ageRating: 'Mature 17+', manga: 'rtl', pageCount: 24 });
  assert.deepEqual(['Everyone', 'Early Childhood', 'Kids to Adults', 'Everyone 10+', 'Teen', 'MA15+', 'Mature 17+', 'Adults Only 18+', 'R18+', 'X18+', 'Unknown', 'Rating Pending', ''].map(ageFor), [0, 3, 6, 10, 13, 15, 17, 18, 18, 18, null, null, null]);
  rows();
  const vol = await get(comic('Blade Manga', '1'));
  assert.equal(vol.item.issue, '1');
  assert.equal(vol.item.overview, 'A sword story.');
  assert.equal(vol.item.year, 2020);
  assert.equal(vol.item.pageCount, 3, '__MACOSX is not a page');
  assert.ok(vol.item.poster, 'the first page is the cover');
  const series = await get(vol.item.showId);
  assert.equal(series.item.title, 'Blade Manga');
  assert.equal(series.item.readingDir, 'rtl');
});

test('issue numbers from file names', { skip }, async () => {
  rows();
  const saga = await get(ids['series:Saga']);
  assert.deepEqual(saga.books.map((b) => b.issue), ['1.5', '12', 'Annual 2']);
});

test('a folder of images is one comic; a folder with one cover.jpg is not', { skip }, async () => {
  rows();
  const sketch = nf.app.core.db.get("SELECT * FROM items WHERE kind = 'comic' AND title = 'Sketchbook'");
  assert.ok(sketch, 'Sketchbook is a comic');
  assert.equal(sketch.page_count, 3);
  assert.equal(JSON.parse(sketch.media).format, 'folder');
  assert.equal(nf.app.core.db.get("SELECT COUNT(*) AS n FROM items WHERE title = 'Covers Only'").n, 0);
});

test('without a tool a CBR is listed with "Install 7-Zip to read this"', { skip }, async () => {
  rows();
  const night = await get(comic('Night', '3'));
  assert.equal(night.item.needsTool, 'Install 7-Zip to read this');
  assert.equal(night.item.pageCount, undefined);
  const status = (await admin.get('/api/admin/dashboard')).data.tools.archive;
  assert.equal(status.available, false);
});

test('CBR through a fake 7z: listed once, one page at a time, unknown names refused', { skip }, async () => {
  const saved = await admin.put('/api/admin/settings', { archiveToolPath: FAKE_7Z });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const tool = (await admin.get('/api/admin/dashboard')).data.tools.archive;
  assert.deepEqual([tool.available, tool.kind, tool.version], [true, '7z', '23.01']);
  await admin.post(`/api/libraries/${lib.id}/scan`, {});
  await waitForScan(admin);
  rows();
  const night = nf.app.core.db.get('SELECT * FROM items WHERE id = ?', comic('Night', '3'));
  const m = JSON.parse(night.media);
  assert.deepEqual(m.pages, ['01.jpg', '02.jpg'], 'pages in natural order, ComicInfo is not one');
  assert.equal(m.format, 'cbr');
  assert.equal(night.issue, '3');
  const t = nf.app.core.tools.archive;
  const list = await archiveList(t, night.path);
  assert.ok(list.includes('ComicInfo.xml'));
  const first = await archiveEntry(t, night.path, '01.jpg', { list });
  assert.deepEqual([...first.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  await assert.rejects(archiveEntry(t, night.path, '../../etc/passwd', { list }), /That page isn't in this comic\./);
});

test('a tool that hangs answers "7-Zip didn\'t answer in time." within the timeout', { skip }, async () => {
  const file = path.join(media, 'Hang 1.cbr');
  fake(file, { entries: { '01.jpg': '' }, hang: true });
  const t = await detectArchiveTool([FAKE_7Z]);
  const started = Date.now();
  await assert.rejects(archiveEntry(t, file, '01.jpg', { list: ['01.jpg'], timeoutMs: 500 }), /7-Zip didn't answer in time\./);
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(archiveEntry({ available: false, kind: null, path: null }, file, '01.jpg', { list: ['01.jpg'] }), /Install 7-Zip to read this\./);
  assert.deepEqual(await detectArchiveTool(['/nowhere/7z']), { available: false, kind: null, path: null, version: null });
});

test('the age rating follows the rules: series unrated, issue rated 18 → Mia sees neither unless allow-unrated, and never the 18', { skip }, async () => {
  rows();
  const seen = async (c) => {
    const listed = (await c.get(`/api/libraries/${lib.id}/items`)).data.items.map((i) => i.title);
    const mixed = await c.get(`/api/items/${ids['series:Mixed']}`);
    return { listed, mixed: mixed.status === 200 ? mixed.data.books.map((b) => b.issue) : mixed.status, adult: (await c.get(`/api/items/${comic('Mixed', '2')}`)).status };
  };
  const m = await seen(mia);
  assert.ok(m.listed.includes('Bunny'), JSON.stringify(m));
  assert.ok(!m.listed.includes('Mixed') && !m.listed.includes('Blade Manga'), JSON.stringify(m));
  assert.equal(m.adult, 404);
  const l = await seen(leo);
  assert.ok(l.listed.includes('Mixed'), JSON.stringify(l));
  assert.deepEqual(l.mixed, ['1'], 'the unrated issue, never the 18');
  assert.equal(l.adult, 404);
});

test('ComicInfo G, PG and M are ratings, not unrated', () => {
  assert.deepEqual(['G', 'PG', 'M'].map(ageFor), [0, 8, 15]);
});

test("a series' cover comes from its most widely allowed issue, not an adults-only one", { skip }, async () => {
  rows();
  const series = nf.app.core.db.get("SELECT poster FROM items WHERE kind = 'series' AND title = 'Scary'").poster;
  const two = nf.app.core.db.get('SELECT poster FROM items WHERE id = ?', comic('Scary', '2')).poster;
  assert.equal(series, two);
  const listed = (await mia.get(`/api/libraries/${lib.id}/items`)).data.items.map((i) => i.title);
  assert.ok(listed.includes('Scary'), 'Mia sees the series, by its #2');
});
