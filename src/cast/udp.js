// The real discovery transport: a UDP socket on each IPv4 interface, so one multicast question goes out on every
// network this machine is on. Answers come back to the socket's own (random) port.
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

/** @returns {{ send(buf, port, address), on(ev, fn), off(ev, fn), close() }} */
export function udpTransport({ interfaces = os.networkInterfaces() } = {}) {
  const t = new EventEmitter();
  const addrs = Object.values(interfaces).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  const sockets = [];
  const ready = [];
  for (const address of addrs.length ? addrs : ['0.0.0.0']) {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => {}); // an interface that will not take a socket is skipped
    s.on('message', (buf, rinfo) => t.emit('message', buf, rinfo));
    ready.push(
      new Promise((resolve) => {
        s.bind({ address, port: 0 }, () => {
          try {
            s.setMulticastTTL(2);
            if (address !== '0.0.0.0') s.setMulticastInterface(address);
          } catch {
            // the multicast settings are best effort
          }
          resolve();
        });
        s.once('error', resolve);
      }),
    );
    sockets.push(s);
  }
  t.send = (buf, port, address) => {
    Promise.all(ready).then(() => {
      for (const s of sockets) {
        try {
          s.send(buf, port, address);
        } catch {
          // closed or never bound
        }
      }
    });
  };
  t.close = () => {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  };
  return t;
}
