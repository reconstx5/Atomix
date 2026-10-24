// Reading ZIP archives (v0.22 books and comics): EPUB, CBZ, and comics packed for Downloads. No imports, so the same
// file runs on the server (inflating with zlib), in a page and in the offline helper (with DecompressionStream) —
// /sw.js joins it into one classic script, so each export starts its line. Only the central directory and the one
// entry asked for are read. A hostile archive is refused with a sentence: more than 5,000 files, an entry over 50 MB
// or inflating past 100× its packed size, a name that climbs out (`..`, absolute) or appears twice.

export const ZIP_LIMITS = { entryBytes: 52428800, ratio: 100, entries: 5000 };

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

const DAMAGED = "This file is damaged or isn't a ZIP archive.";
const TOO_MANY = 'This archive has more than 5,000 files.';
const TOO_LARGE = 'A file in this archive is too large to open.';
const METHOD = "This archive uses a kind of compression Atomix can't read.";
const BAD_NAME = "This archive has a file name Atomix won't open.";

const SIG_EOCD = 0x06054b50;
const SIG_LOC64 = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_COMMENT = 65535;

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const u64 = (dv, at) => {
  const n = dv.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(DAMAGED);
  return Number(n);
};

async function readExactly(read, offset, length) {
  if (offset < 0 || length < 0) throw new ZipError(DAMAGED);
  const got = await read(offset, length);
  if (!got || got.length !== length) throw new ZipError(DAMAGED);
  return got;
}

/** A name that stays inside the archive: not absolute, no `..` segment, no NUL or drive letter. */
function safeName(name) {
  if (!name || name.includes('\u0000') || /^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((part) => part === '..');
}

/**
 * The archive's entries by name (folders left out).
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read
 * @param {number} size the archive's length in bytes
 * @returns {Promise<Map<string, {name: string, method: number, flags: number, packed: number, size: number, offset: number, crc: number}>>}
 */
export async function readZipIndex(read, size, limits = ZIP_LIMITS) {
  if (!(size >= 22)) throw new ZipError(DAMAGED);
  const tailLen = Math.min(size, 22 + MAX_COMMENT);
  const tail = await readExactly(read, size - tailLen, tailLen);
  const tv = view(tail);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipError(DAMAGED);
  let count = tv.getUint16(at + 10, true);
  let cdSize = tv.getUint32(at + 12, true);
  let cdOffset = tv.getUint32(at + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator sits just before the end record and points at the ZIP64 end record.
    const locAt = size - tailLen + at - 20;
    if (locAt < 0) throw new ZipError(DAMAGED);
    const loc = view(await readExactly(read, locAt, 20));
    if (loc.getUint32(0, true) !== SIG_LOC64) throw new ZipError(DAMAGED);
    const recAt = u64(loc, 8);
    if (recAt + 56 > size) throw new ZipError(DAMAGED);
    const rec = view(await readExactly(read, recAt, 56));
    if (rec.getUint32(0, true) !== SIG_EOCD64) throw new ZipError(DAMAGED);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (count > limits.entries) throw new ZipError(TOO_MANY);
  if (cdOffset + cdSize > size || cdSize < count * 46) throw new ZipError(DAMAGED);
  const cd = await readExactly(read, cdOffset, cdSize);
  const dv = view(cd);
  const decoder = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError(DAMAGED);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let packed = dv.getUint32(p + 20, true);
    let length = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipError(DAMAGED);
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra: only the fields that were 0xFFFFFFFF, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        const take = () => {
          if (q + 8 > x + 4 + len) throw new ZipError(DAMAGED);
          const v = u64(dv, q);
          q += 8;
          return v;
        };
        if (length === 0xffffffff) length = take();
        if (packed === 0xffffffff) packed = take();
        if (offset === 0xffffffff) offset = take();
      }
      x += 4 + len;
    }
    p = end;
    if (!safeName(name)) throw new ZipError(BAD_NAME);
    if (name.endsWith('/')) continue; // a folder
    if (entries.has(name)) throw new ZipError(BAD_NAME);
    // Its data must end before the central directory: a packed size that runs past it is a lie (and reading it would
    // mean holding gigabytes at once).
    if (offset + 30 + packed > cdOffset) throw new ZipError(DAMAGED);
    entries.set(name, { name, method, flags, packed, size: length, offset, crc });
  }
  return entries;
}

/**
 * One entry's bytes. `inflate(bytes, maxOutput)` is the platform's raw-deflate decompressor; it must stop at maxOutput.
 * @returns {Promise<Uint8Array>}
 */
export async function readEntry(read, entry, inflate, limits = ZIP_LIMITS) {
  if (entry.flags & 1) throw new ZipError(METHOD); // encrypted
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(METHOD);
  if (entry.size > limits.entryBytes || entry.size > Math.max(entry.packed, 1) * limits.ratio) throw new ZipError(TOO_LARGE);
  const head = view(await readExactly(read, entry.offset, 30));
  if (head.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(DAMAGED);
  const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = await readExactly(read, start, entry.packed);
  if (entry.method === 0) {
    if (entry.packed !== entry.size) throw new ZipError(DAMAGED);
    return data;
  }
  let out;
  try {
    out = await inflate(data, entry.size);
  } catch (err) {
    throw err instanceof ZipError ? err : new ZipError(DAMAGED);
  }
  if (!out || out.length !== entry.size) throw new ZipError(DAMAGED);
  return out;
}

/** Raw-deflate with DecompressionStream (pages and the offline helper), stopping past `max` bytes. */
export async function inflateStream(bytes, max) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(max);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) {
      await reader.cancel().catch(() => {});
      throw new ZipError(DAMAGED);
    }
    out.set(value, n);
    n += value.length;
  }
  return out.subarray(0, n);
}

/** A ZIP held in a Blob (a download on this device): { entries, read(name) → Uint8Array|null }. */
export async function openZipBlob(blob, limits = ZIP_LIMITS) {
  const read = async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  const entries = await readZipIndex(read, blob.size, limits);
  return {
    entries,
    read: async (name) => (entries.has(name) ? readEntry(read, entries.get(name), inflateStream, limits) : null),
  };
}
