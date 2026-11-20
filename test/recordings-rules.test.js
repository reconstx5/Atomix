// Recordings' rules (public/js/recordings-rules.js): where focus goes after a row goes, the episode line and the gap
// sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFocusKey, afterDeleteFocus, episodeLine, gapText } from '../public/js/recordings-rules.js';

const rows = [{ id: 1, firstKey: 'cancel:1' }, { id: 2, firstKey: 'cancel:2' }, { id: 3, firstKey: 'cancel:3' }];

test("nextFocusKey: the next row's first control", () => {
  assert.equal(nextFocusKey(rows, 1, 'rec-scheduled'), 'cancel:2');
  assert.equal(nextFocusKey(rows, 2, 'rec-scheduled'), 'cancel:3');
});

test("nextFocusKey: the last row: the row before's", () => {
  assert.equal(nextFocusKey(rows, 3, 'rec-scheduled'), 'cancel:2');
});

test("nextFocusKey: an only row, a row that isn't there, or a next row with no controls: the heading", () => {
  assert.equal(nextFocusKey([{ id: 7, firstKey: 'play:7' }], 7, 'rec-done'), 'h:rec-done');
  assert.equal(nextFocusKey(rows, 99, 'rec-scheduled'), 'h:rec-scheduled');
  // A failed row that is saving has no buttons: the heading, as today (the row before isn't tried).
  assert.equal(nextFocusKey([{ id: 1, firstKey: 'retry:1' }, { id: 2, firstKey: null }], 1, 'rec-failed'), 'h:rec-failed');
});

test("afterDeleteFocus: the deleted row's own controls give the Done heading", () => {
  assert.equal(afterDeleteFocus('play:5', 5), 'h:rec-done');
  assert.equal(afterDeleteFocus('delete:5', 5), 'h:rec-done');
  assert.equal(afterDeleteFocus('play:6', 5), 'play:6');
  assert.equal(afterDeleteFocus('h:rec-done', 5), 'h:rec-done');
});

test('episodeLine: S/E and the episode title', () => {
  assert.equal(episodeLine({ season: 3, episode: 7, episodeTitle: 'High Tide' }), 'S3 E7 · High Tide');
  assert.equal(episodeLine({ season: 0, episode: 1 }), 'S0 E1');
  assert.equal(episodeLine({ season: null, episode: 2, episodeTitle: 'Pilot' }), 'Pilot');
  assert.equal(episodeLine({}), '');
});

test('gapText: none, or the minutes missing (at least 1)', () => {
  assert.equal(gapText({ gapSeconds: 0 }), null);
  assert.equal(gapText({}), null);
  assert.equal(gapText({ gapSeconds: 20 }), 'Has a gap (1 min missing)');
  assert.equal(gapText({ gapSeconds: 300 }), 'Has a gap (5 min missing)');
  assert.equal(gapText({ gapSeconds: 301 }), 'Has a gap (6 min missing)');
});
