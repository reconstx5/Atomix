// v0.28 (Dallas's iPhone, 11 Nov): an HEVC film in MP4 failed "as it is" (Safari only plays HEVC labelled hvc1) and
// its conversion failed "Media failed to decode". Apple devices now get HEVC repackaged with the hvc1 label (no
// conversion), and anything sent as HLS has plain stereo AAC sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, buildFfmpegArgs } from '../src/stream/playback.js';
import { summarise } from '../src/library/probe.js';

const iphone = { video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'ac3', 'eac3', 'flac', 'alac'], containers: ['mp4'], hls: true, mse: false };
const chrome = { video: ['h264', 'hevc', 'vp9'], audio: ['aac', 'mp3', 'opus', 'flac'], containers: ['mp4', 'webm'], hls: false };
const film = (codec, tag, channels = 6) => ({
  container: 'mov,mp4', duration: 5700,
  video: { codec, tag, profile: 'Main 10', width: 1920, height: 1040, bitDepth: codec === 'hevc' ? 10 : 8, fps: 23.976, hdr: false },
  audio: [{ index: 0, codec: 'aac', channels, default: true }],
});
const base = { transcodingEnabled: true, quality: 'original', file: 'D:/Movies/Jackass.mp4' };

test('HEVC labelled hev1 (or not known) is repackaged for Apple devices, not played as it is', () => {
  for (const tag of ['hev1', undefined]) {
    const plan = decide({ ...base, media: film('hevc', tag), caps: iphone });
    assert.equal(plan.mode, 'remux', `tag ${tag}`);
  }
});

test('HEVC already labelled hvc1 plays as it is on Apple devices', () => {
  assert.equal(decide({ ...base, media: film('hevc', 'hvc1', 2), caps: iphone }).mode, 'direct');
});

test('other browsers are unchanged', () => {
  assert.equal(decide({ ...base, media: film('hevc', 'hev1'), caps: chrome }).mode, 'direct');
});

test('HLS for Apple devices: surround sound is made stereo AAC; the HEVC copy is labelled hvc1', () => {
  const plan = decide({ ...base, media: film('hevc', 'hev1', 6), caps: iphone });
  assert.equal(plan.audioCopy, false);
  const args = buildFfmpegArgs({ ...plan, file: base.file, media: film('hevc', 'hev1', 6), delivery: 'hls', start: 0 }, { hwAccel: 'none' }, { type: 'hls', dir: '/tmp/x' }).join(' ');
  assert.match(args, /-c:v copy -tag:v hvc1/);
  assert.match(args, /-c:a aac/);
  assert.match(args, /pan=stereo/);
});

test('a stereo AAC track is still copied for Apple devices', () => {
  const plan = decide({ ...base, file: 'D:/Movies/x.mkv', media: film('h264', 'avc1', 2), caps: iphone });
  assert.equal(plan.audioCopy, true);
});

test('a converted stream for Apple devices has stereo sound too', () => {
  const plan = decide({ ...base, media: film('hevc', 'hev1', 6), caps: iphone, forceTranscode: true });
  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.audioCopy, false);
});

test("the probe keeps the video's label", () => {
  const s = summarise({ format: { duration: '10' }, streams: [{ codec_type: 'video', codec_name: 'hevc', codec_tag_string: 'hev1', width: 1920, height: 1040, pix_fmt: 'yuv420p10le' }] });
  assert.equal(s.video.tag, 'hev1');
});

test('a repackaged (not converted) stream reads ahead faster, so an iPhone has its first minute quickly', () => {
  const tools = { ffmpeg: { available: true, major: 9, burst: true } };
  const remux = decide({ ...base, media: film('hevc', 'hev1', 2), caps: iphone });
  const r = buildFfmpegArgs({ ...remux, tools, file: base.file, media: film('hevc', 'hev1', 2), delivery: 'hls', start: 0 }, { hwAccel: 'none' }, { type: 'hls', dir: '/tmp/x' }).join(' ');
  assert.match(r, /-readrate 4 -readrate_initial_burst 60/);
  const conv = decide({ ...base, media: film('hevc', 'hev1', 2), caps: iphone, forceTranscode: true });
  const c = buildFfmpegArgs({ ...conv, tools, file: base.file, media: film('hevc', 'hev1', 2), delivery: 'hls', start: 0 }, { hwAccel: 'none' }, { type: 'hls', dir: '/tmp/x' }).join(' ');
  assert.match(c, /-readrate 1.5 -readrate_initial_burst 10/);
});
