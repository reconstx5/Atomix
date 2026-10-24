// Orbit's Movies and TV Shows page (v0.25): the A–Z rail's letters and jumps, what counts as in progress, the
// header's count, where the spotlight starts and what its Play button says. No DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { letterOf, railLetters, jumpIndex, railShown, inProgress, posterFraction, countLine, spotStartItem, playFor } from '../public/js/library-rules.js';

test('letters ignore "The", accents fold, digits and symbols are #', () => {
  const L = (title, sortTitle) => letterOf({ title, sortTitle });
  assert.equal(L('The Matrix'), 'M');
  assert.equal(L('Émile'), 'E');
  assert.equal(L('12 Monkeys'), '#');
  assert.equal(L('¡Three Amigos!'), 'T'); // punctuation dropped first, as the server's sort title does
  assert.equal(L('Kill Bill', 'bill kill'), 'B', 'an edited sort title wins');
  assert.equal(L('東京物語'), '#');
});
test('rail letters follow the list and a letter jumps to its first title', () => {
  const items = ['12 Monkeys', 'Alien', 'Aliens', 'The Birds', 'Casablanca'].map((title) => ({ title }));
  assert.deepEqual(railLetters(items), ['#', 'A', 'B', 'C']);
  assert.equal(jumpIndex(items, 'B'), 3);
  assert.equal(jumpIndex(items, 'Z'), -1);
  // Accented titles sort after Z in the list (the server's sort title keeps the accent); the rail still reads # A–Z.
  assert.deepEqual(railLetters([{ title: 'Alien' }, { title: 'Tron' }, { title: 'Émile' }]), ['A', 'E', 'T']);
  assert.equal(jumpIndex([{ title: 'Alien' }, { title: 'Tron' }, { title: 'Émile' }], 'E'), 2);
});
test('the rail shows only for A–Z, 20 or more titles and no search', () => {
  assert.equal(railShown({ sort: 'title', q: '', count: 20 }), true);
  assert.equal(railShown({ sort: 'title', q: '', count: 19 }), false);
  assert.equal(railShown({ sort: 'added', q: '', count: 99 }), false);
  assert.equal(railShown({ sort: 'title', q: 'al', count: 99 }), false);
});
test('in progress, the poster line and the count', () => {
  const film = { kind: 'movie', duration: 6000, progress: { position: 1500, duration: 6000, watched: false } };
  const show = { kind: 'show', childCount: 10, unwatched: 4 };
  assert.equal(inProgress(film), true);
  assert.equal(inProgress({ ...film, progress: { ...film.progress, watched: true } }), false);
  assert.equal(inProgress({ kind: 'show', childCount: 10, unwatched: 10 }), false);
  assert.equal(posterFraction(film), 0.25);
  assert.equal(posterFraction(show), 0.6);
  assert.equal(countLine(42, 3, ['show', 'shows']), '42 shows · 3 in progress');
  assert.equal(countLine(1, 0, ['movie', 'movies']), '1 movie');
});
test('the spotlight starts on the most recent title in this library', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(spotStartItem(items, [{ id: 9, at: 5 }, { id: 3, at: 4 }]).id, 3);
  assert.equal(spotStartItem(items, []).id, 1);
  assert.equal(spotStartItem([], []), null);
});
test('Play, Resume and the next episode', () => {
  const film = { id: 7, kind: 'movie', progress: { position: 900, duration: 6000, watched: false } };
  assert.deepEqual(playFor(film, null), { label: 'Resume', href: '#/play/7', position: 900, duration: 6000 });
  const show = { id: 5, kind: 'show', childCount: 10, unwatched: 8 };
  const e = { id: 51, season: 1, episode: 3, duration: 1800, progress: { position: 600, duration: 1800, watched: false } };
  assert.equal(playFor(show, { nextEpisode: e }).label, 'Resume S1 · E3');
  assert.equal(playFor(show, { nextEpisode: { ...e, episode: 4, progress: null } }).label, 'Play S1 · E4');
  assert.equal(playFor({ ...show, unwatched: 10 }, { nextEpisode: { ...e, progress: null } }).label, 'Play');
  assert.equal(playFor(show, null), null);
});
