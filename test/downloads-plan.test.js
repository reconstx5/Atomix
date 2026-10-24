// What a download is: copied when it already fits, else converted to a phone-sized MP4 (or WebM, or AAC for songs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadFormat, planDownload, downloadArgs } from '../src/downloads/plan.js';

const film = (codec, height, audio = 'aac', channels = 2, container = 'mov,mp4,m4a,3gp,3g2,mj2') => ({
  container,
  duration: 100,
  video: { codec, width: Math.round((height * 16) / 9), height },
  audio: [{ index: 0, codec: audio, channels, default: true }],
  defaultAudio: 0,
});
const chrome = { video: ['h264', 'vp9'], audio: ['aac', 'mp3', 'opus'] };
const noH264 = { video: ['vp9', 'av1'], audio: ['opus', 'mp3'] };
const movie = { kind: 'movie', path: '/m/a.mp4' };

test('the format follows the browser: MP4 with H.264, WebM without, audio for songs', () => {
  assert.equal(downloadFormat('movie', chrome), 'mp4');
  assert.equal(downloadFormat('episode', noH264), 'webm');
  assert.equal(downloadFormat('track', chrome), 'audio');
});

test('a 1080p H.264 film at 720 is converted to a phone-sized MP4', () => {
  const p = planDownload({ item: movie, media: film('h264', 1080), quality: '720', format: 'mp4' });
  assert.equal(p.copy, false);
  assert.equal(p.ext, 'mp4');
  const a = downloadArgs(p, '/m/a.mp4', '/d/1.part').join(' ');
  assert.match(a, /-vf scale=-2:720/);
  assert.match(a, /-c:v libx264/);
  assert.match(a, /-b:v 2500k/);
  assert.match(a, /-c:a copy/, 'stereo AAC is already right');
  assert.match(a, /-movflags \+faststart/);
  assert.match(a, /-progress pipe:1/);
  assert.match(a, /-sn -dn -map_metadata -1/);
  assert.match(a, /-i \/m\/a\.mp4/);
  assert.ok(a.endsWith('/d/1.part'));
});

test('the same film at 1080 already fits: copied', () => {
  const p = planDownload({ item: movie, media: film('h264', 1080), quality: '1080', format: 'mp4' });
  assert.equal(p.copy, true);
  assert.match(downloadArgs(p, '/m/a.mp4', '/d/1.part').join(' '), /-c copy/);
});

test('surround sound is never copied', () => {
  const p = planDownload({ item: movie, media: film('h264', 720, 'aac', 6), quality: '720', format: 'mp4' });
  assert.equal(p.copy, false);
  const a = downloadArgs(p, '/m/a.mp4', '/d/1.part').join(' ');
  assert.match(a, /-c:a aac -b:a 160k -ac 2/);
  assert.match(a, /-c:v copy/, 'the picture is copied when only the sound needs work');
});

test('an HEVC MKV for a browser without H.264 becomes WebM', () => {
  const p = planDownload({ item: { kind: 'episode', path: '/t/e.mkv' }, media: film('hevc', 720, 'ac3', 6, 'matroska,webm'), quality: '720', format: 'webm' });
  assert.equal(p.ext, 'webm');
  const a = downloadArgs(p, '/t/e.mkv', '/d/2.part').join(' ');
  assert.match(a, /-c:v libvpx-vp9/);
  assert.match(a, /-c:a libopus -b:a 128k -ac 2/);
  assert.doesNotMatch(a, /faststart/);
});

test('songs: copied when the browser plays them, else AAC 192k', () => {
  const song = (codec, ext) => ({ item: { kind: 'track', path: `/mu/s.${ext}` }, media: { container: ext, duration: 200, audio: [{ index: 0, codec, channels: 2, default: true }] } });
  const flac = planDownload({ ...song('flac', 'flac'), quality: '720', format: 'audio', caps: chrome });
  assert.equal(flac.copy, false);
  assert.equal(flac.ext, 'm4a');
  assert.match(downloadArgs(flac, '/mu/s.flac', '/d/3.part').join(' '), /-vn -c:a aac -b:a 192k/);
  const mp3 = planDownload({ ...song('mp3', 'mp3'), quality: '720', format: 'audio', caps: chrome });
  assert.equal(mp3.copy, true);
  assert.equal(mp3.ext, 'mp3');
});

test('songs for a browser with no AAC are converted to Opus in WebM (it would get a file it can\'t play)', () => {
  const aac = { item: { kind: 'track', path: '/mu/s.m4a' }, media: { container: 'mov,mp4,m4a', duration: 200, audio: [{ index: 0, codec: 'aac', channels: 2, default: true }] } };
  const p = planDownload({ ...aac, quality: '720', format: 'audio', caps: noH264 });
  assert.equal(p.copy, false);
  assert.equal(p.ext, 'webm');
  assert.match(downloadArgs(p, '/mu/s.m4a', '/d/4.part').join(' '), /-vn -c:a libopus -b:a 160k -ac 2 -f webm/);
});

test('right codecs in an MKV are copied into MP4 (8-bit only)', () => {
  const mkv = film('h264', 720, 'aac', 2, 'matroska,webm');
  const p = planDownload({ item: { kind: 'movie', path: '/m/a.mkv' }, media: mkv, quality: '720', format: 'mp4' });
  assert.equal(p.copy, true);
  assert.match(downloadArgs(p, '/m/a.mkv', '/d/1.part').join(' '), /-c copy -f mp4 -movflags \+faststart/);
  const tenBit = { ...mkv, video: { ...mkv.video, bitDepth: 10 } };
  assert.equal(planDownload({ item: { kind: 'movie', path: '/m/a.mkv' }, media: tenBit, quality: '720', format: 'mp4' }).copyVideo, false, "10-bit H.264 won't play on phones");
});
