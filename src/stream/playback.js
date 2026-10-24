// Playback: decides between direct play, remux and transcode, runs ffmpeg,
// and tracks who is watching what (for the admin dashboard).
//
//   direct     the browser plays the original file (HTTP range requests)
//   remux      video copied as-is, audio converted if needed, new container
//   transcode  video re-encoded to H.264 (CPU/GPU heavy)
//
// Delivery is either a progressive fragmented-MP4 stream (Chrome, Firefox,
// Edge) or HLS (Safari / iOS, which can't play unbounded MP4 streams).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { logger } from '../log.js';
import { parseJson } from '../db.js';
import { HttpError } from '../http/router.js';
import { sendFile, safeJoin } from '../http/static.js';
import { IMAGE_SUB_CODECS } from './subtitles.js';
import { keyframeAtOrBefore } from './keyframes.js';
import { headerArgs, liveInputArgs, redactArgs, redactText, NETWORK_ONLY } from './ffheaders.js';

const log = logger('playback');

export const QUALITIES = {
  original: null,
  2160: { height: 2160, bitrate: 20000 },
  1080: { height: 1080, bitrate: 8000 },
  720: { height: 720, bitrate: 4000 },
  480: { height: 480, bitrate: 1500 },
  360: { height: 360, bitrate: 800 },
};

const DIRECT_CONTAINERS = { '.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mp4', '.webm': 'webm' };
const COPYABLE_AUDIO = { mp4: new Set(['aac', 'mp3']), webm: new Set(['opus', 'vorbis']) };
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide how an item should be played for a given client.
 * @param {object} media  probe summary (may be null if ffprobe is missing)
 * @param {object} caps   { video: [], audio: [], containers: [], hls: bool }
 */
const HDR_SENTENCE = "This ffmpeg can't convert HDR video (it needs zscale or libplacebo).";
const DV_SENTENCE = "This ffmpeg can't convert Dolby Vision video (it needs libplacebo).";

/** Which filter converts this HDR source for a non-HDR sink: 'zscale' | 'libplacebo', or a 422 when this ffmpeg has neither. */
function hdrFilterFor(video, tools) {
  const f = tools?.filters || {};
  // Dolby Vision profile 5 has no HDR10 base layer: only libplacebo reads it. Other profiles tone-map as HDR10.
  if (video.dolbyVision?.profile === 5) {
    if (f.libplacebo) return 'libplacebo';
    throw new HttpError(422, DV_SENTENCE);
  }
  if (f.zscale && f.tonemap) return 'zscale';
  if (f.libplacebo) return 'libplacebo';
  throw new HttpError(422, HDR_SENTENCE);
}

export function decide({ file, media, caps, audioIndex, quality, burnSubtitle, forceTranscode, transcodingEnabled, tools = null }) {
  const ext = path.extname(file).toLowerCase();
  const container = DIRECT_CONTAINERS[ext];
  // Almost every browser plays H.264 in MP4. Browsers built without it (some
  // Linux Chromium builds) get VP8/Opus in WebM instead.
  const target = caps.video.includes('h264') || caps.hls ? 'mp4' : 'webm';
  const containerOk = Boolean(container && caps.containers.includes(container));
  const reasons = [];

  if (!media || media.error) {
    if (containerOk) return { mode: 'direct', target, reasons: ['No media info (is ffprobe installed?) — trying the file as-is'] };
    if (!transcodingEnabled) throw new HttpError(422, 'This file needs converting, but transcoding is turned off.');
    return { mode: 'transcode', target, audioCopy: false, reasons: ['No media info; converting to be safe'] };
  }

  // Music (or any file without a picture stream).
  if (!media.video && media.audio?.length) return decideAudio({ ext, media, caps, target, forceTranscode, transcodingEnabled });

  const v = media.video;
  const audios = media.audio || [];
  const defaultAudio = audios.find((a) => a.default) || audios[0];
  if (audioIndex != null && audioIndex !== '' && !audios.some((a) => a.index === Number(audioIndex))) throw new HttpError(400, "That audio track doesn't exist.");
  const audio = audioIndex != null && audioIndex !== '' ? audios.find((a) => a.index === Number(audioIndex)) : defaultAudio;
  const q = QUALITIES[quality] || null;

  // Dolby Vision profile 5 has no watchable base layer on ordinary screens, PQ tag or not: it counts as HDR.
  const hdrish = Boolean(v && (v.hdr || v.dolbyVision?.profile === 5));
  const videoOk = Boolean(
    v && caps.video.includes(v.codec) && !(v.codec === 'h264' && v.bitDepth > 8) && !(hdrish && !caps.hdr),
  );
  if (!v) reasons.push('No video stream');
  else if (!videoOk) reasons.push(`Browser can't play ${v.codec.toUpperCase()}${v.bitDepth > 8 ? ` ${v.bitDepth}-bit` : ''} video`);
  const audioOk = !audio || caps.audio.includes(audio.codec);
  if (!audioOk) reasons.push(`Browser can't play ${audio.codec.toUpperCase()} audio`);
  const nonDefaultAudio = audio && defaultAudio && audio.index !== defaultAudio.index;
  if (nonDefaultAudio) reasons.push('Switching audio track');
  const tooBig = q && v && v.height > q.height;
  if (tooBig) reasons.push(`Reducing quality to ${q.height}p`);
  if (!containerOk) reasons.push(`${ext.slice(1).toUpperCase()} container`);
  if (burnSubtitle != null) reasons.push('Burning in subtitles');
  if (forceTranscode) reasons.push('Transcode requested');

  // The track is kept as-is when the container can carry it and the sink plays it (in transcode mode too).
  const audioCopy = !audio || (COPYABLE_AUDIO[target].has(audio.codec) && audioOk);
  const canRemux = videoOk && (target === 'mp4' || WEBM_VIDEO.has(v.codec));

  if (!forceTranscode && burnSubtitle == null && !tooBig) {
    if (containerOk && videoOk && audioOk && !nonDefaultAudio) return { mode: 'direct', target, audio, reasons: ['Browser can play the original file'] };
    if (canRemux) return { mode: 'remux', target, audio, audioCopy, reasons };
  }
  if (!transcodingEnabled) throw new HttpError(422, `This file needs converting (${reasons.join(', ')}), but transcoding is turned off.`);
  // An HDR picture for a sink that can't show HDR is converted to normal colours — with a filter this ffmpeg has.
  const hdrFilter = hdrish && !caps.hdr ? hdrFilterFor(v, tools) : undefined;
  return { mode: 'transcode', target, audio, audioCopy, reasons, ...(hdrFilter ? { hdrFilter } : {}) };
}

