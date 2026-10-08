// Finding DLNA TVs: an SSDP M-SEARCH for MediaRenderers, then each answer's description.
import { udpTransport } from './udp.js';
import { parseDescription, fetchText } from './dlna.js';

export const RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';

export const mSearch = (mx = 2) =>
  Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${RENDERER}\r\n\r\n`);

/** @returns {{ location, usn, st }} from an SSDP answer's headers */
export function parseSsdp(text) {
  const h = {};
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { location: h.location || null, usn: h.usn || null, st: h.st || h.nt || null };
}

/**
 * @param {{ transport?, timeoutMs?, fetchDescription?: (url) => Promise<string> }} opts
 * @returns {Promise<{ id, kind: 'dlna', name, model, location, control }[]>}
 */
export async function searchDlna({ transport = udpTransport(), timeoutMs = 2500, fetchDescription = (url) => fetchText(url, { timeoutMs: 2000 }) } = {}) {
  const found = new Map(); // location → promise of a device or null
  const onMessage = (buf, rinfo) => {
    const { location } = parseSsdp(buf.toString('utf8'));
    let url;
    try {
      url = new URL(location);
    } catch {
      return;
    }
    // Only a device's own description: a LOCATION on any other host (localhost, the internet) is not fetched.
    if (!/^https?:$/.test(url.protocol) || url.hostname !== rinfo?.address || found.has(url.href) || found.size >= 32) return;
    found.set(
      url.href,
      fetchDescription(url.href)
        .then((xml) => {
          const d = parseDescription(xml, url.href);
          return d.control.avTransport ? { id: `dlna:${d.udn || url.href}`, kind: 'dlna', name: d.name, model: d.model, location: url.href, control: d.control } : null;
        })
        .catch(() => null),
    );
  };
  transport.on('message', onMessage);
  try {
    transport.send(mSearch(2), 1900, '239.255.255.250');
    await new Promise((r) => setTimeout(r, timeoutMs));
  } finally {
    transport.off?.('message', onMessage);
    transport.close();
  }
  const devices = new Map();
  for (const d of await Promise.all(found.values())) if (d && !devices.has(d.id)) devices.set(d.id, d);
  return [...devices.values()];
}
