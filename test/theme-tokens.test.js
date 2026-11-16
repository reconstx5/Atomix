// Visual refresh Plan A, task 2: the token layers (public/css/tokens.css + each theme's --n-*/--a-* ramps).
// Every built-in theme resolves the semantic set, keeps today's old-name colours, meets the APCA thresholds, has an
// oklch value for every hex step, and no var() cycle; an old-names-only theme still wins; component CSS gains no raw
// colours. UPDATE_RAW_COLOURS=1 lowers counts in test/fixtures/raw-colours.json (never raises them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readThemeTokens, composite } from '../src/themes/tokens.js';
import { apcaContrast, wcagRatio, parseColor } from '../src/themes/apca.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const THEMES = ['arctic', 'arctic-side', 'daylight', 'harbour', 'midnight', 'obsidian', 'orbit'];
const MODES = ['modern', 'legacy']; // legacy = a browser without oklch() (old TVs): @supports blocks don't apply
const SEMANTIC = ['--app-bg', '--surface-1', '--surface-2', '--surface-3', '--border-subtle', '--border-strong', '--text-high',
  '--text-low', '--accent-solid', '--accent-hover', '--on-accent', '--focus-ring', '--danger', '--success'];
const OLD_COLOURS = ['--bg', '--bg-2', '--surface', '--surface-2', '--border', '--text', '--text-dim', '--accent', '--accent-text', '--danger', '--success'];
const OTHER = ['--radius', '--radius-lg', '--shadow', '--nav-bg', '--font', '--font-display', '--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl',
  '--r-full', '--focus-width', '--focus-offset', '--card-radius', '--poster-aspect', '--wide-aspect', '--row-gap', '--glass-alpha', '--glass-blur'];
const SURFACES = ['--app-bg', '--surface-1', '--surface-2', '--surface-3'];
// Painted old names moved to their passing ramp steps (fix round 1); everything else keeps today's value.
const RETUNED = {
  '--text-dim': ['arctic', 'arctic-side', 'daylight', 'harbour', 'midnight', 'obsidian', 'orbit'],
  '--accent': ['midnight', 'obsidian', 'harbour'],
  '--accent-text': ['arctic', 'arctic-side', 'daylight', 'harbour', 'midnight', 'obsidian', 'orbit'],
};
const OLD_SURFACES = ['--bg', '--bg-2', '--surface', '--surface-2'];

// The stylesheets in the order index.html loads them, then the theme (and what it @imports, first).
const baseCss = () => ['public/css/tokens.css', 'public/css/app.css', 'public/css/orbit.css'].map(read).join('\n');
const layoutOf = (t) => JSON.parse(read(`themes/${t}/theme.json`)).layout;
function chainOf(file) {
  const css = fs.readFileSync(file, 'utf8');
  const imp = /@import\s+url\(["']?([^"')]+)["']?\)/.exec(css);
  return imp ? [...chainOf(path.resolve(path.dirname(file), imp[1])), file] : [file];
}
function resolve(themeFile, { supports = 'modern', layout = 'top', base = baseCss(), attrs = {}, classes = [] } = {}) {
  const context = { attrs: { 'data-layout': layout, ...attrs }, classes, supports };
  let m = base;
  for (const f of chainOf(themeFile)) m = readThemeTokens(fs.readFileSync(f, 'utf8'), { base: m, context });
  return m;
}
const themeFile = (t) => path.join(ROOT, 'themes', t, 'theme.css');
const tokensOf = (t, supports, extra = {}) => resolve(themeFile(t), { supports, layout: layoutOf(t), ...extra });

const colour = (m, name) => {
  const c = parseColor(m.get(name) ?? '');
  assert.ok(c, `${name} is a colour (got ${m.get(name)})`);
  return c;
};
const opaque = (c, under) => (c.a < 1 ? composite(c, under) : c);
const lc = (text, bg) => Math.abs(apcaContrast(opaque(text, bg), bg));
const near = (a, b, msg) => {
  for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(a[k] - b[k]) <= 1, `${msg}: ${k} ${a[k]} vs ${b[k]}`);
  assert.ok(Math.abs((a.a ?? 1) - (b.a ?? 1)) < 0.002, `${msg}: alpha`);
};

