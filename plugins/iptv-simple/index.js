// IPTV Simple: Live TV from an M3U playlist and an XMLTV guide — an original Atomix plugin modelled on what Kodi's
// IPTV Simple Client does (no Kodi code). Atomix stores the channels and programmes; this plugin only reads the
// files and knows each channel's stream and catch-up addresses, which never leave the server.
import { parseM3u } from './m3u.js';
import { parseXmltv, decodeGuide } from './xmltv.js';
import { catchupUrl, catchupWindowDays } from './catchup.js';
import { matchGuide } from './match.js';
import { openInput, readText } from './fetch.js';

const DAY = 24 * 3600_000;
const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));

function joinLogo(logo, base) {
  if (!logo) return null;
  if (/^(https?:)?\/\//i.test(logo) || /^data:/i.test(logo) || !base) return logo;
  if (isUrl(base)) return base.replace(/\/?$/, '/') + logo.replace(/^\/+/, '');
  const sep = /\\/.test(base) && !/\//.test(base) ? '\\' : '/';
  return base.replace(/[\\/]?$/, sep) + logo.replace(/^[\\/]+/, '');
}

function summaryTime(ms) {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-NZ', { weekday: 'short' });
  const h = d.getHours();
  const m = d.getMinutes();
  return `${day} ${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}


/** The Guide time shift setting in hours, kept to −24…24 (a typo can't move the guide by days). */
const guideShift = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-24, Math.min(24, n)) : 0;
};
export function setup(api) {
  // key -> { url, headers, mime, catchup, shift } — kept in storage so streams work after a restart.
  let channels = new Map(Object.entries(api.storage.get('channels', {}) || {}));
  let header = api.storage.get('header', {}) || {};
  let summary = api.storage.get('summary', null);

  const cfg = () => api.config || {};
  const userAgent = () => String(cfg().userAgent || '').trim() || `Atomix/${api.version || ''}`.replace(/\/$/, '');

  async function refresh(ctx = {}) {
    const c = cfg();
    const playlist = String(c.playlist || '').trim();
    if (!playlist) throw new Error('Add a playlist address in Settings → Plugins → IPTV Simple');
    const text = await readText(await openInput(playlist, { userAgent: userAgent(), signal: ctx.signal, what: 'playlist' }, api));
    const parsed = parseM3u(text, { numbering: c.numbering === 'order' ? 'order' : 'playlist', startNumber: Number(c.startNumber) || 1 });
    const warnings = [...parsed.warnings];
    const settingDays = Number(c.catchupDays) || 7;

    // The guide: the setting, else the playlist's own url-tvg. A guide problem never blocks the channels.
    const guideLoc = String(c.guide || '').trim() || parsed.header.guideUrls[0] || '';
    const now = Date.now();
    const maxDays = Math.max(1, ...parsed.channels.map((ch) => catchupWindowDays(ch, parsed.header, settingDays)));
    const from = now - maxDays * DAY;
    const to = now + 7 * DAY;
    let guide = { channels: new Map(), programmes: null }; // null: the guide wasn't read (Atomix keeps the last one)
    if (guideLoc) {
      try {
        const stream = decodeGuide(await openInput(guideLoc, { userAgent: userAgent(), signal: ctx.signal, what: 'guide' }, api));
        const kept = [];
        // Only programmes Atomix will keep are collected (a big guide holds weeks of them): inside the window, and for
        // a guide channel some playlist channel uses (XMLTV lists channels first; re-matched if more turn up later).
        let wanted = null;
        let known = -1;
        const g = await parseXmltv(stream, {
          onProgramme: (p, guideChannels) => {
            if (guideChannels.size !== known) {
              wanted = new Set(matchGuide(parsed.channels, guideChannels).values());
              known = guideChannels.size;
            }
            if (p.end > from - DAY && p.start < to + DAY && wanted.has(p.guideId)) kept.push(p);
          },
        });
        guide = { channels: g.channels, programmes: kept };
      } catch (err) {
        warnings.push(err.message);
        api.log.warn(`Guide: ${err.message}`);
      }
    } else warnings.push('No guide address — add one in the plugin settings, or use a playlist that names one');

    const matches = matchGuide(parsed.channels, guide.channels);
    const next = new Map();
    const shiftFor = new Map(); // guide id -> hours (the first channel using it decides)
    const out = parsed.channels.map((ch) => {
      const guideId = matches.get(ch.key) || null;
      const days = catchupWindowDays(ch, parsed.header, settingDays);
      const mode = ch.catchup?.mode || parsed.header.catchup || (ch.catchup?.source || parsed.header.catchupSource ? 'default' : null);
      const catchup = days > 0 && mode ? { mode, days } : null;
      next.set(ch.key, { url: ch.url, headers: ch.headers || {}, mime: ch.mime || null, catchup: { ...(ch.catchup || {}), mode: mode || undefined }, name: ch.name, drm: ch.drm || null, appUrl: ch.appUrl || null, appName: ch.appName || null, manifestHeaders: ch.manifestHeaders || null, streamHeaders: ch.streamHeaders || null, manifestParams: ch.manifestParams || null, streamParams: ch.streamParams || null });
      if (guideId && !shiftFor.has(guideId)) shiftFor.set(guideId, guideShift(c.guideShift) + (ch.shift ?? parsed.header.shift ?? 0));
      return {
        key: ch.key,
        number: ch.number,
        name: ch.name,
        group: ch.groups,
        logo: joinLogo(ch.logo, String(c.logosPath || '').trim()),
        radio: ch.radio,
        guideId,
        catchup,
        // Only the names: the licence details stay in the plugin. Core still takes one name (Task 2 switches it to the list).
        drm: systemsOf(ch.drm)[0]?.system || null,
        drmSystems: systemsOf(ch.drm).map((s) => s.system),
      };
    });
    const programmes = guide.programmes ? [] : null;
    for (const p of guide.programmes || []) {
      if (!shiftFor.has(p.guideId)) continue;
      const shift = shiftFor.get(p.guideId) * 3600_000;
      programmes.push({ ...p, start: p.start + shift, end: p.end + shift });
    }

    channels = next;
    header = { catchup: parsed.header.catchup, catchupSource: parsed.header.catchupSource };
    const groups = new Set(out.flatMap((ch) => ch.group));
    // With no fresh guide the last count stands (every channel would otherwise read as "without guide").
    // TV channels without guide (radio is rarely in a guide, so it isn't counted as missing one).
    const unmatched = programmes ? out.filter((ch) => !ch.guideId && !ch.radio).length : summary?.unmatched ?? out.filter((ch) => !ch.radio).length;
    const guideEnd = programmes ? programmes.reduce((m, p) => Math.max(m, p.end), 0) : summary?.guideEnd || 0;
    summary = { channels: out.length, groups: groups.size, unmatched, guideEnd: guideEnd || null };
    api.storage.set('channels', Object.fromEntries(channels));
    api.storage.set('header', header);
    api.storage.set('summary', summary);
    return { channels: out, programmes, warnings };
  }

  const known = (key) => {
    const ch = channels.get(String(key));
    if (!ch) throw new api.HttpError(404, 'This channel no longer exists.');
    return ch;
  };

  /** A channel's systems as a list: the stored { systems } form, or the older single { system, licence } as one entry. */
  function systemsOf(drm) {
    if (!drm) return [];
    if (Array.isArray(drm.systems)) return drm.systems;
    return drm.system ? [drm] : [];
  }

  async function stream(key, opts = {}) {
    const ch = known(key);
    const list = systemsOf(ch.drm);
    const pick = (opts && opts.system && list.find((s) => s.system === opts.system)) || list[0] || null;
    const { url: own, ...drm } = pick || {};
    return {
      url: own || ch.url,
      headers: { 'User-Agent': userAgent(), ...ch.headers, ...(ch.streamHeaders || {}) },
      mime: ch.mime || null,
      drm: pick ? drm : null,
      appUrl: ch.appUrl || null,
      appName: ch.appName || null,
      manifestHeaders: ch.manifestHeaders || null,
      streamHeaders: ch.streamHeaders || null,
      manifestParams: ch.manifestParams || null,
      streamParams: ch.streamParams || null,
    };
  }

  async function catchup(key, programme, { from = 0 } = {}) {
    const ch = known(key);
    const url = catchupUrl({ url: ch.url, catchup: ch.catchup }, { start: programme.start, end: programme.end, now: Date.now(), from, defaults: { mode: header.catchup, source: header.catchupSource } });
    return { url, headers: { 'User-Agent': userAgent(), ...ch.headers }, duration: Math.max(1, Math.round((programme.end - programme.start) / 1000 - from)) };
  }

  function settingsSummary() {
    if (!summary) return 'Not refreshed yet';
    const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
    return [n(summary.channels, 'channel', 'channels') + ' in ' + n(summary.groups, 'group', 'groups'), summary.guideEnd ? `guide to ${summaryTime(summary.guideEnd)}` : 'no guide', summary.unmatched ? n(summary.unmatched, 'TV channel', 'TV channels') + ' without guide' : null].filter(Boolean).join(' · ');
  }

  function maxStreams() {
    const v = String(cfg().maxStreams || 'auto');
    if (v === 'unlimited') return Infinity;
    if (v === 'auto') return isUrl(cfg().playlist) ? 1 : Infinity;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function refreshHours() {
    const n = Number(cfg().refreshHours);
    return [1, 6, 12, 24].includes(n) ? n : 6;
  }

  /** Local logo files are served only from the logos folder (never from a path a playlist names elsewhere). */
  function imageRoots() {
    const base = String(cfg().logosPath || '').trim();
    return base && !isUrl(base) ? [base] : [];
  }

  // Settings that change the channels or the guide (Streams at once, Refresh every don't need a refresh).
  const refreshKeys = ['playlist', 'guide', 'userAgent', 'numbering', 'startNumber', 'guideShift', 'logosPath', 'catchupDays'];
  api.registerLiveSource({ id: 'playlist', name: 'IPTV Simple', refresh, stream, catchup, settingsSummary, maxStreams, refreshHours, imageRoots, refreshKeys });
}
