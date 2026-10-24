// v0.15.0: a remux seek starts where the picture really starts (the keyframe at or before the time asked), the
// subtitles filter is warmed up once at startup, .ass sidecars keep their styling when burned in, cp1252 .ass files
// convert, and a dead HLS encoder is reported instead of waited for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir } from './helpers.js';
import { keyframeAtOrBefore } from '../src/stream/keyframes.js';
import { PlaybackManager, fontsDirArg } from '../src/stream/playback.js';
import { toVtt } from '../src/stream/subtitles.js';
import { warmUpSubtitles } from '../src/stream/warmup.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let dir, gop;

before(() => {
  if (!hasFfmpeg) return;
  dir = tempDir();
  gop = path.join(dir, 'gop.mkv');
  // 10 s at 24 fps with a keyframe every 2 s exactly (no scene cuts).
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-an', gop]);
});

test('keyframeAtOrBefore returns the last keyframe at or before start', { skip }, async () => {
  assert.equal(await keyframeAtOrBefore('ffprobe', gop, 5.0), 4);
  assert.equal(await keyframeAtOrBefore('ffprobe', gop, 4.0), 4);
  assert.equal(await keyframeAtOrBefore('ffprobe', gop, 1.5), 0);
});

test('…near the end it never answers past the file, and a failure answers null', { skip }, async () => {
  const late = await keyframeAtOrBefore('ffprobe', gop, 9.9);
  assert.ok(late <= 9.9 && late >= 8, String(late));
  const past = await keyframeAtOrBefore('ffprobe', gop, 50);
  assert.ok(past == null || past <= 10, String(past));
  assert.equal(await keyframeAtOrBefore('ffprobe', path.join(dir, 'missing.mkv'), 5), null);
});

test('a remux session that starts mid-file reports the keyframe time as its start', { skip }, async () => {
  const config = { transcodeDir: path.join(dir, 'transcode'), ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };
  const settings = { all: () => ({ transcodingEnabled: true, hwAccel: 'none' }), get: () => 3 };
  const pm = new PlaybackManager({ db: null, config, settings, hooks: { emit() {} }, tools: () => ({ ffmpeg: { available: true, major: 7 }, filters: {} }) });
  const media = { container: 'matroska', duration: 10, video: { codec: 'h264', width: 320, height: 180, bitDepth: 8, hdr: false, fps: 24 }, audio: [], subtitles: [] };
  const item = { id: 1, kind: 'movie', title: 'GOP', path: gop, media: JSON.stringify(media) };
  const caps = { video: ['h264'], audio: ['aac'], containers: ['mp4'], hls: false };
  const { session } = await pm.create({ user: { id: 1, username: 'd' }, profile: null, item, caps, start: 5 });
  assert.equal(session.mode, 'remux');
  assert.equal(session.start, 4, 'the keyframe before 5 s');
  pm.stop(session.id);
});

test('the subtitles filter names the OS fonts folder with the colon escaped', () => {
  assert.equal(fontsDirArg('win32', null, {}), ':fontsdir=C\\\\:/Windows/Fonts'); // two backslashes in the argv: one for the graph parser, one for the option splitter
  assert.equal(fontsDirArg('linux'), ':fontsdir=/usr/share/fonts');
});

test('the startup warm-up runs the subtitles filter once, in the background, and never throws', { skip }, async () => {
  const log = path.join(dir, 'warm.log');
  const shim = path.join(dir, 'ffmpeg-shim.sh');
  fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  fs.chmodSync(shim, 0o755);
  const p = warmUpSubtitles({ ffmpegPath: shim, transcodeDir: path.join(dir, 'transcode') }, { filters: { subtitles: true } });
  assert.ok(p instanceof Promise);
  await p;
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /-f lavfi -i color=s=16x16:d=0\.1 .*subtitles=.*warm\.vtt.* -f null -/);
  await warmUpSubtitles({ ffmpegPath: shim, transcodeDir: path.join(dir, 'transcode') }, { filters: { subtitles: false } });
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'nothing without libass');
  await assert.doesNotReject(warmUpSubtitles({ ffmpegPath: path.join(dir, 'nope'), transcodeDir: path.join(dir, 'transcode') }, { filters: { subtitles: true } }));
});

test('toVtt converts a cp1252 .ass by retrying with the charset', { skip }, async () => {
  const ass = path.join(dir, 'latin.ass');
  const text = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Café crème\n';
  fs.writeFileSync(ass, Buffer.from(text, 'latin1'));
  const vtt = await toVtt(ass, 'ffmpeg');
  assert.match(vtt, /Café crème/);
});

test('a long gap between keyframes is still found (ffprobe reads from the keyframe before the window)', { skip }, async () => {
  const long = path.join(dir, 'long-gop.mkv');
  // 70 s at 2 fps with keyframes only at 0 s and 20 s (gaps far longer than the 10-s window the search reads).
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=2:duration=70', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:eq(t,0)+eq(t,20)', '-g', '1000', '-keyint_min', '1000', '-sc_threshold', '0', '-an', long]);
  assert.equal(await keyframeAtOrBefore('ffprobe', long, 38), 20, '18 s back');
  assert.equal(await keyframeAtOrBefore('ffprobe', long, 65), 20, '45 s back');
});