test('tokens.css is loaded before app.css, orbit.css and the theme', () => {
  const html = read('public/index.html');
  const at = (s) => html.indexOf(s);
  assert.ok(at('/css/tokens.css') > 0, 'linked');
  assert.ok(at('/css/tokens.css') < at('/css/app.css'));
  assert.ok(at('/css/app.css') < at('/css/orbit.css') && at('/css/orbit.css') < at('id="theme-css"'));
});

for (const t of THEMES) for (const supports of MODES) {
  test(`${t} (${supports}): the semantic, old and component tokens all resolve`, () => {
    const m = tokensOf(t, supports);
    for (const n of [...SEMANTIC, ...OLD_COLOURS]) colour(m, n);
    for (const n of OTHER) assert.ok(m.get(n), `${n} resolves`);
    for (let i = 1; i <= 12; i++) { colour(m, `--n-${i}`); colour(m, `--a-${i}`); }
  });

  test(`${t} (${supports}): old token names keep today's colours (except the ones retuned for contrast)`, () => {
    const was = JSON.parse(read('test/fixtures/old-theme-tokens.json'))[t];
    const m = tokensOf(t, supports);
    for (const [n, v] of Object.entries(was)) {
      if (RETUNED[n]?.includes(t)) continue;
      const a = parseColor(v);
      if (a) near(colour(m, n), a, `${t} ${n}`);
      else assert.equal(m.get(n), v, `${t} ${n}`);
    }
  });

  test(`${t} (${supports}): APCA and focus contrast`, () => {
    const m = tokensOf(t, supports);
    const bg = colour(m, '--app-bg');
    for (const s of SURFACES) {
      const under = opaque(colour(m, s), bg);
      assert.ok(lc(colour(m, '--text-high'), under) >= 75, `--text-high on ${s}: Lc ${lc(colour(m, '--text-high'), under).toFixed(1)}`);
      assert.ok(lc(colour(m, '--text-low'), under) >= 60, `--text-low on ${s}: Lc ${lc(colour(m, '--text-low'), under).toFixed(1)}`);
    }
    const solid = opaque(colour(m, '--accent-solid'), bg);
    assert.ok(lc(colour(m, '--on-accent'), solid) >= 60, `--on-accent on --accent-solid: Lc ${lc(colour(m, '--on-accent'), solid).toFixed(1)}`);
    const ring = opaque(colour(m, '--focus-ring'), bg);
    assert.ok(wcagRatio(ring, bg) >= 3, `--focus-ring vs --app-bg: ${wcagRatio(ring, bg).toFixed(2)}:1`);
  });

  // The names the stylesheets actually paint with (--text-dim has ~70 uses; buttons are --accent-text on --accent).
  test(`${t} (${supports}): APCA on the painted old names`, () => {
    const m = tokensOf(t, supports);
    const bg = colour(m, '--bg');
    for (const s of OLD_SURFACES) {
      const under = opaque(colour(m, s), bg);
      assert.ok(lc(colour(m, '--text'), under) >= 75, `--text on ${s}: Lc ${lc(colour(m, '--text'), under).toFixed(1)}`);
      assert.ok(lc(colour(m, '--text-dim'), under) >= 60, `--text-dim on ${s}: Lc ${lc(colour(m, '--text-dim'), under).toFixed(1)}`);
    }
    const acc = opaque(colour(m, '--accent'), bg);
    assert.ok(lc(colour(m, '--accent-text'), acc) >= 60, `--accent-text on --accent: Lc ${lc(colour(m, '--accent-text'), acc).toFixed(1)}`);
  });
}

// Orbit's glass. The environment (sign-in, profiles, music) is the artwork under a veil of the page colour
// (theme.css `.environment::after`: color-mix(--bg 50%)), so its darkest point is black art and its lightest white art,
// each under that veil. Solid glass is --glass-solid; Tinted glass is the --glass-tinted colour at .55 (the spec's figure,
// inside the .5–.66 the theme's glass tokens use).
test('orbit: text tokens on Solid and Tinted glass over the darkest and lightest environment', () => {
  for (const supports of MODES) {
    const m = tokensOf('orbit', supports);
    const css = read('themes/orbit/theme.css');
    const veil = /\.environment::after\s*\{[^}]*color-mix\(in srgb, var\(--bg\) (\d+)%, transparent\)\s*;/.exec(css);
    assert.ok(veil, 'the environment veil is where this test reads it');
    const page = colour(m, '--bg');
    const shade = { ...page, a: Number(veil[1]) / 100 };
    const envs = { darkest: composite(shade, { r: 0, g: 0, b: 0, a: 1 }), lightest: composite(shade, { r: 255, g: 255, b: 255, a: 1 }) };
    const tinted = colour(m, '--glass-tinted');
    const glasses = { solid: colour(m, '--glass-solid'), tinted: { ...tinted, a: 0.55 } };
    for (const [gn, g] of Object.entries(glasses)) for (const [en, env] of Object.entries(envs)) {
      const under = composite(g, env);
      for (const [tok, min] of [['--text-high', 75], ['--text-low', 60], ['--text', 75], ['--text-dim', 60], ['--text-soft', 60]]) {
        const v = lc(colour(m, tok), under);
        assert.ok(v >= min, `${tok} on ${gn} glass over the ${en} environment (${supports}): Lc ${v.toFixed(1)} < ${min}`);
      }
    }
  }
});

