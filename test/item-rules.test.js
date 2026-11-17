// The title page's rules (public/js/item-rules.js): resume point, which season opens, where Orbit's episode row starts,
// the admin intro line, and "watched".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeInfo, selectedSeasonId, rowStartEpisode, introText, isWatched } from '../public/js/item-rules.js';

test('resumeInfo: nothing to resume without progress, when watched, or under 30 s in', () => {
  assert.equal(resumeInfo({ duration: 6000, progress: null }), null);
  assert.equal(resumeInfo({ duration: 6000, progress: { position: 1800, watched: true } }), null);
  assert.equal(resumeInfo({ duration: 6000, progress: { position: 29 } }), null);
});

test('resumeInfo: 30 s in is kept, with the time left from the progress duration first', () => {
  assert.deepEqual(resumeInfo({ duration: 6000, progress: { position: 30 } }), { position: 30, left: 5970 });
  assert.deepEqual(resumeInfo({ duration: 6000, progress: { position: 1800, duration: 5000 } }), { position: 1800, left: 3200 });
});

test('resumeInfo: time left is never below 0, and null with no duration', () => {
  assert.deepEqual(resumeInfo({ duration: 100, progress: { position: 200 } }), { position: 200, left: 0 });
  assert.deepEqual(resumeInfo({ progress: { position: 200 } }), { position: 200, left: null });
});

const SEASONS = [{ id: 20, season: 0 }, { id: 21, season: 1 }, { id: 22, season: 2 }];

test('selectedSeasonId: the address season when it is one of the show’s', () => {
  assert.equal(selectedSeasonId(SEASONS, { query: { season: '22' }, nextEpisode: { parentId: 21 } }), 22);
});

test('selectedSeasonId: an address season that isn’t the show’s falls through to the next episode’s season', () => {
  assert.equal(selectedSeasonId(SEASONS, { query: { season: '999' }, nextEpisode: { parentId: 22 } }), 22);
});

test('selectedSeasonId: then the first numbered season, then the first, then null', () => {
  assert.equal(selectedSeasonId(SEASONS, { query: {} }), 21);
  assert.equal(selectedSeasonId([{ id: 20, season: 0 }], { query: {} }), 20);
  assert.equal(selectedSeasonId([], { query: {} }), null);
});

const ep = (id, progress) => ({ id, duration: 2700, progress });

test('rowStartEpisode: the one to resume first', () => {
  const eps = [ep(1, { watched: true }), ep(2, null), ep(3, { position: 900 })];
  assert.equal(rowStartEpisode(eps).id, 3);
});

test('rowStartEpisode: else the first not watched, else the first', () => {
  assert.equal(rowStartEpisode([ep(1, { watched: true }), ep(2, null)]).id, 2);
  assert.equal(rowStartEpisode([ep(1, { watched: true }), ep(2, { watched: true })]).id, 1);
  assert.equal(rowStartEpisode([]), undefined);
});

test('introText: not found, none, and where it is with how it was found', () => {
  assert.equal(introText(undefined), 'Intro not found yet');
  assert.equal(introText({}), 'Intro not found yet');
  assert.equal(introText({ intro: { none: true } }), 'No intro');
  assert.equal(introText({ intro: { start: 42, end: 92, source: 'audio' } }), 'Intro 0:42–1:32 · found automatically');
  assert.equal(introText({ intro: { start: 42, end: 92, source: 'chapter' } }), 'Intro 0:42–1:32 · from chapters');
  assert.equal(introText({ intro: { start: 42, end: 92, source: 'manual' } }), 'Intro 0:42–1:32 · set by hand');
});

test('isWatched: a show when nothing is left unwatched; anything else by its progress', () => {
  assert.equal(isWatched({ kind: 'show', unwatched: 0 }), true);
  assert.equal(isWatched({ kind: 'show', unwatched: 3 }), false);
  assert.equal(isWatched({ kind: 'movie', progress: { watched: true } }), true);
  assert.equal(isWatched({ kind: 'episode', progress: null }), false);
});

test('selectedSeasonId: a next episode in a season that isn’t listed falls through to the first numbered season', () => {
  assert.equal(selectedSeasonId(SEASONS, { query: {}, nextEpisode: { parentId: 77 } }), 21);
});
