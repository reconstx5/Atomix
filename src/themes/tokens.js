// Reads CSS custom properties out of theme stylesheets so tests can check contrast
// without a browser. Deliberately small; mirrors the cascade where it can and says so
// (in `skipped`) where it can't.
//
// readThemeTokens(cssText, { base, media, context }) -> Map(name -> resolved value | null)
//   The returned Map also carries two non-enumerable extras:
//     .skipped  string[]  root-level rules/at-rules that declare custom properties but
//                         could not be evaluated (never dropped silently)
//     .decls    array     the winning-candidate declarations, used as `base` later
//   `base`     CSS text, or a Map from an earlier call (e.g. tokens.css). Raw declarations
//              are merged (base first, theme on top) and resolved ONCE, so a theme that
//              overrides `--n-1` changes base's `--surface: var(--n-1)`.
//   `context`  { attrs: {name: value}, classes: [], media: [query, ...], supports: 'modern'|'legacy' } describing the
//              <html> element being simulated (default: no attributes/classes/media).
//   `media`    shorthand for one extra entry in context.media.
//
// What counts: top-level rules whose selector list holds a selector made only of
// `:root` / `html` plus `[attr]`, `[attr="v"]`, `.class` and `:not(<one of those>)`,
// all satisfied by the context. Declarations are ranked like the cascade:
// !important, then unlayered over layered (later @layer over earlier), then specificity
// (:root, attr, class and :not() contents = class level; html = type level), then source
// order. Anything else root-ish (other pseudo-classes, combinators, :is(), `@container`
// ...) that declares custom properties goes into `skipped`. Bare `[data-x]`/`.x` selectors
// without :root/html are ignored (not root-ish). @media blocks apply only when their query
// matches context.media/`media` (whitespace/case-insensitive; conditions are never
// evaluated); a non-matching @media that declares root custom properties is listed in `skipped`.
// @layer contents are applied. @supports: a plain `(prop: value)` or `selector(...)` is true when
// context.supports is 'modern' (default) and false for 'legacy'; `not <plain>` inverts; and/or/nested
// conditions are not evaluated (block skipped, listed in `skipped`). Layers from `base` and the theme share one
// numbering by first appearance within each file; !important layer reversal is not modelled.
//
// Values: for a repeated property the last declaration that is "understood" wins. A
// value is not understood only if it calls a function outside the known-CSS list below
// (mimics a fallback written for old syntax); everything else is kept, like a browser.
// var() chains resolve with fallbacks and nested fallbacks; members of a cycle, and
// missing vars with no fallback, resolve to null.
import { parseColor } from './apca.js'; // re-exported convenience for callers
export { parseColor };

const KNOWN_FUNCS = new Set(['var', 'calc', 'min', 'max', 'clamp', 'url', 'rgb', 'rgba', 'oklch', 'hsl', 'hsla',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'cubic-bezier', 'steps', 'env', 'attr', 'format', 'local',
  'drop-shadow', 'blur', 'brightness', 'saturate', 'contrast', 'translate', 'translatey', 'translatex', 'scale', 'rotate',
  'repeat', 'minmax', 'fit-content', 'light-dark', 'color-mix', 'color', 'oklab', 'lab', 'lch', 'hwb',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'image-set', 'counter', 'counters']);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\*[\s\S]*$/, '');
const squash = (s) => s.replace(/\s+/g, '').toLowerCase();

// Splits at top level into items: {prelude, body} for blocks, {statement} for `...;`.
function items(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    let j = i, q = null, paren = 0, found = null;
    for (; j < css.length; j++) {
      const ch = css[j];
      if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (paren <= 0 && (ch === ';' || ch === '{')) { found = ch; break; }
    }
    if (!found) break;
    const head = css.slice(i, j).trim();
    if (found === ';') { if (head) out.push({ statement: head }); i = j + 1; continue; }
    let depth = 1, k = j + 1;
    q = null;
    for (; k < css.length && depth > 0; k++) {
      const ch = css[k];
      if (q) { if (ch === '\\') k++; else if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    out.push({ prelude: head, body: css.slice(j + 1, k - 1) });
    i = k;
  }
  return out;
}

function splitDecls(body) {
  const out = [];
  let depth = 0, q = null, cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) { cur += ch; if (ch === '\\') cur += body[++i] ?? ''; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ';' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function understood(value) {
  const re = /([a-z][a-z0-9-]*)\(/gi;
  let m;
  while ((m = re.exec(value))) if (!KNOWN_FUNCS.has(m[1].toLowerCase())) return false;
  return true;
}

// --- selectors ---
const ATTR = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))\s*)?\]/;
const CLASS = /^\.([\w-]+)/;
// -> {t:'attr',name,value|null} | {t:'class',name} | null, consuming the whole string
function simple(s) {
  let m = ATTR.exec(s);
  if (m && m[0].length === s.length) return { t: 'attr', name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null };
  m = CLASS.exec(s);
  if (m && m[0].length === s.length) return { t: 'class', name: m[1] };
  return null;
}
const holds = (c, ctx) => c.t === 'attr'
  ? (c.value === null ? c.name in ctx.attrs : ctx.attrs[c.name] === c.value)
  : ctx.classes.includes(c.name);

