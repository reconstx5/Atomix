// Downloads (v0.21): the per-account switch, the settings, and the routes a device uses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let kid;
const ids = {};
const caps = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'] };
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};
before(async () => {
  const media = tempDir();
  if (hasFfmpeg) {
    makeVideo(path.join(media, 'Movies', 'Family (2020)', 'Family (2020).mp4'), { seconds: 2 });
    fs.writeFileSync(path.join(media, 'Movies', 'Family (2020)', 'Family (2020).nfo'), '<movie><title>Family</title><mpaa>G</mpaa></movie>');
    fs.writeFileSync(path.join(media, 'Movies', 'Family (2020)', 'Family (2020).en.srt'), '1\n00:00:00,500 --> 00:00:01,500\nHello there\n');
    makeVideo(path.join(media, 'Movies', 'Grown (2021)', 'Grown (2021).mp4'), { seconds: 2 });
    fs.writeFileSync(path.join(media, 'Movies', 'Grown (2021)', 'Grown (2021).nfo'), '<movie><title>Grown</title><mpaa>R16</mpaa></movie>');
    for (const e of [1, 2]) makeVideo(path.join(media, 'TV', 'Show', 'Season 01', `Show.S01E0${e}.mp4`), { seconds: 1 });
  }
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  if (!hasFfmpeg) return;
  const lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  const tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] })).data.id;
  await waitForScan(admin);
  for (const it of (await admin.get(`/api/libraries/${lib}/items`)).data.items) ids[it.title] = it.id;
  const db = nf.app.core.db;
  ids.season = db.get("SELECT id FROM items WHERE kind = 'season'").id;
  ids.eps = db.all("SELECT id FROM items WHERE kind = 'episode' ORDER BY episode").map((r) => r.id);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => {
  await nf?.app.stop();
});

test('the account switch: admins always, others when switched on', async () => {
  const me = (await admin.get('/api/users')).data.find((u) => u.username === 'dallas');
  assert.equal(me.canDownload, true);
  const u = (await admin.post('/api/users', { username: 'viewer', password: 'viewerpass123', role: 'user' })).data;
  assert.equal(u.canDownload, false);
  assert.equal((await admin.patch(`/api/users/${u.id}`, { canDownload: true })).data.canDownload, true);
  assert.equal((await admin.patch(`/api/users/${u.id}`, { canDownload: false })).data.canDownload, false);
  const a = (await admin.post('/api/users', { username: 'second', password: 'secondpass123', role: 'admin' })).data;
  assert.equal(a.canDownload, true);
});

test('download settings are kept inside their ranges', async () => {
  await admin.put('/api/admin/settings', { downloadOfflineDays: 200, downloadQuality: '4k', downloadsCacheGb: 0, downloadDeviceGb: 9999 });
  const s = (await admin.get('/api/admin/settings')).data;
  assert.equal(s.downloadOfflineDays, 90);
  assert.equal(s.downloadQuality, '720');
  assert.equal(s.downloadsCacheGb, 1);
  assert.equal(s.downloadDeviceGb, 500);
  assert.equal(s.downloadsEnabled, true);
});

test('an account without downloads, and a server with them off, are told why', { skip }, async () => {
  const v = client(nf.base);
  await v.post('/api/auth/login', { username: 'viewer', password: 'viewerpass123' });
  let r = await v.post('/api/downloads', { itemIds: [ids.Family], caps });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "Downloads aren't switched on for this account. Ask an admin.");
  await admin.put('/api/admin/settings', { downloadsEnabled: false });
  r = await admin.post('/api/downloads', { itemIds: [ids.Family], caps });
  assert.equal(r.data.error, 'Downloads are switched off on this server.');
  await admin.put('/api/admin/settings', { downloadsEnabled: true });
});

test('a film, a season in order, and the Kids rules', { skip }, async () => {
  let r = await admin.post('/api/downloads', { itemIds: [ids.Family], quality: '480', caps });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].format, 'mp4');
  assert.equal(r.data.items[0].title, 'Family');
  ids.job = r.data.items[0].jobId;
  r = await admin.post('/api/downloads', { itemIds: [ids.season], caps });
  assert.deepEqual(r.data.items.map((x) => x.itemId), ids.eps);
  r = await kid.post('/api/downloads', { itemIds: [ids.Grown, ids.Family], quality: '480', caps });
  assert.equal(r.data.skipped, 1);
  assert.deepEqual(r.data.items.map((x) => x.itemId), [ids.Family]);
  assert.equal(r.data.items[0].jobId, ids.job, 'the same copy');
  await until(async () => (await admin.get(`/api/downloads/jobs?ids=${ids.job}`)).data[0].status === 'ready');
});

