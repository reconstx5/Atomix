// Casting Live TV: a channel or a catch-up programme started on a pretend Chromecast / DLNA TV through the cast
// manager. The TV gets Atomix's own cast link (never the provider's address); channel up/down zap on the TV; a live
// channel can't be seeked; Kids without ticked groups can't cast a channel; nothing is written to progress.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, fakeServer } from './helpers.js';
import { fakeChromecast, fakeDlna, hasOpenssl } from './helpers-cast.js';

const skip = (!hasFfmpeg && 'ffmpeg not installed') || (!hasOpenssl && 'openssl not installed');
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
let nf, admin, kid, upstream, cc, tv, ids, dev = {};

const until = async (fn, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const current = (c) => c.get('/api/cast/sessions/current');
const cmd = (c, id, name, body = {}) => c.post(`/api/cast/sessions/${id}/${name}`, body);
const lastLoad = (f) => f.sent('LOAD').at(-1)?.payload;
const stopCast = async (c) => {
  const cur = await current(c);
  if (cur.status === 200 && cur.data?.id) await cmd(c, cur.data.id, 'stop');
};

before(async () => {
  if (skip) return;
  const dir = tempDir();
  const ts = path.join(dir, 'live.ts');
  makeVideo(ts, { seconds: 4 });
  upstream = await fakeServer((req, res) => {
    if (req.url.startsWith('/live/') || req.url.startsWith('/timeshift/')) {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return fs.createReadStream(ts).pipe(res);
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = upstream.url;
  cc = await fakeChromecast({ name: 'Living room TV' });
  tv = await fakeDlna({ name: 'Samsung TV' });
  nf = await startAtomix(
    { ATOMIX_PLUGINS_DIR: PLUGINS, ATOMIX_CAST_DISCOVERY: 'off', ATOMIX_CAST_DEVICES: `chromecast:127.0.0.1:${cc.port}#Living room TV,dlna:${tv.location}#Samsung TV` },
    { skipLiveRefresh: true },
  );
  Object.assign(nf.app.core.cast.manager, { saveEveryMs: 0, dlnaPollMs: 50 });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const profile = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${profile}/select`, {});
  const kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
  for (const d of (await admin.get('/api/cast/devices')).data.devices) dev[d.name] = d.id;
});
after(async () => {
  await nf?.app.stop();
  for (const f of [cc, tv]) await f?.close();
  await upstream?.close();
});

test('casting a channel loads Atomix\'s cast link as a LIVE stream; the Remote sees the channel and programme', { skip }, async () => {
  const r = await admin.post('/api/cast/sessions', { deviceId: dev['Living room TV'], liveChannelId: ids.One });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const load = lastLoad(cc);
  assert.match(load.media.contentId, /\/api\/(stream|hls)\/[^?]+\?cast=/);
  assert.equal(load.media.streamType, 'LIVE');
  assert.equal(load.media.duration, undefined);
  assert.ok(!JSON.stringify(cc.messages).includes('secretpw'), 'no provider address reaches the TV');
  assert.ok(!JSON.stringify(cc.messages).includes('hdrsecret'));
  assert.equal(r.data.live.kind, 'live');
  assert.equal(r.data.live.channel.name, 'One');
  assert.equal(r.data.live.channel.number, 1);
  assert.ok(r.data.live.programme.title.startsWith('One '));
  assert.ok(r.data.live.next.title.startsWith('One '));
  assert.equal(r.data.title, 'One');
  const ps = nf.app.core.playback.sessions.get(nf.app.core.cast.manager.sessions.get(r.data.id).playbackSessionId);
  assert.equal(ps.live.channelId, ids.One);
  assert.equal(ps.castDevice, 'Living room TV');
  await stopCast(admin);
});

test('channelUp zaps the TV to the next channel and stops the old stream; channelDown comes back', { skip }, async () => {
  const r = await admin.post('/api/cast/sessions', { deviceId: dev['Living room TV'], liveChannelId: ids.One });
  const manager = nf.app.core.cast.manager;
  const first = manager.sessions.get(r.data.id).playbackSessionId;
  const loadsBefore = cc.sent('LOAD').length;
  const up = await cmd(admin, r.data.id, 'channelUp');
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.live.channel.name, 'Two');
  assert.equal(cc.sent('LOAD').length, loadsBefore + 1);
  const second = manager.sessions.get(r.data.id).playbackSessionId;
  assert.notEqual(second, first);
  await until(() => !nf.app.core.playback.sessions.has(first));
  assert.equal(nf.app.core.playback.sessions.get(second).live.channelId, ids.Two);
  const down = await cmd(admin, r.data.id, 'channelDown');
  assert.equal(down.data.live.channel.name, 'One');
  // Radio isn't in the TV's channel order: Down from One wraps to Three, whose stream is dead — the TV stays on One.
  const playing = manager.sessions.get(r.data.id).playbackSessionId;
  const wrap = await cmd(admin, r.data.id, 'channelDown');
  assert.equal(wrap.status, 502);
  assert.equal(wrap.data.error, "This channel isn't answering right now (the provider closed the connection)");
  const still = (await current(admin)).data;
  assert.equal(still.live.channel.name, 'One');
  assert.ok(nf.app.core.playback.sessions.has(playing), 'the channel on the TV keeps playing');
  await stopCast(admin);
});

test('on a 1-stream provider the TV still zaps (its old channel goes first) and the cast carries on', { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const r = await admin.post('/api/cast/sessions', { deviceId: dev['Living room TV'], liveChannelId: ids.One });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const up = await cmd(admin, r.data.id, 'channelUp');
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.live.channel.name, 'Two');
    const cur = (await current(admin)).data;
    assert.equal(cur.id, r.data.id, 'the same cast, not ended');
    assert.equal(nf.app.core.live.streams.openOn(KEY).length, 1);
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopCast(admin);
  }
});

test('quick channel presses on the Remote run one after another: no 409 on a 1-stream provider, no stream left behind', { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const r = await admin.post('/api/cast/sessions', { deviceId: dev['Living room TV'], liveChannelId: ids.One });
    const [up, down] = await Promise.all([cmd(admin, r.data.id, 'channelUp'), cmd(admin, r.data.id, 'channelDown')]);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(down.status, 200, JSON.stringify(down.data));
    assert.equal((await current(admin)).data.live.channel.name, 'One');
    const live = [...nf.app.core.playback.sessions.values()].filter((x) => x.live);
    assert.equal(live.length, 1, live.map((x) => x.live.channelName).join(','));
    assert.equal(live[0].id, nf.app.core.cast.manager.sessions.get(r.data.id).playbackSessionId);
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopCast(admin);
  }
});

test('a live channel can\'t be seeked or skipped', { skip }, async () => {
  const r = await admin.post('/api/cast/sessions', { deviceId: dev['Living room TV'], liveChannelId: ids.One });
  const seek = await cmd(admin, r.data.id, 'seek', { position: 30 });
  assert.equal(seek.status, 400);
  assert.equal(seek.data.error, "You can't seek a live channel");
  assert.equal((await cmd(admin, r.data.id, 'skip', { by: 30 })).status, 400);
  await stopCast(admin);
});

test('a Kids profile with no ticked groups can\'t cast a channel (404)', { skip }, async () => {
  const loads = cc.sent('LOAD').length;
  const r = await kid.post('/api/cast/sessions', { deviceId: dev['Living room TV'], liveChannelId: ids.One });
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'This channel no longer exists.');
  assert.equal(cc.sent('LOAD').length, loads, 'nothing was loaded on the TV');
  assert.equal((await kid.get('/api/cast/sessions/current')).data?.id, undefined);
});

test('catch-up casts with its length and seeks by restarting from the new point; nothing goes to progress', { skip }, async () => {
  const before = nf.app.core.db.get('SELECT COUNT(*) AS n FROM progress').n;
  const g = (await admin.get(`/api/live/guide?from=${Date.now() - 3 * 3600_000}&to=${Date.now()}&channels=${ids.One}`)).data;
  const aired = g.programmes[ids.One].find((p) => p.end < Date.now() - 30 * 60_000);
  const r = await admin.post('/api/cast/sessions', { deviceId: dev['Living room TV'], catchupProgrammeId: aired.id, position: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.live.kind, 'catchup');
  assert.equal(r.data.title, aired.title);
  assert.equal(r.data.duration, (aired.end - aired.start) / 1000);
  assert.equal(lastLoad(cc).media.streamType, 'BUFFERED');
  assert.ok(!JSON.stringify(cc.messages).includes('secretpw'));
  const seek = await cmd(admin, r.data.id, 'seek', { position: 600 });
  assert.equal(seek.status, 200, JSON.stringify(seek.data));
  const ps = nf.app.core.playback.sessions.get(nf.app.core.cast.manager.sessions.get(r.data.id).playbackSessionId);
  assert.equal(ps.live.offset, 600);
  assert.equal(seek.data.position, 600);
  cc.tick(5);
  await new Promise((res) => setTimeout(res, 150));
  await stopCast(admin);
  assert.equal(nf.app.core.db.get('SELECT COUNT(*) AS n FROM progress').n, before, 'no progress rows');
});

test('a DLNA TV gets a live channel with no duration', { skip }, async () => {
  const r = await admin.post('/api/cast/sessions', { deviceId: dev['Samsung TV'], liveChannelId: ids.Two });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const set = tv.called('SetAVTransportURI').at(-1);
  assert.match(set.args.CurrentURI, /\?cast=/);
  assert.ok(!/duration=/.test(set.args.CurrentURIMetaData || ''), set.args.CurrentURIMetaData);
  assert.ok(!set.args.CurrentURI.includes('secretpw'));
  await stopCast(admin);
});

test('Stop on a DLNA TV\'s own remote during a live cast says "Stopped on Samsung TV."', { skip }, async () => {
  const r = await admin.post('/api/cast/sessions', { deviceId: dev['Samsung TV'], liveChannelId: ids.Two });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  tv.state.duration = 0; // a TV reports no length for a live stream
  tv.tick(2);
  await until(async () => (await admin.get('/api/cast/sessions/current')).data?.state === 'playing');
  tv.stopOnTv();
  const seen = [];
  const c = await until(async () => { const x = (await admin.get('/api/cast/sessions/current')); seen.push([x.status, x.data?.state, x.data?.ended, x.data?.detail]); return x.data?.ended && x.data; }).catch(() => null);
  assert.equal(c?.detail, 'Stopped on Samsung TV.', JSON.stringify(seen.slice(-3)));
});
