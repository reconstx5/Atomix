// Encrypted Live TV channels (Widevine/ClearKey DASH). ffmpeg can't decrypt them, so the browser plays them itself
// with its own key system; Atomix keeps an "encrypted session" per play and relays the manifest, segments and
// licence (so provider addresses, headers and tokens stay on the server). With Widevine the licence is sealed for the
// browser's Widevine module: Atomix only passes bytes along and never holds a key.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { lookup as dnsLookup } from 'node:dns/promises';
import { HttpError, readBody } from '../http/router.js';
import { isPrivateTarget, checkResolved } from '../http/net.js';
import { fetchFollowing } from '../remote/provider.js';
import { withTimeout } from './timeout.js';
import { parseMpd } from '../../public/js/dash/mpd.js';
import { parseXml, serializeXml, localName } from '../../public/js/dash/xml.js';
import { rewritePlaylist, isPlaylist } from './hls-relay.js';

// PlayReady (v0.28): the server names the recommendation form as a hint; the browser falls back to plain
// com.microsoft.playready itself.
export const KEY_SYSTEMS = { widevine: 'com.widevine.alpha', clearkey: 'org.w3.clearkey', fairplay: 'com.apple.fps', playready: 'com.microsoft.playready.recommendation' };
export const NO_COMMON_SYSTEM = "This browser can't play any of this channel's protections.";
export const UNREADABLE = "This channel's stream couldn't be read";
const IDLE_MS = 2 * 60_000;
const MANIFEST_MAX = 2_000_000;
const MANIFEST_TIMEOUT_MS = 15_000;
const ENDED_KEEP_MS = 5 * 60_000;
const isNetworkUrl = (u) => /^https?:\/\/[^/]/i.test(String(u || ''));
const SEGMENT_MAX = 64 * 1024 * 1024;
const SEGMENT_FIRST_BYTE_MS = 20_000;
const SEGMENT_TOTAL_MS = 120_000;
const LICENCE_MAX = 64 * 1024;
const LICENCE_ANSWER_MAX = 1024 * 1024;
const LICENCE_TIMEOUT_MS = 10_000;
const CERTIFICATE_MAX = 64 * 1024; // a FairPlay certificate (v0.27)
const CONTENT_ID_MAX = 256;
export const REFUSED = "The provider refused this channel's licence";
export const NOT_ANSWERING = "The licence server isn't answering";
export const NO_KEY = "The playlist doesn't have the key for this channel";
const OUTPUT_NODES_MAX = 200_000; // a rewritten manifest repeats inherited timelines per representation
const MP4PROTECTION = 'urn:mpeg:dash:mp4protection:2011';
const SYSTEM_IDS = {
  widevine: ['urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'],
  playready: ['urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'],
  clearkey: ['urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e', 'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'],
};
// Parts of a manifest the player doesn't need that would lead the browser to the provider (or another licence server).
const DROPPED = new Set(['Laurl', 'laurl', 'Metrics', 'Reporting', 'ProgramInformation', 'Location', 'PatchLocation']);
const refused = () => Object.assign(new Error('refused address'), { code: 'EPRIVATE' });
// A licence or segment request redirected to another server (c.mjh.nz → TVNZ's own, by 307; a CDN edge) keeps what
// describes the request — its content type, the playlist's headers — but not credentials, which stay with their host.
const CREDENTIALS = new Set(['authorization', 'cookie', 'proxy-authorization']);
const keepLicenceHeader = (name) => !CREDENTIALS.has(name);
const lowerKeys = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * The key system to play a channel with (v0.28): the first of the device's list (its own order of preference) that the
 * channel offers; null when none is. No device list (an older page) → the channel's first system.
 * @param {string[]} offered the channel's systems, in the playlist's order
 * @param {string[]} [device] what the browser has, best first
 */
export function chooseSystem(offered, device) {
  const list = Array.isArray(offered) ? offered : [];
  if (!Array.isArray(device)) return list[0] ?? null;
  return device.find((d) => list.includes(d)) ?? null;
}

// A PlayReady Object (mspr:pro, or the data of a PlayReady pssh box): length (u32 LE), record count (u16), records of
// type (u16), size (u16), data. Type 1 is the WRMHEADER XML (UTF-16LE), where the provider's LA_URL (and LUI_URL) are.
function proWithLicence(pro, url) {
  try {
    if (pro.length < 10 || pro.readUInt32LE(0) !== pro.length) return null;
    const count = pro.readUInt16LE(4);
    let at = 6;
    const out = [];
    for (let i = 0; i < count; i++) {
      if (at + 4 > pro.length) return null;
      const type = pro.readUInt16LE(at);
      const size = pro.readUInt16LE(at + 2);
      if (at + 4 + size > pro.length) return null;
      let data = pro.subarray(at + 4, at + 4 + size);
      if (type === 1) {
        let xml = data.toString('utf16le');
        if (!/<LA_URL>/.test(xml)) return null; // nothing to point at Atomix: not safe to pass on
        xml = xml.replace(/<LA_URL>[^<]*<\/LA_URL>/g, () => `<LA_URL>${url.replace(/&/g, '&amp;')}</LA_URL>`).replace(/<LUI_URL>[^<]*<\/LUI_URL>/g, '');
        data = Buffer.from(xml, 'utf16le');
        if (data.length > 0xffff) return null;
      }
      const rec = Buffer.alloc(4);
      rec.writeUInt16LE(type, 0);
      rec.writeUInt16LE(data.length, 2);
      out.push(rec, data);
      at += 4 + size;
    }
    const body = Buffer.concat(out);
    const head = Buffer.alloc(6);
    head.writeUInt32LE(6 + body.length, 0);
    head.writeUInt16LE(count, 4);
    return Buffer.concat([head, body]);
  } catch {
    return null;
  }
}
/** The base64 of a PlayReady Object (mspr:pro) with Atomix's licence address in it; null when it can't be read. */
export function rewritePro(b64, url) {
  const out = proWithLicence(Buffer.from(String(b64 || '').trim(), 'base64'), url);
  return out ? out.toString('base64') : null;
}
/** The base64 of a PlayReady pssh box with Atomix's licence address in its object; null when it can't be read. */
export function rewritePssh(b64, url) {
  try {
    const box = Buffer.from(String(b64 || '').trim(), 'base64');
    if (box.length < 32 || box.readUInt32BE(0) !== box.length || box.toString('latin1', 4, 8) !== 'pssh') return null;
    const at = box[8] === 1 ? 32 + box.readUInt32BE(28) * 16 : 28; // version 1 lists key ids first
    if (box.length < at + 4 || box.readUInt32BE(at) !== box.length - at - 4) return null;
    const pro = proWithLicence(box.subarray(at + 4), url);
    if (!pro) return null;
    const head = Buffer.from(box.subarray(0, at + 4));
    head.writeUInt32BE(at + 4 + pro.length, 0);
    head.writeUInt32BE(pro.length, at);
    return Buffer.concat([head, pro]).toString('base64');
  } catch {
    return null;
  }
}

