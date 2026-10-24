// v0.15.0 transcoder: HDR shown in the right colours (or refused plainly), Dolby Vision 5 detected, hardware HLS
// segments on keyframes, dialogue-safe downmix, audio copied when it can be, a fast first frame, honest levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, buildFfmpegArgs } from '../src/stream/playback.js';

const chrome = { video: ['h264', 'vp9', 'av1'], audio: ['aac', 'mp3', 'opus', 'flac'], containers: ['mp4', 'webm'], hls: false, hdr: false };
const safari = { video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'ac3', 'eac3', 'flac'], containers: ['mp4'], hls: true, hdr: false };
const hdrMedia = (extra = {}) => ({
  container: 'matroska', duration: 100,
  video: { codec: 'hevc', width: 3840, height: 2160, bitDepth: 10, hdr: true, fps: 23.976, colour: { transfer: 'smpte2084', primaries: 'bt2020', matrix: 'bt2020nc' }, rotation: 0, dolbyVision: null, ...extra },
  audio: [{ index: 0, codec: 'eac3', channels: 6, default: true }],
  subtitles: [],
});
const sdrMedia = (acodec = 'aac', channels = 2) => ({
  container: 'matroska', duration: 100,
  video: { codec: 'hevc', width: 1920, height: 1080, bitDepth: 8, hdr: false, fps: 25 },
  audio: [{ index: 0, codec: acodec, channels, default: true }],
  subtitles: [],
});
const tools = (filters = {}, major = 7) => ({ ffmpeg: { available: true, major }, filters: { zscale: false, tonemap: false, subtitles: false, libplacebo: false, ...filters } });
const base = { transcodingEnabled: true, quality: 'original', file: 'a.mkv' };
const settings = { hwAccel: 'none', x264Preset: 'veryfast', maxSoftwareHeight: 2160 };
const joined = (plan, s = settings, out = { type: 'progressive' }) => buildFfmpegArgs({ file: 'a.mkv', start: 0, quality: 'original', ...plan }, s, out).join(' ');

test('HDR to a non-HDR sink with zscale: scale first, the tonemap with the probe\'s input tags, bt709 output flags', () => {
  const plan = decide({ ...base, media: hdrMedia(), caps: chrome, tools: tools({ zscale: true, tonemap: true }) });
  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.hdrFilter, 'zscale');
  const j = joined({ ...plan, media: hdrMedia() });
  const vf = /-filter_complex (\S+)/.exec(j)[1];
  assert.ok(vf.indexOf('scale=-2:2160') < vf.indexOf('zscale='), 'scale before the tone map');
  assert.match(vf, /zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=100/);
  assert.match(vf, /tonemap=hable/);
  assert.match(vf, /format=yuv420p\[vout\]$/);
  assert.match(j, /-color_primaries bt709 -color_trc bt709 -colorspace bt709/);
});

test('…without zscale but with libplacebo: the libplacebo filter; with neither: a plain 422', () => {
  const plan = decide({ ...base, media: hdrMedia(), caps: chrome, tools: tools({ libplacebo: true }) });
  assert.equal(plan.hdrFilter, 'libplacebo');
  assert.match(joined({ ...plan, media: hdrMedia() }), /libplacebo=tonemapping=bt\.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p/);
  assert.throws(() => decide({ ...base, media: hdrMedia(), caps: chrome, tools: tools() }), (e) => e.status === 422 && e.message === "This ffmpeg can't convert HDR video (it needs zscale or libplacebo).");
});

test('an HDR sink plays HDR as-is (no tone map, no refusal)', () => {
  const plan = decide({ ...base, file: 'a.mp4', media: hdrMedia(), caps: { ...safari, hdr: true }, tools: tools() });
  assert.notEqual(plan.mode, 'transcode');
  assert.equal(plan.hdrFilter, undefined);
});

test('Dolby Vision profile 5 needs libplacebo', () => {
  assert.throws(() => decide({ ...base, media: hdrMedia({ dolbyVision: { profile: 5 } }), caps: chrome, tools: tools({ zscale: true, tonemap: true }) }), (e) => e.status === 422 && /Dolby Vision/.test(e.message));
  const plan = decide({ ...base, media: hdrMedia({ dolbyVision: { profile: 5 } }), caps: chrome, tools: tools({ zscale: true, libplacebo: true }) });
  assert.equal(plan.hdrFilter, 'libplacebo');
  const p8 = decide({ ...base, media: hdrMedia({ dolbyVision: { profile: 8 } }), caps: chrome, tools: tools({ zscale: true, tonemap: true }) });
  assert.equal(p8.hdrFilter, 'zscale', 'profile 8 carries an HDR10 base layer');
});

