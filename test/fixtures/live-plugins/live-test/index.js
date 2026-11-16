// A canned live source for test/live-api.test.js and test/live-stream.test.js. LIVE_TEST_BASE points logos and
// streams at a fake server the test runs; LIVE_TEST_MAX sets the stream limit.
const HALF = 30 * 60_000;

// The playlist's init_data for a PlayReady entry (base64): a pssh box ('pssh') or a bare PlayReady Object ('pro')
// naming the provider's licence server, or bytes that are neither ('bad').
function prInitData(kind, licence) {
  if (kind === 'bad') return Buffer.from('not a playready header').toString('base64');
  const xml = Buffer.from(`<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><KID>AAAA</KID><LA_URL>${licence}</LA_URL></DATA></WRMHEADER>`, 'utf16le');
  const head = Buffer.alloc(10);
  head.writeUInt32LE(10 + xml.length, 0);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 6);
  head.writeUInt16LE(xml.length, 8);
  const pro = Buffer.concat([head, xml]);
  if (kind === 'pro') return pro.toString('base64');
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32 + pro.length, 0);
  box.write('pssh', 4);
  Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex').copy(box, 12);
  box.writeUInt32BE(pro.length, 28);
  return Buffer.concat([box, pro]).toString('base64');
}

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
    // LIVE_TEST_MULTI=1: several key systems, provider links (test/live-multi-drm-api.test.js)
    ...(process.env.LIVE_TEST_MULTI
      ? [
          { key: 'm-both', number: 11, name: 'Both', group: ['Movies'], logo: null, radio: false, guideId: 'm-both', catchup: null, drm: 'widevine', drmSystems: ['widevine', 'playready'], appUrl: process.env.LIVE_TEST_APP_URL || 'https://provider.example/app', appName: 'Provider' },
          { key: 'm-one', number: 12, name: 'Solo', group: ['Movies'], logo: null, radio: false, guideId: 'm-one', catchup: null, drm: 'widevine' },
          { key: 'm-junk', number: 13, name: 'Junk', group: ['Movies'], logo: null, radio: false, guideId: 'm-junk', catchup: null, drmSystems: ['playready', 'bogus', 'playready'] },
          { key: 'm-tvnz', number: 14, name: 'TVNZ 2', group: ['Movies'], logo: null, radio: false, guideId: 'm-tvnz', catchup: null, drm: 'widevine', drmSystems: ['widevine'] },
          { key: 'm-kids', number: 15, name: 'TVNZ DUKE', group: ['Kids'], logo: null, radio: false, guideId: 'm-kids', catchup: null, drm: 'widevine', drmSystems: ['widevine'] },
        ]
      : []),
    // LIVE_TEST_MULTIPLAY=1: multi-system channels that play (test/live-multi-drm.test.js); stream(key, { system })
    // answers the asked system's entry, else the first (as plugins/iptv-simple does). 'Liar' names ClearKey but only
    // ever answers Widevine.
    ...(process.env.LIVE_TEST_MULTIPLAY
      ? [
          { key: 'mp-trio', number: 21, name: 'Trio', group: ['Movies'], logo: null, radio: false, guideId: 'mp-trio', catchup: null, drm: 'widevine', drmSystems: ['widevine', 'playready', 'clearkey'] },
          { key: 'mp-duo', number: 22, name: 'Duo', group: ['Movies'], logo: null, radio: false, guideId: 'mp-duo', catchup: null, drm: 'widevine', drmSystems: ['widevine', 'playready'] },
          { key: 'mp-pr', number: 23, name: 'Ready', group: ['Movies'], logo: null, radio: false, guideId: 'mp-pr', catchup: null, drm: 'playready', drmSystems: ['playready'] },
          { key: 'mp-pr-pro', number: 25, name: 'Ready Pro', group: ['Movies'], logo: null, radio: false, guideId: 'mp-pr-pro', catchup: null, drm: 'playready', drmSystems: ['playready'] },
          { key: 'mp-pr-bad', number: 26, name: 'Ready Bad', group: ['Movies'], logo: null, radio: false, guideId: 'mp-pr-bad', catchup: null, drm: 'playready', drmSystems: ['playready'] },
          { key: 'mp-liar', number: 24, name: 'Liar', group: ['Movies'], logo: null, radio: false, guideId: 'mp-liar', catchup: null, drm: 'widevine', drmSystems: ['widevine', 'clearkey'] },
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
  const WV = { system: 'widevine', licence: { url: '/lic/wv', headers: { 'X-WV': 'wvsecret' }, body: { kind: 'raw' }, response: { kind: 'raw' } } };
  const PR = { system: 'playready', licence: { url: '/lic/pr', headers: { 'X-PR': 'prsecret' }, body: { kind: 'raw' }, response: { kind: 'raw' } } };
  const CK = { system: 'clearkey', licence: { keys: [{ kid: 'a7e61c373e219033c21091fa607bf3b8', key: '76a6c65c5ea762046bd749a2e632ccbb' }] } };
  const MULTI = {
    'mp-trio': { url: '/dash/trio.mpd', systems: [WV, PR, { ...CK, url: '/dash/trio-ck.mpd' }] },
    'mp-duo': { url: '/dash/duo.mpd', systems: [WV, PR] },
    'mp-pr': { url: '/dash/ready.mpd', systems: [{ ...PR, initData: 'pssh' }] },
    'mp-pr-pro': { url: '/dash/ready.mpd', systems: [{ ...PR, initData: 'pro' }] },
    'mp-pr-bad': { url: '/dash/ready.mpd', systems: [{ ...PR, initData: 'bad' }] },
    'mp-liar': { url: '/dash/liar.mpd', systems: [WV] },
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
    async stream(key, opts = {}) {
      if (MULTI[key]) {
        const m = MULTI[key];
        const pick = m.systems.find((x) => x.system === opts?.system) || m.systems[0];
        const licence = pick.licence.url ? { ...pick.licence, url: `${base()}${pick.licence.url}` } : pick.licence;
        const initData = pick.initData ? prInitData(pick.initData, `${base()}/lic/pr?prsecret=1`) : undefined;
        return { url: `${base()}${pick.url || m.url}`, headers: { 'X-Token': 'hdrsecret' }, mime: 'application/dash+xml', drm: { system: pick.system, licence, ...(initData ? { initData } : {}) }, manifestHeaders: { 'X-Manifest': 'mansecret' } };
      }
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
