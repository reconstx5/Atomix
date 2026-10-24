// ComicInfo.xml (v0.22 comics): the series, the number, the age rating and whether it reads right to left.
import { parseBookXml, deepText } from './epub.js';
import { localName } from '../../public/js/dash/xml.js';

const AGES = { everyone: 0, g: 0, pg: 8, m: 15, 'early childhood': 3, 'kids to adults': 6, 'everyone 10+': 10, teen: 13, 'ma15+': 15, 'mature 17+': 17, 'adults only 18+': 18, 'r18+': 18, 'x18+': 18 };

/** A ComicInfo AgeRating as the youngest age it is for, or null (unrated: Unknown, Rating Pending, empty). */
export function ageFor(rating) {
  const k = String(rating ?? '').trim().toLowerCase();
  return k in AGES ? AGES[k] : null;
}

/** @returns {{ series, number, title, summary, year, ageRating, manga: 'rtl'|null, pageCount }} */
export function parseComicInfo(xml) {
  const root = parseBookXml(xml);
  const field = (name) => {
    const el = (root.children || []).find((c) => localName(c.name) === name);
    const t = el ? deepText(el).replace(/\s+/g, ' ').trim() : '';
    return t || null;
  };
  const int = (v) => (/^\d+$/.test(v || '') ? Number(v) : null);
  return {
    series: field('Series'),
    number: field('Number'),
    title: field('Title'),
    summary: field('Summary'),
    year: int(field('Year')),
    ageRating: field('AgeRating'),
    manga: field('Manga') === 'YesAndRightToLeft' ? 'rtl' : null,
    pageCount: int(field('PageCount')),
  };
}
