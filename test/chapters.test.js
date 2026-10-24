// Chapters in the playback answer: from the stored probe, titled "Chapter N" when the file has no name; items probed
// before chapters were stored are re-read once, in the background, and the result is kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeEpisode, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { chapterList } from '../src/library/chapters.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

test('chapterList: titles default to Chapter N; bad rows are dropped', () => {
  assert.deepEqual(chapterList({ chapters: [{ start: 0, end: 2, title: 'Opening' }, { start: 2, end: 5, title: null }, { start: 5, end: 5 }] }), [
    { start: 0, end: 2, title: 'Opening' },
    { start: 2, end: 5, title: 'Chapter 2' },
  ]);
  assert.deepEqual(chapterList(null), []);
  assert.deepEqual(chapterList({}), []);
});

let nf;
let admin;
const ids = {};
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeEpisode(path.join(media, 'Movies', 'Marked (2020)', 'Marked (2020).mp4'), { seconds: 8, chapters: [[0, 3, 'Opening'], [3, 8, '']] });
  makeVideo(path.join(media, 'Movies', 'Plain (2021)', 'Plain (2021).mp4'), { seconds: 4 });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${lib}/items`)).data.items) ids[it.title] = it.id;
});
after(async () => {
  await nf?.app.stop();
});

const caps = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'], hls: false };
const play = async (id) => {
  const r = (await admin.post(`/api/items/${id}/playback`, { caps, start: 0 })).data;
  await admin.post(`/api/playback/${r.sessionId}/stop`, {});
  return r;
};

test('the playback answer lists the chapters with titles', { skip }, async () => {
  const r = await play(ids.Marked);
  assert.equal(r.chapters.length, 2);
  assert.deepEqual(r.chapters.map((c) => c.title), ['Opening', 'Chapter 2']);
  assert.equal(r.chapters[0].start, 0);
  assert.ok(Math.abs(r.chapters[1].start - 3) < 0.01 && Math.abs(r.chapters[1].end - 8) < 0.2, JSON.stringify(r.chapters));
});

test('a file without chapters → []', { skip }, async () => {
  assert.deepEqual((await play(ids.Plain)).chapters, []);
});

test('an item probed before chapters were stored is re-read once, in the background', { skip }, async () => {
  const { db } = nf.app.core;
  const strip = (id) => {
    const m = JSON.parse(db.get('SELECT media FROM items WHERE id = ?', id).media);
    delete m.chapters;
    db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(m), id);
  };
  strip(ids.Marked);
  strip(ids.Plain);
  let reads = 0;
  const real = nf.app.core.chapters.read;
  nf.app.core.chapters.read = (...a) => (reads++, real(...a));
  await play(ids.Marked); // starts the read; this answer may not have them yet
  await play(ids.Plain);
  for (let i = 0; i < 50 && 'chapters' in JSON.parse(db.get('SELECT media FROM items WHERE id = ?', ids.Plain).media) === false; i++) await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 50 && !JSON.parse(db.get('SELECT media FROM items WHERE id = ?', ids.Marked).media).chapters; i++) await new Promise((r) => setTimeout(r, 100));
  const again = await play(ids.Marked);
  assert.deepEqual(again.chapters.map((c) => c.title), ['Opening', 'Chapter 2'], 'the next playback has them');
  assert.deepEqual(JSON.parse(db.get('SELECT media FROM items WHERE id = ?', ids.Plain).media).chapters, [], 'none found is stored too');
  await play(ids.Marked);
  await play(ids.Plain);
  assert.equal(reads, 2, 'each item is read once');
  nf.app.core.chapters.read = real;
});

// ---- v0.21 tidy-up ----
test('a chapters read that fails or times out stores nothing; a failed save never throws unseen', async () => {
  const { Chapters } = await import('../src/library/chapters.js');
  const fs = await import('node:fs');
  const file = path.join(tempDir(), 'x.mkv');
  fs.writeFileSync(file, 'x');
  let media = { duration: 10 };
  let runs = 0;
  const db = {
    get: () => ({ media: JSON.stringify(media) }),
    run: (sql, json) => {
      runs++;
      if (db.fail) throw new Error('database is locked');
      media = JSON.parse(json);
    },
  };
  const unseen = [];
  const onUnhandled = (err) => unseen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const c = new Chapters({ db, config: { ffprobePath: 'ffprobe' }, log: { debug() {}, warn() {} } });
    c.read = () => Promise.reject(Object.assign(new Error('ffprobe timed out'), { code: 'ETIMEDOUT' }));
    c.forItem({ id: 1, path: file }, media);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!('chapters' in media), 'not stored as "no chapters": the next play reads again');
    c.read = async () => [];
    db.fail = true;
    c.forItem({ id: 1, path: file }, media);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unseen.length, 0, unseen.map((e) => e.message).join());
    assert.ok(runs >= 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
