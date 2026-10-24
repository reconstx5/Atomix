// Encrypted Live TV channels (src/live/drm.js): pressing play opens an encrypted session (the browser plays it with
// its own key system) instead of an ffmpeg one — with the same stream limits, Kids rules, ping/stop/reap and the
// Dashboard listing; provider addresses, headers and keys never reach the reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, fakeServer } from './helpers.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const MPD = fs.readFileSync(new URL('./fixtures/dash/live-number.mpd', import.meta.url), 'utf8');
let nf, admin, other, kid, kidId, upstream, ids, myProfile;

before(async () => {
  upstream = await fakeServer((req, res) => {
    if (req.url.startsWith('/dash/five/') || req.url.startsWith('/dash/six/')) {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(MPD);
    }
    if (req.url === '/dash/broken.mpd') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>Sign in</body></html>');
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = upstream.url;
  process.env.LIVE_TEST_DRM = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  myProfile = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${myProfile}/select`, {});
  kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  other = client(nf.base);
  await other.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_DRM;
  await nf?.app.stop();
  await upstream?.close();
});

const drm = () => nf.app.core.live.drm;
const play = (c, id, body = {}) => c.post(`/api/live/channels/${id}/play`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] }, ...body });
const stopAll = () => {
  for (const id of [...drm().sessions.keys()]) drm().stop(id, 'test');
  for (const id of [...nf.app.core.playback.sessions.keys()]) nf.app.core.playback.stop(id, 'test');
};

test('channels say they are encrypted', async () => {
  const list = (await admin.get('/api/live/channels')).data;
  assert.equal(list.find((c) => c.name === 'Five').drm, 'clearkey');
  assert.equal(list.find((c) => c.name === 'Six').drm, 'widevine');
  assert.equal(list.find((c) => c.name === 'One').drm, null);
});

test('play on an encrypted channel opens an encrypted session with Atomix addresses only', async () => {
  const r = await play(admin, ids.Five);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.delivery, 'drm');
  assert.equal(r.data.keySystem, 'org.w3.clearkey');
  assert.equal(r.data.manifest, `/api/live/drm/${r.data.sessionId}/manifest.mpd`);
  assert.equal(r.data.licence, `/api/live/drm/${r.data.sessionId}/licence`);
  assert.equal(r.data.live, true);
  assert.equal(r.data.channel.name, 'Five');
  assert.ok(r.data.programme?.title?.startsWith('Five '));
  const text = JSON.stringify(r.data);
  for (const secret of [upstream.url.replace('http://', ''), 'hdrsecret', 'mansecret', '76a6c65c5ea762046bd749a2e632ccbb']) assert.ok(!text.includes(secret), secret);
  const six = await play(admin, ids.Six, { replaces: r.data.sessionId });
  assert.equal(six.data.keySystem, 'com.widevine.alpha');
  assert.ok(!JSON.stringify(six.data).includes('secretlic'));
  assert.equal(drm().sessions.has(r.data.sessionId), false, 'replaces stops the old encrypted session');
  stopAll();
});

test('the Dashboard lists encrypted sessions; an admin can stop one', async () => {
  const r = await play(admin, ids.Five);
  const d = (await admin.get('/api/admin/dashboard')).data;
  const row = d.sessions.find((s) => s.id === r.data.sessionId);
  assert.ok(row, JSON.stringify(d.sessions));
  assert.equal(row.mode, 'encrypted');
  assert.equal(row.itemId, `live:${ids.Five}`);
  assert.equal(row.title, 'Five');
  assert.equal((await admin.post(`/api/admin/sessions/${r.data.sessionId}/stop`, {})).status, 200);
  assert.equal(drm().sessions.has(r.data.sessionId), false);
});

test('the source\'s stream limit counts encrypted sessions: another profile is refused, the same profile replaces', async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const mine = await play(admin, ids.Five);
    assert.equal(mine.status, 200);
    const theirs = await play(other, ids.Six);
    assert.equal(theirs.status, 409);
    assert.match(theirs.data.error, /Your provider allows 1 stream at a time/);
    const again = await play(admin, ids.Six);
    assert.equal(again.status, 200, 'the same profile\'s newest press wins');
    assert.equal(drm().sessions.has(mine.data.sessionId), false);
    assert.equal(nf.app.core.live.streams.openOn(KEY).length, 1);
  } finally {
    delete process.env.LIVE_TEST_MAX;
    stopAll();
  }
});

test('the account\'s cap of 4 open streams counts encrypted sessions', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await play(admin, ids.Five)).status, 200);
  const user = nf.app.core.db.get("SELECT id FROM users WHERE username = 'dallas'");
  assert.equal(nf.app.core.playback.sessionsOf(user.id).length, 4, 'playback\'s own count sees them');
  const fifth = await play(admin, ids.Six);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.data.error, 'Too many streams open on this account.');
  stopAll();
});

test('ping keeps a session; 2 minutes without one ends it; ping/stop of someone else\'s is 404', async () => {
  const r = await play(admin, ids.Five);
  const sid = r.data.sessionId;
  assert.deepEqual((await admin.post(`/api/live/drm/${sid}/ping`, {})).data, { ok: true });
  assert.equal((await other.post(`/api/live/drm/${sid}/ping`, {})).status, 404);
  assert.equal((await kid.post(`/api/live/drm/${sid}/ping`, {})).status, 404, 'another profile of the same account');
  assert.equal((await other.post(`/api/live/drm/${sid}/stop`, {})).status, 404);
  drm().reap(Date.now() + 60_000);
  assert.ok(drm().sessions.has(sid), 'a minute is fine');
  drm().reap(Date.now() + 121_000);
  assert.equal(drm().sessions.has(sid), false);
  assert.deepEqual((await admin.post(`/api/live/drm/${sid}/ping`, {})).data, { ok: false, error: 'This channel stopped.' });
  const s2 = (await play(admin, ids.Five)).data.sessionId;
  assert.equal((await admin.post(`/api/live/drm/${s2}/stop`, {})).status, 200);
  assert.equal(drm().sessions.has(s2), false);
});

test('a Kids profile without ticked groups gets 404; a manifest that isn\'t one is "couldn\'t be read"', async () => {
  const k = await play(kid, ids.Five);
  assert.equal(k.status, 404);
  const b = await play(admin, ids.Broken);
  assert.equal(b.status, 502);
  assert.equal(b.data.error, "This channel's stream couldn't be read");
  assert.equal(drm().sessions.size, 0, 'nothing left open');
  assert.equal(nf.app.core.live.streams.reserved.size, 0, 'the reservation was released');
});

// v0.27: a live encrypted channel can be cast to a Chromecast (test/cast-drm.test.js); its archive still can't.
test('encrypted channels can\'t be cast from the archive, played from the archive, or played as radio', async () => {
  const g = (await admin.get(`/api/live/guide?from=${Date.now() - 3 * 3600_000}&to=${Date.now()}&channels=${ids.Five}`)).data;
  const aired = g.programmes[ids.Five].find((p) => p.end < Date.now());
  const cast = await admin.post('/api/cast/sessions', { deviceId: 'nope', catchupProgrammeId: aired.id });
  assert.equal(cast.status, 400);
  assert.equal(cast.data.error, 'This channel is encrypted, so it can\'t be cast');
  const detail = (await admin.get(`/api/live/programmes/${aired.id}`)).data;
  assert.equal(detail.canCatchup, false);
  assert.equal(detail.canStartOver, false);
  assert.equal((await admin.post(`/api/live/programmes/${aired.id}/play`, {})).status, 400);
  const radio = await play(admin, ids.Five, { audioOnly: true });
  assert.equal(radio.status, 400);
  assert.equal(radio.data.error, "Encrypted channels can't be played as radio");
});
