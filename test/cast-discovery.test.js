// Finding cast devices: the mDNS packet reader, SSDP, the device list, the address TVs fetch from, and formats.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildQuery, parseResponse, searchCast } from '../src/cast/mdns.js';
import { parseSsdp, searchDlna } from '../src/cast/ssdp.js';
import { parseDescription } from '../src/cast/dlna.js';
import { CastDevices, baseUrlFor } from '../src/cast/devices.js';
import { castCaps, sinkToCaps, dlnaHeaders } from '../src/cast/caps.js';
import { openDatabase } from '../src/db.js';
import { tempDir } from './helpers.js';
import { fakeChromecast, fakeDlna, hasOpenssl } from './helpers-cast.js';

const open = [];
after(async () => { for (const x of open) await x.close(); });

// A _googlecast answer as a Chromecast sends it: one PTR answer, then SRV, TXT and A as additional records, with
// names compressed by pointers back into the packet.
function castAnswer({ instance = 'Chromecast-abc123', id = 'abc123', fn = 'Living Room TV', md = 'Chromecast', ip = [192, 168, 1, 60], port = 8009 } = {}) {
  const bytes = [];
  const u16 = (n) => bytes.push((n >> 8) & 255, n & 255);
  const u32 = (n) => { u16((n >>> 16) & 0xffff); u16(n & 0xffff); };
  const label = (s) => { const b = Buffer.from(s); bytes.push(b.length, ...b); };
  const ptr = (off) => u16(0xc000 | off);
  u16(0); u16(0x8400); u16(0); u16(1); u16(0); u16(3);
  const serviceAt = bytes.length; // _googlecast._tcp.local
  label('_googlecast'); const tcpAt = bytes.length; label('_tcp'); const localAt = bytes.length; label('local'); bytes.push(0);
  void tcpAt;
  u16(12); u16(1); u32(120);
  const rdlenAt = bytes.length; u16(0);
  const instanceAt = bytes.length; label(instance); ptr(serviceAt);
  const rdlen = bytes.length - instanceAt; bytes[rdlenAt] = rdlen >> 8; bytes[rdlenAt + 1] = rdlen & 255;
  // SRV
  ptr(instanceAt); u16(33); u16(0x8001); u32(120);
  const srvLenAt = bytes.length; u16(0);
  const srvStart = bytes.length; u16(0); u16(0); u16(port);
  const targetAt = bytes.length; label(id); ptr(localAt);
  const srvLen = bytes.length - srvStart; bytes[srvLenAt] = srvLen >> 8; bytes[srvLenAt + 1] = srvLen & 255;
  // TXT
  ptr(instanceAt); u16(16); u16(0x8001); u32(4500);
  const txt = [`id=${id}`, `md=${md}`, `fn=${fn}`, 've=05'].map((s) => Buffer.from(s));
  u16(txt.reduce((n, b) => n + b.length + 1, 0));
  for (const b of txt) bytes.push(b.length, ...b);
  // A
  ptr(targetAt); u16(1); u16(0x8001); u32(120); u16(4); bytes.push(...ip);
  return Buffer.from(bytes);
}

const desc = (urlBase, controlURL) => `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">${urlBase ? `<URLBase>${urlBase}</URLBase>` : ''}<device><friendlyName>TV</friendlyName><UDN>uuid:abc</UDN><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>${controlURL}</controlURL></service></serviceList></device></root>`;

function fakeTransport(replies) {
  const t = new EventEmitter();
  t.sent = [];
  t.closed = false;
  t.send = (buf, port, address) => {
    t.sent.push({ buf, port, address });
    for (const [r, from] of replies) setImmediate(() => t.emit('message', Buffer.isBuffer(r) ? r : Buffer.from(r), { address: from, port }));
  };
  t.close = () => { t.closed = true; };
  return t;
}

test('parseResponse reads a captured _googlecast answer (PTR, SRV, TXT fn/md/id, A) with name compression', () => {
  const recs = parseResponse(castAnswer());
  const by = (type) => recs.find((r) => r.type === type);
  assert.equal(by('PTR').name, '_googlecast._tcp.local');
  assert.equal(by('PTR').data, 'Chromecast-abc123._googlecast._tcp.local');
  assert.equal(by('SRV').name, 'Chromecast-abc123._googlecast._tcp.local');
  assert.deepEqual(by('SRV').data, { priority: 0, weight: 0, port: 8009, target: 'abc123.local' });
  assert.deepEqual(by('TXT').data, { id: 'abc123', md: 'Chromecast', fn: 'Living Room TV', ve: '05' });
  assert.deepEqual([by('A').name, by('A').data], ['abc123.local', '192.168.1.60']);
  const q = buildQuery('_googlecast._tcp.local');
  assert.equal(q.readUInt16BE(4), 1, 'one question');
  assert.deepEqual(parseResponse(q), [], 'a query has no answers');
  assert.throws(() => parseResponse(Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 0x0c])), /pointer|truncated/i, 'a pointer loop is refused');
});

