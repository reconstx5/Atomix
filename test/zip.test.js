// The ZIP reader (v0.22 books and comics): stored and deflated entries, ZIP64, damaged archives and the limits that
// keep a hostile archive (a bomb, odd names) from doing harm. The archives are built here, byte by byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { tempDir } from './helpers.js';
import { readZipIndex, readEntry, ZipError, ZIP_LIMITS } from '../public/js/reader/zip.js';
import { openZip } from '../src/books/zip.js';
import { writeStoredZip } from '../src/books/zip-write.js';

const dir = tempDir();
const u16 = (n) => Buffer.from([n & 255, (n >>> 8) & 255]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * A ZIP archive. entries: { name, data, deflate?, claimSize?, claimPacked? } — the claims lie about the sizes (a bomb).
 * zip64: write the sizes and offsets in ZIP64 extras and end records.
 */
export function buildZip(entries, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const packed = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(raw);
    const size = e.claimSize ?? raw.length;
    const psize = e.claimPacked ?? packed.length;
    const local = Buffer.concat([u32(0x04034b50), u16(45), u16(0x800), u16(e.deflate ? 8 : 0), u16(0), u16(0), u32(crc), u32(zip64 ? 0xffffffff : psize), u32(zip64 ? 0xffffffff : size), u16(name.length), u16(zip64 ? 20 : 0), name, zip64 ? Buffer.concat([u16(1), u16(16), u64(size), u64(psize)]) : Buffer.alloc(0)]);
    const extra = zip64 ? Buffer.concat([u16(1), u16(24), u64(size), u64(psize), u64(offset)]) : Buffer.alloc(0);
    central.push(Buffer.concat([u32(0x02014b50), u16(45), u16(45), u16(0x800), u16(e.deflate ? 8 : 0), u16(0), u16(0), u32(crc), u32(zip64 ? 0xffffffff : psize), u32(zip64 ? 0xffffffff : size), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(zip64 ? 0xffffffff : offset), name, extra]));
    parts.push(local, packed);
    offset += local.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const rec = Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(entries.length), u64(entries.length), u64(cd.length), u64(offset)]);
    tail.push(rec, Buffer.concat([u32(0x07064b50), u32(0), u64(offset + cd.length), u32(1)]));
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff), u16(0)]));
  } else {
    tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]));
  }
  return Buffer.concat([...parts, cd, ...tail]);
}

const reader = (buf) => async (offset, length) => new Uint8Array(buf.subarray(offset, offset + length));
const inflate = async (bytes, max) => new Uint8Array(zlib.inflateRawSync(bytes, { maxOutputLength: Math.max(1, max) }));
const text = (u8) => Buffer.from(u8).toString();
const prose = Array.from({ length: 700 }, (_, i) => `word${(i * 7919) % 1013}`).join(' '); // compresses like a book, not 100×
const refusal = (message) => (err) => err instanceof ZipError && err.message === message;
const DAMAGED = "This file is damaged or isn't a ZIP archive.";
const TOO_LARGE = 'A file in this archive is too large to open.';
const BAD_NAME = "This archive has a file name Atomix won't open.";

test('reads stored and deflated entries', async () => {
  const buf = buildZip([{ name: 'a.txt', data: 'stored text' }, { name: 'dir/b.xhtml', data: prose, deflate: true }, { name: 'dir/', data: '' }]);
  const idx = await readZipIndex(reader(buf), buf.length);
  assert.deepEqual([...idx.keys()], ['a.txt', 'dir/b.xhtml'], 'folders are not entries');
  assert.equal(text(await readEntry(reader(buf), idx.get('a.txt'), inflate)), 'stored text');
  assert.equal(text(await readEntry(reader(buf), idx.get('dir/b.xhtml'), inflate)), prose);
  const file = path.join(dir, 'plain.zip');
  fs.writeFileSync(file, buf);
  const z = await openZip(file);
  assert.equal((await z.read('dir/b.xhtml')).toString(), prose);
  assert.equal(await z.read('missing.txt'), null);
  await z.close();
});

test('reads a ZIP64 archive', async () => {
  const buf = buildZip([{ name: 'one.jpg', data: 'pic one' }, { name: 'two.jpg', data: 'pic two two', deflate: true }], { zip64: true });
  const idx = await readZipIndex(reader(buf), buf.length);
  assert.equal(idx.get('two.jpg').size, 11);
  assert.equal(text(await readEntry(reader(buf), idx.get('two.jpg'), inflate)), 'pic two two');
});

