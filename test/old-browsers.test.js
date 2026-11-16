// Old TV browsers (Chromium 88-110, Safari < 16.2) know neither color-mix() nor oklch()/oklab(). A declaration whose
// value uses one of them with var() inside is kept by the parser and then thrown out at computed-value time: the
// property becomes `unset` (a transparent background, the inherited colour), not the rule before it. So every such
// value must sit inside an @supports block that tests for it, or come after a plain declaration of the same property in
// the same rule (that fallback only helps when the value has no var(); with var() only @supports helps). A custom
// property holding one never falls back, so it must be guarded too.
//
// Declarations already like this before visual refresh A are listed in test/fixtures/old-browser-colours.json (pre-
// existing debt, shown as a count); anything else fails. UPDATE_OLD_BROWSER_COLOURS=1 shrinks the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODERN = /\b(color-mix|oklch|oklab|lab|lch)\(|\bfrom\s+(var\(|#|rgb|hsl)/i;
const GUARD = /color-mix|oklch|oklab|\blab\(|\blch\(|from/i;

/** Every unguarded modern-colour declaration in `css`: [{ key: 'selector | property', line }]. */
export function unguarded(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [];
  const walk = (start, end, guarded, prelude) => {
    let i = start;
    while (i < end) {
      const open = css.indexOf('{', i);
      if (open < 0 || open >= end) break;
      const head = css.slice(i, open).trim();
      // the matching close brace
      let depth = 1, j = open + 1;
      for (; j < end && depth; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; }
      const close = j - 1;
      const body = css.slice(open + 1, close);
      if (head.startsWith('@')) {
        const g = guarded || (/^@supports/i.test(head) && GUARD.test(head) && !/\bnot\b/i.test(head));
        walk(open + 1, close, g, head);
      } else if (body.includes('{')) {
        walk(open + 1, close, guarded, head); // nested rule (CSS nesting)
      } else {
        const seen = new Map(); // property -> had a plain value earlier in this rule
        let pos = open + 1;
        for (const decl of body.split(';')) {
          const at = pos; pos += decl.length + 1;
          const k = decl.indexOf(':');
          if (k < 0) continue;
          const prop = decl.slice(0, k).trim().toLowerCase(), value = decl.slice(k + 1).trim();
          if (!prop) continue;
          if (!MODERN.test(value)) { seen.set(prop, true); continue; }
          const fallsBack = seen.get(prop) && !/var\(/.test(value) && !prop.startsWith('--');
          if (guarded || fallsBack) continue;
          const sel = head.replace(/\s+/g, ' ');
          out.push({ key: `${sel} | ${prop}`, line: css.slice(0, at).split('\n').length + decl.slice(0, k).split('\n').length - 1 });
        }
      }
      i = close + 1;
    }
  };
  walk(0, css.length, false, '');
  return out;
}

const FILES = () => [
  ...fs.readdirSync(path.join(ROOT, 'public/css')).filter((f) => f.endsWith('.css')).map((f) => `public/css/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'themes')).filter((t) => fs.existsSync(path.join(ROOT, 'themes', t, 'theme.css'))).map((t) => `themes/${t}/theme.css`),
].sort();

test('unguarded() finds color-mix/oklch outside @supports and passes guarded or fallen-back ones', () => {
  const keys = (css) => unguarded(css).map((d) => d.key);
  assert.deepEqual(keys('.a { background: color-mix(in srgb, var(--x) 50%, white); }'), ['.a | background']);
  assert.deepEqual(keys('.a { --b: color-mix(in srgb, red 50%, blue); }'), ['.a | --b']);
  assert.deepEqual(keys('.a { color: oklch(50% 0.1 200); }'), ['.a | color']);
  assert.deepEqual(keys('.a { color: #333; color: oklch(50% 0.1 200); }'), [], 'a plain value first, no var(): falls back');
  assert.deepEqual(keys('.a { background: #333; background: color-mix(in srgb, var(--x) 50%, white); }'), ['.a | background'], 'with var() the earlier value does not help');
  assert.deepEqual(keys('@supports (color: color-mix(in srgb, red, blue)) { .a { background: color-mix(in srgb, var(--x) 50%, white); } }'), []);
  assert.deepEqual(keys('@supports (color: oklch(0% 0 0)) { :root { --n-1: oklch(20% 0 0); } }'), []);
  assert.deepEqual(keys('@media (min-width: 1px) { .a { border-color: color-mix(in srgb, var(--x) 40%, transparent); } }'), ['.a | border-color']);
  assert.deepEqual(keys('/* color-mix(in srgb, red, blue) */ .a { color: red; }'), []);
});

test('no new colour that old TV browsers drop (baseline test/fixtures/old-browser-colours.json)', () => {
  const fixture = path.join(ROOT, 'test/fixtures/old-browser-colours.json');
  const now = {};
  for (const f of FILES()) {
    const found = unguarded(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (found.length) now[f] = [...new Set(found.map((d) => d.key))].sort();
  }
  const was = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  if (process.env.UPDATE_OLD_BROWSER_COLOURS === '1') { // only ever drops entries
    const next = Object.fromEntries(Object.entries(was).map(([f, ks]) => [f, ks.filter((k) => now[f]?.includes(k))]).filter(([, ks]) => ks.length));
    fs.writeFileSync(fixture, JSON.stringify(next, null, 1) + '\n');
    return;
  }
  const fresh = [];
  for (const [f, ks] of Object.entries(now)) for (const k of ks) if (!(was[f] || []).includes(k)) fresh.push(`${f}: ${k}`);
  assert.deepEqual(fresh, [], 'color-mix()/oklch() as the only value: old TVs drop it (unset). Put a ramp step first and the mix in @supports (color: color-mix(in srgb, red, blue)), or use a ramp step');
});
