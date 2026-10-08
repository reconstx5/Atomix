// ffprobe wrapper: reads codecs, duration and tracks from a media file.
import { spawn } from 'node:child_process';
import { normaliseTags } from './music.js';

export function run(bin, args, { timeout = 60000, maxBuffer = 20 * 1024 * 1024, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    // The background job runner lowers ffmpeg's priority and kills it when playback needs the CPU.
    onSpawn?.(proc);
    const out = [];
    const errOut = [];
    let size = 0;
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out`));
    }, timeout);
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size <= maxBuffer) out.push(c);
    });
    proc.stderr.on('data', (c) => errOut.push(c));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited with ${code}: ${Buffer.concat(errOut).toString().slice(-500)}`));
    });
  });
}

/** Check whether ffmpeg/ffprobe can be run and report their versions. */
export async function detectTools(config) {
  const check = async (bin) => {
    try {
      const out = (await run(bin, ['-version'], { timeout: 10000 })).toString();
      const version = /version\s+(\S+)/.exec(out)?.[1] || 'unknown';
      return { available: true, version, path: bin };
    } catch (err) {
      return { available: false, error: err.code === 'ENOENT' ? 'not found' : err.message, path: bin };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([check(config.ffmpegPath), check(config.ffprobePath)]);
  let encoders = [];
  if (ffmpeg.available) {
    try {
      const out = (await run(config.ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10000 })).toString();
      encoders = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_videotoolbox', 'h264_amf'].filter((e) =>
        new RegExp(`\\s${e}\\s`).test(out),
      );
    } catch {
      /* ignore */
    }
  }
  // Used to tone-map HDR films for seek-bar previews, when this ffmpeg has them.
  let filters = { zscale: false, tonemap: false, subtitles: false };
  if (ffmpeg.available) {
    try {
      const out = (await run(config.ffmpegPath, ['-hide_banner', '-filters'], { timeout: 10000 })).toString();
      filters = { zscale: /\szscale\s/.test(out), tonemap: /\stonemap\s/.test(out), subtitles: /\ssubtitles\s/.test(out) }; // subtitles: libass, for drawing text onto video
    } catch {
      /* ignore */
    }
  }
  return { ffmpeg, ffprobe, encoders, filters };
}

/** Lyrics embedded in the tags (ID3 USLT, Vorbis LYRICS, …), capped at 64 KB. */
function pickLyrics(...sources) {
  for (const tags of sources) {
    for (const [k, v] of Object.entries(tags || {})) {
      if (/^(lyrics|unsyncedlyrics|uslt|lyrics-[a-z]{3})$/i.test(k) && typeof v === 'string' && v.trim()) return v.slice(0, 64 * 1024);
    }
  }
  return null;
}
const lang = (tags = {}) => (tags.language && tags.language !== 'und' ? tags.language : null);

/** Probe a file and return a compact summary we store in the DB. */
export async function probe(ffprobePath, file) {
  const out = await run(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const data = JSON.parse(out.toString('utf8'));
  const streams = data.streams || [];
  const format = data.format || {};

  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  let audioIdx = 0;
  let subIdx = 0;
  const audio = [];
  const subtitles = [];
  for (const s of streams) {
    if (s.codec_type === 'audio') {
      audio.push({
        index: audioIdx++,
        streamIndex: s.index,
        codec: s.codec_name,
        profile: s.profile || null,
        channels: s.channels || null,
        layout: s.channel_layout || null,
        language: lang(s.tags),
        title: s.tags?.title || null,
        default: Boolean(s.disposition?.default),
      });
    } else if (s.codec_type === 'subtitle') {
      subtitles.push({
        index: subIdx++,
        streamIndex: s.index,
        codec: s.codec_name,
        language: lang(s.tags),
        title: s.tags?.title || null,
        default: Boolean(s.disposition?.default),
        forced: Boolean(s.disposition?.forced),
      });
    }
  }

  let fps = null;
  if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
    const [a, b] = video.avg_frame_rate.split('/').map(Number);
    if (b) fps = Math.round((a / b) * 1000) / 1000;
  }

  const firstAudio = streams.find((st) => st.codec_type === 'audio');
  return {
    container: format.format_name || null,
    // lyricsChecked: the tags were read for lyrics (so the catch-up for songs probed before 0.10 skips this one).
    tags: { ...normaliseTags(format.tags, firstAudio?.tags), ...(pickLyrics(format.tags, firstAudio?.tags) ? { lyrics: pickLyrics(format.tags, firstAudio?.tags) } : {}), lyricsChecked: true },
    coverArt: streams.some((st) => st.disposition?.attached_pic),
    duration: Number(format.duration) || Number(video?.duration) || null,
    bitrate: Number(format.bit_rate) || null,
    video: video
      ? {
          codec: video.codec_name,
          profile: video.profile || null,
          width: video.width,
          height: video.height,
          pixFmt: video.pix_fmt || null,
          bitDepth: Number(video.bits_per_raw_sample) || (/10/.test(video.pix_fmt || '') ? 10 : 8),
          fps,
          hdr: /smpte2084|arib-std-b67/.test(video.color_transfer || ''),
        }
      : null,
    audio,
    subtitles,
  };
}
