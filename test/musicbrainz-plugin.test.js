// v0.23 Plan B Task 5: the MusicBrainz plugin fills missing album years, genres and Cover Art Archive covers, and
// passes the MusicBrainz ids on to Fanart.tv.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, makeImage, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { luceneQuote, normName } from '../plugins/musicbrainz/index.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const jpg = path.join(tempDir(), 'cover.jpg');
let nf, admin, mb, caa, fanart, version;
const mbSeen = [];
const caaSeen = [];
const caaUa = [];
const fanartSeen = [];

const group = (id, title, artist, date, score = 100) => ({ id, title, score, 'first-release-date': date, 'artist-credit': [{ name: artist, artist: { id: `a-${artist}`, name: artist } }] });

before(async () => {
  if (!hasFfmpeg) return;
  makeImage(jpg, 'orange', '300x300');
  const song = (dir, album, artist, extra = {}) => makeAudio(path.join(media, 'Music', dir, '01.mp3'), { seconds: 1, tags: { title: 'Song', album, artist, album_artist: artist }, ...extra });
  song('Band A/Album One', 'Album One', 'Band A');
  song('ACDC/Embedded', 'Embedded', 'AC/DC', { cover: jpg });
  song('Band A/Live Here', 'Live "Here"', 'Band A');
  song('Band A/Weak', 'Weak', 'Band A');
  mb = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    mbSeen.push({ u, at: Date.now(), ua: req.headers['user-agent'] });
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    const q = u.searchParams.get('query') || '';
    if (u.pathname === '/ws/2/release-group/') {
      if (q.includes('releasegroup:"Album One"')) return send({ 'release-groups': [group('rg1', 'Album One', 'Band A', '1985-06-17')] });
      if (q.includes('releasegroup:"Album Two"')) return send({ 'release-groups': [group('rg2', 'Album Two (Deluxe Edition)', 'Band A', '1987')] });
      if (q.includes('releasegroup:"Embedded"')) return send({ 'release-groups': [group('rgE', 'Embedded', 'AC/DC', '1990-01-01')] });
      if (q.includes('releasegroup:"Live \\"Here\\""')) return send({ 'release-groups': [group('rgL', 'Live "Here"', 'Band A', '1999')] });
      if (q.includes('releasegroup:"Weak"')) return send({ 'release-groups': [group('rgW1', 'Weak', 'Band A', '2001', 70), group('rgW2', 'Weak', 'Band B', '2002')] });
      return send({ 'release-groups': [] });
    }
    if (/^\/ws\/2\/release-group\/rg\w+$/.test(u.pathname)) return send({ genres: [{ name: 'rock', count: 5 }, { name: 'pop', count: 2 }, { name: 'synth-pop', count: 1 }, { name: 'x', count: 0 }] });
    if (u.pathname === '/ws/2/artist/') {
      if (q === 'artist:"Band A"') return send({ artists: [{ id: 'ar1', name: 'Band A', score: 100 }] });
      if (q === 'artist:"AC/DC"') return send({ artists: [{ id: 'ar2', name: 'AC/DC', score: 100 }] });
      return send({ artists: [] });
    }
    return send({ error: 'Not Found' }, 404);
  });
  caa = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    caaSeen.push(u.pathname);
    caaUa.push(req.headers['user-agent']);
    if (u.pathname === '/release-group/rg1') return res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ images: [{ front: true, image: 'x' }] }));
    if (u.pathname === '/release-group/rg1/front-500') return res.writeHead(200, { 'content-type': 'image/jpeg' }), res.end(fs.readFileSync(jpg));
    res.writeHead(404);
    res.end();
  });
  fanart = await fakeServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/img/')) return res.writeHead(200, { 'content-type': 'image/jpeg' }), res.end(fs.readFileSync(jpg));
    fanartSeen.push(u.pathname);
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/v3/music/albums/rg2') return send({ albums: { rg2: { albumcover: [{ url: `${fanart.url}/img/rg2.jpg`, lang: '', likes: '1' }] } } });
    if (u.pathname === '/v3/music/albums/rgE') return send({ albums: { rgE: { albumcover: [{ url: `${fanart.url}/img/rgE.jpg`, lang: '', likes: '1' }] } } });
    if (u.pathname === '/v3/music/ar1') return send({ artistthumb: [{ url: `${fanart.url}/img/ar1.jpg`, lang: '', likes: '2' }] });
    return send({}, 404);
  });
  nf = await startAtomix({ ATOMIX_MUSICBRAINZ_BASE: mb.url, ATOMIX_COVERART_BASE: caa.url, ATOMIX_FANART_BASE: fanart.url }, { skipLiveRefresh: true });
  version = nf.app.core.version;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/admin/plugins/musicbrainz/enabled', { enabled: true });
  await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(admin);
});

