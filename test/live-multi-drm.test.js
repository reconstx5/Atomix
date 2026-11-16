// Several key systems per channel on the relay (v0.28): the server picks the system the device can play (its own
// order of preference), refuses before anything is reserved or fetched when none fits, and PlayReady joins the DASH
// path (manifest filtered to its mspr:pro, the browser's wrapped licence message unwrapped for the provider).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client } from './helpers.js';
import { multiDrmProvider, MULTI_MPD } from './helpers-live.js';
import { chooseSystem, unwrapPlayReady, rewriteManifest, KEY_SYSTEMS } from '../src/live/drm.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const NONE = "This browser can't play any of this channel's protections.";
const PR_MESSAGE = '<PlayReadyKeyMessage type="LicenseAcquisition"><LicenseAcquisition Version="1"><Challenge encoding="base64encoded">QUJD</Challenge><HttpHeaders><HttpHeader><name>Content-Type</name><value>text/xml; charset=utf-8</value></HttpHeader><HttpHeader><name>SOAPAction</name><value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value></HttpHeader></HttpHeaders></LicenseAcquisition></PlayReadyKeyMessage>';
const proText = (b64) => Buffer.from(b64, 'base64').subarray(10).toString('utf16le');
const utf16 = (s) => Buffer.from(s, 'utf16le');
let nf, admin, provider, ids;

// ---- The chooser ----

test('chooseSystem: the device\'s order wins; none in common is null; no device list is the channel\'s first', () => {
  assert.equal(chooseSystem(['widevine', 'playready', 'clearkey'], ['playready', 'widevine']), 'playready');
  assert.equal(chooseSystem(['widevine'], ['fairplay', 'clearkey']), null);
  assert.equal(chooseSystem(['widevine', 'clearkey']), 'widevine');
  assert.equal(chooseSystem(['widevine', 'clearkey'], null), 'widevine');
  assert.equal(chooseSystem(['widevine', 'clearkey'], []), null, 'a device that has none');
  assert.equal(chooseSystem([], ['widevine']), null);
});

// ---- PlayReady's licence message ----

test('unwrapPlayReady: the UTF-16 message gives the challenge and its headers', () => {
  const out = unwrapPlayReady(utf16(PR_MESSAGE));
  assert.ok(out);
  assert.equal(out.challenge.toString(), 'ABC');
  assert.deepEqual(out.headers, { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"' });
  const bom = unwrapPlayReady(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16(`<?xml version="1.0" encoding="utf-16"?>\n${PR_MESSAGE}`)]));
  assert.equal(bom?.challenge.toString(), 'ABC', 'a byte-order mark and declaration are fine');
});

test('unwrapPlayReady: raw bytes, a truncated message and a bad challenge are null (sent as they are)', () => {
  assert.equal(unwrapPlayReady(Buffer.from([0x08, 0x04, 0x12, 0x10, 0xaa, 0xbb])), null);
  assert.equal(unwrapPlayReady(Buffer.from('<soap:Envelope/>')), null, 'a plain SOAP body (already unwrapped)');
  assert.equal(unwrapPlayReady(utf16(PR_MESSAGE.slice(0, 120))), null, 'truncated');
  assert.equal(unwrapPlayReady(utf16(PR_MESSAGE).subarray(0, 241)), null, 'cut mid-character');
  assert.equal(unwrapPlayReady(utf16(PR_MESSAGE.replace('QUJD', '!!not base64!!'))), null);
  assert.equal(unwrapPlayReady(utf16(PR_MESSAGE.replace('QUJD', ''))), null, 'no challenge');
  assert.equal(unwrapPlayReady(utf16('<Other><Challenge>QUJD</Challenge></Other>')), null, 'not a PlayReadyKeyMessage');
  assert.equal(unwrapPlayReady(Buffer.alloc(0)), null);
});

// ---- The manifest keeps the chosen system only ----

const protections = (xml) => [...xml.matchAll(/<ContentProtection[^>]*schemeIdUri="([^"]+)"/g)].map((m) => m[1].toLowerCase());
const rewrite = (system) => rewriteManifest(MULTI_MPD, 'https://cdn.example/live/x.mpd', { id: 's1', bases: [], system });

