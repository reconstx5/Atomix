// The spoken-word player's arithmetic (v0.22 Plan C): book time across parts, the chapter at a time, the resume
// point, the "left" text and the sleep timer's fade. Pure, so it runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partAt, bookTime, chapterAt, resumePoint, leftText, fadeVolume, SPEEDS } from '../public/js/spoken-time.js';

const parts = [
  { start: 0, duration: 60 },
  { start: 60, duration: 60 },
  { start: 120, duration: 30 },
];

test('partAt finds the part and the offset in it', () => {
  assert.deepEqual(partAt(parts, 0), { index: 0, offset: 0 });
  assert.deepEqual(partAt(parts, 75), { index: 1, offset: 15 });
  assert.deepEqual(partAt(parts, 60), { index: 1, offset: 0 });
  assert.deepEqual(partAt(parts, 999), { index: 2, offset: 30 }, 'past the end: the last part, at its end');
  assert.deepEqual(partAt(parts, -5), { index: 0, offset: 0 });
  assert.deepEqual(partAt([], 10), { index: 0, offset: 10 }, 'a single file (no parts list)');
});

test('bookTime is a part start plus the offset', () => {
  assert.equal(bookTime(parts, 1, 15), 75);
  assert.equal(bookTime([], 0, 42), 42);
});

test('chapterAt', () => {
  const ch = [
    { title: 'One', start: 0 },
    { title: 'Two', start: 100 },
  ];
  assert.deepEqual(chapterAt(ch, 50), { index: 0, title: 'One' });
  assert.deepEqual(chapterAt(ch, 100), { index: 1, title: 'Two' });
  assert.deepEqual(chapterAt([{ title: 'Late', start: 10 }], 2), { index: 0, title: 'Late' }, 'before the first: the first');
  assert.equal(chapterAt([], 5), null);
});

test('resumePoint rewinds 5 s after more than 10 minutes away', () => {
  assert.equal(resumePoint({ position: 100, updatedAt: 0 }, 600_001), 95);
  assert.equal(resumePoint({ position: 100, updatedAt: 0 }, 599_000), 100);
  assert.equal(resumePoint({ position: 3, updatedAt: 0 }, 9_999_999), 0);
  assert.equal(resumePoint(null, 1), 0);
});

test('leftText', () => {
  assert.equal(leftText(8040), '2 h 14 min left');
  assert.equal(leftText(7200), '2 h left');
  assert.equal(leftText(720), '12 min left');
  assert.equal(leftText(30), 'Less than a minute left');
});

test('fadeVolume over the last 10 seconds', () => {
  assert.equal(fadeVolume(0.8, 20_000), 0.8);
  assert.equal(fadeVolume(0.8, 5000), 0.4);
  assert.equal(fadeVolume(0.8, 0), 0);
  assert.equal(fadeVolume(0.8, -10), 0);
});

test('the speeds', () => {
  assert.deepEqual(SPEEDS, [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
});

test('partAt with a part whose length is not known yet', () => {
  const p = [
    { start: 0, duration: 60 },
    { start: 60, duration: 0 },
    { start: 60, duration: 60 },
  ];
  assert.deepEqual(partAt(p, 70), { index: 1, offset: 10 }, 'an unknown length: the earlier part');
  assert.deepEqual(partAt(p, 70, 1), { index: 1, offset: 10 }, 'playing it: stay in it');
  assert.deepEqual(partAt(p, 30, 1), { index: 0, offset: 30 }, 'before it: the part before');
  assert.deepEqual(partAt(parts, 75, 0), { index: 1, offset: 15 }, 'known lengths: as before');
});