// -> {kind:'ignore'|'unknown'|'no'|'yes', spec}
function evalSelector(sel, ctx) {
  sel = sel.trim();
  if (!/(^|[^\w-]):root(?![\w-])/.test(sel) && !/^html(?![\w-])/i.test(sel)) return { kind: 'ignore' };
  let rest = sel, spec = 0, ok = true;
  if (/^html(?![\w-])/i.test(rest)) { rest = rest.slice(4); spec += 1; }
  while (rest) {
    let m;
    if ((m = /^:root(?![\w-])/.exec(rest))) { spec += 10; rest = rest.slice(m[0].length); continue; }
    if ((m = ATTR.exec(rest)) || (m = CLASS.exec(rest))) {
      const c = simple(m[0]);
      spec += 10; ok = ok && holds(c, ctx); rest = rest.slice(m[0].length); continue;
    }
    if ((m = /^:not\(\s*((?:\[[^\]]*\])|(?:\.[\w-]+))\s*\)/.exec(rest))) {
      const c = simple(m[1]);
      if (!c) return { kind: 'unknown' };
      spec += 10; ok = ok && !holds(c, ctx); rest = rest.slice(m[0].length); continue;
    }
    return { kind: 'unknown' };
  }
  return { kind: ok ? 'yes' : 'no', spec };
}

// @supports condition -> true/false for a plain `(prop: value)` / `selector(...)` (modern: true,
// legacy: false) or `not <plain>` (inverse); null (unevaluable) for and/or/nested/anything else.
function supportsValue(cond, mode) {
  cond = cond.trim();
  let neg = false;
  const n = /^not\s*(.*)$/is.exec(cond);
  if (n) { neg = true; cond = n[1].trim(); }
  const m = /^(selector)?\(/i.exec(cond);
  if (!m) return null;
  const open = m[0].length - 1;
  if (closeParen(cond, open) !== cond.length - 1) return null; // and/or or trailing text
  if (/^\s*(\(|not\b)/i.test(cond.slice(open + 1))) return null; // nested condition
  const base = mode !== 'legacy';
  return neg ? !base : base;
}

function makeContext(options) {
  const c = options.context || {};
  const attrs = {};
  for (const [k, v] of Object.entries(c.attrs || {})) attrs[k.toLowerCase()] = String(v);
  const media = new Set([...(c.media || []), ...(options.media ? [options.media] : [])].map(squash));
  return { attrs, classes: c.classes || [], media, supports: c.supports === 'legacy' ? 'legacy' : 'modern' };
}

// Collects candidate declarations from one stylesheet. `st` = {decls, skipped, order, layers, ctx}.
function collect(css, st, layer) {
  for (const it of items(css)) {
    if (it.statement !== undefined) {
      const m = /^@layer\s+(.+)$/i.exec(it.statement);
      if (m) for (const n of m[1].split(',')) layerIndex(st, n.trim());
      continue; // @import, @charset, @namespace ...
    }
    const { prelude, body } = it;
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1].toLowerCase();
      if (name === 'media') {
        if (st.ctx.media.has(squash(prelude.replace(/^@media/i, '')))) collect(body, st, layer);
        else if (/:root|html/.test(body) && /--[\w-]+\s*:/.test(body)) st.skipped.push(prelude.replace(/\s+/g, ' '));
      } else if (name === 'layer') {
        collect(body, st, layerIndex(st, prelude.replace(/^@layer/i, '').trim() || null));
      } else if (name === 'supports') {
        const v = supportsValue(prelude.replace(/^@supports/i, ''), st.ctx.supports);
        if (v === true) collect(body, st, layer);
        else if (v === null) st.skipped.push(prelude.replace(/\s+/g, ' '));
      } else if (/:root|html/.test(body) && /--[\w-]+\s*:/.test(body)) {
        st.skipped.push(prelude.replace(/\s+/g, ' '));
      }
      continue;
    }
    const decls = [];
    for (const d of splitDecls(body)) {
      const k = d.indexOf(':');
      if (k < 0) continue;
      const name = d.slice(0, k).trim();
      if (!name.startsWith('--')) continue;
      let value = d.slice(k + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      value = value.replace(/!\s*important\s*$/i, '').trim();
      if (value && understood(value)) decls.push({ name, value, important });
    }
    if (!decls.length && !/--[\w-]+\s*:/.test(body)) continue;
    let spec = -1;
    for (const sel of prelude.split(',')) {
      const r = evalSelector(sel, st.ctx);
      if (r.kind === 'unknown') st.skipped.push(sel.trim().replace(/\s+/g, ' '));
      else if (r.kind === 'yes') spec = Math.max(spec, r.spec);
    }
    if (spec < 0) continue;
    for (const d of decls) st.decls.push({ ...d, layer, spec, order: st.order++ });
  }
}
function layerIndex(st, name) {
  if (name === null) return st.layers.size + 1000 + st.order++; // anonymous: its own, later layer
  if (!st.layers.has(name)) st.layers.set(name, st.layers.size);
  return st.layers.get(name);
}

// Higher rank wins. Unlayered (layer = Infinity) beats any layer.
const better = (a, b) => {
  if (a.important !== b.important) return a.important;
  if (a.layer !== b.layer) return a.layer > b.layer;
  if (a.spec !== b.spec) return a.spec > b.spec;
  return a.order > b.order;
};

function parseSheet(cssText, options, startOrder) {
  const st = { decls: [], skipped: [], order: startOrder, layers: new Map(), ctx: makeContext(options) };
  collect(stripComments(String(cssText)), st, Infinity);
  return st;
}

// --- var() ---
const closeParen = (s, open) => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
};
function substitute(value, lookup) {
  let out = '', i = 0;
  for (;;) {
    const at = value.indexOf('var(', i);
    if (at < 0) return out + value.slice(i);
    const end = closeParen(value, at + 3);
    if (end < 0) return null;
    const inner = value.slice(at + 4, end);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let r = lookup(name);
    if (r === null && fallback !== null) r = substitute(fallback, lookup);
    if (r === null) return null;
    out += value.slice(i, at) + r;
    i = end + 1;
  }
}