test('the file is served in resumable pieces', { skip }, async () => {
  const job = (await admin.get(`/api/downloads/jobs?ids=${ids.job}`)).data[0];
  let r = await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-199/${job.size}`);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.match(r.headers.get('cache-control'), /no-store/);
  r = await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: `bytes=${job.size}-` } });
  assert.equal(r.status, 416);
  r = await admin.raw(`/api/downloads/${ids.job}/file`);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, job.size);
  const other = client(nf.base);
  await other.post('/api/auth/login', { username: 'viewer', password: 'viewerpass123' });
  await admin.patch(`/api/users/${(await admin.get('/api/users')).data.find((u) => u.username === 'viewer').id}`, { libraryAccess: [], canDownload: true });
  assert.equal((await other.raw(`/api/downloads/${ids.job}/file`)).status, 404, "an account that can't see the title");
});

test("the download's subtitles", { skip }, async () => {
  const subs = (await admin.get(`/api/downloads/${ids.job}/subtitles`)).data;
  assert.equal(subs.length, 1);
  const r = await admin.raw(subs[0].url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/vtt/);
  assert.match(await r.text(), /Hello there/);
});

test('check removes what may no longer be kept', { skip }, async () => {
  let r = await kid.post('/api/downloads/check', { itemIds: [ids.Family] });
  assert.deepEqual(r.data, { keep: [ids.Family], remove: [], offlineDays: 90 }); // the settings test set 90
  await admin.patch(`/api/items/${ids.Family}/details`, { changes: { certification: 'R16' } });
  r = await kid.post('/api/downloads/check', { itemIds: [ids.Family] });
  assert.deepEqual(r.data.remove, [ids.Family], 're-rated above her age');
  assert.deepEqual((await admin.post('/api/downloads/check', { itemIds: [ids.Family] })).data.keep, [ids.Family]);
  await admin.patch(`/api/items/${ids.Family}/details`, { changes: { certification: 'G' } });
  const users = (await admin.get('/api/users')).data;
  const viewer = users.find((u) => u.username === 'viewer');
  await admin.patch(`/api/users/${viewer.id}`, { canDownload: true, libraryAccess: null });
  const v = client(nf.base);
  await v.post('/api/auth/login', { username: 'viewer', password: 'viewerpass123' });
  assert.deepEqual((await v.post('/api/downloads/check', { itemIds: [ids.Family] })).data.keep, [ids.Family]);
  await admin.patch(`/api/users/${viewer.id}`, { canDownload: false });
  r = await v.post('/api/downloads/check', { itemIds: [ids.Family, ids.Grown] });
  assert.equal(r.status, 200, 'check still answers with downloads off');
  assert.deepEqual(r.data.remove.sort(), [ids.Family, ids.Grown].sort());
});

test('offline progress: the newest wins', { skip }, async () => {
  const now = Date.now();
  await admin.post(`/api/items/${ids.Grown}/progress`, { position: 1.5, duration: 2 });
  let r = await admin.post('/api/downloads/progress', { entries: [{ itemId: ids.Grown, position: 0.5, duration: 2, at: now - 3600_000 }] });
  assert.equal(r.data.saved, 0);
  assert.equal((await admin.get(`/api/items/${ids.Grown}`)).data.item.progress.position, 1.5);
  r = await admin.post('/api/downloads/progress', { entries: [{ itemId: ids.Grown, position: 2, duration: 2, at: now + 1000 }] });
  assert.equal(r.data.saved, 1);
  assert.equal((await admin.get(`/api/items/${ids.Grown}`)).data.item.progress.watched, true);
});

test('the Dashboard counts preparing downloads, and Activity notes a first fetch', { skip }, async () => {
  assert.equal(typeof (await admin.get('/api/admin/dashboard')).data.downloadsPreparing, 'number');
  await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: 'bytes=0-9' } });
  await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: 'bytes=0-9' } });
  const entries = (await admin.get('/api/admin/activity?type=download')).data.entries;
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.match(entries[0].text, /^dallas downloaded Family \(480p\)$/);
});

test("a connected server's title is refused", { skip }, async () => {
  const db = nf.app.core.db;
  db.run('UPDATE items SET path = ? WHERE id = ?', (await import('../src/remote/index.js')).REMOTE_PREFIX + '1/x', ids.eps[1]);
  const r = await admin.post('/api/downloads', { itemIds: [ids.eps[1]], caps });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "Downloads aren't available for titles from a connected server yet.");
});

test('switching the server off stops new downloads but keeps what devices hold', { skip }, async () => {
  await admin.put('/api/admin/settings', { downloadsEnabled: false });
  const r = await admin.post('/api/downloads/check', { itemIds: [ids.Grown] });
  assert.deepEqual(r.data.keep, [ids.Grown]);
  await admin.put('/api/admin/settings', { downloadsEnabled: true });
});

test('the folder for prepared copies must be writable', { skip }, async () => {
  const r = await admin.put('/api/admin/settings', { downloadsDir: '/proc/version/nope' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "Atomix can't write to that folder");
});

test('the folder for prepared copies may not be inside a library', { skip }, async () => {
  const lib = (await admin.get('/api/libraries')).data.find((l) => l.type === 'movies');
  const r = await admin.put('/api/admin/settings', { downloadsDir: path.join(lib.paths[0], 'prepared') });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'Pick a folder outside your libraries (they would be scanned as titles).');
});

// ---- v0.22: the v0.21 review's leftovers ----
test("jobs and subtitles need the account's downloads switch (not the server's)", { skip }, async () => {
  const id = (await admin.get('/api/users')).data.find((u) => u.username === 'viewer').id;
  await admin.patch(`/api/users/${id}`, { canDownload: false, libraryAccess: null });
  const v = client(nf.base);
  await v.post('/api/auth/login', { username: 'viewer', password: 'viewerpass123' });
  assert.equal((await v.get(`/api/downloads/jobs?ids=${ids.job}`)).status, 403);
  assert.equal((await v.get(`/api/downloads/${ids.job}/subtitles`)).status, 403);
  await admin.put('/api/admin/settings', { downloadsEnabled: false });
  assert.equal((await admin.get(`/api/downloads/jobs?ids=${ids.job}`)).status, 200, 'the server switch only stops new downloads');
  await admin.put('/api/admin/settings', { downloadsEnabled: true });
});

test('an unknown job answers gone', { skip }, async () => {
  const r = (await admin.get(`/api/downloads/jobs?ids=${ids.job},999999`)).data;
  assert.equal(r.length, 2);
  assert.deepEqual(r[1], { id: 999999, status: 'gone' });
  // A job for a title the profile may not see is gone for it too (never "hidden").
  const db = nf.app.core.db;
  const grown = db.get('SELECT id FROM items WHERE id = ?', ids.Grown);
  const hidden = Number(db.run("INSERT INTO download_jobs (item_id, quality, format, status, created_at, used_at) VALUES (?, '480', 'mp4', 'queued', 1, 1)", grown.id).lastInsertRowid);
  assert.deepEqual((await kid.get(`/api/downloads/jobs?ids=${hidden}`)).data, [{ id: hidden, status: 'gone' }]);
  db.run('DELETE FROM download_jobs WHERE id = ?', hidden);
});

test("asking again refreshes a ready copy's used_at", { skip }, async () => {
  const db = nf.app.core.db;
  const job = db.get('SELECT * FROM download_jobs WHERE id = ?', ids.job);
  db.run('UPDATE download_jobs SET used_at = 1 WHERE id = ?', job.id);
  await admin.post('/api/downloads', { itemIds: [job.item_id], quality: job.quality, caps });
  assert.ok(db.get('SELECT used_at FROM download_jobs WHERE id = ?', job.id).used_at > Date.now() - 60_000);
});

test('extras count as skipped', { skip }, async () => {
  const db = nf.app.core.db;
  const film = db.get('SELECT * FROM items WHERE id = ?', ids.Family);
  const extra = Number(db.run("INSERT INTO items (library_id, kind, parent_id, title, path, extra_kind, added_at, updated_at) VALUES (?, 'extra', ?, 'Trailer', ?, 'trailer', 1, 1)", film.library_id, film.id, film.path).lastInsertRowid);
  const r = (await admin.post('/api/downloads', { itemIds: [extra], caps })).data;
  assert.deepEqual({ items: r.items.length, skipped: r.skipped }, { items: 0, skipped: 1 });
  db.run('DELETE FROM items WHERE id = ?', extra);
});

test("a 416 isn't cached and says the size", { skip }, async () => {
  const job = (await admin.get(`/api/downloads/jobs?ids=${ids.job}`)).data[0];
  const r = await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: `bytes=${job.size}-` } });
  assert.equal(r.status, 416);
  assert.match(r.headers.get('cache-control') || '', /no-store/);
  assert.equal(r.headers.get('content-range'), `bytes */${job.size}`);
});

test("If-Range that doesn't match sends the whole file", { skip }, async () => {
  const job = (await admin.get(`/api/downloads/jobs?ids=${ids.job}`)).data[0];
  const first = await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: 'bytes=0-9' } });
  const etag = first.headers.get('etag');
  await first.arrayBuffer();
  const same = await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: 'bytes=10-19', 'if-range': etag } });
  assert.equal(same.status, 206);
  await same.arrayBuffer();
  const changed = await admin.raw(`/api/downloads/${ids.job}/file`, { headers: { range: 'bytes=10-19', 'if-range': 'W/"not-it"' } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.arrayBuffer()).byteLength, job.size);
});

test('a lowered cache limit prunes at once', { skip }, async () => {
  const q = nf.app.core.downloads;
  let calls = 0;
  const real = q.cleanup.bind(q);
  q.cleanup = (...a) => (calls++, real(...a));
  await admin.put('/api/admin/settings', { downloadsCacheGb: 1 });
  q.cleanup = real;
  assert.equal(calls, 1);
  await admin.put('/api/admin/settings', { downloadsCacheGb: 50 });
});

test('the fetched set is pruned', async () => {
  const { FetchedOnce } = await import('../src/downloads/rules.js');
  let now = 0;
  const f = new FetchedOnce({ max: 3, ttlMs: 1000, now: () => now });
  assert.equal(f.first('a'), true);
  assert.equal(f.first('a'), false, 'once');
  f.first('b');
  f.first('c');
  f.first('d'); // over the cap: the oldest goes
  assert.equal(f.size, 3);
  assert.equal(f.first('a'), true);
  now = 5000; // past the time limit: everything goes
  assert.equal(f.first('b'), true);
  assert.equal(f.size, 1);
});
