// ZIP archives on the server (v0.22): EPUB books and CBZ comics, read with the shared reader (public/js/reader/zip.js)
// and inflated by zlib, which stops at the entry's declared size. The central directories of the last 16 archives
// opened are kept (by path, size and modification time) so turning a page doesn't re-read them.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readZipIndex, readEntry, ZipError, ZIP_LIMITS } from '../../public/js/reader/zip.js';

export { ZipError, ZIP_LIMITS };

const KEEP = 16;
const indexes = new Map(); // "<path>:<size>:<mtime>" → entries (oldest first)

const inflate = async (bytes, max) => {
  try {
    return zlib.inflateRawSync(bytes, { maxOutputLength: Math.max(1, max) });
  } catch {
    throw new ZipError("This file is damaged or isn't a ZIP archive.");
  }
};

/**
 * Open an archive: its entries, and one entry's bytes by name (null when it has no such entry).
 * @returns {Promise<{ entries: Map<string, object>, read(name: string): Promise<Buffer|null>, close(): Promise<void> }>}
 */
export async function openZip(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const st = await fh.stat();
    const read = async (offset, length) => {
      // Never more than the file holds (a hostile length would otherwise be allocated, or abort a read past 2 GB).
      if (!(length >= 0) || offset < 0 || offset + length > st.size || length > 0x7fffffff) throw new ZipError("This file is damaged or isn't a ZIP archive.");
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    };
    const key = `${file}:${st.size}:${st.mtimeMs}`;
    let entries = indexes.get(key);
    if (entries) indexes.delete(key);
    else entries = await readZipIndex(read, st.size);
    indexes.set(key, entries);
    while (indexes.size > KEEP) indexes.delete(indexes.keys().next().value);
    return {
      entries,
      async read(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        return Buffer.from(await readEntry(read, entry, inflate));
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

/** Open, use, close. */
export async function withZip(file, fn) {
  const z = await openZip(file);
  try {
    return await fn(z);
  } finally {
    await z.close().catch(() => {});
  }
}
