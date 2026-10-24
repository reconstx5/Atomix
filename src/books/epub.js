// An EPUB's metadata, reading order and table of contents (v0.22), read with the DOM-free XML reader: no DOCTYPE
// internal subsets or entity declarations, HTML's common named characters turned into numbers first.
import path from 'node:path';
import { parseXml, localName } from '../../public/js/dash/xml.js';

const HTML_ENTITIES = { nbsp: 160, copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, laquo: 171, raquo: 187, shy: 173, eacute: 233, egrave: 232, uuml: 252, ouml: 246, auml: 228, ccedil: 231, middot: 183, bull: 8226 };

/** XML from an EPUB: a plain DOCTYPE dropped (one with declarations in it is refused by the reader), HTML entities as numbers. */
export function parseBookXml(buf) {
  const text = String(buf ?? '')
    .replace(/<!DOCTYPE[^>[]*>/i, '')
    .replace(/&([a-zA-Z]+);/g, (m, n) => (HTML_ENTITIES[n] ? `&#${HTML_ENTITIES[n]};` : m));
  return parseXml(text, { maxBytes: 8_000_000, maxNodes: 200_000, maxDepth: 128 });
}

const kids = (el, name) => (el?.children || []).filter((c) => localName(c.name) === name);
const kid = (el, name) => kids(el, name)[0] || null;
/** All the text in an element and its children. */
export function deepText(el) {
  if (!el) return '';
  return (el.text || '') + (el.children || []).map(deepText).join('');
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim() || null;
const stripTags = (s) => clean(String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

/** `href` as written in `fromFile`, made relative to the package folder (keeping any #fragment). */
function rel(opfDir, fromFile, href) {
  const [p, frag] = String(href).split('#');
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    /* keep it as written */
  }
  const full = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded));
  const out = opfDir ? path.posix.relative(opfDir, full) : full;
  return frag ? `${out}#${frag}` : out;
}

function navToc(nav, opfDir, navFile) {
  const out = [];
  const tocNav = findAll(nav, 'nav').find((n) => /\btoc\b/.test(n.attrs['epub:type'] || n.attrs.type || '')) || findAll(nav, 'nav')[0];
  const walkOl = (ol, level) => {
    for (const li of kids(ol, 'li')) {
      const a = kid(li, 'a') || kid(li, 'span');
      if (a) {
        const title = clean(deepText(a));
        if (title && a.attrs.href) out.push({ title, href: rel(opfDir, navFile, a.attrs.href), level });
      }
      const sub = kid(li, 'ol');
      if (sub) walkOl(sub, level + 1);
    }
  };
  const ol = tocNav && findAll(tocNav, 'ol')[0];
  if (ol) walkOl(ol, 0);
  return out;
}

function ncxToc(ncx, opfDir, ncxFile) {
  const out = [];
  const walk = (el, level) => {
    for (const p of kids(el, 'navPoint')) {
      const title = clean(deepText(kid(kid(p, 'navLabel'), 'text')));
      const src = kid(p, 'content')?.attrs.src;
      if (title && src) out.push({ title, href: rel(opfDir, ncxFile, src), level });
      walk(p, level + 1);
    }
  };
  walk(kid(ncx, 'navMap'), 0);
  return out;
}

