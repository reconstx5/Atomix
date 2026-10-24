import { AUDIO_KINDS } from '../library/kinds.js';
// What a download is (v0.21): a phone-sized copy of a film, episode or song. A file that already fits is copied as it
// is; otherwise the picture is scaled and converted (H.264 in MP4, or VP9 in WebM for a browser without H.264), the
// sound mixed to two channels, and songs a browser can't play become AAC.

export const DOWNLOAD_QUALITIES = {
  480: { height: 480, videoBitrate: 1000 },
  720: { height: 720, videoBitrate: 2500 },
  1080: { height: 1080, videoBitrate: 5000 },
};
const AUDIO_EXT = { mp3: 'mp3', aac: 'm4a', opus: 'opus', vorbis: 'ogg', flac: 'flac' };

/** mp4 when the browser plays H.264, else webm; songs are 'audio'. */
export function downloadFormat(kind, caps = {}) {
  if (kind === 'book') return 'epub'; // v0.22: books and comics go whole (see src/books/download.js)
  if (kind === 'comic') return 'cbz';
  if (AUDIO_KINDS.has(kind)) return 'audio';
  return (caps.video || []).map(String).includes('h264') ? 'mp4' : 'webm';
}

const defaultAudio = (media) => (media?.audio || [])[media?.defaultAudio ?? 0] || (media?.audio || [])[0] || null;

/**
 * @returns {{ copy: boolean, copyVideo: boolean, copyAudio: boolean, ext: string, format: string, height: number|null,
 *   videoBitrate: number|null, audioBitrate: number, audioIndex: number }}
 */
export function planDownload({ item, media, quality = '720', format, caps = {} }) {
  const audio = defaultAudio(media);
  const audioIndex = Math.max(0, (media?.audio || []).indexOf(audio));
  if (format === 'audio' || AUDIO_KINDS.has(item.kind)) {
    const codec = audio?.codec || '';
    const have = (caps.audio || []).map(String);
    const plays = have.includes(codec) && AUDIO_EXT[codec];
    // Converted: AAC, unless the browser said it plays sound but not AAC (some Chromium builds) — then Opus in WebM.
    const opus = !plays && have.length > 0 && !have.includes('aac');
    return { format: 'audio', copy: Boolean(plays), copyVideo: false, copyAudio: Boolean(plays), ext: plays ? AUDIO_EXT[codec] : opus ? 'webm' : 'm4a', height: null, videoBitrate: null, audioBitrate: opus ? 160 : 192, audioIndex };
  }
  const q = DOWNLOAD_QUALITIES[quality] || DOWNLOAD_QUALITIES[720];
  const v = media?.video || {};
  const webm = format === 'webm';
  // The codecs decide, not the box they came in: H.264/AAC from an MKV goes into an MP4 as it is (8-bit only — phones
  // can't play 10-bit H.264).
  const copyVideo = (webm ? v.codec === 'vp9' : v.codec === 'h264' && (v.bitDepth || 8) <= 8) && (v.height || 0) <= q.height;
  const copyAudio = Boolean(audio) && (webm ? audio.codec === 'opus' : audio.codec === 'aac') && (audio.channels || 2) <= 2;
  return {
    format: webm ? 'webm' : 'mp4',
    copy: copyVideo && (copyAudio || !audio),
    copyVideo,
    copyAudio,
    ext: webm ? 'webm' : 'mp4',
    height: (v.height || 0) > q.height ? q.height : null,
    videoBitrate: q.videoBitrate,
    audioBitrate: webm ? 128 : 160,
    audioIndex,
  };
}

/** ffmpeg arguments: progress on stdout, one picture and one sound track, nothing else carried over. */
export function downloadArgs(plan, input, output) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', input];
  if (plan.format === 'audio') {
    args.push('-map', `0:a:${plan.audioIndex}`, '-vn');
    if (plan.copy) args.push('-c', 'copy', '-f', { mp3: 'mp3', m4a: 'mp4', opus: 'ogg', ogg: 'ogg', flac: 'flac' }[plan.ext] || 'mp4');
    else if (plan.ext === 'webm') args.push('-c:a', 'libopus', '-b:a', `${plan.audioBitrate}k`, '-ac', '2', '-f', 'webm');
    else args.push('-c:a', 'aac', '-b:a', `${plan.audioBitrate}k`, '-ac', '2', '-f', 'mp4', '-movflags', '+faststart');
  } else {
    args.push('-map', '0:v:0', '-map', `0:a:${plan.audioIndex}?`);
    if (plan.copy) args.push('-c', 'copy');
    else {
      if (plan.copyVideo) args.push('-c:v', 'copy');
      else {
        if (plan.height) args.push('-vf', `scale=-2:${plan.height}`);
        const rate = `${plan.videoBitrate}k`;
        if (plan.format === 'webm') args.push('-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-b:v', rate);
        else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', rate, '-maxrate', rate, '-bufsize', `${plan.videoBitrate * 2}k`, '-pix_fmt', 'yuv420p');
      }
      if (plan.copyAudio) args.push('-c:a', 'copy');
      else if (plan.format === 'webm') args.push('-c:a', 'libopus', '-b:a', `${plan.audioBitrate}k`, '-ac', '2');
      else args.push('-c:a', 'aac', '-b:a', `${plan.audioBitrate}k`, '-ac', '2');
    }
    args.push('-f', plan.format === 'webm' ? 'webm' : 'mp4');
    if (plan.format !== 'webm') args.push('-movflags', '+faststart');
  }
  args.push('-sn', '-dn', '-map_metadata', '-1', output);
  return args;
}
