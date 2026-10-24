// v0.15.0: an unplugged drive doesn't wipe a library, migration 14's indexes, the show page's own next-up lookup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { openDatabase, MIGRATIONS } from '../src/db.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf, admin, root, aside, lib;

before(async () => {
  if (!hasFfmpeg) return;
  const base = tempDir();
  root = path.join(base, 'drive');
  aside = path.join(base, 'aside');
  fs.mkdirSync(root);
  fs.mkdirSync(aside);
  makeVideo(path.join(root, 'Film A (2020).mp4'), { seconds: 2 });
  makeVideo(path.join(root, 'Film B (2021).mp4'), { seconds: 2 });
  nf = await startAtomix();
  await nf.app.core.tasks.stop();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.put('/api/admin/settings', { previewsEnabled: false, introDetection: false });
  lib = (await admin.post('/api/libraries', { name: 'Drive', type: 'movies', paths: [root] })).data;
  await admin.post('/api/scan', {});
  await waitForScan(admin);
});

after(async () => { await nf?.app.stop(); });

const items = async () => (await admin.get(`/api/libraries/${lib.id}/items`)).data.items;

test('a root that is a folder but yields no files keeps its titles and warns; the drive back brings no new ids', { skip }, async () => {
  const before = await items();
  assert.equal(before.length, 2);
  await admin.post(`/api/items/${before[0].id}/progress`, { position: 30, duration: 120 });
  for (const f of fs.readdirSync(root)) fs.renameSync(path.join(root, f), path.join(aside, f)); // the drive "unplugged": the mount point stays
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const during = await items();
  assert.equal(during.length, 2, 'nothing pruned');
  const status = (await admin.get('/api/scan/status')).data;
  assert.match(status.warning || '', /looks empty/);
  for (const f of fs.readdirSync(aside)) fs.renameSync(path.join(aside, f), path.join(root, f));
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const after = await items();
  assert.deepEqual(after.map((i) => i.id).sort(), before.map((i) => i.id).sort(), 'the same titles, same ids');
  assert.equal((await admin.get('/api/scan/status')).data.warning, null);
  const p = nf.app.core.db.get('SELECT position FROM progress WHERE item_id = ?', before[0].id);
  assert.equal(p.position, 30, 'watch history survived');
});

