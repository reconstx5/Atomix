// Captions under wide cards (public/js/components.js). Older themes show "S1 · E4 · Title";
// Orbit shows how much is left ("S1 · E4, 23m left"), since the top area already names the episode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wideCaption, episodeCaption } from '../public/js/components.js';

test('wide cards: the classic caption and the time-left caption', () => {
  const ep = { kind: 'episode', showTitle: 'Night Harbour', title: 'The Quiet Tide', season: 1, episode: 4, duration: 2880, progress: { position: 1500, duration: 2880, watched: false } };
  assert.deepEqual(wideCaption(ep), { title: 'Night Harbour', sub: 'S1 · E4 · The Quiet Tide', left: 'S1 · E4, 23 min left' });
  const movie = { kind: 'movie', title: 'Northlight', year: 2022, duration: 6660, progress: { position: 1980, duration: 6660, watched: false } };
  assert.deepEqual(wideCaption(movie), { title: 'Northlight', sub: '2022', left: '1h 18m left' });
});

test('not started or already watched: no time left', () => {
  assert.deepEqual(wideCaption({ kind: 'movie', title: 'New', year: 2024 }), { title: 'New', sub: '2024', left: '2024' });
  assert.equal(wideCaption({ kind: 'episode', showTitle: 'S', title: 'Pilot', season: 2, episode: 1, duration: 600, progress: { position: 590, watched: true } }).left, 'S2 · E1, Watched');
  assert.equal(wideCaption({ kind: 'movie', title: 'Barely', year: 2020, duration: 600, progress: { position: 12 } }).left, '2020', 'under 30 seconds is not started');
});

test('episodeCaption says Watched, N min left, or the running time', () => {
  assert.equal(episodeCaption({ kind: 'episode', progress: { watched: true, position: 0 }, duration: 2000 }), 'Watched');
  assert.equal(episodeCaption({ kind: 'episode', progress: { position: 600, duration: 2000 } }), '24 min left');
  assert.equal(episodeCaption({ kind: 'episode', progress: { position: 1995, duration: 2000 } }), '1 min left');
  assert.equal(episodeCaption({ kind: 'episode', progress: { position: 10 }, runtime: 42 }), '42m');
  assert.equal(episodeCaption({ kind: 'episode', duration: 1500 }), '25m');
  assert.equal(episodeCaption({ kind: 'episode' }), '');
});

test('wide cards: episodes use the same caption after the label', () => {
  const ep = { kind: 'episode', showTitle: 'S', title: 'T', season: 1, episode: 4, duration: 2880, progress: { position: 1500, duration: 2880, watched: false } };
  assert.equal(wideCaption(ep).left, 'S1 · E4, 23 min left');
  assert.equal(wideCaption({ ...ep, progress: { position: 2800, watched: true } }).left, 'S1 · E4, Watched');
  assert.equal(wideCaption({ ...ep, progress: null }).left, 'S1 · E4');
});
