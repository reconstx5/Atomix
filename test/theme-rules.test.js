// Visual refresh Plan C: each theme's own rules, one table. A row says "in this theme, this token (optionally under a
// TV media or html attributes) must satisfy check(lch, map)". Every row runs in modern and legacy modes. Each Plan C
// task adds its rows here; check() throws (assert) with a plain sentence when the colour is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { apcaContrast, wcagRatio } from '../src/themes/apca.js';
import { THEMES, MODES, ROOT, TV_MEDIA, tokensOf, colourOf, lchOf, baseCss, chainOf, themeFile } from './helpers/theme-resolve.js';

const hexOf = (map, name) => {
  const { r, g, b } = colourOf(map, name);
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
};

const parseAlpha = (v) => { const m = /rgba?\(([^)]+)\)/.exec(v || ''); const p = m ? m[1].split(/[,/\s]+/).filter(Boolean) : []; return p.length > 3 ? Number(p[3]) : 1; };


// Arctic and Arctic Side (Task 6): flat opaque surfaces, a regular-width body font, League Gothic for titles only, pill buttons.
function arcticRules(theme) {
  const chain = () => chainOf(themeFile(theme)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  return [
    ...['--surface-1', '--surface-2'].map((tok) => ({ name: `${tok} is opaque (flat)`, token: tok, check: (lch, map) => assert.equal(parseAlpha(map.get(tok)), 1) })),
    { name: '.panel, .search-box and .addon-tile have no backdrop-filter', token: '--n-1', check: () => {
      const bad = [];
      for (const m of chain().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/(^|[\s,])(\.panel|\.search-box|\.addon-tile)/.test(m[1]) && /backdrop-filter:\s*(?!none)/.test(m[2])) bad.push(m[1].trim());
      }
       assert.deepEqual(bad, [], `blur on ${bad.join('; ')}`);
    } },
    { name: '.panel, .search-box and .addon-tile paint --surface-1', token: '--n-1', check: () => {
      const css = chain().replace(/\s+/g, ' ');
      for (const sel of ['.panel', '.search-box', '.addon-tile']) assert.ok(css.split('}').some((r) => r.split('{')[0].split(',').some((x) => x.trim() === sel) && /background: var\(--surface-1\)/.test(r)), `${sel} does not use --surface-1`);
    } },
    { name: 'the body font is regular width (no Condensed or Narrow)', token: '--n-1', check: (lch, map) => assert.doesNotMatch(map.get('--font'), /Condensed|Narrow/) },
    { name: 'titles use League Gothic', token: '--n-1', check: (lch, map) => assert.match(map.get('--font-title'), /^"League Gothic"/) },
    { name: 'buttons are pills (--button-radius is 999px)', token: '--n-1', check: (lch, map) => assert.equal(map.get('--button-radius'), '999px') },
    { name: 'any url() in the theme points into /fonts/ and has an OFL licence file', token: '--n-1', check: () => {
      for (const m of chain().matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        if (/^\.\.\/[\w-]+\/theme\.css$/.test(m[1])) continue; // the @import of Arctic
        assert.match(m[1], /^\/fonts\//, `${m[1]} is not under /fonts/`);
        assert.ok(fs.readdirSync(path.join(ROOT, 'public/fonts')).some((f) => /^OFL/.test(f)), 'no OFL licence in public/fonts');
      }
    } },
    { name: 'the theme asks for the backdrop to follow focus (theme.json)', token: '--n-1', check: () => assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'themes', theme, 'theme.json'), 'utf8')).backdropFollowsFocus, true) },
  ];
}

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
  daylight: [
    { name: '--app-bg is an off-white (L 0.96-0.97)', token: '--app-bg', check: (lch) => assert.ok(lch.L >= 0.96 && lch.L <= 0.974, `L ${lch.L.toFixed(3)} is outside 0.96-0.97`) },
    { name: 'on a TV the canvas dims to about 90% lightness', token: '--app-bg', media: TV_MEDIA, check: (lch) => assert.ok(lch.L >= 0.886 && lch.L <= 0.914, `L ${lch.L.toFixed(3)} is outside 0.89-0.91`) },
    { name: 'on a TV the page colour --bg dims with it', token: '--bg', media: TV_MEDIA, check: (lch) => assert.ok(lch.L >= 0.886 && lch.L <= 0.914, `L ${lch.L.toFixed(3)} is outside 0.89-0.91`) },
    { name: 'on a TV --surface-1 is no lighter than 95%', token: '--surface-1', media: TV_MEDIA, check: (lch) => assert.ok(lch.L <= 0.954, `L ${lch.L.toFixed(3)} is above 0.95`) },
    { name: '--accent-solid is a darker step (L 0.45-0.55)', token: '--accent-solid', check: (lch) => assert.ok(lch.L >= 0.45 && lch.L <= 0.554, `L ${lch.L.toFixed(3)} is outside 0.45-0.55`) },
    { name: '--on-accent reads on --accent-solid (APCA Lc >= 60)', token: '--on-accent', check: (lch, map) => {
      const lc = Math.abs(apcaContrast(colourOf(map, '--on-accent'), colourOf(map, '--accent-solid')));
      assert.ok(lc >= 60, `Lc ${lc.toFixed(1)}`);
    } },
    { name: 'raised surfaces get their elevation from --shadow, not an edge line', token: '--surface-1', check: (lch, map) => {
      assert.ok(map.get('--shadow') && map.get('--shadow') !== 'none', `--shadow is ${map.get('--shadow')}`);
      assert.match(map.get('--surface-edge'), /^0 0 0 0 transparent$/, `--surface-edge is ${map.get('--surface-edge')}`);
    } },
    { name: 'the focus halo is light (white at 90%), so the ring separates from video black', token: '--focus-ring', check: (lch, map) => {
      assert.equal(map.get('--focus-halo').replace(/\s+/g, ''), 'rgba(255,255,255,0.9)');
    } },
    { name: 'the halo reaches 2px past the ring (1px wider than the default)', token: '--focus-ring', check: (lch, map) => {
      assert.match(map.get('--focus-halo-ring'), /\+ 2px\)/, `--focus-halo-ring is ${map.get('--focus-halo-ring')}`);
      assert.match(map.get('--focus-halo-inset'), /\+ 2px\)/, `--focus-halo-inset is ${map.get('--focus-halo-inset')}`);
    } },
    ...[undefined, TV_MEDIA].map((media) => ({ name: `--rating (amber) reads at 4.5:1 on a canvas 3% darker than --app-bg${media ? ' (TV)' : ''}`, token: '--rating', media, check: (lch, map) => {
      const bg = colourOf(map, '--app-bg'), dark = { r: bg.r * 0.97, g: bg.g * 0.97, b: bg.b * 0.97, a: 1 };
      const r = wcagRatio(colourOf(map, '--rating'), dark);
      assert.ok(r >= 4.5, `ratio ${r.toFixed(2)}`);
    } })),
    ...[undefined, TV_MEDIA].map((media) => ({ name: `the focus ring is at least 3:1 on the canvas${media ? ' (TV)' : ''}`, token: '--focus-ring', media, check: (lch, map) => {
      const r = wcagRatio(colourOf(map, '--focus-ring'), colourOf(map, '--app-bg'));
      assert.ok(r >= 3, `ratio ${r.toFixed(2)}`);
    } })),
  ],
  arctic: arcticRules('arctic'),
  'arctic-side': arcticRules('arctic-side'),
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
