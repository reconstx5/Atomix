// v0.28 multi-DRM: PlayReady's own headers never carry the provider's licence address to the browser — not in the
// play reply's initData (the playlist's init_data), and not in a relayed init segment's moov/pssh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client } from './helpers.js';
import { multiDrmProvider } from './helpers-live.js';
import { playReadyInitData, rewriteInitSegment } from '../src/live/drm.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const PR_ID = '9a04f07998404286ab92e65be0885f95';
const WV_ID = 'edef8ba979d64acea3c827dcd51d21ed';

// ---- ISO BMFF boxes ----
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const proFor = (licence) => {
  const xml = Buffer.from(`<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><KID>AAAA</KID><LA_URL>${licence}</LA_URL><LUI_URL>${licence}/ui</LUI_URL></DATA></WRMHEADER>`, 'utf16le');
  const head = Buffer.alloc(10);
  head.writeUInt32LE(10 + xml.length, 0);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 6);
  head.writeUInt16LE(xml.length, 8);
  return Buffer.concat([head, xml]);
};
const psshBox = (systemId, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return box('pssh', Buffer.alloc(4), Buffer.from(systemId, 'hex'), len, data);
};
const prPsshFor = (licence) => psshBox(PR_ID, proFor(licence));
const wvPssh = psshBox(WV_ID, Buffer.from('12107e57d4d3bf3d4d7a9e2b0c1f1e1d1c1b48e3dc959b06', 'hex'));
const initFor = (licence) =>
  Buffer.concat([
    box('ftyp', Buffer.from('iso6'), Buffer.alloc(4), Buffer.from('iso6dash')),
    box('moov', box('mvhd', Buffer.alloc(100, 1)), prPsshFor(licence), wvPssh, box('trak', box('tkhd', Buffer.alloc(84, 2)))),
  ]);
const MEDIA = Buffer.concat([box('styp', Buffer.from('msdh')), box('moof', box('mfhd', Buffer.alloc(8)), box('pssh', Buffer.alloc(4), Buffer.from(PR_ID, 'hex'), Buffer.alloc(4))), box('mdat', Buffer.alloc(500, 7))]);

const BIG = Buffer.concat([MEDIA, box('mdat', Buffer.alloc(1536 * 1024, 9))]); // past what's read whole

/** The top-level boxes (and moov's), each size checked against what's really there. */
function boxes(buf, from = 0, to = buf.length) {
  const out = [];
  let at = from;
  while (at < to) {
    const size = buf.readUInt32BE(at);
    assert.ok(size >= 8 && at + size <= to, `box at ${at} has a size (${size}) that doesn't fit`);
    out.push({ type: buf.toString('latin1', at + 4, at + 8), at, size, bytes: buf.subarray(at, at + size) });
    at += size;
  }
  assert.equal(at, to, 'the boxes fill their parent exactly');
  return out;
}
const proText = (pssh) => pssh.subarray(32 + 10).toString('utf16le');

// ---- The helpers ----

test('playReadyInitData: a pssh, or a bare PlayReady Object, comes back as a pssh naming Atomix\'s licence address; anything else is null', () => {
  const own = '/api/live/drm/s1/licence';
  const fromPssh = Buffer.from(playReadyInitData(prPsshFor('https://lic.example/pr?prsecret=1').toString('base64'), own), 'base64');
  assert.equal(fromPssh.readUInt32BE(0), fromPssh.length);
  assert.equal(fromPssh.toString('latin1', 4, 8), 'pssh');
  assert.ok(proText(fromPssh).includes(`<LA_URL>${own}</LA_URL>`));
  assert.ok(!fromPssh.toString('utf16le').includes('lic.example') && !proText(fromPssh).includes('prsecret'));
  const fromPro = Buffer.from(playReadyInitData(proFor('https://lic.example/pr?prsecret=1').toString('base64'), own), 'base64');
  assert.equal(fromPro.toString('latin1', 4, 8), 'pssh', 'a bare object is wrapped as a pssh (the browser asks with cenc)');
  assert.equal(fromPro.toString('hex', 12, 28), PR_ID);
  assert.equal(fromPro.readUInt32BE(0), fromPro.length);
  assert.equal(fromPro.readUInt32BE(28), fromPro.length - 32);
  assert.ok(proText(fromPro).includes(`<LA_URL>${own}</LA_URL>`) && !proText(fromPro).includes('lic.example'));
  assert.equal(playReadyInitData(Buffer.from('not a header').toString('base64'), own), null);
  assert.equal(playReadyInitData('', own), null);
});

