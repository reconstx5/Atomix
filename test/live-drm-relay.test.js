// The encrypted-channel relay (src/live/drm.js + /api/live/drm/:sid/*): the manifest rewritten so the browser only
// sees Atomix addresses, segments fetched only from the provider's own hosts, the licence forwarded in each of
// Kodi's request/answer forms, and ClearKey keys from the playlist answered by Atomix itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAtomix, client, fakeServer } from './helpers.js';
import { parseXml } from '../public/js/dash/xml.js';
import { parseMpd } from '../public/js/dash/mpd.js';
import { rewriteManifest, baseAllowed, buildLicenceRequest, readLicenceResponse, clearKeyAnswer, relayCheck, segmentTarget } from '../src/live/drm.js';
import zlib from 'node:zlib';
import { fetchFollowing } from '../src/remote/provider.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const KID = 'a7e61c373e219033c21091fa607bf3b8';
const KEYHEX = '76a6c65c5ea762046bd749a2e632ccbb';
const b64u = (hex) => Buffer.from(hex, 'hex').toString('base64url');
let nf, admin, kid, kidId, up, ids;
let slowOpened = null;
const seenEncoding = [];
const seenUrls = [];
let providerClockCalls = 0;
const clockAuth = [];
let providerClock = '2030-01-01T00:00:00Z';
let slowClosed = null;
const licenceCalls = [];
let licenceAnswer = (body) => ({ status: 200, type: 'application/octet-stream', body: Buffer.concat([Buffer.from('LIC:'), body]) });

/** The provider's manifest: segments on two hosts (127.0.0.1 and localhost), a timing source, a Location. */
const manifest = () => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="dynamic" availabilityStartTime="2026-10-10T00:00:00Z" minimumUpdatePeriod="PT2S">
  <Location>${up.url}/dash/five/live.mpd?token=locsecret</Location>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="${up.url}/time?k=timesecret"/>
  <BaseURL>${up.url}/cdn1/</BaseURL>
  <Period id="p" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="a7e61c37-3e21-9033-c210-91fa607bf3b8"/>
      <SegmentTemplate timescale="1" duration="2" startNumber="1" media="$RepresentationID$/seg-$Number%05d$.m4s?tk=segsecret" initialization="$RepresentationID$/init.mp4"/>
      <Representation id="hd" bandwidth="3000000" codecs="avc1.4d401f" width="1280" height="720"><BaseURL>video/</BaseURL></Representation>
      <Representation id="sd" bandwidth="800000" codecs="avc1.4d401e" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <BaseURL>${up.url.replace('127.0.0.1', 'localhost')}/cdn2/audio/</BaseURL>
      <Representation id="a" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="1000" duration="2000" media="../shared/a-$Number$.m4s" initialization="../shared/a-init.mp4"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

