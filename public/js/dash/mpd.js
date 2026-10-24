// Reads a DASH manifest (MPD) into what the player needs: the timing of a live stream, its periods, the video and
// audio adaptation sets with their quality levels, the segment templates (merged down from period to
// representation, as the standard says) and the content protection (which key system, the key id, Widevine's pssh).
// SegmentTemplate only (with or without a SegmentTimeline) — what live packagers publish. Pure (no DOM).
import { parseXml, localName } from './xml.js';

/** ISO 8601 duration ("PT1H2M3.5S", "P1DT1S") → seconds; null when absent or unreadable. */
export function parseDuration(text) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(text || '').trim());
  if (!m || text === 'P' || text === 'PT') return null;
  const [, d = 0, h = 0, min = 0, sec = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(sec);
}

const SYSTEMS = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'clearkey',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'clearkey',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
};

/** A ContentProtection schemeIdUri → 'widevine' | 'clearkey' | 'playready' | 'cenc' (the common one) | null. */
export function systemOf(schemeIdUri) {
  const s = String(schemeIdUri || '').toLowerCase();
  if (s === 'urn:mpeg:dash:mp4protection:2011') return 'cenc';
  const m = /^urn:uuid:([0-9a-f-]{36})$/.exec(s);
  return (m && SYSTEMS[m[1]]) || null;
}

const time = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const int = (v, d = null) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const kids = (el, name) => el.children.filter((c) => localName(c.name) === name);
const kid = (el, name) => kids(el, name)[0] || null;
const attrLocal = (el, name) => {
  for (const [k, v] of Object.entries(el.attrs)) if (localName(k) === name) return v;
  return null;
};

function resolve(base, ref) {
  try {
    return new URL(ref, base).href;
  } catch {
    return base;
  }
}
/** The base URL of an element: its first BaseURL resolved against the parent's. */
function baseOf(el, parentBase) {
  const b = kid(el, 'BaseURL');
  const text = b?.text?.trim();
  return text ? resolve(parentBase, text) : parentBase;
}

function protectionOf(el) {
  return kids(el, 'ContentProtection').map((cp) => {
    const kidAttr = attrLocal(cp, 'default_KID');
    const pssh = kids(cp, 'pssh')[0]?.text?.trim() || null;
    return {
      system: systemOf(cp.attrs.schemeIdUri),
      schemeIdUri: cp.attrs.schemeIdUri || '',
      kid: kidAttr ? kidAttr.toLowerCase().replace(/-/g, '') : null,
      pssh,
    };
  });
}

function templateOf(el, inherited) {
  const st = kid(el, 'SegmentTemplate');
  if (!st) return inherited;
  const a = st.attrs;
  const timelineEl = kid(st, 'SegmentTimeline');
  const timeline = timelineEl ? kids(timelineEl, 'S').map((s) => ({ t: int(s.attrs.t), d: int(s.attrs.d, 0), r: int(s.attrs.r, 0) })) : null;
  const base = inherited || {};
  return {
    media: a.media ?? base.media ?? null,
    initialization: a.initialization ?? base.initialization ?? null,
    startNumber: int(a.startNumber, base.startNumber ?? 1),
    timescale: int(a.timescale, base.timescale ?? 1),
    duration: int(a.duration, base.duration ?? null),
    presentationTimeOffset: int(a.presentationTimeOffset, base.presentationTimeOffset ?? 0),
    timeline: timeline || base.timeline || null,
  };
}

function typeOf(as, firstRep) {
  const ct = as.attrs.contentType;
  if (ct === 'video' || ct === 'audio' || ct === 'text') return ct;
  const mime = as.attrs.mimeType || firstRep?.attrs.mimeType || '';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^(text|application)\//.test(mime)) return 'text';
  return null;
}

/**
 * @param {string} text the manifest
 * @param {string} manifestUrl where it came from (the base for relative addresses)
 */
export function parseMpd(text, manifestUrl) {
  const root = parseXml(text);
  if (localName(root.name) !== 'MPD') throw new Error('not a DASH manifest');
  const a = root.attrs;
  const mpdBase = baseOf(root, resolve(manifestUrl, './')); // relative addresses resolve against the manifest's folder
  const periods = [];
  let prevEnd = 0;
  for (const pe of kids(root, 'Period')) {
    const start = parseDuration(pe.attrs.start) ?? prevEnd;
    const duration = parseDuration(pe.attrs.duration);
    const pBase = baseOf(pe, mpdBase);
    const pTemplate = templateOf(pe, null);
    const adaptationSets = kids(pe, 'AdaptationSet').map((as) => {
      const reps = kids(as, 'Representation');
      const asBase = baseOf(as, pBase);
      const asTemplate = templateOf(as, pTemplate);
      const asProtection = protectionOf(as);
      return {
        id: as.attrs.id ?? null,
        type: typeOf(as, reps[0]),
        lang: as.attrs.lang || null,
        mimeType: as.attrs.mimeType || null,
        codecs: as.attrs.codecs || null,
        contentProtection: asProtection,
        representations: reps.map((r) => {
          const own = protectionOf(r);
          return {
            id: r.attrs.id ?? '',
            bandwidth: int(r.attrs.bandwidth, 0),
            codecs: r.attrs.codecs || as.attrs.codecs || null,
            width: int(r.attrs.width ?? as.attrs.width),
            height: int(r.attrs.height ?? as.attrs.height),
            frameRate: r.attrs.frameRate || as.attrs.frameRate || null,
            audioSamplingRate: int(r.attrs.audioSamplingRate ?? as.attrs.audioSamplingRate),
            mimeType: r.attrs.mimeType || as.attrs.mimeType || null,
            baseUrl: baseOf(r, asBase),
            template: templateOf(r, asTemplate),
            contentProtection: own.length ? own : asProtection,
          };
        }),
      };
    });
    periods.push({ id: pe.attrs.id ?? null, start, duration, baseUrl: pBase, adaptationSets });
    prevEnd = duration != null ? start + duration : start;
  }
  if (!periods.length) throw new Error('not a DASH manifest');
  return {
    type: a.type === 'dynamic' ? 'dynamic' : 'static',
    availabilityStartTime: time(a.availabilityStartTime),
    publishTime: time(a.publishTime),
    mediaPresentationDuration: parseDuration(a.mediaPresentationDuration),
    minimumUpdatePeriod: parseDuration(a.minimumUpdatePeriod),
    timeShiftBufferDepth: parseDuration(a.timeShiftBufferDepth),
    suggestedPresentationDelay: parseDuration(a.suggestedPresentationDelay),
    maxSegmentDuration: parseDuration(a.maxSegmentDuration),
    minBufferTime: parseDuration(a.minBufferTime),
    utcTiming: kids(root, 'UTCTiming').map((u) => ({ scheme: u.attrs.schemeIdUri || '', value: u.attrs.value || '' })),
    location: kid(root, 'Location')?.text?.trim() || null,
    periods,
  };
}
