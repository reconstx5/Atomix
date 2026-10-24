// Writing a stored (uncompressed) ZIP (v0.22): a comic from a CBR, a CB7 or a folder of pictures, packed as a CBZ for
// Downloads. Pictures don't shrink when deflated, so nothing is compressed. Names are UTF-8; no ZIP64 (a comic over
// 4 GB is refused).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ZipError } from '../../public/js/reader/zip.js';

const LIMIT = 0xfffffffe;
const u16 = (n) => Buffer.from([n & 255, (n >>> 8) & 255]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/**
 * @param {string} outFile
 * @param {{ name: string, file?: string, data?: Buffer }[]} files
 */
export async function writeStoredZip(outFile, files) {
  const fh = await fs.promises.open(outFile, 'w');
  try {
    let offset = 0;
    const central = [];
    const put = async (buf) => {
      await fh.write(buf);
      offset += buf.length;
    };
    for (const f of files) {
      const data = f.data ?? (await fs.promises.readFile(f.file));
      const name = Buffer.from(f.name);
      if (offset + data.length + 30 + name.length > LIMIT) throw new ZipError('A file in this archive is too large to open.');
      const crc = zlib.crc32(data);
      const at = offset;
      await put(Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]));
      await put(data);
      central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(at), name]));
    }
    const cd = Buffer.concat(central);
    const cdAt = offset;
    await put(cd);
    await put(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(cdAt), u16(0)]));
  } finally {
    await fh.close();
  }
}
