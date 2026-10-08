// A UPnP/DLNA MediaRenderer driver: the device description, SOAP calls to AVTransport, RenderingControl and
// ConnectionManager, and a status poll that raises the same `status` events as the Chromecast driver:
//   { state: 'playing'|'paused'|'buffering'|'idle', position, duration, volume, idleReason }
// Emits `close` after two polls in a row cannot reach the renderer.
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const SERVICES = {
  avTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
  rendering: 'urn:schemas-upnp-org:service:RenderingControl:1',
  connection: 'urn:schemas-upnp-org:service:ConnectionManager:1',
};

export const escapeXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unescapeXml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
/** The text of the first <tag> (any namespace prefix), unescaped, or null. */
const tagText = (xml, tag) => {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return m ? unescapeXml(m[1].trim()) : null;
};

/** "1:02:03", "01:02:03.500" → seconds; anything else (NOT_IMPLEMENTED, empty) → null */
export function parseTime(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(String(s ?? '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
const two = (n) => String(n).padStart(2, '0');
/** seconds → "00:01:40" (Seek targets) */
export const seekTime = (s) => { s = Math.max(0, Math.floor(s)); return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`; };
/** seconds → "1:57:00" (DIDL-Lite res@duration) */
const didlTime = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`; };

/**
 * @param {string} xml the device description
 * @param {string} location the URL it came from
 * @returns {{ udn, name, model, control: { avTransport, rendering, connection } }}
 */
export function parseDescription(xml, location) {
  let base = tagText(xml, 'URLBase') || location;
  try {
    new URL(base);
  } catch {
    base = location; // an unreadable URLBase is no URLBase
  }
  const home = new URL(location).hostname;
  const control = {};
  for (const [, block] of xml.matchAll(/<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/g)) {
    const type = tagText(block, 'serviceType');
    const url = tagText(block, 'controlURL');
    const key = Object.keys(SERVICES).find((k) => type?.startsWith(SERVICES[k].replace(/:1$/, ':')));
    if (key && url && !control[key]) {
      try {
        const u = new URL(url, base);
        // A description only controls the device that served it: no SOAP calls to any other host.
        if (u.hostname === home && /^https?:$/.test(u.protocol)) control[key] = u.href;
      } catch {
        // an unparseable controlURL: that service is missing
      }
    }
  }
  return { udn: tagText(xml, 'UDN'), name: tagText(xml, 'friendlyName') || 'TV', model: tagText(xml, 'modelName'), control };
}

/** A small http(s) request; resolves { status, body }. */
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { connection: 'close', ...headers }, agent: false, timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > 2_000_000) req.destroy(new Error('answer too large'));
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`No answer from ${u.host}`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

/** GET a text document (a device description); throws on a non-200 answer. */
export async function fetchText(url, { timeoutMs = 5000 } = {}) {
  const { status, body } = await request(url, { timeoutMs });
  if (status !== 200) throw Object.assign(new Error(`${url} answered ${status}`), { code: 'EDESC', httpStatus: status });
  return body;
}

export function didl({ url, title, kind, image, duration, protocolInfo }) {
  const cls = kind === 'track' ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
  const dur = duration ? ` duration="${didlTime(duration)}"` : '';
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title || 'Atomix')}</dc:title><upnp:class>${cls}</upnp:class>` +
    (image ? `<upnp:albumArtURI>${escapeXml(image)}</upnp:albumArtURI>` : '') +
    `<res protocolInfo="${escapeXml(protocolInfo)}"${dur}>${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

const STATES = { PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', PAUSED_RECORDING: 'paused', TRANSITIONING: 'buffering', STOPPED: 'idle', NO_MEDIA_PRESENT: 'idle' };

export class DlnaDevice extends EventEmitter {
  /** @param {{ location: string, pollMs?: number, timeoutMs?: number }} opts */
  constructor({ location, pollMs = 2000, timeoutMs = 5000 }) {
    super();
    this.location = location;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.desc = null;
    this.name = null;
    this.seekSupported = true;
    this.url = null; // what we loaded
    this.started = false; // the renderer has played what we loaded
    this.stopping = false; // we asked it to stop
    this.polls = 0;
    this.failures = 0;
    this.closed = false;
    this.timer = null;
    this.current = { state: 'idle', position: 0, duration: null, volume: null, idleReason: null };
  }
  status() {
    return { ...this.current };
  }
  update(patch) {
    this.current = { ...this.current, ...patch };
    this.emit('status', this.status());
  }
  async connect() {
    const body = await fetchText(this.location, { timeoutMs: this.timeoutMs });
    this.desc = parseDescription(body, this.location);
    if (!this.desc.control.avTransport) throw Object.assign(new Error('This device is not a media renderer'), { code: 'ENOTRENDERER' });
    this.name = this.desc.name;
    this.closed = false;
    this.failures = 0;
    await this.readVolume().catch(() => {});
    return this.desc;
  }
  async soap(service, action, args = {}) {
    const url = this.desc?.control[service];
    if (!url) throw Object.assign(new Error(`The TV has no ${service} service`), { code: 'ENOSERVICE' });
    const type = SERVICES[service];
    const inner = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${type}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${type}#${action}"`, 'content-length': Buffer.byteLength(body) },
      body,
      timeoutMs: this.timeoutMs,
    });
    if (res.status !== 200) {
      const code = Number(tagText(res.body, 'errorCode')) || null;
      throw Object.assign(new Error(`The TV refused ${action}${code ? ` (UPnP error ${code})` : ` (${res.status})`}`), { code: 'UPNP_FAULT', upnpCode: code, httpStatus: res.status });
    }
    return res.body;
  }
  /** @returns {Promise<string[]>} the Sink protocolInfo list */
  async protocolInfo() {
    const xml = await this.soap('connection', 'GetProtocolInfo');
    return (tagText(xml, 'Sink') || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  async readVolume() {
    const xml = await this.soap('rendering', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    const v = Number(tagText(xml, 'CurrentVolume'));
    if (Number.isFinite(v)) this.current.volume = Math.max(0, Math.min(1, v / 100));
  }
  /**
   * @param {{ url, contentType?, title, kind, image?, startTime?, duration?, protocolInfo? }} m
   */
  async load(m) {
    const protocolInfo = m.protocolInfo || `http-get:*:${m.contentType || 'video/mp4'}:*`;
    const meta = didl({ ...m, protocolInfo });
    this.url = m.url;
    this.started = false;
    this.stopping = false;
    this.loadedAt = Date.now();
    this.generation = (this.generation || 0) + 1; // a poll from before this load is stale
    try {
      await this.soap('avTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: m.url, CurrentURIMetaData: meta });
    } catch (err) {
      if (err.code !== 'UPNP_FAULT') throw err;
      // Some TVs reject metadata they cannot parse: once more, without it.
      await this.soap('avTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: m.url, CurrentURIMetaData: '' });
    }
    await this.soap('avTransport', 'Play', { InstanceID: 0, Speed: 1 });
    this.update({ state: 'buffering', position: m.startTime || 0, duration: m.duration ?? null, idleReason: null });
    if (m.startTime > 0 && this.seekSupported) {
      try {
        await this.seek(m.startTime);
      } catch (err) {
        if (err.code !== 'SEEK_UNSUPPORTED') throw err;
      }
    }
    this.startPolling();
  }
  startPolling() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }
  async play() {
    await this.soap('avTransport', 'Play', { InstanceID: 0, Speed: 1 });
    this.update({ state: 'playing' });
  }
  async pause() {
    await this.soap('avTransport', 'Pause', { InstanceID: 0 });
    this.update({ state: 'paused' });
  }
  async seek(seconds) {
    if (!this.seekSupported) throw Object.assign(new Error('This TV cannot seek'), { code: 'SEEK_UNSUPPORTED' });
    try {
      await this.soap('avTransport', 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: seekTime(seconds) });
    } catch (err) {
      if (err.upnpCode === 710) {
        this.seekSupported = false;
        throw Object.assign(new Error('This TV cannot seek'), { code: 'SEEK_UNSUPPORTED' });
      }
      throw err;
    }
    this.update({ position: Math.floor(seconds) });
  }
  async stop() {
    this.stopping = true;
    await this.soap('avTransport', 'Stop', { InstanceID: 0 });
    this.update({ state: 'idle', idleReason: 'stopped' });
  }
  async setVolume(level) {
    const v = Math.round(Math.max(0, Math.min(1, Number(level) || 0)) * 100);
    await this.soap('rendering', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: v });
    this.update({ volume: v / 100 });
  }
  /** One poll: position and transport state, and every fifth time (or `media`) the current URI and volume. */
  async refresh({ media = false } = {}) {
    if (this.closed) return this.status();
    const generation = this.generation || 0;
    try {
      const pos = await this.soap('avTransport', 'GetPositionInfo', { InstanceID: 0 });
      const tr = await this.soap('avTransport', 'GetTransportInfo', { InstanceID: 0 });
      let uri = null;
      if (media || this.polls % 5 === 4) {
        uri = tagText(await this.soap('avTransport', 'GetMediaInfo', { InstanceID: 0 }), 'CurrentURI');
        await this.readVolume().catch(() => {});
      }
      this.polls++;
      this.failures = 0;
      if (generation !== (this.generation || 0)) return this.status(); // a load happened meanwhile: this answer is about the old title
      if (this.current.idleReason) return this.status(); // already over: nothing more to say
      if (uri != null && this.url && uri !== this.url) {
        this.update({ state: 'idle', idleReason: 'taken' });
        return this.status();
      }
      const ts = tagText(tr, 'CurrentTransportState');
      const state = STATES[ts] || 'buffering';
      const position = parseTime(tagText(pos, 'RelTime'));
      const duration = parseTime(tagText(pos, 'TrackDuration'));
      const patch = {};
      if (position != null) patch.position = position;
      if (duration) patch.duration = duration;
      if (state === 'idle') {
        if (this.started) Object.assign(patch, { state: 'idle', idleReason: this.stopping ? 'stopped' : 'finished' });
        // Not started yet: some TVs say STOPPED for a moment after the load; it is still buffering. Still STOPPED
        // 10 s later means it couldn't fetch the video.
        else if (Date.now() - (this.loadedAt || 0) > 10_000) Object.assign(patch, { state: 'idle', idleReason: 'error' });
      } else {
        if (state === 'playing' || state === 'paused') this.started = true;
        patch.state = state;
      }
      this.update(patch);
      return this.status();
    } catch (err) {
      if (err.code === 'UPNP_FAULT') throw err;
      this.failures++;
      if (this.failures >= 2 && !this.closed) {
        this.close();
        this.emit('close', err);
      }
      throw err;
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
  }
}
