// The EPUB reader's arithmetic (v0.22): a chapter laid out in columns is a row of pages, each starting at a text
// offset — the place kept is the offset, so a new text size or a turned phone lands on the same words. Pure.

export const WPM = 250; // words a minute until this device has timed its reader

/** The page an offset is on (`starts`: each page's first text offset, in order). */
export function pageOfOffset(starts, offset) {
  if (!starts?.length) return 0;
  let page = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= offset) page = i;
  return page;
}

/** The text offset a page starts at (the last page's past the end). */
export function offsetOfPage(starts, page) {
  if (!starts?.length) return 0;
  return starts[Math.max(0, Math.min(starts.length - 1, page))];
}

/** Minutes to read `words` at `wpm` (250 when not known), to one decimal. */
export function minutesLeft(words, wpm = WPM) {
  const speed = wpm > 0 ? wpm : WPM;
  return Math.round((Math.max(0, words) / speed) * 10) / 10;
}

/** "Chapter 3 · 42% · 12 min left in chapter" (never 100% before the end). */
export function statusText({ chapter, percent, minutes }) {
  const pct = Math.min(99, Math.floor(percent));
  const left = minutes < 1 ? 'less than a minute left in chapter' : `${Math.round(minutes)} min left in chapter`;
  return `Chapter ${chapter} · ${pct}% · ${left}`;
}

/** How far through the book: the chapters before this one, and this one's share for the pages read in it. */
export function bookPercent({ chapter, page, pages, chapters }) {
  if (!chapters) return 0;
  const within = pages > 0 ? page / pages : 0;
  return Math.round(((chapter + within) / chapters) * 1000) / 10;
}

/** What kind of device this is, for "Jump to page 87 (from your phone)?". */
export function deviceKind({ ua = '', touch = false, short = 1080 } = {}) {
  if (/\b(SMART-TV|SmartTV|Tizen|Web0S|webOS|AFT\w*|BRAVIA|CrKey|GoogleTV|Android TV)\b/i.test(ua)) return 'TV';
  if (/iPad/.test(ua) || (touch && short >= 600)) return 'tablet';
  if (touch || /iPhone|Android.*Mobile/.test(ua)) return 'phone';
  return 'computer';
}
