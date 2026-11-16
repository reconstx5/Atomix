// Reads M3U / M3U8 playlists as IPTV providers, free lists and tuners (HDHomeRun, Tvheadend) write them: the
// #EXTM3U header, #EXTINF attributes, #EXTGRP, #EXTVLCOPT and #KODIPROP lines, and "url|Header=Value" suffixes.
// Written from the format; pure, so it's tested on fixtures.
import crypto from 'node:crypto';
import { systemName, parseLicenceKey, parseDrmLegacy, parseDrmJson, parseHeaderList } from './drm.js';

const ATTR = /([A-Za-z][\w-]*)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;

function attrs(text) {
  const out = {};
  for (const m of text.matchAll(ATTR)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}

/** Split "#EXTINF:-1 a="x, y" b=z,Name" into the attribute part and the name, at the first comma outside quotes. */
function splitExtinf(rest) {
  let quote = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') return [rest.slice(0, i), rest.slice(i + 1)];
  }
  return [rest, ''];
}

const num = (v) => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function catchupOf(a) {
  const mode = a.catchup || a['catchup-type'];
  const days = num(a['catchup-days']);
  const source = a['catchup-source'];
  const correction = num(a['catchup-correction']);
  if (!mode && days == null && !source) return undefined;
  const c = {};
  if (mode) c.mode = mode.toLowerCase();
  if (days != null) c.days = days;
  if (source) c.source = source;
  if (correction != null) c.correction = correction;
  return c;
}

const MIME_FOR_MANIFEST = { hls: 'application/x-mpegURL', mpd: 'application/dash+xml', ism: 'application/vnd.ms-sstr+xml' };
const VLC_HEADERS = { 'http-user-agent': 'User-Agent', 'http-referrer': 'Referer', 'http-referer': 'Referer', 'http-origin': 'Origin', 'http-cookie': 'Cookie' };
const SUFFIX_HEADERS = { 'user-agent': 'User-Agent', referer: 'Referer', referrer: 'Referer', origin: 'Origin', cookie: 'Cookie' };

/** decodeURIComponent that keeps the text as written when it isn't valid %-escaping (one bad line mustn't fail the playlist). */
function safeDecode(text, fallback = text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return fallback;
  }
}

function splitUrl(line) {
  const bar = line.indexOf('|');
  if (bar < 0) return { url: line, headers: {} };
  const headers = {};
  for (const part of line.slice(bar + 1).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = safeDecode(part.slice(0, eq).trim());
    const value = safeDecode(part.slice(eq + 1).replace(/\+/g, '%20'), part.slice(eq + 1));
    headers[SUFFIX_HEADERS[name.toLowerCase()] || name] = value;
  }
  return { url: line.slice(0, bar).trim(), headers };
}

/** One system from the older #KODIPROP lines (license_type + license_key, or drm_legacy), or null. */
function legacyOf(d) {
  if (d.legacy) return parseDrmLegacy(d.legacy);
  const system = systemName(d.type);
  if (!system) return null;
  const licence = parseLicenceKey(system, d.key);
  if (!licence) return null;
  // The browser's key system takes these straight from the playlist (base64); neither is an address.
  return { system, licence, ...(d.serverCertificate ? { serverCertificate: d.serverCertificate } : {}), ...(d.initData ? { initData: d.initData } : {}) };
}

/** An entry's encryption from its #KODIPROP lines: { systems: [...] } in the playlist's order, or null. The JSON form comes first; an older form only adds a system it didn't name. */
function drmOf(d) {
  const systems = d.json ? parseDrmJson(d.json) : [];
  const old = legacyOf(d);
  if (old && !systems.some((s) => s.system === old.system)) systems.push(old);
  return systems.length ? { systems } : null;
}

const urlHash = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

/**
 * @param {string} text
 * @param {{ startNumber?: number, numbering?: 'playlist'|'order' }} [opts]
 * @returns {{ header: object, channels: object[], warnings: string[] }}
 */
