// v0.28 (iPhone report): a conversion whose ffmpeg quit on its own said only "Transcoder stopped unexpectedly". ffmpeg's
// own last words and the (redacted) command must reach the log whatever exit code it used — ffmpeg 7+ uses 255 for
// errors too, which used to be skipped as if Atomix had stopped it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { PlaybackManager } from '../src/stream/playback.js';
import { setLogFile, closeLogFile } from '../src/log.js';

const dir = tempDir();
const logFile = path.join(dir, 'atomix.log');
after(() => closeLogFile());

test('an ffmpeg that quits with 255 on its own is logged with its error and command', { skip: process.platform === 'win32' && 'needs sh' }, async () => {
  const fake = path.join(dir, 'fake-ffmpeg');
  fs.writeFileSync(fake, '#!/bin/sh\necho "Unrecognized option \'readrate_initial_burst\'." >&2\nexit 255\n');
  fs.chmodSync(fake, 0o755);
  setLogFile(logFile);
  const config = { transcodeDir: path.join(dir, 'transcode'), ffmpegPath: fake, ffprobePath: 'ffprobe' };
  const settings = { all: () => ({ transcodingEnabled: true, hwAccel: 'none' }), get: () => 3 };
  const pm = new PlaybackManager({ db: null, config, settings, hooks: { emit() {} }, tools: () => ({ ffmpeg: { available: true, major: 9 }, filters: {} }) });
  const media = { container: 'matroska', duration: 10, video: { codec: 'hevc', width: 320, height: 180, bitDepth: 10, hdr: false, fps: 24 }, audio: [{ codec: 'eac3', channels: 6 }], subtitles: [] };
  const item = { id: 6, kind: 'movie', title: 'Ten Bit', path: path.join(dir, 'film.mkv'), media: JSON.stringify(media) };
  const caps = { video: ['h264'], audio: ['aac'], containers: ['mp4'], hls: true };
  const { session } = await pm.create({ user: { id: 1, username: 'd' }, profile: null, item, caps });
  pm.startHls(session);
  for (let i = 0; i < 50 && session.proc; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  const text = fs.readFileSync(logFile, 'utf8');
  assert.match(text, /ffmpeg exited with 255: Unrecognized option 'readrate_initial_burst'/);
  assert.match(text, /ffmpeg command: .*-i /);
  pm.stop(session.id);
});

// Dallas's iPhone, 11 Nov: ffmpeg 9 writes the HLS header (-hls_fmp4_init_filename init.mp4) into its working folder,
// not beside the playlist, so every converted stream's header landed in D:\Nodeflix and the iPhone never got one.
test('a converted HLS stream runs ffmpeg in its own folder, so a relative init.mp4 lands there', { skip: process.platform === 'win32' && 'needs sh' }, async () => {
  const fake = path.join(dir, 'fake-ffmpeg-cwd');
  fs.writeFileSync(fake, '#!/bin/sh\necho header > init.mp4\nsleep 5\n');
  fs.chmodSync(fake, 0o755);
  const config = { transcodeDir: path.join(dir, 'transcode2'), ffmpegPath: fake, ffprobePath: 'ffprobe' };
  const settings = { all: () => ({ transcodingEnabled: true, hwAccel: 'none' }), get: () => 3 };
  const pm = new PlaybackManager({ db: null, config, settings, hooks: { emit() {} }, tools: () => ({ ffmpeg: { available: true, major: 9 }, filters: {} }) });
  const media = { container: 'matroska', duration: 10, video: { codec: 'h264', width: 320, height: 180, bitDepth: 8, hdr: false, fps: 24 }, audio: [{ codec: 'dts', channels: 2 }], subtitles: [] };
  const item = { id: 7, kind: 'movie', title: 'Cwd', path: path.join(dir, 'film.mkv'), media: JSON.stringify(media) };
  const { session } = await pm.create({ user: { id: 1, username: 'd' }, profile: null, item, caps: { video: ['h264'], audio: ['aac'], containers: ['mp4'], hls: true } });
  pm.startHls(session);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(session.dir, 'init.mp4')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(path.join(session.dir, 'init.mp4')), 'the header is in the stream folder');
  pm.stop(session.id);
});
