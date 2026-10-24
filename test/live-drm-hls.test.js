// v0.27 Plan B: FairPlay channels (HLS). The playlists are rewritten so every address goes through Atomix's relay
// (src/live/hls-relay.js), skd:// key ids stay as they are, and the certificate and licence are relayed by LiveDrm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePlaylist, isPlaylist } from '../src/live/hls-relay.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://asset-1",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXT-X-SESSION-DATA:DATA-ID="com.example.title",URI="https://meta.example/title.json"
#EXT-X-CONTENT-STEERING:SERVER-URI="https://steer.example/s.json"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="aud/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="aud"
v720/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200000,URI="v720/iframes.m3u8"
`;

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://asset-1",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="pr://playready/whatever",KEYFORMAT="com.microsoft.playready"
#EXTINF:6.0,
seg100.m4s?tk=abc
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1?tk=abc"
#EXTINF:6.0,
https://cdn.example/fp/v720/seg101.m4s
`;

test('the master playlist: every address through the relay, skd:// kept, no provider host left', () => {
  const s = { id: 'sid', bases: [] };
  const out = rewritePlaylist(MASTER, 'https://cdn.example/fp/master.m3u8?tok=secret', s);
  assert.doesNotMatch(out, /cdn\.example|tok=secret|https?:\/\//);
  assert.match(out, /^\/api\/live\/drm\/sid\/r\/0\/fp\/v720\/index\.m3u8$/m);
  assert.match(out, /#EXT-X-MEDIA:.*URI="\/api\/live\/drm\/sid\/r\/0\/fp\/aud\/index\.m3u8"/);
  assert.match(out, /#EXT-X-I-FRAME-STREAM-INF:.*URI="\/api\/live\/drm\/sid\/r\/0\/fp\/v720\/iframes\.m3u8"/);
  assert.match(out, /#EXT-X-SESSION-KEY:.*URI="skd:\/\/asset-1"/);
  assert.doesNotMatch(out, /EXT-X-SESSION-DATA|EXT-X-CONTENT-STEERING/);
  assert.deepEqual(s.bases, ['https://cdn.example']);
});

test('a media playlist: segments, EXT-X-MAP and an AES-128 key relayed; skd:// and data: kept; a PlayReady key line dropped', () => {
  const s = { id: 'sid', bases: ['https://cdn.example'] };
  const out = rewritePlaylist(MEDIA, 'https://cdn.example/fp/v720/index.m3u8', s);
  assert.match(out, /#EXT-X-MAP:URI="\/api\/live\/drm\/sid\/r\/0\/fp\/v720\/init\.mp4"/);
  assert.match(out, /^\/api\/live\/drm\/sid\/r\/0\/fp\/v720\/seg100\.m4s\?tk=abc$/m);
  assert.match(out, /^\/api\/live\/drm\/sid\/r\/0\/fp\/v720\/seg101\.m4s$/m);
  assert.match(out, /URI="skd:\/\/asset-1"/);
  assert.match(out, /URI="data:text\/plain;base64,AAAA"/);
  assert.doesNotMatch(out, /playready|pr:\/\//);
  assert.match(out, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/live\/drm\/sid\/r\/1\/k1\?tk=abc"/);
  assert.equal(s.bases[1], 'https://keys.example');
  assert.match(out, /#EXT-X-MEDIA-SEQUENCE:100/);
  assert.doesNotMatch(out, /https?:\/\//);
});

test('media playlists on another host resolve relative paths and keep their query', () => {
  const s = { id: 'sid', bases: ['https://cdn.example'] };
  const out = rewritePlaylist('#EXTM3U\n#EXTINF:6,\n../seg/1.ts?x=1\n', 'https://edge2.example/a/b/index.m3u8', s);
  assert.match(out, /^\/api\/live\/drm\/sid\/r\/1\/a\/seg\/1\.ts\?x=1$/m);
  assert.equal(s.bases[1], 'https://edge2.example');
  // The same origin later keeps its slot.
  const again = rewritePlaylist('#EXTM3U\n#EXTINF:6,\nhttps://cdn.example/z.ts\n', 'https://edge2.example/a/b/index.m3u8', s);
  assert.match(again, /^\/api\/live\/drm\/sid\/r\/0\/z\.ts$/m);
});

test('more than 64 origins is refused; slots are never reused', () => {
  const s = { id: 'sid', bases: [] };
  const many = (from, n) => `#EXTM3U\n${Array.from({ length: n }, (_, i) => `#EXTINF:6,\nhttps://h${from + i}.example/s.ts`).join('\n')}\n`;
  rewritePlaylist(many(0, 40), 'https://h0.example/p.m3u8', s);
  rewritePlaylist(many(40, 24), 'https://h0.example/p.m3u8', s);
  assert.equal(s.bases.length, 64);
  assert.throws(() => rewritePlaylist(many(64, 1), 'https://h0.example/p.m3u8', s));
  assert.equal(s.bases[0], 'https://h0.example', 'an old slot is not handed to a new host');
});

test('not a playlist is refused', () => {
  assert.throws(() => rewritePlaylist('<MPD/>', 'https://x.example/m.m3u8', { id: 's', bases: [] }));
});

test('a playlist without .m3u8 is recognised by its type', () => {
  assert.equal(isPlaylist(new URL('https://x/live?ch=1'), 'application/vnd.apple.mpegurl'), true);
  assert.equal(isPlaylist(new URL('https://x/live?ch=1'), 'audio/mpegurl; charset=utf-8'), true);
  assert.equal(isPlaylist(new URL('https://x/a/index.m3u8?t=1'), null), true);
  assert.equal(isPlaylist(new URL('https://x/seg1.ts'), 'video/mp2t'), false);
});

// ---- Through Atomix: the canned source's FairPlay channels (LIVE_TEST_FPS=1) on a fake provider ----
import { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, fakeServer } from './helpers.js';
import { buildLicenceRequest } from '../src/live/drm.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const SOURCE = 'live-test/canned';
let nf, admin, up, ids;
const seen = [];
let certCalls = 0;
const licenceCalls = [];

before(async () => {
  up = await fakeServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    const other = () => up.url.replace('127.0.0.1', 'localhost');
    if (req.url.startsWith('/fp/master.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://asset-1",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="En",URI="aud/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="a"\nv720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\n${other()}/live/media?q=1\n#EXT-X-STREAM-INF:BANDWIDTH=500000\n/s3/low-media\n`);
    }
    if (req.url === '/fp/v720/index.m3u8' || req.url === '/live/media?q=1') {
      res.writeHead(200, { 'content-type': req.url.includes('m3u8') ? 'application/octet-stream' : 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://asset-1",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\nseg1.m4s?tk=segsecret\n`);
    }
    if (req.url === '/s3/low-media') {
      // Object storage: a playlist with neither .m3u8 nor a playlist type.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${up.url}/s3/seg1.ts\n`);
    }
    if (req.url.startsWith('/fp/v720/seg1.m4s')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end('SEGMENT');
    }
    if (req.url === '/fps/cert.der') {
      certCalls++;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end('CERT-EIGHT');
    }
    if (req.url === '/lic/fps') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      licenceCalls.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(Buffer.concat([Buffer.from('CKC:'), body]).toString('base64'));
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = up.url;
  process.env.LIVE_TEST_FPS = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(SOURCE)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_FPS;
  await nf?.app.stop();
  await up?.close();
});

const stopAll = () => {
  for (const id of [...nf.app.core.live.drm.sessions.keys()]) nf.app.core.live.drm.stop(id, 'test');
};
const play = async (name) => {
  stopAll();
  return admin.post(`/api/live/channels/${ids[name]}/play`, {});
};
const get = (p) => fetch(`${nf.base}${p}`, { headers: { cookie: admin.cookie } });

test('play replies with the master, licence and certificate routes, and no certificate address', async () => {
  const r = await play('Eight');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data;
  assert.equal(s.delivery, 'drm');
  assert.equal(s.keySystem, 'com.apple.fps');
  assert.equal(s.manifest, `/api/live/drm/${s.sessionId}/master.m3u8`);
  assert.equal(s.licence, `/api/live/drm/${s.sessionId}/licence`);
  assert.equal(s.certificate, `/api/live/drm/${s.sessionId}/certificate`);
  assert.equal(s.serverCertificate, null);
  assert.doesNotMatch(JSON.stringify(s), /127\.0\.0\.1|localhost|cert\.der|mansecret/);
});

test('GET master.m3u8 and a media playlist through r/: no provider host, the provider got the manifest headers', async () => {
  const s = (await play('Eight')).data;
  const res = await get(s.manifest);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/vnd\.apple\.mpegurl/);
  const master = await res.text();
  assert.doesNotMatch(master, /127\.0\.0\.1|localhost|mansecret|https?:\/\//);
  assert.match(master, /skd:\/\/asset-1/);
  assert.equal(seen.filter((x) => x.url.startsWith('/fp/master.m3u8')).at(-1).headers['x-manifest'], 'mansecret');
  const variant = master.split('\n').find((l) => l.startsWith(`/api/live/drm/${s.sessionId}/r/`) && l.includes('v720'));
  const media = await (await get(variant)).text();
  assert.doesNotMatch(media, /127\.0\.0\.1|segsecret=|https?:\/\//);
  assert.match(media, /#EXT-X-MAP:URI="\/api\/live\/drm\/[0-9a-f]+\/r\/\d+\/fp\/v720\/init\.mp4"/);
  const seg = media.split('\n').find((l) => l.includes('seg1.m4s'));
  assert.equal(await (await get(seg)).text(), 'SEGMENT');
});

test('a playlist without .m3u8 through r/ is rewritten', async () => {
  const s = (await play('Eight')).data;
  const master = await (await get(s.manifest)).text();
  const line = master.split('\n').find((l) => l.includes('/live/media?q=1'));
  assert.ok(line, master);
  const media = await (await get(line)).text();
  assert.match(media, /^#EXTM3U/);
  assert.doesNotMatch(media, /https?:\/\//);
  assert.match(media, /\/api\/live\/drm\/[0-9a-f]+\/r\/\d+\/live\/seg1\.m4s\?tk=segsecret/);
});

test('the certificate: fetched by Atomix from the playlist address (once), or decoded from base64', async () => {
  const s = (await play('Eight')).data;
  const before = certCalls;
  const a = await get(s.certificate);
  assert.equal(a.status, 200);
  assert.equal(Buffer.from(await a.arrayBuffer()).toString(), 'CERT-EIGHT');
  await get(s.certificate);
  assert.equal(certCalls - before, 1, 'kept on the session');
  const n = (await play('Nine')).data;
  assert.equal(Buffer.from(await (await get(n.certificate)).arrayBuffer()).toString(), 'CERT-NINE');
});

test('the licence: SPC in with ?contentId=asset-1, the playlist form out; the base64 answer back as bytes', async () => {
  const s = (await play('Eight')).data;
  const res = await fetch(`${nf.base}${s.licence}?contentId=asset-1`, { method: 'POST', body: Buffer.from('SPC'), headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream' } });
  assert.equal(res.status, 200);
  const call = licenceCalls.at(-1);
  assert.equal(call.body.toString(), 'spc=U1BD&id=asset-1');
  assert.equal(call.headers['x-key'], 'abc');
  assert.match(call.headers['content-type'], /x-www-form-urlencoded/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'CKC:spc=U1BD&id=asset-1');
});

test("a FairPlay channel without a certificate doesn't start", async () => {
  const r = await play('No Cert');
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "This channel's stream couldn't be read");
  assert.equal(nf.app.core.live.drm.sessions.size, 0);
});

test("the account's 4 streams count FairPlay sessions", async () => {
  stopAll();
  const opened = [];
  for (let i = 0; i < 4; i++) opened.push((await admin.post(`/api/live/channels/${ids[i % 2 ? 'Nine' : 'Eight']}/play`, {})).status);
  assert.deepEqual(opened, [200, 200, 200, 200]);
  const fifth = await admin.post(`/api/live/channels/${ids.Eight}/play`, {});
  assert.equal(fifth.status, 429);
  stopAll();
});

test('buildLicenceRequest fills {CONTENTID}, URL-encoded', () => {
  const { body } = buildLicenceRequest({ body: { kind: 'template', text: 'spc=b{SSM}&id={CONTENTID}' } }, Buffer.from('SPC'), { contentId: 'a b' });
  assert.equal(body.toString(), 'spc=U1BD&id=a%20b');
});

// ---- Final-review fixes ----
test('any URI attribute on any tag is relayed (interstitials, unknown tags); other comment lines are dropped', () => {
  const s = { id: 'sid', bases: [] };
  const out = rewritePlaylist(`#EXTM3U
# made by encoder at https://origin.provider/secret
#EXT-X-DATERANGE:ID="ad1",CLASS="com.apple.hls.interstitial",START-DATE="2026-10-23T00:00:00Z",X-ASSET-URI="https://ads.provider/a.m3u8?tok=SECRET",X-ASSET-LIST="https://ads.provider/list.json"
#EXT-X-FUTURE-THING:FOO-URI="https://other.provider/x?tok=SECRET"
#EXTINF:6,
a.ts
`, 'https://cdn.example/p/index.m3u8', s);
  assert.doesNotMatch(out, /\.provider|https?:\/\//, out); // the query rides along to Atomix, as segments' do
  assert.match(out, /X-ASSET-URI="\/api\/live\/drm\/sid\/r\/\d+\/a\.m3u8\?tok=SECRET"/);
});

test('a $ in an address is copied as it is; only whole URI attributes are matched', () => {
  const s = { id: 'sid', bases: [] };
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?a=$&b=$\'"\n#EXT-X-KEY:METHOD=AES-128,X-FOO-URI="k1",URI="https://keys.provider/k2"\n#EXTINF:6,\na.ts\n', 'https://cdn.example/p/index.m3u8', s);
  assert.match(out, /#EXT-X-MAP:URI="\/api\/live\/drm\/sid\/r\/0\/p\/init\.mp4\?a=\$&b=\$%27"$/m);
  assert.doesNotMatch(out, /https?:\/\//, out);
});

test('a playlist served as application/octet-stream without .m3u8 is still rewritten (recognised by #EXTM3U)', async () => {
  const s = (await play('Eight')).data;
  const master = await (await get(s.manifest)).text();
  const line = master.split('\n').find((l) => l.includes('/s3/low-media'));
  assert.ok(line, master);
  const media = await (await get(line)).text();
  assert.match(media, /^#EXTM3U/);
  assert.doesNotMatch(media, /https?:\/\//, media);
});
