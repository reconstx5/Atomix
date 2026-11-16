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
