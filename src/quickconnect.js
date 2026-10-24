// Quick Connect: sign a TV (or any screen without a keyboard) in without typing a password. The TV asks for a code
// and shows it; someone already signed in types it in Settings → Profile → Quick Connect; the TV, polling with its
// own private token, is signed in as that account and asks "Who's watching?". Codes last 5 minutes and sign in once.
// Every waiting code is compared in constant time; 5 wrong codes in a row from one account cancel every waiting code
// (the TVs simply show new ones).
import crypto from 'node:crypto';
import { makeCode } from './together.js';
import { HttpError } from './http/router.js';

const WRONG_LIMIT = 5;
const COLLECT_MS = 60_000; // an approved code must be collected by its TV within a minute
const LIVE_PER_ADDRESS = 5;
const STARTS_PER_MINUTE = 10;
const MAX_WAITING = 1000;
const BUSY = 'Too many codes from this address. Try again in a minute.';

/** A short name for the device, from its browser's user agent. */
export function deviceName(ua = '') {
  const s = String(ua);
  if (/SMART-TV|SmartTV|Tizen|Web0S|webOS|Android TV|AFT[A-Z]|CrKey|BRAVIA|HbbTV|NetCast/i.test(s)) return 'a smart TV';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'a Mac' : /CrOS/.test(s) ? 'a Chromebook' : /Linux/.test(s) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || 'a web browser';
}

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export class QuickConnect {
  constructor({ now = Date.now, ttlMs = 5 * 60_000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.waiting = new Map(); // poll token -> { code, expiresAt, device, userId }
    this.wrongs = new Map(); // userId -> wrong codes in a row
    this.starts = new Map(); // address -> start times in the last minute
  }
  gone(e, now) {
    return e.userId ? now - e.approvedAt > COLLECT_MS : e.expiresAt <= now;
  }
  sweep() {
    const now = this.now();
    for (const [k, v] of this.waiting) if (this.gone(v, now)) this.waiting.delete(k);
    for (const [ip, times] of this.starts) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length) this.starts.set(ip, recent);
      else this.starts.delete(ip);
    }
  }
  /** A new code for a TV at `ip`: at most 5 waiting and 10 started a minute per address, 1000 in all. */
  start(userAgent = '', ip = '') {
    this.sweep();
    const now = this.now();
    const live = [...this.waiting.values()].filter((e) => e.ip === ip && !e.userId).length;
    const recent = this.starts.get(ip) || [];
    if (live >= LIVE_PER_ADDRESS || recent.length >= STARTS_PER_MINUTE) throw new HttpError(429, BUSY);
    if (this.waiting.size >= MAX_WAITING) throw new HttpError(429, BUSY);
    recent.push(now);
    this.starts.set(ip, recent);
    const entry = { code: makeCode(6), expiresAt: now + this.ttlMs, device: deviceName(userAgent), userId: null, ip };
    const poll = crypto.randomBytes(24).toString('base64url');
    this.waiting.set(poll, entry);
    return { code: entry.code, poll, expiresAt: entry.expiresAt, ttlMs: this.ttlMs, device: entry.device };
  }
  /** The TV asking: still waiting, gone, or approved (once — the token is spent after that). */
  poll(token) {
    const e = this.waiting.get(String(token || ''));
    if (!e) return { status: 'expired' };
    if (this.gone(e, this.now())) {
      this.waiting.delete(String(token));
      return { status: 'expired' };
    }
    if (e.userId) {
      this.waiting.delete(String(token));
      return { status: 'approved', userId: e.userId };
    }
    if (e.expiresAt <= this.now()) {
      this.waiting.delete(String(token));
      return { status: 'expired' };
    }
    return { status: 'waiting' };
  }
  /** Someone signed in typed `code`: approve the TV showing it. Null when no TV is showing it. */
  approve(code, userId) {
    const typed = String(code || '').trim().toUpperCase();
    const now = this.now();
    let found = null;
    for (const e of this.waiting.values()) {
      const ok = same(e.code, typed) && !e.userId && e.expiresAt > now; // every code is compared: no early exit
      if (ok && !found) found = e;
    }
    if (!found) {
      this.wrong(userId);
      return null;
    }
    this.wrongs.delete(userId);
    found.userId = userId;
    found.approvedAt = now;
    return { device: found.device, ip: found.ip || null };
  }
  /** A TV's code forgotten (Quick Connect turned off). */
  forget(token) {
    this.waiting.delete(String(token || ''));
  }
  /** Every waiting and approved code goes (Quick Connect turned off). */
  clear() {
    this.waiting.clear();
  }
  wrong(userId) {
    const n = (this.wrongs.get(userId) || 0) + 1;
    if (n >= WRONG_LIMIT) {
      for (const [k, e] of this.waiting) if (!e.userId) this.waiting.delete(k);
      this.wrongs.delete(userId);
      return;
    }
    this.wrongs.set(userId, n);
  }
}
