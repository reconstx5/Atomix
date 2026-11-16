// v0.15.0 probe: bit depth from the pixel format, rotation, Dolby Vision, chapters and the default audio track in
// one ffprobe run; previews and intro fingerprints read them; run() refuses to truncate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { summarise, run, parseVersion } from '../src/library/probe.js';
import { planPreviews, previewArgs } from '../src/extras/previews.js';
import { fingerprintArgs } from '../src/extras/intros.js';
import { albumArtArgs } from '../src/library/scanner.js';

const fixture = {
  format: { format_name: 'matroska,webm', duration: '7200.5', bit_rate: '20000000', tags: {} },
  streams: [
    {
      index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', width: 3840, height: 2160, pix_fmt: 'yuv420p12le',
      avg_frame_rate: '24000/1001', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc',
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }, { side_data_type: 'DOVI configuration record', dv_profile: 5, dv_level: 6 }],
      disposition: { default: 1, attached_pic: 0 },
    },
    { index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 2, tags: { language: 'eng', title: 'Commentary' }, disposition: { default: 0 } },
    { index: 2, codec_type: 'audio', codec_name: 'eac3', channels: 6, channel_layout: '5.1', tags: { language: 'eng' }, disposition: { default: 1 } },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' }, disposition: {} },
    { index: 4, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
  ],
  chapters: [
    { id: 0, start_time: '0.000000', end_time: '95.000000', tags: { title: 'Intro' } },
    { id: 1, start_time: '95.000000', end_time: '7200.500000', tags: { title: 'Chapter 2' } },
  ],
};

test('summary reads 12-bit depth, rotation, Dolby Vision, colour tags, chapters, cover codec and the default audio track', () => {
  const s = summarise(fixture);
  assert.equal(s.video.bitDepth, 12);
  assert.equal(s.video.rotation, 270);
  assert.deepEqual(s.video.dolbyVision, { profile: 5 });
  assert.deepEqual(s.video.colour, { transfer: 'smpte2084', primaries: 'bt2020', matrix: 'bt2020nc' });
  assert.equal(s.video.hdr, true);
  assert.equal(s.video.fps, 23.976);
  assert.deepEqual(s.chapters, [{ start: 0, end: 95, title: 'Intro' }, { start: 95, end: 7200.5, title: 'Chapter 2' }]);
  assert.equal(s.defaultAudio, 1, 'the second audio stream carries the default flag');
  assert.equal(s.coverArt, true);
  assert.equal(s.coverCodec, 'mjpeg');
});

test('a plain 8-bit file without the newer fields reads as none', () => {
  const s = summarise({ format: {}, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', avg_frame_rate: '25/1' }, { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2 }] });
  assert.equal(s.video.bitDepth, 8);
  assert.equal(s.video.rotation, 0);
  assert.equal(s.video.dolbyVision, null);
  assert.equal(s.video.hdr, false);
  assert.deepEqual(s.chapters, []);
  assert.equal(s.defaultAudio, 0);
});

test('bits_per_raw_sample wins when the pixel format carries no depth', () => {
  const s = summarise({ format: {}, streams: [{ index: 0, codec_type: 'video', codec_name: 'prores', width: 1920, height: 1080, pix_fmt: 'yuv422p10le', bits_per_raw_sample: '10' }] });
  assert.equal(s.video.bitDepth, 10);
});

test('parseVersion reads a numeric or a dated gyan build', () => {
  assert.equal(parseVersion('7.1.1'), 7);
  assert.equal(parseVersion('4.4.2-0ubuntu0.22.04.1'), 4);
  assert.equal(parseVersion('2025-03-10-git-abc'), 7, 'a dated build is a current ffmpeg');
  assert.equal(parseVersion('n6.1'), 6);
  assert.equal(parseVersion('unknown'), 0);
});

test('run() rejects with EOVERFLOW instead of truncating', async () => {
  const script = path.join(tempDir(), 'big.sh');
  fs.writeFileSync(script, '#!/bin/sh\nhead -c 3000 /dev/zero\n');
  fs.chmodSync(script, 0o755);
  await assert.rejects(run(script, [], { maxBuffer: 1000 }), (e) => e.code === 'EOVERFLOW');
  const ok = await run(script, [], { maxBuffer: 5000 });
  assert.equal(ok.length, 3000);
});

test('previews put scale before the tonemap chain and ask for hardware decoding', () => {
  const item = { id: 7, path: '/m/f.mkv', duration: 100 };
  const plan = planPreviews(100, { width: 1920, height: 1080 });
  const args = previewArgs({ item, plan, tonemap: true, tmp: '/tmp/x' });
  const i = args.indexOf('-i');
  assert.ok(args.indexOf('-hwaccel') < i && args[args.indexOf('-hwaccel') + 1] === 'auto');
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.indexOf('scale=') < vf.indexOf('zscale='), 'scale first, then the tonemap');
  assert.match(vf, /tile=10x10$/);
  const plain = previewArgs({ item, plan, tonemap: false, tmp: '/tmp/x' })[0 + previewArgs({ item, plan, tonemap: false, tmp: '/tmp/x' }).indexOf('-vf') + 1];
  assert.doesNotMatch(plain, /zscale/);
});

test('portrait sources get portrait tiles; old summaries without rotation are landscape as before', () => {
  const p = planPreviews(100, { width: 1920, height: 1080, rotation: 90 });
  assert.ok(p.height > p.width, `${p.width}×${p.height}`);
  assert.equal(planPreviews(100, { width: 1920, height: 1080 }).height, 180);
});

test('intro fingerprints map the default audio track, else the first', () => {
  assert.ok(fingerprintArgs('/m/e.mkv', 1000, 1).join(' ').includes('-map 0:a:1'));
  assert.ok(fingerprintArgs('/m/e.mkv', 1000).join(' ').includes('-map 0:a:0'));
});

test('album art is copied as-is when the embedded picture is already a JPEG', () => {
  const copy = albumArtArgs('/m/t.flac', '/img/x.jpg', 'mjpeg');
  assert.ok(copy.includes('copy') && !copy.includes('-q:v'));
  const re = albumArtArgs('/m/t.flac', '/img/x.jpg', 'png');
  assert.ok(re.includes('mjpeg') && re.includes('-q:v'));
  assert.ok(copy.includes('-an') && copy.includes('-sn'));
});

test('v0.28: which ffmpegs can read the first seconds at full speed (-readrate_initial_burst, ffmpeg 6.1+)', async () => {
  const { supportsInitialBurst } = await import('../src/library/probe.js');
  assert.equal(supportsInitialBurst('6.1.1-3ubuntu5'), true);
  assert.equal(supportsInitialBurst('n6.1'), true);
  assert.equal(supportsInitialBurst('7.1'), true);
  assert.equal(supportsInitialBurst('6.0'), false);
  assert.equal(supportsInitialBurst('5.1.2'), false);
  assert.equal(supportsInitialBurst('2024-05-01-git-abc'), true);
  assert.equal(supportsInitialBurst('2023-05-01-git-abc'), false);
  assert.equal(supportsInitialBurst('unknown'), false);
});
