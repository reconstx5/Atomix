// ffprobe wrapper: reads codecs, duration and tracks from a media file.
import { spawn } from 'node:child_process';
import { normaliseTags } from './music.js';
import { headerArgs, liveInputArgs } from '../stream/ffheaders.js';
import { detectArchiveTool, ARCHIVE_CANDIDATES } from '../books/archive-tool.js';


export function run(bin, args, { timeout = 60000, maxBuffer = 20 * 1024 * 1024, onSpawn, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, ...(cwd ? { cwd } : {}) });
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
    let overflow = false;
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size <= maxBuffer) out.push(c);
      else if (!overflow) {
        // Never hand back a truncated answer (a cut fingerprint or JSON would be wrong, not short).
        overflow = true;
        proc.kill('SIGKILL');
      }
    });
    proc.stderr.on('data', (c) => errOut.push(c));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (overflow) reject(Object.assign(new Error(`${bin} produced more than ${maxBuffer} bytes`), { code: 'EOVERFLOW' }));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited with ${code}: ${Buffer.concat(errOut).toString().slice(-500)}`));
    });
  });
}

/** Check whether ffmpeg/ffprobe can be run and report their versions. */
export async function detectTools(config, settings = null) {
  const check = async (bin) => {
    try {
      const out = (await run(bin, ['-version'], { timeout: 10000 })).toString();
      const version = /version\s+(\S+)/.exec(out)?.[1] || 'unknown';
      return { available: true, version, major: parseVersion(version), path: bin };
    } catch (err) {
      return { available: false, error: err.code === 'ENOENT' ? 'not found' : err.message, path: bin };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([check(config.ffmpegPath), check(config.ffprobePath)]);
  let encoders = [];
  let webp = false;
  if (ffmpeg.available) {
    try {
      const out = (await run(config.ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 10000 })).toString();
      encoders = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_videotoolbox', 'h264_amf'].filter((e) =>
        new RegExp(`\\s${e}\\s`).test(out),
      );
      webp = /\slibwebp\s/.test(out); // v0.24: smaller artwork copies as WebP
    } catch {
      /* ignore */
    }
  }
  // Used to tone-map HDR films for seek-bar previews, when this ffmpeg has them.
  let filters = { zscale: false, tonemap: false, subtitles: false, libplacebo: false };
  if (ffmpeg.available) {
    try {
      const out = (await run(config.ffmpegPath, ['-hide_banner', '-filters'], { timeout: 10000 })).toString();
      // subtitles: libass, for drawing text onto video; libplacebo: the GPU tone mapper (also reads Dolby Vision).
      filters = { zscale: /\szscale\s/.test(out), tonemap: /\stonemap\s/.test(out), subtitles: /\ssubtitles\s/.test(out), libplacebo: /\slibplacebo\s/.test(out) };
      // Listed isn't usable: libplacebo needs a Vulkan device, which a VPS or a Docker host has not. One tiny run says.
      if (filters.libplacebo) {
        try {
          await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=d=0.1:size=16x16', '-vf', 'libplacebo=format=yuv420p', '-f', 'null', '-'], { timeout: 20000 });
        } catch {
          filters.libplacebo = false;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // v0.22: 7-Zip or unrar for .cbr and .cb7 comics — the path in Settings → Server first, then the usual names.
  const archive = await detectArchiveTool([String(settings?.get?.('archiveToolPath') || '').trim(), ...ARCHIVE_CANDIDATES]);
  return { ffmpeg, ffprobe, encoders, filters, archive, webp };
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

/** The major version of an ffmpeg version string: "7.1.1" → 7, "n6.1" → 6, a dated gyan build ("2025-03-10-git…") → 7, unknown → 0. */
export function parseVersion(version) {
  const v = String(version || '');
  const dated = /^(\d{4})-\d\d-\d\d/.exec(v);
  if (dated) return Number(dated[1]) >= 2022 ? 7 : 4;
  const m = /^n?(\d+)/.exec(v);
  return m ? Number(m[1]) : 0;
}

/** Probe a file (streams, format and chapters in one run) and return the compact summary we store in the DB. */
export async function probe(ffprobePath, file, { headers = null, live = false, timeout } = {}) {
  // A live channel: a short look (8 s of network, 5 s of stream), with the provider's headers.
  let input = headers ? headerArgs(headers) : [];
  if (live) {
    input = liveInputArgs(headers || {});
    input[input.indexOf('-rw_timeout') + 1] = '8000000';
    input.push('-analyzeduration', '5000000', '-probesize', '5000000');
  }
  const out = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...(live ? [] : ['-show_chapters']), ...input, file],
    timeout ? { timeout } : undefined,
  );
  return summarise(JSON.parse(out.toString('utf8')));
}

/** ffprobe's JSON → the media summary (`items.media`). Pure, so fixtures can be fed to it. */
export function summarise(data) {
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
  const cover = streams.find((st) => st.codec_type === 'video' && st.disposition?.attached_pic);
  const side = (type) => (video?.side_data_list || []).find((d) => d.side_data_type === type);
  const rotationRaw = (video?.side_data_list || []).find((d) => d.rotation != null)?.rotation ?? video?.tags?.rotate ?? 0;
  const rotation = video ? ((Math.round(Number(rotationRaw) || 0) % 360) + 360) % 360 : 0;
  const dovi = side('DOVI configuration record');
  const chapters = (data.chapters || [])
    .map((c) => ({ start: Number(c.start_time) || 0, end: Number(c.end_time) || 0, title: c.tags?.title || null }))
    .filter((c) => c.end > c.start);
  const defaultAudio = Math.max(0, audio.findIndex((a) => a.default));
  return {
    container: format.format_name || null,
    // lyricsChecked: the tags were read for lyrics (so the catch-up for songs probed before 0.10 skips this one).
    tags: { ...normaliseTags(format.tags, firstAudio?.tags), ...(pickLyrics(format.tags, firstAudio?.tags) ? { lyrics: pickLyrics(format.tags, firstAudio?.tags) } : {}), lyricsChecked: true },
    coverArt: Boolean(cover),
    coverCodec: cover?.codec_name || null,
    chapters,
    // Which audio[] entry the file marks default (the player's and the intro finder's starting track).
    defaultAudio,
    duration: Number(format.duration) || Number(video?.duration) || null,
    bitrate: Number(format.bit_rate) || null,
    video: video
      ? {
          codec: video.codec_name,
          profile: video.profile || null,
          width: video.width,
          height: video.height,
          pixFmt: video.pix_fmt || null,
          // "yuv420p10le" → 10, "gbrp16le" → 16; "nv12"/"rgb24" carry a layout number, not a depth.
          bitDepth: Number((/p(\d+)(le|be)?$/.exec(video.pix_fmt || '') || [])[1]) || Number(video.bits_per_raw_sample) || 8,
          fps,
          hdr: /smpte2084|arib-std-b67/.test(video.color_transfer || ''),
          // What the transcoder needs to convert HDR properly (zscale wants them stated, not guessed).
          colour: { transfer: video.color_transfer || null, primaries: video.color_primaries || null, matrix: video.color_space || null },
          rotation,
          dolbyVision: dovi ? { profile: Number(dovi.dv_profile) || 0 } : null,
        }
      : null,
    audio,
    subtitles,
  };
}
