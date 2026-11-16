// Pure helpers for devtools/gallery.mjs (tested in test/gallery.test.js).
export const SIZES = { desk: { w: 1440, h: 900, label: 'Desktop' }, tv: { w: 1920, h: 1080, label: 'TV' }, phone: { w: 390, h: 844, label: 'Phone' } };
const PAGES = { _: 'Home', _library_1: 'Library', _item_1: 'Title page', _live: 'Live TV', _settings: 'Settings' };
export const PAGE_ORDER = Object.keys(PAGES);

/** 'arctic-side-tv-_item_1.png' -> { theme, size, page, name }; null for anything that is not a picture name. */
export function parseName(file) {
  const m = /^(.+)-(desk|tv|phone)-(_[^.]*)\.png$/.exec(file);
  return m ? { theme: m[1], size: m[2], page: m[3], name: file.slice(0, -4) } : null;
}
export const pageLabel = (page) => PAGES[page] || page;

/** Every before picture is a pair; `missing` names the ones the after folder lacks. */
export function pairNames(beforeFiles, afterFiles) {
  const have = new Set(afterFiles);
  const pairs = beforeFiles.map(parseName).filter(Boolean);
  return { pairs, missing: pairs.filter((p) => !have.has(`${p.name}.png`)).map((p) => p.name) };
}
