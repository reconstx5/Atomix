// A Cast v2 channel: TLS to a Chromecast on port 8009 (self-signed certificates — local devices only), framed
// CastMessages, request ids with replies, and the heartbeat.
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { encodeCastMessage, FrameReader } from './protobuf.js';

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

export class CastChannel extends EventEmitter {
  /** @param {{ pingMs?: number, deadMs?: number }} opts  dead: nothing at all heard back for that long */
  constructor(socket, { pingMs = 5000, deadMs = 15000 } = {}) {
    super();
    this.lastHeard = Date.now();
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map(); // requestId → { resolve, reject, timer }
    this.reader = new FrameReader();
    this.closed = false;
    socket.on('data', (chunk) => {
      this.lastHeard = Date.now();
      let msgs;
      try {
        msgs = this.reader.push(chunk);
      } catch (err) {
        return this.destroy(err);
      }
      for (const m of msgs) this.onMessage(m);
    });
    socket.on('close', () => this.destroy());
    socket.on('error', (err) => this.destroy(err));
    socket.setKeepAlive?.(true, 5000);
    // A TV that loses power keeps the socket "open" for minutes: no answer to our PINGs means it is gone.
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastHeard > deadMs) return this.destroy(Object.assign(new Error('The device stopped answering'), { code: 'ETIMEDOUT' }));
      this.send(NS.heartbeat, { type: 'PING' });
    }, pingMs);
    this.heartbeat.unref?.();
  }
  /** @returns {Promise<CastChannel>} */
  static connect({ host, port = 8009, timeoutMs = 5000, pingMs, deadMs }) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: undefined });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error(`No answer from ${host}:${port}`), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(new CastChannel(socket, { pingMs, deadMs }));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  onMessage(m) {
    let payload;
    try {
      payload = JSON.parse(m.payload || '{}');
    } catch {
      return;
    }
    if (m.namespace === NS.heartbeat) {
      if (payload.type === 'PING') this.send(NS.heartbeat, { type: 'PONG' }, { destinationId: m.sourceId, sourceId: m.destinationId });
      return;
    }
    const p = payload.requestId && this.pending.get(payload.requestId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(payload.requestId);
      p.resolve(payload);
    }
    this.emit('message', { namespace: m.namespace, sourceId: m.sourceId, destinationId: m.destinationId, payload });
  }
  send(namespace, payload, { destinationId = 'receiver-0', sourceId = 'sender-0' } = {}) {
    if (this.closed) return;
    this.socket.write(encodeCastMessage({ sourceId, destinationId, namespace, payload: JSON.stringify(payload) }));
  }
  /** Send with a requestId and wait for the reply carrying it. */
  request(namespace, payload, opts = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('The cast connection is closed'), { code: 'ECONNRESET' }));
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error('The device did not answer'), { code: 'ETIMEDOUT' }));
      }, opts.timeoutMs ?? 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(namespace, { ...payload, requestId }, opts);
    });
  }
  destroy(err) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('The cast connection closed'), { code: 'ECONNRESET' }));
    }
    this.pending.clear();
    this.socket.destroy();
    this.emit('close', err);
  }
}