after(async () => {
  await nf?.app.stop();
  for (const s of [mb, caa, fanart]) await s?.close();
});

const album = (title) => nf.app.core.db.get("SELECT * FROM items WHERE kind = 'album' AND title = ?", title);

test('luceneQuote and normName', () => {
  assert.equal(luceneQuote('Live "Here"'), '"Live \\"Here\\""');
  assert.equal(luceneQuote('a\\b'), '"a\\\\b"');
  assert.equal(normName('The Wall (Deluxe Edition)'), 'wall');
  assert.equal(normName('Rock & Roll!'), 'rock and roll');
  assert.equal(normName('Album [Remastered]'), 'album');
});

test('an album gets its first-release year, genres and Cover Art Archive cover', { skip }, async () => {
  const a = album('Album One');
  assert.equal(a.year, 1985);
  assert.deepEqual(JSON.parse(a.genres), ['Rock', 'Pop', 'Synth-pop']);
  assert.ok(a.poster && !a.poster.startsWith('cache:emb-'), a.poster);
  assert.ok(caaSeen.includes('/release-group/rg1/front-500'));
});

test('an embedded album cover stays', { skip }, async () => {
  const a = album('Embedded');
  assert.match(a.poster, /^cache:emb-/);
  assert.equal(a.year, 1990, 'its other gaps still fill');
  assert.ok(!caaSeen.some((p) => p.includes('rgE')), 'the Cover Art Archive is not asked');
});

test('names with quotes and slashes are escaped', { skip }, async () => {
  const queries = mbSeen.map((s) => s.u.searchParams.get('query') || '');
  assert.ok(queries.some((q) => q.includes('artist:"AC/DC"')));
  assert.ok(queries.some((q) => q.includes('releasegroup:"Live \\"Here\\""')));
  assert.equal(album('Live "Here"').year, 1999);
});

test('a weak or different match is ignored', { skip }, async () => {
  const a = album('Weak');
  assert.equal(a.year, null);
  assert.deepEqual(JSON.parse(a.genres || '[]'), []);
  assert.ok(!mbSeen.some((s) => /rgW/.test(s.u.pathname)), 'no lookup for either');
});

test('the artist and album ids reach Fanart.tv', { skip }, async () => {
  makeAudio(path.join(media, 'Music', 'Band A', 'Album Two', '01.mp3'), { seconds: 1, tags: { title: 'Song', album: 'Album Two', artist: 'Band A', album_artist: 'Band A' } });
  await admin.put('/api/admin/plugins/fanart-tv/config', { apiKey: 'FKEY' });
  await admin.post('/api/admin/plugins/fanart-tv/enabled', { enabled: true });
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  assert.ok(fanartSeen.includes('/v3/music/albums/rg2'), fanartSeen.join());
  assert.ok(fanartSeen.includes('/v3/music/ar1'), fanartSeen.join());
  assert.ok(album('Album Two').poster, "Fanart.tv's cover, since the Cover Art Archive has none");
  assert.ok(caaSeen.includes('/release-group/rg2'));
  assert.ok(!caaSeen.includes('/release-group/rg2/front-500'), 'no dead address passed on');
  // Review gap: Fanart.tv leaves an embedded cover alone too, even when it has one for the album.
  await admin.post(`/api/items/${album('Embedded').id}/refresh`, {});
  assert.ok(!fanartSeen.includes('/v3/music/albums/rgE'), 'not even asked: the album has its cover');
  assert.match(album('Embedded').poster, /^cache:emb-/);
});

test('requests are a second apart and say who is asking', { skip }, async () => {
  for (let i = 1; i < mbSeen.length; i++) assert.ok(mbSeen[i].at - mbSeen[i - 1].at >= 950, `gap ${mbSeen[i].at - mbSeen[i - 1].at} ms`);
  assert.ok(mbSeen.every((s) => s.ua === `Atomix/${version}`), mbSeen[0].ua);
  await admin.put('/api/admin/plugins/musicbrainz/config', { contact: 'me@example.com' });
  const before = mbSeen.length;
  const caaBefore = caaUa.length;
  nf.app.core.db.run('UPDATE items SET poster = NULL WHERE id = ?', album('Album One').id); // so the archive is asked again
  await admin.post(`/api/items/${album('Album One').id}/refresh`, {});
  assert.ok(mbSeen.length > before);
  assert.equal(mbSeen.at(-1).ua, `Atomix/${version} ( me@example.com )`);
  // Review fix F5: the contact email goes only to MusicBrainz, never to the Cover Art Archive.
  assert.ok(caaUa.length > caaBefore, 'the archive was asked');
  assert.ok(caaUa.slice(caaBefore).every((ua) => !String(ua).includes('me@example.com')), caaUa.slice(caaBefore).join(' | '));
});