before(async () => {
  up = await fakeServer(async (req, res) => {
    seenUrls.push(req.url);
    if (req.url === '/dash/hop.mpd') {
      // Like i.mjh.nz/.r/…: the playlist's address redirects to where the manifest really is.
      res.writeHead(302, { location: '/real/tvnz/live.mpd' });
      return res.end();
    }
    if (req.url === '/real/tvnz/live.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="v/seg-$Number$.m4s" initialization="v/init.mp4" duration="2"/><Representation id="v" bandwidth="1" codecs="avc1.4d401f"/></AdaptationSet></Period></MPD>');
    }
    if (req.url === '/dash/huge.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(`<MPD>${'<!-- padding -->'.repeat(200_000)}</MPD>`);
    }
    if (req.url === '/dash/bomb.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end('<!DOCTYPE MPD [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><MPD>&b;</MPD>');
    }
    if (req.url.startsWith('/dash/')) {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(manifest());
    }
    if (req.url.startsWith('/tok/')) {
      // A manifest address with an expiring token: "old" and "bad" are refused, "new" is good.
      if (/old|bad/.test(req.url)) {
        res.writeHead(403);
        return res.end('expired');
      }
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(manifest());
    }
    if (req.url === '/clock') {
      providerClockCalls++;
      clockAuth.push(req.headers.authorization || null);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(providerClock);
    }
    if (req.url.startsWith('/utc/')) {
      const kind = req.url.slice(5);
      const timing = kind === 'iso-other' ? `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="${up.url.replace('127.0.0.1', 'localhost')}/clock"/>` : kind === 'iso' ? `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="${up.url}/clock"/>` : kind === 'direct' ? '<UTCTiming schemeIdUri="urn:mpeg:dash:utc:direct:2014" value="2031-05-05T05:05:05Z"/>' : `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="${up.url}/nothing-here"/>`;
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end(`<MPD type="dynamic" availabilityStartTime="2026-10-10T00:00:00Z">${timing}<Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s$Number$.m4s" duration="2"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`);
    }
    if (req.url === '/aslist.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      return res.end('<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><SegmentList duration="2"><Initialization sourceURL="init.mp4"/><SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/></SegmentList><Representation id="a" bandwidth="1"/><Representation id="b" bandwidth="2"/></AdaptationSet></Period></MPD>');
    }
    if (req.url === '/cdn1/gz.m4s') {
      seenEncoding.push(req.headers['accept-encoding']);
      const gz = zlib.gzipSync(Buffer.from('SEGMENT BYTES '.repeat(50)));
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-encoding': 'gzip', 'content-length': gz.length });
      return res.end(gz);
    }
    if (req.url === '/cdn1/missing.m4s') {
      res.writeHead(404);
      return res.end('nope');
    }
    if (req.url === '/cdn1/hdrs' || req.url === '/cdn2/hdrs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ auth: req.headers.authorization || null, token: req.headers['x-token'] || null }));
    }
    if (req.url === '/many.mpd') {
      res.writeHead(200, { 'content-type': 'application/dash+xml' });
      const reps = Array.from({ length: 33 }, (_, i) => `<Representation id="r${i}" bandwidth="${i + 1}"><BaseURL>https://h${i}.example/v/</BaseURL><SegmentTemplate media="s$Number$.m4s" duration="2"/></Representation>`).join('');
      return res.end(`<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4">${reps}</AdaptationSet></Period></MPD>`);
    }
    if (req.url === '/cdn1/slow') {
      slowOpened = Date.now();
      return res.on('close', () => (slowClosed = Date.now())); // never answers
    }
    if (req.url === '/redir-local') {
      res.writeHead(302, { location: `${up.url.replace('127.0.0.1', 'localhost')}/cdn1/x` });
      return res.end();
    }
    if (req.url === '/cdn1/edge.m4s') {
      // A CDN sending a segment to another edge server.
      res.writeHead(302, { location: `${up.url.replace('127.0.0.1', 'localhost')}/cdn2/edge.m4s` });
      return res.end();
    }
    if (req.url.startsWith('/cdn1/') || req.url.startsWith('/cdn2/')) {
      const body = Buffer.from(`SEG ${req.headers.host} ${req.url} token=${req.headers['x-token'] || ''}`);
      if (req.headers.range) {
        res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes 0-3/${body.length}`, 'content-length': 4 });
        return res.end(body.subarray(0, 4));
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': body.length });
      return res.end(body);
    }
    if (req.url === '/lic-redir') {
      // Like c.mjh.nz: a 307 to the real licence server, on another host.
      res.writeHead(307, { location: `${up.url.replace('127.0.0.1', 'localhost')}/lic/strict` });
      return res.end();
    }
    if (req.url === '/lic/strict' && req.headers['content-type'] !== 'application/octet-stream') {
      // Like TVNZ's server: without the content type it times out (504).
      const chunks = [];
      for await (const c of req) chunks.push(c);
      licenceCalls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(504, { 'content-type': 'application/json' });
      return res.end('{"code":"timeout"}');
    }
    if (req.url.startsWith('/lic/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      licenceCalls.push({ url: req.url, headers: req.headers, body });
      const a = licenceAnswer(body, req);
      res.writeHead(a.status, { 'content-type': a.type });
      return res.end(a.body);
    }
    res.writeHead(404);
    res.end();
  });
  process.env.LIVE_TEST_BASE = up.url;
  process.env.LIVE_TEST_DRM = '1';
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  delete process.env.LIVE_TEST_DRM;
  await nf?.app.stop();
  await up?.close();
});

const start = async (name) => {
  for (const id of [...nf.app.core.live.drm.sessions.keys()]) nf.app.core.live.drm.stop(id, 'test'); // one at a time (the account's cap is 4)
  return (await admin.post(`/api/live/channels/${ids[name]}/play`, {})).data;
};
// The browser's key system posts licence requests as bytes.
const raw = (method, p, { body, headers = {}, as = admin } = {}) => fetch(`${nf.base}${p}`, { method, body, headers: { cookie: as.cookie, ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : {}), ...headers } });
const waitFor = async (fn, ms = 1000) => {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};
const walk = (el, fn) => {
  fn(el);
  for (const c of el.children) walk(c, fn);
};

test('the rewritten manifest has no provider host anywhere; bases become opaque per origin; templates still work', async () => {
  const s = await start('Five');
  const res = await raw('GET', s.manifest);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/dash\+xml/);
  const text = await res.text();
  const host = new URL(up.url).host;
  walk(parseXml(text), (el) => {
    for (const v of [el.text, ...Object.values(el.attrs)]) {
      assert.ok(!String(v).includes(host) && !String(v).includes('localhost:'), `${el.name}: ${v}`);
      assert.ok(!/secret/.test(String(v)) || /segsecret/.test(String(v)), `${el.name}: ${v}`); // only the segment query (needed) remains, behind Atomix
    }
  });
  assert.ok(!text.includes('<Location'), 'Location is dropped (the player re-reads Atomix\'s address)');
  assert.ok(!text.includes('<BaseURL'), 'every BaseURL is folded into the templates');
  const m = parseMpd(text, `${nf.base}${s.manifest}`);
  const [video, audio] = m.periods[0].adaptationSets;
  const hd = video.representations.find((r) => r.id === 'hd');
  assert.equal(hd.template.media, `/api/live/drm/${s.sessionId}/r/0/cdn1/video/$RepresentationID$/seg-$Number%05d$.m4s?tk=segsecret`);
  assert.equal(video.representations.find((r) => r.id === 'sd').template.media, `/api/live/drm/${s.sessionId}/r/0/cdn1/$RepresentationID$/seg-$Number%05d$.m4s?tk=segsecret`);
  assert.equal(audio.representations[0].template.media, `/api/live/drm/${s.sessionId}/r/1/cdn2/shared/a-$Number$.m4s`, '"../" resolved on the server');
  assert.equal(audio.representations[0].template.timescale, 1000);
  assert.equal(hd.template.timescale, 1, 'inherited attributes are carried into each representation');
  assert.deepEqual(m.utcTiming, [{ scheme: 'urn:mpeg:dash:utc:http-iso:2014', value: `/api/live/drm/${s.sessionId}/time` }]);
  assert.deepEqual(video.contentProtection.map((c) => c.kid), [KID], 'protection kept as it was');
});

test('segments: fetched from the base\'s own origin with the stream headers; Range passes through; other hosts refused', async () => {
  const s = await start('Five');
  await raw('GET', s.manifest);
  const seg = await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/video/hd/seg-00001.m4s?tk=segsecret`);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get('content-type'), 'video/mp4');
  assert.equal(await seg.text(), `SEG ${new URL(up.url).host} /cdn1/video/hd/seg-00001.m4s?tk=segsecret token=hdrsecret`);
  const a = await raw('GET', `/api/live/drm/${s.sessionId}/r/1/cdn2/shared/a-1.m4s`);
  assert.equal(await a.text(), `SEG localhost:${new URL(up.url).port} /cdn2/shared/a-1.m4s token=hdrsecret`);
  const part = await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/x.m4s`, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range').startsWith('bytes 0-3/'), true);
  for (const bad of ['r/9/x', 'r/x/y']) {
    const r = await raw('GET', `/api/live/drm/${s.sessionId}/${bad}`);
    assert.ok(r.status === 404 || r.status === 400, `${bad}: ${r.status}`);
  }
  // Addresses that look like other hosts are paths on the base's own host (the provider answers 404 → 502).
  for (const path of ['r/0/https://evil.example/x', 'r/0//evil.example/x', 'r/0/..%2F..%2Fx']) {
    const r = await raw('GET', `/api/live/drm/${s.sessionId}/${path}`);
    assert.equal(r.status, 502, path);
  }
  const cross = await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/x.m4s`, { as: kid });
  assert.equal(cross.status, 404, 'another profile');
});

test('baseAllowed: a provider on the internet can\'t point Atomix at this machine or the home network', () => {
  assert.equal(baseAllowed('http://127.0.0.1:8787/', 'https://cdn.example/live.mpd'), false);
  assert.equal(baseAllowed('http://192.168.1.10/', 'https://cdn.example/live.mpd'), false);
  assert.equal(baseAllowed('http://localhost/', 'https://cdn.example/live.mpd'), false);
  assert.equal(baseAllowed('https://cdn2.example/', 'https://cdn.example/live.mpd'), true);
  assert.equal(baseAllowed('http://192.168.1.10:5004/', 'http://192.168.1.10:5004/lineup.mpd'), true, 'a tuner on the home network serving itself');
});

test('licence, raw: the provider gets the exact challenge with the licence headers; the browser the exact answer', async () => {
  const s = await start('Six');
  const challenge = Buffer.from([8, 4, 0, 255, 1, 2, 3]);
  const r = await raw('POST', s.licence, { body: challenge, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.concat([Buffer.from('LIC:'), challenge]));
  const call = licenceCalls.at(-1);
  assert.deepEqual(call.body, challenge);
  assert.equal(call.headers['x-lic'], 'secretlic');
  assert.equal(call.headers['content-type'], 'application/octet-stream');
});

test('licence, templated JSON request and a JSON-field base64 answer (JBlicense); a base64 body answer (B)', async () => {
  const s = await start('Six');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.licence = { ...session.licence, body: { kind: 'template', text: '{"challenge":"b{SSM}","drm":"widevine"}' }, response: { kind: 'json', path: 'data.license', base64: true } };
  licenceAnswer = (body) => {
    const req = JSON.parse(body.toString());
    return { status: 200, type: 'application/json', body: JSON.stringify({ data: { license: Buffer.from(`OK ${req.challenge}`).toString('base64') } }) };
  };
  const r = await raw('POST', s.licence, { body: Buffer.from('chal') });
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), `OK ${Buffer.from('chal').toString('base64')}`);
  assert.equal(licenceCalls.at(-1).headers['content-type'], 'application/json');
  session.licence = { ...session.licence, body: { kind: 'raw' }, response: { kind: 'base64' } };
  licenceAnswer = () => ({ status: 200, type: 'text/plain', body: Buffer.from('LICENCE BYTES').toString('base64') });
  assert.equal(Buffer.from(await (await raw('POST', s.licence, { body: Buffer.from('x') })).arrayBuffer()).toString(), 'LICENCE BYTES');
  licenceAnswer = (body) => ({ status: 200, type: 'application/octet-stream', body: Buffer.concat([Buffer.from('LIC:'), body]) });
});