test('rewriteInitSegment: the PlayReady pssh in moov names Atomix; Widevine\'s pssh and every other box are unchanged; sizes add up', () => {
  const own = '/api/live/drm/s1/licence';
  const src = initFor('https://lic.example/pr?prsecret=1');
  const out = rewriteInitSegment(src, own);
  assert.ok(Buffer.isBuffer(out.bytes));
  assert.equal(out.unreadable, false);
  const [ftyp, moov] = boxes(out.bytes);
  assert.deepEqual([ftyp.type, moov.type], ['ftyp', 'moov']);
  assert.deepEqual(ftyp.bytes, boxes(src)[0].bytes);
  const inner = boxes(out.bytes, moov.at + 8, moov.at + moov.size);
  assert.deepEqual(inner.map((b) => b.type), ['mvhd', 'pssh', 'pssh', 'trak']);
  const srcInner = boxes(src, boxes(src)[1].at + 8, boxes(src)[1].at + boxes(src)[1].size);
  assert.deepEqual(inner[0].bytes, srcInner[0].bytes);
  assert.deepEqual(inner[2].bytes, wvPssh, 'Widevine\'s pssh byte for byte');
  assert.deepEqual(inner[3].bytes, srcInner[3].bytes);
  const pr = inner[1].bytes;
  assert.equal(pr.readUInt32BE(28), pr.length - 32, 'the pssh\'s data size');
  assert.ok(proText(pr).includes(`<LA_URL>${own}</LA_URL>`), proText(pr));
  assert.ok(!out.bytes.toString('utf16le').includes('lic.example') && !out.bytes.toString('latin1').includes('prsecret'));
});

test('rewriteInitSegment: a media segment, and bytes that aren\'t boxes, come back as they are; a broken init is unreadable', () => {
  const own = '/api/live/drm/s1/licence';
  const media = rewriteInitSegment(MEDIA, own);
  assert.equal(media.bytes, MEDIA, 'the same bytes');
  assert.equal(media.unreadable, false);
  const junk = Buffer.from('hello world, not boxes');
  assert.equal(rewriteInitSegment(junk, own).bytes, junk);
  assert.equal(rewriteInitSegment(junk, own).unreadable, false, 'not an init segment: nothing to say');
  const broken = Buffer.from(initFor('https://lic.example/pr'));
  broken.writeUInt32BE(broken.length * 2, boxes(broken)[1].at); // moov claims more than there is
  const b = rewriteInitSegment(broken, own);
  assert.equal(b.bytes, broken);
  assert.equal(b.unreadable, true);
});

// ---- Through the API ----

