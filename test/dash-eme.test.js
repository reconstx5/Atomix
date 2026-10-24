// The DASH player's key handling (public/js/dash/eme.js): what to ask the browser's key system for, the init data
// for each protection entry, and the sentences a failed licence or key becomes. The browser part (setupKeys) is
// checked in a real browser by live-ui.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keySystemConfigs, initDataFor, licenceError, keyStatusError, setupKeys, restrictedKids } from '../public/js/dash/eme.js';
import { sentenceOf } from '../public/js/dash/player.js';

const KID = 'a7e61c373e219033c21091fa607bf3b8';
const WV = 'com.widevine.alpha';
const CK = 'org.w3.clearkey';
const PSSH = Buffer.from('00000020707373680000000000000000000000000000000000000000000000000000', 'hex').toString('base64');

test('keySystemConfigs: Widevine with software robustness; ClearKey without; codecs listed once', () => {
  const tracks = { video: [{ mimeType: 'video/mp4', codecs: 'avc1.4d401f' }, { mimeType: 'video/mp4', codecs: 'avc1.4d401f' }], audio: [{ mimeType: 'audio/mp4', codecs: 'mp4a.40.2' }] };
  assert.deepEqual(keySystemConfigs(WV, tracks), [
    {
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.4d401f"', robustness: 'SW_SECURE_CRYPTO' }],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' }],
      persistentState: 'optional',
      distinctiveIdentifier: 'optional',
      sessionTypes: ['temporary'],
    },
  ]);
  const ck = keySystemConfigs(CK, tracks)[0];
  assert.deepEqual(ck.initDataTypes, ['keyids', 'cenc']);
  assert.deepEqual(ck.videoCapabilities, [{ contentType: 'video/mp4; codecs="avc1.4d401f"' }]);
});

test('initDataFor: Widevine uses each distinct pssh; ClearKey asks by key id; none leaves it to the encrypted event', () => {
  const wv = initDataFor(WV, [{ system: 'widevine', pssh: PSSH }, { system: 'widevine', pssh: PSSH }, { system: 'cenc', kid: KID }]);
  assert.equal(wv.length, 1);
  assert.equal(wv[0].initDataType, 'cenc');
  assert.deepEqual(Buffer.from(wv[0].initData), Buffer.from(PSSH, 'base64'));
  const ck = initDataFor(CK, [{ system: 'cenc', kid: KID }]);
  assert.equal(ck[0].initDataType, 'keyids');
  assert.deepEqual(JSON.parse(Buffer.from(ck[0].initData).toString()), { kids: ['p-YcNz4hkDPCEJH6YHvzuA'] });
  assert.deepEqual(initDataFor(WV, [{ system: 'cenc', kid: KID }]), []);
  assert.deepEqual(initDataFor(CK, []), []);
});

test('licenceError and keyStatusError: the sentences', () => {
  assert.equal(licenceError(403, "The provider refused this channel's licence"), "The provider refused this channel's licence");
  assert.equal(licenceError(403, "The playlist doesn't have the key for this channel"), "The playlist doesn't have the key for this channel");
  assert.equal(licenceError(403), "The provider refused this channel's licence");
  assert.equal(licenceError(502), "The licence server isn't answering");
  assert.equal(licenceError(0), "The licence server isn't answering");
  assert.equal(keyStatusError(new Map([['k', 'output-restricted']])), "This channel's protection won't play in this browser");
  assert.equal(keyStatusError(new Map([['k', 'internal-error']])), "This channel's protection won't play in this browser");
  assert.equal(keyStatusError(new Map([['k', 'usable']])), null);
});

test('keyStatusError fails only when no key is usable (an L3 browser restricting the HD keys still plays SD)', () => {
  assert.equal(keyStatusError(new Map([['hd', 'output-restricted'], ['sd', 'usable']])), null);
  assert.equal(keyStatusError(new Map([['hd', 'output-restricted'], ['sd', 'internal-error']])), "This channel's protection won't play in this browser");
  assert.equal(keyStatusError(new Map([['k', 'status-pending']])), null, 'still deciding');
  assert.equal(keyStatusError(new Map()), null);
});

