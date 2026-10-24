// Orbit's Live TV page (v0.25): the pure rules — a channel's colour, time left, the card's next line, and which
// channel the spotlight starts on and keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelTint, minutesLeft, nextLine, spotStart, spotKeep } from '../public/js/live-rules.js';

test('a channel keeps its colour; different names differ', () => {
  assert.equal(channelTint('TVNZ 1'), channelTint('TVNZ 1'));
  assert.notEqual(channelTint('TVNZ 1'), channelTint('Three'));
  assert.match(channelTint('Three'), /^hsl\(\d{1,3} 45% 32%\)$/);
  assert.equal(channelTint(''), 'hsl(220 20% 24%)');
});

test('time left reads in minutes, then hours', () => {
  const at = 1_000_000;
  assert.equal(minutesLeft({ start: at - 60_000, end: at + 38 * 60_000 }, at), '38 min left');
  assert.equal(minutesLeft({ start: at, end: at + 65 * 60_000 }, at), '1 h 5 min left');
  assert.equal(minutesLeft({ start: at, end: at + 20_000 }, at), 'Ending now');
  assert.equal(minutesLeft(null, at), '');
});

test("the card's next line", () => {
  assert.equal(nextLine({ start: 1, title: 'Coast' }, () => '2:00 PM'), 'Next 2:00 PM · Coast');
  assert.equal(nextLine(null, () => 'x'), '');
});

test('the spotlight starts on the first favourite and keeps a listed channel', () => {
  const list = [{ id: 1 }, { id: 2, favourite: true }, { id: 3 }];
  assert.equal(spotStart(list), 2);
  assert.equal(spotStart([{ id: 5 }]), 5);
  assert.equal(spotStart([]), null);
  assert.equal(spotKeep(list, 3), 3);
  assert.equal(spotKeep(list, 9), 2, 'a channel no longer listed gives way to the start');
});
