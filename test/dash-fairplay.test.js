// v0.27 Plan B: FairPlay in Safari (public/js/dash/fairplay.js): the certificate before the keys, the licence with the
// skd:// content id, the playlist last. Checked here with a pretend key system; a real iPhone is listed as not yet verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skdContentId, fairPlayConfigs, playFairPlay } from '../public/js/dash/fairplay.js';
import { NO_FAIRPLAY, REFUSED } from '../public/js/dash/eme.js';

const utf16le = (s) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) b[i * 2] = s.charCodeAt(i);
  return b.buffer;
};

test('skdContentId: UTF-8 or UTF-16 init data, with or without skd://', () => {
  assert.equal(skdContentId(new TextEncoder().encode('skd://mock-asset')), 'mock-asset');
  assert.equal(skdContentId(utf16le('skd://mock-asset')), 'mock-asset');
  assert.equal(skdContentId(new TextEncoder().encode('asset-9')), 'asset-9');
});

test('fairPlayConfigs asks for skd init data and HLS', () => {
  const [c] = fairPlayConfigs();
  assert.deepEqual(c.initDataTypes, ['skd']);
  assert.ok(c.videoCapabilities.some((v) => v.contentType === 'application/vnd.apple.mpegurl'));
});

function fakeSafari(log, { licenceStatus = 200, refuse = false } = {}) {
  class Session extends EventTarget {
    async generateRequest(type, data) {
      log.push(`request ${type} ${skdContentId(data)}`);
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { message: new TextEncoder().encode('SPC').buffer })), 0);
    }
    async update(b) {
      log.push(`update ${new TextDecoder().decode(b)}`);
    }
    async close() {
      log.push('close');
    }
  }
  Object.defineProperty(globalThis.navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async (ks) => {
      log.push(`access ${ks}`);
      if (refuse) throw new Error('NotSupportedError');
      return { createMediaKeys: async () => ({ createSession: () => new Session(), setServerCertificate: async (c) => (log.push(`certificate ${new TextDecoder().decode(c)}`), true) }) };
    },
  });
  const video = new EventTarget();
  video.setMediaKeys = async (k) => log.push(`setMediaKeys ${k ? 'keys' : 'null'}`);
  video.removeAttribute = (a) => log.push(`remove ${a}`);
  video.load = () => log.push('load');
  Object.defineProperty(video, 'src', { set: (v) => log.push(`src ${v}`), get: () => '' });
  const fetch = async (url, opts = {}) => {
    log.push(`fetch ${url}`);
    if (url.includes('certificate')) return new Response('CERT', { status: 200 });
    if (licenceStatus !== 200) return new Response(JSON.stringify({ error: REFUSED }), { status: licenceStatus });
    return new Response('CKC', { status: 200 });
  };
  return { video, fetch };
}

test('playFairPlay: the certificate before the keys are attached, the licence with ?contentId=, the playlist last', async () => {
  const log = [];
  const { video, fetch } = fakeSafari(log);
  const player = await playFairPlay(video, { playlist: '/api/live/drm/s/master.m3u8', licence: '/api/live/drm/s/licence', certificate: '/api/live/drm/s/certificate', fetch });
  assert.deepEqual(log.slice(0, 5), ['access com.apple.fps', 'fetch /api/live/drm/s/certificate', 'certificate CERT', 'setMediaKeys keys', 'src /api/live/drm/s/master.m3u8']);
  video.dispatchEvent(Object.assign(new Event('encrypted'), { initDataType: 'skd', initData: new TextEncoder().encode('skd://asset-1').buffer }));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(log.includes('request skd asset-1'), JSON.stringify(log));
  assert.ok(log.includes('fetch /api/live/drm/s/licence?contentId=asset-1'), JSON.stringify(log));
  assert.ok(log.includes('update CKC'));
  await player.close();
  assert.ok(log.includes('remove src') && log.includes('setMediaKeys null') && log.includes('close'), JSON.stringify(log));
});

test('playFairPlay: no FairPlay is NO_FAIRPLAY; a refused licence reaches onError as REFUSED', async () => {
  await assert.rejects(playFairPlay(fakeSafari([], { refuse: true }).video, { playlist: '/p', licence: '/l', certificate: '/c', fetch: fakeSafari([], { refuse: true }).fetch }), { message: NO_FAIRPLAY });
  const log = [];
  const errors = [];
  const { video, fetch } = fakeSafari(log, { licenceStatus: 403 });
  const player = await playFairPlay(video, { playlist: '/p', licence: '/l', certificate: '/certificate', fetch, onError: (e) => errors.push(e) });
  video.dispatchEvent(Object.assign(new Event('encrypted'), { initDataType: 'skd', initData: new TextEncoder().encode('skd://a').buffer }));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(errors, [REFUSED]);
  await player.close();
});

test('playFairPlay stopped while it starts (a quick zap) never attaches keys or sets the playlist', async () => {
  const log = [];
  const { video, fetch } = fakeSafari(log);
  let stale = false;
  const slowFetch = async (url, o) => {
    const r = await fetch(url, o);
    stale = true; // the person zapped away while the certificate was on its way
    return r;
  };
  await assert.rejects(playFairPlay(video, { playlist: '/p', licence: '/l', certificate: '/certificate', fetch: slowFetch, isStale: () => stale }), { message: 'stopped' });
  assert.ok(!log.some((l) => l.startsWith('setMediaKeys') || l.startsWith('src')), JSON.stringify(log));
});