let nf, admin, provider, ids;
const warnings = [];
before(async () => {
  provider = await multiDrmProvider({
    files: (at, host) => {
      if (at === '/dash/v720/init.mp4') return initFor(`http://${host}/lic/pr?prsecret=1`);
      if (at === '/dash/v720/seg-00100.m4s') return MEDIA;
      if (at === '/dash/v720/seg-00101.m4s') {
        const broken = Buffer.from(initFor(`http://${host}/lic/pr`));
        broken.writeUInt32BE(broken.length * 2, boxes(broken)[1].at);
        return broken;
      }
      if (at === '/dash/v720/seg-00102.m4s') return BIG;
      if (at === '/dash/v720/seg-00103.m4s') return { chunked: BIG };
      return null;
    },
  });
  process.env.LIVE_TEST_BASE = provider.url;
  process.env.LIVE_TEST_MULTIPLAY = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  const log = nf.app.core.live.drm.log;
  const warn = log.warn;
  log.warn = (...a) => (warnings.push(a.join(' ')), warn?.apply(log, a));
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
const secretsIn = (text) => [provider.url.replace('http://', ''), 'lic.example', 'prsecret', 'hdrsecret', 'mansecret'].filter((s) => text.includes(s));

test('PlayReady: the play reply\'s initData names Atomix\'s licence address, never the provider\'s (pssh and bare object); unreadable is null', async () => {
  for (const name of ['Ready', 'Ready Pro']) {
    const r = await play(ids[name], { keySystems: ['playready'] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.initData, `${name}: initData is sent`);
    const decoded = Buffer.from(r.data.initData, 'base64');
    for (const text of [JSON.stringify(r.data), decoded.toString('latin1'), decoded.toString('utf16le'), decoded.subarray(1).toString('utf16le')]) assert.deepEqual(secretsIn(text), [], name);
    assert.ok(decoded.toString('utf16le').includes(`<LA_URL>${r.data.licence}</LA_URL>`) || decoded.subarray(1).toString('utf16le').includes(`<LA_URL>${r.data.licence}</LA_URL>`), name);
  }
  const bad = await play(ids['Ready Bad'], { keySystems: ['playready'] });
  assert.equal(bad.status, 200, JSON.stringify(bad.data));
  assert.equal(bad.data.initData, null, 'a header that can\'t be read is not sent');
  stopAll();
});

test('a relayed PlayReady init segment names Atomix\'s licence address; media segments pass byte for byte; a broken init passes with one warning', async () => {
  const r = await play(ids.Ready, { keySystems: ['playready'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mpd = await (await admin.raw(r.data.manifest)).text();
  const init = /initialization="([^"]+)"/.exec(mpd)[1].replace('$RepresentationID$', 'v720').replace(/&amp;/g, '&');
  const media = /media="([^"]+)"/.exec(mpd)[1].replace('$RepresentationID$', 'v720').replace(/&amp;/g, '&');
  const got = await admin.raw(init);
  assert.equal(got.status, 200);
  const bytes = Buffer.from(await got.arrayBuffer());
  assert.equal(Number(got.headers.get('content-length')), bytes.length);
  const [ftyp, moov] = boxes(bytes);
  assert.deepEqual([ftyp.type, moov.type], ['ftyp', 'moov']);
  const inner = boxes(bytes, moov.at + 8, moov.at + moov.size);
  assert.deepEqual(inner.map((b) => b.type), ['mvhd', 'pssh', 'pssh', 'trak']);
  assert.ok(proText(inner[1].bytes).includes(`<LA_URL>${r.data.licence}</LA_URL>`), proText(inner[1].bytes));
  assert.deepEqual(inner[2].bytes, wvPssh);
  assert.deepEqual(secretsIn(bytes.toString('utf16le') + bytes.toString('latin1')), []);
  const seg = await admin.raw(media.replace('$Number%05d$', '00100'));
  assert.equal(seg.status, 200);
  assert.deepEqual(Buffer.from(await seg.arrayBuffer()), MEDIA, 'a media segment is untouched');
  const big = await admin.raw(media.replace('$Number%05d$', '00102'));
  assert.equal(big.status, 200);
  assert.ok(Buffer.from(await big.arrayBuffer()).equals(BIG), 'a big segment is streamed as it came');
  const unsized = await admin.raw(media.replace('$Number%05d$', '00103'));
  assert.equal(unsized.status, 200);
  assert.ok(Buffer.from(await unsized.arrayBuffer()).equals(BIG), 'one without a length: what was read, then the rest');
  for (let i = 0; i < 2; i++) {
    const broken = await admin.raw(media.replace('$Number%05d$', '00101'));
    assert.equal(broken.status, 200);
    const b = Buffer.from(await broken.arrayBuffer());
    assert.equal(b.toString('latin1', 4, 8), 'ftyp', 'passed on as it came');
  }
  const mine = warnings.filter((w) => /init segment/i.test(w));
  assert.equal(mine.length, 1, `one warning per session: ${JSON.stringify(warnings)}`);
  assert.deepEqual(secretsIn(mine[0]), []);
  stopAll();
});

test('a Widevine session\'s init segment is untouched', async () => {
  const r = await play(ids.Trio, { keySystems: ['widevine'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mpd = await (await admin.raw(r.data.manifest)).text();
  const init = /initialization="([^"]+)"/.exec(mpd)[1].replace('$RepresentationID$', 'v720').replace(/&amp;/g, '&');
  const bytes = Buffer.from(await (await admin.raw(init)).arrayBuffer());
  assert.deepEqual(bytes, initFor(`${provider.url.replace('http://', 'http://')}/lic/pr?prsecret=1`));
  stopAll();
});

test('keySystems: [] on a multi-system channel is 409 with the sentence', async () => {
  const r = await play(ids.Trio, { keySystems: [] });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "This browser can't play any of this channel's protections.");
  assert.equal(drm().sessions.size, 0);
});