test('a pre-0.15 summary without the new fields still decides and builds', () => {
  const old = { container: 'x', duration: 100, video: { codec: 'hevc', width: 1920, height: 1080, bitDepth: 8, hdr: false }, audio: [{ index: 0, codec: 'dts', channels: 6, default: true }], subtitles: [] };
  const plan = decide({ ...base, media: old, caps: chrome });
  assert.equal(plan.mode, 'transcode');
  assert.doesNotThrow(() => joined({ ...plan, media: old }));
});

test('5.1 to stereo uses the pan matrix and a limiter, not -ac 2', () => {
  const plan = decide({ ...base, media: sdrMedia('dts', 6), caps: chrome });
  const j = joined({ ...plan, media: sdrMedia('dts', 6) });
  assert.match(j, /-af pan=stereo\|FL=FC\+0\.30\*FL\+0\.30\*BL\+0\.30\*SL\|FR=FC\+0\.30\*FR\+0\.30\*BR\+0\.30\*SR,alimiter=limit=0\.95/);
  assert.doesNotMatch(j, /-ac 2/);
  const stereo = joined({ ...decide({ ...base, media: sdrMedia('dts', 2), caps: chrome }), media: sdrMedia('dts', 2) });
  assert.doesNotMatch(stereo, /pan=/);
});

test('AAC the sink can play is copied even when the video is transcoded', () => {
  const plan = decide({ ...base, media: sdrMedia('aac', 6), caps: chrome, forceTranscode: true });
  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.audioCopy, true);
  assert.match(joined({ ...plan, media: sdrMedia('aac', 6) }), /-c:a copy/);
});

test('an audio index the probe does not list is a 400; -map 0:a:N has no ? suffix', () => {
  assert.throws(() => decide({ ...base, media: sdrMedia(), caps: chrome, audioIndex: 7 }), (e) => e.status === 400 && e.message === "That audio track doesn't exist.");
  const plan = decide({ ...base, media: sdrMedia('dts'), caps: chrome, audioIndex: 0 });
  assert.match(joined({ ...plan, media: sdrMedia('dts') }), /-map 0:a:0 /);
  assert.doesNotMatch(joined({ ...plan, media: sdrMedia('dts') }), /0:a:0\?/);
});

test('hardware encoders start HLS segments on keyframes; libvpx uses row threads', () => {
  const plan = { ...decide({ ...base, media: sdrMedia('dts'), caps: safari, forceTranscode: true }), media: sdrMedia('dts') };
  const nv = joined(plan, { ...settings, hwAccel: 'nvenc' }, { type: 'hls', dir: '/tmp/s' });
  assert.match(nv, /h264_nvenc .*-forced-idr 1/);
  assert.match(nv, /-b:v 0/);
  assert.match(nv, /-g 50/);
  const qsv = joined(plan, { ...settings, hwAccel: 'qsv' }, { type: 'hls', dir: '/tmp/s' });
  assert.match(qsv, /h264_qsv .*-forced_idr 1/);
  assert.match(qsv, /-look_ahead 0/);
  const amf = joined(plan, { ...settings, hwAccel: 'amf' }, { type: 'hls', dir: '/tmp/s' });
  assert.match(amf, /-g 50/);
  const webm = joined({ ...plan, target: 'webm' }, settings);
  assert.match(webm, /-row-mt 1/);
});

test('-level follows height and frame rate', () => {
  const plan = decide({ ...base, media: sdrMedia('dts'), caps: chrome });
  assert.match(joined({ ...plan, media: sdrMedia('dts') }), /-level:v 4\.1/);
  const fast = { ...sdrMedia('dts'), video: { ...sdrMedia().video, fps: 60 } };
  assert.match(joined({ ...plan, media: fast }), /-level:v 4\.2/);
  const uhd = { ...sdrMedia('dts'), video: { ...sdrMedia().video, width: 3840, height: 2160 } };
  assert.match(joined({ ...plan, media: uhd }), /-level:v 5\.1/);
});

