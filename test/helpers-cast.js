// Pretend cast devices for the casting tests: a Chromecast speaking the real Cast v2 framing over TLS, and (Task 3)
// a DLNA renderer speaking UPnP SOAP. Both "play" on a clock the test moves.
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './helpers.js';
import { encodeCastMessage, FrameReader } from '../src/cast/protobuf.js';

export const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let certs = null;
function selfSigned() {
  if (certs) return certs;
  const dir = tempDir('atomix-cast-cert-');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=fake-chromecast', '-days', '1'], { stdio: 'ignore' });
  certs = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  return certs;
}

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

/**
 * @param {{ name?: string }} opts
 * @returns {Promise<{ host, port, messages, state, tick(s), finish(), failNextLoad(), takeOver(), drop(), pingClient(), close() }>}
 */
export async function fakeChromecast({ name = 'Living room TV', port: listenPort = 0 } = {}) {
  const sockets = new Set();
  const messages = []; // { namespace, payload, destinationId }
  const state = {
    name,
    app: null, // { appId, sessionId, transportId }
    volume: { level: 0.5, muted: false },
    media: null, // { mediaSessionId, playerState, currentTime, media, activeTrackIds, idleReason }
    failNext: false,
    pongs: 0,
  };
  const send = (sock, namespace, payload, { sourceId = 'receiver-0', destinationId = '*' } = {}) =>
    sock.write(encodeCastMessage({ sourceId, destinationId, namespace, payload: JSON.stringify(payload) }));
  const broadcast = (namespace, payload, sourceId) => { for (const s of sockets) send(s, namespace, payload, { sourceId }); };
  const receiverStatus = (requestId = 0) => ({ type: 'RECEIVER_STATUS', requestId, status: { applications: state.app ? [{ ...state.app, displayName: state.app.appId === 'CC1AD845' ? 'Default Media Receiver' : 'YouTube', namespaces: [{ name: NS.media }] }] : [], volume: state.volume } });
  const mediaStatus = (requestId = 0) => ({ type: 'MEDIA_STATUS', requestId, status: state.media ? [{ mediaSessionId: state.media.mediaSessionId, playerState: state.media.playerState, currentTime: state.media.currentTime, idleReason: state.media.idleReason, activeTrackIds: state.media.activeTrackIds, media: state.media.media, volume: state.volume }] : [] });

  const server = tls.createServer({ ...selfSigned() }, (sock) => {
    sockets.add(sock);
    const reader = new FrameReader();
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      for (const m of reader.push(chunk)) {
        const payload = JSON.parse(m.payload || '{}');
        messages.push({ namespace: m.namespace, payload, destinationId: m.destinationId, sourceId: m.sourceId });
        if (state.silent) continue; // powered off with the socket still up: nothing answers, not even PING
        const reply = (ns, body) => send(sock, ns, body, { sourceId: m.destinationId, destinationId: m.sourceId });
        if (m.namespace === NS.heartbeat) {
          if (payload.type === 'PING') reply(NS.heartbeat, { type: 'PONG' });
          if (payload.type === 'PONG') state.pongs++;
          continue;
        }
        if (m.namespace === NS.receiver) {
          if (payload.type === 'GET_STATUS') {
            if (state.statusDelay) setTimeout(() => reply(NS.receiver, receiverStatus(payload.requestId)), state.statusDelay);
            else reply(NS.receiver, receiverStatus(payload.requestId));
          }
          if (payload.type === 'LAUNCH') {
            state.app = { appId: payload.appId, sessionId: 'sess-1', transportId: 'web-5' };
            state.media = null;
            reply(NS.receiver, receiverStatus(payload.requestId));
          }
          if (payload.type === 'SET_VOLUME') {
            Object.assign(state.volume, payload.volume);
            reply(NS.receiver, receiverStatus(payload.requestId));
          }
          continue;
        }
        if (m.namespace === NS.media) {
          const t = payload.type;
          if (t === 'LOAD') {
            if (state.failNext) {
              state.failNext = false;
              reply(NS.media, { type: 'LOAD_FAILED', requestId: payload.requestId });
              continue;
            }
            state.media = { mediaSessionId: (state.media?.mediaSessionId || 0) + 1, playerState: payload.autoplay === false ? 'PAUSED' : 'PLAYING', currentTime: payload.currentTime || 0, media: payload.media, activeTrackIds: payload.activeTrackIds || [], idleReason: undefined };
          } else if (!state.media) {
            reply(NS.media, { type: 'INVALID_REQUEST', requestId: payload.requestId, reason: 'INVALID_MEDIA_SESSION_ID' });
            continue;
          } else if (t === 'PLAY') state.media.playerState = 'PLAYING';
          else if (t === 'PAUSE') state.media.playerState = 'PAUSED';
          else if (t === 'SEEK') state.media.currentTime = payload.currentTime;
          else if (t === 'STOP') Object.assign(state.media, { playerState: 'IDLE', idleReason: 'CANCELLED' });
          else if (t === 'EDIT_TRACKS_INFO') state.media.activeTrackIds = payload.activeTrackIds || [];
          if (t === 'STOP' && state.stopDelay) setTimeout(() => reply(NS.media, mediaStatus(payload.requestId)), state.stopDelay);
          else reply(NS.media, mediaStatus(payload.requestId));
        }
      }
    });
  });
  await new Promise((r) => server.listen(listenPort, '127.0.0.1', r));
  const { port } = server.address();
  return {
    host: '127.0.0.1',
    port,
    messages,
    state,
    /** The device plays on: currentTime moves by `s` seconds and a status goes out. */
    tick(s = 1) {
      if (state.media?.playerState === 'PLAYING') state.media.currentTime += s;
      broadcast(NS.media, mediaStatus(), state.app?.transportId);
    },
    finish() {
      if (state.media) Object.assign(state.media, { playerState: 'IDLE', idleReason: 'FINISHED' });
      broadcast(NS.media, mediaStatus(), state.app?.transportId);
    },
    failNextLoad() { state.failNext = true; },
    takeOver() {
      state.app = { appId: '233637DE', sessionId: 'yt', transportId: 'web-9' };
      state.media = null;
      broadcast(NS.receiver, receiverStatus());
    },
    drop() { for (const s of sockets) s.destroy(); },
    /** Connections Atomix still has open to this device. */
    openSockets: () => sockets.size,
    pingClient() { for (const s of sockets) send(s, NS.heartbeat, { type: 'PING' }); },
    sent: (type) => messages.filter((m) => m.payload.type === type),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

// ---- A pretend DLNA renderer -------------------------------------------------------------------------------------

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const exml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hms = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/**
 * A UPnP MediaRenderer over http. `calls` records { service, action, args }; the test moves its clock with tick().
 * @param {{ sink?: string[], urlBase?: boolean, relativeControl?: boolean, name?: string }} opts
 */
export async function fakeDlna({ sink = ['http-get:*:video/mp4:*', 'http-get:*:audio/mpeg:*'], urlBase = false, relativeControl = false, name = 'Samsung TV', port: listenPort = 0 } = {}) {
  const http = await import('node:http');
  const calls = [];
  const state = { uri: '', meta: '', transport: 'NO_MEDIA_PRESENT', position: 0, duration: 0, volume: 50, rejectMeta: false, noSeek: false };
  const ctl = (svc) => (relativeControl ? `ctl/${svc}` : `/upnp/ctl/${svc}`);
  const fault = (res, code) => {
    res.writeHead(500, { 'content-type': 'text/xml; charset="utf-8"' });
    res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>err</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
  };
  const answer = (res, service, action, out = {}) => {
    res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
    const body = Object.entries(out).map(([k, v]) => `<${k}>${exml(v)}</${k}>`).join('');
    res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}Response></s:Body></s:Envelope>`);
  };
  let base = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/dev/desc.xml') {
        res.writeHead(200, { 'content-type': 'text/xml' });
        const svc = (type, id) => `<service><serviceType>urn:schemas-upnp-org:service:${type}:1</serviceType><serviceId>urn:upnp-org:serviceId:${type}</serviceId><controlURL>${ctl(id)}</controlURL><eventSubURL>/evt/${id}</eventSubURL><SCPDURL>/scpd/${id}.xml</SCPDURL></service>`;
        return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>${urlBase ? `<URLBase>${base}/base/</URLBase>` : ''}<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${exml(name)}</friendlyName><modelName>UE55</modelName><UDN>uuid:fake-dlna-1</UDN><serviceList>${svc('AVTransport', 'av')}${svc('RenderingControl', 'rc')}${svc('ConnectionManager', 'cm')}</serviceList></device></root>`);
      }
      const m = /#(\w+)"?$/.exec(req.headers.soapaction || '');
      const service = /service:(\w+):/.exec(req.headers.soapaction || '')?.[1];
      if (req.method !== 'POST' || !m) { res.writeHead(404); return res.end(); }
      const action = m[1];
      const inner = new RegExp(`<u:${action}[^>]*>([\\s\\S]*)</u:${action}>`).exec(raw)?.[1] || '';
      const args = {};
      for (const [, k, v] of inner.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) args[k] = unxml(v);
      calls.push({ service, action, args, path: req.url });
      if (action === 'SetAVTransportURI') {
        if (state.rejectMeta && args.CurrentURIMetaData) { state.rejectMeta = false; return fault(res, 714); }
        if (state.failLoads > 0) { state.failLoads--; return fault(res, 716); }
        Object.assign(state, { uri: args.CurrentURI, meta: args.CurrentURIMetaData, transport: 'STOPPED', position: 0, duration: 7020 });
        return answer(res, service, action);
      }
      if (action === 'Play') { if (!state.refusePlay) state.transport = 'PLAYING'; return answer(res, service, action); }
      if (action === 'Pause') { state.transport = 'PAUSED_PLAYBACK'; return answer(res, service, action); }
      if (action === 'Stop') { state.transport = 'STOPPED'; state.position = 0; return answer(res, service, action); }
      if (action === 'Seek') {
        if (state.noSeek) return fault(res, 710);
        const [h, mi, s] = args.Target.split(':').map(Number);
        state.position = h * 3600 + mi * 60 + s;
        return answer(res, service, action);
      }
      if (action === 'GetPositionInfo') return answer(res, service, action, { Track: 1, TrackDuration: hms(state.duration), TrackURI: state.uri, RelTime: hms(state.position), AbsTime: 'NOT_IMPLEMENTED' });
      if (action === 'GetTransportInfo') return answer(res, service, action, { CurrentTransportState: state.transport, CurrentTransportStatus: 'OK', CurrentSpeed: 1 });
      if (action === 'GetMediaInfo') {
        const uri = state.uri; // what was loaded when the question arrived
        if (state.mediaDelay) return setTimeout(() => answer(res, service, action, { NrTracks: 1, CurrentURI: uri }), state.mediaDelay);
        return answer(res, service, action, { NrTracks: 1, CurrentURI: uri });
      }
      if (action === 'SetVolume') { state.volume = Number(args.DesiredVolume); return answer(res, service, action); }
      if (action === 'GetVolume') return answer(res, service, action, { CurrentVolume: state.volume });
      if (action === 'GetProtocolInfo') return answer(res, service, action, { Source: '', Sink: sink.join(',') });
      return fault(res, 401);
    });
  });
  await new Promise((r) => server.listen(listenPort, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    location: `${base}/dev/desc.xml`,
    base,
    calls,
    state,
    called: (action) => calls.filter((c) => c.action === action),
    tick(s = 1) { if (state.transport === 'PLAYING') state.position += s; },
    finish() { state.transport = 'STOPPED'; state.position = 0; },
    takeOver() { state.uri = 'http://192.168.1.50/other.mp4'; state.transport = 'PLAYING'; },
    rejectMetadataOnce() { state.rejectMeta = true; },
    noSeek() { state.noSeek = true; },
    /** The TV takes the URL but never plays it (it can't fetch it). */
    refuseToPlay() { state.refusePlay = true; },
    /** The next n SetAVTransportURI calls fault (the TV can't take the URL). */
    failLoads(n) { state.failLoads = n; },
    /** Stop pressed on the TV's own remote: STOPPED, position back to 0 (as TVs report it). */
    stopOnTv() { state.transport = 'STOPPED'; state.position = 0; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
