// Card motion v2 (v0.28): the rules for selecting a card that need no page (public/js/card-motion-rules.js) —
// the one-line info strip under a selected poster, the card's colour, and the sheen that crosses a card once per visit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardInfoLine, cardLabel, cardTint, sheenLedger } from '../public/js/card-motion-rules.js';

test('info line: a film says its year, rating and running time', () => {
  assert.equal(cardInfoLine({ kind: 'movie', year: 2019, certification: 'PG-13', runtime: 112 }), '2019 · PG-13 · 1 h 52 m');
  assert.equal(cardInfoLine({ kind: 'movie', year: 2019, duration: 112 * 60 }), '2019 · 1 h 52 m', 'the file length when there is no runtime');
  assert.equal(cardInfoLine({ kind: 'movie', year: 2019, runtime: 45 }), '2019 · 45 m');
  assert.equal(cardInfoLine({ kind: 'movie', year: 2019, runtime: 120 }), '2019 · 2 h');
  assert.equal(cardInfoLine({ kind: 'movie', title: 'No facts' }), '');
});

test('info line: an episode says where it sits and how long it is', () => {
  assert.equal(cardInfoLine({ kind: 'episode', season: 2, episode: 4, runtime: 45 }), 'S2 · E4 · 45 m');
  assert.equal(cardInfoLine({ kind: 'episode', season: 2, episode: 4, duration: 2700 }), 'S2 · E4 · 45 m');
  assert.equal(cardInfoLine({ kind: 'episode', season: 0, episode: 3 }), 'Special 3');
  assert.equal(cardInfoLine({ kind: 'episode', season: 1, episode: null, runtime: 30 }), '30 m');
});

test('info line: a show says its first year and how many seasons (or episodes) it has', () => {
  assert.equal(cardInfoLine({ kind: 'show', year: 2014, seasonCount: 3 }), '2014 · 3 seasons');
  assert.equal(cardInfoLine({ kind: 'show', year: 2014, seasonCount: 1 }), '2014 · 1 season');
  assert.equal(cardInfoLine({ kind: 'show', year: 2014, childCount: 24 }), '2014 · 24 episodes', 'cards carry the episode count');
  assert.equal(cardInfoLine({ kind: 'show', childCount: 1 }), '1 episode');
});

test('info line: other kinds of card carry none', () => {
  assert.equal(cardInfoLine({ kind: 'album', year: 2001 }), '');
  assert.equal(cardInfoLine(null), '');
});

test('card colour: the poster colour for poster cards, the backdrop colour for wide cards, nothing when unknown', () => {
  const item = { tint: '#aa3300', tintWide: '#0033aa' };
  assert.equal(cardTint(item, 'poster'), '#aa3300');
  assert.equal(cardTint(item, 'landscape'), '#0033aa');
  assert.equal(cardTint({ tint: null }, 'poster'), null);
  assert.equal(cardTint({ tint: 'red; background: url(x)' }, 'poster'), null, 'only a plain #rrggbb colour reaches the style');
  assert.equal(cardTint(undefined, 'poster'), null);
});

test('sheen: once per card per page visit, again after the page changes', () => {
  const sheen = sheenLedger();
  assert.equal(sheen.take(7), true, 'the first selection of a card');
  assert.equal(sheen.take(7), false, 'not again on the same page');
  assert.equal(sheen.take(8), true, 'another card has its own');
  sheen.reset(); // a route change
  assert.equal(sheen.take(7), true);
  assert.equal(sheen.take(null), false, 'a card without an id never shines');
});

test("the poster card's spoken name carries the info line (the aria-label replaces the card's contents)", () => {
  const film = { kind: 'movie', title: 'Red Canyon', year: 2019, certification: 'PG-13', runtime: 112 };
  assert.equal(cardLabel(film), 'Red Canyon, 2019, PG-13, 1 h 52 m', 'the year is said once, in the line');
  assert.ok(cardLabel(film).includes(cardInfoLine(film).split(' · ').join(', ')));
  assert.equal(cardLabel(film, ', watched'), 'Red Canyon, 2019, PG-13, 1 h 52 m, watched');
  assert.equal(cardLabel({ kind: 'episode', title: 'Pilot', year: 2014, season: 2, episode: 4, runtime: 45 }), 'Pilot (2014), S2, E4, 45 m', 'a year the line lacks stays');
  assert.equal(cardLabel({ kind: 'show', title: 'Bay', year: 2014, childCount: 24 }, ', 3 unwatched'), 'Bay, 2014, 24 episodes, 3 unwatched');
  assert.equal(cardLabel({ kind: 'season', title: 'Season 1', year: 2014 }), 'Season 1 (2014)', 'no line: as before');
  assert.equal(cardLabel({ kind: 'movie', title: 'Untitled' }), 'Untitled');
});