test('software transcodes are capped at maxSoftwareHeight; hardware ones are not', () => {
  const uhd = { ...sdrMedia('dts'), video: { ...sdrMedia().video, width: 3840, height: 2160 } };
  const plan = { ...decide({ ...base, media: uhd, caps: chrome }), media: uhd };
  assert.match(joined(plan, { ...settings, maxSoftwareHeight: 1080 }), /scale=-2:1080/);
  assert.match(joined(plan, { ...settings, maxSoftwareHeight: 1080, hwAccel: 'nvenc' }), /scale=-2:2160/);
});

test('progressive mp4 fragments every half second; HLS uses 2 s segments and reads at 1.5× on ffmpeg 5+', () => {
  const plan = { ...decide({ ...base, media: sdrMedia('dts'), caps: chrome }), media: sdrMedia('dts'), tools: tools({}, 7) };
  assert.match(joined(plan), /-frag_duration 500000/);
  const hls = joined({ ...plan, target: 'mp4' }, settings, { type: 'hls', dir: '/tmp/s' });
  assert.match(hls, /-readrate 1\.5 .*-i a\.mkv/);
  assert.match(hls, /-hls_time 2 /);
  assert.match(hls, /-hls_init_time 1/);
  assert.match(hls, /expr:gte\(t,n_forced\*2\)/);
  const old = joined({ ...plan, tools: tools({}, 4) }, settings, { type: 'hls', dir: '/tmp/s' });
  assert.doesNotMatch(old, /-readrate/);
  assert.doesNotMatch(joined(plan), /-readrate/, 'the progressive pipe is backpressured by the socket');
});

test('a rotated (portrait) video is judged by its height on screen: original quality isn\'t shrunk', () => {
  const portrait = { ...sdrMedia('dts'), video: { ...sdrMedia().video, width: 1920, height: 1080, rotation: 90 } };
  const plan = { ...decide({ ...base, media: portrait, caps: chrome }), media: portrait };
  assert.match(joined(plan, { ...settings, maxSoftwareHeight: 2160 }), /scale=-2:1920/, '1920 tall on screen, kept');
  assert.match(joined(plan, { ...settings, maxSoftwareHeight: 1080 }), /scale=-2:1080/, 'the cap still applies');
});

test('a software cap that binds is named in the reasons', async () => {
  const { softwareCapReason } = await import('../src/stream/playback.js');
  const uhd = { ...sdrMedia('dts'), video: { ...sdrMedia().video, width: 3840, height: 2160 } };
  const plan = { ...decide({ ...base, media: uhd, caps: chrome }), media: uhd };
  assert.equal(softwareCapReason(plan, { ...settings, maxSoftwareHeight: 1080 }), 'Capped at 1080p (software conversion)');
  assert.equal(softwareCapReason(plan, { ...settings, maxSoftwareHeight: 2160 }), null, 'not binding');
  assert.equal(softwareCapReason(plan, { ...settings, maxSoftwareHeight: 1080, hwAccel: 'nvenc' }), null, 'hardware isn\'t capped');
});

test('a conversion from the buffer reads the local playlist, rewound, with file-only protocols', () => {
  const media = sdrMedia('aac', 2);
  const plan = decide({ ...base, file: 'live.ts', media, caps: { ...chrome, video: ['vp9'] } });
  const j = buildFfmpegArgs({ ...plan, media, file: '/data/timeshift/t1/run-1/index.m3u8', start: 0, quality: 'original', live: { kind: 'buffer' }, behind: 60, headers: null }, settings, { type: 'progressive' }).join(' ');
  assert.match(j, /-live_start_index -15/);
  assert.match(j, /-protocol_whitelist file,crypto/);
  assert.match(j, /-i \/data\/timeshift\/t1\/run-1\/index\.m3u8/);
  assert.ok(!/-user_agent|-reconnect|-ss /.test(j), j);
  const live = buildFfmpegArgs({ ...plan, media, file: '/x/index.m3u8', start: 0, quality: 'original', live: { kind: 'buffer' }, behind: 0 }, settings, { type: 'progressive' }).join(' ');
  assert.match(live, /-live_start_index -2/, 'live: a couple of pieces back, as a live HLS player starts');
});
