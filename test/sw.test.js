// The offline helper (v0.21): byte ranges from stored files, and the list of files the app needs to start offline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rangeResponse } from '../public/js/offline/range.js';
import { startAtomix, client } from './helpers.js';

const blob = new Blob([new Uint8Array(1000).map((_, i) => i % 251)]);

test('a range from a stored file', async () => {
  let r = rangeResponse(blob, 'bytes=100-199', 'video/webm');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
  const got = new Uint8Array(await r.arrayBuffer());
  assert.equal(got.length, 100);
  assert.equal(got[0], 100);
  r = rangeResponse(blob, 'bytes=900-', 'video/webm');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.equal(rangeResponse(blob, 'bytes=1000-', 'video/webm').status, 416);
  r = rangeResponse(blob, null, 'video/webm');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), '1000');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
});

let nf;
let anon;
before(async () => {
  nf = await startAtomix();
  anon = client(nf.base);
});
after(async () => {
  await nf?.app.stop();
});

test('the shell list: everything the app needs to start, nothing else, and a version that follows the files', async () => {
  const s = (await anon.get('/api/shell')).data;
  for (const f of ['/', '/index.html', '/js/app.js', '/css/app.css', '/css/orbit.css', '/manifest.webmanifest', '/img/icon-192.png']) assert.ok(s.files.includes(f), f);
  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const modules = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) modules.push('/' + path.relative(pub, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(pub, 'js'));
  for (const m of modules.filter((x) => x !== '/js/offline/worker.js')) assert.ok(s.files.includes(m), m);
  assert.ok(!s.files.includes('/sw.js') && !s.files.includes('/js/offline/worker.js'), 'the worker itself is not in its cache');
  assert.ok(s.files.every((f) => f.startsWith('/') && !f.includes('..')));
  const v1 = s.version;
  const file = path.join(pub, 'js', 'vtt.js');
  const t = fs.statSync(file).mtime;
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const v2 = (await anon.get('/api/shell')).data.version;
  fs.utimesSync(file, t, t);
  assert.notEqual(v1, v2);
});

test('/sw.js is one classic script with the range helper in it', async () => {
  const r = await anon.raw('/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  const text = await r.text();
  assert.match(text, /^\/\/ A stored file answered/);
  assert.doesNotMatch(text, /^\s*(import|export) /m);
  assert.match(text, /function rangeResponse/);
});

test('the shell lists only what /themes/ serves', async () => {
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'atomix-themes-'));
  fs.mkdirSync(path.join(dir, 'neon'));
  for (const f of ['theme.json', 'style.css', 'bg.webp', 'tool.js', 'face.ttf', 'notes.html']) fs.writeFileSync(path.join(dir, 'neon', f), 'x');
  const other = await startAtomix({}, { themesDir: dir });
  try {
    const files = (await client(other.base).get('/api/shell')).data.files.filter((f) => f.startsWith('/themes/'));
    assert.deepEqual(files.sort(), ['/themes/neon/bg.webp', '/themes/neon/style.css', '/themes/neon/theme.json']);
    for (const f of files) assert.equal((await client(other.base).raw(f)).status, 200, f);
  } finally {
    await other.app.stop();
  }
});

/** The offline helper's fetch handler, run with a stand-in for the worker's globals and a stored file. */
async function workerFetch(request, stored = new Blob(['abcdefghij'], { type: 'audio/mpeg' })) {
  const vm = await import('node:vm');
  const text = await (await anon.raw('/sw.js')).text();
  const handlers = {};
  const dirHandle = { getDirectoryHandle: async () => dirHandle, getFileHandle: async () => ({ getFile: async () => stored }) };
  const ctx = { self: { location: { href: 'http://x/sw.js?v=t', origin: 'http://x' }, addEventListener: (n, f) => (handlers[n] = f) }, navigator: { storage: { getDirectory: async () => dirHandle } }, caches: { open: async () => ({ match: async () => null }) }, fetch: async () => new Response('net'), Response, Request, Blob, URL, Headers, decodeURIComponent, encodeURIComponent, DataView, TextDecoder, DecompressionStream, Uint8Array, Map, Error, BigInt, Number, Math, String };
  vm.runInNewContext(text, ctx);
  let answered = null;
  handlers.fetch({ request: { url: request.url, method: 'GET', mode: request.mode, destination: request.destination || '', headers: new Headers(request.headers || {}) }, respondWith: (p) => (answered = p) });
  return answered && (await answered);
}

test('a typed address under /offline/ is refused; the player\'s own fetches still get the file', async () => {
  const typed = await workerFetch({ url: 'http://x/offline/1/7.mp3', mode: 'navigate' });
  assert.equal(typed.status, 404);
  const player = await workerFetch({ url: 'http://x/offline/1/7.mp3', mode: 'no-cors', headers: { range: 'bytes=0-3' } });
  assert.equal(player.status, 206);
  assert.equal(await player.text(), 'abcd');
});

test("a downloaded book's chapter is served from its ZIP with the reader's policy; a typed address is refused, the reader's frame is not", async () => {
  const { writeStoredZip } = await import('../src/books/zip-write.js');
  const os = await import('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atomix-sw-')), 'b.epub');
  await writeStoredZip(file, [{ name: 'OEBPS/text/ch 1.xhtml', data: Buffer.from('<html><body>Hello offline</body></html>') }, { name: 'OEBPS/p.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 9]) }]);
  const blob = new Blob([fs.readFileSync(file)]);
  const url = 'http://x/offline-zip/1/7.epub/OEBPS/text/ch%201.xhtml';
  const framed = await workerFetch({ url, mode: 'navigate', destination: 'iframe' }, blob);
  assert.equal(framed.status, 200);
  assert.equal(await framed.text(), '<html><body>Hello offline</body></html>');
  assert.match(framed.headers.get('content-type'), /application\/xhtml\+xml/);
  const csp = framed.headers.get('content-security-policy');
  for (const part of ["default-src 'none'", 'img-src http://x/offline-zip/1/7.epub/ data:', "script-src 'none'", 'sandbox allow-same-origin']) assert.ok(csp.includes(part), `${part} in ${csp}`);
  const pic = await workerFetch({ url: 'http://x/offline-zip/1/7.epub/OEBPS/p.jpg', mode: 'no-cors', destination: 'image' }, blob);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
  assert.equal((await workerFetch({ url, mode: 'navigate', destination: 'document' }, blob)).status, 404, 'typed into the address bar');
  assert.equal((await workerFetch({ url: 'http://x/offline-zip/1/7.epub/OEBPS/missing.xhtml', mode: 'navigate', destination: 'iframe' }, blob)).status, 404);
  assert.equal((await workerFetch({ url: 'http://x/offline-zip/1/../7.epub/x', mode: 'no-cors', destination: 'image' }, blob)).status, 404);
});
