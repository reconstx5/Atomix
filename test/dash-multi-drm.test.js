// v0.28 multi-DRM in the browser (public/js/dash/): PlayReady's key system configurations and init data, the key
// systems this device has (in its own order of preference), and the pre-check for a channel offering several.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keySystemConfigs, initDataFor, setupKeys, NEED_SECURE, NO_WIDEVINE_IPHONE, NO_COMMON_SYSTEM, NO_PROTECTION_IOS, PLAYREADY, PLAYREADY_PLAIN } from '../public/js/dash/eme.js';
import { deviceKeySystems, protectionVerdict, sendsKeySystems, probeKeySystem } from '../public/js/dash/support.js';
import { parseMpd } from '../public/js/dash/mpd.js';
import { sentenceOf } from '../public/js/dash/player.js';

const PR_ID = '9a04f07998404286ab92e65be0885f95';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const EDGE_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const all = async () => true;

test('the sentences, verbatim', () => {
  assert.equal(NO_COMMON_SYSTEM, "This browser can't play any of this channel's protections.");
  assert.equal(NO_PROTECTION_IOS, "This channel's protection doesn't play on iPhone or iPad.");
  assert.equal(PLAYREADY, 'com.microsoft.playready.recommendation');
  assert.equal(PLAYREADY_PLAIN, 'com.microsoft.playready');
  assert.equal(sentenceOf(new Error(NO_COMMON_SYSTEM)), NO_COMMON_SYSTEM);
  assert.equal(sentenceOf(new Error(NO_PROTECTION_IOS)), NO_PROTECTION_IOS);
});

test('keySystemConfigs: PlayReady asks hardware (3000) then software (2000) video, as two configurations; audio software (2000) in both', () => {
  const tracks = { video: [{ mimeType: 'video/mp4', codecs: 'avc1.4d401f' }], audio: [{ mimeType: 'audio/mp4', codecs: 'mp4a.40.2' }] };
  for (const ks of [PLAYREADY, PLAYREADY_PLAIN]) {
    const configs = keySystemConfigs(ks, tracks);
    assert.equal(configs.length, 2);
    assert.deepEqual(
      configs.map((c) => c.videoCapabilities[0].robustness),
      ['3000', '2000'],
    );
    assert.deepEqual(
      configs.map((c) => c.audioCapabilities[0].robustness),
      ['2000', '2000'],
      'PlayReady audio is software-decrypted on every device (3000 audio is refused)',
    );
    for (const c of configs) {
      assert.deepEqual(c.initDataTypes, ['cenc']);
      assert.equal(c.videoCapabilities[0].contentType, 'video/mp4; codecs="avc1.4d401f"');
      assert.deepEqual(c.sessionTypes, ['temporary']);
    }
  }
  assert.equal(keySystemConfigs('com.widevine.alpha', tracks).length, 1, 'Widevine unchanged');
});

const box = (u8) => Buffer.from(u8);
test('initDataFor: PlayReady uses its own pssh, else a PSSH built from mspr:pro; never Widevine\'s', () => {
  const wvPssh = Buffer.from('00000020707373680000000000000000000000000000000000000000000000000000', 'hex').toString('base64');
  const prPssh = Buffer.from(`00000024707373680000000${'0'}${PR_ID}00000004deadbeef`, 'hex').toString('base64');
  const fromPssh = initDataFor(PLAYREADY, [
    { system: 'widevine', pssh: wvPssh },
    { system: 'playready', pssh: prPssh, pro: 'AAAA' },
    { system: 'playready', pssh: prPssh },
  ]);
  assert.equal(fromPssh.length, 1);
  assert.equal(fromPssh[0].initDataType, 'cenc');
  assert.equal(box(fromPssh[0].initData).toString('base64'), prPssh);

  const pro = Buffer.from('PlayReadyHeaderObject').toString('base64');
  const built = initDataFor(PLAYREADY_PLAIN, [{ system: 'playready', pro }, { system: 'playready', pro }, { system: 'cenc', kid: 'a7e61c373e219033c21091fa607bf3b8' }]);
  assert.equal(built.length, 1);
  const b = box(built[0].initData);
  const proBytes = Buffer.from(pro, 'base64');
  assert.equal(b.readUInt32BE(0), b.length);
  assert.equal(b.length, 32 + proBytes.length);
  assert.equal(b.subarray(4, 8).toString('latin1'), 'pssh');
  assert.equal(b.readUInt32BE(8), 0, 'version 0, no flags');
  assert.equal(b.subarray(12, 28).toString('hex'), PR_ID);
  assert.equal(b.readUInt32BE(28), proBytes.length);
  assert.ok(b.subarray(32).equals(proBytes));

  assert.deepEqual(initDataFor(PLAYREADY, [{ system: 'widevine', pssh: wvPssh }, { system: 'cenc', kid: 'ab' }]), [], 'the encrypted event supplies it');
});

