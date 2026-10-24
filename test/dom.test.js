// Formatting helpers from the browser's dom.js that need no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock } from '../public/js/dom.js';

test('formatClock rounds to tenths before splitting', () => {
  assert.equal(formatClock(42.97, { tenths: true }), '0:43.0');
  assert.equal(formatClock(59.96, { tenths: true }), '1:00.0');
  assert.equal(formatClock(3599.96, { tenths: true }), '1:00:00.0');
  assert.equal(formatClock(12.34, { tenths: true }), '0:12.3');
  assert.equal(formatClock(42, { tenths: true }), '0:42', 'a whole second has no tenths');
  assert.equal(formatClock(42.97), '0:42', 'without tenths: unchanged');
});
