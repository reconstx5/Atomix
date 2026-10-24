// The image cache and servers that label pictures badly (a CDN sending PNG logos as application/octet-stream), and
// addresses that keep failing (asked once, not on every page draw).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { tempDir } from './helpers.js';
import { ImageCache } from '../src/library/images.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);

async function serve(handler) {
  const hits = {};
  const srv = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    handler(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, hits, close: () => srv.close() };
}

test('a picture sent as application/octet-stream is kept when its bytes are an image (PNG, JPEG)', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': req.url.includes('binary') ? 'binary/octet-stream' : 'application/octet-stream' });
    res.end(req.url.includes('jpg') ? JPEG : PNG);
  });
  try {
    const cache = new ImageCache({ imagesDir: tempDir() });
    const png = await cache.download(`${s.base}/thumbnails/1744244355255.png`);
    assert.match(png || '', /^cache:[0-9a-f]+\.png$/);
    assert.deepEqual(fs.readFileSync(cache.resolve(png).file), PNG);
    assert.match((await cache.download(`${s.base}/logo-binary`)) || '', /\.png$/, 'named by what it is, not the address');
    assert.match((await cache.download(`${s.base}/x.jpg`)) || '', /\.jpg$/);
  } finally {
    s.close();
  }
});

test('octet-stream that isn\'t an image, and text/html, are still refused', async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { 'content-type': req.url === '/page' ? 'text/html' : 'application/octet-stream' });
    res.end(req.url === '/page' ? PNG : Buffer.from('#EXTM3U\nnot a picture'));
  });
  try {
    const dir = tempDir();
    const cache = new ImageCache({ imagesDir: dir });
    assert.equal(await cache.download(`${s.base}/data.png`), null);
    assert.equal(await cache.download(`${s.base}/page`), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    s.close();
  }
});

test('an address that failed isn\'t asked again (or logged again) for an hour', async () => {
  const s = await serve((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    let t = 1_000_000;
    const cache = new ImageCache({ imagesDir: tempDir(), now: () => t });
    const url = `${s.base}/gone.png`;
    for (let i = 0; i < 5; i++) assert.equal(await cache.download(url), null);
    assert.equal(s.hits['/gone.png'], 1, 'one request, not five');
    t += 61 * 60_000;
    await cache.download(url);
    assert.equal(s.hits['/gone.png'], 2, 'tried again after the hour');
  } finally {
    s.close();
  }
});

// ---- v0.21 review fix ----
test('AVIF, BMP and ICO pictures are pictures too', async () => {
  const { sniffImage } = await import('../src/library/images.js');
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(16)]);
  assert.equal(sniffImage(avif), 'image/avif');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)])), 'image/bmp');
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)])), 'image/x-icon');
  assert.equal(sniffImage(Buffer.from('<html>no</html>')), null);
});
