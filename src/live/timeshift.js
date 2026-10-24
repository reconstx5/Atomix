// The tuner's buffer: ffmpeg copies a channel into fragmented-MP4 HLS pieces (a folder per run, so a restart after a
// drop never overwrites what was kept), and Atomix builds the browser's dynamic DASH manifest over the last 30
// minutes from those runs. Pure: the tuner (tuner.js) runs ffmpeg and reads the files.

const VIDEO_TAGS = { h264: 'avc1', hevc: 'hvc1', av1: 'av01', vp9: 'vp09' };
const AUDIO_TAGS = { aac: 'mp4a', mp3: 'mp4a', ac3: 'ac-3', eac3: 'ec-3', opus: 'Opus' };
export const PIECE_SEC = 4;
export const WINDOW_SEC = 1800;
// ffmpeg's list: up to 1800 pieces (the short first ones included); the tuner deletes pieces older than the 30-minute
// window itself, by time.
const LIST_SIZE = 1800;

/** The fMP4 tags for the channel's streams; null when one of them can't go into fMP4 (the channel is unbuffered). */
export function codecTags(media) {
  const vc = media?.video?.codec;
  const ac = media?.audio?.[0]?.codec;
  const v = vc ? VIDEO_TAGS[vc] || null : null;
  const a = ac ? AUDIO_TAGS[ac] || null : null;
  if ((vc && !v) || (ac && !a) || (!v && !a)) return null;
  return { v, a };
}

/** ffmpeg's arguments for one run of a tuner. `inputArgs`: the caller's live input options (headers, reconnects). */
export function tunerArgs({ url, media, dir, run, inputArgs = [] }) {
  const tags = codecTags(media);
  if (!tags) throw new Error('unbuffered');
  const out = `${dir}/run-${run}`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs, '-i', url];
  if (tags.v) args.push('-map', '0:v:0');
  if (tags.a) args.push('-map', '0:a:0');
  args.push('-c', 'copy');
  if (tags.v) args.push('-tag:v', tags.v);
  if (tags.a) args.push('-tag:a', tags.a);
  if (media?.audio?.[0]?.codec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  args.push(
    '-f', 'hls',
    '-hls_time', String(PIECE_SEC),
    '-hls_init_time', '1', // the first pieces are short: a channel starts in a second or two, not four
    '-hls_list_size', String(LIST_SIZE),
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `init-${run}.mp4`,
    '-hls_segment_filename', `${out}/seg-${run}-%06d.m4s`,
    '-hls_flags', 'program_date_time+omit_endlist+independent_segments', // the tuner deletes old pieces itself, by time
    '-master_pl_name', 'master.m3u8',
    `${out}/index.m3u8`,
  );
  return args;
}

/** One run's media playlist: the init piece and each piece's sequence number, duration (s) and wall-clock start. */
export function parsePlaylist(text) {
  let init = null;
  let seq = 0;
  let duration = null;
  let pdt = null;
  const segments = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-MAP:')) init = /URI="([^"]+)"/.exec(line)?.[1] || null;
    else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8));
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (!line.startsWith('#')) {
      segments.push({ uri: line, seq: seq++, duration: Number.isFinite(duration) ? duration : 0, pdt: Number.isFinite(pdt) ? pdt : null });
      duration = null;
      pdt = null;
    }
  }
  return { init, segments };
}

const VIDEO_CODECS = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', av1: 'av01.0.08M.08', vp9: 'vp09.00.40.08' };
const AUDIO_CODECS = { aac: 'mp4a.40.2', mp3: 'mp4a.40.34', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus' };
/** How many of a run's newest pieces cover `behind` seconds (at least two: a live start; at most the whole run). */
export function piecesBack(pieces, behindSec) {
  let sum = 0;
  let n = 0;
  for (let i = pieces.length - 1; i >= 0 && sum < behindSec * 1000; i--) {
    sum += pieces[i].d;
    n++;
  }
  return Math.min(pieces.length, Math.max(2, n));
}

/** A codecs string for the browser when ffmpeg's master playlist names none (it writes them only for H.264/AAC). */
export function fallbackCodecs(media) {
  return [VIDEO_CODECS[media?.video?.codec], AUDIO_CODECS[media?.audio?.[0]?.codec]].filter(Boolean).join(',');
}

/** The master playlist's CODECS value ("avc1.64001f,mp4a.40.2"). */
export function parseCodecs(text) {
  return /CODECS="([^"]+)"/.exec(String(text))?.[1] || null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const secs = (ms) => `PT${Math.round(ms) / 1000}S`;

/**
 * The browser's manifest: dynamic, 30 minutes deep, a period per run (each starting where its first piece did,
 * counted from the tuner's origin), only the pieces still inside the window.
 * runs: [{ run, start (ms), codecs, audioOnly, pieces: [{ seq, t (ms from the run's first piece), d (ms) }] }]
 */
export function buildManifest({ runs, origin, now, windowSec = WINDOW_SEC, piecePath, timeUrl }) {
  const from = now - windowSec * 1000;
  const periods = [];
  for (const r of runs) {
    const kept = r.pieces.filter((p) => r.start + p.t + p.d > from); // a piece on disk is available, whatever its stamped time
    if (!kept.length) continue;
    const type = r.audioOnly ? 'audio' : 'video';
    const timeline = kept.map((p) => `<S t="${p.t}" d="${p.d}"/>`).join('');
    periods.push(
      `<Period id="r${r.run}" start="${secs(r.start - origin)}">` +
        `<AdaptationSet id="${r.run}" contentType="${type}" mimeType="${type}/mp4" segmentAlignment="true">` +
        `<Representation id="${type}-${r.run}" bandwidth="1000000" codecs="${esc(r.codecs || '')}">` +
        `<SegmentTemplate timescale="1000" initialization="${esc(piecePath)}init-${r.run}.mp4" media="${esc(piecePath)}seg-${r.run}-$Number%06d$.m4s" startNumber="${kept[0].seq}">` +
        `<SegmentTimeline>${timeline}</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period>`,
    );
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011" ` +
    `availabilityStartTime="${new Date(origin).toISOString()}" publishTime="${new Date(now).toISOString()}" ` +
    `minimumUpdatePeriod="PT4S" timeShiftBufferDepth="${secs(windowSec * 1000)}" suggestedPresentationDelay="PT8S" ` +
    `maxSegmentDuration="PT${PIECE_SEC + 2}S" minBufferTime="PT4S">` +
    `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="${esc(timeUrl)}"/>` +
    periods.join('') +
    '</MPD>\n'
  );
}
