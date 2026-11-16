// Even volume (v0.28): each song's loudness is measured once in the background (EBU R128, as ReplayGain 2 uses) and
// the music player levels songs to the same loudness; music apps get it as OpenSubsonic's replayGain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { parseEbur128, levelGain, replayGainOf } from '../src/library/loudness.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

test('the loudness summary ffmpeg prints is read', () => {
  const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -9.8 LUFS\n    Threshold: -20.1 LUFS\n\n  Loudness range:\n    LRA:         5.2 LU\n\n  True peak:\n    Peak:       -0.3 dBFS\n`;
  assert.deepEqual(parseEbur128(stderr), { i: -9.8, tp: -0.3 });
  assert.equal(parseEbur128('nothing here'), null);
  assert.deepEqual(parseEbur128('    I:         -70.0 LUFS\n    Peak:       -inf dBFS'), null, 'silence is not measured');
});

test('the gain that brings a song to -16 LUFS: turned down freely, turned up a little, never past its peak', () => {
  assert.equal(levelGain({ i: -9.8, tp: -0.3 }), -6.2);
  assert.equal(levelGain({ i: -20, tp: -6 }), 4, 'a quiet song is lifted');
  assert.equal(levelGain({ i: -20, tp: -1 }), 0, 'but never past 0 dBFS peak (it would clip)');
  assert.equal(levelGain({ i: -40, tp: -20 }), 6, 'at most +6 dB');
  assert.equal(levelGain({ i: 0, tp: 0 }), -12, 'at most -12 dB');
  assert.equal(levelGain(null), 0);
});

test('music apps get ReplayGain 2 values (reference -18 LUFS, peak as a ratio)', () => {
  assert.deepEqual(replayGainOf({ i: -9.8, tp: -0.3 }), { trackGain: -8.2, trackPeak: 0.966 });
  assert.equal(replayGainOf(null), undefined);
});

let nf, admin;
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  makeAudio(path.join(media, 'Music', 'Band', 'Album', '01 - Loud.flac'), { seconds: 4, tags: { title: 'Loud', artist: 'Band', album: 'Album', track: '1' } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(admin);
});
after(async () => nf?.app.stop());

test('the background job measures a song, and its playback says how loud it is', { skip }, async () => {
  const db = nf.app.core.db;
  const song = db.get("SELECT * FROM items WHERE kind = 'track'");
  assert.equal(nf.app.core.extras.nextLoudnessItem()?.id, song.id, 'waiting to be measured');
  await nf.app.core.tasks.jobs.loudness(song, {});
  const m = JSON.parse(db.get('SELECT media FROM items WHERE id = ?', song.id).media).loudness;
  assert.ok(m.i < -5 && m.i > -40, JSON.stringify(m));
  assert.equal(nf.app.core.extras.nextLoudnessItem(), null, 'measured once');
  const play = await admin.post(`/api/items/${song.id}/playback`, { caps: { audio: ['flac', 'aac', 'mp3'], containers: ['mp4'] } });
  assert.equal(play.data.loudness, m.i);
  assert.equal(play.data.levelDb, levelGain(m), 'and the gain the player applies');
  await admin.post(`/api/playback/${play.data.sessionId}/stop`, {});
});

test('a measured song carries replayGain in the music apps\' song entry', async () => {
  const { song } = await import('../src/subsonic/shapes.js');
  const entry = song({ id: 5, parent_id: 2, title: 'S', path: '/m/a/s.flac', media: JSON.stringify({ loudness: { i: -9.8, tp: -0.3 } }) });
  assert.deepEqual(entry.replayGain, { trackGain: -8.2, trackPeak: 0.966 });
  assert.equal(song({ id: 6, parent_id: 2, title: 'T', path: '/m/a/t.flac', media: '{}' }).replayGain, undefined);
});
