// v0.28: channels this device can't play are hidden (public/js/dash/playable.js), and channel up/down skips them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelPlayable, hiddenFilter, deviceWord, SHOW_KEY, switchLabel, iosDevice } from '../public/js/dash/playable.js';
import { isIos } from '../public/js/dash/support.js';
import { neighbour, setZapOrder } from '../public/js/live.js';

const IPHONE = ['fairplay', 'clearkey'];
const CHROME = ['widevine', 'clearkey'];
const EDGE = ['playready', 'widevine', 'clearkey'];

test('channelPlayable: a plain channel always plays', () => {
  assert.equal(channelPlayable(null, IPHONE), true);
  assert.equal(channelPlayable(undefined, IPHONE), true);
  assert.equal(channelPlayable([], IPHONE), true);
});

test('channelPlayable: iPhone and iPad play FairPlay and ClearKey only', () => {
  assert.equal(channelPlayable(['widevine'], IPHONE), false);
  assert.equal(channelPlayable(['widevine', 'playready'], IPHONE), false);
  assert.equal(channelPlayable(['widevine', 'clearkey'], IPHONE), true);
  assert.equal(channelPlayable(['fairplay', 'widevine'], IPHONE), true);
  assert.equal(channelPlayable('widevine', IPHONE), false, 'an older single name');
});

test('channelPlayable: Chrome and Edge from their probe', () => {
  assert.equal(channelPlayable(['widevine'], CHROME), true);
  assert.equal(channelPlayable(['playready'], CHROME), false);
  assert.equal(channelPlayable(['playready'], EDGE), true);
  assert.equal(channelPlayable(['fairplay'], EDGE), false);
});

test('channelPlayable: a device not known yet (probe running, or a plain-http page) hides nothing', () => {
  assert.equal(channelPlayable(['widevine'], null), true);
  assert.equal(channelPlayable(['playready'], undefined), true);
});

test('hiddenFilter keeps order and drops what the device can\'t play', () => {
  const list = [{ id: 1, drm: null }, { id: 2, drm: ['widevine'] }, { id: 3, drm: ['widevine', 'clearkey'] }, { id: 4, drm: ['playready'] }];
  assert.deepEqual(hiddenFilter(list, { device: IPHONE }).map((c) => c.id), [1, 3]);
  assert.deepEqual(hiddenFilter(list, { device: null }).map((c) => c.id), [1, 2, 3, 4]);
  const all = hiddenFilter(list, { device: IPHONE, showAll: true });
  assert.deepEqual(all.map((c) => c.id), [1, 2, 3, 4]);
  assert.deepEqual(all.map((c) => Boolean(c.unplayable)), [false, true, false, true]);
  assert.equal(all[0], list[0], 'a playable channel is the same object (nothing re-drawn)');
  assert.equal(list[1].unplayable, undefined, 'the list given is not changed');
  assert.equal(hiddenFilter(list, { device: CHROME }).length, 3);
  assert.equal(hiddenFilter(null, { device: IPHONE }).length, 0);
});

test('deviceWord and the switch\'s words', () => {
  assert.equal(deviceWord({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }), 'iPhone');
  assert.equal(deviceWord({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1' }), 'iPad');
  assert.equal(deviceWord({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }), 'iPad', 'iPadOS asks for the desktop site');
  assert.equal(deviceWord({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' }), 'browser');
  assert.equal(switchLabel('iPhone'), "Show channels this iPhone can't play");
  assert.equal(switchLabel('iPad'), "Show channels this iPad can't play");
  assert.equal(switchLabel('browser'), "Show channels this browser can't play");
  assert.equal(SHOW_KEY, 'atomix-show-unplayable');
});

test('iosDevice agrees with support.js\'s isIos (playable.js keeps its own copy so plain pages stay light)', () => {
  const navs = [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { userAgent: 'Mozilla/5.0 (iPod touch)' },
    { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 },
    { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130' },
    {},
  ];
  for (const n of navs) assert.equal(iosDevice(n), isIos(n), JSON.stringify(n));
});

test('zapping skips channels this device can\'t play', () => {
  const A = 1;
  const B = 2;
  const C = 3;
  setZapOrder([A, B, C]);
  const ok = (id) => id !== B;
  assert.equal(neighbour(A, 1, ok), C, 'A → C, over B');
  assert.equal(neighbour(C, 1, ok), A, 'C → A (wraps)');
  assert.equal(neighbour(C, -1, ok), A, 'C ← A, over B');
  assert.equal(neighbour(A, -1, ok), C, 'A ← C (wraps)');
  assert.equal(neighbour(A, 1, (id) => id === A), A, 'only A plays: stays');
  assert.equal(neighbour(B, 1, ok), C, 'from a hidden one, on to the next that plays');
  assert.equal(neighbour(99, 1, (id) => id !== A), B, 'not in the order: the first that plays');
  assert.equal(neighbour(A, 1), B, 'without a check, as before');
  setZapOrder([]);
});