// Visual refresh B1: the Glass choice. Paragraph panels keep .66 in every choice; in Tinted and Solid the text tokens
// pass on the glass the theme really paints (read from the CSS for that choice), over both environment extremes.
test('orbit: glass choices keep paragraph panels at .66 and text readable on Tinted and Solid', () => {
  const css = read('themes/orbit/theme.css');
  const veil = Number(/\.environment::after\s*\{[^}]*color-mix\(in srgb, var\(--bg\) (\d+)%, transparent\)\s*;/.exec(css)[1]) / 100;
  for (const supports of MODES) for (const glass of ['clear', 'tinted', 'solid']) {
    const m = tokensOf('orbit', supports, { attrs: { 'data-glass': glass } });
    for (const panel of ['--glass-panel', '--glass-player']) assert.ok(colour(m, panel).a >= 0.659, `${panel} in ${glass}: alpha ${colour(m, panel).a}`);
    if (glass === 'clear') continue;
    const page = colour(m, '--bg');
    const envs = [0, 255].map((v) => composite({ ...page, a: veil }, { r: v, g: v, b: v, a: 1 }));
    for (const g of ['--glass-tinted', '--glass-cluster']) for (const env of envs) {
      const under = composite(colour(m, g), env);
      for (const [tok, min] of [['--text', 75], ['--text-dim', 60]]) {
        const v = lc(colour(m, tok), under);
        assert.ok(v >= min, `${tok} on ${g} (${glass}, ${supports}): Lc ${v.toFixed(1)} < ${min}`);
      }
    }
  }
});

// Visual refresh B2: OLED black (dark themes), More contrast and both together keep every check. OLED is not offered
// on Daylight (a light theme), so it is not set there.
const DARK = THEMES.filter((t) => t !== 'daylight');
for (const t of THEMES) for (const supports of MODES) {
  const combos = [{ 'data-contrast': 'more' }, ...(DARK.includes(t) ? [{ 'data-oled': '' }, { 'data-oled': '', 'data-contrast': 'more' }] : [])];
  for (const attrs of combos) {
    const label = Object.keys(attrs).join('+');
    test(`${t} (${supports}) ${label}: text and button contrast`, () => {
      const m = tokensOf(t, supports, { attrs });
      const bg = colour(m, '--app-bg');
      for (const s of [...SURFACES, '--bg', '--bg-2', '--surface', '--surface-2']) {
        const under = opaque(colour(m, s), bg);
        for (const [tok, min] of [['--text-high', 75], ['--text-low', 60], ['--text', 75], ['--text-dim', 60]]) {
          assert.ok(lc(colour(m, tok), under) >= min, `${tok} on ${s}: Lc ${lc(colour(m, tok), under).toFixed(1)}`);
        }
      }
      const acc = opaque(colour(m, '--accent'), bg);
      assert.ok(lc(colour(m, '--accent-text'), acc) >= 60, '--accent-text on --accent');
      const ring = opaque(colour(m, '--focus-ring'), bg);
      assert.ok(wcagRatio(ring, bg) >= 3, '--focus-ring');
      if ('data-oled' in attrs) {
        assert.deepEqual([bg.r, bg.g, bg.b], [0, 0, 0], `${t} OLED --app-bg is black`);
        const page = colour(m, '--bg');
        assert.deepEqual([page.r, page.g, page.b], [0, 0, 0], `${t} OLED --bg is black`);
      }
      if (attrs['data-contrast'] === 'more') {
        assert.equal(m.get('--text-low'), m.get('--text-high'), 'More contrast: --text-low is --text-high');
        assert.equal(m.get('--text-dim'), m.get('--text'), 'More contrast: --text-dim is --text');
        assert.equal(m.get('--focus-width'), '4px');
      }
    });
  }
}