test('licence failures read as sentences: refused (403), not answering (502); a body over 64 KB is 413; another profile 404', async () => {
  const s = await start('Six');
  licenceAnswer = () => ({ status: 403, type: 'text/plain', body: 'no' });
  let r = await raw('POST', s.licence, { body: Buffer.from('x') });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "The provider refused this channel's licence");
  licenceAnswer = () => ({ status: 503, type: 'text/plain', body: 'down' });
  r = await raw('POST', s.licence, { body: Buffer.from('x') });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, "The licence server isn't answering");
  licenceAnswer = (body) => ({ status: 200, type: 'application/octet-stream', body: Buffer.concat([Buffer.from('LIC:'), body]) });
  r = await raw('POST', s.licence, { body: Buffer.alloc(64 * 1024 + 1) });
  assert.equal(r.status, 413);
  r = await raw('POST', s.licence, { body: Buffer.from('x'), as: kid });
  assert.equal(r.status, 404);
});

test('ClearKey keys from the playlist: Atomix answers the browser\'s request with the key; an unknown key id is 403', async () => {
  const s = await start('Five');
  const r = await raw('POST', s.licence, { body: Buffer.from(JSON.stringify({ kids: [b64u(KID)], type: 'temporary' })) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { keys: [{ kty: 'oct', kid: b64u(KID), k: b64u(KEYHEX) }], type: 'temporary' });
  const bad = await raw('POST', s.licence, { body: Buffer.from(JSON.stringify({ kids: [b64u('00'.repeat(16))] })) });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error, "The playlist doesn't have the key for this channel");
});

