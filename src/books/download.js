// A book or comic for Downloads (v0.22): the whole file. An EPUB and a CBZ go as they are; a CBR, a CB7 or a folder
// of pictures is packed into a CBZ (stored, not compressed), so a device only ever reads ZIP files.
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../db.js';
import { writeStoredZip } from './zip-write.js';
import { archiveList, archiveExtractAll } from './archive-tool.js';

/** What a book or comic downloads as: 'epub' or 'cbz'. */
export const readingFormat = (kind) => (kind === 'book' ? 'epub' : 'cbz');

/**
 * Write the download copy of `item` to `out`.
 * @param {{ tool?: object, tmpRoot?: string }} opts the archive tool (for .cbr and .cb7) and where it may unpack
 */
export async function prepareReading(item, out, { tool = null, tmpRoot = path.dirname(out) } = {}) {
  const m = parseJson(item.media, {}) || {};
  if (item.kind === 'book' || m.format === 'cbz') {
    await fs.promises.copyFile(item.path, out);
    return;
  }
  const pages = m.pages || [];
  if (m.format === 'folder') {
    await writeStoredZip(out, pages.map((name) => ({ name, file: path.join(item.path, path.basename(name)) })));
    return;
  }
  // A CBR or CB7: unpacked once into a fresh folder of the cache, then packed page by page from there (never the
  // whole comic in memory), the folder removed after. Only names from the archive's own list, inside that folder.
  const list = await archiveList(tool, item.path);
  const tmp = await fs.promises.mkdtemp(path.join(tmpRoot, 'pack-'));
  try {
    await archiveExtractAll(tool, item.path, tmp);
    const inside = (name) => {
      const p = path.resolve(tmp, name);
      return p.startsWith(tmp + path.sep) && fs.existsSync(p) ? p : null;
    };
    const files = pages.filter((name) => list.includes(name)).map((name) => ({ name, file: inside(name) }));
    if (files.some((f) => !f.file)) throw new Error("This comic couldn't be read.");
    const info = list.find((n) => n.toLowerCase() === 'comicinfo.xml');
    if (info && inside(info)) files.push({ name: 'ComicInfo.xml', file: inside(info) });
    await writeStoredZip(out, files);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}
