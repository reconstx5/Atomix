// Orbit's menu (v0.24): the Live TV recordings library is marked on /api/libraries, so it gets its own icon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startAtomix, client, tempDir } from './helpers.js';

let nf, admin, recId, tvId;

before(async () => {
  nf = await startAtomix({}, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  const dir = nf.app.core.live.scheduler.dir();
  fs.mkdirSync(dir, { recursive: true });
  recId = (await admin.post('/api/libraries', { name: 'Recordings', type: 'tv', paths: [dir] })).data.id;
  tvId = (await admin.post('/api/libraries', { name: 'TV Shows', type: 'tv', paths: [tempDir()] })).data.id;
});
after(async () => {
  await nf?.app.stop();
});

test('the Live TV recordings library is marked, other TV libraries are not', async () => {
  const libs = (await admin.get('/api/libraries')).data;
  assert.equal(libs.find((l) => l.id === recId).recordings, true);
  assert.equal(libs.find((l) => l.id === tvId).recordings, false);
});