const PLAYREADY_ID = '9a04f07998404286ab92e65be0885f95';
/** A PlayReady pssh box (version 0) around a PlayReady Object. */
function playReadyPssh(pro) {
  const head = Buffer.alloc(32);
  head.writeUInt32BE(32 + pro.length, 0);
  head.write('pssh', 4, 'latin1');
  Buffer.from(PLAYREADY_ID, 'hex').copy(head, 12);
  head.writeUInt32BE(pro.length, 28);
  return Buffer.concat([head, pro]);
}
/**
 * The playlist's init_data for a PlayReady session, as the browser gets it: a pssh box naming Atomix's licence address
 * (from a pssh, or a bare PlayReady Object wrapped as one, since the browser asks with 'cenc'); null when it's neither.
 */
export function playReadyInitData(b64, url) {
  const pssh = rewritePssh(b64, url);
  if (pssh) return pssh;
  const pro = rewritePro(b64, url);
  return pro ? playReadyPssh(Buffer.from(pro, 'base64')).toString('base64') : null;
}

// ISO BMFF boxes: [{ type, start, end, head }] over buf[from, to), or null when a size doesn't fit.
function readBoxes(buf, from, to) {
  const out = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) return null;
    let size = buf.readUInt32BE(at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      const big = buf.readBigUInt64BE(at + 8);
      if (big > BigInt(to - at)) return null;
      size = Number(big);
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) return null;
    out.push({ type: buf.toString('latin1', at + 4, at + 8), start: at, end: at + size, head });
    at += size;
  }
  return out;
}
const INIT_SEGMENT_MAX = 1024 * 1024; // init segments are a few KB; anything bigger is streamed as it came
/**
 * v0.28: a PlayReady session's relayed init segment (ftyp and/or a top-level moov) with every PlayReady pssh in moov
 * naming Atomix's licence address (the provider's LA_URL stays on the server). Widevine's pssh, media segments and
 * every other box pass byte for byte. { bytes, unreadable }: unreadable is true for an init segment that couldn't be
 * read (its bytes are then the original ones).
 */
export function rewriteInitSegment(buf, url) {
  const asIs = (unreadable = false) => ({ bytes: buf, unreadable });
  const first = buf.length >= 8 ? buf.toString('latin1', 4, 8) : '';
  const top = readBoxes(buf, 0, buf.length);
  if (!top) return asIs(first === 'ftyp' || first === 'moov');
  const moovs = top.filter((b) => b.type === 'moov');
  if (!moovs.length) return asIs(); // a media segment (styp/moof/mdat), or an ftyp alone: nothing names a licence server
  if (moovs.length > 1) return asIs(true);
  const moov = moovs[0];
  const kids = readBoxes(buf, moov.start + moov.head, moov.end);
  if (!kids) return asIs(true);
  let changed = false;
  const parts = [];
  for (const k of kids) {
    let bytes = buf.subarray(k.start, k.end);
    if (k.type === 'pssh' && k.head === 8 && bytes.length >= 28 && bytes.toString('hex', 12, 28) === PLAYREADY_ID) {
      const done = rewritePssh(bytes.toString('base64'), url);
      if (!done) return asIs(true);
      bytes = Buffer.from(done, 'base64');
      changed = true;
    }
    parts.push(bytes);
  }
  if (!changed) return asIs();
  const body = Buffer.concat(parts);
  const head = Buffer.from(buf.subarray(moov.start, moov.start + moov.head));
  if (moov.head === 16) head.writeBigUInt64BE(BigInt(16 + body.length), 8);
  else if (8 + body.length > 0xffffffff) return asIs(true);
  else head.writeUInt32BE(8 + body.length, 0);
  return { bytes: Buffer.concat([buf.subarray(0, moov.start), head, body, buf.subarray(moov.end)]), unreadable: false };
}

/** The play request's keySystems: known names only (no repeats, at most 4); undefined when it isn't a list. */
export function deviceSystems(v) {
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.filter((x) => typeof x === 'string' && Object.hasOwn(KEY_SYSTEMS, x)))].slice(0, 4);
}

const PR_MESSAGE_MAX_HEADERS = 16;
/**
 * Edge's and Chromium's PlayReady licence request: a UTF-16 PlayReadyKeyMessage holding the challenge (base64) and
 * the HTTP headers to send it with. The challenge and those headers, or null when the bytes aren't such a message
 * (a raw challenge, or a broken one: sent as it is).
 * @returns {{ challenge: Buffer, headers: Record<string, string> } | null}
 */
export function unwrapPlayReady(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length % 2) return null;
  let text = buf.toString('utf16le');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<PlayReadyKeyMessage[\s>]/.test(text)) return null;
  let root;
  try {
    root = parseXml(text, { maxBytes: LICENCE_MAX, maxNodes: 200 });
  } catch {
    return null;
  }
  if (localName(root.name) !== 'PlayReadyKeyMessage') return null;
  const acq = els(root, 'LicenseAcquisition')[0];
  const b64 = String(acq && els(acq, 'Challenge')[0]?.text || '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const headers = {};
  for (const h of (acq && els(acq, 'HttpHeaders')[0]?.children.filter((c) => localName(c.name) === 'HttpHeader')) || []) {
    if (Object.keys(headers).length >= PR_MESSAGE_MAX_HEADERS) break;
    const name = els(h, 'name')[0]?.text?.trim();
    const value = els(h, 'value')[0]?.text?.trim();
    if (name && value != null && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(value)) headers[name] = value;
  }
  return { challenge: Buffer.from(b64, 'base64'), headers };
}

// From the unwrapped message, only these describe the request; anything else (a cookie, say) isn't the browser's to set.
const PR_MESSAGE_HEADERS = new Set(['content-type', 'soapaction']);

/** An IPv4 address as four numbers, also when written inside IPv6 ("::ffff:7f00:1"); null otherwise. */
function v4Of(h) {
  let m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h) || /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) return m.slice(1, 5).map(Number);
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!m) return null;
  const [a, b] = [parseInt(m[1], 16), parseInt(m[2], 16)];
  return [a >> 8, a & 255, b >> 8, b & 255];
}

const bare = (hostname) => String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

