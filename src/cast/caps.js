// What a cast device can play, in the `caps` shape decide() takes for a browser.

const CHROMECAST = { containers: ['mp4', 'webm'], video: ['h264', 'vp9', 'vp8'], audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'], hls: false, hdr: false };
const FALLBACK = { containers: ['mp4'], video: ['h264'], audio: ['aac'], hls: false, hdr: false };

const SINK_CONTAINERS = { 'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a' };

/** @param {string[]} sink a ConnectionManager Sink list ("http-get:*:video/mp4:*", ...) */
export function sinkToCaps(sink) {
  const mimes = new Set((sink || []).map((p) => String(p).split(':')[2]?.trim().toLowerCase()).filter(Boolean));
  if (!mimes.size) return structuredClone(FALLBACK);
  const containers = [];
  for (const [mime, c] of Object.entries(SINK_CONTAINERS)) if (mimes.has(mime) && !containers.includes(c)) containers.push(c);
  if (!containers.includes('mp4')) containers.unshift('mp4'); // what Atomix converts to: every DLNA TV is sent it
  const video = ['h264'];
  if (mimes.has('video/hevc') || mimes.has('video/x-hevc')) video.push('hevc');
  const audio = ['aac', 'mp3'];
  if (mimes.has('audio/ac3') || mimes.has('audio/vnd.dolby.dd-raw')) audio.push('ac3');
  if (mimes.has('audio/flac') || mimes.has('audio/x-flac')) audio.push('flac');
  return { containers, video, audio, hls: false, hdr: false };
}

/** @param {{ kind, model?, sink? }} device */
export function castCaps(device) {
  if (device?.kind === 'chromecast') {
    const caps = structuredClone(CHROMECAST);
    if (/google tv|ultra/i.test(device.model || '')) {
      caps.video.push('hevc');
      caps.hdr = true;
    }
    return caps;
  }
  return sinkToCaps(device?.sink);
}

/** Headers a DLNA TV wants on a converted stream. */
export const dlnaHeaders = () => ({ 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1' });
