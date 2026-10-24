// IPTV Simple keeps a channel's encryption lines (Kodi inputstream.adaptive conventions) so Atomix can play it in the
// browser: the licence-key grammar, drm_legacy, manifest/stream headers and ClearKey keys in the playlist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeServer } from './helpers.js';
import { parseLicenceKey, systemName, parseHeaderList } from '../plugins/iptv-simple/drm.js';
import { parseM3u } from '../plugins/iptv-simple/m3u.js';
import { setup } from '../plugins/iptv-simple/index.js';
import { fetchFollowing } from '../src/remote/provider.js';
import { redactUrl, isPrivateTarget } from '../src/http/net.js';

const M3U = fs.readFileSync(new URL('./fixtures/iptv/drm.m3u', import.meta.url), 'utf8');
const KID = 'a7e61c373e219033c21091fa607bf3b8';
const KEY = '76a6c65c5ea762046bd749a2e632ccbb';

test('a licence key that is just an address: raw request, raw answer, no headers', () => {
  assert.deepEqual(parseLicenceKey('widevine', 'https://lic.example/wv'), { url: 'https://lic.example/wv', headers: {}, body: { kind: 'raw' }, response: { kind: 'raw' } });
});

test('headers, R{SSM} and an empty response part', () => {
  assert.deepEqual(parseLicenceKey('widevine', 'https://lic.example/wv|User-Agent=Foo%20Bar&X-Token=abc|R{SSM}|'), {
    url: 'https://lic.example/wv',
    headers: { 'User-Agent': 'Foo Bar', 'X-Token': 'abc' },
    body: { kind: 'raw' },
    response: { kind: 'raw' },
  });
});

test('a templated request and the response forms (JBlicense, B, J with a dotted path)', () => {
  const t = parseLicenceKey('widevine', 'https://l/x||{"challenge":"b{SSM}"}|JBlicense');
  assert.deepEqual(t.body, { kind: 'template', text: '{"challenge":"b{SSM}"}' });
  assert.deepEqual(t.response, { kind: 'json', path: 'license', base64: true });
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x|||B').response, { kind: 'base64' });
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x|||Jdata.lic').response, { kind: 'json', path: 'data.lic', base64: false });
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x||b{SSM}|').body, { kind: 'template', text: 'b{SSM}' });
});

test('the other response forms Kodi documents: BJ (base64 JSON), HB (an HTTP answer with a base64 body), a ";hdcp" suffix', () => {
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x|||BJlicense').response, { kind: 'json', path: 'license', base64: false, wrapped: true });
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x|||HB').response, { kind: 'http-base64' });
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x|||JBlicense;hdcp').response, { kind: 'json', path: 'license', base64: true });
  assert.deepEqual(parseLicenceKey('widevine', 'https://l/x|||B;hdcp').response, { kind: 'base64' });
});

test('ClearKey keys written in the playlist: kid:key pairs or a JSON object; anything else is null', () => {
  assert.deepEqual(parseLicenceKey('clearkey', `${KID}:${KEY}`), { keys: [{ kid: KID, key: KEY }] });
  assert.deepEqual(parseLicenceKey('clearkey', `${KID.toUpperCase()}:${KEY},${KEY}:${KID}`), { keys: [{ kid: KID, key: KEY }, { kid: KEY, key: KID }] });
  assert.deepEqual(parseLicenceKey('clearkey', JSON.stringify({ [KID]: KEY })), { keys: [{ kid: KID, key: KEY }] });
  assert.equal(parseLicenceKey('clearkey', 'zz:yy'), null);
  assert.equal(parseLicenceKey('widevine', ''), null);
  assert.equal(parseLicenceKey('widevine', 'file:///etc/passwd'), null, 'only http(s) licence servers');
});

test('systemName and parseHeaderList', () => {
  assert.equal(systemName('com.widevine.alpha'), 'widevine');
  assert.equal(systemName('Widevine'), 'widevine');
  assert.equal(systemName('org.w3.clearkey'), 'clearkey');
  assert.equal(systemName('com.microsoft.playready'), null);
  assert.deepEqual(parseHeaderList('Referer=https%3A%2F%2Fa.example%2F&Origin=x'), { Referer: 'https://a.example/', Origin: 'x' });
});

test('parseM3u keeps each channel\'s encryption, and plain channels have none', () => {
  const { channels } = parseM3u(M3U);
  const by = Object.fromEntries(channels.map((c) => [c.name, c]));
  assert.deepEqual(by['TVNZ 2'].drm, { system: 'widevine', licence: { url: 'https://c.mjh.nz/tvnz-2-wv', headers: {}, body: { kind: 'raw' }, response: { kind: 'raw' } } });
  assert.equal(by['TVNZ 2'].mime, 'application/dash+xml');
  assert.deepEqual(by['Clear Key Legacy'].drm, { system: 'clearkey', licence: { url: 'https://l.example/ck', headers: { 'X-A': '1', 'X-B': 'two words' }, body: { kind: 'raw' }, response: { kind: 'raw' } } });
  assert.equal(by['Clear Key Legacy'].mime, 'application/dash+xml', 'a .mpd address is DASH');
  assert.deepEqual(by.Headered.manifestHeaders, { Referer: 'https://a.example/' });
  assert.deepEqual(by.Headered.streamHeaders, { Referer: 'https://a.example/', Origin: 'https://a.example' });
  assert.deepEqual(by.Headered.drm.licence.headers, { 'X-Token': 'abc' });
  assert.deepEqual(by['Keys Inline'].drm, { system: 'clearkey', licence: { keys: [{ kid: KID, key: KEY }] } });
  assert.equal(by.Plain.drm, null);
  assert.equal(by.Plain.manifestHeaders, undefined);
});

