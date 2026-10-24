// The activity log: what happened, who, from where — sign-ins, profiles, settings (names only), app passwords,
// plays, Watch together, Quick Connect — filtered, 50 at a time, kept 30 days, for admins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { rest } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  makeVideo(path.join(media, 'Movies', 'The Test Movie (2020)', 'The Test Movie (2020).mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  await waitForScan(admin);
  ids.film = (await admin.get(`/api/libraries/${ids.lib}/items`)).data.items[0].id;
});

after(async () => {
  await nf?.app.stop();
});

const entries = async (q = '') => (await admin.get(`/api/admin/activity${q}`)).data;
const texts = async (q) => (await entries(q)).entries.map((e) => e.text);

test('things that happen are logged with who and where', { skip }, async () => {
  assert.equal((await client(nf.base).post('/api/auth/login', { username: 'dallas', password: 'nope' })).status, 401);
  await client(nf.base).post('/api/auth/login', { username: 'nobody', password: 'nope' });
  await client(nf.base).post('/api/auth/login', { username: 'dallas', password: 'password123' });
  nf.app.core.auth.attempts.clear();
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data;
  await admin.put('/api/admin/settings', { maxTranscodes: 2, tmdbApiKey: 'secretkey-abcdef-123456' });
  const pw = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data;
  await rest(nf.base, 'ping', { u: 'dallas', p: pw.secret });
  await rest(nf.base, 'ping', { u: 'dallas', p: pw.secret }); // only the first use is news
  await admin.del(`/api/me/app-passwords/${pw.id}`);
  const core = nf.app.core;
  const profileId = core.db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  core.plays.report({ profileId, item: core.library.get(ids.film), position: 0, client: 'cast' });
  core.plays.report({ profileId, item: core.library.get(ids.film), position: 100, watched: true, client: 'cast' });
  await admin.del(`/api/profiles/${mia.id}`);
  await admin.post('/api/users', { username: 'sam', password: 'sampass123' });
  const all = await texts();
  for (const t of [
    'Wrong password for dallas',
    'Unknown username',
    'dallas signed in',
    'dallas added the profile Mia',
    'dallas changed maxTranscodes, tmdbApiKey',
    'dallas made an app password for Phone',
    'Phone signed in for the first time',
    'dallas revoked Phone',
    'dallas started The Test Movie (cast)',
    'dallas finished The Test Movie (cast)',
    'dallas removed the profile Mia',
    'dallas added the user sam',
  ]) assert.ok(all.includes(t), `${t} in ${JSON.stringify(all)}`);
  assert.equal(all.filter((t) => t === 'Phone signed in for the first time').length, 1);
  const json = JSON.stringify(await entries());
  for (const secret of ['secretkey-abcdef-123456', pw.secret, 'password123', 'nope']) assert.ok(!json.includes(secret), secret);
  const first = (await entries()).entries[0];
  assert.equal(first.text, 'dallas added the user sam', 'newest first');
  assert.equal(first.type, 'users');
  assert.equal(first.user, 'dallas');
  assert.equal(first.profile, 'dallas');
  assert.match(first.ip, /127\.0\.0\.1/);
  assert.ok(first.at > Date.now() - 60_000);
});

test('filters: type, profile and day', { skip }, async () => {
  assert.deepEqual(await texts('?type=sign-in-failed'), ['Unknown username', 'Wrong password for dallas']);
  const pid = nf.app.core.db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  assert.ok((await texts(`?profile=${pid}`)).includes('dallas started The Test Movie (cast)'));
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.ok((await texts(`?day=${today}`)).length > 5);
  assert.deepEqual(await texts('?day=2001-01-01'), []);
});

test('50 at a time', { skip }, async () => {
  for (let i = 0; i < 60; i++) nf.app.core.activity.add({ type: 'scan', text: `Scan ${i}` });
  const page1 = await entries('?type=scan');
  assert.equal(page1.entries.length, 50);
  assert.equal(page1.more, true);
  const page2 = await entries(`?type=scan&before=${page1.entries.at(-1).id}`);
  assert.equal(page2.more, false);
  assert.ok(page2.entries.length >= 10);
  assert.ok(page2.entries.every((e) => e.id < page1.entries.at(-1).id));
});

test('kept 30 days', { skip }, async () => {
  const a = nf.app.core.activity;
  nf.app.core.db.run("INSERT INTO activity (at, type, text) VALUES (?, 'scan', 'Old news')", Date.now() - 31 * 86400_000);
  a.prune();
  assert.ok(!(await texts('?type=scan')).includes('Old news'));
});

test('admins only', { skip }, async () => {
  const sam = client(nf.base);
  await sam.post('/api/auth/login', { username: 'sam', password: 'sampass123' });
  assert.equal((await sam.get('/api/admin/activity')).status, 403);
  const kidP = (await admin.post('/api/profiles', { name: 'Kiddo', kids: true, maxAge: 10 })).data;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidP.id}/select`, {});
  assert.equal((await kid.get('/api/admin/activity')).status, 403);
});

test('recordings starting, finishing and failing are logged', { skip }, async () => {
  const rec = nf.app.core.live.recordings;
  const db = nf.app.core.db;
  const pid = db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  const id = Number(db.run("INSERT INTO live_recordings (profile_id, source, channel_key, title, start, end, status, created_at) VALUES (?, 's', 'k', 'Seven Sharp', 1, 2, 'scheduled', 1)", pid).lastInsertRowid);
  rec.update(id, { status: 'recording' });
  rec.update(id, { gapSeconds: 3 }); // not a status change
  rec.update(id, { status: 'done' });
  const id2 = Number(db.run("INSERT INTO live_recordings (profile_id, source, channel_key, title, start, end, status, created_at) VALUES (?, 's', 'k', 'News', 1, 2, 'recording', 1)", pid).lastInsertRowid);
  rec.update(id2, { status: 'failed', error: 'The stream stopped' });
  const t = await texts('?type=recording');
  assert.deepEqual(t, ['Recording News failed: The stream stopped', 'Recording Seven Sharp finished', 'Recording Seven Sharp started']);
});

test('review fixes: a recording failure never logs an address', { skip }, async () => {
  const rec = nf.app.core.live.recordings;
  const db = nf.app.core.db;
  const pid = db.get("SELECT id FROM profiles WHERE name = 'dallas'").id;
  const id = Number(db.run("INSERT INTO live_recordings (profile_id, source, channel_key, title, start, end, status, created_at) VALUES (?, 's', 'k', 'Quiz', 1, 2, 'recording', 1)", pid).lastInsertRowid);
  rec.update(id, { status: 'failed', error: 'ffmpeg: http://provider.example:8080/live/user/pass/123.ts: 403 Forbidden' });
  const t = (await texts('?type=recording')).find((x) => x.startsWith('Recording Quiz'));
  assert.ok(!/provider\.example|http|pass/.test(t), t);
  assert.equal(t, 'Recording Quiz failed: ffmpeg: <address>: 403 Forbidden');
});

// ---- v0.21 tidy-up ----
test("the Activity filter's profiles: every account's (admins only)", { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  await admin.post('/api/users', { username: 'otheracct', password: 'otherpass123', role: 'user' });
  const other = client(nf.base);
  await other.post('/api/auth/login', { username: 'otheracct', password: 'otherpass123' });
  const list = await admin.get('/api/admin/profiles');
  assert.equal(list.status, 200);
  assert.ok(list.data.some((p) => p.owner === 'otheracct'), JSON.stringify(list.data));
  assert.ok(list.data.every((p) => typeof p.id === 'number' && p.name && p.owner));
  assert.equal((await other.get('/api/admin/profiles')).status, 403);
});
