// Finding Chromecasts: one mDNS question for _googlecast._tcp.local, and a small DNS packet reader for the answers
// (PTR, SRV, TXT and A records, with name compression).
import { udpTransport } from './udp.js';

const TYPES = { 1: 'A', 12: 'PTR', 16: 'TXT', 33: 'SRV' };
export const CAST_SERVICE = '_googlecast._tcp.local';

/** A PTR question for `name`, with the unicast-response bit set (we ask from a random port). */
export function buildQuery(name) {
  const labels = name.split('.').filter(Boolean).map((l) => {
    const b = Buffer.from(l);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 0x80, 1])]);
}

function readName(buf, pos) {
  const labels = [];
  let end = null;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated name');
    const len = buf[pos];
    if (len === 0) {
      pos++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated pointer');
      if (++jumps > 32) throw new Error('name pointer loop');
      if (end == null) end = pos + 2;
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (target >= pos) throw new Error('name pointer points forward');
      pos = target;
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated label');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join('.'), end ?? pos];
}

/** @returns {{ name, type, ttl, data }[]} every answer and additional record of a known type */
export function parseResponse(buf) {
  if (buf.length < 12) throw new Error('truncated header');
  const qd = buf.readUInt16BE(4);
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    [, pos] = readName(buf, pos);
    pos += 4;
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    let name;
    [name, pos] = readName(buf, pos);
    if (pos + 10 > buf.length) throw new Error('truncated record');
    const typeCode = buf.readUInt16BE(pos);
    const ttl = buf.readUInt32BE(pos + 4);
    const len = buf.readUInt16BE(pos + 8);
    const start = pos + 10;
    if (start + len > buf.length) throw new Error('truncated record data');
    const type = TYPES[typeCode];
    let data;
    if (type === 'A' && len === 4) data = [...buf.subarray(start, start + 4)].join('.');
    else if (type === 'PTR') [data] = readName(buf, start);
    else if (type === 'SRV') data = { priority: buf.readUInt16BE(start), weight: buf.readUInt16BE(start + 2), port: buf.readUInt16BE(start + 4), target: readName(buf, start + 6)[0] };
    else if (type === 'TXT') {
      data = {};
      for (let p = start; p < start + len; ) {
        const l = buf[p];
        const s = buf.toString('utf8', p + 1, Math.min(p + 1 + l, start + len));
        const eq = s.indexOf('=');
        if (eq > 0) data[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
        p += 1 + l;
      }
    }
    if (type && data !== undefined) out.push({ name, type, ttl, data });
    pos = start + len;
  }
  return out;
}

/**
 * Asks the network for Chromecasts and collects answers for `timeoutMs`.
 * @returns {Promise<{ id, kind: 'chromecast', name, model, host, port }[]>}
 */
export async function searchCast({ transport = udpTransport(), timeoutMs = 2000 } = {}) {
  const records = [];
  const onMessage = (buf, rinfo) => {
    try {
      for (const r of parseResponse(buf)) records.push({ ...r, from: rinfo?.address });
    } catch {
      // not a DNS packet we can read
    }
  };
  transport.on('message', onMessage);
  try {
    transport.send(buildQuery(CAST_SERVICE), 5353, '224.0.0.251');
    await new Promise((r) => setTimeout(r, timeoutMs));
  } finally {
    transport.off?.('message', onMessage);
    transport.close();
  }
  const lower = (s) => String(s).toLowerCase();
  const instances = new Map(); // instance name → { from }
  for (const r of records) if (r.type === 'PTR' && lower(r.name) === CAST_SERVICE) instances.set(lower(r.data), { from: r.from });
  const devices = new Map();
  for (const [instance, { from }] of instances) {
    const srv = records.find((r) => r.type === 'SRV' && lower(r.name) === instance)?.data;
    const txt = records.find((r) => r.type === 'TXT' && lower(r.name) === instance)?.data || {};
    const a = srv && records.find((r) => r.type === 'A' && lower(r.name) === lower(srv.target))?.data;
    const host = a || from;
    if (!host) continue;
    const id = `cc:${txt.id || instance}`;
    if (devices.has(id)) continue;
    devices.set(id, { id, kind: 'chromecast', name: txt.fn || instance.split('.')[0], model: txt.md || null, host, port: srv?.port || 8009 });
  }
  return [...devices.values()];
}
