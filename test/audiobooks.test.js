// Audiobooks (v0.22 Plan B Task 4): a folder (or one .m4b) is a book; parts in natural order, disc folders joined,
// chapters from the file or one per part, progress on the whole book, and the Continue listening row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, makeImage, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let kid;
const books = {};

before(async () => {
  if (!hasFfmpeg) return;
  const root = path.join(media, 'Audiobooks');
  // A folder of chapter files, numbered so a plain sort would put 10 before 2.
  for (const [file, title] of [['Chapter 2.mp3', 'The Second'], ['Chapter 10.mp3', 'The Tenth'], ['Chapter 1.mp3', 'The First']]) {
    makeAudio(path.join(root, 'Long Walk', file), { seconds: 2, tags: { album: 'The Long Walk', artist: 'Ann Author', composer: 'Ned Narrator', date: '2019', title } });
  }
  // One .m4b with its own chapters, rated R16 by an admin later.
  makeAudio(path.join(root, 'Dark Tales.m4b'), { seconds: 6, codec: 'aac', tags: { album: 'Dark Tales', artist: 'Bea Writer' }, chapters: [{ title: 'Opening', start: 0, end: 2 }, { title: 'Middle', start: 2, end: 4 }, { title: 'End', start: 4, end: 6 }] });
  // Disc folders, a cover, and things that aren't audio.
  makeAudio(path.join(root, 'Big Book', 'CD1', '01.mp3'), { seconds: 2, tags: { album: 'Big Book', artist: 'Cy Author' } });
  makeAudio(path.join(root, 'Big Book', 'CD2', '01.mp3'), { seconds: 2, tags: { album: 'Big Book', artist: 'Cy Author' } });
  makeImage(path.join(root, 'Big Book', 'cover.jpg'), 'green', '200x200');
  fs.writeFileSync(path.join(root, 'Big Book', 'notes.txt'), 'not a book');
  fs.writeFileSync(path.join(root, 'Big Book', 'Big Book.cue'), 'FILE "x" MP3');

  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Audiobooks', type: 'audiobooks', paths: [root] })).data;
  await waitForScan(admin);
  for (const b of (await admin.get(`/api/libraries/${lib.id}/items`)).data.items) books[b.title] = b.id;
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', allowUnrated: true })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});

after(async () => {
  await nf?.app.stop();
});

const get = async (id) => (await admin.get(`/api/items/${id}`)).data;

test('a folder of mp3s is one book with parts in natural order', { skip }, async () => {
  assert.deepEqual(Object.keys(books).sort(), ['Big Book', 'Dark Tales', 'The Long Walk']);
  const b = await get(books['The Long Walk']);
  assert.equal(b.item.kind, 'audiobook');
  assert.deepEqual([b.item.author, b.item.narrator, b.item.year], ['Ann Author', 'Ned Narrator', 2019]);
  assert.deepEqual(b.parts.map((p) => p.title), ['The First', 'The Second', 'The Tenth']);
  assert.deepEqual(b.parts.map((p) => Math.round(p.start)), [0, 2, 4]);
  assert.equal(Math.round(b.item.duration), 6);
  assert.deepEqual(b.chapters.map((c) => [c.title, Math.round(c.start)]), [['The First', 0], ['The Second', 2], ['The Tenth', 4]], 'one chapter per part');
});

test("an m4b's embedded chapters are the book's chapters", { skip }, async () => {
  const b = await get(books['Dark Tales']);
  assert.equal(b.parts.length, 1);
  assert.deepEqual(b.chapters.map((c) => [c.title, Math.round(c.start)]), [['Opening', 0], ['Middle', 2], ['End', 4]]);
});

test('disc folders join one book; non-audio files are ignored', { skip }, async () => {
  const b = await get(books['Big Book']);
  assert.equal(b.parts.length, 2);
  assert.match(b.parts[0].path ?? b.parts[0].title, /.+/);
  assert.ok(b.item.poster, 'cover.jpg is the poster');
  const all = (await admin.get(`/api/search?q=Book`)).data;
  assert.ok(all, 'search answers');
});

test("progress on a part is the book's progress", { skip }, async () => {
  const b = await get(books['The Long Walk']);
  const part2 = b.parts[1];
  assert.equal((await admin.post(`/api/items/${part2.id}/progress`, { position: 1, duration: 2 })).status, 200);
  const after = await get(books['The Long Walk']);
  assert.equal(Math.round(after.item.progress.position), 3, 'part 2 starts at 2 s: 1 s into it is 3 s into the book');
  assert.equal(Math.round(after.item.progress.duration), 6);
});

test('Continue listening shows a book in progress, within the viewer\'s rules', { skip }, async () => {
  const { db } = nf.app.core;
  const book = books['The Long Walk'];
  await admin.post(`/api/items/${book}/progress`, { position: 40, duration: 6000 }); // > 30 s in, not finished
  db.run('UPDATE items SET duration = 6000 WHERE id = ?', book);
  let row = (await admin.get('/api/home')).data.rows.find((r) => r.key === 'continue-listening');
  assert.equal(row?.title, 'Continue listening');
  assert.deepEqual(row.items.map((i) => i.title), ['The Long Walk']);
  // Rated R16: Mia doesn't see it there (even with her own progress on it).
  await admin.patch(`/api/items/${book}/details`, { changes: { certification: 'R16' } });
  db.run("INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) SELECT id, ?, 50, 6000, 0, ? FROM profiles WHERE name = 'Mia'", book, Date.now());
  row = (await kid.get('/api/home')).data.rows.find((r) => r.key === 'continue-listening');
  assert.ok(!row || !row.items.some((i) => i.title === 'The Long Walk'));
});

test("a rescan keeps a year a plugin filled when the tags have none, and doesn't refetch an unchanged book (F2)", { skip }, async () => {
  const id = books['Dark Tales'];
  nf.app.core.db.run('UPDATE items SET year = 1977, metadata_at = 12345 WHERE id = ?', id);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const row = nf.app.core.db.get('SELECT year, metadata_at FROM items WHERE id = ?', id);
  assert.equal(row.year, 1977, 'no date tag: the filled year stays');
  assert.equal(row.metadata_at, 12345, 'unchanged files: not offered to providers again');
});
