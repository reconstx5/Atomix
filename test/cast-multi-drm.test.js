// Casting an encrypted channel (v0.28): the TV's choice is Widevine, then PlayReady, then ClearKey. A PlayReady
// manifest for the TV names Atomix's licence address twice (dashif:Laurl and the LA_URL inside mspr:pro and the
// PlayReady pssh); the provider's licence host is nowhere in it. FairPlay-only channels still can't be cast.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, startAtomix, client, fakeServer } from './helpers.js';
import { fakeChromecast, hasOpenssl } from './helpers-cast.js';
import { rewriteManifest } from '../src/live/drm.js';
import { castableDrm } from '../public/js/live.js';

const skip = (!hasFfmpeg && 'ffmpeg not installed') || (!hasOpenssl && 'openssl not installed');
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const CANT = "This channel is encrypted, so it can't be cast";
const KID = Buffer.from('a7e61c373e219033c21091fa607bf3b8', 'hex');
let nf, admin, up, cc, ids;

// A PlayReady Object (what mspr:pro carries): length, record count, one WRMHEADER record (UTF-16LE).
const wrm = (la) => `<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><PROTECTINFO><KEYLEN>16</KEYLEN><ALGID>AESCTR</ALGID></PROTECTINFO><KID>AAAA</KID><LA_URL>${la}</LA_URL><LUI_URL>${la}/ui</LUI_URL></DATA></WRMHEADER>`;
const pro = (la) => {
  const xml = Buffer.from(wrm(la), 'utf16le');
  const head = Buffer.alloc(6 + 4);
  head.writeUInt32LE(6 + 4 + xml.length, 0);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 6);
  head.writeUInt16LE(xml.length, 8);
  return Buffer.concat([head, xml]);
};
const readPro = (b64) => {
  const b = Buffer.from(b64, 'base64');
  assert.equal(b.readUInt32LE(0), b.length, 'the object length is right');
  const len = b.readUInt16LE(8);
  assert.equal(10 + len, b.length, 'the record length is right');
  return b.subarray(10).toString('utf16le');
};
const psshOf = (data) => {
  const head = Buffer.alloc(32);
  head.writeUInt32BE(32 + data.length, 0);
  head.write('pssh', 4);
  Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex').copy(head, 12);
  head.writeUInt32BE(data.length, 28);
  return Buffer.concat([head, data]);
};
const readPssh = (b64) => {
  const b = Buffer.from(b64, 'base64');
  assert.equal(b.readUInt32BE(0), b.length);
  assert.equal(b.readUInt32BE(28), b.length - 32);
  return readPro(b.subarray(32).toString('base64'));
};

let providerHost = '';
const MPD = (kind) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" xmlns:mspr="urn:microsoft:playready" type="dynamic" availabilityStartTime="2026-10-10T00:00:00Z" minimumUpdatePeriod="PT2S">
  <Period id="p" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="a7e61c37-3e21-9033-c210-91fa607bf3b8"/>
      <ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"><cenc:pssh>AAAAQnBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAACISEKfmHDc+IZAzwhCR+mB787hI49yVmwY=</cenc:pssh></ContentProtection>
      ${
        kind === 'ready' || kind === 'trio'
          ? `<ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95" value="MSPR 2.0"><cenc:pssh>${psshOf(pro(`http://${providerHost}/lic/pr?prsecret=1`)).toString('base64')}</cenc:pssh><mspr:pro>${pro(`http://${providerHost}/lic/pr?prsecret=1`).toString('base64')}</mspr:pro></ContentProtection>`
          : kind === 'badpro'
            ? '<ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95" value="MSPR 2.0"><mspr:pro>UFJPLUhFQURFUg==</mspr:pro></ContentProtection>'
            : ''
      }
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"/>
      <SegmentTemplate timescale="1" duration="2" startNumber="100" media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4"/>
      <Representation id="v720" bandwidth="3000000" codecs="avc1.4d401f" width="1280" height="720"/>
    </AdaptationSet>
  </Period>
</MPD>`;

before(async () => {
  if (skip) return;
  up = await fakeServer((req, res) => {
    providerHost = req.headers.host;
    const m = /^\/dash\/(ready|trio)\.mpd/.exec(req.url);
    res.writeHead(m ? 200 : 404, { 'content-type': 'application/dash+xml' });
    res.end(m ? MPD(m[1]) : '');
  });
  providerHost = up.url.replace('http://', '');
  process.env.LIVE_TEST_BASE = up.url;
  process.env.LIVE_TEST_MULTIPLAY = '1';
  process.env.LIVE_TEST_FPS = '1';
  cc = await fakeChromecast({ name: 'Living room TV' });
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS, ATOMIX_CAST_DISCOVERY: 'off', ATOMIX_CAST_DEVICES: `chromecast:127.0.0.1:${cc.port}#Living room TV` }, { skipLiveRefresh: true });
  Object.assign(nf.app.core.cast.manager, { saveEveryMs: 0 });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_MULTIPLAY;
  delete process.env.LIVE_TEST_FPS;
  await nf?.app.stop();
  await cc?.close();
  await up?.close();
});