// A pretend key system for setupKeys: sessions log what happens; closing and detaching keys take a while.
function fakeEme(log, { closeMs = 0, setMs = 0 } = {}) {
  class Session extends EventTarget {
    keyStatuses = new Map();
    async generateRequest(type) {
      log.push(`request ${type}`);
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { message: new Uint8Array([1]).buffer })), 0);
    }
    async update() {
      log.push('update');
    }
    async close() {
      await new Promise((r) => setTimeout(r, closeMs));
      log.push('close');
    }
  }
  let n = 0;
  Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async () => ({ createMediaKeys: async () => ({ name: `keys${++n}`, createSession: () => new Session(), setServerCertificate: async (c) => (log.push(`certificate ${new Uint8Array(c).length}`), true) }) }),
  });
  const video = new EventTarget();
  video.setMediaKeys = async (k) => {
    await new Promise((r) => setTimeout(r, k ? 0 : setMs));
    log.push(`setMediaKeys ${k ? k.name : 'null'}`);
  };
  const fetch = async () => (log.push('licence'), new Response(new Uint8Array([9]), { status: 200 }));
  return { video, fetch };
}

test('setupKeys: the init segment\'s "encrypted" event opens no second session when the manifest already gave the key system its data', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  const keys = await setupKeys(video, { keySystem: WV, licenceUrl: '/lic', contentProtection: [{ system: 'widevine', pssh: PSSH }], fetch });
  video.dispatchEvent(Object.assign(new Event('encrypted'), { initDataType: 'cenc', initData: new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]).buffer }));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.filter((l) => l.startsWith('request')), ['request cenc'], JSON.stringify(log));
  await keys.close();
});

test('setupKeys waits for the previous channel\'s keys to be released before attaching new ones (quick zaps)', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log, { closeMs: 30, setMs: 30 });
  const first = await setupKeys(video, { keySystem: CK, licenceUrl: '/lic', contentProtection: [{ system: 'cenc', kid: KID }], fetch });
  first.close(); // not awaited, as when the player view zaps
  const second = await setupKeys(video, { keySystem: CK, licenceUrl: '/lic', contentProtection: [{ system: 'cenc', kid: KID }], fetch });
  const sets = log.filter((l) => l.startsWith('setMediaKeys'));
  assert.deepEqual(sets, ['setMediaKeys keys1', 'setMediaKeys null', 'setMediaKeys keys2'], JSON.stringify(log));
  await second.close();
});

test('licence 404 is unreadable and 401 names sign-in', () => {
  assert.equal(licenceError(404), "This channel's stream couldn't be read");
  assert.equal(licenceError(401), 'Your sign-in has expired — sign in again');
  assert.equal(sentenceOf('Your sign-in has expired — sign in again'), 'Your sign-in has expired — sign in again');
});

test('the server certificate is set before the first licence request', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  const keys = await setupKeys(video, { keySystem: WV, licenceUrl: '/lic', contentProtection: [{ system: 'widevine', pssh: PSSH }], serverCertificate: btoa('CERT'), fetch });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(log.indexOf('certificate 4') >= 0 && log.indexOf('certificate 4') < log.indexOf('licence'), JSON.stringify(log));
  await keys.close();
});

test("the playlist's init data opens a session when the manifest carries none", async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  const keys = await setupKeys(video, { keySystem: WV, licenceUrl: '/lic', contentProtection: [{ system: 'widevine' }], initData: PSSH, fetch });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.filter((l) => l.startsWith('request')), ['request cenc']);
  video.dispatchEvent(Object.assign(new Event('encrypted'), { initDataType: 'cenc', initData: new Uint8Array([0, 0, 0, 8, 1, 2, 3, 4]).buffer }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(log.filter((l) => l.startsWith('request')).length, 1, 'no second session from the init segment');
  await keys.close();
});

