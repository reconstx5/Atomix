// Card motion (v0.28): a card resting under the remote or the mouse flips through pictures from the title itself,
// taken from its seek-bar preview sheets. The page asks for a title's sheets with one small request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';

let nf, admin;
const ids = {};
const skip = !hasFfmpeg && 'ffmpeg not installed';
const MANIFEST = { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 300, sheets: 3 };

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeVideo(path.join(media, 'Movies', 'Moving Film (2020)', 'Moving Film (2020).mp4'), { seconds: 2 });
  makeVideo(path.join(media, 'Movies', 'Still Film (2021)', 'Still Film (2021).mp4'), { seconds: 2 });
  makeVideo(path.join(media, 'TV', 'Bay Show', 'Season 01', 'Bay Show - S01E02.mp4'), { seconds: 2 });
  makeVideo(path.join(media, 'TV', 'Bay Show', 'Season 01', 'Bay Show - S01E01.mp4'), { seconds: 2 });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] });
  await waitForScan(admin);
  const db = nf.app.core.db;
  for (const r of db.all("SELECT id, title, kind, season, episode, size, mtime FROM items")) ids[r.kind === 'episode' ? `ep${r.episode}` : r.title] = r;
  const done = (item) => db.run("INSERT OR REPLACE INTO media_jobs (item_id, job, status, data, source_size, source_mtime, updated_at) VALUES (?, 'previews', 'done', ?, ?, ?, ?)", item.id, JSON.stringify(MANIFEST), item.size, item.mtime, 5);
  done(ids['Moving Film']);
  done(ids.ep1);
});
after(async () => nf?.app.stop());

test('a film with previews answers its sheets; one without answers 404', { skip }, async () => {
  const r = await admin.get(`/api/items/${ids['Moving Film'].id}/previews`);
  assert.equal(r.status, 200);
  assert.equal(r.data.count, 300);
  assert.match(r.data.url, new RegExp(`^/api/items/${ids['Moving Film'].id}/previews/\\{n\\}`));
  assert.equal((await admin.get(`/api/items/${ids['Still Film'].id}/previews`)).status, 404);
});

test('a show answers its first episode\'s sheets', { skip }, async () => {
  const r = await admin.get(`/api/items/${ids['Bay Show'].id}/previews`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, new RegExp(`^/api/items/${ids.ep1.id}/previews/`));
});
