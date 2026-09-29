// Work out which codecs this browser can play natively, so the server only
// converts what it has to.
let cached;

export function detectCaps() {
  if (cached) return cached;
  const v = document.createElement('video');
  const can = (type) => {
    try {
      if (v.canPlayType(type) !== '') return true;
      return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
    } catch {
      return false;
    }
  };
  const video = [];
  if (can('video/mp4; codecs="avc1.42E01E"') || can('video/mp4; codecs="avc1.640028"')) video.push('h264');
  if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) video.push('hevc');
  if (can('video/webm; codecs="vp9"') || can('video/mp4; codecs="vp09.00.10.08"')) video.push('vp9');
  if (can('video/webm; codecs="vp8"')) video.push('vp8');
  if (can('video/mp4; codecs="av01.0.08M.08"') || can('video/webm; codecs="av01.0.08M.08"')) video.push('av1');

  const audio = [];
  if (can('audio/mp4; codecs="mp4a.40.2"')) audio.push('aac');
  if (can('audio/mpeg')) audio.push('mp3');
  if (can('audio/webm; codecs="opus"') || can('audio/mp4; codecs="opus"')) audio.push('opus');
  if (can('audio/webm; codecs="vorbis"') || can('audio/ogg; codecs="vorbis"')) audio.push('vorbis');
  if (can('audio/flac') || can('audio/mp4; codecs="flac"')) audio.push('flac');
  if (can('audio/wav') || can('audio/wav; codecs="1"')) audio.push('wav');
  if (can('audio/mp4; codecs="alac"')) audio.push('alac');
  if (can('audio/mp4; codecs="ac-3"')) audio.push('ac3');
  if (can('audio/mp4; codecs="ec-3"')) audio.push('eac3');

  const containers = ['mp4'];
  if (can('video/webm')) containers.push('webm');
  if (can('audio/ogg; codecs="opus"') || can('audio/ogg; codecs="vorbis"')) containers.push('ogg');

  // Safari and every iOS browser need HLS for converted streams.
  const apple = /Apple/.test(navigator.vendor || '');
  const hls = apple && can('application/vnd.apple.mpegurl');
  const hdr = video.includes('hevc') && matchMedia('(dynamic-range: high)').matches;

  cached = { video, audio, containers, hls, hdr };
  return cached;
}