export function parseM3u(text, { startNumber = 1, numbering = 'playlist' } = {}) {
  const src = String(text || '').replace(/^﻿/, '');
  if (/^\s*</.test(src)) throw new Error("The playlist isn't an M3U file");
  const lines = src.split(/\r?\n/);
  const warnings = [];
  const header = { guideUrls: [] };
  let sawHeader = false;
  let pending = null; // the #EXTINF waiting for its URL
  let extraGroups = [];
  let headers = {};
  let mime;
  let drm = {}; // this entry's #KODIPROP encryption lines
  const raw = [];
  const seenUrls = new Set();
  let duplicates = 0;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      sawHeader = true;
      const a = attrs(line.slice(7));
      for (const k of ['url-tvg', 'x-tvg-url']) if (a[k]) header.guideUrls.push(...a[k].split(',').map((u) => u.trim()).filter(Boolean));
      if (a.catchup || a['catchup-type']) header.catchup = (a.catchup || a['catchup-type']).toLowerCase();
      if (num(a['catchup-days']) != null) header.catchupDays = num(a['catchup-days']);
      if (a['catchup-source']) header.catchupSource = a['catchup-source'];
      if (num(a['tvg-shift']) != null) header.shift = num(a['tvg-shift']);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const [attrPart, name] = splitExtinf(line.slice(8));
      pending = { a: attrs(attrPart.replace(/^\s*-?\d+(\.\d+)?/, '')), name: name.trim() };
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      const g = line.slice(8).trim();
      if (g) extraGroups.push(g);
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice(11);
      const eq = opt.indexOf('=');
      const key = opt.slice(0, eq).trim().toLowerCase();
      if (eq > 0 && VLC_HEADERS[key]) headers[VLC_HEADERS[key]] = opt.slice(eq + 1).trim();
      continue;
    }
    if (line.startsWith('#KODIPROP:')) {
      const prop = line.slice(10);
      const eq = prop.indexOf('=');
      const key = prop.slice(0, eq).trim().toLowerCase();
      const value = prop.slice(eq + 1).trim();
      if (key === 'mimetype') mime = value;
      else if (key === 'inputstream.adaptive.manifest_type' && MIME_FOR_MANIFEST[value.toLowerCase()]) mime = MIME_FOR_MANIFEST[value.toLowerCase()];
      else if (key === 'inputstream.adaptive.drm') drm.json = value;
      else if (key === 'atomix.app_url') drm.appUrl = /^https:\/\/[^/\s]/i.test(value) ? value : undefined;
      else if (key === 'atomix.app_name') drm.appName = value;
      else if (key === 'inputstream.adaptive.license_type') drm.type = value;
      else if (key === 'inputstream.adaptive.license_key') drm.key = value;
      else if (key === 'inputstream.adaptive.drm_legacy') drm.legacy = value;
      else if (key === 'inputstream.adaptive.manifest_headers') drm.manifestHeaders = parseHeaderList(value);
      else if (key === 'inputstream.adaptive.stream_headers') drm.streamHeaders = parseHeaderList(value);
      else if (key === 'inputstream.adaptive.manifest_params') drm.manifestParams = value.replace(/^\?/, '');
      else if (key === 'inputstream.adaptive.stream_params') drm.streamParams = value.replace(/^\?/, '');
      else if (key === 'inputstream.adaptive.server_certificate') drm.serverCertificate = value;
      else if (key === 'inputstream.adaptive.license_data') drm.initData = value;
      continue;
    }
    if (line.startsWith('#')) continue;

    // A URL line: it closes the current entry.
    const { url, headers: suffix } = splitUrl(line);
    const entry = pending || { a: {}, name: '' };
    const a = entry.a;
    if (seenUrls.has(url)) {
      duplicates++;
    } else {
      seenUrls.add(url);
      const groups = [...(a['group-title'] ? a['group-title'].split(';').map((g) => g.trim()).filter(Boolean) : []), ...extraGroups];
      const ch = {
        name: entry.name || a['tvg-name'] || '',
        tvgId: a['tvg-id'] || undefined,
        tvgName: a['tvg-name'] || undefined,
        logo: a['tvg-logo'] || undefined,
        chno: num(a['tvg-chno'] ?? a['channel-number']),
        groups: [...new Set(groups)],
        radio: String(a.radio || '').toLowerCase() === 'true',
        shift: num(a['tvg-shift']),
        url,
        headers: { ...headers, ...suffix },
        mime: mime || (/\.mpd(\?|$)/i.test(url) ? MIME_FOR_MANIFEST.mpd : undefined),
        catchup: catchupOf(a),
        drm: drmOf(drm),
        manifestHeaders: drm.manifestHeaders,
        streamHeaders: drm.streamHeaders,
        manifestParams: drm.manifestParams,
        streamParams: drm.streamParams,
        appUrl: drm.appUrl,
        appName: drm.appName,
      };
      for (const k of ['tvgId', 'tvgName', 'logo', 'shift', 'mime', 'catchup', 'manifestHeaders', 'streamHeaders', 'manifestParams', 'streamParams', 'appUrl', 'appName']) if (ch[k] === undefined) delete ch[k];
      raw.push(ch);
    }
    pending = null;
    extraGroups = [];
    headers = {};
    mime = undefined;
    drm = {};
  }

  if (!raw.length) throw new Error("The playlist isn't an M3U file");
  if (!sawHeader) warnings.push('The playlist has no #EXTM3U line');
  if (duplicates) warnings.push(`${duplicates} duplicate channel${duplicates === 1 ? '' : 's'} left out`);

  // Numbers: tvg-chno where given (playlist numbering), the rest in order after the highest given number.
  const given = numbering === 'playlist' ? raw.map((c) => c.chno).filter((n) => n != null) : [];
  let next = Math.max(Number(startNumber) || 1, given.length ? Math.max(...given) + 1 : 1);
  // A tvg-id is a channel's key; when a later channel repeats it, that one is keyed by its address instead, so the
  // first keeps its favourites and number.
  const taken = new Set();
  const channels = raw.map((c) => {
    const number = numbering === 'playlist' && c.chno != null ? c.chno : next++;
    const { chno, ...rest } = c;
    return {
      ...rest,
      key: c.tvgId && !taken.has(c.tvgId) ? (taken.add(c.tvgId), c.tvgId) : urlHash(c.url),
      number,
      name: c.name || `Channel ${number}`,
    };
  });
  return { header, channels, warnings };
}
