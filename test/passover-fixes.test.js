// Plan A review fixes: the fontsdir escape runs through real ffmpeg, silent videos still remux, the remux keyframe
// lands on the right frame for non-millisecond timestamps, kids on an admin account get the scan stub, one ffmpeg
// extracts every embedded track, libplacebo counts only when it runs, Dolby Vision 5 is converted even without
// a PQ tag, a cast restart doesn't count its own old stream, mapped IPv6 link-local is refused, and more.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { decide, buildFfmpegArgs, fontsDirArg, PlaybackManager } from '../src/stream/playback.js';
import { keyframeAtOrBefore } from '../src/stream/keyframes.js';
import { detectTools, summarise } from '../src/library/probe.js';
import { isPrivateTarget } from '../src/http/net.js';
import { readBody } from '../src/http/router.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const chrome = { video: ['h264', 'vp9'], audio: ['aac', 'mp3', 'opus'], containers: ['mp4', 'webm'], hls: false, hdr: false };
let dir;
before(() => { dir = tempDir(); });

test('the fontsdir escape survives ffmpeg\'s filter parsing (a folder with a colon in its name)', { skip }, () => {
  const fonts = path.join(dir, 'fo:nt');
  fs.mkdirSync(fonts, { recursive: true });
  fs.writeFileSync(path.join(dir, 'w.vtt'), 'WEBVTT\n\n00:00.000 --> 00:00.100\nhi\n');
  const arg = fontsDirArg('linux', fonts);
  assert.equal(arg, `:fontsdir=${fonts.replace(':', '\\\\:')}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=16x16:d=0.1', '-vf', `subtitles=filename=w.vtt${arg}`, '-f', 'null', '-'], { cwd: dir });
  assert.match(fontsDirArg('win32', null, { WINDIR: 'D:\\Win' }), /^:fontsdir=D\\\\:\/Win\/Fonts$/);
});

test('a video with no audio stream still remuxes and transcodes', { skip }, async () => {
  const silent = path.join(dir, 'silent.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', silent]);
  const media = { container: 'matroska', duration: 1, video: { codec: 'h264', width: 160, height: 90, bitDepth: 8, hdr: false, fps: 24 }, audio: [], subtitles: [] };
  const plan = decide({ file: silent, media, caps: chrome, quality: 'original', transcodingEnabled: true });
  assert.equal(plan.mode, 'remux');
  const args = buildFfmpegArgs({ ...plan, file: silent, start: 0, media, quality: 'original' }, { hwAccel: 'none' }, { type: 'progressive' });
  assert.ok(!args.join(' ').includes('0:a:'), 'no audio map for a silent file');
  const out = path.join(dir, 'silent-out.mp4');
  const i = args.indexOf('pipe:1'); args[i] = out; args.splice(i, 0, '-y');
  execFileSync('ffmpeg', args);
  assert.ok(fs.statSync(out).size > 0);
  const t = decide({ file: silent, media, caps: chrome, quality: 'original', transcodingEnabled: true, forceTranscode: true });
  assert.ok(!buildFfmpegArgs({ ...t, file: silent, start: 0, media, quality: 'original' }, { hwAccel: 'none' }, { type: 'progressive' }).join(' ').includes('0:a:'));
});

test('keyframeAtOrBefore rounds up to the millisecond so -ss lands on that keyframe (MP4 at 23.976 fps)', { skip }, async () => {
  const mp4 = path.join(dir, 'ntsc.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24000/1001:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-bf', '0', '-an', mp4]);
  const kf = await keyframeAtOrBefore('ffprobe', mp4, 5);
  assert.ok(kf > 4.17 && kf < 4.18, String(kf)); // frame 100 at 4.1708 s, rounded up
  // What ffmpeg's -ss does with -c:v copy: start at the keyframe at or before the time. Rounded up, that is this one.
  const copied = path.join(dir, 'ntsc-seek.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(kf), '-i', mp4, '-c:v', 'copy', '-f', 'mp4', copied]);
  const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', copied]).toString().trim());
  const total = Math.round(12 * 24000 / 1001);
  assert.ok(Math.abs(frames - (total - 100)) <= 1, `copy from ${kf} kept ${frames} of ${total} frames (expected ${total - 100})`);
});

test('a kids profile on an admin account gets the scan stub', { skip }, async () => {
  const media = path.join(dir, 'lib');
  fs.mkdirSync(media, { recursive: true });
  makeVideo(path.join(media, 'Film (2020).mp4'), { seconds: 1 });
  const nf = await startAtomix();
  try {
    await nf.app.core.tasks.stop();
    const admin = client(nf.base);
    await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
    const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
    const kid = client(nf.base);
    await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
    await kid.post(`/api/profiles/${mia.id}/select`, {});
    assert.deepEqual(Object.keys((await kid.get('/api/scan/status')).data), ['running']);
    assert.ok('phase' in (await admin.get('/api/scan/status')).data);
  } finally {
    await nf.app.stop();
  }
});

test('the subtitles job extracts every embedded track with one ffmpeg run', { skip }, async () => {
  const media = path.join(dir, 'subs');
  fs.mkdirSync(media, { recursive: true });
  const plain = path.join(dir, 'p.mp4');
  makeVideo(plain, { seconds: 2 });
  for (const [n, t] of [['a', 'One'], ['b', 'Two'], ['c', 'Three']]) fs.writeFileSync(path.join(dir, `${n}.srt`), `1\n00:00:00,500 --> 00:00:01,000\n${t}\n`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', plain, '-i', path.join(dir, 'a.srt'), '-i', path.join(dir, 'b.srt'), '-i', path.join(dir, 'c.srt'), '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c', 'copy', '-c:s', 'srt', path.join(media, 'Three Tracks (2020).mkv')]);
  const log = path.join(dir, 'spawns.log');
  const shim = path.join(dir, 'ffmpeg-shim.sh');
  fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${log}"\nexec ffmpeg "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const nf = await startAtomix({ ATOMIX_FFMPEG: shim });
  try {
    await nf.app.core.tasks.stop();
    const admin = client(nf.base);
    await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
    await admin.put('/api/admin/settings', { previewsEnabled: false, introDetection: false });
    await admin.post('/api/libraries', { name: 'S', type: 'movies', paths: [media] });
    await admin.post('/api/scan', {});
    await waitForScan(admin);
    const runner = nf.app.core.tasks;
    const task = runner.next();
    assert.equal(task?.job, 'subtitles');
    fs.writeFileSync(log, '');
    await runner.jobs.subtitles(task.item, { signal: null });
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => /webvtt/.test(l));
    assert.equal(runs.length, 1, 'one ffmpeg for three tracks');
    const cached = fs.readdirSync(path.join(nf.app.core.config.cacheDir, 'subs')).filter((f) => f.startsWith(`${task.item.id}-`));
    assert.equal(cached.length, 3);
    const subs = (await admin.get(`/api/items/${task.item.id}/subtitles`)).data.filter((s) => s.source === 'embedded');
    const r = await admin.raw(subs[2].url);
    assert.match(await r.text(), /Three/);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => /webvtt/.test(l)).length, 1, 'served from the cache');
  } finally {
    await nf.app.stop();
  }
});

test('libplacebo counts only when it can actually run (no Vulkan here → false)', { skip }, async () => {
  const tools = await detectTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  assert.equal(typeof tools.filters.libplacebo, 'boolean');
  const listed = /\slibplacebo\s/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString());
  let works = false;
  try { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=d=0.1:size=16x16', '-vf', 'libplacebo=format=yuv420p', '-f', 'null', '-'], { stdio: 'ignore' }); works = true; } catch { works = false; }
  assert.equal(tools.filters.libplacebo, listed && works);
});

test('Dolby Vision profile 5 is converted even when the base layer carries no PQ tag', () => {
  const media = { container: 'matroska', duration: 100, video: { codec: 'hevc', width: 1920, height: 1080, bitDepth: 10, hdr: false, fps: 24, dolbyVision: { profile: 5 }, colour: {} }, audio: [{ index: 0, codec: 'aac', channels: 2, default: true }], subtitles: [] };
  const tools = { ffmpeg: { available: true, major: 7 }, filters: { zscale: true, tonemap: true, libplacebo: true } };
  const plan = decide({ file: 'a.mkv', media, caps: { ...chrome, video: ['h264', 'hevc'] }, quality: 'original', transcodingEnabled: true, tools });
  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.hdrFilter, 'libplacebo');
  assert.throws(() => decide({ file: 'a.mkv', media, caps: { ...chrome, video: ['h264', 'hevc'] }, quality: 'original', transcodingEnabled: true, tools: { ...tools, filters: { zscale: true, tonemap: true, libplacebo: false } } }), (e) => e.status === 422);
});

test('a restart that replaces its own stream is not counted against the caps', { skip }, async () => {
  const config = { transcodeDir: path.join(dir, 'tc'), ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
  const settings = { all: () => ({ transcodingEnabled: true, hwAccel: 'none' }), get: (k) => (k === 'maxTranscodes' ? 1 : null) };
  const pm = new PlaybackManager({ db: null, config, settings, hooks: { emit() {} }, tools: () => ({ ffmpeg: { available: true, major: 7 }, filters: {} }) });
  const media = { container: 'matroska', duration: 10, video: { codec: 'h264', width: 160, height: 90, bitDepth: 8, hdr: false, fps: 24 }, audio: [], subtitles: [] };
  const item = { id: 1, kind: 'movie', title: 'x', path: path.join(dir, 'silent.mkv'), media: JSON.stringify(media) };
  const user = { id: 1, username: 'd' };
  const old = (await pm.create({ user, profile: null, item, caps: chrome, start: 0 })).session;
  old.proc = { killed: false }; // the TV is still fetching it
  for (let i = 0; i < 3; i++) pm.sessions.set(`u1-${i}`, { id: `u1-${i}`, userId: 1, proc: null, mode: 'direct' });
  await assert.rejects(pm.create({ user, profile: null, item, caps: chrome, start: 0 }), (e) => e.status === 429);
  const fresh = (await pm.create({ user, profile: null, item, caps: chrome, start: 2, keepUntilLoaded: old.id })).session;
  assert.ok(fresh.id !== old.id);
  assert.doesNotThrow(() => pm.checkCapacity(fresh), 'the stream being replaced is not counted');
  for (const s of [...pm.sessions.values()]) pm.sessions.delete(s.id);
});

test('isPrivateTarget catches the IPv4-mapped IPv6 spelling of link-local and the unspecified address', () => {
  assert.equal(isPrivateTarget('http://[::ffff:169.254.169.254]/'), true);
  assert.equal(isPrivateTarget('http://[::ffff:0.0.0.0]/'), true);
  assert.equal(isPrivateTarget('http://[::ffff:192.168.1.5]/'), false);
  assert.equal(isPrivateTarget('http://192.168.1.5:8096/'), false);
});

test('bitDepth ignores pixel formats whose digits are not a depth (nv12, rgb24)', () => {
  const v = (pix_fmt) => summarise({ format: {}, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 16, height: 16, pix_fmt }] }).video.bitDepth;
  assert.equal(v('nv12'), 8);
  assert.equal(v('rgb24'), 8);
  assert.equal(v('yuv420p10le'), 10);
  assert.equal(v('gbrp16le'), 16);
});

test('after a 408 Atomix closes the connection once the answer is out, even if the body keeps trickling', { skip }, async () => {
  const nf = await startAtomix({}, { bodyTimeoutMs: 100 });
  try {
    const port = Number(new URL(nf.base).port);
    const result = await new Promise((resolve) => {
      let status = null;
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/setup', headers: { 'content-type': 'application/json', 'content-length': '1000' } }, (res) => {
        status = res.statusCode;
        res.resume();
        res.on('close', () => resolve({ status, closed: true }));
      });
      req.on('error', () => resolve({ status, closed: true }));
      req.write('{"a":');
      const t = setInterval(() => { try { req.write('1'); } catch { clearInterval(t); } }, 50);
      setTimeout(() => { clearInterval(t); resolve({ status, closed: false }); }, 3000);
    });
    assert.equal(result.status, 408);
    assert.equal(result.closed, true, 'the socket was closed by the server');
  } finally {
    await nf.app.stop();
  }
});

test('4K at 60 fps asks for level 5.2', () => {
  const media = { container: 'matroska', duration: 100, video: { codec: 'hevc', width: 3840, height: 2160, bitDepth: 8, hdr: false, fps: 60 }, audio: [{ index: 0, codec: 'aac', channels: 2, default: true }], subtitles: [] };
  const plan = decide({ file: 'a.mkv', media, caps: chrome, quality: 'original', transcodingEnabled: true });
  assert.match(buildFfmpegArgs({ ...plan, file: 'a.mkv', start: 0, media, quality: 'original' }, { hwAccel: 'nvenc' }, { type: 'progressive' }).join(' '), /-level:v 5\.2|nvenc/);
  assert.match(buildFfmpegArgs({ ...plan, file: 'a.mkv', start: 0, media, quality: 'original' }, { hwAccel: 'none', maxSoftwareHeight: 2160 }, { type: 'progressive' }).join(' '), /-level:v 5\.2/);
});

test('checkResolved refuses names that resolve to link-local or the unspecified address', async () => {
  const { checkResolved } = await import('../src/http/net.js');
  const lookup = async (h) => ({ 'meta.example': [{ address: '169.254.169.254', family: 4 }], 'zero.example': [{ address: '0.0.0.0', family: 4 }], 'v6.example': [{ address: 'fe80::1', family: 6 }], 'lan.example': [{ address: '192.168.1.5', family: 4 }] })[h] || [{ address: '93.184.216.34', family: 4 }];
  for (const bad of ['http://meta.example/x', 'http://zero.example/x', 'http://v6.example/x', 'http://169.254.169.254/x']) await assert.rejects(checkResolved(bad, { lookup }), (e) => e.code === 'EPRIVATE', bad);
  await checkResolved('http://lan.example/x', { lookup }); // the home network is fine (a tuner, a NAS)
  await checkResolved('https://cdn.example/x', { lookup });
});

test('the image cache refuses an image whose host resolves to a link-local address', async () => {
  const { ImageCache } = await import('../src/library/images.js');
  let hits = 0;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const srv = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const imagesDir = tempDir();
    const cache = new ImageCache({ imagesDir, lookup: async () => [{ address: '169.254.169.254', family: 4 }] });
    assert.equal(await cache.download(`http://localhost:${srv.address().port}/x.png`), null);
    assert.equal(hits, 0, 'never fetched');
  } finally {
    srv.close();
  }
});

test('the image cache refuses an image over 10 MB (with or without a length)', async () => {
  const { ImageCache } = await import('../src/library/images.js');
  const big = Buffer.alloc(11 * 1024 * 1024, 1);
  const srv = http.createServer((req, res) => {
    if (req.url === '/len.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': big.length });
      return res.end(big);
    }
    res.writeHead(200, { 'content-type': 'image/png' }); // chunked: no length
    res.end(big);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const imagesDir = tempDir();
    const cache = new ImageCache({ imagesDir });
    const base = `http://127.0.0.1:${srv.address().port}`;
    assert.equal(await cache.download(`${base}/len.png`), null);
    assert.equal(await cache.download(`${base}/chunked.png`), null);
    assert.deepEqual(fs.readdirSync(imagesDir), [], 'nothing kept');
  } finally {
    srv.close();
  }
});
