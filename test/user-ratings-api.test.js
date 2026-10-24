// Stars and hearts: per profile, for songs, albums, artists, films and shows; any profile (Kids included) may rate
// what it can see; every item the API returns carries the viewer's play count, last played, stars and favourite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let other; // a second grown-up profile on dallas's account
let kid; // a G-only Kids profile
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  for (const [folder, rating] of [['Cartoon (2020)', 'NZ:G'], ['Scary (2018)', 'R16']]) {
    makeVideo(path.join(m, folder, `${folder}.mp4`));
    fs.writeFileSync(path.join(m, folder, `${folder}.nfo`), `<movie><title>${folder.replace(/ \(\d+\)$/, '')}</title><mpaa>${rating}</mpaa></movie>`);
  }
  const t = path.join(media, 'TV');
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show.S01E01.mp4'));
  fs.writeFileSync(path.join(t, 'Show', 'tvshow.nfo'), '<tvshow><title>Show</title><mpaa>NZ:G</mpaa></tvshow>');
  makeAudio(path.join(media, 'Music', 'The Band', 'First Record', '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/1' }, seconds: 3 });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title] = it.id;
  for (const it of (await admin.get(`/api/libraries/${ids.tv}/items`)).data.items) ids[it.title] = it.id;
  const show = (await admin.get(`/api/items/${ids.Show}`)).data;
  ids.season = show.seasons[0].id;
  ids.E1 = (await admin.get(`/api/items/${ids.season}`)).data.episodes[0].id;
  const track = (await admin.get(`/api/libraries/${ids.music}/items?view=tracks`)).data.items[0];
  ids.track = track.id;
  ids.album = track.parentId;
  const sam = (await admin.post('/api/profiles', { name: 'Sam', avatar: 'blue' })).data;
  other = client(nf.base);
  await other.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await other.post(`/api/profiles/${sam.id}/select`, {});
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});

after(async () => {
  await nf?.app.stop();
});

test('stars and hearts are per profile', { skip }, async () => {
  const r = await admin.put(`/api/items/${ids.Cartoon}/rating`, { stars: 4, favourite: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { stars: 4, favourite: true });
  const mine = (await admin.get(`/api/items/${ids.Cartoon}`)).data.item;
  assert.equal(mine.stars, 4);
  assert.equal(mine.favourite, true);
  const theirs = (await other.get(`/api/items/${ids.Cartoon}`)).data.item;
  assert.equal(theirs.stars, null);
  assert.equal(theirs.favourite, false);
  // Lists of items carry them too.
  const listed = (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items.find((i) => i.id === ids.Cartoon);
  assert.equal(listed.stars, 4);
  assert.equal(listed.favourite, true);
});

test('leaving a field out keeps it', { skip }, async () => {
  assert.deepEqual((await admin.put(`/api/items/${ids.Cartoon}/rating`, { favourite: false })).data, { stars: 4, favourite: false });
});

test('null clears the stars', { skip }, async () => {
  assert.deepEqual((await admin.put(`/api/items/${ids.Cartoon}/rating`, { stars: null })).data, { stars: null, favourite: false });
  assert.equal((await admin.get(`/api/items/${ids.Cartoon}`)).data.item.stars, null);
});

test("seasons and episodes can't be rated", { skip }, async () => {
  for (const id of [ids.season, ids.E1]) {
    const r = await admin.put(`/api/items/${id}/rating`, { stars: 3 });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'Only songs, albums, artists, films and shows can be rated.');
  }
  for (const stars of [6, 0, 2.5, 'x']) {
    const r = await admin.put(`/api/items/${ids.Show}/rating`, { stars });
    assert.equal(r.status, 400, String(stars));
    assert.equal(r.data.error, 'Stars are 1 to 5.');
  }
  for (const id of [ids.Show, ids.album, ids.track]) assert.equal((await admin.put(`/api/items/${id}/rating`, { stars: 5 })).status, 200);
});

test("a Kids profile can rate what it sees, not what it can't", { skip }, async () => {
  assert.equal((await kid.put(`/api/items/${ids.Cartoon}/rating`, { stars: 5 })).status, 200);
  assert.equal((await kid.get(`/api/items/${ids.Cartoon}`)).data.item.stars, 5);
  assert.equal((await kid.put(`/api/items/${ids.Scary}/rating`, { stars: 5 })).status, 404);
  assert.equal((await admin.get(`/api/items/${ids.Cartoon}`)).data.item.stars, null, "the kid's stars are the kid's");
});

test('items carry play counts', { skip }, async () => {
  const before = (await admin.get(`/api/items/${ids.album}`)).data.tracks[0];
  assert.equal(before.playCount, 0);
  assert.equal(before.lastPlayed, null);
  const profileId = nf.app.core.db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  const item = nf.app.core.library.get(ids.track);
  const plays = nf.app.core.plays;
  plays.report({ profileId, item, position: 0, watched: true, client: 'browser' });
  nf.app.core.db.run('UPDATE plays SET counted = 1, updated_at = updated_at - 8 * 3600000');
  plays.report({ profileId, item, position: 0, client: 'browser' });
  nf.app.core.db.run('UPDATE plays SET counted = 1');
  const after = (await admin.get(`/api/items/${ids.album}`)).data.tracks[0];
  assert.equal(after.playCount, 2);
  assert.ok(after.lastPlayed > Date.now() - 60_000);
  assert.equal((await other.get(`/api/items/${ids.album}`)).data.tracks[0].playCount, 0);
  assert.equal((await admin.get(`/api/items/${ids.album}`)).data.item.playCount, null, 'albums have no count of their own');
});

// ---- v0.21 tidy-up ----
test('favourite "false" (a string) is false', { skip }, async () => {
  const id = Object.values(ids).find((v) => typeof v === 'number');
  await admin.put(`/api/items/${id}/rating`, { favourite: true });
  assert.equal((await admin.put(`/api/items/${id}/rating`, { favourite: 'false' })).data.favourite, false);
  assert.equal((await admin.put(`/api/items/${id}/rating`, { favourite: 'true' })).data.favourite, true);
  assert.equal((await admin.put(`/api/items/${id}/rating`, { favourite: 0 })).data.favourite, false);
});