test('time: Atomix\'s clock for the player', async () => {
  const s = await start('Five');
  const r = await raw('GET', `/api/live/drm/${s.sessionId}/time`);
  assert.ok(Math.abs(Date.parse(await r.text()) - Date.now()) < 5000);
  assert.equal((await raw('GET', `/api/live/drm/${s.sessionId}/time`, { as: kid })).status, 404);
});

test('the pure helpers', () => {
  assert.deepEqual(buildLicenceRequest({ body: { kind: 'raw' } }, Buffer.from('ab')), { body: Buffer.from('ab'), contentType: 'application/octet-stream' });
  assert.deepEqual(buildLicenceRequest({ body: { kind: 'template', text: 'x=B{SSM}' } }, Buffer.from([251, 255])), { body: Buffer.from(`x=${encodeURIComponent(Buffer.from([251, 255]).toString('base64'))}`), contentType: 'application/x-www-form-urlencoded' });
  assert.deepEqual(readLicenceResponse({ response: { kind: 'json', path: 'a.b', base64: false } }, Buffer.from('{"a":{"b":"hi"}}')), Buffer.from('hi'));
  assert.throws(() => readLicenceResponse({ response: { kind: 'json', path: 'missing', base64: true } }, Buffer.from('{}')));
  assert.deepEqual(clearKeyAnswer([{ kid: KID, key: KEYHEX }], { kids: [b64u(KID)] }), { keys: [{ kty: 'oct', kid: b64u(KID), k: b64u(KEYHEX) }], type: 'temporary' });
  assert.equal(clearKeyAnswer([{ kid: KID, key: KEYHEX }], { kids: ['AAAA'] }), null);
  const s = { id: 'sid', bases: [], manifestUrl: 'https://o.example/m/live.mpd' };
  const out = rewriteManifest('<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"><SegmentTemplate media="s$Number$.m4s" duration="2"/></Representation></AdaptationSet></Period></MPD>', s.manifestUrl, s);
  assert.match(out, /media="\/api\/live\/drm\/sid\/r\/0\/m\/s\$Number\$\.m4s"/);
  assert.deepEqual(s.bases, ['https://o.example']);
});

test('a manifest over 2 MB, or one with entity declarations, reads as "couldn\'t be read" (never expanded)', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  for (const p of ['/dash/huge.mpd', '/dash/bomb.mpd']) {
    session.manifestUrl = `${up.url}${p}`;
    const r = await raw('GET', s.manifest);
    assert.equal(r.status, 502, p);
    assert.equal((await r.json()).error, "This channel's stream couldn't be read");
  }
});

