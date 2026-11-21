// Now Playing's decisions (public/js/nowplaying-rules.js): the lyric line, seek and volume steps, where focus goes in the
// queue after a move or remove, the disc headings and numbers and sub line of a song row, which face the page shows, and
// the sleep timer's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAD, SEEK_STEP, VOLUME_STEP, HOLD_MS, VOLUME_SAVE_MS, currentLine, seekStep, volumeStep, queueFocusAfter, discRows, trackNumber, subLine, faceFor, sleepLabel } from '../public/js/nowplaying-rules.js';

test('constants', () => {
  assert.equal(LEAD, 0.3);
  assert.equal(SEEK_STEP, 5);
  assert.equal(VOLUME_STEP, 0.05);
  assert.equal(HOLD_MS, 4000);
  assert.equal(VOLUME_SAVE_MS, 800);
});

test('currentLine: the last line that has started, a little early', () => {
  const lines = [0, 1, 2, 3].map((at) => ({ at, text: String(at) }));
  assert.equal(currentLine(lines, 2.5), 2);
  assert.equal(currentLine(lines, 1.75), 2);
  assert.equal(currentLine(lines, -1), -1);
  assert.equal(currentLine([], 5), -1);
  assert.equal(currentLine([{ at: 10, text: 'x' }], 2), -1);
});

test('seekStep: 5 s either way, kept inside the song', () => {
  assert.equal(seekStep(10, 100, 'ArrowRight'), 15);
  assert.equal(seekStep(3, 100, 'ArrowLeft'), 0);
  assert.equal(seekStep(98, 100, 'ArrowRight'), 100);
  assert.equal(seekStep(10, 0, 'ArrowRight'), 0);
  assert.equal(seekStep(10, 100, 'ArrowUp'), null);
});

test('volumeStep: 5% either way, between 0 and 1, no float dust', () => {
  assert.equal(volumeStep(0.5, 'ArrowUp'), 0.55);
  assert.equal(volumeStep(0.98, 'ArrowUp'), 1);
  assert.equal(volumeStep(0.03, 'ArrowDown'), 0);
  assert.equal(volumeStep(0.35, 'ArrowDown'), 0.3);
  assert.equal(volumeStep(0.5, 'ArrowLeft'), null);
});

test('queueFocusAfter: the button the moved or removed row leaves focus on', () => {
  assert.equal(queueFocusAfter('up', 4, 10), '3:up');
  assert.equal(queueFocusAfter('down', 4, 10), '5:down');
  assert.equal(queueFocusAfter('remove', 4, 10), '4:remove');
  assert.equal(queueFocusAfter('remove', 9, 10), '8:remove');
});

test('discRows: a heading where the disc changes, only when there is more than one', () => {
  const t = [{ season: 1 }, { season: 1 }, { season: 2 }];
  assert.deepEqual(discRows(t, true), [{ disc: 1 }, { track: t[0], i: 0 }, { track: t[1], i: 1 }, { disc: 2 }, { track: t[2], i: 2 }]);
  const one = [{ season: 1 }, { season: null }];
  assert.deepEqual(discRows(one, true), [{ track: one[0], i: 0 }, { track: one[1], i: 1 }]);
  assert.deepEqual(discRows(t, false), t.map((track, i) => ({ track, i })));
});

test('trackNumber: the episode, else the place in the list; blank when numbers are off', () => {
  assert.equal(trackNumber({ episode: 7 }, 0, true), '7');
  assert.equal(trackNumber({}, 2, true), '3');
  assert.equal(trackNumber({ episode: 7 }, 0, false), '');
});

test('subLine: artist (or only when it differs), then album', () => {
  assert.equal(subLine({ artist: 'A' }, true, false), 'A');
  assert.equal(subLine({ artist: 'A' }, 'A', false), null);
  assert.equal(subLine({ artist: 'B' }, 'A', false), 'B');
  assert.equal(subLine({ artist: 'A', albumTitle: 'Album' }, 'A', true), 'Album');
  assert.equal(subLine({ artist: 'B', albumTitle: 'Album' }, 'A', true), 'B · Album');
  assert.equal(subLine({ artist: 'B', albumTitle: 'Album' }, false, false), null);
});

test('faceFor: lyrics of another song, the song, a book or episode, or nothing', () => {
  assert.equal(faceFor({ song: '5', current: { id: 5 } }), 'song');
  assert.equal(faceFor({ song: '6', current: { id: 5 } }), 'lyrics');
  assert.equal(faceFor({ song: 'abc', current: null }), 'lyrics');
  assert.equal(faceFor({ current: null }), 'empty');
  assert.equal(faceFor({ current: { id: 1, spoken: {} } }), 'spoken');
  assert.equal(faceFor({ current: { id: 1 } }), 'song');
});

test('sleepLabel: off, end of chapter, or minutes left', () => {
  assert.equal(sleepLabel({ mode: null }), 'Sleep timer');
  assert.equal(sleepLabel({ mode: 'chapter' }), 'Sleep timer: end of chapter');
  assert.equal(sleepLabel({ mode: 'time', remaining: 125000 }), 'Sleep timer: 3 min left');
  assert.equal(sleepLabel({ mode: 'time' }), 'Sleep timer: 0 min left');
});
