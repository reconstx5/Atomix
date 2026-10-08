// Cast sessions end to end: Atomix drives a pretend Chromecast (two of them) and a pretend DLNA TV, given through
// ATOMIX_CAST_DEVICES, while the phone (an API client) is the remote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { fakeChromecast, fakeDlna, hasOpenssl } from './helpers-cast.js';

const skip = (!hasFfmpeg && 'ffmpeg not installed') || (!hasOpenssl && 'openssl not installed');
let nf, base, admin, sam, cc, cc2, tv, manager, stopped = false;
const ids = {};
const dev = {};

const until = async (fn, ms = 5000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const startCast = (c, body) => c.post('/api/cast/sessions', body);
const current = (c) => c.get('/api/cast/sessions/current');
const cmd = (c, id, name, body = {}) => c.post(`/api/cast/sessions/${id}/${name}`, body);
const loads = (f) => f.sent('LOAD').map((m) => m.payload);
const lastLoad = (f) => loads(f).at(-1);
const progressOf = (itemId) => nf.app.core.db.get('SELECT * FROM progress WHERE item_id = ? AND profile_id = ?', itemId, ids.profile);
const stopCast = async (c) => {
  const cur = await current(c);
  if (cur.status === 200 && cur.data.id) await cmd(c, cur.data.id, 'stop');
};

before(async () => {
  if (skip) return;
  cc = await fakeChromecast({ name: 'Living room TV' });
  cc2 = await fakeChromecast({ name: 'Den TV' });
  tv = await fakeDlna({ name: 'Samsung TV' });
  const media = tempDir();
  const film = path.join(media, 'Movies', 'Cast Film (2020)');
  makeVideo(path.join(film, 'Cast Film (2020).mp4'), { seconds: 6 });
  fs.writeFileSync(path.join(film, 'Cast Film (2020).en.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello TV\n');
  const other = path.join(media, 'Movies', 'Other Film (2021)');
  makeVideo(path.join(other, 'Other Film (2021).mkv'), { seconds: 6, acodec: 'ac3' });
  fs.writeFileSync(path.join(other, 'Other Film (2021).en.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello DLNA\n');
  makeVideo(path.join(media, 'Movies', 'Grown Film (2019)', 'Grown Film (2019).mp4'), { seconds: 3 });
  makeVideo(path.join(media, 'TV', 'Cast Show', 'Season 01', 'Cast Show - S01E01.mp4'), { seconds: 4 });
  makeVideo(path.join(media, 'TV', 'Cast Show', 'Season 01', 'Cast Show - S01E02.mp4'), { seconds: 4 });
  makeAudio(path.join(media, 'Music', 'Band', 'Record', '01 - One.mp3'), { tags: { title: 'One', artist: 'Band', album: 'Record', track: '1' } });
  makeAudio(path.join(media, 'Music', 'Band', 'Record', '02 - Two.mp3'), { tags: { title: 'Two', artist: 'Band', album: 'Record', track: '2' } });
  fs.writeFileSync(path.join(media, 'poster.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'));

  nf = await startAtomix({
    ATOMIX_CAST_DISCOVERY: 'off',
    ATOMIX_CAST_DEVICES: `chromecast:127.0.0.1:${cc.port}#Living room TV,chromecast:127.0.0.1:${cc2.port}#Den TV,dlna:${tv.location}#Samsung TV`,
  });
  base = nf.base;
  manager = nf.app.core.cast.manager;
  Object.assign(manager, { upNextDelayMs: 150, reconnectMs: 800, reconnectEveryMs: 100, saveEveryMs: 0, dlnaPollMs: 50 });
  admin = client(base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] });
  await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] });
  await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(admin);
  const db = nf.app.core.db;
  const byTitle = (t, kind) => db.get('SELECT id FROM items WHERE title = ? AND kind = ?', t, kind).id;
  ids.film = byTitle('Cast Film', 'movie');
  ids.other = byTitle('Other Film', 'movie');
  ids.grown = byTitle('Grown Film', 'movie');
  ids.e1 = db.get("SELECT id FROM items WHERE kind = 'episode' AND episode = 1").id;
  ids.e2 = db.get("SELECT id FROM items WHERE kind = 'episode' AND episode = 2").id;
  ids.t1 = byTitle('One', 'track');
  ids.t2 = byTitle('Two', 'track');
  db.run('UPDATE items SET poster = ? WHERE id = ?', 'file:' + path.join(media, 'poster.png'), ids.film);
  db.run('UPDATE items SET min_age = 16 WHERE id = ?', ids.grown);
  db.run('UPDATE items SET min_age = 0 WHERE id IN (?, ?, ?, ?)', ids.film, ids.other, ids.e1, ids.e2);
  db.run("UPDATE items SET min_age = 0 WHERE kind = 'show'");
  ids.profile = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${ids.profile}/select`, {});
  await admin.post('/api/users', { username: 'sam', password: 'sampass123', role: 'user' });
  sam = client(base);
  await sam.post('/api/auth/login', { username: 'sam', password: 'sampass123' });
  const list = (await admin.get('/api/cast/devices')).data.devices;
  for (const d of list) dev[d.name] = d.id;
});
after(async () => {
  if (nf && !stopped) await nf.app.stop();
  for (const f of [cc, cc2, tv]) await f?.close();
});

test('casting a film to the Chromecast loads the cast link at the resume point with its text tracks and artwork', { skip }, async () => {
  nf.app.core.db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 45, 7020, 0, 1)', ids.profile, ids.film);
  const res = await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const s = res.data;
  assert.equal(s.deviceName, 'Living room TV');
  assert.equal(s.kind, 'chromecast');
  assert.equal(s.itemId, ids.film);
  assert.equal(s.title, 'Cast Film');
  assert.ok(s.subtitles.some((t) => t.kind === 'text'));
  const load = lastLoad(cc);
  assert.ok(load.media.contentId.startsWith(`${base}/api/items/${ids.film}/file?cast=`), load.media.contentId);
  assert.equal(load.currentTime, 45, 'from the resume point');
  assert.equal(load.media.contentType, 'video/mp4');
  assert.equal(load.media.metadata.title, 'Cast Film');
  assert.match(load.media.metadata.images[0].url, new RegExp(`^${base}/api/items/${ids.film}/image/poster\\?.*cast=`));
  const track = load.media.tracks.find((t) => t.language === 'en');
  assert.match(track.trackContentId, /\/subtitles\/s\d+\.vtt\?cast=/);
  assert.deepEqual(load.activeTrackIds, []);
  for (const url of [load.media.contentId, load.media.metadata.images[0].url, track.trackContentId]) {
    const r = await fetch(url);
    assert.equal(r.status, 200, url);
    await r.arrayBuffer();
  }
  await stopCast(admin);
});

test('play, pause, skip +10, seek, volume reach the device; current() follows the device\'s status', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  assert.equal((await cmd(admin, s.id, 'pause')).status, 200);
  assert.equal(cc.state.media.playerState, 'PAUSED');
  await cmd(admin, s.id, 'play');
  assert.equal(cc.state.media.playerState, 'PLAYING');
  cc.tick(2);
  await until(async () => (await current(admin)).data.position === 2);
  await cmd(admin, s.id, 'skip', { by: 10 });
  assert.equal(cc.state.media.currentTime, 12);
  await cmd(admin, s.id, 'seek', { position: 3 });
  assert.equal(cc.state.media.currentTime, 3);
  await cmd(admin, s.id, 'volume', { level: 0.25 });
  assert.equal(cc.state.volume.level, 0.25);
  cc.tick(1);
  const cur = await until(async () => { const c = (await current(admin)).data; return c.position === 4 && c; });
  assert.equal(cur.state, 'playing');
  assert.equal(cur.volume, 0.25);
  assert.equal((await cmd(admin, s.id, 'seek', { position: 'x' })).status, 400);
  assert.equal((await cmd(admin, s.id, 'nonsense')).status, 404);
  await stopCast(admin);
  assert.equal(cc.state.media.playerState, 'IDLE');
  assert.equal((await current(admin)).status, 204, 'stopped by its owner: nothing to say');
});

test('a text subtitle switches tracks on the Chromecast; a picture subtitle restarts with it burned in', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const text = s.subtitles.find((t) => t.kind === 'text');
  const before = loads(cc).length;
  await cmd(admin, s.id, 'subtitle', { id: text.id });
  assert.deepEqual(cc.state.media.activeTrackIds, [lastLoad(cc).media.tracks.find((t) => t.trackContentId.includes(`/subtitles/${text.id}.vtt`)).trackId]);
  assert.equal(loads(cc).length, before, 'no reload for a text track');
  assert.equal((await current(admin)).data.subtitleId, text.id);
  await cmd(admin, s.id, 'subtitle', { id: null });
  assert.deepEqual(cc.state.media.activeTrackIds, []);
  await stopCast(admin);

  // A PGS track (Review Focus 5): the Chromecast can't draw it, so Atomix converts with it drawn on.
  const db = nf.app.core.db;
  const media = JSON.parse(db.get('SELECT media FROM items WHERE id = ?', ids.film).media);
  media.subtitles = [...(media.subtitles || []), { index: 7, codec: 'hdmv_pgs_subtitle', language: 'eng', title: null }];
  db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), ids.film);
  try {
    const p = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
    const pgs = p.subtitles.find((t) => t.kind === 'image');
    assert.equal(pgs.id, 'e7');
    cc.tick(2);
    await until(async () => (await current(admin)).data.position === 2);
    const n = loads(cc).length;
    assert.equal((await cmd(admin, p.id, 'subtitle', { id: 'e7' })).status, 200);
    assert.equal(loads(cc).length, n + 1, 'reloaded');
    const load = lastLoad(cc);
    const sid = /\/api\/stream\/([0-9a-f]+)\?cast=/.exec(load.media.contentId)?.[1];
    assert.ok(sid, load.media.contentId);
    const ps = nf.app.core.playback.sessions.get(sid);
    assert.equal(ps.burnSubtitle, 7);
    assert.equal(ps.mode, 'transcode');
    assert.equal(ps.start, 2, 'from where it was');
    assert.equal(load.currentTime, 0, 'the converted stream starts at the restart point');
    assert.equal((await current(admin)).data.subtitleId, 'e7');
    await stopCast(admin);
  } finally {
    media.subtitles = media.subtitles.filter((x) => x.index !== 7);
    db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), ids.film);
  }
});

test('on the DLNA TV a subtitle restarts the stream burned in at the current time; a seek on a converted stream restarts with the offset, revokes the old link and stops its playback session', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.other, position: 0 })).data;
  assert.equal(s.kind, 'dlna');
  const set1 = tv.called('SetAVTransportURI').at(-1).args;
  assert.match(set1.CurrentURI, new RegExp(`^${base}/api/stream/[0-9a-f]+\\?cast=`), 'MKV with AC3: converted for this TV');
  const head = await fetch(set1.CurrentURI, { method: 'HEAD' });
  assert.equal(head.headers.get('transfermode.dlna.org'), 'Streaming');
  assert.equal(head.headers.get('contentfeatures.dlna.org'), 'DLNA.ORG_OP=00;DLNA.ORG_CI=1');
  tv.tick(2);
  await until(async () => (await current(admin)).data.position === 2);

  const text = s.subtitles.find((t) => t.kind === 'text');
  await cmd(admin, s.id, 'subtitle', { id: text.id });
  const set2 = tv.called('SetAVTransportURI').at(-1).args;
  assert.notEqual(set2.CurrentURI, set1.CurrentURI);
  const sid2 = /\/api\/stream\/([0-9a-f]+)/.exec(set2.CurrentURI)[1];
  const ps2 = nf.app.core.playback.sessions.get(sid2);
  assert.ok(ps2.burnTextFile, 'the text subtitle is drawn on');
  assert.equal(ps2.start, 2);
  // The TV fetches it: ffmpeg really draws the subtitle (the filter runs) and video comes out.
  const r = await fetch(set2.CurrentURI);
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  let got = 0;
  while (got < 2000) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
  }
  await reader.cancel();
  assert.ok(got >= 2000, `video bytes came out (${got})`);

  // Review Focus 2: a converted seek is a restart; the old link dies with its playback session and its ffmpeg.
  const oldSid = sid2;
  await cmd(admin, s.id, 'seek', { position: 4 });
  const set3 = tv.called('SetAVTransportURI').at(-1).args;
  const sid3 = /\/api\/stream\/([0-9a-f]+)/.exec(set3.CurrentURI)[1];
  assert.notEqual(sid3, oldSid);
  assert.equal(nf.app.core.playback.sessions.has(oldSid), false, 'the old playback session is stopped');
  assert.equal((await fetch(set2.CurrentURI, { method: 'HEAD' })).status, 401, 'the old link is revoked');
  assert.equal(nf.app.core.playback.sessions.get(sid3).start, 4);
  tv.tick(1);
  const cur = await until(async () => { const c = (await current(admin)).data; return c.position === 5 && c; });
  assert.equal(cur.subtitleId, text.id, 'the subtitle stays on across the restart');
  await stopCast(admin);
  assert.equal(nf.app.core.playback.sessions.has(sid3), false);
});

test('progress is saved as the device plays and the episode is watched at the end; Up next starts the next episode after the delay; cancel-up-next ends instead', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.e1, position: 0 })).data;
  cc.tick(2);
  await until(() => progressOf(ids.e1)?.position === 2);
  cc.finish();
  await until(() => progressOf(ids.e1)?.watched === 1);
  const waiting = await until(async () => (await current(admin)).data.upNext);
  assert.equal(waiting.itemId, ids.e2);
  await until(() => lastLoad(cc).media.contentId.includes(`/api/items/${ids.e2}/file`));
  const cur = await until(async () => { const c = (await current(admin)).data; return c.itemId === ids.e2 && c; });
  assert.equal(cur.id, s.id, 'the same cast session carries on');
  assert.equal(cur.upNext, null);
  cc.finish();
  const done = await until(async () => { const c = await current(admin); return c.data.ended && c.data; });
  assert.equal(done.ended, 'finished');

  manager.upNextDelayMs = 2000;
  try {
    await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.e1, position: 0 });
    const n = loads(cc).length;
    cc.finish();
    const w = await until(async () => { const c = (await current(admin)).data; return c.upNext && c; });
    assert.equal((await cmd(admin, w.id, 'cancel-up-next')).status, 200);
    assert.equal((await current(admin)).data.ended, 'finished');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(loads(cc).length, n, 'nothing more was loaded');
  } finally {
    manager.upNextDelayMs = 150;
  }
});

test('a status after the end (a volume change) does not start Up next twice', { skip }, async () => {
  await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.e1, position: 0 });
  const e2Loads = () => loads(cc).filter((l) => l.media.contentId.includes(`/api/items/${ids.e2}/file`)).length;
  const before = e2Loads();
  cc.finish();
  const w = await until(async () => { const c = (await current(admin)).data; return c.upNext && c; });
  await cmd(admin, w.id, 'volume', { level: 0.4 }); // the receiver answers with a status that still says "finished"
  cc.tick(0);
  await until(() => e2Loads() > before);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(e2Loads(), before + 1, 'the next episode was loaded once');
  await stopCast(admin);
});

test('a DLNA TV stopped from its own remote mid-film ends the cast without marking it watched; stopped at the end it is finished', { skip }, async () => {
  nf.app.core.db.run('DELETE FROM progress WHERE item_id = ?', ids.film);
  await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.film, position: 0 });
  tv.tick(2);
  await until(async () => (await current(admin)).data.position === 2);
  tv.stopOnTv();
  const c = await until(async () => { const r = (await current(admin)).data; return r.ended && r; });
  assert.equal(c.ended, 'finished');
  assert.match(c.detail, /Stopped on Samsung TV/);
  const p = progressOf(ids.film);
  assert.equal(p.watched, 0);
  assert.equal(p.position, 2);
  await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.film, position: 0 });
  tv.tick(6);
  await until(async () => (await current(admin)).data.position >= 5.5);
  tv.finish();
  await until(async () => (await current(admin)).data.ended);
  assert.equal(progressOf(ids.film).watched, 1, 'at the end it is watched');
});

test('a failed restart stops the old stream too', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.other, position: 0 })).data;
  const old = [...nf.app.core.playback.sessions.values()].find((p) => p.castDevice === 'Samsung TV').id;
  tv.failLoads(2); // the restart's load and its empty-metadata retry
  const r = await cmd(admin, s.id, 'seek', { position: 3 });
  assert.equal(r.status, 502, JSON.stringify(r.data));
  assert.equal(nf.app.core.playback.sessions.has(old), false, 'the old playback session (and its ffmpeg) is gone');
  assert.equal([...nf.app.core.playback.sessions.values()].filter((p) => p.castDevice === 'Samsung TV').length, 0);
});

test('stopping while a reconnect is under way leaves no connection behind', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const connects = cc.sent('CONNECT').length;
  cc.state.statusDelay = 500; // the reconnect waits on the device's answer
  try {
    cc.drop();
    await until(() => cc.sent('CONNECT').length > connects);
    await cmd(admin, s.id, 'stop');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(cc.openSockets(), 0, 'the reconnect\'s connection was closed');
  } finally {
    cc.state.statusDelay = 0;
  }
});

test('resuming on a DLNA TV that can\'t seek restarts converted from the resume point', { skip }, async () => {
  const db = nf.app.core.db;
  db.run('DELETE FROM progress WHERE item_id = ?', ids.film);
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 45, 7020, 0, 1)', ids.profile, ids.film);
  tv.noSeek();
  try {
    const r = await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.film });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const set = tv.called('SetAVTransportURI').at(-1).args;
    assert.match(set.CurrentURI, /\/api\/stream\/([0-9a-f]+)\?cast=/, 'converted, since the TV refused to seek the file');
    const sid = /\/api\/stream\/([0-9a-f]+)/.exec(set.CurrentURI)[1];
    assert.equal(nf.app.core.playback.sessions.get(sid).start, 45);
    assert.equal([...nf.app.core.playback.sessions.values()].filter((p) => p.castDevice === 'Samsung TV').length, 1, 'the direct-file session is gone');
    assert.equal(r.data.position, 45);
    await stopCast(admin);
  } finally {
    tv.state.noSeek = false;
    db.run('DELETE FROM progress WHERE item_id = ?', ids.film);
  }
});

test("…and when converting is off, the TV keeps the file it already has from the start rather than being left with a dead link", { skip }, async () => {
  const db = nf.app.core.db;
  db.run('DELETE FROM progress WHERE item_id = ?', ids.film);
  db.run('INSERT INTO progress (profile_id, item_id, position, duration, watched, updated_at) VALUES (?, ?, 45, 7020, 0, 1)', ids.profile, ids.film);
  tv.noSeek();
  await admin.put('/api/admin/settings', { transcodingEnabled: false });
  try {
    const r = await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.film });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = (await current(admin)).data;
    assert.ok(c && c.state !== 'ended', JSON.stringify(c));
    const live = [...nf.app.core.playback.sessions.values()].filter((p) => p.castDevice === 'Samsung TV');
    assert.equal(live.length, 1, 'the direct-file stream is still the cast\'s');
    assert.equal(live[0].mode, 'direct');
    assert.equal(c.position, 0, 'playing from the start, as v0.13 did');
    await stopCast(admin);
  } finally {
    tv.state.noSeek = false;
    await admin.put('/api/admin/settings', { transcodingEnabled: true });
    db.run('DELETE FROM progress WHERE item_id = ?', ids.film);
  }
});

test('ending a cast revokes its links before the TV is told to stop', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const url = lastLoad(cc).media.contentId;
  cc.state.stopDelay = 400; // the TV takes its time answering STOP
  try {
    const stopping = cmd(admin, s.id, 'stop');
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(url, { method: 'HEAD' });
    await stopping;
    assert.equal(res.status, 401, 'the link died at once, not after the device answered');
  } finally {
    cc.state.stopDelay = 0;
  }
});

test('a subtitle downloaded after the cast started is picked by a restart on a Chromecast', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const file = nf.app.core.db.get('SELECT path FROM items WHERE id = ?', ids.film).path;
  const extra = file.replace(/\.mp4$/, '.fr.srt');
  fs.writeFileSync(extra, '1\n00:00:00,500 --> 00:00:02,000\nBonjour\n');
  try {
    nf.app.core.cast.manager.subtitlesChanged(ids.film);
    const cur = (await current(admin)).data;
    const fr = cur.subtitles.find((t) => t.language === 'fr');
    assert.ok(fr, JSON.stringify(cur.subtitles));
    const n = loads(cc).length;
    assert.equal((await cmd(admin, s.id, 'subtitle', { id: fr.id })).status, 200);
    assert.equal(loads(cc).length, n + 1, 'reloaded with the new track list');
    const load = lastLoad(cc);
    const track = load.media.tracks.find((t) => t.trackContentId.includes(`/subtitles/${fr.id}.vtt`));
    assert.ok(track);
    assert.deepEqual(load.activeTrackIds, [track.trackId]);
    assert.equal((await current(admin)).data.subtitleId, fr.id);
    await stopCast(admin);
  } finally {
    fs.rmSync(extra, { force: true });
  }
});

test('a failed subtitle restart keeps the previous choice', { skip }, async () => {
  const db = nf.app.core.db;
  const media = JSON.parse(db.get('SELECT media FROM items WHERE id = ?', ids.film).media);
  media.subtitles = [...(media.subtitles || []), { index: 7, codec: 'hdmv_pgs_subtitle', language: 'eng', title: null }];
  db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), ids.film);
  try {
    const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
    const live = nf.app.core.cast.manager.sessions.get(s.id);
    cc.failNextLoad();
    const r = await cmd(admin, s.id, 'subtitle', { id: 'e7' });
    assert.equal(r.status, 502);
    const c = (await current(admin)).data;
    assert.equal(c.ended, 'error', 'a failed restart ends the cast');
    assert.equal(live.subtitleId, null, 'the choice was not recorded before the restart succeeded');
  } finally {
    media.subtitles = media.subtitles.filter((x) => x.index !== 7);
    db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify(media), ids.film);
  }
});

test('a cast whose profile is deleted ends as lost', { skip }, async () => {
  const jo = (await admin.post('/api/profiles', { name: 'Jo2' })).data.id;
  const other = client(base);
  await other.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await other.post(`/api/profiles/${jo}/select`, {});
  const s = (await startCast(other, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const url = lastLoad(cc).media.contentId;
  const stops = cc.sent('STOP').length;
  assert.equal((await admin.del(`/api/profiles/${jo}`)).status, 200);
  cc.tick(1);
  await until(() => !nf.app.core.cast.manager.sessions.has(s.id), 3000);
  await until(() => cc.sent('STOP').length > stops, 2000);
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 401);
});

test('non-admins get no address and no network refresh; reachable is still answered', { skip }, async () => {
  const devs = nf.app.core.cast.devices;
  const was = devs.discover;
  let scans = 0;
  devs.discover = async function () { scans++; return was.call(this); };
  try {
    const r = (await sam.get('/api/cast/devices?refresh=1')).data;
    assert.equal(r.baseUrl, null);
    assert.equal(typeof r.reachable, 'boolean');
    assert.equal(r.devices.length, 3);
    assert.equal(scans, 0, 'a viewer cannot start a scan');
    await admin.get('/api/cast/devices?refresh=1');
    assert.equal(scans, 1, 'an admin can');
    assert.notEqual((await admin.get('/api/cast/devices')).data.baseUrl, undefined);
  } finally {
    devs.discover = was;
  }
});

test('current reads the subtitle list from the session; a download refreshes it', { skip }, async () => {
  const m = nf.app.core.cast.manager;
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const n = m.subtitleReads;
  await current(admin);
  await current(admin);
  assert.equal(m.subtitleReads, n, 'polling does not re-read the folder');
  const file = nf.app.core.db.get('SELECT path FROM items WHERE id = ?', ids.film).path;
  const extra = file.replace(/\.mp4$/, '.de.srt');
  fs.writeFileSync(extra, '1\n00:00:00,500 --> 00:00:02,000\nHallo\n');
  try {
    m.subtitlesChanged(ids.film);
    const c = (await current(admin)).data;
    assert.ok(c.subtitles.some((t) => t.language === 'de'));
    assert.equal(m.subtitleReads, n + 1);
    await stopCast(admin);
  } finally {
    fs.rmSync(extra, { force: true });
  }
  assert.equal(s.id.length, 24);
});

test('a start that fails before its stream exists leaves no .vtt behind; cast-subs is emptied at startup', { skip }, async () => {
  const dir = path.join(nf.app.core.config.transcodeDir, 'cast-subs');
  await admin.put('/api/admin/settings', { transcodingEnabled: false });
  try {
    const sub = (await admin.get(`/api/items/${ids.other}/subtitles`)).data.find((t) => t.kind === 'text');
    const r = await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.other, position: 0, subtitle: sub.id });
    assert.equal(r.status, 422, JSON.stringify(r.data));
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'nothing left behind');
  } finally {
    await admin.put('/api/admin/settings', { transcodingEnabled: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stray.vtt'), 'WEBVTT\n');
  const { CastManager } = await import('../src/cast/sessions.js');
  const fresh = new CastManager(nf.app.core);
  await fresh.stopAll();
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('without libass a text subtitle on a DLNA TV is refused with the libass message', { skip }, async () => {
  const tools = nf.app.core.tools;
  const had = tools.filters.subtitles;
  tools.filters.subtitles = false;
  try {
    const s = (await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.other, position: 0 })).data;
    const text = s.subtitles.find((t) => t.kind === 'text');
    const sets = tv.called('SetAVTransportURI').length;
    const r = await cmd(admin, s.id, 'subtitle', { id: text.id });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "This ffmpeg can't draw subtitles onto video (it needs libass)");
    assert.equal(tv.called('SetAVTransportURI').length, sets, 'nothing restarted');
    await stopCast(admin);
    const r2 = (await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.other, position: 0, subtitle: text.id })).data;
    assert.equal(r2.subtitleId, null, 'a start loads without it');
    await stopCast(admin);
  } finally {
    tools.filters.subtitles = had;
  }
});

test('a music queue plays track after track on the device', { skip }, async () => {
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], queue: { itemIds: [ids.t1, ids.t2], index: 0 } })).data;
  assert.equal(s.itemId, ids.t1);
  assert.deepEqual(s.queue.items.map((i) => i.id), [ids.t1, ids.t2]);
  const l1 = lastLoad(cc);
  assert.equal(l1.media.metadata.metadataType, 3);
  assert.equal(l1.media.metadata.title, 'One');
  assert.equal(l1.media.metadata.artist, 'Band');
  assert.match(l1.media.contentType, /^audio\//);
  cc.finish();
  await until(() => lastLoad(cc).media.metadata.title === 'Two');
  assert.equal((await current(admin)).data.queue.index, 1);
  cc.finish();
  assert.equal((await until(async () => (await current(admin)).data.ended)), 'finished');
});

test('another app taking over ends the session as taken, with progress saved; a dropped device reconnects, then ends as lost after reconnectMs', { skip }, async () => {
  nf.app.core.db.run('DELETE FROM progress WHERE item_id = ?', ids.film);
  await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 });
  cc.tick(3);
  await until(async () => (await current(admin)).data.position === 3);
  cc.takeOver();
  const ended = await until(async () => { const c = (await current(admin)).data; return c.ended && c; });
  assert.deepEqual([ended.ended, ended.deviceName], ['taken', 'Living room TV']);
  assert.equal(progressOf(ids.film).position, 3);

  await startCast(admin, { deviceId: dev['Den TV'], itemId: ids.film, position: 0 });
  const connects = cc2.sent('CONNECT').length;
  cc2.drop();
  await until(() => cc2.sent('CONNECT').length > connects);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok((await current(admin)).data.id, 'reconnected: still casting');
  await cc2.close();
  const lost = await until(async () => { const c = (await current(admin)).data; return c.ended && c; }, 4000);
  assert.equal(lost.ended, 'lost');
  assert.equal(lost.deviceName, 'Den TV');
});

test('LOAD_FAILED ends the session with "<device> couldn\'t load the video from <base>…"', { skip }, async () => {
  cc.failNextLoad();
  const res = await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 });
  assert.equal(res.status, 502);
  assert.match(res.data.error, new RegExp(`^Living room TV couldn't load the video from ${base.replace(/\./g, '\\.')}\\. Check the address in Settings → Server → Casting\\.$`));
  const c = (await current(admin)).data;
  assert.equal(c.ended, 'error');
  assert.match(c.detail, /couldn't load the video/);
  assert.equal([...nf.app.core.playback.sessions.values()].filter((p) => p.castDevice).length, 0, 'its playback session is gone');
});

