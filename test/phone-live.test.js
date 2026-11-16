// The phone's screen-on lock while Live TV plays (public/js/views/phone-live.js), with stand-in browser parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise((r) => setTimeout(r, 5));
function setup() {
  const held = new Set();
  let requests = 0;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', fullscreenElement: null });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      wakeLock: {
        request: async () => {
          requests++;
          await tick();
          const l = Object.assign(new EventTarget(), { release: async () => held.delete(l) });
          held.add(l);
          return l;
        },
      },
    },
  });
  const video = Object.assign(new EventTarget(), { paused: false });
  return { video, held, requests: () => requests };
}

test('v0.28: two quick "playing" events take one lock, not two', async () => {
  const { phoneLive } = await import('../public/js/views/phone-live.js');
  const { video, held } = setup();
  const p = phoneLive(video, { touch: true });
  video.dispatchEvent(new Event('playing'));
  video.dispatchEvent(new Event('playing'));
  await tick();
  await tick();
  assert.equal(held.size, 1, 'one lock held');
  p.destroy();
  await tick();
  assert.equal(held.size, 0, 'and none after leaving');
});

test('v0.28: a playback error lets the screen sleep', async () => {
  const { phoneLive } = await import('../public/js/views/phone-live.js');
  const { video, held } = setup();
  const p = phoneLive(video, { touch: true });
  video.dispatchEvent(new Event('playing'));
  await tick();
  await tick();
  assert.equal(held.size, 1);
  video.dispatchEvent(new Event('error'));
  await tick();
  assert.equal(held.size, 0, 'the error page does not keep the screen on');
  p.destroy();
});
