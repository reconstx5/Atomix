// Spoken titles in the rest of Atomix (v0.22 Plan B Task 5): playback as audio, search, song playlists, Downloads,
// stats, and music apps (podcasts yes, audiobooks no).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let kid;
let host;
let secret;
const ids = {};
const CAPS = { video: ['h264'], audio: ['aac', 'mp3', 'opus'], containers: ['mp4', 'mp3', 'webm'] };

before(async () => {
  if (!hasFfmpeg) return;
  const mp3 = path.join(media, 'ep.mp3');
  makeAudio(mp3, { seconds: 2 });
  const bytes = fs.readFileSync(mp3);
  host = await fakeServer((req, res) => {
    if (req.url === '/feed.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(`<rss><channel><title>Quiet Cast</title><item><title>Spoken One</title><guid>s1</guid><pubDate>${new Date(Date.UTC(2025, 0, 2)).toUTCString()}</pubDate><enclosure url="${host.url}/1.mp3" type="audio/mpeg"/></item></channel></rss>`);
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(bytes);
  });
  makeAudio(path.join(media, 'Audiobooks', 'Grim Story', '01.mp3'), { seconds: 2, tags: { album: 'Grim Story', artist: 'A. Writer', title: 'Part One' } });
  makeAudio(path.join(media, 'Audiobooks', 'Grim Story', '02.mp3'), { seconds: 2, tags: { album: 'Grim Story', artist: 'A. Writer', title: 'Part Two' } });
  fs.mkdirSync(path.join(media, 'Podcasts'), { recursive: true });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.books = (await admin.post('/api/libraries', { name: 'Audiobooks', type: 'audiobooks', paths: [path.join(media, 'Audiobooks')] })).data.id;
  ids.pods = (await admin.post('/api/libraries', { name: 'Podcasts', type: 'podcasts', paths: [path.join(media, 'Podcasts')] })).data.id;
  await waitForScan(admin);
  ids.book = (await admin.get(`/api/libraries/${ids.books}/items`)).data.items[0].id;
  await admin.patch(`/api/items/${ids.book}/details`, { changes: { certification: 'R16' } });
  ids.cast = (await admin.post('/api/podcasts', { libraryId: ids.pods, feedUrl: `${host.url}/feed.xml` })).data.id;
  await nf.app.core.podcasts.idle();
  ids.ep = (await admin.get(`/api/items/${ids.cast}`)).data.episodes[0].id;
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', allowUnrated: true })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  secret = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data.secret;
});

after(async () => {
  await nf?.app.stop();
  await host?.close();
});

test('a podcast episode plays as audio', { skip }, async () => {
  const r = await admin.post(`/api/items/${ids.ep}/playback`, { caps: CAPS });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.previews, null);
  assert.equal(r.data.next, null);
  assert.deepEqual(r.data.markers, { intro: null, credits: null });
  await admin.post(`/api/playback/${r.data.sessionId}/stop`, {});
});

test('search finds podcasts and audiobooks, within the viewer\'s rules', { skip }, async () => {
  const s = (await admin.get('/api/search?q=Grim')).data;
  assert.deepEqual(s.audiobooks.map((b) => b.title), ['Grim Story']);
  assert.deepEqual((await admin.get('/api/search?q=Quiet')).data.podcasts.map((p) => p.title), ['Quiet Cast']);
  assert.deepEqual((await kid.get('/api/search?q=Grim')).data.audiobooks, [], 'R16: not for Mia');
  assert.deepEqual((await admin.get('/api/search?q=x')).data.podcasts, [], 'a short search answers empty lists');
});

test("a song playlist takes podcast episodes and audiobooks; a video playlist doesn't", { skip }, async () => {
  const songs = (await admin.post('/api/lists', { kind: 'music', name: 'Commute' })).data;
  assert.equal((await admin.post(`/api/lists/${songs.id}/items`, { itemId: ids.ep })).status, 204);
  assert.equal((await admin.post(`/api/lists/${songs.id}/items`, { itemId: ids.book })).status, 204);
  const video = (await admin.post('/api/lists', { kind: 'video', name: 'Films' })).data;
  const r = await admin.post(`/api/lists/${video.id}/items`, { itemId: ids.ep });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'A video playlist takes films and episodes (add a season for a show).');
  const show = await admin.post(`/api/lists/${songs.id}/items`, { itemId: ids.cast });
  assert.equal(show.data.error, 'A song playlist takes songs, podcast episodes and audiobooks.');
});

test('downloading a podcast downloads its kept episodes; an audiobook its parts', { skip }, async () => {
  const p = (await admin.post('/api/downloads', { itemIds: [ids.cast], caps: CAPS })).data;
  assert.deepEqual(p.items.map((i) => [i.itemId, i.kind]), [[ids.ep, 'podcast_episode']]);
  const b = (await admin.post('/api/downloads', { itemIds: [ids.book], caps: CAPS })).data;
  assert.deepEqual(b.items.map((i) => i.kind), ['chapter', 'chapter']);
  assert.ok(b.items.every((i) => ['original', 'audio', 'webm'].includes(i.format)));
});

