// LRC parsing, shared by the server (tags check) and the Now Playing page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc } from '../public/js/lrc.js';

test('parseLrc: stamps, several stamps per line, offset, metadata tags dropped, sorted', () => {
  const r = parseLrc('[ar:Band]\n[offset:+500]\n[00:12.00]Line one\n[00:01.5][00:20.250]Twice\n[01:00]Minute\n\n[00:05.00]');
  assert.equal(r.synced, true);
  assert.equal(r.offset, 0.5);
  assert.deepEqual(r.lines.map((l) => [Number(l.at.toFixed(2)), l.text]), [[2, 'Twice'], [5.5, ''], [12.5, 'Line one'], [20.75, 'Twice'], [60.5, 'Minute']]);
});

test('parseLrc: fewer than three timed lines is plain text; brackets in lyrics are not stamps', () => {
  const r = parseLrc('[Chorus]\nLa la la\n[00:10.00]only one stamp\n');
  assert.equal(r.synced, false);
  assert.deepEqual(r.lines, [{ at: null, text: '[Chorus]' }, { at: null, text: 'La la la' }, { at: null, text: 'only one stamp' }]);
});

test('parseLrc: inline word stamps <mm:ss.xx> are stripped to the line; CRLF and BOM are fine', () => {
  const r = parseLrc('﻿[00:01.00]<00:01.00>Hello <00:01.50>there\r\n[00:02.00]B\r\n[00:03.00]C');
  assert.equal(r.synced, true);
  assert.deepEqual(r.lines.map((l) => l.text), ['Hello there', 'B', 'C']);
});