test('fetchFollowing waits for an async check on every hop (a redirect is refused before it is fetched)', async () => {
  const seen = [];
  const check = async (u) => {
    seen.push(u);
    await new Promise((r) => setTimeout(r, 5));
    if (new URL(u).hostname === 'localhost') throw new Error('refused');
  };
  await assert.rejects(fetchFollowing(`${up.url}/redir-local`, { check }), /refused/);
  assert.equal(seen.length, 2);
});

test('relayCheck: for a manifest on the internet, any hop that names or resolves to this machine or the home network is refused', async () => {
  const lookup = async (host) => (host === 'sneaky.example' ? [{ address: '127.0.0.1', family: 4 }] : host === 'tuner.lan' ? [{ address: '192.168.1.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  const check = relayCheck('https://cdn.example/live.mpd', { lookup });
  for (const bad of ['http://127.0.0.1/x', 'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:c0a8:101]/x', 'http://localhost./x', 'http://100.64.1.1/x', 'http://0.1.2.3/x', 'http://[::]/x', 'http://169.254.169.254/x', 'http://sneaky.example/x']) {
    await assert.rejects(check(bad), undefined, bad);
  }
  await check('https://cdn2.example/seg.m4s');
  const home = relayCheck('http://tuner.lan:5004/lineup.mpd', { lookup });
  await home('http://tuner.lan:5004/seg.m4s');
  await home('http://192.168.1.5/seg');
  await assert.rejects(home('http://169.254.169.254/'), undefined, 'link-local is never fetched');
});

test('a segment the browser gives up on — or a session that is stopped — stops the provider fetch too', async () => {
  const s = await start('Five');
  await raw('GET', s.manifest);
  const url = `${nf.base}/api/live/drm/${s.sessionId}/r/0/cdn1/slow`;
  slowOpened = slowClosed = null;
  const ac = new AbortController();
  fetch(url, { headers: { cookie: admin.cookie }, signal: ac.signal }).catch(() => {});
  assert.ok(await waitFor(() => slowOpened));
  ac.abort();
  assert.ok(await waitFor(() => slowClosed), 'the provider saw the close');
  slowOpened = slowClosed = null;
  const pending = fetch(url, { headers: { cookie: admin.cookie } }).then((r) => r.status, () => 'reset');
  assert.ok(await waitFor(() => slowOpened));
  nf.app.core.live.drm.stop(s.sessionId, 'test');
  assert.ok(await waitFor(() => slowClosed), 'stop() ends the relays in flight');
  assert.ok([502, 'reset'].includes(await pending));
});

test('a manifest that would expand past the output cap (many representations × an inherited timeline) is refused', () => {
  const S = '<S d="1"/>'.repeat(1000);
  const reps = Array.from({ length: 300 }, (_, i) => `<Representation id="r${i}" bandwidth="${i + 1}"/>`).join('');
  const text = `<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate media="s$Time$.m4s"><SegmentTimeline>${S}</SegmentTimeline></SegmentTemplate>${reps}</AdaptationSet></Period></MPD>`;
  assert.throws(() => rewriteManifest(text, 'https://o.example/m.mpd', { id: 'sid', bases: [], system: 'widevine' }), /too big/);
});

test('nothing in the rewritten manifest leads the browser to the provider: licence URLs, other systems, reports, remote periods, sourceURLs', () => {
  const text = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dashif="https://dashif.org/" type="static" mediaPresentationDuration="PT10S">
  <ProgramInformation moreInformationURL="https://o.example/info"><Title>Show</Title></ProgramInformation>
  <Metrics metrics="DVBErrors"><Reporting schemeIdUri="urn:dvb:dash:reporting:2014" value="1" reportingUrl="https://o.example/report"/></Metrics>
  <Period id="1"><AdaptationSet mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><dashif:Laurl>https://lic.other/wv</dashif:Laurl><cenc:pssh xmlns:cenc="urn:mpeg:cenc:2013">AAAA</cenc:pssh></ContentProtection>
    <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"><mspr:pro xmlns:mspr="urn:microsoft:playready">PROTDATA</mspr:pro></ContentProtection>
    <SupplementalProperty schemeIdUri="urn:x:thumbs" value="https://o.example/thumbs"/>
    <Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL><SegmentBase indexRange="0-99"><Initialization sourceURL="init.mp4"/><RepresentationIndex sourceURL="idx.sidx"/></SegmentBase></Representation>
  </AdaptationSet></Period>
  <Period id="2" xlink:href="https://o.example/period2.xml" xlink:actuate="onLoad"/>
</MPD>`;
  const out = rewriteManifest(text, 'https://o.example/m/live.mpd', { id: 'sid', bases: [], system: 'widevine' });
  for (const leak of ['o.example', 'lic.other', 'PROTDATA', 'Metrics', 'ProgramInformation', 'Laurl', 'xlink:href']) assert.ok(!out.includes(leak), `${leak} in ${out}`);
  assert.match(out, /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/, 'the session\'s own system stays');
  assert.match(out, /<cenc:pssh[^>]*>AAAA</, 'with its pssh');
  assert.match(out, /mp4protection/);
  assert.match(out, /<Initialization sourceURL="\/api\/live\/drm\/sid\/r\/0\/m\/init\.mp4"\/>/);
  assert.match(out, /<RepresentationIndex sourceURL="\/api\/live\/drm\/sid\/r\/0\/m\/idx\.sidx"\/>/);
});

test('licence answers in Kodi\'s other forms: a token found at any depth, one-element arrays, BJ, HB; a 2-byte certificate request passes through', () => {
  const lic = (response) => ({ response });
  assert.deepEqual(readLicenceResponse(lic({ kind: 'json', path: 'license', base64: false }), Buffer.from('{"result":[{"data":{"license":"abc"}}]}')), Buffer.from('abc'));
  assert.deepEqual(readLicenceResponse(lic({ kind: 'json', path: 'a.b', base64: false }), Buffer.from('{"a":[{"b":"x"}]}')), Buffer.from('x'));
  const inner = Buffer.from(JSON.stringify({ license: 'LIC' })).toString('base64');
  assert.deepEqual(readLicenceResponse(lic({ kind: 'json', path: 'license', base64: false, wrapped: true }), Buffer.from(inner)), Buffer.from('LIC'));
  assert.deepEqual(readLicenceResponse(lic({ kind: 'http-base64' }), Buffer.from(`HTTP/1.1 200 OK\r\nX-A: 1\r\n\r\n${Buffer.from('BYTES').toString('base64')}`)), Buffer.from('BYTES'));
  assert.deepEqual(readLicenceResponse(lic({ kind: 'json', path: 'license', base64: true }), Buffer.from('CERT'), Buffer.from([8, 4])), Buffer.from('CERT'));
});

test('licence requests: R{SSM} keeps the exact bytes, placeholders are replaced once, a form body says so', () => {
  const chal = Buffer.from([0xff, 0x00, 0x80]);
  assert.deepEqual(buildLicenceRequest({ body: { kind: 'template', text: 'pre:R{SSM}' } }, chal).body, Buffer.concat([Buffer.from('pre:'), chal]));
  assert.deepEqual(buildLicenceRequest({ body: { kind: 'template', text: 'R{SSM}' } }, Buffer.from('b{SSM}')).body, Buffer.from('b{SSM}'), 'a challenge is never re-read as a template');
  assert.equal(buildLicenceRequest({ body: { kind: 'template', text: 'x=B{SSM}' } }, chal).contentType, 'application/x-www-form-urlencoded');
  assert.equal(buildLicenceRequest({ body: { kind: 'template', text: '{"c":"b{SSM}"}' } }, chal).contentType, 'application/json');
});

test('a playlist\'s own content-type for the licence replaces Atomix\'s (one header, whatever its case)', async () => {
  const s = await start('Six');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.licence = { ...session.licence, headers: { ...session.licence.headers, 'content-type': 'application/json' } };
  await raw('POST', s.licence, { body: Buffer.from('x') });
  assert.equal(licenceCalls.at(-1).headers['content-type'], 'application/json');
});

test('a licence server that redirects to another host (307) still gets the request\'s content type and the playlist\'s headers — not its credentials', async () => {
  const s = await start('Six');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.licence = { ...session.licence, url: `${up.url}/lic-redir`, headers: { 'X-Lic': 'secretlic', Authorization: 'Bearer abc', Cookie: 'a=b' }, body: { kind: 'raw' }, response: { kind: 'raw' } };
  licenceAnswer = (body) => ({ status: 200, type: 'application/octet-stream', body: Buffer.concat([Buffer.from('LIC:'), body]) });
  const r = await raw('POST', s.licence, { body: Buffer.from([8, 4]) });
  const call = licenceCalls.at(-1);
  assert.equal(call.url, '/lic/strict');
  assert.equal(r.status, 200, `the provider answered ${call.headers['content-type'] || 'no content type'}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), Buffer.from([...Buffer.from('LIC:'), 8, 4]));
  assert.equal(call.headers['content-type'], 'application/octet-stream');
  assert.equal(call.headers['x-lic'], 'secretlic');
  assert.equal(call.headers.authorization, undefined, 'credentials stay with the host they were written for');
  assert.equal(call.headers.cookie, undefined);
});

test('relative segment addresses resolve against where the manifest really is (after the playlist address redirects)', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.manifestUrl = `${up.url}/dash/hop.mpd`;
  const text = await (await raw('GET', s.manifest)).text();
  assert.match(text, new RegExp(`media="/api/live/drm/${s.sessionId}/r/\\d+/real/tvnz/v/seg-\\$Number\\$\\.m4s"`), text);
});

