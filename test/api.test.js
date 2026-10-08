// End-to-end API test: starts a real server on a random port with a temporary
// data folder, generates a few tiny videos with ffmpeg (if installed), and
// talks to it over HTTP like the web app does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atomix-test-'));
const mediaDir = path.join(tmp, 'media');
let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

function makeVideo(file, { vcodec = 'libx264', acodec = 'aac', seconds = 4 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=24:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', vcodec, '-pix_fmt', 'yuv420p', '-c:a', acodec, '-shortest', file]);
}

// A pretend TMDB so metadata can be tested offline.
const tmdb = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (d, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (u.pathname === '/3/search/movie') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return send({ results: q.includes('heat') ? [{ id: 11, title: 'Heat', release_date: '1995-12-15', overview: 'LA heist.', poster_path: null }] : [] });
  }
  if (u.pathname === '/3/movie/11') return send({ id: 11, title: 'Heat', release_date: '1995-12-15', overview: 'LA heist.', genres: [{ name: 'Crime' }], runtime: 170, vote_average: 8.3, tagline: 'A Los Angeles crime saga' });
  if (u.pathname === '/3/movie/22') return send({ id: 22, title: 'Heat (Fixed)', release_date: '1995-12-15', overview: 'Fixed match.', genres: [], runtime: 170 });
  if (u.pathname === '/3/search/tv') return send({ results: [{ id: 33, name: 'Demo Show', first_air_date: '2022-01-01' }] });
  if (u.pathname === '/3/tv/33') return send({ id: 33, name: 'Demo Show', first_air_date: '2022-01-01', overview: 'A show.', genres: [{ name: 'Drama' }] });
  if (u.pathname === '/3/tv/33/season/1') return send({ overview: 'S1', episodes: [{ episode_number: 1, name: 'Pilot from TMDB', overview: 'First.' }, { episode_number: 2, name: 'Second', overview: '2nd' }] });
  send({}, 404);
});

