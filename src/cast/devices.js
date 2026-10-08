// The cast device list: what discovery found (kept 5 minutes), devices an admin added by address, and (dev/test)
// devices from ATOMIX_CAST_DEVICES. Also the address a TV should fetch Atomix's media from.
import os from 'node:os';
import { HttpError } from '../http/router.js';
import { searchCast } from './mdns.js';
import { searchDlna } from './ssdp.js';
import { ChromecastDevice } from './chromecast.js';
import { DlnaDevice } from './dlna.js';
import { NS } from './castv2.js';

const CACHE_MS = 5 * 60_000;

/** "host[:port][#name]" or "<url>[#name]" → { address, name } */
function splitName(address) {
  const i = String(address).indexOf('#');
  return i < 0 ? { address: String(address), name: null } : { address: String(address).slice(0, i), name: String(address).slice(i + 1) || null };
}
function hostPort(address) {
  const m = /^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/.exec(String(address).trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 8009;
  if (!(port > 0 && port < 65536)) return null;
  return { host: m[1], port };
}
function httpUrl(address) {
  try {
    const u = new URL(String(address).trim());
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function toDevice(kind, address, name, id, extra = {}) {
  if (kind === 'chromecast') {
    const hp = hostPort(address);
    return hp && { id, kind, name: name || `Chromecast (${hp.host})`, model: null, host: hp.host, port: hp.port, ...extra };
  }
  const location = httpUrl(address);
  return location && { id, kind: 'dlna', name: name || 'TV', model: null, location, ...extra };
}

export class CastDevices {
  /**
   * @param {{ db, config, search?: { cast?: () => Promise<object[]>, dlna?: () => Promise<object[]> }, now?: () => number }} opts
   */
  constructor({ db, config, search = {}, now = Date.now }) {
    this.db = db;
    this.config = config;
    this.search = { cast: search.cast || (() => searchCast()), dlna: search.dlna || (() => searchDlna()) };
    this.now = now;
    this.found = null; // { at, devices }
    this.pending = null;
  }
  manual() {
    const rows = this.db.all('SELECT * FROM cast_devices ORDER BY id');
    const fromDb = rows.map((r) => toDevice(r.kind, r.address, r.name, `manual:${r.id}`, { manual: true })).filter(Boolean);
    const fromEnv = (this.config.castDevices || []).map((d) => {
      const { address, name } = splitName(d.address);
      return toDevice(d.kind, address, name, `env:${d.kind}:${address}`, { manual: true });
    }).filter(Boolean);
    return [...fromDb, ...fromEnv];
  }
  async discover() {
    const [cast, dlna] = await Promise.allSettled([this.search.cast(), this.search.dlna()]);
    const devices = [...(cast.value || []), ...(dlna.value || [])];
    this.found = { at: this.now(), devices };
    return devices;
  }
  /** @returns {Promise<object[]>} discovered devices, then manual ones (a manual device found by discovery too is listed once) */
  async list({ refresh = false } = {}) {
    if (refresh || !this.found || this.now() - this.found.at >= CACHE_MS) {
      this.pending ||= this.discover().finally(() => (this.pending = null));
      await this.pending;
    }
    const found = this.found.devices;
    const key = (d) => (d.kind === 'chromecast' ? `cc:${d.host}:${d.port}` : `dlna:${d.location}`);
    const seen = new Set(found.map(key));
    return [...found, ...this.manual().filter((d) => !seen.has(key(d)))];
  }
  async get(id) {
    const all = [...(this.found?.devices || []), ...this.manual()];
    return all.find((d) => d.id === id) || null;
  }
  /** Checks the address answers as that kind of device, then stores it. */
  async addManual({ kind, address, name }) {
    const label = String(name || '').trim().slice(0, 80) || null;
    if (kind === 'chromecast') {
      const hp = hostPort(address);
      if (!hp) throw new HttpError(400, 'Enter the Chromecast as an address, like 192.168.1.40 or 192.168.1.40:8009.');
      const d = new ChromecastDevice({ host: hp.host, port: hp.port });
      try {
        await d.connect();
        await d.channel.request(NS.receiver, { type: 'GET_STATUS' });
      } catch {
        throw new HttpError(400, `Atomix could not reach a Chromecast at ${hp.host}:${hp.port}.`);
      } finally {
        d.close();
      }
      return this.store('chromecast', `${hp.host}:${hp.port}`, label || `Chromecast (${hp.host})`);
    }
    if (kind === 'dlna') {
      const location = httpUrl(address);
      if (!location) throw new HttpError(400, "Enter the TV's description address, like http://192.168.1.50:7676/description.xml.");
      const d = new DlnaDevice({ location });
      let desc;
      try {
        desc = await d.connect();
      } catch {
        throw new HttpError(400, `Atomix could not find a TV at ${location}.`);
      } finally {
        d.close();
      }
      return this.store('dlna', location, label || desc.name);
    }
    throw new HttpError(400, 'Choose Chromecast or DLNA.');
  }
  store(kind, address, name) {
    const r = this.db.run('INSERT INTO cast_devices (kind, name, address, created_at) VALUES (?, ?, ?, ?)', kind, name, address, Date.now());
    return toDevice(kind, address, name, `manual:${r.lastInsertRowid}`, { manual: true });
  }
  remove(id) {
    const m = /^manual:(\d+)$/.exec(String(id));
    const r = m && this.db.run('DELETE FROM cast_devices WHERE id = ?', Number(m[1]));
    if (!r?.changes) throw new HttpError(404, 'That device was not added by address.');
  }
}

const ipNum = (a) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const isIPv4 = (a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(a));
const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const VIRTUAL = /^(docker|br-|veth|tun|tap|wg|utun|virbr|vmnet|zt)/i;

/**
 * The address a device at `host` should use to reach Atomix.
 * @returns {string|null} like "http://192.168.1.20:8787", or null when no address fits
 */
export function baseUrlFor(host, { settings, config, port, interfaces = os.networkInterfaces() }) {
  const override = settings?.castBaseUrl || config?.castBaseUrl;
  if (override) return String(override).replace(/\/+$/, '');
  if (/^(127\.|localhost$|::1$)/.test(String(host))) return `http://127.0.0.1:${port}`;
  const v4 = Object.entries(interfaces).flatMap(([name, list]) => (list || []).filter((i) => i.family === 'IPv4' || i.family === 4).map((i) => ({ name, ...i }))).filter((i) => !i.internal);
  if (isIPv4(host)) {
    const h = ipNum(host);
    // Every interface whose subnet holds the device; a real interface beats a docker/VPN one, then the narrowest
    // subnet wins (a VPN's 10.0.0.0/8 also "contains" a home LAN on 10.0.1.0/24).
    const bits = (mask) => mask.split('.').reduce((n, x) => n + Number(x).toString(2).replace(/0/g, '').length, 0);
    const same = v4
      .filter((i) => {
        const mask = ipNum(i.netmask);
        return mask && ((ipNum(i.address) & mask) >>> 0) === ((h & mask) >>> 0);
      })
      .sort((a, b) => Number(VIRTUAL.test(a.name)) - Number(VIRTUAL.test(b.name)) || bits(b.netmask) - bits(a.netmask))[0];
    if (same) return `http://${same.address}:${port}`;
  }
  const lan = v4.find((i) => isPrivate(i.address) && !VIRTUAL.test(i.name));
  return lan ? `http://${lan.address}:${port}` : null;
}