test('an SSDP answer is only believed from the host it names, and a description cannot point its controls at another host', async () => {
  const tv = await fakeDlna({ name: 'Real TV' });
  open.push(tv);
  const reply = (loc) => `HTTP/1.1 200 OK\r\nLOCATION: ${loc}\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:x\r\n\r\n`;
  let fetched = [];
  const dlna = await searchDlna({ transport: fakeTransport([[reply(tv.location), '192.168.1.66'], [reply('http://169.254.169.254/latest/meta-data/'), '192.168.1.66']]), timeoutMs: 100, fetchDescription: async (u) => { fetched.push(u); return ''; } });
  assert.deepEqual([dlna, fetched], [[], []], 'nothing fetched for a LOCATION on a host other than the sender');
  const away = parseDescription(desc('http://evil.example/', '/upnp/control/AVTransport1'), 'http://10.0.0.5:8080/d.xml');
  assert.deepEqual(away.control, {}, 'controls on another host are dropped');
  const absolute = parseDescription(desc(null, 'http://10.0.0.99:9000/AVTransport/ctl'), 'http://10.0.0.5:8080/d.xml');
  assert.equal(absolute.control.avTransport, undefined);
});

test('searchCast and searchDlna collect devices from fake transports; duplicates merge', async () => {
  const mdns = fakeTransport([
    [castAnswer(), '192.168.1.60'],
    [castAnswer(), '192.168.1.60'],
    [castAnswer({ instance: 'Google-TV-9f', id: '9f', fn: 'Den', md: 'Chromecast HD', ip: [192, 168, 1, 61] }), '192.168.1.61'],
    ['garbage', '192.168.1.99'],
  ]);
  const cast = await searchCast({ transport: mdns, timeoutMs: 50 });
  assert.equal(mdns.sent[0].port, 5353);
  assert.equal(mdns.sent[0].address, '224.0.0.251');
  assert.ok(mdns.closed);
  assert.deepEqual(cast.sort((a, b) => a.name.localeCompare(b.name)), [
    { id: 'cc:9f', kind: 'chromecast', name: 'Den', model: 'Chromecast HD', host: '192.168.1.61', port: 8009 },
    { id: 'cc:abc123', kind: 'chromecast', name: 'Living Room TV', model: 'Chromecast', host: '192.168.1.60', port: 8009 },
  ]);

  const tv = await fakeDlna({ name: 'Samsung TV' });
  open.push(tv);
  const reply = (loc, usn) => `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${loc}\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: ${usn}\r\n\r\n`;
  assert.deepEqual(parseSsdp(reply('http://a/d.xml', 'uuid:x::urn:schemas-upnp-org:device:MediaRenderer:1')), { location: 'http://a/d.xml', usn: 'uuid:x::urn:schemas-upnp-org:device:MediaRenderer:1', st: 'urn:schemas-upnp-org:device:MediaRenderer:1' });
  const ssdp = fakeTransport([
    [reply(tv.location, 'uuid:fake-dlna-1::urn:schemas-upnp-org:device:MediaRenderer:1'), '127.0.0.1'],
    [reply(tv.location, 'uuid:fake-dlna-1::urn:schemas-upnp-org:device:MediaRenderer:1'), '127.0.0.1'],
    [reply('http://127.0.0.1:1/dead.xml', 'uuid:dead'), '127.0.0.1'],
  ]);
  const dlna = await searchDlna({ transport: ssdp, timeoutMs: 300 });
  assert.match(ssdp.sent[0].buf.toString(), /^M-SEARCH \* HTTP\/1\.1\r\n[\s\S]*MAN: "ssdp:discover"[\s\S]*ST: urn:schemas-upnp-org:device:MediaRenderer:1/);
  assert.equal(ssdp.sent[0].address, '239.255.255.250');
  assert.equal(dlna.length, 1, 'the duplicate merged and the dead one left out');
  assert.equal(dlna[0].id, 'dlna:uuid:fake-dlna-1');
  assert.equal(dlna[0].name, 'Samsung TV');
  assert.equal(dlna[0].location, tv.location);
  assert.equal(dlna[0].control.avTransport, `${tv.base}/upnp/ctl/av`);
});