test('a segment redirected to another server still carries the playlist\'s stream headers', async () => {
  const s = await start('Five');
  await raw('GET', s.manifest);
  const seg = await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/edge.m4s`);
  assert.equal(seg.status, 200);
  assert.match(await seg.text(), /token=hdrsecret$/);
});

test('segmentTarget: a colon in the first path part and a double slash stay paths', () => {
  assert.equal(segmentTarget('https://o.example', 'a:b/seg.m4s', '?x=1').href, 'https://o.example/a:b/seg.m4s?x=1');
  assert.equal(segmentTarget('https://o.example', '/x//seg.m4s', '').href, 'https://o.example//x//seg.m4s');
  for (const rest of ['https://evil.example/x', '//evil.example/x', '../../x']) assert.equal(segmentTarget('https://o.example', rest, '').origin, 'https://o.example', rest);
});

test('segments: the provider is asked for identity encoding; an encoded answer has no content-length', async () => {
  const s = await start('Five');
  await raw('GET', s.manifest);
  const r = await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/gz.m4s`);
  assert.equal(seenEncoding.at(-1), 'identity');
  assert.equal(r.headers.get('content-length'), null);
  assert.equal(await r.text(), 'SEGMENT BYTES '.repeat(50));
});

test('segments: a provider 404 reaches the browser as 502 "couldn\'t be read"; a 206 still passes', async () => {
  const s = await start('Five');
  await raw('GET', s.manifest);
  const r = await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/missing.m4s`);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, "This channel's stream couldn't be read");
  assert.equal((await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/x.m4s`, { headers: { range: 'bytes=0-3' } })).status, 206);
});

