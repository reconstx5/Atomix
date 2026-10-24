// The EPUB reader's arithmetic (v0.22 Plan D Task 5): which page a text offset is on and back, minutes left at a
// reading speed, and the status line's words. Pure, so it runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageOfOffset, offsetOfPage, minutesLeft, statusText, bookPercent, deviceKind } from '../public/js/reader/paging.js';

const starts = [0, 410, 905, 1320]; // the text offset each page starts at

test('pageOfOffset and offsetOfPage round-trip', () => {
  assert.equal(pageOfOffset(starts, 0), 0);
  assert.equal(pageOfOffset(starts, 409), 0);
  assert.equal(pageOfOffset(starts, 410), 1);
  assert.equal(pageOfOffset(starts, 5000), 3, 'past the end: the last page');
  assert.equal(pageOfOffset(starts, -3), 0);
  assert.equal(pageOfOffset([], 50), 0);
  for (let p = 0; p < starts.length; p++) assert.equal(pageOfOffset(starts, offsetOfPage(starts, p)), p);
  assert.equal(offsetOfPage(starts, 99), 1320);
});

test('minutesLeft at 250 words a minute', () => {
  assert.equal(minutesLeft(3000, 250), 12);
  assert.equal(minutesLeft(100, 250), 0.4);
  assert.equal(minutesLeft(3000), 12, '250 by default');
  assert.equal(minutesLeft(3000, 0), 12, 'no speed measured yet: 250');
});

test('statusText', () => {
  assert.equal(statusText({ chapter: 3, percent: 42.4, minutes: 12.2 }), 'Chapter 3 · 42% · 12 min left in chapter');
  assert.equal(statusText({ chapter: 1, percent: 0, minutes: 0.4 }), 'Chapter 1 · 0% · less than a minute left in chapter');
  assert.equal(statusText({ chapter: 2, percent: 99.6, minutes: 1 }), 'Chapter 2 · 99% · 1 min left in chapter', 'never 100% before the end');
});

test('bookPercent from the chapter and the page in it', () => {
  assert.equal(bookPercent({ chapter: 0, page: 0, pages: 10, chapters: 4 }), 0);
  assert.equal(bookPercent({ chapter: 2, page: 5, pages: 10, chapters: 4 }), 62.5);
  assert.equal(bookPercent({ chapter: 3, page: 9, pages: 10, chapters: 4 }), 97.5);
});

test('deviceKind', () => {
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', touch: true, short: 390 }), 'phone');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (iPad; CPU OS 17_0)', touch: true, short: 820 }), 'tablet');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)', touch: false, short: 1080 }), 'TV');
  assert.equal(deviceKind({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', touch: false, short: 1080 }), 'computer');
});