test('listening to a book counts as listening', { skip }, async () => {
  const before = (await admin.get('/api/me/stats?range=week')).data.listenedHours;
  const part = (await admin.get(`/api/items/${ids.book}`)).data.parts[0];
  const { plays } = nf.app.core;
  const profileId = nf.app.core.db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  // Two reports a minute apart of real listening (the play history counts listened seconds).
  plays.report({ profileId, item: nf.app.core.library.get(ids.book), position: 0, duration: 7200, watched: false, client: 'browser' });
  const row = nf.app.core.db.get('SELECT * FROM plays WHERE profile_id = ? ORDER BY id DESC LIMIT 1', profileId);
  nf.app.core.db.run('UPDATE plays SET seconds = 3600 WHERE id = ?', row.id);
  const after = (await admin.get('/api/me/stats?range=week')).data.listenedHours;
  assert.ok(after > before, JSON.stringify({ before, after, part }));
});

test('music apps see podcasts, not audiobooks', { skip }, async () => {
  const auth = tokenAuth('dallas', secret);
  const got = await rest(nf.base, 'getPodcasts', auth);
  assert.equal(got.body.status, 'ok', JSON.stringify(got.body));
  const ch = got.body.podcasts.channel;
  assert.equal(ch.length, 1);
  assert.equal(ch[0].title, 'Quiet Cast');
  assert.equal(ch[0].url, '', 'the feed address stays on the server');
  assert.equal(ch[0].episode[0].status, 'completed');
  assert.ok(!JSON.stringify(got.body).includes(new URL(host.url).host));
  const noEps = await rest(nf.base, 'getPodcasts', { ...tokenAuth('dallas', secret), includeEpisodes: 'false' });
  assert.equal(noEps.body.podcasts.channel[0].episode, undefined);
  const newest = await rest(nf.base, 'getNewestPodcasts', tokenAuth('dallas', secret));
  assert.equal(newest.body.newestPodcasts.episode[0].title, 'Spoken One');
  const stream = await rest(nf.base, 'stream', { ...tokenAuth('dallas', secret), id: ch[0].episode[0].streamId }, { f: null });
  assert.equal(stream.status, 200);
  assert.match(stream.type, /audio/);
  const s3 = await rest(nf.base, 'search3', { ...tokenAuth('dallas', secret), query: 'Grim' });
  assert.ok(!JSON.stringify(s3.body).includes('Grim Story'), 'audiobooks are not in music apps');
});

test("a spoken title's own file is served (direct play)", { skip }, async () => {
  const r = await admin.raw(`/api/items/${ids.ep}/file`, { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  const part = (await admin.get(`/api/items/${ids.book}`)).data.parts[0];
  assert.equal((await admin.raw(`/api/items/${part.id}/file`, { headers: { range: 'bytes=0-9' } })).status, 206);
});

test('playing a title whose file has gone says so at once', { skip }, async () => {
  const part = (await admin.get(`/api/items/${ids.book}`)).data.parts[1];
  const file = nf.app.core.db.get('SELECT path FROM items WHERE id = ?', part.id).path;
  fs.renameSync(file, `${file}.away`);
  try {
    const r = await admin.post(`/api/items/${part.id}/playback`, { caps: CAPS });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, 'The file is missing on the server — try rescanning the library.');
  } finally {
    fs.renameSync(`${file}.away`, file);
  }
});

test("offline progress takes a book's part (as the book's place) and an episode", { skip }, async () => {
  const parts = (await admin.get(`/api/items/${ids.book}`)).data.parts;
  const at = Date.now() + 5000;
  const r = await admin.post('/api/downloads/progress', { entries: [{ itemId: parts[1].id, position: 1, duration: parts[1].duration, at }, { itemId: ids.ep, position: 1.2, duration: 2, at }] });
  assert.equal(r.data.saved, 2, JSON.stringify(r.data));
  const book = (await admin.get(`/api/items/${ids.book}`)).data.item;
  assert.ok(Math.abs(book.progress.position - (parts[1].start + 1)) < 0.01, JSON.stringify(book.progress));
  assert.ok(Math.abs(book.progress.duration - (parts[0].duration + parts[1].duration)) < 0.01);
  const again = await admin.post('/api/downloads/progress', { entries: [{ itemId: parts[0].id, position: 0.1, duration: parts[0].duration, at: at - 60_000 }] });
  assert.equal(again.data.saved, 0, "an older report doesn't replace the book's newer place");
  assert.ok(Math.abs((await admin.get(`/api/items/${ids.ep}`)).data.item.progress.position - 1.2) < 0.01);
});

test('one podcast episode, or one part of a book, downloads on its own', { skip }, async () => {
  const ep = (await admin.post('/api/downloads', { itemIds: [ids.ep], caps: CAPS })).data;
  assert.deepEqual(ep.items.map((i) => [i.itemId, i.kind]), [[ids.ep, 'podcast_episode']], JSON.stringify(ep));
  const part = (await admin.get(`/api/items/${ids.book}`)).data.parts[1];
  const one = (await admin.post('/api/downloads', { itemIds: [part.id], caps: CAPS })).data;
  assert.deepEqual(one.items.map((i) => [i.itemId, i.kind]), [[part.id, 'chapter']]);
});

test("offline reports for two parts of a book: the later listening wins", { skip }, async () => {
  const parts = (await admin.get(`/api/items/${ids.book}`)).data.parts;
  const at = Date.now() + 60_000;
  const r = await admin.post('/api/downloads/progress', { entries: [{ itemId: parts[0].id, position: 1.5, duration: parts[0].duration, at }, { itemId: parts[1].id, position: 0.5, duration: parts[1].duration, at: at + 1000 }] });
  assert.equal(r.data.saved, 1, JSON.stringify(r.data));
  const book = (await admin.get(`/api/items/${ids.book}`)).data.item;
  assert.ok(Math.abs(book.progress.position - (parts[1].start + 0.5)) < 0.01, JSON.stringify(book.progress));
});
