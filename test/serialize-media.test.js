import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSummary } from '../src/api/serialize.js';

const video = (extra) => ({ video: { codec: 'hevc', height: 2160, width: 3840, hdr: false, colour: { transfer: null }, dolbyVision: null, ...extra }, audio: [], subtitles: [] });

test('HDR format: Dolby Vision, HDR10, HLG or none', () => {
  assert.equal(mediaSummary(video({ hdr: true, colour: { transfer: 'smpte2084' }, dolbyVision: { profile: 8 } })).hdrFormat, 'Dolby Vision');
  assert.equal(mediaSummary(video({ hdr: true, colour: { transfer: 'smpte2084' } })).hdrFormat, 'HDR10');
  assert.equal(mediaSummary(video({ hdr: true, colour: { transfer: 'arib-std-b67' } })).hdrFormat, 'HLG');
  assert.equal(mediaSummary(video({})).hdrFormat, null);
});

test('Atmos from an audio track\'s profile or title', () => {
  const m = video({});
  m.audio = [{ index: 0, codec: 'eac3', profile: 'Dolby Digital Plus + Dolby Atmos', channels: 6 }];
  assert.equal(mediaSummary(m).atmos, true);
  m.audio = [{ index: 0, codec: 'truehd', profile: null, title: 'English Atmos 7.1', channels: 8 }];
  assert.equal(mediaSummary(m).atmos, true);
  m.audio = [{ index: 0, codec: 'aac', channels: 2 }];
  assert.equal(mediaSummary(m).atmos, false);
});