test('stream headers\' credentials go only to the manifest\'s own origin', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.streamHeaders = { ...session.streamHeaders, Authorization: 'Bearer x' };
  await raw('GET', s.manifest);
  const own = await (await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/hdrs`)).json();
  const other = await (await raw('GET', `/api/live/drm/${s.sessionId}/r/1/cdn2/hdrs`)).json();
  assert.deepEqual(own, { auth: 'Bearer x', token: 'hdrsecret' });
  assert.deepEqual(other, { auth: null, token: 'hdrsecret' });
});

test('more than 32 provider origins: the manifest is refused', async () => {
  const s = await start('Five');
  nf.app.core.live.drm.sessions.get(s.sessionId).manifestUrl = `${up.url}/many.mpd`;
  const r = await raw('GET', s.manifest);
  assert.equal(r.status, 502);
});

test('an expired manifest address is renewed once from the playlist', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  let calls = 0;
  session.manifestUrl = `${up.url}/tok/live.mpd?token=old`;
  session.source = { key: KEY, stream: async () => (calls++, { url: `${up.url}/tok/live.mpd?token=new`, headers: {}, drm: { system: 'clearkey', licence: session.licence } }) };
  const r = await raw('GET', s.manifest);
  assert.equal(r.status, 200);
  assert.equal(calls, 1);
  assert.match(session.manifestUrl, /token=new$/);
});

test('a second refusal after the fresh address is the 502', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  let calls = 0;
  session.manifestUrl = `${up.url}/tok/live.mpd?token=old`;
  session.source = { key: KEY, stream: async () => (calls++, { url: `${up.url}/tok/live.mpd?token=bad`, headers: {}, drm: { system: 'clearkey', licence: session.licence } }) };
  const r = await raw('GET', s.manifest);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, "This channel's stream couldn't be read");
  assert.equal(calls, 1, 'asked once, not in a loop');
});

test('time: the provider\'s own clock when the manifest names one (cached 60 s); direct values; unreadable → Atomix\'s', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.manifestUrl = `${up.url}/utc/iso`;
  await raw('GET', s.manifest);
  const before = providerClockCalls;
  const t1 = await (await raw('GET', `/api/live/drm/${s.sessionId}/time`)).text();
  assert.match(t1, /^2030-01-01T00:00:0/);
  await (await raw('GET', `/api/live/drm/${s.sessionId}/time`)).text();
  assert.equal(providerClockCalls - before, 1, 'cached for 60 s');
  session.manifestUrl = `${up.url}/utc/direct`;
  await raw('GET', s.manifest);
  assert.match(await (await raw('GET', `/api/live/drm/${s.sessionId}/time`)).text(), /^2031-05-05T05:05:0/);
  session.manifestUrl = `${up.url}/utc/broken`;
  await raw('GET', s.manifest);
  const t3 = Date.parse(await (await raw('GET', `/api/live/drm/${s.sessionId}/time`)).text());
  assert.ok(Math.abs(t3 - Date.now()) < 5000);
});

test('an AdaptationSet-level SegmentList is inherited into each Representation', async () => {
  const s = await start('Five');
  nf.app.core.live.drm.sessions.get(s.sessionId).manifestUrl = `${up.url}/aslist.mpd`;
  const text = await (await raw('GET', s.manifest)).text();
  const reps = text.split('<Representation').slice(1);
  assert.equal(reps.length, 2);
  for (const r of reps) assert.match(r, new RegExp(`<SegmentURL media="/api/live/drm/${s.sessionId}/r/\\d+/s1\\.m4s"`), r);
});

test('relayCheck: a home-network manifest still can\'t reach a name that resolves to link-local', async () => {
  const lookup = async (h) => (h === 'meta.lan' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '192.168.1.5', family: 4 }]);
  const check = relayCheck('http://tuner.lan:5004/lineup.mpd', { lookup });
  await assert.rejects(check('http://meta.lan/latest/'), undefined, 'a name for the metadata address');
  await check('http://tuner.lan:5004/seg.m4s');
});

test('manifest and stream params from the playlist are added to the provider addresses', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  Object.assign(session, { manifestParams: 'a=1', streamParams: 'b=2' });
  await raw('GET', s.manifest);
  assert.ok(seenUrls.some((u) => u.startsWith('/dash/five/live.mpd?a=1')), JSON.stringify(seenUrls.slice(-3)));
  await raw('GET', `/api/live/drm/${s.sessionId}/r/0/cdn1/video/hd/seg-00001.m4s?tk=segsecret`);
  assert.equal(seenUrls.at(-1), '/cdn1/video/hd/seg-00001.m4s?tk=segsecret&b=2');
});

test('the play reply carries the playlist\'s server certificate and init data (no provider host)', async () => {
  const s = await start('Six');
  assert.ok('serverCertificate' in s && 'initData' in s, JSON.stringify(Object.keys(s)));
  assert.ok(!JSON.stringify(s).includes(new URL(up.url).host));
});

test("the provider's clock on another host never gets the stream's credentials", async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.manifestUrl = `${up.url}/utc/iso-other`;
  session.manifestHeaders = { Authorization: 'Bearer clocksecret' };
  await raw('GET', s.manifest);
  session.clock = null;
  clockAuth.length = 0;
  await (await raw('GET', `/api/live/drm/${s.sessionId}/time`)).text();
  assert.deepEqual(clockAuth, [null]);
});

test("the playlist's manifest params are on the very first manifest read", async () => {
  const src = nf.app.core.plugins.getLiveSource(KEY);
  const orig = src.stream;
  src.stream = async (k, o) => ({ ...(await orig.call(src, k, o)), manifestParams: 'first=1' });
  try {
    seenUrls.length = 0;
    const s = await start('Five');
    assert.ok(s.sessionId, JSON.stringify(s));
    assert.ok(seenUrls.some((u) => /\.mpd\?(.*&)?first=1/.test(u)), JSON.stringify(seenUrls));
  } finally {
    src.stream = orig;
  }
});

test('a CDN that names a new edge host on each refresh keeps playing (the 32-origin cap is per manifest)', () => {
  const session = { id: 'sid', bases: [], system: 'widevine' };
  const one = (host) => `<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><BaseURL>https://${host}/v/</BaseURL><SegmentTemplate media="s$Number$.m4s" duration="2"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`;
  let last;
  for (let i = 0; i < 80; i++) last = rewriteManifest(one(`edge${i}.cdn.example`), 'https://o.example/m.mpd', session);
  const n = Number(/\/r\/(\d+)\//.exec(last)[1]);
  assert.equal(session.bases[n], 'https://edge79.cdn.example', 'the latest edge is reachable');
  assert.ok(session.bases.length <= 64, `${session.bases.length} origins kept`);
  // The previous manifest's edge is still reachable (a segment the player is fetching right now).
  assert.ok(session.bases.includes('https://edge78.cdn.example'));
});

test('a renewal whose source never answers is the 502, in time (v0.22)', async () => {
  const s = await start('Five');
  const session = nf.app.core.live.drm.sessions.get(s.sessionId);
  session.manifestUrl = `${up.url}/tok/live.mpd?token=old`;
  session.source = { key: KEY, stream: () => new Promise(() => {}) };
  nf.app.core.live.streams.resolveTimeoutMs = 100;
  const t0 = Date.now();
  const r = await raw('GET', s.manifest);
  nf.app.core.live.streams.resolveTimeoutMs = 15_000;
  assert.equal(r.status, 502);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});

test('an encrypted start whose source never answers is the 502, in time (v0.22)', async () => {
  const drm = nf.app.core.live.drm;
  nf.app.core.live.streams.resolveTimeoutMs = 100;
  const t0 = Date.now();
  const err = await drm.start({ user: { id: 99 }, profile: { id: 999 }, channel: { key: 'x', id: 'x', name: 'X' }, source: { key: 'never/src', maxStreams: () => 5, stream: () => new Promise(() => {}) } }).catch((e) => e);
  nf.app.core.live.streams.resolveTimeoutMs = 15_000;
  assert.equal(err.status, 502, String(err));
  assert.ok(Date.now() - t0 < 5000);
});
