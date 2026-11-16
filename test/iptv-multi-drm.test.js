// IPTV Simple reads several key systems per channel (Kodi's inputstream.adaptive.drm JSON, plus the older lines).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers.js';
import { parseDrmJson, systemName } from '../plugins/iptv-simple/drm.js';
import { parseM3u } from '../plugins/iptv-simple/m3u.js';
import { setup } from '../plugins/iptv-simple/index.js';
import { fetchFollowing } from '../src/remote/provider.js';
import { redactUrl, isPrivateTarget } from '../src/http/net.js';

const KID = 'a7e61c373e219033c21091fa607bf3b8';
const KEY = '76a6c65c5ea762046bd749a2e632ccbb';
const JSON_LINE = '{"com.widevine.alpha":{"license":{"server_url":"https://lic.example/wv","req_headers":"X-A=1","unwrapper":"json,base64","unwrapper_params":{"path_data":"license"}}},"com.microsoft.playready":{"license":{"server_url":"https://lic.example/pr"}},"com.apple.fps":{"license":{"server_url":"https://lic.example/fps","server_certificate":"QUJD"},"atomix_url":"https://cdn.example/master.m3u8"},"com.example.unknown":{}}';

test('systemName knows PlayReady and FairPlay 1_0', () => {
  for (const n of ['com.microsoft.playready', 'com.microsoft.playready.recommendation', 'playready']) assert.equal(systemName(n), 'playready');
  assert.equal(systemName('com.apple.fps.1_0'), 'fairplay');
});

test('parseDrmJson reads systems in order, skipping unknown ones', () => {
  const r = parseDrmJson(JSON_LINE);
  assert.deepEqual(r.map((s) => s.system), ['widevine', 'playready', 'fairplay']);
  assert.deepEqual(r[0].licence.headers, { 'X-A': '1' });
  assert.deepEqual(r[0].licence.response, { kind: 'json', path: 'license', base64: true });
  assert.equal(r[0].licence.url, 'https://lic.example/wv');
  assert.equal(r[1].licence.url, 'https://lic.example/pr');
  assert.equal(r[2].url, 'https://cdn.example/master.m3u8');
  assert.equal(r[2].serverCertificate, 'QUJD');
});

test('unwrapper mappings and req_data', () => {
  const one = (u, extra = '') => parseDrmJson(`{"com.widevine.alpha":{"license":{"server_url":"https://l/x","unwrapper":"${u}","unwrapper_params":{"path_data":"p"}${extra}}}}`)[0].licence;
  assert.deepEqual(one('base64').response, { kind: 'base64' });
  assert.deepEqual(one('json').response, { kind: 'json', path: 'p', base64: false });
  assert.deepEqual(one('base64,json').response, { kind: 'json', path: 'p', base64: false, wrapped: true });
  assert.deepEqual(one('json,base64', ',"req_data":"b{SSM}"').body, { kind: 'template', text: 'b{SSM}' });
});

test('bad input: ftp licence dropped, bad JSON gives []', () => {
  assert.deepEqual(parseDrmJson('{"com.widevine.alpha":{"license":{"server_url":"ftp://x/y"}}}'), []);
  assert.deepEqual(parseDrmJson('{bad'), []);
});

test('ClearKey keyids', () => {
  const r = parseDrmJson(`{"org.w3.clearkey":{"license":{"keyids":{"${KID}":"${KEY}"}}}}`);
  assert.deepEqual(r[0].licence, { keys: [{ kid: KID, key: KEY }] });
});

function entry(lines, url = 'https://cdn.example/a.mpd') {
  return parseM3u(`#EXTM3U\n#EXTINF:-1 tvg-id="a",A\n${lines.join('\n')}\n${url}\n`).channels[0];
}

