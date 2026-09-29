// Music library — written before the feature existed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeAudio, makeImage, startNodeFlix, client, waitForScan } from './helpers.js';
import { normaliseTags, parseTrack } from '../src/library/music.js';
import { decide, buildFfmpegArgs } from '../src/stream/playback.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

test('tag names are normalised', () => {
  const t = normaliseTags({ TITLE: 'Song', ARTIST: 'Band', ALBUMARTIST: 'Band', TRACKNUMBER: '3/12', DISCNUMBER: '2', DATE: '2019-05-01', GENRE: 'Rock; Indie' });
  assert.deepEqual(t, { title: 'Song', artist: 'Band', album_artist: 'Band', track: '3/12', disc: '2', date: '2019-05-01', genre: 'Rock; Indie' });
  assert.equal(normaliseTags({ 'album artist': 'X' }).album_artist, 'X');
  assert.equal(normaliseTags({ year: '1999' }).date, '1999');
});

test('track info from tags, falling back to the folder layout', () => {
  const root = path.join('/music');
  const tagged = parseTrack({ title: 'Song', artist: 'Band', album: 'Record', track: '3/12', disc: '1/2', date: '2019', genre: 'Rock; Indie' }, path.join(root, 'x', 'y.mp3'), root);
  assert.deepEqual(tagged, { title: 'Song', artist: 'Band', albumArtist: null, album: 'Record', track: 3, disc: 1, year: 2019, genres: ['Rock', 'Indie'] });
  const untagged = parseTrack({}, path.join(root, 'The Band', 'First Record (2011)', '07 - Last Song.flac'), root);
  assert.deepEqual(untagged, { title: 'Last Song', artist: 'The Band', albumArtist: null, album: 'First Record', track: 7, disc: 1, year: 2011, genres: [] });
  const loose = parseTrack({}, path.join(root, 'demo.mp3'), root);
  assert.equal(loose.title, 'demo');
  assert.equal(loose.album, null);
  assert.equal(loose.artist, null);
});

test('audio playback decisions', () => {
  const chrome = { video: ['h264'], audio: ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'wav'], containers: ['mp4', 'webm'], hls: false };
  const audio = (codec) => ({ container: 'x', duration: 200, video: null, audio: [{ index: 0, codec, channels: 2, default: true }], subtitles: [] });
  assert.equal(decide({ file: 'a.mp3', media: audio('mp3'), caps: chrome, transcodingEnabled: true, quality: 'original' }).mode, 'direct');
  assert.equal(decide({ file: 'a.flac', media: audio('flac'), caps: chrome, transcodingEnabled: true, quality: 'original' }).mode, 'direct');
  assert.equal(decide({ file: 'a.wav', media: audio('pcm_s16le'), caps: chrome, transcodingEnabled: true, quality: 'original' }).mode, 'direct');
  const wma = decide({ file: 'a.wma', media: audio('wmav2'), caps: chrome, transcodingEnabled: true, quality: 'original' });
  assert.equal(wma.mode, 'transcode');
  assert.equal(wma.audioOnly, true);
  const args = buildFfmpegArgs({ ...wma, file: 'a.wma', start: 0, media: audio('wmav2'), quality: 'original' }, {}, { type: 'progressive' }).join(' ');
  assert.match(args, /-vn/);
  assert.match(args, /-c:a aac/);
  assert.ok(!/libx264|-c:v/.test(args), 'no video encoding for music');
  // Album art is a picture stream, not video — still audio.
  const withArt = { ...audio('mp3'), video: null, coverArt: true };
  assert.equal(decide({ file: 'a.mp3', media: withArt, caps: chrome, transcodingEnabled: true, quality: '480' }).mode, 'direct', 'quality limits do not apply to music');
});

// ---- A music library on disk ----
const media = tempDir();
const music = path.join(media, 'Music');
let nf;
let admin;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const band = path.join(music, 'The Band', 'First Record (2011)');
  makeAudio(path.join(band, '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/2', date: '2011', genre: 'Rock' } });
  makeAudio(path.join(band, '02 Closer.mp3'), { tags: { title: 'Closer', artist: 'The Band', album: 'First Record', track: '2/2', date: '2011', genre: 'Rock' } });
  makeImage(path.join(band, 'cover.jpg'), 'blue');
  makeImage(path.join(music, 'The Band', 'artist.jpg'), 'green');
  // Second album by the same band, tracks out of order on purpose, two discs
  const second = path.join(music, 'The Band', 'Second Record');
  makeAudio(path.join(second, 'b.flac'), { tags: { title: 'Disc Two Song', artist: 'The Band', album: 'Second Record', track: '1', disc: '2/2', date: '2014' } });
  makeAudio(path.join(second, 'a.flac'), { tags: { title: 'Disc One Song', artist: 'The Band', album: 'Second Record', track: '1', disc: '1/2', date: '2014' } });
  // A compilation: different artists, no album artist tag
  const hits = path.join(music, 'Compilations', 'Summer Hits');
  makeAudio(path.join(hits, '1.mp3'), { tags: { title: 'Sunny', artist: 'Singer One', album: 'Summer Hits', track: '1' } });
  makeAudio(path.join(hits, '2.mp3'), { tags: { title: 'Beach', artist: 'Singer Two', album: 'Summer Hits', track: '2' } });
  // Embedded cover art + an album artist tag, AAC in M4A
  const coverFile = path.join(tempDir(), 'embedded.jpg');
  makeImage(coverFile, 'red');
  makeAudio(path.join(music, 'Solo', 'Night.m4a'), { tags: { title: 'Night', artist: 'Solo feat. Friend', album_artist: 'Solo', album: 'After Dark', track: '1', genre: 'Electronic' }, cover: coverFile, codec: 'aac' });
  // A format browsers can't play
  makeAudio(path.join(music, 'Old', 'Legacy.wma'), { tags: { title: 'Legacy', artist: 'Old Timer', album: 'Archive' }, codec: 'wmav2' });

  nf = await startNodeFlix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
  const r = await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [music] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids.lib = r.data.id;
  await waitForScan(admin);
});

