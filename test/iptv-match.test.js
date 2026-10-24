// IPTV Simple: matching playlist channels to guide channels (plugins/iptv-simple/match.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGuide, normaliseName } from '../plugins/iptv-simple/match.js';

const guide = new Map([
  ['tvnz1.nz', ['TVNZ 1', 'TVNZ1']],
  ['Three.NZ', ['Three']],
  ['maori.nz', ['Maori TV']],
  ['sky.sport1', ['Sky Sport 1']],
]);

test('tvg-id exact, then case-insensitive', () => {
  const m = matchGuide([{ key: 'a', name: 'Whatever', tvgId: 'tvnz1.nz' }, { key: 'b', name: 'Nope', tvgId: 'three.nz' }], guide);
  assert.equal(m.get('a'), 'tvnz1.nz');
  assert.equal(m.get('b'), 'Three.NZ');
});

test('name against display names: "TVNZ 1 HD" ↔ "TVNZ1", "Māori TV" ↔ "Maori TV"', () => {
  const m = matchGuide(
    [
      { key: 'a', name: 'TVNZ 1 HD' },
      { key: 'b', name: 'Māori TV' },
      { key: 'c', name: 'Sky Sport 1 FHD' },
      { key: 'd', name: 'x', tvgName: 'Sky Sport 1' },
      { key: 'e', name: 'three 4k' },
    ],
    guide,
  );
  assert.equal(m.get('a'), 'tvnz1.nz');
  assert.equal(m.get('b'), 'maori.nz');
  assert.equal(m.get('c'), 'sky.sport1');
  assert.equal(m.get('d'), 'sky.sport1', 'tvg-name before the channel name');
  assert.equal(m.get('e'), 'Three.NZ');
});

test('unmatched channels stay out of the map', () => {
  const m = matchGuide([{ key: 'z', name: 'Unknown Channel', tvgId: 'nope' }], guide);
  assert.equal(m.has('z'), false);
});

test('normaliseName strips accents, punctuation, spaces and a quality suffix', () => {
  assert.equal(normaliseName('Māori  TV (HD)'), 'maoritv');
  assert.equal(normaliseName('TVNZ-1 UHD'), 'tvnz1');
  assert.equal(normaliseName('Prime'), 'prime');
});