const until = async (fn, ms = 8000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const lastLoad = () => cc.sent('LOAD').at(-1)?.payload;
const stopCast = async () => {
  const cur = await admin.get('/api/cast/sessions/current');
  if (cur.status === 200 && cur.data?.id) await admin.post(`/api/cast/sessions/${cur.data.id}/stop`, {});
};
const cast = async (name) => {
  const dev = (await admin.get('/api/cast/devices')).data.devices.find((d) => d.name === 'Living room TV');
  return admin.post('/api/cast/sessions', { deviceId: dev.id, liveChannelId: ids[name] });
};
const drmSessions = () => [...nf.app.core.live.drm.sessions.values()];

test('a Widevine + PlayReady + ClearKey channel is cast with Widevine', { skip }, async () => {
  const before = cc.sent('LOAD').length;
  const r = await cast('Trio');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await until(() => cc.sent('LOAD').length > before);
  assert.deepEqual(drmSessions().map((s) => s.system), ['widevine']);
  const mpd = await (await fetch(lastLoad().media.contentId)).text();
  assert.doesNotMatch(mpd, /9a04f079|mspr:pro/i, "PlayReady's entry (header object and pssh) is not in a Widevine TV manifest");
  assert.doesNotMatch(mpd, new RegExp(`127\\.0\\.0\\.1:${new URL(up.url).port}|prsecret`));
  await stopCast();
});

test('a PlayReady-only channel is cast with PlayReady; the TV manifest has the cast licence address and no provider host', { skip }, async () => {
  const before = cc.sent('LOAD').length;
  const r = await cast('Ready');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await until(() => cc.sent('LOAD').length > before);
  assert.deepEqual(drmSessions().map((s) => s.system), ['playready']);
  const res = await fetch(lastLoad().media.contentId);
  assert.equal(res.status, 200);
  const mpd = await res.text();
  assert.match(mpd, /<dashif:Laurl[^>]*>[^<]*\/api\/live\/drm\/[0-9a-f]+\/licence\?cast=[^<]+<\/dashif:Laurl>/);
  assert.match(mpd, /schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/i);
  assert.doesNotMatch(mpd, /ClearKey1\.0/);
  const laurl = /<dashif:Laurl[^>]*>([^<]+)</.exec(mpd)[1];
  const header = readPro(/<mspr:pro>([^<]+)</.exec(mpd)[1]);
  assert.ok(header.includes(`<LA_URL>${laurl}</LA_URL>`), header);
  assert.ok(!header.includes('LUI_URL'), 'the provider\'s UI address is gone too');
  assert.ok(header.includes('<KID>AAAA</KID>'), 'the rest of the header is as it was');
  assert.ok(readPssh(/<cenc:pssh>([^<]+)</.exec(mpd)[1]).includes(`<LA_URL>${laurl}</LA_URL>`), 'the pssh carries the same header');
  const port = new URL(up.url).port;
  const pssh = readPssh(/<cenc:pssh>([^<]+)</.exec(mpd)[1]);
  for (const text of [mpd, header, pssh]) assert.doesNotMatch(text, new RegExp(`127\\.0\\.0\\.1:${port}|prsecret|/lic/pr`));
  await stopCast();
});

test('an mspr:pro that can\'t be read is dropped, not passed with the provider\'s address inside it', () => {
  const out = rewriteManifest(MPD('badpro'), 'https://cdn.example/x.mpd', { id: 's1', bases: [], system: 'playready' }, { cast: { base: 'http://atomix.lan', token: 't' } });
  assert.ok(!out.includes('mspr:pro') && !out.includes('UFJPLUhFQURFUg'));
  assert.match(out, /<dashif:Laurl>http:\/\/atomix\.lan\/api\/live\/drm\/s1\/licence\?cast=t<\/dashif:Laurl>/);
});

test('a PlayReady manifest with no PlayReady entry gets one that names the cast licence address', () => {
  const out = rewriteManifest(MPD('none'), 'https://cdn.example/x.mpd', { id: 's1', bases: [], system: 'playready' }, { cast: { base: 'http://atomix.lan', token: 't' } });
  assert.match(out, /schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^>]*>\s*<dashif:Laurl>/i);
  assert.doesNotMatch(out, /ClearKey1\.0"[^>]*>\s*<dashif:Laurl/);
});

test('a FairPlay-only channel is refused for casting as before', { skip }, async () => {
  const r = await cast('Eight');
  assert.equal(r.status, 400);
  assert.equal(r.data.error, CANT);
  assert.equal(drmSessions().length, 0);
});

test('castableDrm: widevine, playready or clearkey in the list', () => {
  assert.equal(castableDrm(['fairplay']), false);
  assert.equal(castableDrm(['fairplay', 'playready']), true);
  assert.equal(castableDrm('widevine'), true);
  assert.equal(castableDrm(['clearkey']), true);
  assert.equal(castableDrm('fairplay'), false);
  assert.equal(castableDrm(null), false);
  assert.equal(castableDrm(undefined), false);
  assert.equal(castableDrm([]), false);
});