const AUDIO_CONTAINERS = { '.mp3': 'mp4', '.m4a': 'mp4', '.m4b': 'mp4', '.aac': 'mp4', '.flac': 'mp4', '.wav': 'mp4', '.ogg': 'ogg', '.oga': 'ogg', '.opus': 'ogg', '.webm': 'webm' };

function decideAudio({ ext, media, caps, target, forceTranscode, transcodingEnabled }) {
  const audio = media.audio.find((a) => a.default) || media.audio[0];
  const codec = String(audio.codec || '').startsWith('pcm_') ? 'wav' : audio.codec;
  const container = AUDIO_CONTAINERS[ext];
  // mp3/flac/wav files are their own containers; the browser just needs the codec.
  const containerOk = Boolean(container && (container === 'mp4' || caps.containers.includes(container)));
  if (!forceTranscode && containerOk && caps.audio.includes(codec)) {
    return { mode: 'direct', target, audio, audioOnly: true, reasons: ['Browser can play the original file'] };
  }
  if (!transcodingEnabled) throw new HttpError(422, `This file needs converting (${String(audio.codec).toUpperCase()} audio), but transcoding is turned off.`);
  return { mode: 'transcode', target, audio, audioOnly: true, audioCopy: false, reasons: [forceTranscode ? 'Transcode requested' : `Browser can't play ${String(audio.codec).toUpperCase()} audio`] };
}

/** Live playback sessions one account may hold at once (idle ones are reaped after 2 min). */
export const MAX_SESSIONS_PER_USER = 4;
/** A dropped live stream is retried this many times within the window, then given up. */
const LIVE_RETRIES = 3;
const LIVE_RETRY_WINDOW_MS = 2 * 60 * 1000;