let app;
let base;
let cookie = '';
async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const set = res.headers.get('set-cookie');
  if (set && !headers.cookie) cookie = set.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, res };
}
const waitForScan = async () => {
  for (let i = 0; i < 100; i++) {
    const s = (await call('GET', '/api/scan/status')).data;
    if (!s.running && !s.queued) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

before(async () => {
  if (hasFfmpeg) {
    makeVideo(path.join(mediaDir, 'Movies', 'Heat (1995)', 'Heat.1995.1080p.mp4'));
    makeVideo(path.join(mediaDir, 'Movies', 'Other.Movie.2001.mkv'), { acodec: 'ac3' });
    makeVideo(path.join(mediaDir, 'TV', 'Demo Show', 'Season 01', 'Demo.Show.S01E01.mkv'));
    makeVideo(path.join(mediaDir, 'TV', 'Demo Show', 'Season 01', 'Demo.Show.S01E02.mkv'));
    fs.writeFileSync(path.join(mediaDir, 'TV', 'Demo Show', 'Season 01', 'Demo.Show.S01E01.en.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello\n');
  } else {
    fs.mkdirSync(path.join(mediaDir, 'Movies'), { recursive: true });
    fs.mkdirSync(path.join(mediaDir, 'TV'), { recursive: true });
  }
  await new Promise((r) => tmdb.listen(0, '127.0.0.1', r));
  process.env.ATOMIX_DATA_DIR = path.join(tmp, 'data');
  process.env.ATOMIX_TMDB_BASE = `http://127.0.0.1:${tmdb.address().port}/3`;
  process.env.TMDB_API_KEY = '0123456789abcdef0123456789abcdef';
  const { createApp } = await import('../src/app.js');
  app = await createApp({ port: 0, host: '127.0.0.1', skipStartupScan: true, logLevel: 'error', trustProxy: true });
  const addr = await app.start();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app?.stop();
  tmdb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('first-run setup, sign-in and protection', async () => {
  let r = await call('GET', '/api/status');
  assert.equal(r.data.setupRequired, true);
  assert.equal(r.data.setupCodeRequired, false, 'loopback does not need a code');

  // From "another device" (proxy header), a setup code is required.
  r = await call('POST', '/api/setup', { username: 'admin', password: 'password123' }, { 'x-forwarded-for': '203.0.113.9', cookie: '' });
  assert.equal(r.status, 403);

  r = await call('POST', '/api/setup', { username: 'admin', password: 'short' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/setup', { username: 'admin', password: 'password123', serverName: 'Test' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
  r = await call('POST', '/api/setup', { username: 'again', password: 'password123' });
  assert.equal(r.status, 409);

  assert.equal((await fetch(base + '/api/libraries')).status, 401, 'needs a session');
  const csrf = await fetch(base + '/api/scan', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' } });
  assert.equal(csrf.status, 415);
  const cross = await fetch(base + '/api/scan', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);

  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' }, { cookie: '' });
  assert.equal(r.status, 401);
});

test('libraries, scanning and metadata', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  let r = await call('POST', '/api/libraries', { name: 'Movies', type: 'movies', paths: ['relative/path'] });
  assert.equal(r.status, 400);
  const movies = await call('POST', '/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(mediaDir, 'Movies')] });
  const tv = await call('POST', '/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(mediaDir, 'TV')] });
  assert.equal(movies.status, 200);
  await waitForScan();

  r = await call('GET', `/api/libraries/${movies.data.id}/items`);
  assert.deepEqual(r.data.items.map((i) => i.title).sort(), ['Heat', 'Other Movie']);
  const heat = r.data.items.find((i) => i.title === 'Heat');
  assert.ok(heat, 'Heat was matched');
  const detail = await call('GET', `/api/items/${heat.id}`);
  assert.equal(detail.data.item.tagline, 'A Los Angeles crime saga');
  assert.deepEqual(detail.data.item.genres, ['Crime']);
  assert.equal(detail.data.item.media.videoCodec, 'h264');

  r = await call('GET', `/api/libraries/${tv.data.id}/items`);
  assert.equal(r.data.items.length, 1);
  const show = await call('GET', `/api/items/${r.data.items[0].id}`);
  assert.equal(show.data.seasons.length, 1);
  const season = await call('GET', `/api/items/${show.data.seasons[0].id}`);
  assert.deepEqual(season.data.episodes.map((e) => e.title), ['Pilot from TMDB', 'Second']);

  // Fix match pins a different TMDB id.
  r = await call('POST', `/api/items/${heat.id}/identify`, { tmdbId: 22 });
  assert.equal(r.data.title, 'Heat (Fixed)');
});

test('playback decisions, streaming, subtitles and progress', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const libs = (await call('GET', '/api/libraries')).data;
  const movieLib = libs.find((l) => l.type === 'movies');
  const items = (await call('GET', `/api/libraries/${movieLib.id}/items`)).data.items;
  const mp4 = items.find((i) => i.year === 1995);
  const mkv = items.find((i) => i.year === 2001);
  const caps = { video: ['h264'], audio: ['aac', 'mp3'], containers: ['mp4'] };

  let r = await call('POST', `/api/items/${mp4.id}/playback`, { caps });
  assert.equal(r.data.mode, 'direct');
  const range = await fetch(base + r.data.url, { headers: { cookie, range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);

  r = await call('POST', `/api/items/${mkv.id}/playback`, { caps });
  assert.equal(r.data.mode, 'remux');
  assert.equal(r.data.delivery, 'progressive');
  const stream = await fetch(base + r.data.url, { headers: { cookie } });
  assert.equal(stream.headers.get('content-type'), 'video/mp4');
  const bytes = Buffer.from(await stream.arrayBuffer());
  assert.ok(bytes.length > 1000, 'got video data');
  assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');

  // Another user can't use this session.
  await call('POST', '/api/users', { username: 'viewer', password: 'password123' });
  const other = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'password123' }) });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + r.data.url, { headers: { cookie: otherCookie } })).status, 403);
  assert.equal((await fetch(base + '/api/users', { headers: { cookie: otherCookie } })).status, 403, 'viewers are not admins');

  // HLS for Safari
  r = await call('POST', `/api/items/${mkv.id}/playback`, { caps: { ...caps, hls: true } });
  assert.equal(r.data.delivery, 'hls');
  const playlist = await (await fetch(base + r.data.url, { headers: { cookie } })).text();
  assert.match(playlist, /#EXTM3U/);
  assert.match(playlist, /seg\d+\.m4s/);

  // Sidecar subtitles on the episode
  const tvLib = libs.find((l) => l.type === 'tv');
  const show = (await call('GET', `/api/libraries/${tvLib.id}/items`)).data.items[0];
  const season = (await call('GET', `/api/items/${show.id}`)).data.seasons[0];
  const ep1 = (await call('GET', `/api/items/${season.id}`)).data.episodes[0];
  const epDetail = (await call('GET', `/api/items/${ep1.id}`)).data;
  assert.equal(epDetail.subtitles[0].language, 'en');
  const vtt = await (await fetch(base + epDetail.subtitles[0].url, { headers: { cookie } })).text();
  assert.match(vtt, /00:00:00\.500 --> 00:00:02\.000/);
  assert.equal(epDetail.nextEpisode.episode, 2);

  // Progress → continue watching → watched
  await call('POST', `/api/items/${mp4.id}/progress`, { position: 60, duration: 600 });
  let home = (await call('GET', '/api/home')).data;
  assert.equal(home.rows[0].id, 'continue');
  assert.equal(home.rows[0].items[0].id, mp4.id);
  r = await call('POST', `/api/items/${mp4.id}/playback`, { caps, resume: true });
  assert.equal(r.data.resumed, true);
  assert.equal(r.data.start, 60);
  await call('POST', `/api/items/${mp4.id}/progress`, { position: 590, duration: 600 });
  home = (await call('GET', '/api/home')).data;
  assert.ok(!home.rows.find((row) => row.id === 'continue')?.items.some((i) => i.id === mp4.id));

  // Mark a whole show watched
  await call('POST', `/api/items/${show.id}/watched`, { watched: true });
  const after = (await call('GET', `/api/libraries/${tvLib.id}/items`)).data.items[0];
  assert.equal(after.unwatched, 0);

  // Search
  const s = (await call('GET', '/api/search?q=demo')).data;
  assert.equal(s.shows[0].id, show.id);
});

test('plugins load and can be toggled', async () => {
  const list = (await call('GET', '/api/admin/plugins')).data;
  const ids = list.map((p) => p.id).sort();
  for (const id of ['internet-archive', 'nfo-metadata', 'random-picks', 'opensubtitles']) assert.ok(ids.includes(id), id);
  assert.ok(list.filter((p) => p.enabled).every((p) => p.loaded), JSON.stringify(list.map((p) => [p.id, p.error])));
  assert.equal(list.find((p) => p.id === 'opensubtitles').enabled, false, 'needs an API key first, so it starts off');
  let r = await call('GET', '/api/plugins/random-picks/surprise');
  assert.equal(r.status, 200);
  await call('POST', '/api/admin/plugins/random-picks/enabled', { enabled: false });
  r = await call('GET', '/api/plugins/random-picks/surprise');
  assert.equal(r.status, 404, 'routes disappear when disabled');
  await call('POST', '/api/admin/plugins/random-picks/enabled', { enabled: true });
  r = await call('PUT', '/api/admin/plugins/random-picks/config', { title: 'Try this' });
  assert.equal(r.data.config.title, 'Try this');
  const sources = (await call('GET', '/api/sources')).data;
  assert.equal(sources[0].pluginId, 'internet-archive');
});

test('settings hide secrets and themes are listed', async () => {
  const s = (await call('GET', '/api/admin/settings')).data;
  assert.match(s.tmdbApiKey, /^•+cdef$/);
  await call('PUT', '/api/admin/settings', { tmdbApiKey: s.tmdbApiKey, serverName: 'Renamed' });
  const again = (await call('GET', '/api/admin/settings')).data;
  assert.equal(again.tmdbApiKey, s.tmdbApiKey, 'masked value is not saved over the real key');
  assert.equal(again.serverName, 'Renamed');
  const themeList = (await call('GET', '/api/themes')).data;
  const themes = themeList.map((t) => t.id);
  for (const id of ['orbit', 'arctic', 'arctic-side', 'midnight', 'harbour', 'daylight', 'obsidian']) assert.ok(themes.includes(id), id);
  // Orbit is the default look: a full-screen page with a floating glass menu (its own layout).
  assert.equal((await call('GET', '/api/status')).data.defaultTheme, 'orbit');
  assert.equal(themeList.find((t) => t.id === 'orbit').layout, 'orbit');
  assert.equal(themeList.find((t) => t.id === 'arctic').layout, 'top');
  assert.equal(themeList.find((t) => t.id === 'arctic-side').layout, 'side');
  // The typefaces ship with Atomix (no internet needed), with their licences alongside.
  for (const f of ['roboto-condensed-latin.woff2', 'sora-latin-400.woff2', 'sora-latin-ext-700.woff2']) {
    const font = await fetch(base + '/fonts/' + f);
    assert.equal(font.status, 200, f);
    assert.equal(font.headers.get('content-type'), 'font/woff2', f);
  }
  for (const f of ['OFL.txt', 'OFL-sora.txt']) assert.equal((await fetch(base + '/fonts/' + f)).status, 200, f);
  for (const t of themeList) assert.equal((await fetch(base + t.css)).status, 200, `${t.id} stylesheet`);
  const index = await fetch(base + '/library/1');
  assert.equal(index.status, 200, 'SPA fallback');
  assert.equal((await fetch(base + '/themes/../package.json')).status, 404);
  // "Ask who's watching after": 30 minutes by default; only the five choices are kept.
  assert.equal((await call('GET', '/api/status')).data.pickerIdleMinutes, 30);
  for (const v of [0, 15, 30, 60, 240]) {
    await call('PUT', '/api/admin/settings', { pickerIdleMinutes: v });
    assert.equal((await call('GET', '/api/status')).data.pickerIdleMinutes, v, String(v));
  }
  for (const bad of [7, -1, 'soon', null]) {
    await call('PUT', '/api/admin/settings', { pickerIdleMinutes: bad });
    assert.equal((await call('GET', '/api/status')).data.pickerIdleMinutes, 30, String(bad));
  }
});