test('refuses a damaged archive with a sentence', async () => {
  const buf = buildZip([{ name: 'a.txt', data: 'hello' }]);
  await assert.rejects(readZipIndex(reader(buf.subarray(0, 20)), 20), refusal(DAMAGED));
  await assert.rejects(readZipIndex(reader(Buffer.from('not a zip at all, just text')), 27), refusal(DAMAGED));
  const bent = Buffer.from(buf);
  bent.writeUInt32LE(0x99999999, 0); // the local header's signature
  const idx = await readZipIndex(reader(bent), bent.length);
  await assert.rejects(readEntry(reader(bent), idx.get('a.txt'), inflate), refusal(DAMAGED));
  const file = path.join(dir, 'damaged.epub');
  fs.writeFileSync(file, buf.subarray(0, buf.length - 10));
  await assert.rejects(openZip(file), refusal(DAMAGED));
});

test('refuses a bomb before inflating', async () => {
  let inflated = 0;
  const counting = async (b, m) => ((inflated += 1), inflate(b, m));
  const huge = buildZip([{ name: 'bomb.xml', data: 'x'.repeat(1000), deflate: true, claimSize: 1024 ** 3 }]);
  let idx = await readZipIndex(reader(huge), huge.length);
  await assert.rejects(readEntry(reader(huge), idx.get('bomb.xml'), counting), refusal(TOO_LARGE));
  const ratio = buildZip([{ name: 'r.xml', data: 'y'.repeat(10100), deflate: true }]);
  idx = await readZipIndex(reader(ratio), ratio.length);
  const packed = idx.get('r.xml').packed;
  assert.ok(10100 > packed * ZIP_LIMITS.ratio, `the test needs more than ${ZIP_LIMITS.ratio}× (packed ${packed})`);
  await assert.rejects(readEntry(reader(ratio), idx.get('r.xml'), counting), refusal(TOO_LARGE));
  assert.equal(inflated, 0, 'nothing was inflated');
  // A size that lies small: the inflater stops at the claimed size.
  const liar = buildZip([{ name: 'l.txt', data: 'z'.repeat(400), deflate: true, claimSize: 50 }]);
  idx = await readZipIndex(reader(liar), liar.length);
  await assert.rejects(readEntry(reader(liar), idx.get('l.txt'), inflate), (e) => e instanceof ZipError);
});

test('refuses more than 5,000 entries', async () => {
  const many = buildZip(Array.from({ length: 5001 }, (_, i) => ({ name: `p${i}.jpg`, data: '' })));
  await assert.rejects(readZipIndex(reader(many), many.length), refusal('This archive has more than 5,000 files.'));
  const ok = buildZip(Array.from({ length: 5000 }, (_, i) => ({ name: `p${i}.jpg`, data: '' })));
  assert.equal((await readZipIndex(reader(ok), ok.length)).size, 5000);
});

test('refuses ../, absolute and duplicate names', async () => {
  for (const names of [['../evil.txt'], ['a/../../evil.txt'], ['/etc/passwd'], ['C:/x.txt'], ['ok\\..\\..\\x'], ['a.txt', 'a.txt'], ['nul\u0000.txt']]) {
    const buf = buildZip(names.map((name) => ({ name, data: 'x' })));
    await assert.rejects(readZipIndex(reader(buf), buf.length), refusal(BAD_NAME), names.join(','));
  }
});

test('writeStoredZip round-trips through openZip', async () => {
  const page = path.join(dir, 'page.jpg');
  fs.writeFileSync(page, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  const out = path.join(dir, 'packed.cbz');
  await writeStoredZip(out, [{ name: '001.jpg', file: page }, { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') }, { name: 'é.txt', data: Buffer.from('accent') }]);
  const z = await openZip(out);
  assert.deepEqual([...z.entries.keys()], ['001.jpg', 'ComicInfo.xml', 'é.txt']);
  assert.deepEqual([...(await z.read('001.jpg'))], [0xff, 0xd8, 0xff, 1, 2, 3]);
  assert.equal((await z.read('é.txt')).toString(), 'accent');
  assert.equal(z.entries.get('001.jpg').method, 0, 'stored');
  await z.close();
});

test('refuses an entry whose packed size runs past the archive (it would have to be read in one go)', async () => {
  for (const zip64 of [false, true]) {
    const buf = buildZip([{ name: 'big.xml', data: 'tiny', claimPacked: 0xfffffff0, claimSize: 10 }], { zip64 });
    await assert.rejects(readZipIndex(reader(buf), buf.length), refusal(DAMAGED), `zip64: ${zip64}`);
    const file = path.join(dir, `packed-lie-${zip64}.cbz`);
    fs.writeFileSync(file, buf);
    await assert.rejects(openZip(file), refusal(DAMAGED));
  }
  // A packed size that fits the file but runs past it from the entry's own start.
  const buf = buildZip([{ name: 'a.txt', data: 'hello world' }, { name: 'b.txt', data: 'x', claimPacked: 60 }]);
  await assert.rejects(readZipIndex(reader(buf), buf.length), refusal(DAMAGED));
});
