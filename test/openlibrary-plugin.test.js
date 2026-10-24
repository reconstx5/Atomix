// v0.23 Plan B Task 4: the Open Library plugin fills missing book and audiobook details; EPUBs' ISBNs are read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, makeImage, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { makeEpub } from './helpers-books.js';
import { withZip } from '../src/books/zip.js';
import { readEpub } from '../src/books/epub.js';
import { cleanDescription, pickSubjects } from '../plugins/open-library/index.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const jpg = path.join(tempDir(), 'cover.jpg');
let nf, admin, ol;
const seen = [];

before(async () => {
  if (!hasFfmpeg) return;
  makeImage(jpg, 'navy', '300x450');
  await makeEpub(path.join(media, 'Books', 'Sea Story.epub'), { title: 'Sea Story', author: 'Herman Melville', description: 'Its own words.', identifiers: [{ scheme: 'ISBN', value: '978-0-14-103614-4' }] });
  await makeEpub(path.join(media, 'Books', 'Harbour.epub'), { title: 'Harbour', author: 'Jo Writer' });
  makeAudio(path.join(media, 'Audio', 'Night Voyage', '01.mp3'), { seconds: 2, tags: { album: 'Night Voyage', artist: 'Ann Author' } });
  ol = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/b/id/')) {
      seen.push({ u, at: Date.now(), cover: true });
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(fs.readFileSync(jpg));
    }
    seen.push({ u, at: Date.now(), ua: req.headers['user-agent'] });
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/search.json') {
      if (u.searchParams.get('isbn') === '9780141036144') return send({ docs: [{ key: '/works/OL1W', title: 'Sea Story', author_name: ['Herman Melville'], first_publish_year: 1851, cover_i: 42, subject: ['Fiction', 'Accessible book', 'nyt:best', 'sea stories', 'Whales', 'Ships', 'Sailing'] }] });
      if (u.searchParams.get('title') === 'Night Voyage') {
        return send({ docs: [{ key: '/works/OL9W', title: 'Night Voyage', author_name: ['Someone Else'], first_publish_year: 1970, cover_i: 99 }, { key: '/works/OL2W', title: 'Night Voyage: A Novel', author_name: ['Ann Author'], first_publish_year: 2001, subject: ['Night'] }] });
      }
      if (u.searchParams.get('title') === 'Harbour') return send({ docs: [] });
      return send({ docs: [] });
    }
    if (u.pathname === '/works/OL1W.json') return send({ description: { value: 'From Open Library.\n\n----------\nContains: x' } });
    if (u.pathname === '/works/OL2W.json') return send({ description: 'A voyage by night ([source][1])\n\n[1]: http://example.com' });
    return send({ error: 'notfound' }, 404);
  });
  nf = await startAtomix({ ATOMIX_OPENLIBRARY_BASE: ol.url, ATOMIX_OPENLIBRARY_COVERS_BASE: ol.url }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/admin/plugins/open-library/enabled', { enabled: true });
});

after(async () => {
  await nf?.app.stop();
  await ol?.close();
});

const row = (title) => nf.app.core.db.get('SELECT * FROM items WHERE title = ?', title);

test('an EPUB ISBN is read from its identifier', async () => {
  const dir = tempDir();
  const read = async (identifiers) => {
    const f = path.join(dir, `${Math.random()}.epub`);
    await makeEpub(f, { title: 'T', identifiers });
    return withZip(f, (zip) => readEpub(zip));
  };
  assert.equal((await read([{ scheme: 'ISBN', value: '978-0-14-103614-4' }])).isbn, '9780141036144');
  assert.equal((await read([{ value: 'urn:isbn:9780141036144' }])).isbn, '9780141036144');
  assert.equal((await read([{ value: '0-306-40615-2' }])).isbn, '0306406152', 'ISBN-10');
  assert.equal((await read([{ value: 'urn:uuid:1234-5678' }])).isbn, null);
  assert.equal((await read([{ scheme: 'ISBN', value: '9780141036145' }])).isbn, null, 'a bad checksum');
  assert.equal((await read([])).isbn, null);
});

test('cleanDescription and pickSubjects tidy what Open Library sends', () => {
  assert.equal(cleanDescription({ value: 'A sea story.\n\n----------\nContains: x' }), 'A sea story.');
  assert.equal(cleanDescription('Waves ([source][1])\n\n[1]: http://x'), 'Waves');
  assert.equal(cleanDescription(null), null);
  assert.deepEqual(pickSubjects(['Fiction', 'Accessible book', 'nyt:best', 'sea stories', 'Whales', 'Ships', 'Sailing']), ['Sea stories', 'Whales', 'Ships']);
  assert.deepEqual(pickSubjects(['Fiction']), ['Fiction'], 'fiction stays when nothing else is left');
  assert.deepEqual(pickSubjects(undefined), []);
});

test('a book with an ISBN is filled from Open Library, and only its gaps', { skip }, async () => {
  await admin.post('/api/libraries', { name: 'Books', type: 'books', paths: [path.join(media, 'Books')] });
  await waitForScan(admin);
  const book = row('Sea Story');
  assert.equal(book.overview, 'Its own words.', 'the book’s own description stays');
  assert.equal(book.year, 1851);
  assert.ok(book.poster, 'a cover');
  assert.deepEqual(JSON.parse(book.genres), ['Sea stories', 'Whales', 'Ships']);
  assert.ok(seen.some((s) => s.u.searchParams.get('isbn') === '9780141036144'));
  assert.ok(seen.some((s) => s.cover && s.u.pathname === '/b/id/42-L.jpg'));
});

test('an audiobook is found by title and author', { skip }, async () => {
  await admin.post('/api/libraries', { name: 'Audio', type: 'audiobooks', paths: [path.join(media, 'Audio')] });
  await waitForScan(admin);
  const asked = seen.find((s) => s.u.searchParams.get('title') === 'Night Voyage');
  assert.equal(asked.u.searchParams.get('author'), 'Ann Author');
  const book = row('Night Voyage');
  assert.equal(book.overview, 'A voyage by night');
  assert.equal(book.year, 2001, 'the right author’s work, not the first one');
  assert.equal(book.author, 'Ann Author');
});

test('a book Open Library has no cover for gets none', { skip }, async () => {
  assert.equal(row('Night Voyage').poster, null);
  assert.ok(!seen.some((s) => s.u.pathname === '/b/id/99-L.jpg'));
});

test('requests are a second apart and name Atomix', { skip }, async () => {
  const asks = seen.filter((s) => !s.cover);
  assert.ok(asks.length >= 4);
  for (let i = 1; i < asks.length; i++) assert.ok(asks[i].at - asks[i - 1].at >= 950, `gap ${asks[i].at - asks[i - 1].at} ms`);
  assert.ok(asks.every((s) => s.ua === `Atomix/${nf.app.core.version}`), asks[0].ua);
});
