// Safari (and every iPhone browser) reuses an idle connection for a while; Node's default closes it after 5 s, and a
// POST sent on it as it closes fails in the browser as "Load failed" (WebKit doesn't retry a POST). The server keeps
// idle connections longer than the browsers do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startAtomix } from './helpers.js';

test('an idle keep-alive connection is still open after 8 s, and a POST on it is answered', { timeout: 30_000 }, async () => {
  const nf = await startAtomix({}, { skipLiveRefresh: true });
  try {
    const { port, hostname } = new URL(nf.base);
    const sock = net.connect(Number(port), hostname);
    await new Promise((r) => sock.once('connect', r));
    let data = '';
    let closed = false;
    sock.on('data', (d) => (data += d));
    sock.on('close', () => (closed = true));
    const send = (body) => sock.write(`POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
    send('{}');
    await new Promise((r) => setTimeout(r, 500));
    assert.match(data, /^HTTP\/1\.1 \d{3}/, 'the first request is answered');
    data = '';
    await new Promise((r) => setTimeout(r, 8000)); // the phone sits on the channel list
    assert.equal(closed, false, 'the server kept the idle connection');
    send('{}');
    await new Promise((r) => setTimeout(r, 500));
    assert.match(data, /^HTTP\/1\.1 \d{3}/, 'the POST on the reused connection is answered');
    sock.destroy();
  } finally {
    await nf.app.stop();
  }
});
