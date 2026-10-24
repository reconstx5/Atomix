// Smart playlists over HTTP: making, opening (worked out each time), sharing (worked out for the viewer — a Kids
// profile gets only what it may see), refusing hand edits and bad rules, and Up next following the order shown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let guest;
let kid;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const m = path.join(media, 'Movies');
  for (const [folder, rating] of [['Alien (1979)', 'R16'], ['Cartoon (2020)', 'NZ:G'], ['Scary (2018)', 'R16'], ['Picnic (2015)', 'NZ:G']]) {
    makeVideo(path.join(m, folder, `${folder}.mp4`));
    fs.writeFileSync(path.join(m, folder, `${folder}.nfo`), `<movie><title>${folder.replace(/ \(\d+\)$/, '')}</title><year>${folder.match(/\d{4}/)[0]}</year><mpaa>${rating}</mpaa></movie>`);
  }
  makeAudio(path.join(media, 'Music', 'The Band', 'First Record', '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/2', genre: 'Rock' } });
  makeAudio(path.join(media, 'Music', 'The Band', 'First Record', '02 Closer.mp3'), { tags: { title: 'Closer', artist: 'The Band', album: 'First Record', track: '2/2', genre: 'Rock' } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.movies = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${ids.movies}/items`)).data.items) ids[it.title] = it.id;
  for (const t of (await admin.get(`/api/libraries/${ids.music}/items?view=tracks`)).data.items) ids[t.title] = t.id;
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
});

after(async () => {
  await nf?.app.stop();
});

const everything = (sort = 'title') => ({ match: 'all', rules: [], sort, limit: {} });

test('making and opening a smart playlist', { skip }, async () => {
  await admin.put(`/api/items/${ids.Alien}/rating`, { stars: 5 });
  await admin.put(`/api/items/${ids.Cartoon}/rating`, { stars: 4 });
  await admin.put(`/api/items/${ids.Scary}/rating`, { stars: 2 });
  const rules = { match: 'all', rules: [{ field: 'stars', op: 'gte', value: 4 }], sort: 'stars', limit: {} };
  const made = await admin.post('/api/lists', { kind: 'smart', name: 'Top', media: 'video', rules });
  assert.equal(made.status, 200);
  assert.equal(made.data.kind, 'smart');
  assert.equal(made.data.media, 'video');
  assert.deepEqual(made.data.rules, rules);
  assert.deepEqual(made.data.items.map((i) => i.title), ['Alien', 'Cartoon']);
  await admin.put(`/api/items/${ids.Picnic}/rating`, { stars: 5 });
  const again = (await admin.get(`/api/lists/${made.data.id}`)).data;
  assert.deepEqual(again.items.map((i) => i.title), ['Alien', 'Picnic', 'Cartoon'], 'worked out again, never stored');
  const card = (await admin.get('/api/lists')).data.find((l) => l.id === made.data.id);
  assert.equal(card.kind, 'smart');
  assert.equal(card.media, 'video');
  assert.equal(card.count, 3);
  // Changing the rules (and the name) by PATCH.
  const patched = await admin.patch(`/api/lists/${made.data.id}`, { name: 'Five stars', rules: { ...rules, rules: [{ field: 'stars', op: 'is', value: 5 }], sort: 'title' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.name, 'Five stars');
  assert.deepEqual(patched.data.items.map((i) => i.title), ['Alien', 'Picnic']);
  ids.top = made.data.id;
});

test('a smart song playlist', { skip }, async () => {
  const r = await admin.post('/api/lists', { kind: 'smart', name: 'Rock', media: 'music', rules: { match: 'all', rules: [{ field: 'genre', op: 'is', value: 'rock' }], sort: 'title', limit: { items: 1 } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items.map((i) => i.title), ['Closer']);
  assert.equal(r.data.items[0].albumTitle, 'First Record');
});

test('a shared smart list is evaluated for its viewer', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'smart', name: 'All films', media: 'video', rules: everything() })).data;
  assert.equal((await kid.get(`/api/lists/${list.id}`)).status, 404, 'not shared yet');
  await admin.patch(`/api/lists/${list.id}`, { shared: true });
  const card = (await kid.get('/api/lists')).data.find((l) => l.id === list.id);
  assert.ok(card, 'listed for the kid');
  assert.equal(card.count, 2);
  const got = (await kid.get(`/api/lists/${list.id}`)).data;
  assert.deepEqual(got.items.map((i) => i.title), ['Cartoon', 'Picnic']);
  assert.equal(got.own, false);
  // Stars are the viewer's own: the kid's stars rule sees the kid's stars.
  const kids = (await kid.post('/api/lists', { kind: 'smart', name: 'Mine', media: 'video', rules: { match: 'all', rules: [{ field: 'stars', op: 'set' }], sort: 'title', limit: {} } })).data;
  assert.deepEqual(kids.items, []);
  await kid.put(`/api/items/${ids.Picnic}/rating`, { stars: 3 });
  assert.deepEqual((await kid.get(`/api/lists/${kids.id}`)).data.items.map((i) => i.title), ['Picnic']);
  // Another account sees the whole list (its own access applies).
  assert.equal((await guest.get(`/api/lists/${list.id}`)).data.items.length, 4);
  ids.all = list.id;
});

test("smart lists can't be added to by hand", { skip }, async () => {
  const sentence = 'A smart playlist fills itself — change its rules instead.';
  const add = await admin.post(`/api/lists/${ids.top}/items`, { itemId: ids.Scary });
  assert.equal(add.status, 400);
  assert.equal(add.data.error, sentence);
  assert.equal((await admin.del(`/api/lists/${ids.top}/items/${ids.Alien}`)).data.error, sentence);
  assert.equal((await admin.put(`/api/lists/${ids.top}/items/${ids.Alien}/position`, { position: 1 })).data.error, sentence);
});

test('bad rules are refused on save', { skip }, async () => {
  const bad = await admin.post('/api/lists', { kind: 'smart', name: 'Bad', media: 'video', rules: { match: 'all', rules: [{ field: 'year', op: 'gte', value: 'later' }], sort: 'title', limit: {} } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'Rule 1: give a number.');
  assert.equal((await admin.post('/api/lists', { kind: 'smart', name: 'Bad', media: 'films', rules: everything() })).data.error, 'A smart playlist is for songs or for videos.');
  assert.equal((await admin.post('/api/lists', { kind: 'smart', name: '', media: 'video', rules: everything() })).data.error, 'Give the playlist a name.');
  assert.equal((await admin.patch(`/api/lists/${ids.top}`, { rules: { rules: [{ field: 'album', op: 'is', value: 'x' }] } })).data.error, 'Rule 1: Atomix doesn\'t know "album".', 'checked against its media');
  assert.equal((await guest.patch(`/api/lists/${ids.all}`, { rules: everything() })).status, 403);
  assert.equal((await admin.patch(`/api/lists/${ids.all}`, { media: 'music', rules: everything() })).data.media, 'music', 'media can change with its rules');
  await admin.patch(`/api/lists/${ids.all}`, { media: 'video', rules: everything() });
  const plain = (await admin.post('/api/lists', { kind: 'video', name: 'Plain' })).data;
  assert.equal((await admin.patch(`/api/lists/${plain.id}`, { rules: everything() })).data.error, 'Only a smart playlist has rules.');
});

test('up next follows the smart order', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'smart', name: 'Shuffle', media: 'video', rules: everything('random') })).data;
  const shown = (await admin.get(`/api/lists/${list.id}`)).data.items.map((i) => i.id);
  for (let i = 0; i < 3; i++) {
    const next = (await admin.get(`/api/playback/next?list=${list.id}&after=${shown[i]}`)).data.next;
    assert.equal(next.id, shown[i + 1]);
  }
  const s = (await admin.post(`/api/items/${shown[0]}/playback`, { listId: list.id, caps: {} })).data;
  assert.equal(s.next.id, shown[1]);
  await admin.post(`/api/playback/${s.sessionId}/stop`, {});
});

test("the builder's vocabulary comes from the server", { skip }, async () => {
  const f = (await admin.get('/api/smart/fields')).data;
  assert.deepEqual(f.sorts, ['random', 'added', 'stars', 'mostPlayed', 'lastPlayed', 'title', 'year']);
  assert.ok(f.music.some((x) => x.key === 'album' && x.label === 'album'));
  assert.ok(!f.video.some((x) => x.key === 'album'));
  assert.deepEqual(f.video.find((x) => x.key === 'lastPlayed').ops, ['inLast', 'notInLast', 'set', 'notSet']);
});

// ---- v0.21 tidy-up ----
test('a media change without rules keeps the rules', { skip }, async () => {
  const rules = { match: 'all', rules: [{ field: 'stars', op: 'is', value: 5 }], sort: 'title', limit: {} };
  const list = (await admin.post('/api/lists', { kind: 'smart', name: 'Keep me', media: 'video', rules })).data;
  const before = nf.app.core.db.get('SELECT rules FROM lists WHERE id = ?', list.id).rules;
  const r = await admin.patch(`/api/lists/${list.id}`, { media: 'video' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(nf.app.core.db.get('SELECT rules FROM lists WHERE id = ?', list.id).rules, before);
  await admin.del(`/api/lists/${list.id}`);
});

test('the shuffle is per profile and per device', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'smart', name: 'Two devices', media: 'video', rules: everything('random') })).data;
  const other = client(nf.base);
  await other.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  const me = nf.app.core.db.get('SELECT profile_id FROM sessions ORDER BY created_at LIMIT 1')?.profile_id;
  if (me) await other.post(`/api/profiles/${me}/select`, {});
  await admin.get(`/api/lists/${list.id}`);
  await other.get(`/api/lists/${list.id}`);
  const keys = [...nf.app.core.lists.seeds.keys()].filter((k) => k.startsWith(`${list.id}:`));
  assert.equal(keys.length, 2, `each device its own shuffle: ${keys.join(', ')}`);
  await admin.del(`/api/lists/${list.id}`);
});

test('smart lists skip the second visibility pass', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'smart', name: 'Once', media: 'video', rules: everything() })).data;
  const lib = nf.app.core.library;
  const real = lib.canSee;
  let calls = 0;
  lib.canSee = function (...a) {
    calls++;
    return real.apply(this, a);
  };
  try {
    const shown = (await admin.get(`/api/lists/${list.id}`)).data.items;
    await admin.get(`/api/playback/next?list=${list.id}&after=${shown[0].id}`);
    assert.equal(calls, 0, `canSee called ${calls} times for a smart list`);
  } finally {
    lib.canSee = real;
    await admin.del(`/api/lists/${list.id}`);
  }
});

test('a PATCH with good rules and an empty name saves nothing (v0.22)', { skip }, async () => {
  const list = (await admin.post('/api/lists', { kind: 'smart', name: 'Keep', media: 'video', rules: everything('title') })).data;
  const before = (await admin.get(`/api/lists/${list.id}`)).data.rules;
  const r = await admin.patch(`/api/lists/${list.id}`, { name: '   ', rules: everything('random') });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Give the playlist a name.');
  const after = (await admin.get(`/api/lists/${list.id}`)).data;
  assert.deepEqual(after.rules, before, 'its rules are as they were');
  assert.equal(after.name, 'Keep');
});
