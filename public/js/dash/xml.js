// A small XML reader for DASH manifests, used by the browser player and by the server's manifest rewrite. Elements,
// attributes, text, the five named entities and numeric ones, CDATA and comments. No DOCTYPE or entity declarations
// (a manifest never needs them, and they're how XML bombs work), and hard limits on size, depth and node count.
// Pure (no DOM), so it runs and is tested in Node.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const bad = (why) => new Error(`bad xml: ${why}`);

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, e, off, all) => {
    if (all[off + m.length - 1] !== ';') throw bad('entity without ;');
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) throw bad('character reference');
      return String.fromCodePoint(code);
    }
    if (!(e in NAMED)) throw bad(`unknown entity ${e}`);
    return NAMED[e];
  });
}

const NAME = /[A-Za-z_:][-\w.:]*/y;
const SPACE = /\s*/y;

/**
 * @param {string} text
 * @param {{ maxBytes?: number, maxDepth?: number, maxNodes?: number }} [limits]
 * @returns {{ name: string, attrs: Record<string,string>, children: object[], text: string }} the root element
 */
export function parseXml(text, { maxBytes = 2_000_000, maxDepth = 64, maxNodes = 20_000 } = {}) {
  const s = String(text ?? '');
  if (s.length > maxBytes) throw bad('too big');
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodes = 0;
  let root = null;
  const stack = [];
  const top = () => stack[stack.length - 1];
  const eat = (re) => {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    i = re.lastIndex;
    return m[0];
  };

  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const chunk = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (chunk) {
      if (!stack.length) {
        if (chunk.trim()) throw bad('text outside the root');
      } else top().text += decodeEntities(chunk);
    }
    if (lt < 0) break;
    i = lt;
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i);
      if (end < 0) throw bad('unclosed declaration');
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) throw bad('unclosed comment');
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end < 0 || !stack.length) throw bad('CDATA');
      top().text += s.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (s.startsWith('<!', i)) throw bad('DOCTYPE or declaration');
    if (s[i + 1] === '/') {
      i += 2;
      const name = eat(NAME);
      eat(SPACE);
      if (!name || s[i] !== '>') throw bad('end tag');
      i++;
      const el = stack.pop();
      if (!el || el.name !== name) throw bad(`mismatched </${name}>`);
      if (!stack.length) root = el;
      continue;
    }
    i++;
    const name = eat(NAME);
    if (!name) throw bad('tag name');
    if (root || (!stack.length && nodes > 0)) throw bad('second root');
    const el = { name, attrs: {}, children: [], text: '' };
    if (++nodes > maxNodes) throw bad('too many nodes');
    for (;;) {
      eat(SPACE);
      if (s[i] === '/' && s[i + 1] === '>') {
        i += 2;
        if (stack.length) top().children.push(el);
        else root = el;
        break;
      }
      if (s[i] === '>') {
        i++;
        if (stack.length) top().children.push(el);
        if (stack.length + 1 > maxDepth) throw bad('too deep');
        stack.push(el);
        break;
      }
      const attr = eat(NAME);
      if (!attr) throw bad(`attribute in <${name}>`);
      eat(SPACE);
      if (s[i] !== '=') throw bad(`attribute ${attr}`);
      i++;
      eat(SPACE);
      const q = s[i];
      if (q !== '"' && q !== "'") throw bad(`attribute ${attr} quote`);
      const end = s.indexOf(q, i + 1);
      if (end < 0) throw bad('unclosed attribute');
      el.attrs[attr] = decodeEntities(s.slice(i + 1, end));
      i = end + 1;
    }
  }
  if (stack.length || !root) throw bad('unclosed element');
  return root;
}

const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (v) => escText(v).replace(/"/g, '&quot;');

/** The tree back as XML text (with a declaration). Text is written before the children. */
export function serializeXml(root) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  const write = (el) => {
    out.push(`<${el.name}`);
    for (const [k, v] of Object.entries(el.attrs)) out.push(` ${k}="${escAttr(v)}"`);
    if (!el.children.length && !el.text) {
      out.push('/>');
      return;
    }
    out.push('>');
    if (el.text) out.push(escText(el.text));
    for (const c of el.children) write(c);
    out.push(`</${el.name}>`);
  };
  write(root);
  return out.join('');
}

/** The local part of a (possibly prefixed) name: "cenc:pssh" → "pssh". */
export const localName = (name) => String(name).slice(String(name).indexOf(':') + 1);