function devicesWith({ cast = [], dlna = [], config = {}, now } = {}) {
  const db = openDatabase(path.join(tempDir(), 'cast.db'));
  const searches = { cast: 0, dlna: 0 };
  const devices = new CastDevices({
    db,
    config: { castDevices: [], ...config },
    search: {
      cast: async () => { searches.cast++; return cast.map((d) => ({ ...d })); },
      dlna: async () => { searches.dlna++; return dlna.map((d) => ({ ...d })); },
    },
    now,
  });
  return { db, devices, searches };
}

test('the list is kept 5 minutes; refresh replaces it; manual and ATOMIX_CAST_DEVICES devices are added', async () => {
  let t = 1_000_000;
  const cc = { id: 'cc:1', kind: 'chromecast', name: 'Lounge', model: 'Chromecast', host: '192.168.1.60', port: 8009 };
  const { db, devices, searches } = devicesWith({ cast: [cc], config: { castDevices: [{ kind: 'chromecast', address: '127.0.0.1:9916#Mock Chromecast' }] }, now: () => t });
  db.run("INSERT INTO cast_devices (kind, name, address, created_at) VALUES ('dlna', 'Kitchen TV', 'http://192.168.1.70:7676/desc.xml', 1)");
  const first = await devices.list();
  assert.deepEqual(first.map((d) => d.name).sort(), ['Kitchen TV', 'Lounge', 'Mock Chromecast']);
  const manual = first.find((d) => d.name === 'Kitchen TV');
  assert.equal(manual.id, 'manual:1');
  assert.equal(manual.manual, true);
  assert.equal(manual.location, 'http://192.168.1.70:7676/desc.xml');
  const env = first.find((d) => d.name === 'Mock Chromecast');
  assert.deepEqual([env.host, env.port, env.kind], ['127.0.0.1', 9916, 'chromecast']);
  t += 4 * 60_000;
  await devices.list();
  assert.equal(searches.cast, 1, 'kept');
  t += 2 * 60_000;
  await devices.list();
  assert.equal(searches.cast, 2, 'older than 5 minutes: searched again');
  await devices.list({ refresh: true });
  assert.equal(searches.cast, 3);
  assert.equal(searches.dlna, 3);
  assert.equal((await devices.get('cc:1')).name, 'Lounge');
  assert.equal(await devices.get('cc:nope'), null);
});

test('addManual checks a Chromecast (fakeChromecast) and a DLNA description (fakeDlna); a dead address is a 400', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const cc = await fakeChromecast();
  const tv = await fakeDlna({ name: 'Bedroom TV' });
  open.push(cc, tv);
  const { devices } = devicesWith();
  const a = await devices.addManual({ kind: 'chromecast', address: `${cc.host}:${cc.port}`, name: 'Office' });
  assert.deepEqual([a.id, a.kind, a.name, a.host, a.port, a.manual], ['manual:1', 'chromecast', 'Office', '127.0.0.1', cc.port, true]);
  assert.ok(cc.sent('GET_STATUS').length >= 1, 'it asked the device');
  const b = await devices.addManual({ kind: 'dlna', address: tv.location });
  assert.equal(b.name, 'Bedroom TV', 'the name comes from the description');
  assert.deepEqual((await devices.list()).filter((d) => d.manual).map((d) => d.name), ['Office', 'Bedroom TV']);
  await assert.rejects(devices.addManual({ kind: 'chromecast', address: '127.0.0.1:1' }), (e) => e.status === 400);
  await assert.rejects(devices.addManual({ kind: 'dlna', address: 'http://127.0.0.1:1/d.xml' }), (e) => e.status === 400);
  await assert.rejects(devices.addManual({ kind: 'dlna', address: 'file:///etc/passwd' }), (e) => e.status === 400);
  await assert.rejects(devices.addManual({ kind: 'airplay', address: 'x' }), (e) => e.status === 400);
  devices.remove('manual:1');
  assert.deepEqual((await devices.list()).filter((d) => d.manual).map((d) => d.name), ['Bedroom TV']);
  assert.throws(() => devices.remove('cc:1'), (e) => e.status === 404);
});

