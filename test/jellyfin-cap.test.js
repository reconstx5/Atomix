// Atomix's Jellyfin API and the account's stream cap: one slot per signed-in Infuse (per token), however many range
// reads it makes and whichever title it reads; a fifth device is refused; web playback and Infuse share the cap of
// 4; a silent Infuse is freed by the reaper.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { jf, signIn } from './helpers-jellyfin-api.js';
import { toGuid } from '../src/jellyfin/ids.js';
import { JellyfinSessions } from '../src/jellyfin/sessions.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let secret;
const ids = {};
const g = {};
const CAPS = { mp4: true, h264: true, aac: true };

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const m = path.join(media, 'Movies');
  const t = path.join(media, 'TV');
  makeVideo(path.join(m, 'Alpha (2001)', 'Alpha (2001).mp4'));
  makeVideo(path.join(m, 'Beta (2002)', 'Beta (2002).mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show - S01E01.mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] });
  await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] });
  await waitForScan(admin);
  const db = nf.app.core.db;
  ids.alpha = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Alpha'").id;
  ids.beta = db.get("SELECT id FROM items WHERE kind = 'movie' AND title = 'Beta'").id;
  ids.ep = db.get("SELECT id FROM items WHERE kind = 'episode'").id;
  for (const k of ['alpha', 'beta', 'ep']) g[k] = toGuid('item', ids[k]);
  secret = (await admin.post('/api/me/app-passwords', { name: 'Infuse' })).data.secret;
});

after(async () => {
  await nf?.app.stop();
});

const device = async (deviceId) => {
  const { token } = await signIn(nf.base, 'dallas', secret, { deviceId });
  return { token, api: jf(nf.base, { token, deviceId }) };
};
const read = (d, guid, range = 'bytes=0-99') =>
  d.api.raw(`/Videos/${guid}/stream?static=true`, { headers: { Authorization: `MediaBrowser Token="${d.token}"`, Range: range } });
const drain = async (r) => {
  await r.arrayBuffer();
  return r.status;
};
const jellyfinRows = async () => (await admin.get('/api/admin/dashboard')).data.sessions.filter((s) => s.delivery === 'jellyfin');
const stopAll = async (...devices) => {
  for (const d of devices) await d.api.post('/Sessions/Playing/Stopped', {});
};

test('several range reads are one slot', { skip }, async () => {
  const d = await device('dev-several');
  const statuses = await Promise.all([0, 1, 2, 3, 4].map((i) => read(d, g.alpha, `bytes=${i * 100}-${i * 100 + 99}`).then(drain)));
  assert.deepEqual(statuses, [206, 206, 206, 206, 206]);
  const rows = await jellyfinRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, 'direct');
  assert.equal(rows[0].itemId, ids.alpha);
  await stopAll(d);
  assert.equal((await jellyfinRows()).length, 0, 'Stopped frees it');
});

test('switching titles keeps one slot', { skip }, async () => {
  const d = await device('dev-switch');
  for (const guid of [g.alpha, g.ep, g.beta]) assert.equal(await drain(await read(d, guid)), 206);
  const rows = await jellyfinRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, ids.beta);
  await stopAll(d);
});

test('a fifth device is refused', { skip }, async () => {
  const four = [];
  for (let i = 1; i <= 4; i++) four.push(await device(`dev-cap-${i}`));
  for (const d of four) assert.equal(await drain(await read(d, g.alpha)), 206);
  const fifth = await device('dev-cap-5');
  const refused = await read(fifth, g.alpha);
  assert.equal(refused.status, 429);
  assert.ok(!(await refused.text()).includes('ftyp'), 'no bytes of the file are sent');
  assert.equal((await four[0].api.post('/Sessions/Playing/Stopped', { ItemId: g.alpha })).status, 204);
  assert.equal(await drain(await read(fifth, g.alpha)), 206);
  await stopAll(...four, fifth);
});

test('Logout frees the slot', { skip }, async () => {
  const d = await device('dev-logout');
  assert.equal(await drain(await read(d, g.alpha)), 206);
  assert.equal((await jellyfinRows()).length, 1);
  assert.equal((await d.api.post('/Sessions/Logout')).status, 204);
  assert.equal((await jellyfinRows()).length, 0);
});

test('web sessions and Infuse share the cap', { skip }, async () => {
  const web = [];
  for (let i = 0; i < 3; i++) {
    const r = await admin.post(`/api/items/${ids.alpha}/playback`, { caps: CAPS });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    web.push(r.data.sessionId);
  }
  const d = await device('dev-shared');
  assert.equal(await drain(await read(d, g.beta)), 206);
  const next = await admin.post(`/api/items/${ids.alpha}/playback`, { caps: CAPS });
  assert.equal(next.status, 429);
  for (const id of web) await admin.post(`/api/playback/${id}/stop`, {});
  await stopAll(d);
});

test('an idle Infuse stream is freed', () => {
  let clock = 1000;
  const playback = { externalLists: [], sessionsOf(userId) { return this.externalLists.flatMap((fn) => fn(userId)); } };
  const sessions = new JellyfinSessions({ playback, now: () => clock, idleMs: 50 });
  try {
    const user = { id: 7, username: 'dallas' };
    sessions.open({ tokenRow: { id: 1 }, user, profile: { id: 3 }, item: { id: 10, title: 'Alpha' }, clientIp: '127.0.0.1', client: { client: 'Infuse' } });
    assert.equal(playback.sessionsOf(7).length, 1, 'it counts toward the account');
    clock += 40;
    sessions.reap();
    assert.equal(sessions.list().length, 1, 'not idle yet');
    sessions.touch(1, { position: 12 });
    clock += 40;
    sessions.reap();
    assert.equal(sessions.list().length, 1, 'a touch keeps it');
    assert.equal(sessions.list()[0].position, 12);
    clock += 60;
    sessions.reap();
    assert.equal(sessions.list().length, 0);
    assert.equal(playback.sessionsOf(7).length, 0);
  } finally {
    sessions.close();
  }
});
