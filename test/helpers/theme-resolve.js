// Shared by the theme tests: resolves a built-in theme's tokens the way the browser would (the stylesheets in
// index.html order, then the theme and what it @imports), for a mode (modern or legacy), attributes and a TV media.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readThemeTokens, composite } from '../../src/themes/tokens.js';
import { parseColor } from '../../src/themes/apca.js';
import { toOklch } from '../../public/js/tint.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Every built-in theme is a folder with a theme.json; sorted so reports read the same each run.
export const THEMES = fs.readdirSync(path.join(ROOT, 'themes'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'themes', d.name, 'theme.json')))
  .map((d) => d.name).sort();
export const MODES = ['modern', 'legacy']; // legacy = a browser without oklch() (old TVs): @supports blocks don't apply
export const TV_MEDIA = '(min-width: 1600px) and (orientation: landscape)'; // the TV size, as tokens.css writes it

// The stylesheets in the order index.html loads them, then the theme (and what it @imports, first).
export const baseCss = () => ['public/css/tokens.css', 'public/css/app.css', 'public/css/orbit.css'].map(read).join('\n');
export const layoutOf = (t) => JSON.parse(read(`themes/${t}/theme.json`)).layout;
export function chainOf(file) {
  const css = fs.readFileSync(file, 'utf8');
  const imp = /@import\s+url\(["']?([^"')]+)["']?\)/.exec(css);
  return imp ? [...chainOf(path.resolve(path.dirname(file), imp[1])), file] : [file];
}
export function resolve(themeFile, { supports = 'modern', layout = 'top', base = baseCss(), attrs = {}, classes = [], media } = {}) {
  const context = { attrs: { 'data-layout': layout, ...attrs }, classes, supports, media: [].concat(media || []) };
  let m = base;
  for (const f of chainOf(themeFile)) m = readThemeTokens(fs.readFileSync(f, 'utf8'), { base: m, context });
  return m;
}
export const themeFile = (t) => path.join(ROOT, 'themes', t, 'theme.css');
export const tokensOf = (t, supports, extra = {}) => resolve(themeFile(t), { supports, layout: layoutOf(t), ...extra });

// A token as {r, g, b, a} with alpha composited on --app-bg, so a glass colour reads as what the eye sees.
export function colourOf(map, name) {
  const c = parseColor(map.get(name) ?? '');
  if (!c) throw new Error(`${name} is not a colour (got ${map.get(name)})`);
  if (c.a >= 1) return c;
  const bg = parseColor(map.get('--app-bg') ?? '');
  if (!bg) throw new Error(`--app-bg is not a colour (got ${map.get('--app-bg')})`);
  return composite(c, bg);
}
// A token in OKLCH ({ L 0..1, C, H }), through tint.js's one copy of the maths.
export function lchOf(map, name) {
  const { r, g, b } = colourOf(map, name);
  return toOklch('#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));
}