test('parseMpd reads mspr:pro and the PlayReady system id', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" xmlns:mspr="urn:microsoft:playready" type="static" mediaPresentationDuration="PT10S">
  <Period><AdaptationSet contentType="video" mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="a7e61c37-3e21-9033-c210-91fa607bf3b8"/>
    <ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95"><mspr:pro>UFJP</mspr:pro><cenc:pssh>UFNTSA==</cenc:pssh></ContentProtection>
    <SegmentTemplate media="$Number$.m4s" initialization="init.mp4" duration="2" timescale="1"/>
    <Representation id="v" bandwidth="1" codecs="avc1.4d401f"/>
  </AdaptationSet></Period>
</MPD>`;
  const cp = parseMpd(mpd, 'https://x/m.mpd').periods[0].adaptationSets[0].contentProtection;
  const pr = cp.find((c) => c.system === 'playready');
  assert.equal(pr.pro, 'UFJP');
  assert.equal(pr.pssh, 'UFNTSA==');
  assert.equal(cp[0].pro, null);
});

test('deviceKeySystems: each browser\'s order of preference, filtered by the probe', async () => {
  assert.deepEqual(await deviceKeySystems({ ua: SAFARI, secure: true, probe: all }), ['fairplay', 'clearkey']);
  assert.deepEqual(await deviceKeySystems({ ua: EDGE_WIN, secure: true, probe: all }), ['playready', 'widevine', 'clearkey']);
  assert.deepEqual(await deviceKeySystems({ ua: EDGE_MAC, secure: true, probe: all }), ['widevine', 'playready', 'clearkey'], 'Edge elsewhere: like Chrome');
  assert.deepEqual(await deviceKeySystems({ ua: CHROME, secure: true, probe: all }), ['widevine', 'playready', 'clearkey']);
  // Headless Chromium: ClearKey only.
  assert.deepEqual(await deviceKeySystems({ ua: CHROME, secure: true, probe: async (k) => k === 'org.w3.clearkey' }), ['clearkey']);
  // PlayReady answered under its plain name only.
  assert.deepEqual(await deviceKeySystems({ ua: EDGE_WIN, secure: true, probe: async (k) => k === PLAYREADY_PLAIN }), ['playready']);
  // A probe that fails counts as "doesn't have it".
  assert.deepEqual(await deviceKeySystems({ ua: CHROME, secure: true, probe: async (k) => (k === 'com.widevine.alpha' ? Promise.reject(new Error('x')) : true) }), ['playready', 'clearkey']);
});

test('deviceKeySystems: the probe is asked for EME names, only on a secure page; iPhones known without asking', async () => {
  const asked = [];
  const probe = async (k) => (asked.push(k), true);
  assert.deepEqual(await deviceKeySystems({ ua: CHROME, secure: false, probe }), []);
  assert.deepEqual(asked, [], 'a plain-http page probes nothing');
  await deviceKeySystems({ ua: CHROME, secure: true, probe });
  assert.deepEqual(asked, ['com.widevine.alpha', PLAYREADY, 'org.w3.clearkey']);
  asked.length = 0;
  assert.deepEqual(await deviceKeySystems({ ua: IPHONE, secure: true, probe }), ['fairplay', 'clearkey']);
  assert.deepEqual(await deviceKeySystems({ ua: IPHONE, secure: false, probe }), ['fairplay', 'clearkey']);
  assert.deepEqual(asked, []);
});

test('protectionVerdict for a list: null when any is on the device, else the sentence for the best one to explain', async () => {
  const chrome = { ua: CHROME, secure: true, ios: false, probe: all };
  const iphone = { ua: IPHONE, secure: true, ios: true, probe: all };
  assert.equal(await protectionVerdict(['fairplay', 'widevine'], chrome), null);
  assert.equal(await protectionVerdict(['fairplay'], chrome), NO_COMMON_SYSTEM);
  assert.equal(await protectionVerdict(['widevine', 'playready'], { ...chrome, probe: async (k) => k === 'org.w3.clearkey' }), NO_COMMON_SYSTEM);
  assert.equal(await protectionVerdict(['widevine', 'clearkey'], { ...chrome, probe: async (k) => k === 'org.w3.clearkey' }), null);
  assert.equal(await protectionVerdict(['widevine', 'playready'], { ...chrome, secure: false }), NEED_SECURE, 'plain-http page: the secure address first');
  assert.equal(await protectionVerdict(['widevine'], iphone), NO_WIDEVINE_IPHONE);
  assert.equal(await protectionVerdict(['playready', 'widevine'], iphone), NO_WIDEVINE_IPHONE);
  assert.equal(await protectionVerdict(['playready'], iphone), NO_PROTECTION_IOS);
  assert.equal(await protectionVerdict(['widevine', 'fairplay'], iphone), null);
  assert.equal(await protectionVerdict(['clearkey'], iphone), null);
  assert.equal(await protectionVerdict(['fairplay'], { ...iphone, secure: false }), NEED_SECURE);
  assert.equal(await protectionVerdict(['playready'], { ...iphone, secure: false }), NO_PROTECTION_IOS, 'the secure address wouldn\'t help');
  assert.equal(await protectionVerdict([], chrome), null);
  // The string form is unchanged.
  assert.equal(await protectionVerdict('widevine', { ios: true, secure: true, probe: all }), NO_WIDEVINE_IPHONE);
  assert.equal(await protectionVerdict('clearkey', { secure: true, probe: async () => false }), null);
});

test('setupKeys: PlayReady falls back to the plain name when .recommendation is refused', async () => {
  const asked = [];
  Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async (ks, configs) => {
      asked.push([ks, configs.map((c) => c.videoCapabilities?.[0]?.robustness)]);
      if (ks === PLAYREADY) throw new Error('NotSupportedError');
      return { createMediaKeys: async () => ({ createSession: () => Object.assign(new EventTarget(), { keyStatuses: new Map(), generateRequest: async () => {}, close: async () => {} }) }) };
    },
  });
  const video = Object.assign(new EventTarget(), { setMediaKeys: async () => {} });
  const tracks = { video: [{ mimeType: 'video/mp4', codecs: 'avc1.4d401f' }] };
  const keys = await setupKeys(video, { keySystem: PLAYREADY, licenceUrl: '/lic', contentProtection: [{ system: 'playready', pro: 'UFJP' }], tracks });
  assert.deepEqual(asked, [
    [PLAYREADY, ['3000', '2000']],
    [PLAYREADY_PLAIN, ['3000', '2000']],
  ]);
  await keys.close();
});

test('sendsKeySystems: only a channel offering several systems (or not yet known) sends the device list', () => {
  assert.equal(sendsKeySystems(['widevine', 'playready']), true);
  assert.equal(sendsKeySystems(undefined), true, 'a direct link: the channel list has not named it');
  // One system: the server's choice is forced; the v0.27 path (no list, no probe) is used.
  assert.equal(sendsKeySystems(['clearkey']), false);
  assert.equal(sendsKeySystems(['playready']), false);
  assert.equal(sendsKeySystems('widevine'), false, 'an older single name');
  assert.equal(sendsKeySystems(null), false, 'a plain channel');
  assert.equal(sendsKeySystems([]), false);
});

test('probeKeySystem: the PlayReady probe asks video 3000 then 2000, audio 2000 in both', async () => {
  const asked = [];
  const real = Object.getOwnPropertyDescriptor(globalThis.navigator, 'requestMediaKeySystemAccess');
  Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', { configurable: true, value: async (ks, configs) => (asked.push([ks, configs]), {}) });
  try {
    assert.equal(await probeKeySystem(PLAYREADY_PLAIN), true);
    const [[ks, configs]] = asked;
    assert.equal(ks, PLAYREADY_PLAIN);
    assert.deepEqual(configs.map((c) => c.videoCapabilities[0].robustness), ['3000', '2000']);
    assert.deepEqual(configs.map((c) => c.audioCapabilities?.[0]?.robustness), ['2000', '2000']);
    for (const c of configs) assert.match(c.audioCapabilities[0].contentType, /^audio\/mp4/);
  } finally {
    if (real) Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', real);
    else delete globalThis.navigator.requestMediaKeySystemAccess;
  }
});
