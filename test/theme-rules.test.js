// Visual refresh Plan C: each theme's own rules, one table. A row says "in this theme, this token (optionally under a
// TV media or html attributes) must satisfy check(lch, map)". Every row runs in modern and legacy modes. Each Plan C
// task adds its rows here; check() throws (assert) with a plain sentence when the colour is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, MODES, ROOT, TV_MEDIA, tokensOf, colourOf, lchOf, baseCss } from './helpers/theme-resolve.js';

const hexOf = (map, name) => {
  const { r, g, b } = colourOf(map, name);
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
};

const parseAlpha = (v) => { const m = /rgba?\(([^)]+)\)/.exec(v || ''); const p = m ? m[1].split(/[,/\s]+/).filter(Boolean) : []; return p.length > 3 ? Number(p[3]) : 1; };

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
  obsidian: [
    { name: '--text-high is about 90% light (OLED: no glare)', token: '--text-high', check: (lch) => assert.ok(lch.L >= 0.886 && lch.L <= 0.914, `L ${lch.L.toFixed(3)} is outside 0.89-0.91`) },
    { name: '--app-bg is true black', token: '--app-bg', check: (lch, map) => assert.equal(hexOf(map, '--app-bg'), '#000000') },
    { name: '--app-bg is true black with data-oled', token: '--app-bg', attrs: { 'data-oled': '' }, check: (lch, map) => assert.equal(hexOf(map, '--app-bg'), '#000000') },
    { name: '--border-subtle is a hairline colour (alpha <= 0.12 or L <= 0.30)', token: '--border-subtle', check: (lch, map) => {
      const a = parseAlpha(map.get('--border-subtle'));
      assert.ok(a <= 0.12 || lch.L <= 0.304, `alpha ${a}, L ${lch.L.toFixed(3)}`);
    } },
    { name: 'card edge and panel borders are 1px and the theme does not widen them', token: '--n-1', check: () => {
      const base = baseCss(), theme = fs.readFileSync(path.join(ROOT, 'themes/obsidian/theme.css'), 'utf8');
      assert.match(base, /data-oled\] :is\([^)]*\.panel[^)]*\.card-art\)::after\s*\{[^}]*inset 0 0 0 1px var\(--border-subtle\)/, 'card-art::after is not a 1px edge');
      assert.match(base, /^\.panel\s*\{[^}]*border: 1px solid/m, '.panel border is not 1px');
      assert.doesNotMatch(theme, /(card-art|\.panel)[^{]*\{[^}]*(border|box-shadow)/, 'the theme restyles the card edge or panel border');
    } },
    { name: 'the focus ring is the accent', token: '--focus-ring', check: (lch, map) => assert.equal(hexOf(map, '--focus-ring'), hexOf(map, '--accent-solid')) },
    { name: 'the focus ring is at least 3:1 on black', token: '--focus-ring', check: (lch, map) => {
      const { r, g, b } = colourOf(map, '--focus-ring'), f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const y = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      assert.ok((y + 0.05) / 0.05 >= 3, `contrast ${((y + 0.05) / 0.05).toFixed(2)}`);
    } },
    { name: 'the focus halo is transparent (flat ring, no glow)', token: '--focus-ring', check: (lch, map) => assert.equal(map.get('--focus-halo'), 'transparent') },
    { name: 'the focus ring is 4px', token: '--focus-ring', check: (lch, map) => assert.equal(map.get('--focus-width'), '4px') },
    { name: 'the focus ring is 5px on a TV', token: '--focus-ring', media: TV_MEDIA, check: (lch, map) => assert.equal(map.get('--focus-width'), '5px') },
    { name: "card motion's glow layer is hidden (the lift stays)", token: '--n-1', check: () => {
      const theme = fs.readFileSync(path.join(ROOT, 'themes/obsidian/theme.css'), 'utf8');
      assert.match(theme.replace(/\s+/g, ' '), /:is\(\.row-scroller, \.grid\) > :is\(\.poster-card, \.landscape-card:not\(\.live-card\)\)::before \{[^}]*display: none/, 'the glow ::before is not display: none');
      assert.doesNotMatch(theme, /--card-lift/, 'the theme changes --card-lift');
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
