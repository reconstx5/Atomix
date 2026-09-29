// Seek-bar previews: the layout maths, which tile shows which moment, and a real
// ffmpeg run (with a file name that would break shell quoting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir } from './helpers.js';
import { planPreviews, generatePreviews, removePreviews } from '../src/extras/previews.js';
import { tileFor } from '../public/js/previews.js';

test('5-second steps under 20 minutes, 10 after, and the tile keeps the picture shape', () => {
  assert.deepEqual(planPreviews(130, { width: 1920, height: 1080 }), { interval: 5, width: 320, height: 180, columns: 10, rows: 10, count: 26, sheets: 1 });
  const film = planPreviews(7200, { width: 3840, height: 1600 });
  assert.deepEqual([film.interval, film.height, film.count, film.sheets], [10, 134, 720, 8]);
  assert.equal(planPreviews(1200, { width: 1280, height: 720 }).interval, 10);
});

test('very short or picture-less titles', () => {
  assert.deepEqual(planPreviews(3, { width: 640, height: 480 }), { interval: 5, width: 320, height: 240, columns: 10, rows: 10, count: 1, sheets: 1 });
  assert.equal(planPreviews(0, { width: 640, height: 480 }), null);
  assert.equal(planPreviews(null, { width: 640, height: 480 }), null);
  assert.equal(planPreviews(100, null), null);
  assert.equal(planPreviews(100, { width: 0, height: 0 }), null);
});

test('the tile for a moment in time', () => {
  const m = { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 250, sheets: 3, url: '/api/items/7/previews/{n}?v=1' };
  assert.deepEqual(tileFor(m, 0), { url: '/api/items/7/previews/1?v=1', x: 0, y: 0, width: 320, height: 180, sheetWidth: 3200, sheetHeight: 1800 });
  assert.equal(tileFor(m, 14).x, 320, 'nearest tile');
  const lastOfFirst = tileFor(m, 994);
  assert.deepEqual([lastOfFirst.url.slice(-6), lastOfFirst.x, lastOfFirst.y], ['/1?v=1', 2880, 1620]);
  const firstOfSecond = tileFor(m, 995);
  assert.deepEqual([firstOfSecond.url.slice(-6), firstOfSecond.x, firstOfSecond.y], ['/2?v=1', 0, 0]);
  const end = tileFor(m, 99999);
  assert.deepEqual([end.url.slice(-6), end.x, end.y], ['/3?v=1', 2880, 720], 'clamped to the last tile');
  assert.equal(tileFor(m, -5).x, 0);
  assert.equal(tileFor(null, 5), null);
});

test('makes sheets for a real video with an awkward file name', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tempDir();
  const file = path.join(tempDir(), "Bob's Whānau Film (2020) [1080p].mp4");
  // 20 minutes 10 seconds at 2 fps with a keyframe every 5 s: quick to make, 121 tiles → 2 sheets.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=2:duration=1210', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', file]);
  const spawned = [];
  const layout = await generatePreviews({ ffmpegPath: 'ffmpeg', dir, item: { id: 42, path: file, duration: 1210 }, media: { video: { width: 160, height: 90, hdr: false } }, onSpawn: (p) => spawned.push(p.pid) });
  assert.deepEqual(layout, { interval: 10, width: 320, height: 180, columns: 10, rows: 10, count: 121, sheets: 2 });
  assert.equal(spawned.length, 1, 'onSpawn saw the ffmpeg process');
  assert.deepEqual(fs.readdirSync(path.join(dir, '42')).sort(), ['1.jpg', '2.jpg']);
  assert.ok(!fs.existsSync(path.join(dir, '42.tmp')), 'temp folder swapped in');
  const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, '42', '1.jpg')]).toString().trim();
  assert.equal(size, '3200,1800');
  removePreviews(dir, 42);
  assert.ok(!fs.existsSync(path.join(dir, '42')));
});

test('a broken file fails cleanly', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tempDir();
  const file = path.join(tempDir(), 'broken.mp4');
  fs.writeFileSync(file, 'not a video');
  await assert.rejects(generatePreviews({ ffmpegPath: 'ffmpeg', dir, item: { id: 5, path: file, duration: 60 }, media: { video: { width: 160, height: 90 } } }), /ffmpeg exited/);
  assert.deepEqual(fs.readdirSync(dir), [], 'no half-written folders left behind');
});

// A picture that gets brighter every half second (every frame a keyframe), so brightness tells the time.
const RAMP = "nullsrc=s=160x90:r=2:d=60,format=gray,geq=lum='4*T'";

async function checkTileTimes(file) {
  const dir = tempDir();
  const layout = await generatePreviews({ ffmpegPath: 'ffmpeg', dir, item: { id: 9, path: file, duration: 60 }, media: { video: { width: 160, height: 90 } } });
  const brightness = (input, crop) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-vf', `${crop ? `crop=${crop},` : ''}scale=1:1:flags=area,format=gray`, '-f', 'rawvideo', '-'])[0];
  for (const k of [2, 5, 10]) {
    const t = k * layout.interval;
    const ref = path.join(dir, `ref-${t}.jpg`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${layout.width}:${layout.height}`, ref]);
    const tile = brightness(path.join(dir, '9', '1.jpg'), `${layout.width}:${layout.height}:${(k % 10) * layout.width}:${Math.floor(k / 10) * layout.height}`);
    const expected = brightness(ref);
    assert.ok(Math.abs(tile - expected) <= 3, `tile ${k} should look like ${t}s (brightness ${expected}), got ${tile}`);
  }
}

test('each tile shows the moment it stands for, not a later one', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const file = path.join(tempDir(), 'ramp.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', RAMP, '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', file]);
  await checkTileTimes(file);
});

test('tiles stay in step when the audio starts a moment before the picture', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  // Common in real files: Opus (and AAC) audio carries priming, so the file starts at −0.007 s and ffmpeg
  // puts the first picture at +0.007 s. Without care, every tile then slips one slot late.
  const file = path.join(tempDir(), 'ramp-opus.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', RAMP, '-f', 'lavfi', '-i', 'sine=duration=60', '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-ar', '48000', file]);
  await checkTileTimes(file);
});