test('every ramp step has a hex value and the same colour in oklch() inside @supports', () => {
  for (const t of THEMES) {
    const css = read(`themes/${t}/theme.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    const sup = /@supports\s*\(color:\s*oklch\(0% 0 0\)\)\s*\{([\s\S]*?\}\s*)\}/.exec(css);
    assert.ok(sup, `${t}: an @supports (color: oklch(0% 0 0)) block`);
    const outside = css.replace(sup[0], '');
    const hex = new Map([...outside.matchAll(/(--[na]-\d+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((x) => [x[1], x[2]]));
    const ok = new Map([...sup[1].matchAll(/(--[na]-\d+)\s*:\s*(oklch\([^)]*\))\s*;/gi)].map((x) => [x[1], x[2]]));
    const want = t === 'arctic-side' ? ['a'] : ['n', 'a']; // Arctic Side @imports Arctic's neutrals
    for (const r of want) for (let i = 1; i <= 12; i++) {
      const n = `--${r}-${i}`;
      assert.ok(hex.has(n), `${t} ${n} hex`);
      assert.ok(ok.has(n), `${t} ${n} oklch`);
      near(parseColor(ok.get(n)), parseColor(hex.get(n)), `${t} ${n} ${hex.get(n)} vs ${ok.get(n)}`);
    }
    assert.equal(hex.size, ok.size, `${t}: the same steps in both`);
    assert.doesNotMatch(outside, /oklch\(/i, `${t}: no oklch() outside the @supports block (an old browser would take it)`);
  }
});

test('an old-names-only theme (a copy of the old Midnight) looks as before', () => {
  const file = path.join(ROOT, 'test/fixtures/legacy-theme/theme.css');
  const was = JSON.parse(read('test/fixtures/old-theme-tokens.json')).midnight;
  for (const supports of MODES) {
    const m = resolve(file, { supports });
    for (const [n, v] of Object.entries(was)) {
      if (parseColor(v)) near(colour(m, n), parseColor(v), n);
      else assert.equal(m.get(n), v, n);
    }
    assert.ok(!m.has('--n-1'), 'no ramp');
    near(colour(m, '--app-bg'), parseColor('#0c0e13'), '--app-bg');
    near(colour(m, '--text-high'), parseColor('#eef1f6'), '--text-high');
  }
  // Its own values win over tokens.css's defaults (which happen to be Midnight's): change them and they follow.
  const tmp = fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'atomix-legacy-'));
  const own = path.join(tmp, 'theme.css');
  fs.writeFileSync(own, fs.readFileSync(file, 'utf8').replace('--bg: #0c0e13', '--bg: #102030').replace('--text: #eef1f6', '--text: #fafafa')
    .replace('--surface: #191d27', '--surface: #203040').replace('--accent: #ff6b3d', '--accent: #33cc99'));
  try {
    const m = resolve(own);
    for (const [n, v] of [['--bg', '#102030'], ['--app-bg', '#102030'], ['--text', '#fafafa'], ['--text-high', '#fafafa'],
      ['--surface', '#203040'], ['--surface-1', '#203040'], ['--accent', '#33cc99'], ['--accent-solid', '#33cc99'], ['--focus-ring', '#33cc99']]) {
      near(colour(m, n), parseColor(v), n);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The cascade's winner per property, ranked as tokens.js ranks them (!important, layer, specificity, order).
function winners(decls) {
  const better = (a, b) => (a.important !== b.important ? a.important : a.layer !== b.layer ? a.layer > b.layer : a.spec !== b.spec ? a.spec > b.spec : a.order > b.order);
  const win = new Map();
  for (const d of decls) if (!win.has(d.name) || better(d, win.get(d.name))) win.set(d.name, d);
  return new Map([...win].map(([n, d]) => [n, d.value]));
}
// A browser treats a var() in a fallback as a dependency too, so every name a value mentions is an edge.
function findCycle(values) {
  const edges = new Map([...values].map(([n, v]) => [n, [...v.matchAll(/var\(\s*(--[\w-]+)/g)].map((x) => x[1]).filter((x) => values.has(x))]));
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1); stack.push(n);
    for (const e of edges.get(n)) { const c = visit(e); if (c) return c; }
    stack.pop(); state.set(n, 2);
    return null;
  };
  for (const n of values.keys()) { const c = visit(n); if (c) return c; }
  return null;
}

test('findCycle sees a cycle through a fallback', () => {
  assert.deepEqual(findCycle(new Map([['--a', 'var(--x, var(--b))'], ['--b', 'var(--a)'], ['--x', 'red']])), ['--a', '--b', '--a']);
  assert.equal(findCycle(new Map([['--a', 'var(--b, red)'], ['--b', 'blue']])), null);
});

test('no var() cycles (fallbacks included) in tokens.css with any theme, or with the old-names theme', () => {
  const files = [...THEMES.map((t) => [t, themeFile(t), layoutOf(t)]), ['legacy', path.join(ROOT, 'test/fixtures/legacy-theme/theme.css'), 'top']];
  for (const [t, f, layout] of files) for (const supports of MODES) {
    const c = findCycle(winners(resolve(f, { supports, layout }).decls));
    assert.equal(c, null, `${t} (${supports}): ${c?.join(' -> ')}`);
  }
  // tokens.css alone, too (a theme that fails to load).
  assert.equal(findCycle(winners(readThemeTokens(read('public/css/tokens.css')).decls)), null);
});

// Raw colour literals in public/css/*.css: every declaration value outside the :root / html[...] token blocks, plus
// non-custom declarations inside them (`:root { color: #f00 }` is not a token). Counts hex, colour functions and the
// common named colours. tokens.css is counted the same way (its :root blocks are the tokens; nothing else belongs there).
function countRawColours(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokenBlock = (sel) => sel.split(',').every((s) => /^\s*(:root|html)(\[[^\]]*\]|\.[\w-]+|:root|:not\([^()]*\))*\s*$/.test(s));
  const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(|\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|cyan|magenta|fuchsia)\b/gi;
  const inValues = (body, skipCustom) => body.split(';').reduce((n, d) => {
    const k = d.indexOf(':');
    if (k < 0 || (skipCustom && d.slice(0, k).trim().startsWith('--'))) return n;
    return n + (d.slice(k + 1).match(COLOUR) || []).length;
  }, 0);
  let count = 0;
  const walk = (text) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).split(/[;}]/).pop().trim();
      let depth = 1, k = open + 1;
      for (; k < text.length && depth; k++) depth += text[k] === '{' ? 1 : text[k] === '}' ? -1 : 0;
      const body = text.slice(open + 1, k - 1);
      if (prelude.startsWith('@') && !/^@(font-face|property|page)/i.test(prelude)) walk(body);
      else count += inValues(body, tokenBlock(prelude));
      i = k;
    }
  };
  walk(css);
  return count;
}