function findAll(el, name, out = []) {
  for (const c of el?.children || []) {
    if (localName(c.name) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** An ISBN-10 or ISBN-13 with a good check digit, as bare digits (and a final X), else null. */
export function cleanIsbn(text) {
  const s = String(text || '').trim().replace(/^urn:isbn:/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((t, c, i) => t + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? s : null;
  }
  if (/^97[89]\d{10}$/.test(s)) {
    const sum = [...s.slice(0, 12)].reduce((t, c, i) => t + Number(c) * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === Number(s[12]) ? s : null;
  }
  return null;
}

/**
 * @param {{ read(name: string): Promise<Buffer|null> }} zip an open archive (src/books/zip.js)
 * @returns {Promise<{ title, author, description, language, year, isbn, series, seriesIndex, coverEntry, spine: {href, id}[], toc: {title, href, level}[], opfDir }>}
 */
export async function readEpub(zip) {
  const container = await zip.read('META-INF/container.xml');
  if (!container) throw new Error("This isn't an EPUB book (it has no META-INF/container.xml).");
  const rootfile = findAll(parseBookXml(container), 'rootfile')[0];
  const opfPath = rootfile?.attrs['full-path'];
  const opfBuf = opfPath && (await zip.read(opfPath));
  if (!opfBuf) throw new Error("This EPUB's package file is missing.");
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);
  const pkg = parseBookXml(opfBuf);
  const md = kid(pkg, 'metadata');
  const dc = (name) => kids(md, name);
  const metas = kids(md, 'meta');
  const metaNamed = (n) => metas.find((m) => m.attrs.name === n)?.attrs.content ?? null;
  const creators = dc('creator');
  const author = clean(deepText(creators.find((c) => /aut/.test(c.attrs['opf:role'] || '')) || creators[0]));
  const dateText = clean(deepText(dc('date')[0]));
  const year = dateText && /^\d{4}/.test(dateText) ? Number(dateText.slice(0, 4)) : null;
  // v0.23: the book's ISBN, for looking it up (Open Library): an identifier marked ISBN, a urn:isbn:, or one that
  // reads as an ISBN with a good check digit.
  let isbn = null;
  for (const el of dc('identifier')) {
    const scheme = String(el.attrs['opf:scheme'] || el.attrs.scheme || '').toLowerCase();
    const text = clean(deepText(el)) || '';
    if (scheme && scheme !== 'isbn' && !/^urn:isbn:/i.test(text)) continue;
    isbn = cleanIsbn(text);
    if (isbn) break;
  }

  // Series: calibre's, else an EPUB 3 collection of type series (or untyped).
  let series = clean(metaNamed('calibre:series'));
  let seriesIndex = clean(metaNamed('calibre:series_index'));
  if (!series) {
    const col = metas.find((m) => m.attrs.property === 'belongs-to-collection');
    if (col) {
      const refined = (prop) => metas.find((m) => m.attrs.refines === `#${col.attrs.id}` && m.attrs.property === prop);
      const type = clean(deepText(refined('collection-type')));
      if (!type || type === 'series') {
        series = clean(deepText(col));
        seriesIndex = clean(deepText(refined('group-position')));
      }
    }
  }
  if (seriesIndex && /^\d+(\.0+)?$/.test(seriesIndex)) seriesIndex = String(Number(seriesIndex));

  const manifest = new Map(kids(kid(pkg, 'manifest'), 'item').map((i) => [i.attrs.id, { id: i.attrs.id, href: rel(opfDir, opfPath, i.attrs.href || ''), type: i.attrs['media-type'] || '', props: i.attrs.properties || '' }]));
  const spineEl = kid(pkg, 'spine');
  const spine = kids(spineEl, 'itemref')
    .map((r) => manifest.get(r.attrs.idref))
    .filter((m) => m && /x?html/.test(m.type))
    .map((m) => ({ href: m.href, id: m.id }));

  const items = [...manifest.values()];
  const coverItem = items.find((i) => /\bcover-image\b/.test(i.props)) || manifest.get(metaNamed('cover')) || items.find((i) => /^image\//.test(i.type) && /cover/i.test(i.id + i.href));
  const full = (href) => (opfDir ? `${opfDir}/${href}` : href);

  let toc = [];
  const nav = items.find((i) => /\bnav\b/.test(i.props));
  try {
    if (nav) toc = navToc(parseBookXml(await zip.read(full(nav.href))), opfDir, full(nav.href));
    if (!toc.length) {
      const ncx = manifest.get(spineEl?.attrs.toc) || items.find((i) => i.type === 'application/x-dtbncx+xml');
      if (ncx) toc = ncxToc(parseBookXml(await zip.read(full(ncx.href))), opfDir, full(ncx.href));
    }
  } catch {
    toc = []; // an unreadable table of contents: the book still reads, chapter by chapter
  }

  return {
    title: clean(deepText(dc('title')[0])),
    author,
    description: stripTags(deepText(dc('description')[0])),
    language: clean(deepText(dc('language')[0])),
    year,
    isbn,
    series,
    seriesIndex,
    coverEntry: coverItem && /^image\//.test(coverItem.type || 'image/') ? full(coverItem.href) : null,
    spine,
    toc,
    opfDir,
  };
}