test('one session per device: a second start there ends the first as taken', { skip }, async () => {
  await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 });
  const samStart = await startCast(sam, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 });
  assert.equal(samStart.status, 200);
  const c = (await current(admin)).data;
  assert.deepEqual([c.ended, c.deviceName], ['taken', 'Living room TV']);
  assert.equal((await current(sam)).data.id, samStart.data.id);
  const devices = (await admin.get('/api/cast/devices')).data.devices;
  assert.equal(devices.find((d) => d.name === 'Living room TV').busy, true);
  assert.equal(devices.find((d) => d.name === 'Samsung TV').busy, false);
  await stopCast(sam);
});

test('only the profile that started a session sees it and can command it; another profile on the same account gets 204 from current and 404 on commands; polling current twice changes nothing', { skip }, async () => {
  const jo = (await admin.post('/api/profiles', { name: 'Jo' })).data.id;
  const other = client(base);
  await other.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await other.post(`/api/profiles/${jo}/select`, {});
  const s = (await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  assert.equal((await current(other)).status, 204);
  assert.equal((await cmd(other, s.id, 'pause')).status, 404);
  assert.equal((await current(sam)).status, 204);
  assert.equal(cc.state.media.playerState, 'PLAYING');
  const n = cc.messages.length;
  const a = (await current(admin)).data;
  const b = (await current(admin)).data;
  assert.deepEqual(a, b);
  assert.equal(cc.messages.filter((m, i) => i >= n && m.namespace !== 'urn:x-cast:com.google.cast.tp.heartbeat').length, 0, 'no commands from polling');
  await stopCast(admin);
});

test('a kids profile can\'t cast an R16 film (404, as playing does)', { skip }, async () => {
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10 })).data.id;
  const kid = client(base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia}/select`, {});
  assert.equal((await kid.post(`/api/items/${ids.grown}/playback`, {})).status, 404);
  assert.equal((await startCast(kid, { deviceId: dev['Living room TV'], itemId: ids.grown })).status, 404);
  assert.equal((await startCast(kid, { deviceId: dev['Living room TV'], queue: { itemIds: [ids.film, ids.grown], index: 0 } })).status, 404, 'not hidden in a queue either');
  const ok = await startCast(kid, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 });
  assert.equal(ok.status, 200, 'everyone can cast');
  await stopCast(kid);
});

test('GET /api/cast/devices reports enabled, baseUrl, reachable, and busy for the device in use; castEnabled false answers enabled: false and refuses a start', { skip }, async () => {
  let d = (await admin.get('/api/cast/devices')).data;
  assert.equal(d.enabled, true);
  assert.equal(typeof d.reachable, 'boolean');
  assert.deepEqual(d.devices.map((x) => x.name).sort(), ['Den TV', 'Living room TV', 'Samsung TV']);
  assert.deepEqual(Object.keys(d.devices[0]).sort(), ['busy', 'id', 'kind', 'manual', 'model', 'name']);
  assert.equal((await admin.put('/api/admin/settings', { castBaseUrl: 'ftp://x' })).status, 400);
  await admin.put('/api/admin/settings', { castBaseUrl: 'http://192.168.1.20:8787/' });
  d = (await admin.get('/api/cast/devices')).data;
  assert.deepEqual([d.baseUrl, d.reachable], ['http://192.168.1.20:8787', true]);
  await admin.put('/api/admin/settings', { castBaseUrl: '' });
  assert.equal((await admin.get('/api/admin/settings')).data.castBaseUrl, null);
  await admin.put('/api/admin/settings', { castEnabled: false });
  try {
    d = (await admin.get('/api/cast/devices')).data;
    assert.deepEqual([d.enabled, d.devices.length], [false, 0]);
    const r = await startCast(admin, { deviceId: dev['Living room TV'], itemId: ids.film });
    assert.equal(r.status, 403);
  } finally {
    await admin.put('/api/admin/settings', { castEnabled: true });
  }
  assert.equal((await sam.post('/api/cast/devices', { kind: 'dlna', address: tv.location })).status, 403, 'adding devices is for admins');
});

test('admins see cast sessions in the dashboard and can stop them; an Atomix shutdown stops every cast', { skip }, async () => {
  const s = (await startCast(sam, { deviceId: dev['Living room TV'], itemId: ids.film, position: 0 })).data;
  const sessions = (await admin.get('/api/admin/dashboard')).data.sessions;
  const row = sessions.find((x) => x.castDevice === 'Living room TV');
  assert.ok(row, JSON.stringify(sessions));
  assert.equal(row.clientIp, 'cast');
  const stops = cc.sent('STOP').length;
  assert.equal((await admin.post(`/api/admin/sessions/${row.id}/stop`, {})).status, 200);
  await until(() => cc.sent('STOP').length > stops);
  const c = (await current(sam)).data;
  assert.equal(c.ended, 'stopped');
  assert.equal(s.deviceName, 'Living room TV');

  await startCast(admin, { deviceId: dev['Samsung TV'], itemId: ids.film, position: 0 });
  const tvStops = tv.called('Stop').length;
  await nf.app.stop();
  stopped = true;
  assert.ok(tv.called('Stop').length > tvStops, 'the TV was told to stop before Atomix closed');
});
