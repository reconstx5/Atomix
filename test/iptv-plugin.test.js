// The IPTV Simple plugin end to end (plugins/iptv-simple/index.js) with a fake provider over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fakeServer, tempDir } from './helpers.js';
import { setup } from '../plugins/iptv-simple/index.js';
import { fetchFollowing } from '../src/remote/provider.js';
import { redactUrl, isPrivateTarget } from '../src/http/net.js';

const M3U = fs.readFileSync(new URL('./fixtures/iptv/provider.m3u', import.meta.url), 'utf8');
// The guide's programmes are moved to today (the plugin keeps only programmes near now), so the test doesn't expire.
const TODAY = new Date();
const GUIDE_DAY = Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate());
const ymd = new Date(GUIDE_DAY).toISOString().slice(0, 10).replace(/-/g, '');
const XML = Buffer.from(fs.readFileSync(new URL('./fixtures/iptv/guide.xml', import.meta.url), 'utf8').replaceAll('20261010', ymd));
const at = (h, m = 0) => GUIDE_DAY + h * 3600_000 + m * 60_000;
let srv;
const seen = [];

before(async () => {
  srv = await fakeServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'] });
    if (req.url.startsWith('/get.php')) {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end(M3U.replace('url-tvg="http://guide.example/epg.xml.gz,http://guide.example/backup.xml"', `url-tvg="${srv.url}/epg.xml.gz"`));
    }
    if (req.url === '/epg.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(zlib.gzipSync(XML));
    }
    if (req.url === '/plain.xml') return res.end(XML);
    if (req.url === '/radio.m3u') return res.end('#EXTM3U\n#EXTINF:-1 radio="true",Radio Only\nhttp://r.example/1.mp3\n');
    if (req.url.startsWith('/forbidden')) {
      res.writeHead(403);
      return res.end('no');
    }
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Log in</title>');
    }
    res.writeHead(404);
    res.end();
  });
});
after(() => srv.close());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fakeApi(config, { storage = new Map() } = {}) {
  let source;
  const api = {
    id: 'iptv-simple',
    version: '0.16.0',
    config: { playlist: '', guide: '', userAgent: '', refreshHours: '6', numbering: 'playlist', startNumber: 1, guideShift: 0, logosPath: '', maxStreams: 'auto', catchupDays: 7, ...config },
    HttpError,
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
  };
  setup(api);
  return { api, source, storage };
}
const ctx = () => ({ signal: AbortSignal.timeout(10000), log: { info() {}, warn() {} } });
const playlistUrl = () => `${srv.url}/get.php?username=u&password=secretpw&type=m3u_plus`;

test('refresh returns channels with groups, numbers, logos and programmes matched to them', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/plain.xml`, logosPath: 'http://logos.example/base/' });
  const r = await source.refresh(ctx());
  const tvnz = r.channels.find((c) => c.name === 'TVNZ 1 HD');
  assert.deepEqual([tvnz.key, tvnz.number, tvnz.group, tvnz.logo, tvnz.guideId, tvnz.radio], ['tvnz1.nz', 1, ['News', 'Local'], 'http://logos.example/tvnz1.png', 'tvnz1.nz', false]);
  assert.equal(r.channels.find((c) => c.name === 'Three').logo, 'http://logos.example/base/three.png', 'a bare logo name joins logosPath');
  assert.equal(r.channels.find((c) => c.name === 'RNZ National').radio, true);
  assert.equal(r.channels.some((c) => 'url' in c || 'headers' in c), false, 'stream details stay inside the plugin');
  const news = r.programmes.find((p) => p.title.startsWith('1 News'));
  assert.equal(news.guideId, 'tvnz1.nz');
  assert.equal(news.episode, 'S2 E5');
  const three = r.channels.find((c) => c.name === 'Three');
  assert.deepEqual(three.catchup, { mode: 'xc', days: 7 });
  const tvnzCatchup = tvnz.catchup;
  assert.deepEqual(tvnzCatchup, { mode: 'shift', days: 3 }, 'the playlist header default');
  assert.ok(seen.some((s) => s.url.startsWith('/get.php') && s.ua === 'Atomix/0.16.0'), 'default user agent');
});

test('the guide comes from url-tvg when the setting is empty, and guideShift applies', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guideShift: 1 });
  const r = await source.refresh(ctx());
  assert.ok(seen.some((s) => s.url === '/epg.xml.gz'));
  const news = r.programmes.find((p) => p.title.startsWith('1 News'));
  // The playlist header says tvg-shift="1" and the setting adds 1 more: 2 h on top of the guide's own offset.
  assert.equal(news.start, at(6) + 2 * 3600_000);
});

test('a 403 playlist rejects with the exact sentence and no path or credentials in it', async () => {
  const { source } = fakeApi({ playlist: `${srv.url}/forbidden/get.php?username=u&password=secretpw` });
  await assert.rejects(source.refresh(ctx()), (err) => {
    assert.equal(err.message, "The playlist didn't answer (HTTP 403) — check the address and that your subscription is active");
    assert.ok(!/secretpw|username|forbidden/.test(err.message));
    return true;
  });
});

test('an HTML login page with HTTP 200 rejects with "The playlist isn\'t an M3U file"', async () => {
  const { source } = fakeApi({ playlist: `${srv.url}/login` });
  await assert.rejects(source.refresh(ctx()), /^Error: The playlist isn't an M3U file$/);
});

test('a guide failure still returns channels, with the warning', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/missing.xml` });
  const r = await source.refresh(ctx());
  assert.ok(r.channels.length >= 5);
  assert.equal(r.programmes, null, 'null = the guide was not refreshed (Atomix keeps the old one)');
  assert.ok(r.warnings.includes("The guide didn't answer (HTTP 404)"), r.warnings.join(' | '));
});

