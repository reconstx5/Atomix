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
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { logger } from '../log.js';
import { parseJson } from '../db.js';
import { HttpError } from '../http/router.js';
import { sendFile, safeJoin } from '../http/static.js';
import { IMAGE_SUB_CODECS } from './subtitles.js';
import { headerArgs, redactArgs } from './ffheaders.js';

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
export function decide({ file, media, caps, audioIndex, quality, burnSubtitle, forceTranscode, transcodingEnabled }) {
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
  const audio = audioIndex != null ? audios.find((a) => a.index === audioIndex) || defaultAudio : defaultAudio;
  const q = QUALITIES[quality] || null;

  const videoOk = Boolean(
    v && caps.video.includes(v.codec) && !(v.codec === 'h264' && v.bitDepth > 8) && !(v.hdr && !caps.hdr),
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

  const audioCopy = !audio || COPYABLE_AUDIO[target].has(audio.codec);
  const canRemux = videoOk && (target === 'mp4' || WEBM_VIDEO.has(v.codec));

  if (!forceTranscode && burnSubtitle == null && !tooBig) {
    if (containerOk && videoOk && audioOk && !nonDefaultAudio) return { mode: 'direct', target, audio, reasons: ['Browser can play the original file'] };
    if (canRemux) return { mode: 'remux', target, audio, audioCopy, reasons };
  }
  if (!transcodingEnabled) throw new HttpError(422, `This file needs converting (${reasons.join(', ')}), but transcoding is turned off.`);
  return { mode: 'transcode', target, audio, audioCopy, reasons };
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

export function buildFfmpegArgs(plan, settings, output) {
  if (plan.audioOnly) return buildAudioArgs(plan, output);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const webm = plan.target === 'webm';
  const hw = plan.mode === 'transcode' && !webm ? settings.hwAccel : 'none';
  if (hw === 'vaapi') args.push('-vaapi_device', settings.vaapiDevice || '/dev/dri/renderD128');
  if (plan.headers) args.push(...headerArgs(plan.headers));
  if (plan.start > 0) args.push('-ss', plan.start.toFixed(3));
  args.push('-i', plan.file);

  const q = QUALITIES[plan.quality] || null;
  const srcHeight = plan.media?.video?.height || 1080;
  const targetHeight = q ? Math.min(q.height, srcHeight) : srcHeight;
  const bitrate = q ? q.bitrate : targetHeight >= 2000 ? 20000 : targetHeight >= 1000 ? 10000 : targetHeight >= 700 ? 5000 : 2500;

  if (plan.mode === 'transcode') {
    const filters = [];
    let videoLabel = '0:v:0';
    // Picture-based subtitles (PGS/DVD) can't be shown by the browser, so they're
    // drawn onto the video. Text subtitles are rendered by the player instead.
    const burnCodec = plan.media?.subtitles?.find((s) => s.index === plan.burnSubtitle)?.codec;
    if (plan.burnSubtitle != null && IMAGE_SUB_CODECS.has(burnCodec)) {
      filters.push(`[0:v:0][0:s:${plan.burnSubtitle}]overlay[burned]`);
      videoLabel = '[burned]';
    } else if (plan.burnTextFile) {
      // A text subtitle drawn on for a TV that can't show it (DLNA). With -ss before -i the video starts at 0, so the
      // timestamps go back to the file's own while the subtitle is drawn. ffmpeg runs in the subtitle's folder, so
      // the filter gets a bare file name (made by Atomix: hex and a dot) and no path needs filter escaping.
      const at = (plan.start || 0).toFixed(3);
      filters.push(`[0:v:0]setpts=PTS+${at}/TB,subtitles=filename=${path.basename(plan.burnTextFile)},setpts=PTS-STARTPTS[burned]`);
      videoLabel = '[burned]';
    }
    const scale = hw === 'vaapi' ? `format=nv12,hwupload,scale_vaapi=w=-2:h=${targetHeight}` : `scale=-2:${targetHeight}`;
    const src = videoLabel.startsWith('[') ? videoLabel : `[${videoLabel}]`;
    filters.push(`${src}${scale}${hw === 'vaapi' ? '' : ',format=yuv420p'}[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');

    const maxrate = `${bitrate}k`;
    const bufsize = `${bitrate * 2}k`;
    switch (webm ? 'vp8' : hw) {
      case 'vp8':
        args.push(
          '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', maxrate, '-maxrate', maxrate, '-bufsize', bufsize,
          '-qmin', '4', '-qmax', '48', '-auto-alt-ref', '0', '-lag-in-frames', '0', '-threads', '4',
        );
        break;
      case 'nvenc':
        args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-maxrate', maxrate, '-bufsize', bufsize);
        break;
      case 'qsv':
        args.push('-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '23', '-maxrate', maxrate, '-bufsize', bufsize);
        break;
      case 'vaapi':
        args.push('-c:v', 'h264_vaapi', '-b:v', maxrate, '-maxrate', maxrate);
        break;
      case 'videotoolbox':
        args.push('-c:v', 'h264_videotoolbox', '-b:v', maxrate, '-maxrate', maxrate);
        break;
      case 'amf':
        args.push('-c:v', 'h264_amf', '-quality', 'speed', '-b:v', maxrate, '-maxrate', maxrate);
        break;
      default:
        args.push(
          '-c:v', 'libx264', '-preset', settings.x264Preset || 'veryfast', '-crf', '21',
          '-maxrate', maxrate, '-bufsize', bufsize, '-profile:v', 'high', '-level:v', targetHeight > 1080 ? '5.1' : '4.1',
        );
    }
    // Regular keyframes so HLS segments and seeking line up.
    args.push('-force_key_frames', 'expr:gte(t,n_forced*4)');
  } else {
    args.push('-map', '0:v:0', '-c:v', 'copy');
    if (plan.media?.video?.codec === 'hevc' && !webm) args.push('-tag:v', 'hvc1');
  }

  const audioIndex = plan.audio?.index ?? 0;
  args.push('-map', `0:a:${audioIndex}?`);
  if (plan.audioCopy && plan.mode === 'remux') args.push('-c:a', 'copy');
  else if (webm) args.push('-c:a', 'libopus', '-ac', '2', '-b:a', '160k');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');

  args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-max_muxing_queue_size', '2048');

  if (output.type === 'hls') {
    args.push(
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(output.dir, 'seg%05d.m4s'),
      path.join(output.dir, 'index.m3u8'),
    );
  } else if (webm) {
    args.push('-f', 'webm', 'pipe:1');
  } else {
    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  }
  return args;
}

function buildAudioArgs(plan, output) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (plan.headers) args.push(...headerArgs(plan.headers));
  if (plan.start > 0) args.push('-ss', plan.start.toFixed(3));
  args.push('-i', plan.file, '-map', `0:a:${plan.audio?.index ?? 0}`, '-vn', '-sn', '-dn', '-map_metadata', '-1');
  if (plan.target === 'webm') args.push('-c:a', 'libopus', '-b:a', '160k', '-ac', '2');
  else args.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2');
  if (output.type === 'hls') {
    args.push(
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(output.dir, 'seg%05d.m4s'),
      path.join(output.dir, 'index.m3u8'),
    );
  } else if (plan.target === 'webm') args.push('-f', 'webm', 'pipe:1');
  else args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

export class PlaybackManager {
  constructor({ db, config, settings, hooks, tools }) {
    this.db = db;
    this.config = config;
    this.settings = settings;
    this.hooks = hooks;
    this.tools = tools || (() => ({ ffmpeg: { available: true } }));
    this.sessions = new Map();
    fs.rmSync(config.transcodeDir, { recursive: true, force: true });
    fs.mkdirSync(config.transcodeDir, { recursive: true });
    setInterval(() => this.reap(), 15000).unref();
  }

  activeTranscodes() {
    return [...this.sessions.values()].filter((s) => s.proc && s.mode === 'transcode').length;
  }

  /** Start (or replace) a playback session. */
  /**
   * Start (or replace) a playback session. Casting adds `castDevice` (the TV's name), `extraHeaders` (sent with a
   * converted stream: DLNA's transferMode/contentFeatures) and `burnTextFile` (a .vtt drawn onto the video).
   */
  create({ user, profile, item, source = null, caps, start = 0, audioIndex = null, quality = 'original', burnSubtitle = null, burnTextFile = null, forceTranscode = false, replaces, clientIp, castDevice = null, extraHeaders = null }) {
    if (replaces) {
      const old = this.sessions.get(replaces);
      if (old && old.userId === user.id) this.stop(old.id, 'replaced');
    }
    const settings = this.settings.all();
    const media = parseJson(item.media, null);
    // A connected server's title: the stream URL stands in for the file; the container is what decide() needs a name for.
    const file = source?.file || item.path;
    const decideName = source?.remote ? `remote.${(media?.container || '').split(',')[0].trim() || 'bin'}` : file;
    const plan = decide({
      file: decideName,
      media,
      caps,
      audioIndex,
      quality,
      burnSubtitle: burnSubtitle ?? (burnTextFile ? -1 : null),
      forceTranscode,
      transcodingEnabled: settings.transcodingEnabled,
    });

    if (plan.mode !== 'direct' && !this.tools().ffmpeg?.available) {
      throw new HttpError(422, `This file needs converting (${plan.reasons.join(', ')}), but ffmpeg isn't installed on the server.`);
    }
    const id = crypto.randomBytes(16).toString('hex');
    const delivery = plan.mode === 'direct' ? 'file' : caps.hls ? 'hls' : 'progressive';
    const session = {
      id,
      userId: user.id,
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
      start: plan.mode === 'direct' ? 0 : Math.max(0, Number(start) || 0),
      audio: plan.audio,
      audioCopy: plan.audioCopy,
      quality,
      burnSubtitle,
      burnTextFile: burnTextFile || null,
      castDevice,
      extraHeaders,
      reasons: plan.reasons,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      position: Number(start) || 0,
      paused: false,
      clientIp,
      proc: null,
      dir: null,
    };
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
    if (!s) throw new HttpError(404, 'Playback session expired — press play again.');
    if (user && s.userId !== user.id) throw new HttpError(403, 'Not your session');
    s.lastSeen = Date.now();
    return s;
  }

  checkCapacity(session) {
    if (session.mode !== 'transcode') return;
    const max = Number(this.settings.get('maxTranscodes')) || 3;
    if (this.activeTranscodes() >= max) throw new HttpError(503, `The server is already converting ${max} videos. Try again shortly or pick a lower quality.`);
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
      if (code && !signal && code !== 255) log.warn(`ffmpeg exited with ${code}: ${Buffer.concat(errors).toString().trim().slice(-800)}`);
      if (session.proc === proc) session.proc = null;
    });
    session.proc = proc;
    return proc;
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
      if (!session.proc && !fs.existsSync(file)) throw new HttpError(500, 'Transcoder stopped unexpectedly');
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

  heartbeat(id, user, { position, paused }) {
    const s = this.sessions.get(id);
    if (!s || s.userId !== user.id) return;
    s.lastSeen = Date.now();
    if (position != null) s.position = Number(position);
    if (paused != null) s.paused = Boolean(paused);
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