test('baseUrlFor picks the interface on the device\'s subnet, then a private non-docker/VPN address, else null; the setting wins', () => {
  const iface = (address, netmask, internal = false) => ({ address, netmask, family: 'IPv4', internal, cidr: null });
  const interfaces = {
    lo: [iface('127.0.0.1', '255.0.0.0', true)],
    docker0: [iface('172.17.0.1', '255.255.0.0')],
    tun0: [iface('10.8.0.2', '255.255.255.0')],
    wlan0: [iface('192.168.1.20', '255.255.255.0'), { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
  };
  const settings = { castBaseUrl: null };
  assert.equal(baseUrlFor('192.168.1.50', { settings, config: {}, port: 8787, interfaces }), 'http://192.168.1.20:8787');
  assert.equal(baseUrlFor('10.1.2.3', { settings, config: {}, port: 8787, interfaces }), 'http://192.168.1.20:8787', 'not the VPN, not docker');
  assert.equal(baseUrlFor('172.17.0.5', { settings, config: {}, port: 8787, interfaces }), 'http://172.17.0.1:8787', 'a device really on that subnet');
  assert.equal(baseUrlFor('192.168.1.50', { settings, config: {}, port: 8787, interfaces: { eth0: [iface('203.0.113.9', '255.255.255.0')], lo: interfaces.lo } }), null);
  assert.equal(baseUrlFor('192.168.1.50', { settings: { castBaseUrl: 'http://atomix.lan:8787/' }, config: {}, port: 8787, interfaces }), 'http://atomix.lan:8787');
  assert.equal(baseUrlFor('192.168.1.50', { settings, config: { castBaseUrl: 'http://10.0.0.9:8787' }, port: 8787, interfaces }), 'http://10.0.0.9:8787');
  // A VPN whose wide subnet also covers the home LAN, listed first: the LAN's own (narrower, real) interface wins.
  const overlapping = { tun0: [iface('10.9.0.5', '255.0.0.0')], docker0: [iface('10.0.1.2', '255.255.0.0')], wlan0: [iface('10.0.1.20', '255.255.255.0')] };
  assert.equal(baseUrlFor('10.0.1.9', { settings, config: {}, port: 8787, interfaces: overlapping }), 'http://10.0.1.20:8787');
  assert.equal(baseUrlFor('10.0.1.9', { settings, config: {}, port: 8787, interfaces: { tun0: overlapping.tun0 } }), 'http://10.9.0.5:8787', 'only the VPN covers it: still usable');
  assert.equal(baseUrlFor('127.0.0.1', { settings, config: {}, port: 8787, interfaces }), 'http://127.0.0.1:8787', 'a device on this machine');
});

test('castCaps: a Chromecast, a Google TV (hevc, hdr), a DLNA Sink list, and an empty Sink list → mp4/h264/aac', () => {
  assert.deepEqual(castCaps({ kind: 'chromecast', model: 'Chromecast' }), { containers: ['mp4', 'webm'], video: ['h264', 'vp9', 'vp8'], audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'], hls: false, hdr: false });
  const gtv = castCaps({ kind: 'chromecast', model: 'Chromecast with Google TV' });
  assert.ok(gtv.video.includes('hevc'));
  assert.equal(gtv.hdr, true);
  assert.equal(castCaps({ kind: 'chromecast', model: 'Chromecast Ultra' }).hdr, true);
  const sink = ['http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_HP_HD_AAC', 'http-get:*:video/x-matroska:*', 'http-get:*:video/x-hevc:*', 'http-get:*:audio/mpeg:*', 'http-get:*:audio/ac3:*', 'http-get:*:audio/flac:*', 'http-get:*:image/jpeg:*'];
  assert.deepEqual(sinkToCaps(sink), { containers: ['mp4', 'mkv', 'mp3', 'flac'], video: ['h264', 'hevc'], audio: ['aac', 'mp3', 'ac3', 'flac'], hls: false, hdr: false });
  assert.deepEqual(castCaps({ kind: 'dlna', sink }), sinkToCaps(sink));
  assert.deepEqual(sinkToCaps([]), { containers: ['mp4'], video: ['h264'], audio: ['aac'], hls: false, hdr: false });
  assert.deepEqual(castCaps({ kind: 'dlna' }), sinkToCaps([]));
  assert.deepEqual(dlnaHeaders(), { 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1' });
});