test('the manifest kept for playready keeps mspr:pro and the pssh, with Atomix\'s licence address in them', () => {
  const out = rewrite('playready');
  assert.deepEqual(protections(out), ['urn:mpeg:dash:mp4protection:2011', 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95']);
  // The provider's licence address inside the header object (and the PlayReady pssh) is Atomix's own for the session.
  const header = proText(/<mspr:pro>([^<]+)</.exec(out)[1]);
  assert.ok(header.includes('<LA_URL>/api/live/drm/s1/licence</LA_URL>'), header);
  assert.ok(!header.includes('LUI_URL') && !header.includes('lic.example') && !header.includes('prsecret'));
  const pssh = Buffer.from(/<cenc:pssh>([^<]+)</.exec(out)[1], 'base64');
  const inner = proText(pssh.subarray(32).toString('base64'));
  assert.ok(inner.includes('<LA_URL>/api/live/drm/s1/licence</LA_URL>') && !inner.includes('lic.example'), inner);
  assert.equal(pssh.readUInt32BE(0), pssh.length);
  assert.ok(!out.includes('EDEF8BA9') && !/edef8ba9/i.test(out), "Widevine's entry is gone");
  assert.ok(!Buffer.from(out).toString().includes('lic.example'));
});

test('a PlayReady header that can\'t be read is dropped from the manifest', () => {
  const out = rewriteManifest(MULTI_MPD.replace(/<mspr:pro>[^<]+<\/mspr:pro>/, '<mspr:pro>UFJPLUhFQURFUg==</mspr:pro>'), 'https://cdn.example/live/x.mpd', { id: 's1', bases: [], system: 'playready' });
  assert.ok(!out.includes('mspr:pro') && !out.includes('UFJPLUhFQURFUg'));
});

test('the manifest kept for widevine or clearkey has only that system (and mp4protection)', () => {
  assert.deepEqual(protections(rewrite('widevine')), ['urn:mpeg:dash:mp4protection:2011', 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed']);
  const ck = rewrite('clearkey');
  assert.deepEqual(protections(ck), ['urn:mpeg:dash:mp4protection:2011', 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e']);
  assert.ok(!ck.includes('mspr:pro') && !ck.includes('cenc:pssh'));
});

// ---- Through the API ----

before(async () => {
  provider = await multiDrmProvider();
  process.env.LIVE_TEST_BASE = provider.url;
  process.env.LIVE_TEST_MULTIPLAY = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_MULTIPLAY;
  await nf?.app.stop();
  await provider?.close();
});

const drm = () => nf.app.core.live.drm;
const play = (id, body = {}) => admin.post(`/api/live/channels/${id}/play`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] }, ...body });
const stopAll = () => {
  for (const id of [...drm().sessions.keys()]) drm().stop(id, 'test');
};
const secretsIn = (text) => [provider.url.replace('http://', ''), 'hdrsecret', 'mansecret', 'prsecret', 'wvsecret', '76a6c65c5ea762046bd749a2e632ccbb'].filter((s) => text.includes(s));

test('a device that asks for ClearKey plays the multi-system channel with ClearKey', async () => {
  const r = await play(ids.Trio, { keySystems: ['clearkey'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.keySystem, 'org.w3.clearkey');
  assert.equal(r.data.system, 'clearkey');
  assert.deepEqual(secretsIn(JSON.stringify(r.data)), []);
  assert.equal(drm().sessions.get(r.data.sessionId).system, 'clearkey', 'the session keeps the chosen system only');
  assert.equal(provider.manifests['/dash/trio-ck.mpd'], 1, 'the system\'s own address was asked');
  const m = await admin.raw(r.data.manifest);
  const text = await m.text();
  assert.equal(m.status, 200);
  assert.deepEqual(protections(text), ['urn:mpeg:dash:mp4protection:2011', 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e']);
  assert.deepEqual(secretsIn(text), []);
  const kid = Buffer.from('a7e61c373e219033c21091fa607bf3b8', 'hex').toString('base64url');
  const lic = await admin.post(r.data.licence, { kids: [kid], type: 'temporary' });
  assert.equal(lic.status, 200, JSON.stringify(lic.data));
  assert.deepEqual(lic.data.keys, [{ kty: 'oct', kid, k: Buffer.from('76a6c65c5ea762046bd749a2e632ccbb', 'hex').toString('base64url') }]);
  stopAll();
});

test('nothing in common: 409 with the sentence, nothing reserved and the provider not asked', async () => {
  const streams = nf.app.core.live.streams;
  const reserve = streams.reserve;
  let reserved = 0;
  streams.reserve = (...a) => (reserved++, reserve.apply(streams, a));
  try {
    const before = provider.manifests['/dash/duo.mpd'] || 0;
    const r = await play(ids.Duo, { keySystems: ['fairplay', 'clearkey'] });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, NONE);
    assert.equal(provider.manifests['/dash/duo.mpd'] || 0, before, 'the provider\'s manifest was not fetched');
    assert.equal(reserved, 0, 'no stream reserved');
    assert.equal(drm().sessions.size, 0);
  } finally {
    streams.reserve = reserve;
  }
});

test('no keySystems (an older page) plays the channel\'s first system; the device\'s order picks otherwise', async () => {
  const first = await play(ids.Trio);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.keySystem, 'com.widevine.alpha');
  assert.equal(first.data.system, 'widevine');
  const edge = await play(ids.Trio, { keySystems: ['playready', 'widevine', 'clearkey'] });
  assert.equal(edge.status, 200, JSON.stringify(edge.data));
  assert.equal(edge.data.keySystem, KEY_SYSTEMS.playready);
  assert.equal(edge.data.keySystem, 'com.microsoft.playready.recommendation');
  assert.equal(edge.data.system, 'playready');
  const row = (await admin.get('/api/admin/dashboard')).data.sessions.find((s) => s.id === edge.data.sessionId);
  assert.deepEqual(row.reasons, ['Encrypted (PlayReady): played in the browser']);
  stopAll();
});

test('keySystems that aren\'t a list of known names are ignored', async () => {
  const notList = await play(ids.Trio, { keySystems: 'clearkey' });
  assert.equal(notList.data.system, 'widevine', 'a string is as if nothing was sent');
  const mixed = await play(ids.Trio, { keySystems: ['bogus', 5, { a: 1 }, 'clearkey'] });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.data));
  assert.equal(mixed.data.system, 'clearkey', 'unknown names dropped');
  stopAll();
});

test('a source that answers another system than the one asked is "couldn\'t be read", never played as asked', async () => {
  const r = await play(ids.Liar, { keySystems: ['clearkey'] });
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "This channel's stream couldn't be read");
  assert.equal(drm().sessions.size, 0);
});

test('PlayReady licence: the wrapped message is unwrapped; the challenge, SOAPAction and playlist headers reach the provider', async () => {
  const r = await play(ids.Ready);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.system, 'playready');
  const m = await admin.raw(r.data.manifest);
  const mpd = await m.text();
  assert.match(mpd, /mspr:pro/);
  const header = proText(/<mspr:pro>([^<]+)</.exec(mpd)[1]);
  assert.ok(header.includes(`<LA_URL>${r.data.licence}</LA_URL>`), header);
  const inner = proText(Buffer.from(/<cenc:pssh>([^<]+)</.exec(mpd)[1], 'base64').subarray(32).toString('base64'));
  for (const text of [header, inner]) assert.deepEqual(secretsIn(text).concat(text.includes('lic.example') ? ['lic.example'] : []), []);
  const evil = PR_MESSAGE.replace('</HttpHeaders>', '<HttpHeader><name>Cookie</name><value>a=b</value></HttpHeader><HttpHeader><name>X-Evil</name><value>1</value></HttpHeader></HttpHeaders>');
  const lic = await admin.raw(r.data.licence, { method: 'POST', body: utf16(evil), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(lic.status, 200);
  assert.equal(Buffer.from(await lic.arrayBuffer()).toString(), 'PR-LICENCE', 'the provider\'s answer as it is');
  const got = provider.licences.at(-1);
  assert.equal(got.url, '/lic/pr');
  assert.equal(got.body.toString(), 'ABC');
  assert.equal(got.headers.soapaction, '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"');
  assert.equal(got.headers['content-type'], 'text/xml; charset=utf-8');
  assert.equal(got.headers['x-pr'], 'prsecret');
  assert.equal(got.headers.cookie, undefined, 'only Content-Type and SOAPAction come from the message');
  assert.equal(got.headers['x-evil'], undefined);
  // A raw (already unwrapped) challenge, or a broken message, is sent as it is — never a server error.
  const rawLic = await admin.raw(r.data.licence, { method: 'POST', body: Buffer.from('RAWCHALLENGE'), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(rawLic.status, 200);
  assert.equal(provider.licences.at(-1).body.toString(), 'RAWCHALLENGE');
  const broken = utf16(PR_MESSAGE.slice(0, 100));
  const brokenLic = await admin.raw(r.data.licence, { method: 'POST', body: broken, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(brokenLic.status, 200);
  assert.deepEqual(provider.licences.at(-1).body, broken);
  stopAll();
});
