// Syncing a Plex library: details only when a title changed, a failed detail retried, kids rules, server dates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client, waitForScan } from './helpers.js';
import { fakePlex, plexMovie } from './helpers-plex.js';

let px, nf, admin, kid;
const ids = {};
const detail = (rk, title, extra = {}) => plexMovie(rk, title, { Media: [{ container: 'mkv', Part: [{ key: `/library/parts/${rk}/1/file.mkv`, Stream: [{ streamType: 1, codec: 'h264', width: 1280, height: 720, bitDepth: 8 }, { streamType: 2, codec: 'aac', channels: 2, languageCode: 'eng', default: true }] }] }], ...extra });

before(async () => {
  px = await fakePlex({
    sections: [{ key: '1', title: 'Movies', type: 'movie' }],
    items: { 1: { 1: [plexMovie('11', 'Family Film', { contentRating: 'gb/PG' }), plexMovie('12', 'Late Night', { contentRating: 'TV-MA', addedAt: 1600000000 })] } },
    details: { 11: detail('11', 'Family Film'), 12: detail('12', 'Late Night'), 13: detail('13', 'Newcomer') },
  });
  nf = await startAtomix();
  nf.app.core.remote.sync.paceMs = 0;
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const db = nf.app.core.db;
  ids.server = Number(db.run("INSERT INTO servers (kind, name, url, username, secret, remote_user_id, created_at) VALUES ('plex', 'Dev Plex', ?, 'dallas', 'srv1', 'mach1', ?)", px.url, Date.now()).lastInsertRowid);
  ids.movies = Number(db.run("INSERT INTO libraries (name, type, paths, options, created_at, server_id, remote_id) VALUES ('Movies', 'movies', '[]', '{}', ?, ?, '1')", Date.now(), ids.server).lastInsertRowid);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => { await nf?.app.stop(); await px?.close(); });

const row = (title) => ({ ...nf.app.core.db.get('SELECT * FROM items WHERE title = ?', title) });
const detailCalls = () => px.calls.filter((c) => /^\/library\/metadata\/\d+$/.test(c.path)).length;
const sync = async () => { await admin.post(`/api/libraries/${ids.movies}/scan`, {}); await waitForScan(admin); };

test('a first sync stores details (tracks), the server\'s added date and remote_updated', () => {
  const f = row('Family Film');
  const media = JSON.parse(f.media);
  assert.equal(media.detailed, true);
  assert.equal(media.audio[0].language, 'eng');
  assert.equal(media.plexPart, '/library/parts/11/1/file.mkv');
  assert.equal(f.remote_updated, 1710000000000);
  assert.equal(f.added_at, 1700000000000);
  assert.equal(row('Late Night').added_at, 1600000000000);
  assert.match(f.poster, /\/library\/metadata\/11\/thumb\/1700000000$/);
});

test('a second sync with nothing changed makes no detail requests; a changed updatedAt makes exactly one', async () => {
  px.calls.length = 0;
  await sync();
  assert.equal(detailCalls(), 0);
  assert.equal(JSON.parse(row('Family Film').media).detailed, true, 'stored tracks are kept, not replaced by the listing');
  px.state.items[1][1][0].updatedAt = 1720000000;
  px.calls.length = 0;
  await sync();
  assert.equal(detailCalls(), 1);
  assert.equal(row('Family Film').remote_updated, 1720000000000);
});

test('a failed detail request keeps the listing\'s media and asks again next sync', async () => {
  px.state.items[1][1].push(plexMovie('13', 'Newcomer'));
  px.state.detailFail = true;
  await sync();
  const n = row('Newcomer');
  assert.ok(n.media, 'the listing media');
  assert.ok(!JSON.parse(n.media).detailed);
  assert.equal(n.remote_updated, null);
  px.state.detailFail = false;
  px.calls.length = 0;
  await sync();
  assert.equal(detailCalls(), 1, 'asked again');
  assert.equal(JSON.parse(row('Newcomer').media).detailed, true);
});

test('kids rules apply to Plex titles: TV-MA hidden from a 10-year-old profile, gb/PG shown', async () => {
  const titles = (await kid.get(`/api/libraries/${ids.movies}/items`)).data.items.map((i) => i.title);
  assert.ok(titles.includes('Family Film'));
  assert.ok(!titles.includes('Late Night'));
  assert.equal(row('Late Night').min_age, 17);
});

test('a failed detail request for a changed title keeps its stored tracks (and its poster version)', async () => {
  const was = row('Family Film');
  px.state.items[1][1][0].updatedAt = 1730000000;
  px.state.detailFail = true;
  await sync();
  px.state.detailFail = false;
  const now = row('Family Film');
  assert.equal(JSON.parse(now.media).detailed, true, 'still the real tracks');
  assert.equal(now.metadata_at, was.metadata_at, 'nothing written, so the poster ?v= stays');
  assert.equal(now.remote_updated, was.remote_updated, 'asked again next sync');
});
