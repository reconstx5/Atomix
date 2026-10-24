// v0.27 Plan B: can this device play a channel's protection? Decided before any stream starts (public/js/dash/support.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectionVerdict, isIos } from '../public/js/dash/support.js';
import { NEED_SECURE, NO_WIDEVINE, NO_WIDEVINE_IPHONE, NO_FAIRPLAY } from '../public/js/dash/eme.js';

test('the sentences, verbatim', () => {
  assert.equal(NO_WIDEVINE_IPHONE, "This channel is encrypted with Widevine, which iPhones can't play.");
  assert.equal(NO_WIDEVINE, "This browser can't play this channel's protection.");
  assert.equal(NO_FAIRPLAY, 'This channel is encrypted with FairPlay, which plays in Safari on Apple devices');
});

test('protectionVerdict: what each device hears before any stream starts', async () => {
  const yes = async () => true;
  const no = async () => false;
  assert.equal(await protectionVerdict('widevine', { ios: true, secure: false, probe: yes }), NO_WIDEVINE_IPHONE); // the secure address wouldn't help
  assert.equal(await protectionVerdict('widevine', { ios: true, secure: true, probe: yes }), NO_WIDEVINE_IPHONE);
  assert.equal(await protectionVerdict('widevine', { ios: false, secure: false, probe: yes }), NEED_SECURE);
  assert.equal(await protectionVerdict('widevine', { ios: false, secure: true, probe: no }), NO_WIDEVINE);
  assert.equal(await protectionVerdict('widevine', { ios: false, secure: true, probe: yes }), null);
  assert.equal(await protectionVerdict('fairplay', { secure: true, probe: no }), NO_FAIRPLAY);
  assert.equal(await protectionVerdict('fairplay', { secure: false, apple: true, probe: no }), NEED_SECURE);
  assert.equal(await protectionVerdict('fairplay', { secure: false, apple: false, probe: no }), NO_FAIRPLAY);
  assert.equal(await protectionVerdict('fairplay', { secure: true, probe: yes }), null);
  assert.equal(await protectionVerdict('clearkey', { secure: false, probe: yes }), NEED_SECURE);
  assert.equal(await protectionVerdict('clearkey', { secure: true, probe: no }), null); // its own path says why
  assert.equal(await protectionVerdict(null, { secure: false }), null, 'a plain channel');
});

test('protectionVerdict asks the probe for the right key system', async () => {
  const asked = [];
  const probe = async (k) => (asked.push(k), true);
  await protectionVerdict('widevine', { ios: false, secure: true, probe });
  await protectionVerdict('fairplay', { secure: true, probe });
  assert.deepEqual(asked, ['com.widevine.alpha', 'com.apple.fps']);
});

test('isIos: iPhone, iPad (also as a Mac with touch); not Android or a Mac', () => {
  const nav = (userAgent, platform = '', maxTouchPoints = 0) => ({ userAgent, platform, maxTouchPoints });
  assert.equal(isIos(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone', 5)), true);
  assert.equal(isIos(nav('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad', 5)), true);
  assert.equal(isIos(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'MacIntel', 5)), true, 'iPadOS asks for the desktop site');
  assert.equal(isIos(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 'MacIntel', 0)), false);
  assert.equal(isIos(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile Safari/537.36', 'Linux armv81', 5)), false);
});
