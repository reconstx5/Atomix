// Online subtitle search/download (core API + the OpenSubtitles plugin),
// against a fake OpenSubtitles server. Written before the feature existed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startNodeFlix, client, waitForScan, fakeServer } from './helpers.js';
import { movieHash } from '../plugins/opensubtitles/index.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const calls = [];
let quotaLeft = 3;
let os; // fake OpenSubtitles
let nf;
let admin;
const ids = {};

const SRT = '1\n00:00:00,500 --> 00:00:02,000\nDownloaded line\n';

before(async () => {
  os = await fakeServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: u.pathname, query: u.search, headers: req.headers, body: body ? JSON.parse(body) : null });
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (u.pathname === '/api/v1/login') return send({ token: 'jwt-123', user: { allowed_downloads: 20 }, status: 200 });
    if (u.pathname === '/api/v1/subtitles') {
      return send({
        total_count: 2,
        data: [
          { id: '1', attributes: { language: 'en', download_count: 50, hearing_impaired: true, release: 'Heat.1995.HI', moviehash_match: false, files: [{ file_id: 111, file_name: 'heat.hi.srt' }] } },
          { id: '2', attributes: { language: 'en', download_count: 900, hearing_impaired: false, release: 'Heat.1995.1080p', moviehash_match: true, files: [{ file_id: 222, file_name: 'heat.srt' }] } },
        ],
      });
    }
    if (u.pathname === '/api/v1/download') {
      if (quotaLeft <= 0) return send({ message: 'You have downloaded your allowed 5 subtitles for 24h. Your quota will be renewed in 03 hours', remaining: 0, reset_time: '03 hours' }, 406);
      quotaLeft--;
      return send({ link: `${os.url}/files/${body && JSON.parse(body).file_id}.srt`, file_name: 'heat.srt', remaining: quotaLeft, reset_time: '23 hours' });
    }
    if (u.pathname.startsWith('/files/')) {
      res.writeHead(200, { 'content-type': 'application/x-subrip' });
      return res.end(SRT);
    }
    send({ message: 'not found' }, 404);
  });
  if (!hasFfmpeg) return;
  makeVideo(path.join(media, 'Movies', 'Heat (1995)', 'Heat (1995).mp4'), { seconds: 12 });
  fs.writeFileSync(path.join(media, 'Movies', 'Heat (1995)', 'Heat (1995).nfo'), '<movie><title>Heat</title><uniqueid type="tmdb">949</uniqueid><uniqueid type="imdb">tt0113277</uniqueid></movie>');
  nf = await startNodeFlix({ NODEFLIX_OPENSUBTITLES_BASE: `${os.url}/api/v1` });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123' });
  ids.lib = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data.id;
  await waitForScan(admin);
  ids.heat = (await admin.get(`/api/libraries/${ids.lib}/items`)).data.items[0].id;
});

after(async () => {
  await nf?.app.stop();
  await os?.close();
});

test('moviehash matches the OpenSubtitles algorithm', async () => {
  const dir = tempDir();
  const zero = path.join(dir, 'zero.bin');
  fs.writeFileSync(zero, Buffer.alloc(200000));
  assert.equal(await movieHash(zero), '0000000000030d40', 'all zeros → just the size');
  const one = path.join(dir, 'one.bin');
  const buf = Buffer.alloc(200000);
  buf.writeBigUInt64LE(1n, 0); // first chunk
  buf.writeBigUInt64LE(0xffffffffffffffffn, 200000 - 8); // last chunk (wraps around)
  fs.writeFileSync(one, buf);
  assert.equal(await movieHash(one), '0000000000030d40', '1 + (2^64 - 1) wraps to 0');
  const small = path.join(dir, 'small.bin');
  fs.writeFileSync(small, Buffer.alloc(1000));
  assert.equal(await movieHash(small), null, 'too small to hash');
});

test('no online search until a subtitle plugin is configured', { skip }, async () => {
  const r = await admin.get(`/api/items/${ids.heat}/subtitles/search?languages=en`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.providers, []);
  const pb = await admin.post(`/api/items/${ids.heat}/playback`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } });
  assert.deepEqual(pb.data.subtitleProviders, []);
});

