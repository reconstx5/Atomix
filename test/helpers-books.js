// Test books (v0.22 Plan D): EPUBs written byte by byte with the stored-ZIP writer.
import fs from 'node:fs';
import path from 'node:path';
import { writeStoredZip } from '../src/books/zip-write.js';

/** An EPUB: EPUB 3 (nav.xhtml) unless `ncx`; metadata as given; a cover picture when `cover` is a file. */
export async function makeEpub(file, { title, author, description, language = 'en', date, series, seriesIndex, collection, ncx = false, cover = null, chapters = ['One', 'Two', 'Three'], extraBody = '', identifiers = [] }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const items = chapters.map((c, i) => `<item id="c${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map((c, i) => `<itemref idref="c${i + 1}"/>`).join('');
  const meta = [
    title ? `<dc:title>${title}</dc:title>` : '',
    author ? `<dc:creator opf:role="aut">${author}</dc:creator>` : '',
    description ? `<dc:description>${description}</dc:description>` : '',
    language ? `<dc:language>${language}</dc:language>` : '',
    date ? `<dc:date>${date}</dc:date>` : '',
    series ? `<meta name="calibre:series" content="${series}"/><meta name="calibre:series_index" content="${seriesIndex}"/>` : '',
    collection ? `<meta property="belongs-to-collection" id="col">${collection.name}</meta><meta refines="#col" property="collection-type">series</meta><meta refines="#col" property="group-position">${collection.position}</meta>` : '',
    ...identifiers.map((i) => `<dc:identifier${i.scheme ? ` opf:scheme="${i.scheme}"` : ''}>${i.value}</dc:identifier>`),
    cover && ncx ? '<meta name="cover" content="cover-img"/>' : '',
  ].join('');
  const manifest = `${items}${ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}${cover ? `<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"${ncx ? '' : ' properties="cover-image"'}/>` : ''}`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="${ncx ? '2.0' : '3.0'}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${meta}</metadata><manifest>${manifest}</manifest><spine${ncx ? ' toc="ncx"' : ''}>${spine}</spine></package>`;
  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
    { name: 'META-INF/container.xml', data: Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    ...chapters.map((c, i) => ({ name: `OEBPS/text/ch${i + 1}.xhtml`, data: Buffer.from(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c}</title></head><body><h1>Chapter ${c}</h1><p>${'The words of chapter ' + c + '. '.repeat(1)}${'More words follow here. '.repeat(40)}</p>${extraBody}</body></html>`) })),
  ];
  if (ncx) {
    const points = chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${c}</text></navLabel><content src="text/ch${i + 1}.xhtml"/></navPoint>`).join('');
    files.push({ name: 'OEBPS/toc.ncx', data: Buffer.from(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`) });
  } else {
    const lis = chapters.map((c, i) => `<li><a href="text/ch${i + 1}.xhtml">${c}</a>${i === 0 ? '<ol><li><a href="text/ch1.xhtml#part">Part of One</a></li></ol>' : ''}</li>`).join('');
    files.push({ name: 'OEBPS/nav.xhtml', data: Buffer.from(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${lis}</ol></nav></body></html>`) });
  }
  if (cover) files.push({ name: 'OEBPS/images/cover.jpg', file: cover });
  await writeStoredZip(file, files);
}

