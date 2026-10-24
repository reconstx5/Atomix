// A cast's subtitle delay moves every cue (src/stream/vttshift.js), karaoke timestamps inside a cue too (v0.22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftVtt } from '../src/stream/vttshift.js';

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSing <00:00:01.000>a<00:01.200>long\nat 10:00.000 sharp\n';

test('inline karaoke timestamps move with the cue', () => {
  const out = shiftVtt(VTT, 0.5);
  assert.match(out, /00:00:01\.500 --> 00:00:03\.500/);
  assert.match(out, /Sing <00:00:01\.500>a<00:00:01\.700>long/);
  assert.match(out, /at 10:00\.000 sharp/, 'a time in the words without brackets stays');
});

test('a karaoke timestamp pushed before 0 is 0', () => {
  assert.match(shiftVtt(VTT, -2), /Sing <00:00:00\.000>a<00:00:00\.000>long/);
});