/** This machine or the home network (loopback, unspecified, RFC 1918, CGNAT, unique-local, link-local). */
export function isLocalHost(hostname) {
  const h = bare(hostname);
  if (h === '' || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  const v4 = v4Of(h);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || a === 127 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

const isIpLiteral = (hostname) => {
  const h = bare(hostname);
  return Boolean(v4Of(h)) || h.includes(':');
};

/**
 * The check for every fetch (and every redirect hop) of one encrypted session: never link-local or the unspecified
 * address; and when the manifest is on the internet, nothing that names — or resolves to — this machine or the home
 * network. A manifest on the home network (a tuner) may use the home network.
 */
export function relayCheck(manifestUrl, { lookup = dnsLookup } = {}) {
  const resolvesLocal = async (hostname) => {
    if (isLocalHost(hostname)) return true;
    if (isIpLiteral(hostname)) return false;
    try {
      const all = await lookup(bare(hostname), { all: true });
      return all.some((a) => isLocalHost(a.address));
    } catch {
      return false; // the fetch itself will say it can't reach the name
    }
  };
  let manifestLocal = null;
  return async (url) => {
    checkTarget(url);
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw refused();
    await checkResolved(url, { lookup }); // even a home-network manifest can't name the metadata address
    manifestLocal ??= resolvesLocal(new URL(manifestUrl).hostname);
    if (await manifestLocal) return;
    if (await resolvesLocal(u.hostname)) throw refused();
  };
}

/**
 * May the relay fetch from this origin for this manifest? A provider on the internet can't point Atomix at this
 * machine or the home network; a tuner on the home network may serve itself.
 */
export function baseAllowed(origin, manifestUrl) {
  try {
    return !isLocalHost(new URL(origin).hostname) || isLocalHost(new URL(manifestUrl).hostname);
  } catch {
    return false;
  }
}

/** A segment's provider address: the base origin with the path and query as written (never resolved as relative). */
export function segmentTarget(base, rest, search) {
  const u = new URL(base);
  u.pathname = `/${rest}`;
  u.search = search || '';
  return u;
}

const CLOCK_CACHE_MS = 60_000;
/** An address with the playlist's extra query (manifest_params / stream_params) added. */
const withParams = (url, params) => (params ? `${url}${String(url).includes('?') ? '&' : '?'}${params}` : url);
const MAX_ORIGINS = 32; // provider origins one manifest may name
const KEEP_ORIGINS = MAX_ORIGINS * 2; // origins a session remembers; a slot unused by the last two manifests is reused

const els = (el, name) => el.children.filter((c) => localName(c.name) === name);
const resolveUrl = (ref, base) => new URL(ref, base).href;

/**
 * The provider's manifest rewritten for the browser: every address becomes /api/live/drm/<sid>/r/<n>/<path>, where
 * <n> is the provider origin the session keeps (session.bases). BaseURLs are folded into each representation's own
 * SegmentTemplate (so "../" and per-representation bases resolve here, not in the browser); UTCTiming points at
 * Atomix's clock; Location is dropped. Protection, codecs and timing stay as they are.
 */
export function rewriteManifest(text, manifestUrl, session, { cast = null } = {}) {
  const root = parseXml(text);
  if (localName(root.name) !== 'MPD') throw new Error('not a DASH manifest');
  // v0.27: for a TV (a cast link), absolute addresses on the address the TV reached Atomix by, each with the link.
  const own = cast ? `${cast.base}/api/live/drm/${session.id}` : `/api/live/drm/${session.id}`;
  const prefix = `${own}/r/`;
  const withLink = (search) => (cast ? `${search ? `${search}&` : '?'}cast=${encodeURIComponent(cast.token)}` : search);
  // Origins keep their slot number while in use (the player may be fetching a segment of the previous manifest); a
  // CDN naming a new edge host per refresh reuses slots the last two manifests didn't name.
  const gen = (session.gen = (session.gen || 0) + 1);
  const seen = (session.baseGen ||= []);
  const named = new Set();
  const opaque = (abs) => {
    const u = new URL(abs);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not a network address');
    let n = session.bases.indexOf(u.origin);
    if (n < 0) {
      if (named.size >= MAX_ORIGINS) throw new Error('manifest too big');
      if (session.bases.length < KEEP_ORIGINS) n = session.bases.push(u.origin) - 1;
      else {
        n = session.bases.findIndex((_, i) => (seen[i] || 0) < gen - 1);
        if (n < 0) throw new Error('manifest too big');
        session.bases[n] = u.origin;
      }
    }
    if (!named.has(n)) {
      if (named.size >= MAX_ORIGINS) throw new Error('manifest too big');
      named.add(n);
    }
    seen[n] = gen;
    return `${prefix}${n}${u.pathname}${withLink(u.search)}`;
  };
  const baseOf = (el, parent) => {
    const t = els(el, 'BaseURL')[0]?.text?.trim();
    return t ? resolveUrl(t, parent) : parent;
  };
  const mergeTemplate = (el, inherited) => {
    const st = els(el, 'SegmentTemplate')[0];
    if (!st) return inherited;
    const attrs = { ...(inherited?.attrs || {}), ...st.attrs };
    const initEl = els(st, 'Initialization')[0];
    if (!st.attrs.initialization && initEl?.attrs.sourceURL) attrs.initialization = initEl.attrs.sourceURL;
    return { name: st.name, attrs, timeline: els(st, 'SegmentTimeline')[0] || inherited?.timeline || null };
  };
  const keepSystems = new Set([MP4PROTECTION, ...(session.system ? SYSTEM_IDS[session.system] || [] : [...SYSTEM_IDS.widevine, ...SYSTEM_IDS.clearkey])]);
  // Everything the player doesn't need that could point the browser elsewhere: licence URLs, reports, programme
  // links, remote (xlink) elements, other DRM systems' data.
  const strip = (el) => {
    el.children = el.children.filter((c) => {
      const n = localName(c.name);
      if (DROPPED.has(n)) return false;
      if (n === 'ContentProtection' && !keepSystems.has(String(c.attrs.schemeIdUri || '').toLowerCase())) return false;
      return true;
    });
    for (const k of Object.keys(el.attrs)) if (/^xlink:/i.test(k) || (localName(k) === 'href' && k.includes(':'))) delete el.attrs[k];
    for (const c of el.children) strip(c);
  };
  strip(root);
  const drop = (el, names) => {
    el.children = el.children.filter((c) => !names.includes(localName(c.name)));
  };
  const rootBase = baseOf(root, resolveUrl('./', manifestUrl));
  for (const period of els(root, 'Period')) {
    const pBase = baseOf(period, rootBase);
    const pTpl = mergeTemplate(period, null);
    for (const as of els(period, 'AdaptationSet')) {
      const asBase = baseOf(as, pBase);
      const asTpl = mergeTemplate(as, pTpl);
      // A SegmentList/SegmentBase written once for the set (or period) belongs to each representation without its own.
      const inherited = [...els(as, 'SegmentList'), ...els(as, 'SegmentBase')][0] || [...els(period, 'SegmentList'), ...els(period, 'SegmentBase')][0] || null;
      for (const rep of els(as, 'Representation')) {
        const rBase = baseOf(rep, asBase);
        const tpl = mergeTemplate(rep, asTpl);
        if (!tpl && inherited && !els(rep, 'SegmentList').length && !els(rep, 'SegmentBase').length) rep.children.push(structuredClone(inherited));
        if (tpl) {
          const attrs = { ...tpl.attrs };
          for (const k of ['media', 'initialization', 'index']) if (attrs[k]) attrs[k] = opaque(resolveUrl(attrs[k], rBase));
          drop(rep, ['SegmentTemplate', 'BaseURL']);
          rep.children.push({ name: tpl.name, attrs, children: tpl.timeline ? [tpl.timeline] : [], text: '' });
        } else {
          // SegmentList / SegmentBase: their addresses (and a single-file BaseURL) become Atomix's too.
          for (const list of [...els(rep, 'SegmentList'), ...els(rep, 'SegmentBase')]) {
            for (const u of els(list, 'SegmentURL')) {
              if (u.attrs.media) u.attrs.media = opaque(resolveUrl(u.attrs.media, rBase));
              if (u.attrs.index) u.attrs.index = opaque(resolveUrl(u.attrs.index, rBase));
            }
            for (const i of [...els(list, 'Initialization'), ...els(list, 'RepresentationIndex')]) if (i.attrs.sourceURL) i.attrs.sourceURL = opaque(resolveUrl(i.attrs.sourceURL, rBase));
          }
          drop(rep, ['BaseURL']);
          rep.children.unshift({ name: 'BaseURL', attrs: {}, children: [], text: opaque(rBase) });
        }
      }
      drop(as, ['SegmentTemplate', 'BaseURL', 'SegmentList', 'SegmentBase']);
    }
    drop(period, ['SegmentTemplate', 'BaseURL', 'SegmentList', 'SegmentBase']);
  }
  drop(root, ['BaseURL', 'Location', 'PatchLocation']);
  // The provider's own clock, for /time (the player reads Atomix's address instead).
  const first = els(root, 'UTCTiming')[0];
  if (first) {
    const scheme = String(first.attrs.schemeIdUri || '');
    let value = String(first.attrs.value || '').split(/\s+/)[0];
    if (/http-(iso|xsdate)/.test(scheme)) {
      try {
        value = resolveUrl(value, manifestUrl);
      } catch {
        value = '';
      }
    }
    const was = session.utc;
    if (!was || was.scheme !== scheme || was.value !== value) session.utc = { scheme, value, readAt: Date.now() };
  } else session.utc = null;
  for (const u of els(root, 'UTCTiming')) u.attrs = { schemeIdUri: 'urn:mpeg:dash:utc:http-iso:2014', value: `${own}/time${withLink('')}` };
  // PlayReady's header objects (mspr:pro, the pssh) name the provider's licence server, inside base64: for any device the
  // address inside them becomes Atomix's own licence address for this session (the cast link's for a TV), LUI_URL goes,
  // and an object that can't be read is left out (a TV still has dashif:Laurl, a browser its player's own address).
  if (session.system === 'playready') {
    const address = `${own}/licence${withLink('')}`;
    const protect = (el) => {
      el.children = el.children.filter((x) => {
        const n = localName(x.name);
        if (n === 'pro' || n === 'pssh') {
          const done = (n === 'pro' ? rewritePro : rewritePssh)(x.text, address);
          if (done) x.text = done;
          return Boolean(done);
        }
        protect(x);
        return true;
      });
    };
    protect(root);
  }
  // v0.27: a TV's receiver (Shaka) asks the licence address the manifest names: Atomix's, inside each protection entry
  // of the session's system (one is added beside the common cenc entry when the manifest has none).
  if (cast && SYSTEM_IDS[session.system]) {
    root.attrs['xmlns:dashif'] = 'https://dashif.org/CPS';
    const laurl = () => ({ name: 'dashif:Laurl', attrs: {}, children: [], text: `${own}/licence${withLink('')}` });
    const ids = SYSTEM_IDS[session.system];
    const protectionValue = { widevine: 'Widevine', playready: 'MSPR 2.0', clearkey: 'ClearKey1.0' }[session.system];
    const visit = (el) => {
      const cps = el.children.filter((c) => localName(c.name) === 'ContentProtection');
      if (cps.length) {
        const mine = cps.filter((c) => ids.includes(String(c.attrs.schemeIdUri || '').toLowerCase()));
        if (mine.length) for (const c of mine) c.children.push(laurl());
        else {
          const at = el.children.indexOf(cps.at(-1)) + 1;
          el.children.splice(at, 0, { name: 'ContentProtection', attrs: { schemeIdUri: ids[0], value: protectionValue }, children: [laurl()], text: '' });
        }
      }
      for (const c of el.children) if (localName(c.name) !== 'ContentProtection') visit(c);
    };
    visit(root);
  }
  // Last: any value still naming a provider host goes (a descriptor's link, say) — only Atomix's addresses remain.
  const hosts = [new URL(manifestUrl).host, ...(session.manifestUrl ? [new URL(session.manifestUrl).host] : []), ...session.bases.map((b) => new URL(b).host)].filter(Boolean);
  const names = (v) => hosts.some((h) => String(v).includes(h));
  let nodes = 0;
  const guard = (el) => {
    if (++nodes > OUTPUT_NODES_MAX) throw new Error('manifest too big');
    for (const [k, v] of Object.entries(el.attrs)) if (!String(v).startsWith(prefix) && names(v)) delete el.attrs[k];
    if (el.text && !el.text.startsWith(prefix) && names(el.text)) el.text = '';
    for (const c of el.children) guard(c);
  };
  guard(root);
  return serializeXml(root);
}

/** The address the TV was given for Atomix (the casting address, as plain casts use), not the request's Host. */
function castBase(ctx) {
  if (ctx.castLink?.base) return ctx.castLink.base;
  const proto = ctx.req.socket.encrypted ? 'https' : 'http';
  return `${proto}://${ctx.req.headers.host}`;
}

/** The licence request to send the provider, from the playlist's post-data form (bytes; each placeholder once). */
export function buildLicenceRequest(licence, challenge, { contentId = '' } = {}) {
  const body = licence.body || { kind: 'raw' };
  if (body.kind !== 'template') return { body: challenge, contentType: 'application/octet-stream' };
  const b64 = challenge.toString('base64');
  // {CONTENTID} (FairPlay, v0.27): the skd:// id the browser's key system named, URL-encoded.
  const parts = body.text.split(/([RbB]\{SSM\}|\{CONTENTID\})/).map((p) => (p === 'R{SSM}' ? challenge : p === 'b{SSM}' ? Buffer.from(b64) : p === 'B{SSM}' ? Buffer.from(encodeURIComponent(b64)) : p === '{CONTENTID}' ? Buffer.from(encodeURIComponent(contentId)) : Buffer.from(p, 'utf8')));
  return { body: Buffer.concat(parts), contentType: /^\s*[[{]/.test(body.text) ? 'application/json' : 'application/x-www-form-urlencoded' };
}

const unwrap = (v) => {
  while (Array.isArray(v) && v.length === 1) [v] = v;
  return v;
};

/** A dotted path through a JSON answer (one-element arrays looked through); a single name is also searched for at any depth. */
function findJson(root, path) {
  const keys = String(path || '').split('.').filter(Boolean);
  let v = unwrap(root);
  for (const k of keys) v = v != null && typeof v === 'object' ? unwrap(v[k]) : undefined;
  if (v != null || keys.length !== 1) return v;
  const search = (node, depth) => {
    if (depth > 32 || node == null || typeof node !== 'object') return undefined;
    if (!Array.isArray(node) && node[keys[0]] != null) return unwrap(node[keys[0]]);
    for (const c of Object.values(node)) {
      const found = search(c, depth + 1);
      if (found != null) return found;
    }
    return undefined;
  };
  return search(root, 0);
}

/**
 * The licence bytes for the browser, from the provider's answer and the playlist's response form. A 2-byte challenge
 * is the key system asking for the service certificate: that answer is the certificate itself, whatever the form.
 */
export function readLicenceResponse(licence, buf, challenge = null) {
  if (challenge?.length === 2) return buf;
  const r = licence.response || { kind: 'raw' };
  if (r.kind === 'base64') return Buffer.from(buf.toString('utf8').trim(), 'base64');
  if (r.kind === 'http-base64') {
    const text = buf.toString('latin1');
    const at = text.indexOf('\r\n\r\n');
    return Buffer.from((at >= 0 ? text.slice(at + 4) : text).trim(), 'base64');
  }
  if (r.kind === 'json') {
    const src = r.wrapped ? Buffer.from(buf.toString('utf8').trim(), 'base64').toString('utf8') : buf.toString('utf8');
    const value = findJson(JSON.parse(src), r.path);
    if (value == null) throw new Error('no licence in the answer');
    return r.base64 ? Buffer.from(String(value), 'base64') : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  }
  return buf;
}

/** A ClearKey licence (JWK set) for the key ids the browser asked for; null when the playlist lacks one. */
export function clearKeyAnswer(keys, request) {
  const kids = Array.isArray(request?.kids) ? request.kids : [];
  if (!kids.length) return null;
  const out = [];
  for (const k of kids) {
    const hex = Buffer.from(String(k), 'base64url').toString('hex');
    const found = keys.find((x) => x.kid === hex);
    if (!found) return null;
    out.push({ kty: 'oct', kid: Buffer.from(hex, 'hex').toString('base64url'), k: Buffer.from(found.key, 'hex').toString('base64url') });
  }
  return { keys: out, type: request.type || 'temporary' };
}

/** Refuse addresses Atomix must never be pointed at (the unspecified address, link-local — and on every redirect). */
export function checkTarget(url) {
  if (isPrivateTarget(url)) throw Object.assign(new Error('refused address'), { code: 'EPRIVATE' });
}

/** Read a response body up to `max` bytes (a manifest), or throw. */
export async function readCapped(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('too big'), { code: 'ETOOBIG' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export class LiveDrm {
  /**
   * @param {{ streams: import('./stream.js').LiveStreams, playback, log, now?: () => number }} deps
   */
  constructor({ streams, playback, log, now = Date.now, lookup = dnsLookup }) {
    Object.assign(this, { streams, playback, log, now, lookup });
    this.sessions = new Map(); // id → session
    this.ended = new Map(); // id → { error, at } (what the next ping hears)
    this.timer = setInterval(() => this.reap(), 15_000);
    this.timer.unref?.();
    // Encrypted sessions count toward the account's cap of open streams, and its source's stream limit.
    (playback.externalLists ||= []).push((userId) => [...this.sessions.values()].filter((s) => s.userId === userId));
    (streams.openSources ||= []).push((sourceKey) => [...this.sessions.values()].filter((s) => s.live.sourceKey === sourceKey));
    (streams.stoppers ||= []).push((id, reason) => (this.sessions.has(id) ? (this.stop(id, reason), true) : false));
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.stop(id, 'shutdown');
  }

  /** The session's fetch check (relayCheck for its manifest's address, kept until that address changes). */
  checkFor(s) {
    if (s.checkUrl !== s.manifestUrl) Object.assign(s, { checkUrl: s.manifestUrl, check: relayCheck(s.manifestUrl, { lookup: this.lookup }) });
    return s.check;
  }

  /**
   * A fetch of this session's that ends when the browser goes (ctx's response closes) or the session is stopped.
   * @returns {{ signal: AbortSignal, abort: () => void, done: () => void }}
   */
  relay(s, ctx = null) {
    const ac = new AbortController();
    const abort = () => ac.abort();
    s.aborts.add(ac);
    ctx?.res.on('close', abort);
    return {
      signal: ac.signal,
      abort,
      done: () => {
        s.aborts.delete(ac);
        ctx?.res.off('close', abort);
      },
    };
  }

  /** Fetch a provider's manifest (its headers, every redirect hop checked, 2 MB, 15 s): { text, url } — url is where it really came from. */
  async fetchManifest(url, headers = {}, { check = relayCheck(url, { lookup: this.lookup }), signal = null } = {}) {
    let res;
    const timeout = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
    try {
      res = await fetchFollowing(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, check });
    } catch {
      throw new HttpError(502, UNREADABLE);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw Object.assign(new HttpError(502, UNREADABLE), { upstreamStatus: res.status });
    }
    try {
      // Where it really came from (after redirects): relative segment addresses resolve against that.
      return { text: (await readCapped(res, MANIFEST_MAX)).toString('utf8'), url: res.url || url };
    } catch {
      throw new HttpError(502, UNREADABLE);
    }
  }

  /**
   * Start an encrypted session for a channel the caller already checked this viewer may see.
   * @returns {Promise<object>} the session
   */
  async start({ user, profile, channel, source, replaces = null, isAdmin = false, clientIp = null, castId = null, keySystems }) {
    // v0.28: the system the device can play, chosen before anything is reserved or asked of the provider.
    // A channel that names no system (a caller with only a key) leaves the choice to the source, as before.
    const offered = channel.drmSystems?.length ? channel.drmSystems : channel.drm ? [channel.drm] : [];
    const chosen = offered.length ? chooseSystem(offered, deviceSystems(keySystems)) : undefined;
    if (chosen === null) throw new HttpError(409, NO_COMMON_SYSTEM);
    const release = this.streams.reserve(source, { user, profile, isAdmin, replaces });
    try {
      this.streams.stopReplaced(user, replaces);
      if (this.playback.sessionsOf(user.id).length >= 4) throw new HttpError(429, 'Too many streams open on this account.');
      const out = (await this.streams.addressOf(source, channel, { system: chosen })) || {};
      const system = out.drm?.system;
      // A source answers its first system for one it doesn't know: that isn't the one the device can play.
      if ((chosen && system !== chosen) || !KEY_SYSTEMS[system] || !out.drm.licence || !isNetworkUrl(out.url)) throw new HttpError(502, UNREADABLE);
      const manifestHeaders = { ...(out.headers || {}), ...(out.manifestHeaders || {}) };
      // FairPlay (v0.27) plays only with its certificate: without one there's nothing for Safari to ask a key with.
      if (system === 'fairplay' && !out.drm.serverCertificate) throw new HttpError(502, UNREADABLE);
      const { text, url: realUrl } = await this.fetchManifest(withParams(out.url, out.manifestParams), manifestHeaders);
      if (system === 'fairplay') {
        if (!/^\uFEFF?#EXTM3U/.test(text) || !/#EXT-X-STREAM-INF|#EXTINF/.test(text)) throw new HttpError(502, UNREADABLE);
      } else {
        let mpd;
        try {
          mpd = parseMpd(text, realUrl);
        } catch {
          throw new HttpError(502, UNREADABLE);
        }
        if (!mpd.periods.some((p) => p.adaptationSets.some((a) => a.type === 'video' || a.type === 'audio'))) throw new HttpError(502, UNREADABLE);
      }
      // The account cap again: another start may have finished while this one waited on the provider.
      if (this.playback.sessionsOf(user.id).length >= 4) throw new HttpError(429, 'Too many streams open on this account.');
      const now = this.now();
      const id = crypto.randomBytes(16).toString('hex');
      // The playlist's init_data goes to the browser: PlayReady's names the provider's licence server (WRMHEADER
      // LA_URL), so it becomes Atomix's own for this session; one that can't be read isn't sent at all.
      const initData = out.drm.initData ? (system === 'playready' ? playReadyInitData(out.drm.initData, `/api/live/drm/${id}/licence`) : out.drm.initData) : null;
      const s = {
        id,
        userId: user.id,
        username: user.username,
        profileId: profile?.id ?? null,
        channelId: channel.id,
        channelName: channel.name,
        system,
        manifestUrl: out.url,
        source, // to ask for a fresh address when the provider's token expires
        manifestParams: out.manifestParams || null,
        streamParams: out.streamParams || null,
        serverCertificate: out.drm.serverCertificate || null,
        initData,
        channelKey: channel.key,
        manifestHeaders,
        streamHeaders: { ...(out.headers || {}), ...(out.streamHeaders || {}) },
        licence: out.drm.licence,
        bases: [], // resolved base URLs the rewritten manifest refers to as r/<n>/
        aborts: new Set(), // the relays in flight (stop() ends them)
        createdAt: now,
        lastSeen: now,
        clientIp,
        castId, // v0.27: a TV's session, kept alive by its cast (touch)
        live: { kind: 'live', sourceKey: source.key, channelId: channel.id, channelName: channel.name },
      };
      this.sessions.set(s.id, s);
      return s;
    } finally {
      release();
    }
  }

  /** The session if it belongs to this user and profile; 404 otherwise (as if it didn't exist). */
  get(id, user, profile) {
    const s = this.sessions.get(String(id));
    if (!s || s.userId !== user?.id || s.profileId !== (profile?.id ?? null)) throw new HttpError(404, 'No such stream.');
    return s;
  }

  ping(id, user, profile) {
    const s = this.sessions.get(String(id));
    if (!s) {
      const e = this.ended.get(String(id));
      if (e) return { ok: false, error: e.error };
    }
    this.get(id, user, profile).lastSeen = this.now();
    return { ok: true };
  }

  stop(id, reason = 'stopped') {
    const s = this.sessions.get(String(id));
    if (!s) return;
    this.sessions.delete(s.id);
    for (const ac of s.aborts) ac.abort();
    s.aborts.clear();
    this.ended.set(s.id, { error: 'This channel stopped.', at: this.now(), reason });
    for (const fn of this.stopListeners || []) {
      try {
        fn(s.id, reason);
      } catch {
        /* a listener's failure isn't the stop's */
      }
    }
  }

  /** v0.27: told of every stopped session (the cast manager ends a TV's cast when its session is stopped elsewhere). */
  onStop(fn) {
    (this.stopListeners ||= []).push(fn);
  }

  /** v0.27: a TV's session is alive while its cast is (a TV never pings). */
  touch(id) {
    const s = this.sessions.get(String(id));
    if (s) s.lastSeen = this.now();
  }

  /** End sessions nobody has pinged for 2 minutes (a closed tab). */
  reap(now = this.now()) {
    for (const s of [...this.sessions.values()]) if (now - s.lastSeen > IDLE_MS) this.stop(s.id, 'idle');
    for (const [id, e] of this.ended) if (now - e.at > ENDED_KEEP_MS) this.ended.delete(id);
  }

  // ---- The relay (the browser's requests, each for its own session) ----

  /** The manifest, fetched fresh (live manifests change) and rewritten. */
  async serveManifest(ctx, s) {
    const r = this.relay(s, ctx);
    let text;
    let realUrl;
    try {
      try {
        ({ text, url: realUrl } = await this.fetchManifest(withParams(s.manifestUrl, s.manifestParams), s.manifestHeaders, { check: this.checkFor(s), signal: r.signal }));
      } catch (err) {
        // An expired token in the provider's address: ask the playlist once for a fresh one.
        if (![401, 403, 410].includes(err.upstreamStatus) || !s.source?.stream) throw err;
        await this.renew(s);
        ({ text, url: realUrl } = await this.fetchManifest(withParams(s.manifestUrl, s.manifestParams), s.manifestHeaders, { check: this.checkFor(s), signal: r.signal }));
      }
    } finally {
      r.done();
    }
    let out;
    const hls = s.system === 'fairplay';
    const cast = ctx.castLink ? { base: castBase(ctx), token: ctx.url.searchParams.get('cast') } : null;
    try {
      out = hls ? rewritePlaylist(text, realUrl, s) : rewriteManifest(text, realUrl, s, { cast });
    } catch {
      throw new HttpError(502, UNREADABLE);
    }
    s.lastSeen = this.now();
    ctx.res.writeHead(200, { 'Content-Type': hls ? 'application/vnd.apple.mpegurl' : 'application/dash+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(out), 'Cache-Control': 'no-store' });
    ctx.res.end(out);
  }

  /** A segment (or init segment) from one of the manifest's provider origins, with the stream headers. */
  async serveSegment(ctx, s) {
    const m = /^\/api\/live\/drm\/[^/]+\/r\/(\d+)\/(.*)$/.exec(ctx.url.pathname);
    const base = m ? s.bases[Number(m[1])] : null;
    if (!base) throw new HttpError(404, 'No such segment.');
    const rest = m[2];
    if (!rest) throw new HttpError(400, 'Bad segment address.');
    let target;
    // The TV's cast link is Atomix's, never the provider's: it's taken off the raw query (the rest exactly as written —
    // a CDN may sign it byte for byte).
    const own = ctx.castLink ? ctx.url.search.replace(/([?&])cast=[^&]*(&|$)/g, (m, lead, tail) => (tail ? lead : '')).replace(/^\?$/, '') : ctx.url.search;
    try {
      target = segmentTarget(base, rest, own);
      if (s.streamParams) target.search = withParams(target.search, s.streamParams).replace(/^\?*/, '?');
    } catch {
      throw new HttpError(400, 'Bad segment address.');
    }
    if (target.origin !== base) throw new HttpError(400, 'Bad segment address.');
    if (!baseAllowed(base, s.manifestUrl)) throw new HttpError(403, UNREADABLE);
    s.lastSeen = this.now();
    const headers = lowerKeys(s.streamHeaders);
    // Credentials in the playlist's stream headers are for the manifest's own server only.
    if (base !== new URL(s.manifestUrl).origin) for (const k of CREDENTIALS) delete headers[k];
    headers['accept-encoding'] = 'identity'; // a decoded body with the encoded length would be cut short
    if (ctx.req.headers.range) headers.range = ctx.req.headers.range;
    const r = this.relay(s, ctx);
    const firstByte = setTimeout(r.abort, SEGMENT_FIRST_BYTE_MS);
    const total = setTimeout(r.abort, SEGMENT_TOTAL_MS);
    firstByte.unref?.();
    total.unref?.();
    const finish = () => {
      clearTimeout(firstByte);
      clearTimeout(total);
      r.done();
    };
    let up;
    try {
      up = await fetchFollowing(target.href, { headers, signal: r.signal, check: this.checkFor(s), keepHeader: keepLicenceHeader });
    } catch {
      finish();
      throw new HttpError(502, UNREADABLE);
    }
    clearTimeout(firstByte);
    if (!up.ok) {
      // A provider's refusal or missing segment is the player's "couldn't be read", not the provider's own answer.
      await up.body?.cancel().catch(() => {});
      finish();
      throw new HttpError(502, UNREADABLE);
    }
    // A FairPlay media playlist (v0.27): rewritten like the master, never passed along with provider addresses. One
    // by its type or .m3u8; one with a vague type (object storage: application/octet-stream, text/plain) is read and
    // recognised by its #EXTM3U start — anything else read that way is passed on as it came.
    const upType = up.headers.get('content-type');
    const vague = !upType || /^(application\/octet-stream|binary\/|text\/)/i.test(upType);
    const named = isPlaylist(new URL(up.url || target.href), upType);
    if (s.system === 'fairplay' && (named || (vague && !(Number(up.headers.get('content-length')) > MANIFEST_MAX)))) {
      let bytes;
      try {
        bytes = await readCapped(up, MANIFEST_MAX);
      } catch {
        finish();
        throw new HttpError(502, UNREADABLE);
      }
      finish();
      if (named || /^\uFEFF?#EXTM3U/.test(bytes.subarray(0, 16).toString('utf8'))) {
        let text;
        try {
          text = rewritePlaylist(bytes.toString('utf8'), up.url || target.href, s);
        } catch {
          throw new HttpError(502, UNREADABLE);
        }
        ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
        return ctx.res.end(text);
      }
      const range = up.headers.get('content-range');
      ctx.res.writeHead(up.status, { 'Content-Type': upType || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': range } : {}) });
      return ctx.res.end(ctx.req.method === 'HEAD' ? undefined : bytes);
    }
    // v0.28: a PlayReady init segment's moov/pssh names the provider's licence server: read whole (they're small),
    // rewritten to Atomix's licence address. Anything bigger than INIT_SEGMENT_MAX, a range or a HEAD passes as it came.
    let prefix = null;
    let reader = null;
    if (s.system === 'playready' && up.status === 200 && up.body && ctx.req.method !== 'HEAD' && !(Number(up.headers.get('content-length')) > INIT_SEGMENT_MAX)) {
      reader = up.body.getReader();
      const chunks = [];
      let total = 0;
      let ended = false;
      try {
        while (total <= INIT_SEGMENT_MAX) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          chunks.push(Buffer.from(value));
          total += value.length;
        }
      } catch {
        await reader.cancel().catch(() => {});
        finish();
        throw new HttpError(502, UNREADABLE);
      }
      const bytes = Buffer.concat(chunks);
      if (ended) {
        finish();
        const licence = ctx.castLink ? `${castBase(ctx)}/api/live/drm/${s.id}/licence?cast=${encodeURIComponent(ctx.url.searchParams.get('cast') || '')}` : `/api/live/drm/${s.id}/licence`;
        const { bytes: body, unreadable } = rewriteInitSegment(bytes, licence);
        if (unreadable && !s.initWarned) {
          s.initWarned = true;
          this.log?.warn?.(`Live TV: an init segment of "${s.channelName}" (PlayReady) couldn't be read; it was passed on as it came.`);
        }
        ctx.res.writeHead(200, { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        return ctx.res.end(body);
      }
      prefix = bytes;
    }
    const out = { 'Cache-Control': 'no-store' };
    const encoded = up.headers.get('content-encoding');
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v && !(h === 'content-length' && encoded)) out[h] = v;
    }
    const len = Number(up.headers.get('content-length'));
    if (len > SEGMENT_MAX) {
      await up.body?.cancel().catch(() => {});
      finish();
      throw new HttpError(502, UNREADABLE);
    }
    ctx.res.writeHead(up.status, out);
    if (!up.body || ctx.req.method === 'HEAD') {
      finish();
      await up.body?.cancel().catch(() => {});
      return ctx.res.end();
    }
    let sent = 0;
    // What was already read of a big PlayReady segment, then the rest as it comes.
    const body = reader
      ? Readable.from(
          (async function* () {
            try {
              yield prefix;
              for (;;) {
                const { value, done } = await reader.read();
                if (done) return;
                yield Buffer.from(value);
              }
            } finally {
              reader.cancel().catch(() => {});
            }
          })(),
          { objectMode: false },
        )
      : Readable.fromWeb(up.body);
    body.on('data', (c) => {
      sent += c.length;
      if (sent > SEGMENT_MAX) body.destroy(new Error('too big'));
    });
    await new Promise((resolve) => {
      const done = () => {
        finish();
        resolve();
      };
      body.on('error', () => {
        ctx.res.destroy();
        done();
      });
      ctx.res.on('close', () => {
        body.destroy();
        done();
      });
      body.pipe(ctx.res).on('finish', done);
    });
  }

  /** The licence: forwarded to the provider in the playlist's form, or (ClearKey keys) answered here. */
  async serveLicence(ctx, s) {
    if (Number(ctx.req.headers['content-length']) > LICENCE_MAX) throw new HttpError(413, 'Request body too large');
    const challenge = await readBody(ctx.req, LICENCE_MAX, { timeoutMs: LICENCE_TIMEOUT_MS });
    s.lastSeen = this.now();
    if (s.licence.keys) {
      let request = null;
      try {
        request = JSON.parse(challenge.toString('utf8'));
      } catch {
        request = null;
      }
      const answer = clearKeyAnswer(s.licence.keys, request);
      if (!answer) throw new HttpError(403, NO_KEY);
      return answer;
    }
    const contentId = String(ctx.url.searchParams.get('contentId') || '').slice(0, CONTENT_ID_MAX);
    // PlayReady (v0.28): the challenge inside the browser's message, with the message's Content-Type and SOAPAction
    // (the playlist's headers on top). Not a message → the bytes as they came.
    const wrapped = s.system === 'playready' ? unwrapPlayReady(challenge) : null;
    const { body, contentType } = buildLicenceRequest(s.licence, wrapped ? wrapped.challenge : challenge, { contentId });
    const fromMessage = wrapped && (s.licence.body?.kind || 'raw') === 'raw' ? Object.fromEntries(Object.entries(lowerKeys(wrapped.headers)).filter(([k]) => PR_MESSAGE_HEADERS.has(k))) : {};
    let res;
    const r = this.relay(s, ctx);
    const signal = AbortSignal.any([r.signal, AbortSignal.timeout(LICENCE_TIMEOUT_MS)]);
    try {
      res = await fetchFollowing(s.licence.url, { method: 'POST', headers: { 'content-type': contentType, ...fromMessage, ...lowerKeys(s.licence.headers) }, body, signal, check: this.checkFor(s), keepHeader: keepLicenceHeader });
    } catch {
      r.done();
      throw new HttpError(502, NOT_ANSWERING);
    }
    if (res.status >= 400 && res.status < 500) {
      await res.body?.cancel().catch(() => {});
      r.done();
      throw new HttpError(403, REFUSED);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      r.done();
      throw new HttpError(502, NOT_ANSWERING);
    }
    let bytes;
    try {
      // The 2-byte "send me your certificate" request is Widevine's: a FairPlay SPC is never that short.
      bytes = readLicenceResponse(s.licence, await readCapped(res, LICENCE_ANSWER_MAX), s.system === 'fairplay' || s.system === 'playready' ? null : challenge);
    } catch {
      throw new HttpError(502, NOT_ANSWERING);
    } finally {
      r.done();
    }
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    ctx.res.end(bytes);
  }

  /** FairPlay's certificate (v0.27): fetched by Atomix from the playlist's address (kept on the session), or base64. */
  async serveCertificate(ctx, s) {
    if (s.system !== 'fairplay' || !s.serverCertificate) throw new HttpError(404, 'No such certificate.');
    if (!s.certificate) {
      const src = String(s.serverCertificate).trim();
      if (isNetworkUrl(src)) {
        const r = this.relay(s, ctx);
        try {
          const res = await fetchFollowing(src, { signal: AbortSignal.any([r.signal, AbortSignal.timeout(LICENCE_TIMEOUT_MS)]), check: this.checkFor(s) });
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            throw new Error('refused');
          }
          s.certificate = await readCapped(res, CERTIFICATE_MAX);
        } catch {
          throw new HttpError(502, UNREADABLE);
        } finally {
          r.done();
        }
      } else {
        const bytes = Buffer.from(src.replace(/\s+/g, ''), 'base64');
        if (!bytes.length || bytes.length > CERTIFICATE_MAX) throw new HttpError(502, UNREADABLE);
        s.certificate = bytes;
      }
    }
    s.lastSeen = this.now();
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': s.certificate.length, 'Cache-Control': 'no-store' });
    ctx.res.end(s.certificate);
  }

  /** A fresh provider address for the session (its stream() again); the session keeps its id and origins. */
  async renew(s) {
    let out;
    try {
      out = (await withTimeout(s.source.stream(s.channelKey, { log: this.log, system: s.system }), this.streams.resolveTimeoutMs)) || {};
    } catch {
      throw new HttpError(502, UNREADABLE);
    }
    if (!isNetworkUrl(out.url) || (out.drm && out.drm.system !== s.system)) throw new HttpError(502, UNREADABLE);
    s.manifestUrl = out.url;
    s.manifestHeaders = { ...(out.headers || {}), ...(out.manifestHeaders || {}) };
    s.streamHeaders = { ...(out.headers || {}), ...(out.streamHeaders || {}) };
    s.manifestParams = out.manifestParams || null;
    s.streamParams = out.streamParams || null;
    if (out.drm?.licence) s.licence = out.drm.licence;
  }

  /** The time the player should use: the provider's clock when its manifest names one (cached 60 s), else Atomix's. */
  async clockFor(s) {
    const u = s.utc;
    const now = this.now();
    if (u && /utc:direct/.test(u.scheme)) {
      const t = Date.parse(u.value);
      if (Number.isFinite(t)) return t + (Date.now() - u.readAt);
    }
    if (u && /http-(iso|xsdate)/.test(u.scheme) && u.value) {
      if (s.clock && s.clock.from === u.value && Date.now() - s.clock.at < CLOCK_CACHE_MS) return Date.now() + s.clock.offset;
      try {
        const headers = lowerKeys(s.manifestHeaders);
        // Credentials only to the manifest's own origin (a clock elsewhere gets the other headers only).
        if (new URL(u.value).origin !== new URL(s.manifestUrl).origin) for (const k of CREDENTIALS) delete headers[k];
        const res = await fetchFollowing(u.value, { headers, signal: AbortSignal.timeout(5000), check: this.checkFor(s) });
        const t = res.ok ? Date.parse((await readCapped(res, 4096)).toString('utf8').trim()) : NaN;
        if (!res.ok) await res.body?.cancel().catch(() => {});
        if (Number.isFinite(t)) {
          s.clock = { from: u.value, at: Date.now(), offset: t - Date.now() };
          return t;
        }
      } catch {
        /* Atomix's clock below */
      }
    }
    return now;
  }

  /** The clock the player reads (the manifest's UTCTiming points here). */
  async serveTime(ctx, s) {
    const t = new Date(s ? await this.clockFor(s) : this.now()).toISOString();
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    ctx.res.end(t);
  }

  /** What the Dashboard shows. */
  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      user: s.username,
      itemId: `live:${s.channelId}`,
      title: s.channelName,
      mode: 'encrypted',
      delivery: 'drm',
      quality: 'original',
      position: 0,
      paused: false,
      reasons: [`Encrypted (${{ widevine: 'Widevine', fairplay: 'FairPlay', playready: 'PlayReady' }[s.system] || 'ClearKey'}): played in the browser`],
      startedAt: s.createdAt,
      clientIp: s.clientIp,
      castDevice: null,
      transcoding: false,
    }));
  }
}