after(async () => {
  await nf?.app.stop();
});

test('artists and albums are built from tags', { skip }, async () => {
  const artists = (await admin.get(`/api/libraries/${ids.lib}/items?view=artists`)).data.items;
  assert.deepEqual(artists.map((a) => a.title).sort(), ['Old Timer', 'Solo', 'The Band', 'Various Artists']);
  const albums = (await admin.get(`/api/libraries/${ids.lib}/items`)).data.items;
  assert.deepEqual(albums.map((a) => a.title).sort(), ['After Dark', 'Archive', 'First Record', 'Second Record', 'Summer Hits']);
  const first = albums.find((a) => a.title === 'First Record');
  assert.equal(first.kind, 'album');
  assert.equal(first.year, 2011);
  assert.equal(first.artist, 'The Band');
  assert.equal(first.childCount, 2);
  assert.ok(first.poster, 'cover.jpg is used');
  const dark = albums.find((a) => a.title === 'After Dark');
  assert.ok(dark.poster, 'embedded artwork is extracted');
  const img = await admin.raw(dark.poster);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/jpeg/);
  const band = artists.find((a) => a.title === 'The Band');
  assert.ok(band.poster, 'artist.jpg is used');
  ids.first = first.id;
  ids.second = albums.find((a) => a.title === 'Second Record').id;
  ids.band = band.id;
  ids.hits = albums.find((a) => a.title === 'Summer Hits').id;
  ids.legacyAlbum = albums.find((a) => a.title === 'Archive').id;
});

test('album and artist pages', { skip }, async () => {
  const album = (await admin.get(`/api/items/${ids.first}`)).data;
  assert.deepEqual(album.tracks.map((t) => [t.episode, t.title]), [[1, 'Opening'], [2, 'Closer']]);
  assert.equal(album.artist.title, 'The Band');
  assert.ok(album.tracks[0].duration > 1);
  const second = (await admin.get(`/api/items/${ids.second}`)).data;
  assert.deepEqual(second.tracks.map((t) => t.title), ['Disc One Song', 'Disc Two Song'], 'sorted by disc then track');
  const hits = (await admin.get(`/api/items/${ids.hits}`)).data;
  assert.deepEqual(hits.tracks.map((t) => t.artist), ['Singer One', 'Singer Two'], 'each track keeps its own artist');
  const artist = (await admin.get(`/api/items/${ids.band}`)).data;
  assert.deepEqual(artist.albums.map((a) => a.title), ['Second Record', 'First Record'], 'newest album first');
});

test('an artist page lists every song, in the same order as its albums', { skip }, async () => {
  const artist = (await admin.get(`/api/items/${ids.band}`)).data;
  assert.deepEqual(artist.tracks.map((t) => t.title), ['Disc One Song', 'Disc Two Song', 'Opening', 'Closer']);
  assert.ok(artist.tracks.every((t) => t.kind === 'track' && t.albumTitle && t.albumPoster !== undefined));
  assert.equal(artist.item.childCount, 2, 'album count for the header');
});

test('a track page points at its album', { skip }, async () => {
  const album = (await admin.get(`/api/items/${ids.first}`)).data;
  const track = (await admin.get(`/api/items/${album.tracks[1].id}`)).data;
  assert.equal(track.item.kind, 'track');
  assert.equal(track.album.id, ids.first);
  assert.equal(track.artist.title, 'The Band');
  assert.equal(track.item.albumTitle, 'First Record');
});

