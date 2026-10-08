// The DLNA driver against a pretend UPnP MediaRenderer, and the description parser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseDescription, DlnaDevice } from '../src/cast/dlna.js';
import { fakeDlna } from './helpers-cast.js';

const open = [];
after(async () => { for (const x of open) await x.close(); });
const fake = async (opts) => { const f = await fakeDlna(opts); open.push(f); return f; };
const device = async (f) => { const d = new DlnaDevice({ location: f.location, pollMs: 60_000 }); open.push(d); await d.connect(); return d; };

const desc = (urlBase, controlURL) => `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">${urlBase ? `<URLBase>${urlBase}</URLBase>` : ''}
<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Bedroom &amp; TV</friendlyName><modelName>Bravia</modelName><UDN>uuid:abc</UDN>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>${controlURL}</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>${controlURL.replace('AVTransport', 'RenderingControl')}</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>${controlURL.replace('AVTransport', 'ConnectionManager')}</controlURL></service>
</serviceList></device></root>`;

test('parseDescription resolves relative controlURLs against URLBase, or LOCATION when there is none', () => {
  const a = parseDescription(desc('http://10.0.0.5:49152/', '/upnp/control/AVTransport1'), 'http://10.0.0.5:8080/description.xml');
  assert.equal(a.control.avTransport, 'http://10.0.0.5:49152/upnp/control/AVTransport1');
  assert.equal(a.control.rendering, 'http://10.0.0.5:49152/upnp/control/RenderingControl1');
  assert.deepEqual([a.udn, a.name, a.model], ['uuid:abc', 'Bedroom & TV', 'Bravia']);
  const b = parseDescription(desc(null, 'control/AVTransport'), 'http://10.0.0.6:1400/xml/device.xml');
  assert.equal(b.control.avTransport, 'http://10.0.0.6:1400/xml/control/AVTransport');
  assert.equal(b.control.connection, 'http://10.0.0.6:1400/xml/control/ConnectionManager');
  const c = parseDescription(desc('http://10.0.0.7/', 'http://10.0.0.7:9000/AVTransport/ctl'), 'http://10.0.0.7:9000/d.xml');
  assert.equal(c.control.avTransport, 'http://10.0.0.7:9000/AVTransport/ctl');
});

test('load sends SetAVTransportURI with DIDL-Lite (title, class, res protocolInfo, albumArtURI), then Play; startTime seeks with REL_TIME 00:01:40', async () => {
  const f = await fake({ relativeControl: true });
  const d = await device(f);
  assert.equal(d.name, 'Samsung TV');
  await d.load({ url: 'http://192.168.1.20:8787/api/items/1/file?cast=T&x=1', contentType: 'video/mp4', title: 'Alien <1979>', kind: 'movie', image: 'http://192.168.1.20:8787/api/items/1/image/poster?cast=T', startTime: 100, duration: 7020 });
  const set = f.called('SetAVTransportURI')[0];
  assert.equal(set.path, '/dev/ctl/av', 'a relative controlURL resolved against LOCATION');
  assert.equal(set.args.CurrentURI, 'http://192.168.1.20:8787/api/items/1/file?cast=T&x=1');
  const meta = set.args.CurrentURIMetaData;
  assert.match(meta, /<DIDL-Lite /);
  assert.match(meta, /<dc:title>Alien &lt;1979&gt;<\/dc:title>/);
  assert.match(meta, /<upnp:class>object\.item\.videoItem<\/upnp:class>/);
  assert.match(meta, /<upnp:albumArtURI>http:\/\/192\.168\.1\.20:8787\/api\/items\/1\/image\/poster\?cast=T<\/upnp:albumArtURI>/);
  assert.match(meta, /<res protocolInfo="http-get:\*:video\/mp4:\*" duration="1:57:00">http:\/\/192\.168\.1\.20:8787\/api\/items\/1\/file\?cast=T&amp;x=1<\/res>/);
  assert.deepEqual(f.calls.map((c) => c.action).filter((a) => /SetAV|Play|Seek/.test(a)), ['SetAVTransportURI', 'Play', 'Seek']);
  assert.deepEqual(f.called('Seek')[0].args, { InstanceID: '0', Unit: 'REL_TIME', Target: '00:01:40' });
  assert.equal(f.state.position, 100);
  const music = await fake();
  const m = await device(music);
  await m.load({ url: 'http://x/a.mp3', contentType: 'audio/mpeg', title: 'Song', kind: 'track', protocolInfo: 'http-get:*:audio/mpeg:DLNA.ORG_OP=01' });
  const mm = music.called('SetAVTransportURI')[0].args.CurrentURIMetaData;
  assert.match(mm, /object\.item\.audioItem\.musicTrack/);
  assert.match(mm, /protocolInfo="http-get:\*:audio\/mpeg:DLNA.ORG_OP=01"/);
  assert.equal(music.called('Seek').length, 0, 'no seek from 0');
});

