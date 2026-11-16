// Visual refresh Plan C: each theme's own rules, one table. A row says "in this theme, this token (optionally under a
// TV media or html attributes) must satisfy check(lch, map)". Every row runs in modern and legacy modes. Each Plan C
// task adds its rows here; check() throws (assert) with a plain sentence when the colour is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, MODES, ROOT, tokensOf, colourOf, lchOf } from './helpers/theme-resolve.js';

const hexOf = (map, name) => {
  const { r, g, b } = colourOf(map, name);
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
};

// { [theme]: [{ name, token, media?, attrs?, check(lch, map) }] }
export const RULES = {
  midnight: [
    ...Object.entries({ 1: '#101219', 2: '#151923', 3: '#1b1f2c', 4: '#212636', 5: '#272d3f', 6: '#2f364c' }).map(([n, hex]) => ({
      name: `n-${n} is ${hex} (within 1 per channel)`, token: `--n-${n}`,
      check: (lch, map) => {
        const got = colourOf(map, `--n-${n}`), want = colourOf(new Map([['--app-bg', '#000000'], ['--x', hex]]), '--x');
        for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(got[k] - want[k]) <= 1, `${k} is ${got[k]}, wanted ${want[k]} +-1`);
      },
    })),
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      name: `n-${n} is a slight hue (C 0.01-0.04)${n > 1 ? ` and lighter than n-${n - 1}` : ''}`, token: `--n-${n}`,
      check: (lch, map) => {
        // 0.04 plus 0.004 of 8-bit rounding (lchOf goes through a hex)
        assert.ok(lch.C >= 0.01 && lch.C <= 0.044, `chroma ${lch.C.toFixed(3)} is outside 0.01-0.04`);
        if (n > 1) assert.ok(lch.L > lchOf(map, `--n-${n - 1}`).L, 'is not lighter than the step before');
      },
    })),
    { name: '--text-high is n-12', token: '--text-high', check: (lch, map) => assert.equal(hexOf(map, '--text-high'), hexOf(map, '--n-12')) },
    { name: '--text-low is n-11', token: '--text-low', check: (lch, map) => assert.equal(hexOf(map, '--text-low'), hexOf(map, '--n-11')) },
    { name: 'no blur on glass', token: '--n-1', check: (lch, map) => assert.equal(map.get('--glass-blur'), '0px') },
    { name: 'the menu is solid (nav-bg alpha 1)', token: '--nav-bg', check: (lch, map) => assert.equal(colourOf(map, '--nav-bg').a, 1) },
    { name: 'raised surfaces have a top edge (--surface-edge is set, not the default no-op)', token: '--n-1', check: (lch, map) => {
      const v = map.get('--surface-edge');
      assert.ok(v && v !== 'none' && !/^0 0 0 0 transparent$/.test(v), `--surface-edge is ${v}`);
    } },
  ],
  orbit: [
    { name: 'the focus ring is white', token: '--focus-ring', check: (lch, map) => assert.equal(hexOf(map, '--focus-ring'), '#ffffff') },
  ],
};

test('THEMES is the 7 built-in theme folders', () => {
  assert.deepEqual(THEMES, ['arctic', 'arctic-side', 'daylight', 'harbour', 'midnight', 'obsidian', 'orbit']);
  const folders = fs.readdirSync(path.join(ROOT, 'themes'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(THEMES, folders, 'every folder under themes/ is a theme with a theme.json');
});

test('every rule names a built-in theme', () => {
  for (const t of Object.keys(RULES)) assert.ok(THEMES.includes(t), `RULES has "${t}", which is not a built-in theme`);
});

for (const [theme, rows] of Object.entries(RULES)) for (const mode of MODES) for (const row of rows) {
  test(`${theme} (${mode}): ${row.name}`, () => {
    const map = tokensOf(theme, mode, { attrs: row.attrs, media: row.media });
    const lch = lchOf(map, row.token);
    try { row.check(lch, map); } catch (e) {
      e.message = `${theme} ${row.token}${row.media ? ` under ${row.media}` : ''} in ${mode} mode: ${row.name} (L ${(lch.L * 100).toFixed(1)}%, C ${lch.C.toFixed(3)}, H ${lch.H.toFixed(0)}). ${e.message}`;
      throw e;
    }
  });
}