test('stream() adds the user agent and the playlist\'s headers; an unknown key is 404', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/plain.xml`, userAgent: 'MyBox/1' });
  const r = await source.refresh(ctx());
  const sky = r.channels.find((c) => c.name === 'Sky Sport');
  const s = await source.stream(sky.key, ctx());
  assert.equal(s.url, 'http://provider.example/live/u/p/200.ts');
  assert.deepEqual(s.headers, { 'User-Agent': 'VLC/3.0', Referer: 'http://provider.example/' }, "the playlist's own user agent wins");
  const tvnz = await source.stream('tvnz1.nz', ctx());
  assert.deepEqual(tvnz.headers, { 'User-Agent': 'MyBox/1' });
  const free = await source.stream(r.channels.find((c) => c.name === 'Free Channel').key, ctx());
  assert.equal(free.mime, 'application/x-mpegURL');
  await assert.rejects(source.stream('nope', ctx()), (e) => e.status === 404 && e.message === 'This channel no longer exists.');
});

test('stream() works after a restart from storage, before any refresh', async () => {
  const storage = new Map();
  const first = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/plain.xml` }, { storage });
  await first.source.refresh(ctx());
  const second = fakeApi({ playlist: playlistUrl() }, { storage });
  const s = await second.source.stream('tvnz1.nz', ctx());
  assert.equal(s.url, 'http://provider.example/live/u/p/101.ts');
});

test('catchup() builds the URL for an xtream channel and the duration from "from"', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/plain.xml` });
  await source.refresh(ctx());
  const start = Date.UTC(2026, 9, 10, 6, 0, 0);
  const out = await source.catchup('three.nz', { start, end: start + 30 * 60_000, title: 'X' }, { from: 600 }, ctx());
  assert.equal(out.url, 'http://provider.example/timeshift/u/p/20/2026-10-10:06-10/103.ts');
  assert.equal(out.duration, 1200);
  assert.deepEqual(out.headers, { 'User-Agent': 'Atomix/0.16.0' });
});

test('settingsSummary counts groups and unmatched channels; maxStreams resolves auto', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/plain.xml` });
  await source.refresh(ctx());
  assert.match(source.settingsSummary(), /^6 channels in 5 groups · guide to .+ · 3 TV channels without guide$/, 'the radio station without guide isn\'t counted');
  assert.equal(source.maxStreams(), 1);
  assert.equal(fakeApi({ playlist: 'C:\\TV\\list.m3u', maxStreams: 'auto' }).source.maxStreams(), Infinity);
  assert.equal(fakeApi({ playlist: playlistUrl(), maxStreams: 'unlimited' }).source.maxStreams(), Infinity);
  assert.equal(fakeApi({ playlist: playlistUrl(), maxStreams: '3' }).source.maxStreams(), 3);
  assert.equal(fakeApi({ playlist: playlistUrl(), refreshHours: '12' }).source.refreshHours(), 12);
});

test('redactUrl keeps only scheme, host and port', () => {
  assert.equal(redactUrl('http://user:pw@host.example:8080/live/u/p/1.ts?token=x'), 'http://host.example:8080/…');
  assert.equal(redactUrl('https://cdn.example/a'), 'https://cdn.example/…');
  assert.equal(redactUrl('not a url'), '[address]');
});

