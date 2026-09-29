import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, buildFfmpegArgs } from '../src/stream/playback.js';

const chrome = { video: ['h264', 'vp9', 'av1'], audio: ['aac', 'mp3', 'opus', 'flac'], containers: ['mp4', 'webm'], hls: false };
const safari = { video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'ac3', 'eac3', 'flac'], containers: ['mp4'], hls: true };
const noH264 = { video: ['vp8', 'vp9'], audio: ['opus', 'vorbis'], containers: ['webm'], hls: false };
const media = (vcodec, acodec, extra = {}) => ({
  container: 'x', duration: 100,
  video: { codec: vcodec, width: 1920, height: 1080, bitDepth: 8, hdr: false, ...extra },
  audio: [{ index: 0, codec: acodec, channels: 6, default: true }, { index: 1, codec: 'aac', channels: 2, default: false, language: 'jpn' }],
  subtitles: [{ index: 0, codec: 'hdmv_pgs_subtitle' }],
});
const base = { transcodingEnabled: true, quality: 'original' };

test('direct play for browser-friendly MP4', () => {
  assert.equal(decide({ ...base, file: 'a.mp4', media: media('h264', 'aac'), caps: chrome }).mode, 'direct');
});

test('remux for MKV or unsupported audio', () => {
  assert.equal(decide({ ...base, file: 'a.mkv', media: media('h264', 'aac'), caps: chrome }).mode, 'remux');
  const r = decide({ ...base, file: 'a.mp4', media: media('h264', 'ac3'), caps: chrome });
  assert.equal(r.mode, 'remux');
  assert.equal(r.audioCopy, false);
  assert.equal(decide({ ...base, file: 'a.mp4', media: media('h264', 'aac'), caps: chrome, audioIndex: 1 }).mode, 'remux');
});

test('transcode for unsupported video, 10-bit H.264, quality caps and burn-in', () => {
  assert.equal(decide({ ...base, file: 'a.mkv', media: media('hevc', 'aac'), caps: chrome }).mode, 'transcode');
  assert.equal(decide({ ...base, file: 'a.mkv', media: media('hevc', 'aac'), caps: safari }).mode, 'remux');
  assert.equal(decide({ ...base, file: 'a.mkv', media: media('h264', 'aac', { bitDepth: 10 }), caps: chrome }).mode, 'transcode');
  assert.equal(decide({ ...base, file: 'a.mp4', media: media('h264', 'aac'), caps: chrome, quality: '720' }).mode, 'transcode');
  assert.equal(decide({ ...base, file: 'a.mp4', media: media('h264', 'aac'), caps: chrome, burnSubtitle: 0 }).mode, 'transcode');
});

test('refuses when transcoding is disabled', () => {
  assert.throws(() => decide({ file: 'a.mkv', media: media('hevc', 'aac'), caps: chrome, transcodingEnabled: false, quality: 'original' }), /transcoding is turned off/);
});

test('browsers without H.264 get WebM', () => {
  const r = decide({ ...base, file: 'a.mp4', media: media('h264', 'aac'), caps: noH264 });
  assert.equal(r.mode, 'transcode');
  assert.equal(r.target, 'webm');
  const args = buildFfmpegArgs({ ...r, file: 'a.mp4', start: 0, media: media('h264', 'aac'), quality: 'original' }, {}, { type: 'progressive' });
  assert.ok(args.includes('libvpx') && args.includes('libopus') && args.includes('webm'));
});

test('ffmpeg arguments', () => {
  const plan = { mode: 'transcode', target: 'mp4', file: '/x/a.mkv', start: 42.5, media: media('hevc', 'dts'), quality: '720', audio: { index: 1 }, audioCopy: false, burnSubtitle: 0 };
  const args = buildFfmpegArgs(plan, { hwAccel: 'none', x264Preset: 'veryfast' }, { type: 'progressive' });
  const joined = args.join(' ');
  assert.match(joined, /-ss 42\.500 -i \/x\/a\.mkv/);
  assert.match(joined, /\[0:v:0\]\[0:s:0\]overlay\[burned\];\[burned\]scale=-2:720,format=yuv420p\[vout\]/);
  assert.match(joined, /-c:v libx264/);
  assert.match(joined, /-map 0:a:1\?/);
  assert.match(joined, /-c:a aac/);
  assert.match(joined, /frag_keyframe\+empty_moov/);
  const nv = buildFfmpegArgs({ ...plan, burnSubtitle: null }, { hwAccel: 'nvenc' }, { type: 'hls', dir: '/tmp/s' }).join(' ');
  assert.match(nv, /h264_nvenc/);
  assert.match(nv, /-f hls .*-hls_segment_type fmp4/);
  const copy = buildFfmpegArgs({ mode: 'remux', target: 'mp4', file: 'a.mkv', start: 0, media: media('hevc', 'aac'), quality: 'original', audio: { index: 0 }, audioCopy: true }, {}, { type: 'progressive' }).join(' ');
  assert.match(copy, /-c:v copy -tag:v hvc1/);
  assert.match(copy, /-c:a copy/);
});