export function readThemeTokens(cssText, options = {}) {
  const { base = null } = options;
  let decls = [], skipped = [], order = 0;
  if (typeof base === 'string') {
    const st = parseSheet(base, options, 0);
    decls = st.decls; skipped = st.skipped; order = st.order;
  } else if (base && base.decls) {
    decls = base.decls.slice(); skipped = (base.skipped || []).slice();
    order = decls.reduce((m, d) => Math.max(m, d.order + 1), 0);
  } else if (base instanceof Map) { // plain Map of resolved values: treated as lowest-priority literals
    for (const [name, value] of base) if (typeof value === 'string') decls.push({ name, value, important: false, layer: -1, spec: -1, order: order++ });
  }
  const own = parseSheet(cssText, options, order);
  decls = decls.concat(own.decls);
  skipped = skipped.concat(own.skipped);

  const raw = new Map(), win = new Map();
  for (const d of decls) {
    const cur = win.get(d.name);
    if (!cur || better(d, cur)) win.set(d.name, d);
  }
  for (const [name, d] of win) raw.set(name, d.value);

  const cache = new Map(), stack = [], cyclic = new Set();
  const lookup = (name) => {
    if (cache.has(name)) return cache.get(name);
    if (!raw.has(name)) return null;
    const at = stack.indexOf(name);
    if (at >= 0) { for (const n of stack.slice(at)) cyclic.add(n); return null; }
    stack.push(name);
    let r = substitute(raw.get(name), lookup);
    stack.pop();
    if (cyclic.has(name)) r = null; // a cycle is guaranteed-invalid, fallbacks notwithstanding
    cache.set(name, r);
    return r;
  };
  const out = new Map();
  for (const name of raw.keys()) out.set(name, lookup(name));
  Object.defineProperty(out, 'skipped', { value: [...new Set(skipped)] });
  Object.defineProperty(out, 'decls', { value: decls });
  return out;
}

// Alpha-blends fg over bg; the result is opaque when bg is.
export function composite(fg, bg) {
  const a = fg.a ?? 1, ba = bg.a ?? 1;
  const oa = a + ba * (1 - a);
  if (oa === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (f, b) => (f * a + b * ba * (1 - a)) / oa;
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a: oa };
}