test("the manifest's init data wins over the playlist's", async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  const keys = await setupKeys(video, { keySystem: WV, licenceUrl: '/lic', contentProtection: [{ system: 'widevine', pssh: PSSH }], initData: btoa('other'), fetch });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(log.filter((l) => l.startsWith('request')).length, 1);
  await keys.close();
});

test('closing detaches the keys from the video before closing the sessions (a plain stream may load next)', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log, { closeMs: 20 });
  const keys = await setupKeys(video, { keySystem: CK, licenceUrl: '/lic', contentProtection: [{ system: 'cenc', kid: KID }], fetch });
  await new Promise((r) => setTimeout(r, 10));
  await keys.close();
  const tail = log.filter((l) => l === 'close' || l === 'setMediaKeys null');
  assert.deepEqual(tail, ['setMediaKeys null', 'close'], JSON.stringify(log));
});

test('a player stopped while its keys were being set up never attaches them', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  let stale = false;
  const p = setupKeys(video, { keySystem: CK, licenceUrl: '/lic', contentProtection: [{ system: 'cenc', kid: KID }], fetch, isStale: () => stale });
  stale = true; // the viewer zapped to a plain channel meanwhile
  await assert.rejects(p);
  assert.ok(!log.some((l) => l.startsWith('setMediaKeys keys')), JSON.stringify(log));
});

test('a server certificate the key system refuses fails before the keys are attached, without a retry sentence', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  const real = navigator.requestMediaKeySystemAccess;
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', { configurable: true, value: async (...a) => { const acc = await real(...a); return { createMediaKeys: async () => ({ ...(await acc.createMediaKeys()), setServerCertificate: async () => { throw new Error('bad cert'); } }) }; } });
  await assert.rejects(setupKeys(video, { keySystem: WV, licenceUrl: '/lic', contentProtection: [{ system: 'widevine', pssh: PSSH }], serverCertificate: btoa('BAD'), fetch }), /won't play in this browser/);
  assert.ok(!log.some((l) => l.startsWith('setMediaKeys keys')), JSON.stringify(log));
});

// v0.27 Plan B: the keys a phone refuses (HD behind output protection) while another key still plays.
const KID_HD = '11111111111111111111111111111111';
const KID_SD = '22222222222222222222222222222222';
const KID_4K = '33333333333333333333333333333333';
const hexBytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex')).buffer;

test('restrictedKids: the keys a phone refuses, as hex', () => {
  const st = new Map([[hexBytes(KID_HD), 'output-restricted'], [hexBytes(KID_SD), 'usable'], [hexBytes(KID_4K), 'usable-in-future']]);
  assert.deepEqual(restrictedKids(st).sort(), [KID_HD, KID_4K].sort());
  assert.deepEqual(restrictedKids(new Map([[hexBytes(KID_SD), 'usable']])), []);
});

test('setupKeys tells onRestricted which keys are refused while another is usable', async () => {
  const log = [];
  const { video, fetch } = fakeEme(log);
  const restricted = [];
  const errors = [];
  let session;
  const orig = navigator.requestMediaKeySystemAccess;
  Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async (...a) => {
      const access = await orig(...a);
      return { createMediaKeys: async () => { const k = await access.createMediaKeys(); const make = k.createSession; k.createSession = () => (session = make()); return k; } };
    },
  });
  const keys = await setupKeys(video, { keySystem: CK, licenceUrl: '/lic', contentProtection: [{ system: 'cenc', kid: KID_SD }], fetch, onRestricted: (k) => restricted.push(k), onError: (e) => errors.push(e) });
  session.keyStatuses = new Map([[hexBytes(KID_HD), 'output-restricted'], [hexBytes(KID_SD), 'usable']]);
  session.dispatchEvent(new Event('keystatuseschange'));
  assert.deepEqual(restricted, [[KID_HD]]);
  session.keyStatuses = new Map([[hexBytes(KID_SD), 'usable']]);
  session.dispatchEvent(new Event('keystatuseschange'));
  assert.equal(restricted.length, 1, 'nothing refused: no call');
  assert.deepEqual(errors, []);
  await keys.close();
});