test('countRawColours counts declaration values, not tokens or selectors', () => {
  assert.equal(countRawColours(':root { --a: #fff; } html[data-x="y"] { --b: rgb(0 0 0); } #main .x { color: #123; background: rgba(0,0,0,.5); }'), 2);
  assert.equal(countRawColours('@media (min-width: 1px) { :root { --a: #fff } .b { color: oklch(50% 0 0) } }'), 1);
  assert.equal(countRawColours(':root { color: #f00; } html.kbd { background: #f00 }'), 2, 'non-custom declarations in token blocks');
  assert.equal(countRawColours('.a { color: white; border-color: color-mix(in srgb, var(--x) 50%, black); white-space: nowrap; background: lab(50% 0 0) hwb(0 0% 0%) }'), 4);
});

test('no new raw colours in public/css (baseline test/fixtures/raw-colours.json)', () => {
  const fixture = path.join(ROOT, 'test/fixtures/raw-colours.json');
  const files = fs.readdirSync(path.join(ROOT, 'public/css')).filter((f) => f.endsWith('.css')).sort();
  const now = Object.fromEntries(files.map((f) => [f, countRawColours(read(`public/css/${f}`))]));
  const was = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  if (process.env.UPDATE_RAW_COLOURS === '1') { // lowers counts only; a new file starts at its count
    const next = Object.fromEntries(Object.entries(now).map(([f, n]) => [f, f in was ? Math.min(n, was[f]) : n]));
    fs.writeFileSync(fixture, JSON.stringify(next, null, 2) + '\n');
    return;
  }
  for (const [f, n] of Object.entries(now)) {
    assert.ok(f in was, `${f} is new: add it to raw-colours.json (and use tokens, not raw colours)`);
    assert.ok(n <= was[f], `${f}: ${n} raw colours, the baseline is ${was[f]}; use a token from tokens.css`);
  }
});
