// The app state's change events (v0.26): a top-level write notifies once (not for the same value), notifyState covers
// nested changes the Proxy can't see. No DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchState, onState, notifyState } from '../public/js/state-events.js';

test('a top-level change notifies once; the same value does not', () => {
  const seen = [];
  const off = onState((k) => seen.push(k));
  const s = watchState({ profile: null, status: 1 });
  s.profile = { name: 'Mia' };
  s.status = 1;
  off();
  s.profile = null;
  assert.deepEqual(seen, ['profile']);
});
test('notifyState reaches listeners', () => {
  const seen = [];
  const off = onState((k) => seen.push(k));
  notifyState('prefs');
  off();
  assert.deepEqual(seen, ['prefs']);
});
