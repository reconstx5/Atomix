// The Cast v2 channel and the Chromecast driver against a pretend Chromecast speaking the real framing over TLS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCastMessage, decodeCastMessage, FrameReader } from '../src/cast/protobuf.js';
import { ChromecastDevice } from '../src/cast/chromecast.js';
import { fakeChromecast, hasOpenssl } from './helpers-cast.js';

const skip = !hasOpenssl && 'openssl not installed';
let cc;
before(async () => { if (hasOpenssl) cc = await fakeChromecast(); });
after(async () => cc?.close());
const until = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); };

test('CastMessage round-trips, including a 300-byte payload', () => {
  const payload = JSON.stringify({ type: 'LOAD', blob: 'x'.repeat(300) });
  const buf = encodeCastMessage({ sourceId: 'sender-0', destinationId: 'receiver-0', namespace: 'urn:x-cast:com.google.cast.media', payload });
  assert.equal(buf.readUInt32BE(0), buf.length - 4, 'a 4-byte big-endian length first');
  assert.deepEqual(decodeCastMessage(buf.subarray(4)), { sourceId: 'sender-0', destinationId: 'receiver-0', namespace: 'urn:x-cast:com.google.cast.media', payload });
});

test('FrameReader joins a message split in three chunks and splits two messages in one chunk', () => {
  const a = encodeCastMessage({ sourceId: 's', destinationId: 'd', namespace: 'n', payload: '{"a":1}' });
  const b = encodeCastMessage({ sourceId: 's', destinationId: 'd', namespace: 'n', payload: '{"b":2}' });
  const r = new FrameReader();
  assert.deepEqual(r.push(a.subarray(0, 2)), []);
  assert.deepEqual(r.push(a.subarray(2, 9)), []);
  assert.deepEqual(r.push(a.subarray(9)).map((m) => m.payload), ['{"a":1}']);
  assert.deepEqual(r.push(Buffer.concat([a, b])).map((m) => m.payload), ['{"a":1}', '{"b":2}']);
});

test('connect, launch CC1AD845, load with startTime, tracks and metadata; the fake recorded them', { skip }, async () => {
  const d = new ChromecastDevice({ host: cc.host, port: cc.port, name: 'Living room TV' });
  await d.connect();
  await d.launch();
  assert.equal(cc.sent('LAUNCH')[0].payload.appId, 'CC1AD845');
  await d.load({ url: 'http://192.168.1.20:8787/api/items/1/file?cast=T', contentType: 'video/mp4', title: 'Alien', subtitle: '1979', image: 'http://192.168.1.20:8787/api/items/1/image/poster?cast=T', startTime: 100, duration: 7020, kind: 'movie', tracks: [{ trackId: 1, url: 'http://x/sub.vtt?cast=T', language: 'en', name: 'English' }], activeTrackIds: [1] });
  const load = cc.sent('LOAD')[0];
  assert.equal(load.destinationId, 'web-5', 'sent to the receiver app, not receiver-0');
  assert.equal(load.payload.currentTime, 100);
  assert.equal(load.payload.media.contentId, 'http://192.168.1.20:8787/api/items/1/file?cast=T');
  assert.equal(load.payload.media.streamType, 'BUFFERED');
  assert.equal(load.payload.media.metadata.metadataType, 0);
  assert.equal(load.payload.media.metadata.title, 'Alien');
  assert.equal(load.payload.media.metadata.images[0].url, 'http://192.168.1.20:8787/api/items/1/image/poster?cast=T');
  assert.deepEqual(load.payload.media.tracks[0], { trackId: 1, type: 'TEXT', subtype: 'SUBTITLES', trackContentId: 'http://x/sub.vtt?cast=T', trackContentType: 'text/vtt', language: 'en', name: 'English' });
  assert.deepEqual(load.payload.activeTrackIds, [1]);
  assert.equal(d.status().state, 'playing');
  d.close();
});

test('play/pause/seek/stop/volume/EDIT_TRACKS_INFO reach the fake; status events follow the fake\'s clock', { skip }, async () => {
  const d = new ChromecastDevice({ host: cc.host, port: cc.port });
  const seen = [];
  d.on('status', (s) => seen.push(s));
  await d.connect();
  await d.launch();
  assert.equal(cc.sent('LAUNCH').length, 1, 'the receiver was already running: no second launch');
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', startTime: 0, kind: 'movie' });
  await d.pause();
  assert.equal(d.status().state, 'paused');
  await d.play();
  await d.seek(42);
  assert.equal(cc.state.media.currentTime, 42);
  await d.setVolume(0.3);
  assert.equal(cc.state.volume.level, 0.3);
  await d.setTracks([2]);
  assert.deepEqual(cc.state.media.activeTrackIds, [2]);
  cc.tick(5);
  await until(() => d.status().position === 47);
  assert.equal(d.status().volume, 0.3);
  await d.stop();
  assert.equal(cc.state.media.playerState, 'IDLE');
  assert.ok(seen.length >= 3);
  d.close();
});

test('FINISHED, LOAD_FAILED and another app taking over map to finished, error and taken', { skip }, async () => {
  const d = new ChromecastDevice({ host: cc.host, port: cc.port });
  await d.connect();
  await d.launch();
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  cc.finish();
  await until(() => d.status().idleReason === 'finished');
  cc.failNextLoad();
  await assert.rejects(d.load({ url: 'http://x/bad.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' }), (e) => e.code === 'LOAD_FAILED');
  assert.equal(d.status().idleReason, 'error');
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  cc.takeOver();
  await until(() => d.status().idleReason === 'taken');
  assert.equal(d.status().state, 'idle');
  d.close();
});

test('a dropped connection emits close', { skip }, async () => {
  const d = new ChromecastDevice({ host: cc.host, port: cc.port });
  const connects = cc.sent('CONNECT').length;
  await d.connect();
  // TLS 1.3: connect() resolves before the device has finished its side; wait until it has heard from us.
  await until(() => cc.sent('CONNECT').length > connects);
  let closed = false;
  d.on('close', () => (closed = true));
  cc.drop();
  await until(() => closed);
});

test('a PING from the device is answered with PONG', { skip }, async () => {
  const d = new ChromecastDevice({ host: cc.host, port: cc.port });
  const connects = cc.sent('CONNECT').length;
  await d.connect();
  await until(() => cc.sent('CONNECT').length > connects);
  const before = cc.state.pongs;
  cc.pingClient();
  await until(() => cc.state.pongs > before);
  d.close();
});

test('a device that stops answering (no PONG, nothing) is closed after the dead time', { skip }, async () => {
  const d = new ChromecastDevice({ host: cc.host, port: cc.port, pingMs: 100, deadMs: 400 });
  const connects = cc.sent('CONNECT').length;
  await d.connect();
  await until(() => cc.sent('CONNECT').length > connects);
  let closed = false;
  d.on('close', () => (closed = true));
  cc.state.silent = true;
  try {
    await until(() => closed, 3000);
  } finally {
    cc.state.silent = false;
  }
});
