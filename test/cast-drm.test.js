// v0.27 Plan C: casting an encrypted channel. A Chromecast decrypts it with its own Widevine (here ClearKey): the cast
// manager opens a LiveDrm session for the TV, a cast link scoped to that session lets the TV fetch the manifest,
// segments and licence without a sign-in, and the TV's manifest names Atomix's licence address (dashif:Laurl).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, fakeServer } from './helpers.js';
import { fakeChromecast, fakeDlna, hasOpenssl } from './helpers-cast.js';
import { DLNA_ENCRYPTED } from '../src/api/cast.js';

const skip = (!hasFfmpeg && 'ffmpeg not installed') || (!hasOpenssl && 'openssl not installed');
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const KID = 'a7e61c373e219033c21091fa607bf3b8';
const b64u = (hex) => Buffer.from(hex, 'hex').toString('base64url');
let nf, admin, kid, up, cc, tv, ids;
const dev = {};
const providerUrls = [];
let failManifest = null; // a channel key whose manifest the provider refuses (a zap that fails partway)

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
const castChannel = async (name, device = 'Living room TV', as = admin) => as.post('/api/cast/sessions', { deviceId: dev[device], liveChannelId: ids[name] });
const raw = (url, opts = {}) => fetch(url, opts); // no cookie: as the TV

const MPD = (n) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="dynamic" availabilityStartTime="2026-10-10T00:00:00Z" minimumUpdatePeriod="PT2S">
  <Period id="p" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="a7e61c37-3e21-9033-c210-91fa607bf3b8"/>
      ${n === 'six' ? '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>AAAAQHBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAACAiGHlvdXR1YmUtZGFzaC10ZXN0LWNsZWFya2V5SOPclZsG</cenc:pssh></ContentProtection>' : ''}
      <SegmentTemplate timescale="1" duration="2" startNumber="1" media="$RepresentationID$/seg-$Number$.m4s?tk=segsecret" initialization="$RepresentationID$/init.mp4?hdnts=exp=1~acl=/*~hmac=ab&amp;flag"/>
      <Representation id="hd" bandwidth="3000000" codecs="avc1.4d401f" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;