let srv;
before(async () => {
  srv = await fakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
    res.end(M3U);
  });
});
after(() => srv.close());

function plugin() {
  let source;
  const storage = new Map();
  setup({
    id: 'iptv-simple',
    version: '0.17.0',
    config: { playlist: `${srv.url}/list.m3u`, guide: '', userAgent: '', refreshHours: '6', numbering: 'playlist', startNumber: 1, guideShift: 0, logosPath: '', maxStreams: 'auto', catchupDays: 7 },
    HttpError: class extends Error {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get: (k, d = null) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v), delete: (k) => storage.delete(k) },
    fetch: (...a) => fetch(...a),
    fetchFollowing,
    redactUrl,
    isPrivateTarget,
    onConfigChange() {},
    registerLiveSource(s) {
      source = s;
    },
  });
  return { source, storage };
}

test('the plugin reports only the system name per channel and hands the rest to stream()', async () => {
  const { source, storage } = plugin();
  const r = await source.refresh({ signal: AbortSignal.timeout(10000), log: { info() {}, warn() {} } });
  const tvnz = r.channels.find((c) => c.name === 'TVNZ 2');
  assert.equal(tvnz.drm, 'widevine');
  assert.equal(r.channels.find((c) => c.name === 'Plain').drm, null);
  assert.ok(!JSON.stringify(r.channels).includes('c.mjh.nz') && !JSON.stringify(r.channels).includes(KEY), 'licence details stay inside the plugin');
  const s = await source.stream(tvnz.key);
  assert.equal(s.drm.system, 'widevine');
  assert.equal(s.drm.licence.url, 'https://c.mjh.nz/tvnz-2-wv');
  const hdr = await source.stream(r.channels.find((c) => c.name === 'Headered').key);
  assert.equal(hdr.headers.Referer, 'https://a.example/', 'stream headers go with the segments');
  assert.deepEqual(hdr.manifestHeaders, { Referer: 'https://a.example/' });
  assert.ok(storage.get('channels'), 'kept in the plugin\'s storage for after a restart');
  const plain = await source.stream(r.channels.find((c) => c.name === 'Plain').key);
  assert.equal(plain.drm, null);
});

test('a playlist address whose name resolves to link-local is refused', async () => {
  const { openInput } = await import('../plugins/iptv-simple/fetch.js');
  const { checkResolved } = await import('../src/http/net.js');
  let hits = 0;
  const srv = await fakeServer((req, res) => { hits++; res.end('#EXTM3U\n'); });
  try {
    const api = { fetchFollowing, isPrivateTarget, checkResolved: (u) => checkResolved(u, { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }) };
    await assert.rejects(openInput(`${srv.url.replace('127.0.0.1', 'localhost')}/p.m3u`, { userAgent: 'x', what: 'playlist' }, api));
    assert.equal(hits, 0);
  } finally {
    await srv.close();
  }
});

test('ClearKey keys in JWK form', () => {
  assert.deepEqual(parseLicenceKey('clearkey', '{"keys":[{"kty":"oct","kid":"p-YcNz4hkDPCEJH6YHvzuA","k":"dqbGXF6nYgRr10mi5jLMuw"}]}'), { keys: [{ kid: KID, key: KEY }] });
});

// v0.27 Plan B: FairPlay (an Atomix extension of the same properties; the manifest is HLS).
test('FairPlay: license_type com.apple.fps with the licence grammar and a certificate address', () => {
  const fp = parseM3u(M3U).channels.find((c) => c.name === 'FP One');
  assert.equal(fp.drm.system, 'fairplay');
  assert.equal(fp.drm.licence.url, 'https://lic.example/fps');
  assert.deepEqual(fp.drm.licence.headers, { 'X-Key': 'abc' });
  assert.deepEqual(fp.drm.licence.body, { kind: 'template', text: 'spc=b{SSM}&id={CONTENTID}' });
  assert.deepEqual(fp.drm.licence.response, { kind: 'base64' });
  assert.equal(fp.drm.serverCertificate, 'https://lic.example/cert.der');
});

test('systemName knows FairPlay; PlayReady is still not played', () => {
  assert.equal(systemName('com.apple.fps'), 'fairplay');
  assert.equal(systemName('fairplay'), 'fairplay');
  assert.equal(systemName('com.microsoft.playready'), null);
});

test('the plugin lists a FairPlay channel by name only and hands its certificate to stream()', async () => {
  const { source } = plugin();
  const r = await source.refresh({ signal: AbortSignal.timeout(10000), log: { info() {}, warn() {} } });
  const fp = r.channels.find((c) => c.name === 'FP One');
  assert.equal(fp.drm, 'fairplay');
  assert.ok(!JSON.stringify(r.channels).includes('lic.example'), 'licence and certificate addresses stay inside the plugin');
  const s = await source.stream(fp.key);
  assert.equal(s.drm.serverCertificate, 'https://lic.example/cert.der');
});
