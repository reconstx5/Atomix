// Which segments of a DASH representation exist right now, and their addresses: number templates (a fixed segment
// duration, counted from availabilityStartTime) and SegmentTimelines (explicit times, with repeats). Times returned
// are seconds on the presentation timeline (the period's start + (media time − presentationTimeOffset) / timescale).
// Pure, so the player's live maths is tested with a fake clock.

/** "$RepresentationID$/seg-$Number%05d$.m4s" with values → the address; unknown identifiers stay as written. */
export function fillTemplate(tpl, values) {
  return String(tpl || '').replace(/\$(\w*)(%0?(\d+)d)?\$/g, (all, name, fmt, width) => {
    if (name === '') return '$';
    if (!(name in values) || values[name] == null) return all;
    const v = String(values[name]);
    return fmt ? v.padStart(Number(width), '0') : v;
  });
}

function resolve(base, ref) {
  try {
    return new URL(ref, base).href;
  } catch {
    return ref;
  }
}

const NO_DEPTH_WINDOW = 60; // a live stream that doesn't say how far back it keeps (or says 0): the last minute
const MAX_SEGMENTS = 100_000; // what one call lists at most (a static stream with no end, a hostile timeline)

/**
 * @param {object} rep a representation from parseMpd
 * @param {object} period its period
 * @param {object} mpd the manifest
 * @param {number} nowMs the wall clock (corrected by clockOffset)
 * @returns {{ init: string|null, segments: { number, time, start, end, url }[] }}
 */
export function segmentsAt(rep, period, mpd, nowMs) {
  const tpl = rep.template;
  const ids = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const init = tpl?.initialization ? resolve(rep.baseUrl, fillTemplate(tpl.initialization, ids)) : null;
  if (!tpl?.media) return { init, segments: [] };
  const ts = tpl.timescale || 1;
  const pto = tpl.presentationTimeOffset || 0;
  const live = mpd.type === 'dynamic';
  // How far into the period "now" is; static: the whole period.
  const periodEnd = period.duration != null ? period.duration : mpd.mediaPresentationDuration != null ? mpd.mediaPresentationDuration - period.start : Infinity;
  const elapsed = live ? (nowMs - (mpd.availabilityStartTime || 0)) / 1000 - period.start : periodEnd;
  if (live && elapsed <= 0) return { init, segments: [] };
  const limit = Math.min(elapsed, periodEnd);
  const depth = live ? (mpd.timeShiftBufferDepth > 0 ? mpd.timeShiftBufferDepth : NO_DEPTH_WINDOW) : Infinity;
  const from = limit - depth;
  const segments = [];
  const push = (number, time, d) => {
    const start = (time - pto) / ts;
    const end = start + d / ts;
    if (end > limit + 1e-9 || end < from - 1e-9) return; // not complete yet / out of the window (kept while its end is in it)
    segments.push({ number, time, start: period.start + start, end: period.start + end, url: resolve(rep.baseUrl, fillTemplate(tpl.media, { ...ids, Number: number, Time: time })) });
  };

  if (tpl.timeline) {
    let t = 0;
    let number = tpl.startNumber ?? 1;
    const list = tpl.timeline;
    const limitMedia = limit * ts + pto; // "now" (or the period's end) in media time
    const fromMedia = from * ts + pto;
    for (let i = 0; i < list.length && segments.length < MAX_SEGMENTS; i++) {
      const s = list[i];
      if (s.t != null) t = s.t;
      if (!(s.d > 0)) continue;
      let repeats = s.r ?? 0;
      if (repeats < 0) {
        // Repeat up to the next S's start, or to the end of what exists (bounded when that's open-ended).
        const next = list[i + 1];
        const stopAt = next?.t != null ? next.t : Number.isFinite(limitMedia) ? limitMedia : t + MAX_SEGMENTS * s.d;
        repeats = Math.max(0, Math.ceil((stopAt - t) / s.d) - 1);
      }
      // Skip, arithmetically, the run's segments that ended before the window.
      const skip = Number.isFinite(fromMedia) ? Math.min(repeats + 1, Math.max(0, Math.floor((fromMedia - t) / s.d) - 1)) : 0;
      for (let k = skip; k <= repeats && segments.length < MAX_SEGMENTS; k++) {
        const st = t + k * s.d;
        if (st > limitMedia) break;
        push(number + k, st, s.d);
      }
      t += (repeats + 1) * s.d;
      number += repeats + 1;
    }
    return { init, segments };
  }

  if (!tpl.duration) return { init, segments: [] };
  const segDur = tpl.duration / ts;
  const first = Math.max(0, Math.ceil(from / segDur - 1 - 1e-9));
  const last = Math.min(Math.floor(limit / segDur + 1e-9) - 1, first + MAX_SEGMENTS - 1); // the newest complete one
  for (let k = first; k <= last; k++) push((tpl.startNumber ?? 1) + k, k * tpl.duration + pto, tpl.duration);
  return { init, segments };
}

/** Where to start playing a live stream: max(3 segments, suggestedPresentationDelay) behind the newest segment's end. */
export function liveEdge(mpd, segments) {
  if (!segments.length) return 0;
  const last = segments.at(-1);
  const segDur = last.end - last.start;
  return last.end - Math.max(3 * segDur, mpd.suggestedPresentationDelay || 0);
}

/** How far the server's clock (an ISO time, from UTCTiming) is ahead of ours, in ms; 0 when it can't be read. */
export function clockOffset(serverIso, localMs) {
  const t = Date.parse(String(serverIso || '').trim());
  return Number.isFinite(t) ? t - localMs : 0;
}