before(async () => {
  if (skip) return;
  const ts = path.join(tempDir(), 'live.ts');
  makeVideo(ts, { seconds: 4 });
  up = await fakeServer(async (req, res) => {
    providerUrls.push(req.url);
    const m = /^\/dash\/(\w+)\/live\.mpd/.exec(req.url);
    if (m && m[1] === failManifest) {
      res.writeHead(502);
      return res.end('down');
    }
    if (m) {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(MPD(m[1]));
    }
    if (req.url.startsWith('/dash/')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end('SEG');
    }
    if (req.url.startsWith('/live/') || req.url.startsWith('/dead/')) {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return fs.createReadStream(ts).pipe(res);
    }
    if (req.url.startsWith('/lic/')) {
      for await (const _ of req);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end('LICENCE');
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = up.url;
  process.env.LIVE_TEST_DRM = '1';
  process.env.LIVE_TEST_FPS = '1';
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
  delete process.env.LIVE_TEST_DRM;
  delete process.env.LIVE_TEST_FPS;
  delete process.env.LIVE_TEST_MAX;
  await nf?.app.stop();
  for (const f of [cc, tv]) await f?.close();
  await up?.close();
});

const drmSessions = () => [...nf.app.core.live.drm.sessions.values()];

test("casting an encrypted channel to a Chromecast loads Atomix's DASH manifest as LIVE with the channel's name", { skip }, async () => {
  const r = await castChannel('Five');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const load = await until(() => lastLoad(cc));
  assert.equal(load.media.contentType, 'application/dash+xml');
  assert.equal(load.media.streamType, 'LIVE');
  assert.equal(load.media.metadata.title, 'Five');
  assert.match(load.media.contentId, new RegExp(`^${nf.base}/api/live/drm/[0-9a-f]+/manifest\\.mpd\\?cast=`));
  assert.equal(drmSessions().length, 1);
  await stopCast(admin);
});

test("the TV's manifest carries the licence address and absolute segment addresses with the link, and no provider host", { skip }, async () => {
  await castChannel('Five');
  const url = (await until(() => lastLoad(cc))).media.contentId;
  const res = await raw(url);
  assert.equal(res.status, 200);
  const mpd = await res.text();
  const port = new URL(up.url).port;
  assert.match(mpd, /<dashif:Laurl[^>]*>[^<]*\/api\/live\/drm\/[0-9a-f]+\/licence\?cast=[^<]+<\/dashif:Laurl>/);
  assert.match(mpd, /xmlns:dashif="https:\/\/dashif\.org\/CPS"/);
  for (const m of mpd.matchAll(/(?:media|initialization)="([^"]+)"/g)) {
    assert.ok(m[1].startsWith(`${nf.base}/api/live/drm/`), m[1]);
    assert.match(m[1].replace(/&amp;/g, '&'), /[?&]cast=/);
  }
  assert.doesNotMatch(mpd, new RegExp(`127\\.0\\.0\\.1:${port}|hdrsecret|mansecret`));
  await stopCast(admin);
});

test("the TV's licence request: preflight and POST from the receiver's origin", { skip }, async () => {
  await castChannel('Five');
  const mpd = await (await raw((await until(() => lastLoad(cc))).media.contentId)).text();
  const laurl = /<dashif:Laurl[^>]*>([^<]+)<\/dashif:Laurl>/.exec(mpd)[1].replace(/&amp;/g, '&');
  const pre = await raw(laurl, { method: 'OPTIONS', headers: { origin: 'https://www.gstatic.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/);
  const lic = await raw(laurl, { method: 'POST', headers: { origin: 'https://www.gstatic.com', 'content-type': 'application/json' }, body: JSON.stringify({ kids: [b64u(KID)], type: 'temporary' }) });
  assert.equal(lic.status, 200);
  assert.equal(lic.headers.get('access-control-allow-origin'), '*');
  const jwk = await lic.json();
  assert.equal(jwk.keys[0].kid, b64u(KID));
  assert.ok(jwk.keys[0].k);
  await stopCast(admin);
});

test('the provider never sees the cast link', { skip }, async () => {
  await castChannel('Five');
  const mpd = await (await raw((await until(() => lastLoad(cc))).media.contentId)).text();
  const seg = /initialization="([^"]+)"/.exec(mpd)[1].replace(/&amp;/g, '&');
  providerUrls.length = 0;
  const res = await raw(seg);
  assert.equal(res.status, 200);
  assert.ok(providerUrls.length, 'the provider was asked');
  for (const u of providerUrls) assert.doesNotMatch(u, /cast=/, u);
  await stopCast(admin);
});

test('the cast link serves only its own DRM session, and not after Stop', { skip }, async () => {
  await castChannel('Five');
  const url = new URL((await until(() => lastLoad(cc))).media.contentId);
  const token = url.searchParams.get('cast');
  const other = (await admin.post(`/api/live/channels/${ids.Six}/play`, {})).data;
  assert.equal((await raw(`${nf.base}${other.manifest}?cast=${token}`)).status, 401);
  assert.equal((await raw(`${nf.base}/api/items/1/file?cast=${token}`)).status, 401);
  nf.app.core.live.drm.stop(other.sessionId, 'test');
  await stopCast(admin);
  assert.equal((await raw(url.href)).status, 401);
  const sid = /drm\/([0-9a-f]+)\//.exec(url.pathname)[1];
  assert.equal((await raw(`${nf.base}/api/live/drm/${sid}/licence?cast=${token}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('x') })).status, 401);
  assert.equal(drmSessions().length, 0);
});

test('a DRM cast is kept alive with no browser pings', { skip }, async () => {
  await castChannel('Five');
  await until(() => lastLoad(cc));
  const [s] = drmSessions();
  s.lastSeen -= 3 * 60_000;
  nf.app.core.cast.manager.keepAliveTick();
  nf.app.core.live.drm.reap();
  assert.equal(drmSessions().length, 1, 'still there');
  await stopCast(admin);
});

test('zapping on the TV between an encrypted and a plain channel on a 1-stream provider leaves one stream', { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    const r = await castChannel('Six');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const id = r.data.id;
    const one = () => drmSessions().length + nf.app.core.playback.sessions.size; // the TV's encrypted and plain streams
    // Six (Widevine) → Five (ClearKey) → Three (plain) → Five → Six.
    for (const dir of ['channelDown', 'channelDown', 'channelUp', 'channelUp']) {
      const z = await cmd(admin, id, dir);
      assert.equal(z.status, 200, `${dir}: ${JSON.stringify(z.data)}`);
      await until(() => one() === 1, 3000).catch(() => {});
      assert.equal(one(), 1, `after ${dir}`);
    }
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopCast(admin);
  }
});

test('DLNA refuses an encrypted channel with the sentence; FairPlay is never cast', { skip }, async () => {
  const d = await castChannel('Five', 'Samsung TV');
  assert.equal(d.status, 400);
  assert.equal(d.data.error, DLNA_ENCRYPTED);
  assert.equal(DLNA_ENCRYPTED, "This TV can't play encrypted channels; use a Chromecast or Google TV");
  const f = await castChannel('Eight');
  assert.equal(f.status, 400);
  assert.equal(f.data.error, "This channel is encrypted, so it can't be cast");
  assert.equal(drmSessions().length, 0);
});

test("a Kids profile can't cast an encrypted channel outside its groups", { skip }, async () => {
  const r = await castChannel('Five', 'Living room TV', kid);
  assert.equal(r.status, 404);
});

// ---- Final-review fixes ----
import http from 'node:http';

test("the receiver's licence POST with no content type is answered (Shaka posts the key system's bytes as they are)", { skip }, async () => {
  await castChannel('Five');
  const mpd = await (await raw((await until(() => lastLoad(cc))).media.contentId)).text();
  const laurl = new URL(/<dashif:Laurl[^>]*>([^<]+)<\/dashif:Laurl>/.exec(mpd)[1].replace(/&amp;/g, '&'));
  const body = Buffer.from(JSON.stringify({ kids: [b64u(KID)], type: 'temporary' }));
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: laurl.hostname, port: laurl.port, path: laurl.pathname + laurl.search, method: 'POST', headers: { origin: 'https://www.gstatic.com', 'content-length': body.length } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, acao: r.headers['access-control-allow-origin'], body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.acao, '*');
  assert.equal(JSON.parse(res.body).keys[0].kid, b64u(KID));
  await stopCast(admin);
});

test("a zap that fails partway leaves the TV's channel playing (the provider had room)", { skip }, async () => {
  const r = await castChannel('Six');
  const id = r.data.id;
  await until(() => lastLoad(cc));
  const [six] = drmSessions();
  failManifest = 'five';
  try {
    const z = await cmd(admin, id, 'channelDown');
    assert.equal(z.status, 502);
  } finally {
    failManifest = null;
  }
  assert.ok(nf.app.core.live.drm.sessions.has(six.id), "Six's stream is still there");
  const cur = (await current(admin)).data;
  assert.equal(cur.id, id, 'the cast carries on');
  assert.equal(cur.title, 'Six');
  await stopCast(admin);
});

test("a press elsewhere that takes the TV's only provider stream ends the cast at once", { skip }, async () => {
  process.env.LIVE_TEST_MAX = '1';
  try {
    await castChannel('Six');
    await until(() => lastLoad(cc));
    const p = await admin.post(`/api/live/channels/${ids.Five}/play`, {});
    assert.equal(p.status, 200, JSON.stringify(p.data));
    const cur = await until(async () => {
      const c = (await current(admin)).data;
      return c && c.ended ? c : null;
    }, 8000);
    assert.equal(cur.ended, 'stopped');
    nf.app.core.live.drm.stop(p.data.sessionId, 'test');
  } finally {
    delete process.env.LIVE_TEST_MAX;
    await stopCast(admin);
  }
});

test("the TV's manifest uses the casting address, whatever Host the request carried", { skip }, async () => {
  await castChannel('Five');
  const url = new URL((await until(() => lastLoad(cc))).media.contentId);
  const mpd = await new Promise((resolve, reject) => {
    http.get({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { host: 'proxy.internal:9' } }, (r) => {
      let t = '';
      r.on('data', (c) => (t += c));
      r.on('end', () => resolve(t));
    }).on('error', reject);
  });
  assert.doesNotMatch(mpd, /proxy\.internal/);
  assert.match(mpd, new RegExp(`initialization="${nf.base.replace(/[.]/g, '\\.')}/api/live/drm/`));
  await stopCast(admin);
});

test("the provider gets its segment query exactly as written (no re-encoding when the link is taken off)", { skip }, async () => {
  await castChannel('Five');
  const mpd = await (await raw((await until(() => lastLoad(cc))).media.contentId)).text();
  const init = /initialization="([^"]+)"/.exec(mpd)[1].replace(/&amp;/g, '&').replace('$RepresentationID$', 'hd');
  providerUrls.length = 0;
  assert.equal((await raw(init)).status, 200);
  assert.ok(providerUrls.includes('/dash/five/hd/init.mp4?hdnts=exp=1~acl=/*~hmac=ab&flag'), JSON.stringify(providerUrls));
  await stopCast(admin);
});
