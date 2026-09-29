// The settings behind the background jobs: per-library opt-out, the two server
// switches, and each profile's "skip intros automatically".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, startNodeFlix, client } from './helpers.js';

let nf;
let admin;
before(async () => {
  nf = await startNodeFlix({}, { backgroundTasks: false });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
});
after(async () => {
  await nf?.app.stop();
});

test('libraries can opt out of seek-bar previews', async () => {
  let r = await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [tempDir()] });
  assert.deepEqual(r.data.options, { previews: true }, 'on unless switched off');
  r = await admin.post('/api/libraries', { name: 'Home videos', type: 'movies', paths: [tempDir()], options: { previews: false, evil: 1 } });
  assert.deepEqual(r.data.options, { previews: false }, 'unknown options are dropped');
  const id = r.data.id;
  r = await admin.put(`/api/libraries/${id}`, { options: { previews: true } });
  assert.deepEqual(r.data.options, { previews: true });
  r = await admin.put(`/api/libraries/${id}`, { name: 'Renamed' });
  assert.deepEqual(r.data.options, { previews: true }, 'kept when not sent');
  assert.deepEqual((await admin.get('/api/libraries')).data.find((l) => l.id === id).options, { previews: true });
});

test('the two background jobs can be switched off', async () => {
  let s = (await admin.get('/api/admin/settings')).data;
  assert.deepEqual([s.previewsEnabled, s.introDetection], [true, true]);
  await admin.put('/api/admin/settings', { previewsEnabled: false, introDetection: false });
  s = (await admin.get('/api/admin/settings')).data;
  assert.deepEqual([s.previewsEnabled, s.introDetection], [false, false]);
  const paused = (await admin.get('/api/admin/tasks')).data.paused;
  assert.ok(['disabled', 'no-ffmpeg'].includes(paused), paused);
});

test('each profile can choose to skip intros automatically', async () => {
  let r = await admin.patch('/api/me', { prefs: { skipIntros: true } });
  assert.equal(r.data.profile.prefs.skipIntros, true);
  r = await admin.patch('/api/me', { prefs: { skipIntros: false } });
  assert.equal(r.data.profile.prefs.skipIntros, false);
});