test('search and download through OpenSubtitles', { skip }, async () => {
  let r = await admin.put('/api/admin/plugins/opensubtitles/config', { apiKey: 'KEY123', languages: 'en' });
  assert.equal(r.status, 200);
  r = await admin.post('/api/admin/plugins/opensubtitles/enabled', { enabled: true });
  assert.equal(r.data.loaded, true, r.data.error);

  const pb = await admin.post(`/api/items/${ids.heat}/playback`, { caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'] } });
  assert.deepEqual(pb.data.subtitleProviders.map((p) => p.id), ['opensubtitles/opensubtitles']);

  r = await admin.get(`/api/items/${ids.heat}/subtitles/search?languages=en`);
  assert.equal(r.status, 200);
  assert.equal(r.data.results.length, 2);
  assert.equal(r.data.results[0].id, '222', 'hash match and popularity first');
  assert.equal(r.data.results[0].hashMatch, true);
  assert.equal(r.data.results[1].hearingImpaired, true);

  const search = calls.find((c) => c.path === '/api/v1/subtitles');
  assert.equal(search.headers['api-key'], 'KEY123');
  assert.match(search.headers['user-agent'], /^NodeFlix v\d/);
  const params = new URLSearchParams(search.query);
  assert.equal(params.get('tmdb_id'), '949');
  assert.equal(params.get('languages'), 'en');
  assert.match(params.get('moviehash'), /^[0-9a-f]{16}$/);
  const keys = [...params.keys()];
  assert.deepEqual(keys, [...keys].sort(), 'parameters are sent in alphabetical order');

  r = await admin.post(`/api/items/${ids.heat}/subtitles/download`, { provider: 'opensubtitles/opensubtitles', id: '222' });
  assert.equal(r.status, 200);
  assert.equal(r.data.subtitle.language, 'en');
  assert.equal(r.data.subtitle.source, 'downloaded');
  const list = (await admin.get(`/api/items/${ids.heat}/subtitles`)).data;
  const dl = list.find((s) => s.source === 'downloaded');
  assert.ok(dl, 'shows up in the subtitle list');
  const vtt = await (await admin.raw(dl.url)).text();
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /Downloaded line/);
  assert.equal(calls.find((c) => c.path === '/api/v1/download').body.file_id, 222);
});

test('logs in when an OpenSubtitles account is set', { skip }, async () => {
  await admin.put('/api/admin/plugins/opensubtitles/config', { username: 'dallas', password: 'secret' });
  calls.length = 0;
  await admin.post(`/api/items/${ids.heat}/subtitles/download`, { provider: 'opensubtitles/opensubtitles', id: '111' });
  const login = calls.find((c) => c.path === '/api/v1/login');
  assert.deepEqual(login.body, { username: 'dallas', password: 'secret' });
  const dl = calls.find((c) => c.path === '/api/v1/download');
  assert.equal(dl.headers.authorization, 'Bearer jwt-123');
  const cfg = (await admin.get('/api/admin/plugins')).data.find((p) => p.id === 'opensubtitles').config;
  assert.equal(cfg.password, '••••••••', 'passwords are never sent back');
});

test('a used-up daily quota gives a clear message', { skip }, async () => {
  quotaLeft = 0;
  const r = await admin.post(`/api/items/${ids.heat}/subtitles/download`, { provider: 'opensubtitles/opensubtitles', id: '222' });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /allowed 5 subtitles/);
  quotaLeft = 5;
});

test('downloaded subtitles can be removed by an admin', { skip }, async () => {
  const list = (await admin.get(`/api/items/${ids.heat}/subtitles`)).data.filter((s) => s.source === 'downloaded');
  const r = await admin.del(`/api/items/${ids.heat}/subtitles/${list[0].id}`);
  assert.equal(r.status, 200);
  const after = (await admin.get(`/api/items/${ids.heat}/subtitles`)).data.filter((s) => s.source === 'downloaded');
  assert.equal(after.length, list.length - 1);
});

test('new titles get subtitles automatically when enabled', { skip }, async () => {
  await admin.put('/api/admin/plugins/opensubtitles/config', { autoDownload: true, languages: 'en' });
  makeVideo(path.join(media, 'Movies', 'Sequel (2001)', 'Sequel (2001).mp4'), { seconds: 12 });
  await admin.post(`/api/libraries/${ids.lib}/scan`, {});
  await waitForScan(admin);
  const sequel = (await admin.get(`/api/libraries/${ids.lib}/items`)).data.items.find((i) => i.title === 'Sequel');
  let subs = [];
  for (let i = 0; i < 50 && !subs.length; i++) {
    subs = (await admin.get(`/api/items/${sequel.id}/subtitles`)).data.filter((s) => s.source === 'downloaded');
    if (!subs.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(subs.length, 1);
  assert.equal(subs[0].language, 'en');
  // Heat already has English subtitles, so it wasn't downloaded again.
  const heatSubs = (await admin.get(`/api/items/${ids.heat}/subtitles`)).data.filter((s) => s.source === 'downloaded');
  assert.equal(heatSubs.length, 1);
});
