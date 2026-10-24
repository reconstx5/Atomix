// Addresses Atomix refuses to be pointed at by hand: the unspecified address and the link-local range cloud
// metadata lives on. Loopback stays allowed — a Jellyfin on the same machine is a normal setup (pointing at
// Atomix itself is caught by isSelf). Home-network addresses are of course fine: that's where the TVs are.
import { lookup as dnsLookup } from 'node:dns/promises';

const PRIVATE_NAMES = new Set(['0.0.0.0', '::']);

/** True when the URL's host is the unspecified address or link-local (IPv4 169.254/16, IPv6 fe80::/10). */
export function isPrivateTarget(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  const name = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_NAMES.has(name)) return true;
  if (/^169\.254\./.test(name)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(name)) return true;
  // An IPv4 address written inside IPv6 ("::ffff:169.254.1.1") comes out of URL parsing as hex ("::ffff:a9fe:101").
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(name) || /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (mapped) {
    const v4 = mapped.length === 3 ? [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255] : mapped.slice(1, 5).map(Number);
    if (v4[0] === 169 && v4[1] === 254) return true;
    if (v4.every((n) => n === 0)) return true;
  }
  if (name === '::ffff:0:0') return true;
  return false;
}

/**
 * An address as it may appear in a log line or an error: scheme, host and port only. IPTV providers put the
 * subscriber's username and password in the path (Xtream) or the query, so neither is ever shown.
 */
export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '[address]';
  }
}

/**
 * isPrivateTarget, and the same for the addresses a host name resolves to: a name pointing at the metadata address
 * (169.254.169.254) or the unspecified address is refused as if it were written. A name that doesn't resolve is
 * left for the fetch itself to report. Throws { code: 'EPRIVATE' }.
 */
export async function checkResolved(url, { lookup = dnsLookup } = {}) {
  const refused = () => Object.assign(new Error("That address isn't allowed"), { code: 'EPRIVATE' });
  if (isPrivateTarget(url)) throw refused();
  let host;
  try {
    host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return;
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return; // an address literal: checked above
  let all;
  try {
    all = await lookup(host, { all: true });
  } catch {
    return;
  }
  for (const a of [].concat(all || [])) {
    const addr = a.address || a;
    if (isPrivateTarget(`http://${String(addr).includes(':') ? `[${addr}]` : addr}/`)) throw refused();
  }
}
