// v0.15.0 accessibility helpers that don't need a browser: the seek-bar text throttle and card labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliderText } from '../public/js/components.js';

const fakeInput = () => {
  const writes = [];
  return { writes, setAttribute(k, v) { if (k === 'aria-valuetext') writes.push(v); }, getAttribute() { return writes.at(-1) ?? null; } };
};

test('a focused seek bar is written at most every 10 s; forced writes (a scrub, focus) go through at once', () => {
  const el = fakeInput();
  let t = 0;
  sliderText(el, '0:01 of 1:00', { focused: true, now: (t += 0) });
  for (let i = 0; i < 40; i++) sliderText(el, `0:0${i % 9} of 1:00`, { focused: true, now: (t += 250) }); // 10 s of timeupdates
  assert.equal(el.writes.length, 2, `${el.writes.length} writes in 10 s`);
  sliderText(el, 'Jump to 0:30', { focused: true, force: true, now: (t += 10) });
  assert.equal(el.writes.at(-1), 'Jump to 0:30');
});

test('an unfocused seek bar is kept current (nothing is announced for it)', () => {
  const el = fakeInput();
  for (let i = 0; i < 5; i++) sliderText(el, `0:0${i} of 1:00`, { focused: false, now: i * 250 });
  assert.equal(el.writes.length, 5);
});

test('the same text is never rewritten', () => {
  const el = fakeInput();
  sliderText(el, 'a', { focused: false, now: 0 });
  sliderText(el, 'a', { focused: false, now: 1 });
  sliderText(el, 'a', { focused: true, force: true, now: 2 });
  assert.equal(el.writes.length, 1);
});

// v0.15.0 fix pass (I6): the "Browse …" offer on an empty list names a library of the list's kind, or nothing.
test('browseTarget picks the movies library for video lists, a music library for music lists, else nothing', async () => {
  const { browseTarget } = await import('../public/js/components.js');
  const libs = [{ id: 3, type: 'music' }, { id: 7, type: 'shows' }, { id: 9, type: 'movies' }];
  assert.deepEqual(browseTarget(libs, 'watchlist'), { label: 'Browse Movies', href: '#/library/9', icon: 'film' });
  assert.deepEqual(browseTarget(libs, 'music'), { label: 'Browse Music', href: '#/library/3', icon: 'music' });
  assert.equal(browseTarget([{ id: 7, type: 'shows' }], 'watchlist'), null, 'no movies library: no button');
  assert.equal(browseTarget([{ id: 9, type: 'movies' }], 'music'), null, 'no music library: no button');
});