test('M3U: JSON line gives systems; an older form only adds what is missing', () => {
  const ch = entry([`#KODIPROP:inputstream.adaptive.drm=${JSON_LINE}`, '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha', '#KODIPROP:inputstream.adaptive.license_key=https://old.example/wv']);
  assert.deepEqual(ch.drm.systems.map((s) => s.system), ['widevine', 'playready', 'fairplay']);
  assert.equal(ch.drm.systems[0].licence.url, 'https://lic.example/wv');
  const more = entry(['#KODIPROP:inputstream.adaptive.drm={"com.microsoft.playready":{"license":{"server_url":"https://l/pr"}}}', '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha', '#KODIPROP:inputstream.adaptive.license_key=https://old.example/wv']);
  assert.deepEqual(more.drm.systems.map((s) => s.system), ['playready', 'widevine']);
});

test('M3U: an older single system is a one-entry list; plain is null', () => {
  const ch = entry(['#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha', '#KODIPROP:inputstream.adaptive.license_key=https://old.example/wv']);
  assert.equal(ch.drm.systems.length, 1);
  assert.equal(ch.drm.systems[0].system, 'widevine');
  assert.equal(entry([]).drm, null);
});

test('M3U: atomix.app_url is https only', () => {
  assert.equal(entry(['#KODIPROP:atomix.app_url=http://x.example']).appUrl, undefined);
  const ch = entry(['#KODIPROP:atomix.app_url=https://x.example', '#KODIPROP:atomix.app_name=X Plus']);
  assert.equal(ch.appUrl, 'https://x.example');
  assert.equal(ch.appName, 'X Plus');
});

let srv;
before(async () => {
  const text = `#EXTM3U\n#EXTINF:-1 tvg-id="m",Multi\n#KODIPROP:inputstream.adaptive.drm=${JSON_LINE}\nhttps://cdn.example/multi.mpd\n#EXTINF:-1 tvg-id="s",Single\n#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha\n#KODIPROP:inputstream.adaptive.license_key=https://old.example/wv\nhttps://cdn.example/single.mpd\n`;
  srv = await fakeServer((req, res) => { res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }); res.end(text); });
});
after(() => srv.close());

function plugin() {
  let source;
  const storage = new Map();
  setup({
    id: 'iptv-simple', version: '0.17.0',
    config: { playlist: `${srv.url}/list.m3u`, guide: '', userAgent: '', refreshHours: '6', numbering: 'playlist', startNumber: 1, guideShift: 0, logosPath: '', maxStreams: 'auto', catchupDays: 7 },
    HttpError: class extends Error {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get: (k, d = null) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v), delete: (k) => storage.delete(k) },
    fetch: (...a) => fetch(...a), fetchFollowing, redactUrl, isPrivateTarget, onConfigChange() {},
    registerLiveSource(s) { source = s; },
  });
  return source;
}

test('plugin reports names in order and stream({system}) picks that system', async () => {
  const source = plugin();
  const r = await source.refresh({ signal: AbortSignal.timeout(10000), log: { info() {}, warn() {} } });
  const m = r.channels.find((c) => c.name === 'Multi');
  assert.deepEqual(m.drmSystems, ['widevine', 'playready', 'fairplay']);
  assert.equal(m.drm, 'widevine', 'core still takes one name until Task 2');
  assert.ok(!JSON.stringify(r.channels).includes('lic.example'));
  const first = await source.stream(m.key);
  assert.equal(first.drm.system, 'widevine');
  assert.equal(first.url, 'https://cdn.example/multi.mpd');
  assert.equal(first.drm.licence.url, 'https://lic.example/wv');
  const fp = await source.stream(m.key, { system: 'fairplay' });
  assert.equal(fp.url, 'https://cdn.example/master.m3u8');
  assert.equal(fp.drm.system, 'fairplay');
  assert.equal(fp.drm.serverCertificate, 'QUJD');
  const pr = await source.stream(m.key, { system: 'playready' });
  assert.equal(pr.url, 'https://cdn.example/multi.mpd');
  const single = r.channels.find((c) => c.name === 'Single');
  assert.deepEqual(single.drmSystems, ['widevine']);
});