test('a relative file path is refused; an absolute file path is read', async () => {
  await assert.rejects(fakeApi({ playlist: 'lists/tv.m3u' }).source.refresh(ctx()), /^Error: Use a full file path \(for example D:\\TV\\playlist\.m3u\)$/);
  const dir = tempDir();
  await assert.rejects(fakeApi({ playlist: path.join(dir, 'none.m3u') }).source.refresh(ctx()), /^Error: There's no file at that path$/);
  const file = path.join(dir, 'tv.m3u');
  fs.writeFileSync(file, '#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="Local",A\nhttp://tuner.local:5004/auto/v2\n');
  const r = await fakeApi({ playlist: file }).source.refresh(ctx());
  assert.deepEqual(r.channels.map((c) => c.name), ['A']);
});

test('no playlist set: refresh says so', async () => {
  await assert.rejects(fakeApi({ playlist: '' }).source.refresh(ctx()), /^Error: Add a playlist address in Settings → Plugins → IPTV Simple$/);
});

test('imageRoots() declares the logos folder (a folder, not a URL), so only logos inside it are served', () => {
  assert.deepEqual(fakeApi({ playlist: playlistUrl(), logosPath: '/srv/tv/logos' }).source.imageRoots(), ['/srv/tv/logos']);
  assert.deepEqual(fakeApi({ playlist: playlistUrl(), logosPath: 'http://logos.example/base/' }).source.imageRoots(), []);
  assert.deepEqual(fakeApi({ playlist: playlistUrl(), logosPath: '' }).source.imageRoots(), []);
});

test('a playlist or guide that redirects to a link-local address is refused at that hop', async () => {
  const hop = await fakeServer((req, res) => {
    res.writeHead(302, { location: req.url.includes('guide') ? 'http://[fe80::1]/g.xml' : 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  try {
    await assert.rejects(fakeApi({ playlist: `${hop.url}/get.php` }).source.refresh(ctx()), /^Error: That address isn't allowed$/);
    const r = await fakeApi({ playlist: playlistUrl(), guide: `${hop.url}/guide.xml` }).source.refresh(ctx());
    assert.ok(r.warnings.includes("That address isn't allowed"), r.warnings.join(' | '));
  } finally {
    await hop.close();
  }
});

test('guideShift is clamped to −24…24 hours, and nonsense is 0', async () => {
  const base = at(6) + 3600_000; // the playlist header's own tvg-shift="1"
  for (const [shift, hours] of [[50, 24], [-99, -24], ['x', 0]]) {
    const { source } = fakeApi({ playlist: playlistUrl(), guideShift: shift });
    const r = await source.refresh(ctx());
    assert.equal(r.programmes.find((p) => p.title.startsWith('1 News')).start, base + hours * 3600_000, String(shift));
  }
});

test('a slow guide that keeps sending isn\'t cut off; one that stalls is', async () => {
  const { openInput } = await import('../plugins/iptv-simple/fetch.js');
  const trickle = await fakeServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    const stall = req.url === '/stall';
    for (let i = 0; i < 10; i++) {
      res.write('<!-- chunk -->');
      await new Promise((r) => setTimeout(r, stall && i === 4 ? 600 : 100));
    }
    res.end();
  });
  const api = { fetchFollowing, isPrivateTarget };
  const read = async (p) => {
    let n = 0;
    for await (const c of await openInput(`${trickle.url}${p}`, { userAgent: 'x', what: 'guide', timeouts: { headers: 300, idle: 300 } }, api)) n += c.length;
    return n;
  };
  try {
    assert.ok((await read('/ok')) > 0, 'a guide sending for longer than the headers limit, with no long gap, is read');
    await assert.rejects(read('/stall'), /took too long/);
  } finally {
    await trickle.close();
  }
});

test('the summary counts TV channels without guide (radio isn\'t counted there)', async () => {
  const { source } = fakeApi({ playlist: playlistUrl(), guide: `${srv.url}/plain.xml` });
  await source.refresh(ctx());
  const text = source.settingsSummary();
  assert.match(text, /\d+ TV channels? without guide|^(?!.*without guide)/, text);
  assert.doesNotMatch(text, /\b\d+ channels? without guide/, 'not the old all-channels count');
});

test('a playlist whose only channels without guide are radio says nothing about a guide gap', async () => {
  const { source } = fakeApi({ playlist: `${srv.url}/radio.m3u`, guide: `${srv.url}/plain.xml` });
  await source.refresh(ctx());
  assert.doesNotMatch(source.settingsSummary(), /without guide/);
});