test('playing music: direct for MP3, converted for WMA', { skip }, async () => {
  const caps = { video: ['h264'], audio: ['aac', 'mp3', 'opus', 'flac'], containers: ['mp4', 'webm'] };
  const track = (await admin.get(`/api/items/${ids.first}`)).data.tracks[0];
  let r = await admin.post(`/api/items/${track.id}/playback`, { caps });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mode, 'direct');
  const file = await admin.raw(r.data.url, { headers: { range: 'bytes=0-3' } });
  assert.equal(file.status, 206);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');

  const legacy = (await admin.get(`/api/items/${ids.legacyAlbum}`)).data.tracks[0];
  r = await admin.post(`/api/items/${legacy.id}/playback`, { caps });
  assert.equal(r.data.mode, 'transcode');
  const stream = await admin.raw(r.data.url);
  assert.equal(stream.headers.get('content-type'), 'audio/mp4');
  const out = path.join(tempDir(), 'out.m4a');
  fs.writeFileSync(out, Buffer.from(await stream.arrayBuffer()));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out]).toString());
  assert.deepEqual(probe.streams.map((s) => s.codec_type), ['audio']);
  assert.equal(probe.streams[0].codec_name, 'aac');
});

test('music shows up on the home screen and in search', { skip }, async () => {
  const home = (await admin.get('/api/home')).data;
  const row = home.rows.find((r) => r.id === `recent-${ids.lib}`);
  assert.ok(row, 'a recently added albums row');
  assert.equal(row.style, 'square');
  assert.ok(row.items.every((i) => i.kind === 'album'));
  const s = (await admin.get('/api/search?q=record')).data;
  assert.deepEqual(s.albums.map((a) => a.title).sort(), ['First Record', 'Second Record']);
  const t = (await admin.get('/api/search?q=sunny')).data;
  assert.equal(t.tracks[0].title, 'Sunny');
  const a = (await admin.get('/api/search?q=band')).data;
  assert.equal(a.artists[0].title, 'The Band');
});

test('a whole library can be shuffled', { skip }, async () => {
  const r = (await admin.get(`/api/libraries/${ids.lib}/items?view=tracks&sort=random&limit=50`)).data.items;
  assert.equal(r.length, 8);
  assert.ok(r.every((t) => t.kind === 'track' && t.albumTitle));
});

test('the admin dashboard counts music', { skip }, async () => {
  const d = (await admin.get('/api/admin/dashboard')).data;
  assert.equal(d.counts.albums, 5);
  assert.equal(d.counts.tracks, 8);
  assert.ok(d.counts.artists >= 3);
});

test('Kids profiles can listen to music (it is not age-rated)', { skip }, async () => {
  await admin.post('/api/profiles', { name: 'Kid', kids: true, maxAge: 5 });
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'admin', password: 'password123' });
  const kidProfile = (await kid.get('/api/profiles')).data.find((p) => p.kids);
  await kid.post(`/api/profiles/${kidProfile.id}/select`, {});
  const albums = (await kid.get(`/api/libraries/${ids.lib}/items`)).data.items;
  assert.equal(albums.length, 5);
});

test('removed files disappear, and empty albums and artists with them', { skip }, async () => {
  fs.rmSync(path.join(music, 'Old'), { recursive: true });
  fs.rmSync(path.join(music, 'The Band', 'First Record (2011)', '02 Closer.mp3'));
  await admin.post(`/api/libraries/${ids.lib}/scan`, {});
  await waitForScan(admin);
  const artists = (await admin.get(`/api/libraries/${ids.lib}/items?view=artists`)).data.items.map((a) => a.title);
  assert.ok(!artists.includes('Old Timer'));
  const first = (await admin.get(`/api/items/${ids.first}`)).data;
  assert.deepEqual(first.tracks.map((t) => t.title), ['Opening']);
});

test('databases from earlier versions accept music libraries', async () => {
  const { openDatabase } = await import('../src/db.js');
  const file = path.join(tempDir(), 'v2.db');
  const old = openDatabase(file, { upTo: 2 });
  old.run(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'u', 'x', 'admin', 1)`);
  old.run(`INSERT INTO profiles (id, user_id, name, is_primary, created_at) VALUES (1, 1, 'u', 1, 1)`);
  old.run(`INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movies', '[]', 1)`);
  old.run(`INSERT INTO items (id, library_id, kind, title, added_at, updated_at, path, min_age) VALUES (5, 1, 'movie', 'Keep me', 1, 1, '/m.mp4', 12)`);
  old.run(`INSERT INTO progress (profile_id, item_id, position, watched, updated_at) VALUES (1, 5, 42, 0, 1)`);
  assert.throws(() => old.run(`INSERT INTO libraries (name, type, paths, created_at) VALUES ('M', 'music', '[]', 1)`), /CHECK/);
  old.close();
  const db = openDatabase(file);
  db.run(`INSERT INTO libraries (id, name, type, paths, created_at) VALUES (2, 'Music', 'music', '[]', 1)`);
  db.run(`INSERT INTO items (library_id, kind, title, added_at, updated_at, path, artist) VALUES (2, 'album', 'A', 1, 1, 'x', 'Someone')`);
  assert.equal(db.get('SELECT min_age FROM items WHERE id = 5').min_age, 12);
  assert.equal(db.get('SELECT position FROM progress WHERE item_id = 5').position, 42, 'watch history survives the table rebuild');
  db.run('DELETE FROM libraries WHERE id = 1');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM items WHERE library_id = 1').n, 0, 'foreign keys still cascade');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM progress').n, 0);
  db.close();
});