test('Remove missing titles empties a library whose folder was emptied on purpose (a dry run counts first)', { skip }, async () => {
  const gone = path.join(tempDir(), 'gone');
  fs.mkdirSync(gone);
  makeVideo(path.join(gone, 'Film C (2022).mp4'), { seconds: 2 });
  const l2 = (await admin.post('/api/libraries', { name: 'Gone', type: 'movies', paths: [gone] })).data;
  await admin.post(`/api/libraries/${l2.id}/scan`, {});
  await waitForScan(admin);
  const count = () => nf.app.core.db.get('SELECT COUNT(*) AS n FROM items WHERE library_id = ?', l2.id).n;
  assert.equal(count(), 1);
  for (const f of fs.readdirSync(gone)) fs.rmSync(path.join(gone, f));
  const dry = await admin.post(`/api/admin/libraries/${l2.id}/remove-missing`, { dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.deepEqual(dry.data, { count: 1 });
  assert.equal(count(), 1, 'a dry run removes nothing');
  const done = await admin.post(`/api/admin/libraries/${l2.id}/remove-missing`, {});
  assert.deepEqual(done.data, { removed: 1 });
  assert.equal(count(), 0);
});

test('a truly empty new library still scans to nothing without a warning', { skip }, async () => {
  const empty = path.join(tempDir(), 'empty');
  fs.mkdirSync(empty);
  const l = (await admin.post('/api/libraries', { name: 'Empty', type: 'movies', paths: [empty] })).data;
  await admin.post(`/api/scan`, { libraryId: l.id });
  await waitForScan(admin);
  assert.equal((await admin.get('/api/scan/status')).data.warning, null);
  assert.equal((await admin.get(`/api/libraries/${l.id}/items`)).data.items.length, 0);
});

test('migration 14 adds the progress and sessions indexes', () => {
  const db = openDatabase(path.join(tempDir(), 'm14.db'));
  const idx = db.all("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
  assert.ok(idx.includes('progress_item'), 'progress(item_id)');
  assert.ok(idx.includes('sessions_profile'), 'sessions(profile_id)');
  const plan = db.all('EXPLAIN QUERY PLAN DELETE FROM progress WHERE item_id = ?', 1).map((r) => r.detail).join(' ');
  assert.match(plan, /progress_item/);
  assert.ok(MIGRATIONS.length >= 14);
});

test('nextUpFor finds the next episode of one show', { skip }, async () => {
  const { library } = nf.app.core;
  const db = nf.app.core.db;
  const now = Date.now();
  const showId = Number(db.run("INSERT INTO items (library_id, kind, title, path, added_at, updated_at) VALUES (?, 'show', 'Theme Show', ?, ?, ?)", lib.id, path.join(root, 'Theme Show'), now, now).lastInsertRowid);
  const seasonId = Number(db.run("INSERT INTO items (library_id, kind, title, path, parent_id, show_id, season, added_at, updated_at) VALUES (?, 'season', 'Season 1', ?, ?, ?, 1, ?, ?)", lib.id, path.join(root, 'Theme Show/S1'), showId, showId, now, now).lastInsertRowid);
  const ep = (n) => Number(db.run("INSERT INTO items (library_id, kind, title, path, parent_id, show_id, season, episode, added_at, updated_at) VALUES (?, 'episode', ?, ?, ?, ?, 1, ?, ?, ?)", lib.id, `Ep ${n}`, path.join(root, `Theme Show/S1/e${n}.mp4`), seasonId, showId, n, now, now).lastInsertRowid);
  const e1 = ep(1); const e2 = ep(2); ep(3);
  const profileId = (await admin.get('/api/status')).data.profile.id;
  const viewer = { profileId, kids: false, maxAge: null, userId: 1, role: 'admin' };
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 100, 100, 1, ?)', profileId, e1, now);
  const next = library.nextUpFor(library.viewerFor ? library.viewerFor(viewer) : viewer, showId);
  assert.equal(next?.id, e2);
  const viaList = library.nextUp(library.viewerFor ? library.viewerFor(viewer) : viewer, 50).find((e) => e.show_id === showId);
  assert.equal(viaList?.id, e2, 'the same answer the long way');
});

// v0.23: server problems.
function problemsSpy() {
  const seen = [];
  nf.app.core.hooks.on('server:problem', (p) => seen.push(['problem', p]));
  nf.app.core.hooks.on('server:recovered', (p) => seen.push(['recovered', p]));
  return seen;
}

test('a folder that looks empty raises one problem across two scans', { skip }, async () => {
  const seen = problemsSpy();
  for (const f of fs.readdirSync(root)) fs.renameSync(path.join(root, f), path.join(aside, f));
  for (let i = 0; i < 2; i++) {
    await admin.post('/api/scan', {});
    await waitForScan(admin);
  }
  const raised = seen.filter(([k, p]) => k === 'problem' && p.kind === 'library-folder');
  assert.equal(raised.length, 1, JSON.stringify(seen));
  assert.equal(raised[0][1].text, `The Drive folder ${root} looks empty, so its titles were kept.`);
  for (const f of fs.readdirSync(aside)) fs.renameSync(path.join(aside, f), path.join(root, f));
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  assert.ok(seen.some(([k, p]) => k === 'recovered' && p.kind === 'library-folder'), 'back: cleared');
});

test('a missing library folder raises a problem, and finding it again clears it', { skip }, async () => {
  const seen = problemsSpy();
  const moved = `${root}-gone`;
  fs.renameSync(root, moved);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  const raised = seen.find(([k, p]) => k === 'problem' && p.kind === 'library-folder');
  assert.equal(raised?.[1].text, `The Drive folder ${root} is missing.`);
  fs.renameSync(moved, root);
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  assert.ok(seen.some(([k, p]) => k === 'recovered' && p.kind === 'library-folder'));
});