test('pause/stop/SetVolume 0.4 → 40; GetProtocolInfo returns the Sink list', async () => {
  const f = await fake({ urlBase: true, sink: ['http-get:*:video/mp4:*', 'http-get:*:video/x-matroska:*'] });
  const d = await device(f);
  assert.deepEqual(await d.protocolInfo(), ['http-get:*:video/mp4:*', 'http-get:*:video/x-matroska:*']);
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  await d.pause();
  assert.equal(f.state.transport, 'PAUSED_PLAYBACK');
  await d.play();
  assert.equal(f.state.transport, 'PLAYING');
  await d.setVolume(0.4);
  assert.deepEqual(f.called('SetVolume')[0].args, { InstanceID: '0', Channel: 'Master', DesiredVolume: '40' });
  await d.stop();
  assert.equal(f.state.transport, 'STOPPED');
  assert.equal(d.status().idleReason, 'stopped');
});

test('status follows GetPositionInfo/GetTransportInfo; a changed CurrentURI is taken; STOPPED at the end is finished', async () => {
  const f = await fake();
  const d = await device(f);
  const seen = [];
  d.on('status', (s) => seen.push(s));
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  f.tick(65);
  await d.refresh();
  assert.deepEqual(d.status(), { state: 'playing', position: 65, duration: 7020, volume: 0.5, idleReason: null });
  f.finish();
  await d.refresh();
  assert.equal(d.status().state, 'idle');
  assert.equal(d.status().idleReason, 'finished');
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  f.takeOver();
  await d.refresh({ media: true });
  assert.equal(d.status().idleReason, 'taken');
  assert.equal(d.status().state, 'idle');
  assert.ok(seen.length >= 3);
});

test('a metadata rejection retries once with empty metadata', async () => {
  const f = await fake();
  const d = await device(f);
  f.rejectMetadataOnce();
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  const sets = f.called('SetAVTransportURI');
  assert.equal(sets.length, 2);
  assert.ok(sets[0].args.CurrentURIMetaData.length > 0);
  assert.equal(sets[1].args.CurrentURIMetaData, '');
  assert.equal(f.state.transport, 'PLAYING');
});

test('a Seek fault 710 sets seekSupported false', async () => {
  const f = await fake();
  const d = await device(f);
  f.noSeek();
  assert.equal(d.seekSupported, true);
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie', startTime: 30 });
  assert.equal(d.seekSupported, false, 'the start seek found out, and load still played');
  assert.equal(f.state.transport, 'PLAYING');
  await assert.rejects(d.seek(60), (e) => e.code === 'SEEK_UNSUPPORTED');
});

test('a TV still STOPPED 10 s after the load reports an error (it could not fetch the video)', async () => {
  const f = await fake();
  const d = await device(f);
  f.refuseToPlay();
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  await d.refresh();
  assert.deepEqual([d.status().state, d.status().idleReason], ['buffering', null], 'within the grace time it is still loading');
  d.loadedAt -= 10_001;
  await d.refresh();
  assert.deepEqual([d.status().state, d.status().idleReason], ['idle', 'error']);
});

test('a poll started before a load does not mark the new title taken', async () => {
  const f = await fake();
  const d = await device(f);
  await d.load({ url: 'http://x/one.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  f.state.mediaDelay = 150; // the old poll's GetMediaInfo answers after the new load
  const stale = d.refresh({ media: true });
  await new Promise((r) => setTimeout(r, 20));
  f.state.mediaDelay = 0;
  await d.load({ url: 'http://x/two.mp4', contentType: 'video/mp4', title: 'T2', kind: 'movie' });
  await stale;
  assert.equal(d.status().idleReason, null, 'the old URI is not a takeover');
  await d.refresh({ media: true });
  assert.equal(d.status().idleReason, null);
});

test('an unreachable renderer emits close after two failed polls', async () => {
  const f = await fake();
  const d = await device(f);
  await d.load({ url: 'http://x/f.mp4', contentType: 'video/mp4', title: 'T', kind: 'movie' });
  let closed = false;
  d.on('close', () => (closed = true));
  await f.close();
  await d.refresh().catch(() => {});
  assert.equal(closed, false);
  await d.refresh().catch(() => {});
  assert.equal(closed, true);
});