export function buildFfmpegArgs(plan, settings, output) {
  if (plan.audioOnly) return buildAudioArgs(plan, output);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const webm = plan.target === 'webm';
  const hw = plan.mode === 'transcode' && !webm ? settings.hwAccel : 'none';
  if (hw === 'vaapi') args.push('-vaapi_device', settings.vaapiDevice || '/dev/dri/renderD128');
  const endless = plan.live?.kind === 'live' || plan.live?.kind === 'buffer';
  if (plan.live?.kind === 'buffer') args.push(...bufferInputArgs(plan));
  else {
    if (endless) args.push(...liveInputArgs(plan.headers || {}));
    else if (plan.headers) args.push(...headerArgs(plan.headers));
    if (plan.live && !endless) args.push(...NETWORK_ONLY); // catch-up: the same network-only rule as live
    // HLS encodes to disk with nothing to hold it back: 1.5× real time keeps a background encode from running the
    // whole film at full speed (and three Safari viewers from starving each other). The progressive pipe is paced by
    // the socket. A live channel arrives in real time already.
    // Played faster than 1× (v0.21), the read-ahead keeps half a second per second ahead of it (2× → 2.5).
    if (!endless && output.type === 'hls' && (plan.tools?.ffmpeg?.major || 0) >= 5) args.push('-readrate', String(Math.max(1.5, (Number(plan.speed) || 1) + 0.5)));
    if (!endless && plan.start > 0) args.push('-ss', plan.start.toFixed(3));
  }
  args.push('-i', plan.file);
  // Delays (v0.20): the same file again, shifted with -itsoffset — one input for the audio, one for a burned picture
  // subtitle — read from the same start. Live TV never has them.
  const shifted = (d) => {
    args.push('-itsoffset', String(d));
    if (!endless && plan.start > 0) args.push('-ss', plan.start.toFixed(3));
    args.push('-i', plan.file);
  };
  let nextInput = 1;
  const audioInput = !endless && plan.audioDelay ? nextInput++ : 0;
  if (audioInput) shifted(plan.audioDelay);
  const subInput = !endless && plan.subtitleDelay && plan.burnSubtitle != null && plan.mode === 'transcode' ? nextInput++ : 0;
  if (subInput) shifted(plan.subtitleDelay);

  const q = QUALITIES[plan.quality] || null;
  const v = plan.media?.video || {};
  const srcHeight = shownHeight(v);
  const softCap = softwareCap(plan, settings);
  const targetHeight = Math.min(q ? Math.min(q.height, srcHeight) : srcHeight, softCap);
  const bitrate = q && q.height <= targetHeight ? q.bitrate : targetHeight >= 2000 ? 20000 : targetHeight >= 1000 ? 10000 : targetHeight >= 700 ? 5000 : 2500;
  const fps = Number(v.fps) || 25;
  const SEG = 2; // seconds per HLS segment / forced keyframe
  const gop = Math.round(SEG * fps);

  if (plan.mode === 'transcode') {
    const filters = [];
    let src = '[0:v:0]';
    // Picture-based subtitles (PGS/DVD) can't be shown by the browser, so they're drawn onto the video at the source
    // size, before any scaling. Text subtitles are rendered by the player instead (or drawn on for a DLNA TV, below).
    const burnCodec = plan.media?.subtitles?.find((s) => s.index === plan.burnSubtitle)?.codec;
    if (plan.burnSubtitle != null && IMAGE_SUB_CODECS.has(burnCodec)) {
      filters.push(`[0:v:0][${subInput}:s:${plan.burnSubtitle}]overlay[burned]`);
      src = '[burned]';
    }
    const steps = [];
    const tonemap = plan.hdrFilter ? hdrChain(plan.hdrFilter, v) : null;
    if (hw === 'vaapi' && !tonemap) steps.push('format=nv12', 'hwupload', `scale_vaapi=w=-2:h=${targetHeight}`);
    else steps.push(`scale=-2:${targetHeight}`);
    // The tone map runs after the scale (in float at the output size, not at 4K) and before any text is drawn on.
    if (tonemap) steps.push(tonemap);
    if (plan.burnTextFile) {
      // A text subtitle drawn on for a TV that can't show it (DLNA). With -ss before -i the video starts at 0, so the
      // timestamps go back to the file's own while the subtitle is drawn. ffmpeg runs in the subtitle's folder, so
      // the filter gets a bare file name (made by Atomix: hex and a dot) and no path needs filter escaping.
      const at = (plan.start || 0).toFixed(3);
      steps.push(`setpts=PTS+${at}/TB`, `subtitles=filename=${path.basename(plan.burnTextFile)}${fontsDirArg()}`, 'setpts=PTS-STARTPTS');
    }
    if (hw === 'vaapi' && tonemap) steps.push('format=nv12', 'hwupload');
    else if (hw !== 'vaapi') steps.push('format=yuv420p');
    filters.push(`${src}${steps.join(',')}[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');

    const maxrate = `${bitrate}k`;
    const bufsize = `${bitrate * 2}k`;
    const level = targetHeight > 1080 ? (fps > 30 ? '5.2' : '5.1') : fps > 30 ? '4.2' : '4.1';
    switch (webm ? 'vp8' : hw) {
      case 'vp8':
        args.push(
          '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', maxrate, '-maxrate', maxrate, '-bufsize', bufsize,
          '-qmin', '4', '-qmax', '48', '-auto-alt-ref', '0', '-lag-in-frames', '0', '-row-mt', '1', '-threads', String(os.cpus().length || 4),
        );
        break;
      case 'nvenc':
        // -forced-idr: the forced keyframes become IDR frames, so every HLS segment can be decoded on its own.
        args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', maxrate, '-bufsize', bufsize, '-profile:v', 'high', '-spatial-aq', '1', '-forced-idr', '1', '-g', String(gop));
        break;
      case 'qsv':
        args.push('-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '23', '-look_ahead', '0', '-maxrate', maxrate, '-bufsize', bufsize, '-forced_idr', '1', '-g', String(gop));
        break;
      case 'vaapi':
        args.push('-c:v', 'h264_vaapi', '-b:v', maxrate, '-maxrate', maxrate, '-g', String(gop));
        break;
      case 'videotoolbox':
        args.push('-c:v', 'h264_videotoolbox', '-b:v', maxrate, '-maxrate', maxrate, '-g', String(gop));
        break;
      case 'amf':
        args.push('-c:v', 'h264_amf', '-quality', 'speed', '-b:v', maxrate, '-maxrate', maxrate, '-g', String(gop));
        break;
      default:
        args.push(
          '-c:v', 'libx264', '-preset', settings.x264Preset || 'veryfast', '-crf', '21',
          '-maxrate', maxrate, '-bufsize', bufsize, '-profile:v', 'high', '-level:v', level,
        );
    }
    // Regular keyframes so HLS segments and seeking line up.
    args.push('-force_key_frames', `expr:gte(t,n_forced*${SEG})`);
    // Players read the colour tags: after a tone map the picture is plain BT.709, whatever the source said.
    if (tonemap) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  } else {
    args.push('-map', '0:v:0', '-c:v', 'copy');
    if (v.codec === 'hevc' && !webm) args.push('-tag:v', 'hvc1');
  }

  // A chosen track is mapped by index (a missing one was refused in decide); a file with no audio gets none.
  const hasAudio = Boolean(plan.audio) || (plan.media?.audio?.length ?? 1) > 0;
  const audioIndex = plan.audio?.index ?? 0;
  if (hasAudio) args.push('-map', plan.audio ? `${audioInput}:a:${audioIndex}` : `${audioInput}:a:${audioIndex}?`);
  const channels = Number(plan.audio?.channels) || 2;
  if (!hasAudio) { /* nothing to encode */ }
  else if (plan.audioCopy) args.push('-c:a', 'copy', ...adtsFix(plan));
  else {
    // Surround to stereo: dialogue (the centre) at full strength, the rest a little lower and limited — swresample's
    // default matrix normalises everything down and buries speech under the effects.
    if (channels > 2) args.push('-af', 'pan=stereo|FL=FC+0.30*FL+0.30*BL+0.30*SL|FR=FC+0.30*FR+0.30*BR+0.30*SR,alimiter=limit=0.95');
    else args.push('-ac', '2');
    if (webm) args.push('-c:a', 'libopus', '-b:a', '160k');
    else args.push('-c:a', 'aac', '-b:a', '192k');
  }

  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '2048');

  if (output.type === 'hls') {
    args.push('-f', 'hls', '-hls_time', String(SEG), '-hls_init_time', '1', ...hlsWindow(plan), '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(output.dir, 'seg%05d.m4s'), path.join(output.dir, 'index.m3u8'));
  } else if (webm) {
    args.push('-f', 'webm', 'pipe:1');
  } else {
    // frag_duration: a fragment every half second (or at a keyframe, whichever comes first), so the browser has
    // its first picture in about a second instead of waiting for a whole keyframe interval.
    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', 'pipe:1');
  }
  return args;
}

const ZSCALE_TRANSFER = new Set(['smpte2084', 'arib-std-b67', 'bt709', 'bt2020-10', 'bt2020-12', 'linear']);
const ZSCALE_PRIMARIES = new Set(['bt2020', 'bt709', 'smpte431', 'smpte432']);
const ZSCALE_MATRIX = new Set(['bt2020nc', 'bt2020c', 'bt709', 'bt470bg', 'smpte170m']);

/** The filter steps that turn an HDR picture into BT.709 (ends in yuv420p). */
function hdrChain(filter, v) {
  if (filter === 'libplacebo') return 'libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p';
  // zscale needs the input's colour stated — files often carry no tags, and then it stops with "no path between colorspaces".
  const c = v.colour || {};
  const tin = [ZSCALE_TRANSFER.has(c.transfer) ? `tin=${c.transfer}` : null, ZSCALE_PRIMARIES.has(c.primaries) ? `pin=${c.primaries}` : null, ZSCALE_MATRIX.has(c.matrix) ? `min=${c.matrix}` : null].filter(Boolean);
  return `zscale=${[...tin, 't=linear', 'npl=100'].join(':')},format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
}

/**
 * `:fontsdir=…` for the subtitles filter: the OS font folder, so libass resolves fonts there. A colon (a Windows drive
 * letter) needs two backslashes in the argv: ffmpeg unescapes the filtergraph once, then splits options on bare colons.
 */
export function fontsDirArg(platform = process.platform, dir = null, env = process.env) {
  const folder = dir || (platform === 'win32' ? `${(env.WINDIR || env.SystemRoot || 'C:\\Windows').replace(/\\/g, '/')}/Fonts` : platform === 'darwin' ? '/Library/Fonts' : '/usr/share/fonts');
  return `:fontsdir=${folder.replace(/:/g, '\\\\:')}`;
}

/**
 * AAC as MPEG-TS (and raw .aac radio) carries it, with ADTS headers, can't be copied into MP4 as-is; this filter
 * rewrites it (and leaves AAC that is already MP4-style alone).
 */
/**
 * A conversion reading a tuner's buffer (its playlist on this server, from 0.19): local files only, starting `behind`
 * seconds back (at least two pieces, as a live HLS player starts). Never the provider's options: they're the tuner's.
 */
function bufferInputArgs(plan) {
  // The tuner counts its own pieces (1 s at first, then 4 s): behindPieces; else an estimate from 4-s pieces.
  const pieces = plan.behindPieces || Math.max(2, Math.ceil((Number(plan.behind) || 0) / 4));
  // max_reload: ffmpeg gives up on a live playlist that hasn't grown after 3 re-reads (3 s with 1-s pieces) and ends
  // as if the stream had finished. A provider that sends its stream in bursts (HLS radio: a 10-s segment at a time)
  // leaves the buffer still that long, so the conversion keeps waiting instead.
  return ['-protocol_whitelist', 'file,crypto', '-max_reload', '1000', '-live_start_index', String(-pieces)];
}

function adtsFix(plan) {
  return plan.target !== 'webm' && plan.audio?.codec === 'aac' ? ['-bsf:a', 'aac_adtstoasc'] : [];
}

/** HLS playlist window: a film keeps every segment (an "event" list); a live channel keeps the last six. */
function hlsWindow(plan) {
  if (plan.live?.kind === 'live' || plan.live?.kind === 'buffer') return ['-hls_list_size', '6', '-hls_flags', 'delete_segments+independent_segments+append_list+discont_start'];
  return ['-hls_list_size', '0', '-hls_playlist_type', 'event'];
}

function buildAudioArgs(plan, output) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const endless = plan.live?.kind === 'live' || plan.live?.kind === 'buffer';
  if (plan.live?.kind === 'buffer') args.push(...bufferInputArgs(plan));
  else {
    if (endless) args.push(...liveInputArgs(plan.headers || {}));
    else if (plan.headers) args.push(...headerArgs(plan.headers));
    if (plan.live && !endless) args.push(...NETWORK_ONLY);
    if (!endless && plan.start > 0) args.push('-ss', plan.start.toFixed(3));
  }
  // A live radio stream has one audio track: the first one, whatever its stream number.
  args.push('-i', plan.file, '-map', endless || plan.live ? '0:a:0' : `0:a:${plan.audio?.index ?? 0}`, '-vn', '-sn', '-dn', '-map_metadata', '-1');
  if (plan.audioCopy) args.push('-c:a', 'copy', ...adtsFix(plan));
  else if (plan.target === 'webm') args.push('-c:a', 'libopus', '-b:a', '160k', '-ac', '2');
  else args.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2');
  if (output.type === 'hls') {
    args.push('-f', 'hls', '-hls_time', '6', ...hlsWindow(plan), '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(output.dir, 'seg%05d.m4s'), path.join(output.dir, 'index.m3u8'));
  } else if (plan.target === 'webm') args.push('-f', 'webm', 'pipe:1');
  // frag_duration: audio copied from a tuner's buffer (fMP4 pieces) carries no keyframe marks, so fragments are cut by
  // time — with frag_keyframe alone nothing after the header would ever be sent.
  else args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', 'pipe:1');
  return args;
}

/** A video's height on screen: a 90°/270° rotation (a phone video) shows its coded width as its height. */
const shownHeight = (v) => (v?.rotation === 90 || v?.rotation === 270 ? v.width || v.height || 1080 : v?.height || 1080);

/** The height a software conversion is held to (a PC can't keep up with 4K at veryfast); Infinity for hardware. */
function softwareCap(plan, settings) {
  const webm = plan.target === 'webm';
  const hw = plan.mode === 'transcode' && !webm ? settings.hwAccel : 'none';
  const software = webm || hw === 'none';
  return software && Number(settings.maxSoftwareHeight) > 0 ? Number(settings.maxSoftwareHeight) : Infinity;
}

/** "Capped at 1080p (software conversion)" when that cap lowers this conversion; else null. */
export function softwareCapReason(plan, settings) {
  if (plan.mode !== 'transcode') return null;
  const cap = softwareCap(plan, settings);
  const q = QUALITIES[plan.quality] || null;
  const wanted = q ? Math.min(q.height, shownHeight(plan.media?.video)) : shownHeight(plan.media?.video);
  return Number.isFinite(cap) && wanted > cap ? `Capped at ${cap}p (software conversion)` : null;
}

/** Live radio passed through untouched: an ffmpeg that copies, not one of the conversions the cap is for. */
const isRadioCopy = (s) => Boolean(s.live && s.audioOnly && s.audioCopy);

export class PlaybackManager {
  constructor({ db, config, settings, hooks, tools }) {
    this.db = db;
    this.config = config;
    this.settings = settings;
    this.hooks = hooks;
    this.tools = tools || (() => ({ ffmpeg: { available: true } }));
    this.sessions = new Map();
    this.ended = new Map(); // id -> { error, at }: why a session ended on its own (the player's next ping hears it)
    fs.rmSync(config.transcodeDir, { recursive: true, force: true });
    fs.mkdirSync(config.transcodeDir, { recursive: true });
    setInterval(() => this.reap(), 15000).unref();
  }

  activeTranscodes() {
    return [...this.sessions.values()].filter((s) => s.proc && s.mode === 'transcode').length;
  }
  /** Every ffmpeg this server is running for playback (remuxes included) plus subtitle extractions. */
  activeProcesses({ except = null } = {}) {
    return [...this.sessions.values()].filter((s) => s.proc && !s.proc.killed && s.id !== except && !isRadioCopy(s)).length + (this.extractions || 0);
  }
  /** A slot in the ffmpeg pool for a subtitle extraction; released when the run ends. */
  extractionSlot() {
    const max = Number(this.settings.get('maxTranscodes')) || 3;
    if (this.activeProcesses() >= max) throw new HttpError(503, 'Busy converting other songs or videos; try again in a moment.');
    this.extractions = (this.extractions || 0) + 1;
    let open = true;
    return {
      release: () => {
        if (!open) return;
        open = false;
        this.extractions--;
      },
    };
  }
  /** Live playback sessions of one user. */
  sessionsOf(userId) {
    // Encrypted Live TV sessions (played by the browser, relayed by Atomix) count toward the account's cap too.
    return [...[...this.sessions.values()].filter((s) => s.userId === userId), ...(this.externalLists || []).flatMap((fn) => fn(userId))];
  }

  /** Start (or replace) a playback session. */
  /**
   * Start (or replace) a playback session. Casting adds `castDevice` (the TV's name), `extraHeaders` (sent with a
   * converted stream: DLNA's transferMode/contentFeatures) and `burnTextFile` (a .vtt drawn onto the video).
   */
  /**
   * `replaces`: an old session stopped now. `keepUntilLoaded`: an old session the caller stops itself once the new
   * one is playing (a cast restart: the TV keeps the old stream until it has the new one) — it isn't counted against
   * the caps meanwhile.
   */
  async create({ user, profile, item, source = null, caps, start = 0, audioIndex = null, quality = 'original', burnSubtitle = null, audioDelay = 0, subtitleDelay = 0, burnTextFile = null, forceTranscode = false, replaces, keepUntilLoaded = null, clientIp, castDevice = null, extraHeaders = null, live = null, audioOnly = false, behind = 0, behindPieces = null, speed = 1 }) {
    if (replaces) {
      const old = this.sessions.get(replaces);
      if (old && old.userId === user.id) this.stop(old.id, 'replaced');
    }
    const countsFor = (s) => s.id !== keepUntilLoaded;
    if (this.sessionsOf(user.id).filter(countsFor).length >= MAX_SESSIONS_PER_USER) throw new HttpError(429, 'Too many streams open on this account.');
    const settings = this.settings.all();
    let media = typeof item.media === 'string' ? parseJson(item.media, null) : item.media || null;
    // Radio (or "listen only"): the picture is left out and the music path decides.
    if (audioOnly && media?.video) media = { ...media, video: null };
    // A connected server's title: the stream URL stands in for the file; the container is what decide() needs a name for.
    // A live channel or catch-up is never played as-is: the browser can't reach the provider (and often can't play TS).
    const file = source?.file || item.path;
    const decideName = live ? 'live.ts' : source?.remote ? `remote.${(media?.container || '').split(',')[0].trim() || 'bin'}` : file;
    const plan = decide({
      file: decideName,
      media,
      caps,
      audioIndex,
      quality,
      burnSubtitle: burnSubtitle ?? (burnTextFile ? -1 : null),
      forceTranscode,
      transcodingEnabled: settings.transcodingEnabled,
      tools: this.tools(),
    });
    plan.tools = this.tools();
    // Live radio: MP3/AAC (or Opus for WebM) are passed through untouched.
    if (live && plan.audioOnly && plan.audio && (plan.target === 'webm' ? plan.audio.codec === 'opus' : ['aac', 'mp3'].includes(plan.audio.codec))) {
      plan.audioCopy = true;
      plan.mode = 'remux'; // copied, not converted
      plan.reasons = ['Live radio, passed through'];
    }

    // An audio delay needs ffmpeg: a file that would play as-is is copied with the shift instead (still not converted).
    // Not for a connected server's title: the shifted second input would open its address again without its sign-in.
    const delayed = !live && !audioOnly && !source?.remote && Number(audioDelay) ? Number(audioDelay) : 0;
    if (delayed && plan.mode === 'direct') {
      plan.mode = 'remux';
      plan.audioCopy = true;
      plan.reasons = ['Audio delay'];
    } else if (delayed) plan.reasons = [...(plan.reasons || []), 'Audio delay'];
    const capNote = softwareCapReason({ ...plan, media, quality }, this.settings.all());
    if (capNote) plan.reasons = [...(plan.reasons || []), capNote];
    if (plan.mode !== 'direct' && !this.tools().ffmpeg?.available) {
      throw new HttpError(422, `This file needs converting (${plan.reasons.join(', ')}), but ffmpeg isn't installed on the server.`);
    }
    const id = crypto.randomBytes(16).toString('hex');
    const delivery = plan.mode === 'direct' ? 'file' : caps.hls ? 'hls' : 'progressive';
    // A remux can only begin at a keyframe: tell the player where the picture really starts (local files; a
    // connected server's stream isn't read twice for it).
    let from = plan.mode === 'direct' ? 0 : Math.max(0, Number(start) || 0);
    if (plan.mode === 'remux' && from > 0 && !source?.remote && this.config.ffprobePath) {
      const kf = await keyframeAtOrBefore(this.config.ffprobePath, file, from, { headers: source?.headers || null });
      if (kf != null && kf <= from) from = kf;
    }
    const session = {
      id,
      userId: user.id,
      profileId: profile?.id ?? null,
      username: profile && profile.name !== (user.display_name || user.username) ? `${profile.name} (${user.username})` : user.display_name || user.username,
      itemId: item.id,
      title: item.title,
      file,
      headers: source?.headers || null,
      media,
      mode: plan.mode,
      target: plan.target,
      audioOnly: Boolean(plan.audioOnly),
      delivery,
      start: from,
      audio: plan.audio,
      audioCopy: plan.audioCopy,
      hdrFilter: plan.hdrFilter,
      tools: plan.tools,
      quality,
      burnSubtitle,
      burnTextFile: burnTextFile || null,
      audioDelay: delayed,
      subtitleDelay: !live && !source?.remote && Number(subtitleDelay) ? Number(subtitleDelay) : 0,
      castDevice,
      extraHeaders,
      reasons: plan.reasons,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      position: from,
      paused: false,
      clientIp,
      proc: null,
      dir: null,
      replacing: keepUntilLoaded,
      behind: live?.kind === 'buffer' ? Math.max(0, Math.min(1800, Number(behind) || 0)) : 0, // seconds behind live (rewind)
      behindPieces: live?.kind === 'buffer' ? behindPieces : null, // …as the tuner counts its pieces
      speed: Math.max(0.5, Math.min(2, Number(speed) || 1)), // the player's speed (the HLS read-ahead follows it)
      live: live ? { ...live } : null, // { kind: 'live'|'catchup', sourceKey, channelId, channelName, programmeId? }
      duration: live?.kind === 'live' || live?.kind === 'buffer' ? null : item.duration || media?.duration || null,
      failures: [],
      notice: null,
    };
    if (this.sessionsOf(user.id).filter(countsFor).length >= MAX_SESSIONS_PER_USER) throw new HttpError(429, 'Too many streams open on this account.');
    this.sessions.set(id, session);
    let url;
    if (delivery === 'file') url = `/api/items/${item.id}/file`;
    else if (delivery === 'hls') url = `/api/hls/${id}/index.m3u8`;
    else url = `/api/stream/${id}`;
    this.hooks.emit('playback:start', { session: this.publicSession(session), user, item });
    return { session, url };
  }

  get(id, user) {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, this.ended.get(id)?.error || 'Playback session expired — press play again.');
    if (user && s.userId !== user.id) throw new HttpError(403, 'Not your session');
    s.lastSeen = Date.now();
    return s;
  }

  checkCapacity(session) {
    if (session.mode === 'direct' || isRadioCopy(session)) return; // a copied radio stream converts nothing
    const max = Number(this.settings.get('maxTranscodes')) || 3;
    // The stream this one replaces (a cast restart) is on its way out: it doesn't count.
    if (this.activeProcesses({ except: session.replacing || null }) >= max) throw new HttpError(503, `The server is already converting ${max} videos. Try again shortly or pick a lower quality.`);
  }

  spawn(session, output) {
    const args = buildFfmpegArgs(session, this.settings.all(), output);
    log.debug(`ffmpeg ${redactArgs(args).join(' ')}`);
    const cwd = session.burnTextFile ? path.dirname(session.burnTextFile) : undefined;
    const proc = spawn(this.config.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd });
    const errors = [];
    proc.stderr.on('data', (c) => {
      errors.push(c);
      if (errors.length > 50) errors.shift();
    });
    proc.on('error', (err) => log.error(`ffmpeg failed to start: ${err.message}`));
    proc.on('close', (code, signal) => {
      if (code && !signal && code !== 255) log.warn(`ffmpeg exited with ${code}: ${redactText(Buffer.concat(errors).toString().trim().slice(-800))}`);
      if (session.proc === proc) session.proc = null;
      // A live channel never ends on its own: an exit we didn't cause is a dropped stream.
      if ((session.live?.kind === 'live' || session.live?.kind === 'buffer') && !signal && this.sessions.get(session.id) === session) this.liveDropped(session, output);
    });
    session.proc = proc;
    return proc;
  }

  /**
   * Start a session's ffmpeg again on purpose (its input moved: a tuner's new run), not counted as a drop. HLS is
   * restarted here; a progressive stream ends and the player's reconnect starts it again.
   */
  respawn(session) {
    const proc = session.proc;
    if (proc) {
      proc.replacedOnPurpose = true;
      proc.kill('SIGKILL');
    }
    session.proc = null;
    if (session.delivery === 'hls' && session.dir && this.sessions.get(session.id) === session) this.spawn(session, { type: 'hls', dir: session.dir });
  }

  /** Progressive fragmented-MP4 stream (Chrome/Firefox/Edge). */
  streamProgressive(ctx, id) {
    const session = this.get(id, ctx.user);
    if (session.delivery !== 'progressive') throw new HttpError(400, 'Wrong delivery type');
    const type = `${session.audioOnly ? 'audio' : 'video'}/${session.target === 'webm' ? 'webm' : 'mp4'}`;
    const extra = session.extraHeaders || {};
    if (ctx.req.method === 'HEAD') {
      ctx.res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'none', ...extra }).end();
      return;
    }
    if (session.proc) {
      session.proc.kill('SIGKILL');
      session.proc = null;
    }
    this.checkCapacity(session);
    const proc = this.spawn(session, { type: 'progressive' });
    const { res } = ctx;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', ...extra });
    proc.stdout.pipe(res);
    const cleanup = () => {
      if (proc.exitCode == null) proc.kill('SIGKILL');
    };
    res.on('close', cleanup);
    proc.on('close', () => res.end());
  }

  /** HLS playlist and segments (Safari / iOS). */
  async serveHls(ctx, id, name) {
    const session = this.get(id, ctx.user);
    if (session.delivery !== 'hls') throw new HttpError(400, 'Wrong delivery type');
    if (!session.dir) {
      this.checkCapacity(session);
      session.dir = path.join(this.config.transcodeDir, session.id);
      fs.mkdirSync(session.dir, { recursive: true });
      this.spawn(session, { type: 'hls', dir: session.dir });
    }
    const file = safeJoin(session.dir, name);
    if (!file || !/^(index\.m3u8|init\.mp4|seg\d+\.m4s)$/.test(name)) throw new HttpError(404, 'Not found');
    // Wait for ffmpeg to produce the file (the playlist needs at least one segment).
    const deadline = Date.now() + 30000;
    for (;;) {
      if (fs.existsSync(file)) {
        if (name !== 'index.m3u8') break;
        const text = fs.readFileSync(file, 'utf8');
        if (/#EXTINF/.test(text)) break;
      }
      if (Date.now() > deadline) throw new HttpError(504, 'Transcoder is taking too long to start');
      // Still waiting and no encoder running (it died, or was stopped): say so now, not after 30 s — the playlist
      // without a segment yet included.
      if (!session.proc) throw new HttpError(500, 'Transcoder stopped unexpectedly');
      await sleep(250);
    }
    // Fetched with a cast link (AirPlay: the Apple TV has no cookie): every playlist entry carries the link too,
    // since relative URLs drop the query string.
    const token = ctx.castLink && ctx.query?.cast;
    if (token && name === 'index.m3u8') {
      const add = (u) => `${u}${u.includes('?') ? '&' : '?'}cast=${encodeURIComponent(token)}`;
      const text = fs.readFileSync(file, 'utf8').split('\n').map((line) => (line && !line.startsWith('#') ? add(line.trim()) : line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${add(u)}"`))).join('\n');
      ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      ctx.res.end(text);
      return;
    }
    await sendFile(ctx.req, ctx.res, file, { cacheControl: 'no-cache' });
  }

  /**
   * A live stream dropped: the player reconnects (a progressive stream) or the encoder restarts here (HLS), up to
   * 3 times in 2 minutes; the 4th ends the session with a sentence the player's next ping hears.
   */
  liveDropped(session, output) {
    this.onLiveDropped?.(session);
    const now = Date.now();
    session.failures = [...(session.failures || []).filter((t) => now - t < LIVE_RETRY_WINDOW_MS), now];
    if (session.failures.length > LIVE_RETRIES) {
      this.ended.set(session.id, { error: 'This channel stopped sending video.', at: now });
      this.stop(session.id, 'stream lost');
      return;
    }
    session.notice = 'Lost the channel — trying again';
    this.hooks.emit('playback:notice', { sessionId: session.id, text: session.notice });
    if (output?.type === 'hls' && session.dir) {
      const t = setTimeout(() => {
        if (this.sessions.get(session.id) === session && !session.proc) this.spawn(session, output);
      }, 1000);
      t.unref?.();
    }
  }

  /** The player's ping: keeps the session alive and hears what happened to it (a notice, or why it ended). */
  heartbeat(id, user, { position, paused } = {}) {
    const s = this.sessions.get(id);
    if (!s) {
      const ended = this.ended.get(id);
      return ended ? { ok: false, error: ended.error } : { ok: false };
    }
    if (s.userId !== user.id) return { ok: false };
    s.lastSeen = Date.now();
    if (position != null) s.position = Number(position);
    if (paused != null) s.paused = Boolean(paused);
    const out = { ok: true };
    if (s.notice) {
      out.notice = s.notice;
      s.notice = null;
    }
    return out;
  }

  stop(id, reason = 'stopped') {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.proc) s.proc.kill('SIGKILL');
    if (s.dir) fs.rm(s.dir, { recursive: true, force: true }, () => {});
    if (s.burnTextFile) fs.rm(s.burnTextFile, { force: true }, () => {});
    this.sessions.delete(id);
    this.hooks.emit('playback:stop', { session: this.publicSession(s), reason });
  }

  reap() {
    const now = Date.now();
    for (const [id, e] of this.ended) if (now - e.at > 5 * 60 * 1000) this.ended.delete(id);
    for (const s of this.sessions.values()) {
      // The player sends a heartbeat every few seconds (even when paused), so a
      // silent session means the viewer closed the tab.
      if (now - s.lastSeen > 2 * 60 * 1000) this.stop(s.id, 'idle');
    }
  }

  publicSession(s) {
    return {
      id: s.id,
      user: s.username,
      itemId: s.itemId,
      title: s.title,
      mode: s.mode,
      delivery: s.delivery,
      quality: s.quality,
      position: s.position,
      paused: s.paused,
      reasons: s.reasons,
      startedAt: s.createdAt,
      clientIp: s.clientIp,
      castDevice: s.castDevice || null,
      transcoding: Boolean(s.proc),
    };
  }

  list() {
    return [...this.sessions.values()].map((s) => this.publicSession(s));
  }
}
