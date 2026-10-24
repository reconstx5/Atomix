// A canned live source for test/live-api.test.js and test/live-stream.test.js. LIVE_TEST_BASE points logos and
// streams at a fake server the test runs; LIVE_TEST_MAX sets the stream limit.
const HALF = 30 * 60_000;

export function setup(api) {
  const base = () => process.env.LIVE_TEST_BASE || 'http://provider.invalid';
  const channels = () => [
    { key: 'one', number: 1, name: 'One', group: ['News'], logo: `${base()}/logo/one.png`, radio: false, guideId: 'one', catchup: { mode: 'shift', days: 2 } },
    { key: 'two', number: 2, name: 'Two', group: ['Kids', 'Movies'], logo: process.env.LIVE_TEST_TWO_LOGO || null, radio: false, guideId: 'two', catchup: null },
    { key: 'three', number: 3, name: 'Three', group: ['Movies'], logo: null, radio: false, guideId: 'three', catchup: null },
    { key: 'radio', number: 4, name: 'Radio Waves', group: ['Radio'], logo: null, radio: true, guideId: 'radio', catchup: null },
    // LIVE_TEST_DRM=1: encrypted DASH channels (test/live-drm*.test.js)
    ...(process.env.LIVE_TEST_DRM
      ? [
          { key: 'five', number: 5, name: 'Five', group: ['Movies'], logo: null, radio: false, guideId: 'five', catchup: { mode: 'shift', days: 2 }, drm: 'clearkey' },
          { key: 'six', number: 6, name: 'Six', group: ['Movies'], logo: null, radio: false, guideId: 'six', catchup: null, drm: 'widevine' },
          { key: 'broken', number: 7, name: 'Broken', group: ['Movies'], logo: null, radio: false, guideId: 'broken', catchup: null, drm: 'widevine' },
        ]
      : []),
    // LIVE_TEST_FPS=1: FairPlay HLS channels (test/live-drm-hls.test.js)
    ...(process.env.LIVE_TEST_FPS
      ? [
          { key: 'eight', number: 8, name: 'Eight', group: ['Movies'], logo: null, radio: false, guideId: 'eight', catchup: null, drm: 'fairplay' },
          { key: 'nine', number: 9, name: 'Nine', group: ['Movies'], logo: null, radio: false, guideId: 'nine', catchup: null, drm: 'fairplay' },
          { key: 'nocert', number: 10, name: 'No Cert', group: ['Movies'], logo: null, radio: false, guideId: 'nocert', catchup: null, drm: 'fairplay' },
        ]
      : []),
  ];
  const DRM = {
    five: { url: '/dash/five/live.mpd', drm: { system: 'clearkey', licence: { keys: [{ kid: 'a7e61c373e219033c21091fa607bf3b8', key: '76a6c65c5ea762046bd749a2e632ccbb' }] } } },
    six: { url: '/dash/six/live.mpd', drm: { system: 'widevine', licence: { url: '/lic/six', headers: { 'X-Lic': 'secretlic' }, body: { kind: 'raw' }, response: { kind: 'raw' } } } },
    eight: { url: '/fp/master.m3u8?tok=mansecret', mime: 'application/vnd.apple.mpegurl', drm: { system: 'fairplay', licence: { url: '/lic/fps', headers: { 'X-Key': 'abc' }, body: { kind: 'template', text: 'spc=b{SSM}&id={CONTENTID}' }, response: { kind: 'base64' } }, serverCertificate: '/fps/cert.der' } },
    nine: { url: '/fp/master.m3u8', mime: 'application/vnd.apple.mpegurl', drm: { system: 'fairplay', licence: { url: '/lic/fps', headers: {}, body: { kind: 'raw' }, response: { kind: 'raw' } }, serverCertificate: Buffer.from('CERT-NINE').toString('base64') } },
    nocert: { url: '/fp/master.m3u8', mime: 'application/vnd.apple.mpegurl', drm: { system: 'fairplay', licence: { url: '/lic/fps', headers: {}, body: { kind: 'raw' }, response: { kind: 'raw' } } } },
    broken: { url: '/dash/broken.mpd', drm: { system: 'widevine', licence: { url: '/lic/six', headers: {}, body: { kind: 'raw' }, response: { kind: 'raw' } } } },
  };
  api.registerLiveSource({
    id: 'canned',
    name: 'Canned',
    async refresh() {
      const at = Math.floor(Date.now() / HALF) * HALF;
      const programmes = [];
      for (const c of channels()) {
        for (let i = -6; i < 24; i++) {
          programmes.push({ guideId: c.guideId, start: at + i * HALF, end: at + (i + 1) * HALF, title: `${c.name} ${i}`, description: `About ${c.name} ${i}`, categories: ['Test'], image: i === 0 ? `${base()}/img/${c.key}.jpg` : undefined });
        }
      }
      return { channels: channels(), programmes };
    },
    async stream(key) {
      if (DRM[key]) {
        const d = DRM[key];
        const licence = d.drm.licence.url ? { ...d.drm.licence, url: `${base()}${d.drm.licence.url}` } : d.drm.licence;
        const cert = d.drm.serverCertificate?.startsWith('/') ? `${base()}${d.drm.serverCertificate}` : d.drm.serverCertificate;
        return { url: `${base()}${d.url}`, headers: { 'X-Token': 'hdrsecret' }, mime: d.mime || 'application/dash+xml', drm: { system: d.drm.system, licence, ...(cert ? { serverCertificate: cert } : {}) }, manifestHeaders: { 'X-Manifest': 'mansecret' } };
      }
      const path = { one: '/live/u/secretpw/1.ts', two: '/live/u/secretpw/2.ts', three: '/dead/3.ts', radio: '/radio/4.aac' }[key];
      if (!path) throw new api.HttpError(404, 'This channel no longer exists.');
      if (key === 'one' && process.env.LIVE_TEST_ONE_URL) return { url: process.env.LIVE_TEST_ONE_URL, headers: {} };
      return { url: `${base()}${path}`, headers: { 'X-Token': 'hdrsecret' } };
    },
    async catchup(key, programme, { from = 0 }) {
      return { url: `${base()}/timeshift/u/secretpw/${Math.floor(programme.start / 1000) + from}/1.ts`, headers: { 'X-Token': 'hdrsecret' }, duration: (programme.end - programme.start) / 1000 - from };
    },
    settingsSummary: () => '4 channels in 4 groups',
    imageRoots: () => (process.env.LIVE_TEST_ROOT ? [process.env.LIVE_TEST_ROOT] : []),
    maxStreams: () => Number(process.env.LIVE_TEST_MAX || Infinity),
  });
}
