// Reads XMLTV guides as a stream: a small hand-written tokenizer (no XML library), fed in chunks, so a 100 MB guide
// never sits in memory — only the programme being read does. Plain or gzip (sniffed from the first bytes).
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const NOT_XMLTV = "The guide file isn't XMLTV";
const MAX_TOKEN = 4 * 1024 * 1024; // longest tag, comment, CDATA or text run accepted
const MAX_FIELD = 64 * 1024; // a title or description longer than this is cut
const invalid = (line) => new Error(`The guide file isn't valid XMLTV (line ${line})`);

/** "20261010190000 +1300" → ms since the epoch (no offset = UTC); `shiftHours` added once. */
export function parseXmltvTime(text, shiftHours = 0) {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(String(text || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', sign, oh, om] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (sign) ms -= (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
  return ms + Number(shiftHours || 0) * 3600_000;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
function parseAttrs(text) {
  const out = {};
  for (const m of text.matchAll(ATTR)) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** The end of a tag starting at `i` ("<…>"), skipping ">" inside quotes; -1 when the buffer doesn't hold it yet. */
function tagEnd(buf, i) {
  let quote = null;
  for (let j = i + 1; j < buf.length; j++) {
    const c = buf[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

/** "1.4/10." (zero-based) → "S2 E5"; missing parts left out. */
function episodeFromNs(text) {
  const [s, e] = String(text).split('.').map((x) => x.split('/')[0].trim());
  const season = s !== '' && s != null && /^\d+$/.test(s) ? Number(s) + 1 : null;
  const episode = e !== '' && e != null && /^\d+$/.test(e) ? Number(e) + 1 : null;
  return [season != null ? `S${season}` : null, episode != null ? `E${episode}` : null].filter(Boolean).join(' ') || null;
}

async function* asChunks(input) {
  if (typeof input === 'string') {
    yield input;
    return;
  }
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    yield new TextDecoder('utf-8').decode(input);
    return;
  }
  const dec = new TextDecoder('utf-8');
  for await (const chunk of input) yield typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
  const tail = dec.decode();
  if (tail) yield tail;
}

/**
 * @param {AsyncIterable<Buffer|string>|string|Buffer} input
 * @param {{ shiftHours?: number, onProgramme?: (p) => void }} [opts]  with onProgramme, programmes aren't collected
 * @returns {Promise<{ channels: Map<string, string[]>, programmes: object[] }>}
 */
export async function parseXmltv(input, { shiftHours = 0, onProgramme = null } = {}) {
  const channels = new Map();
  const programmes = [];
  const deferred = new Map(); // channel id -> a programme with no stop, waiting for the next one's start
  const emit = (p) => (onProgramme ? onProgramme(p, channels) : programmes.push(p));
  const finish = (p) => {
    const waiting = deferred.get(p.guideId);
    if (waiting) {
      deferred.delete(p.guideId);
      if (p.start > waiting.start) emit({ ...waiting, end: p.start });
    }
    if (p.end == null) deferred.set(p.guideId, p);
    else if (p.end > p.start) emit(p);
  };

  const stack = [];
  let sawRoot = false;
  let line = 1;
  let chan = null; // { id, names }
  let prog = null; // the programme being read
  let field = null; // { name, system?, text }

  const open = (name, attrs, selfClosing, at) => {
    if (!stack.length) {
      if (sawRoot) throw invalid(at);
      if (name !== 'tv') throw new Error(NOT_XMLTV);
      sawRoot = true;
    }
    const parent = stack.at(-1);
    if (parent === 'tv' && name === 'channel') chan = { id: attrs.id || '', names: [] };
    else if (parent === 'tv' && name === 'programme') {
      const start = parseXmltvTime(attrs.start, shiftHours);
      const stop = attrs.stop ? parseXmltvTime(attrs.stop, shiftHours) : null;
      prog = { guideId: attrs.channel || '', start, end: stop, title: '', categories: [], _ns: null, _onscreen: null };
    } else if (chan && parent === 'channel' && name === 'display-name') field = { name, text: '' };
    else if (prog && parent === 'programme') {
      if (['title', 'sub-title', 'desc', 'category'].includes(name)) field = { name, text: '' };
      else if (name === 'episode-num') field = { name, system: (attrs.system || '').toLowerCase(), text: '' };
      else if (name === 'icon' && attrs.src && !prog.image) prog.image = attrs.src;
      else if (name === 'previously-shown') prog.repeat = true;
    }
    if (!selfClosing) stack.push(name);
    else close(name, at, true);
  };

  const close = (name, at, implicit = false) => {
    if (!implicit) {
      if (stack.at(-1) !== name) throw invalid(at);
      stack.pop();
    }
    if (field && name === field.name) {
      const text = field.text.trim();
      if (chan && name === 'display-name') {
        if (text) chan.names.push(text);
      } else if (prog) {
        if (name === 'title' && !prog.title) prog.title = text;
        else if (name === 'sub-title' && !prog.subtitle && text) prog.subtitle = text;
        else if (name === 'desc' && !prog.description && text) prog.description = text;
        else if (name === 'category' && text) prog.categories.push(text);
        else if (name === 'episode-num') {
          if (field.system === 'onscreen' && text) prog._onscreen = text;
          else if (field.system === 'xmltv_ns' && text) prog._ns = episodeFromNs(text);
        }
      }
      field = null;
    } else if (name === 'channel' && chan && stack.at(-1) === 'tv') {
      if (chan.id) channels.set(chan.id, chan.names);
      chan = null;
    } else if (name === 'programme' && prog && stack.at(-1) === 'tv') {
      const { _ns, _onscreen, ...p } = prog;
      prog = null;
      const episode = _onscreen || _ns;
      if (episode) p.episode = episode;
      if (p.guideId && p.start != null && p.title) finish(p);
    }
  };

  const text = (t) => {
    if (field && field.text.length < MAX_FIELD) field.text += t.slice(0, MAX_FIELD - field.text.length);
  };

  let buf = '';
  const countLines = (s) => {
    let n = 0;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
    return n;
  };

  const consume = (final) => {
    let i = 0;
    while (i < buf.length) {
      const lt = buf.indexOf('<', i);
      if (lt === -1) {
        if (!final) break; // a text run may continue in the next chunk
        const t = buf.slice(i);
        if (stack.length) text(decodeEntities(t));
        line += countLines(t);
        i = buf.length;
        break;
      }
      if (lt > i) {
        const t = buf.slice(i, lt);
        if (stack.length) text(decodeEntities(t));
        line += countLines(t);
        i = lt;
      }
      const at = line;
      let end;
      if (buf.startsWith('<!--', i)) {
        end = buf.indexOf('-->', i + 4);
        if (end === -1) break;
        end += 3;
      } else if (buf.startsWith('<![CDATA[', i)) {
        end = buf.indexOf(']]>', i + 9);
        if (end === -1) break;
        if (stack.length) text(buf.slice(i + 9, end));
        end += 3;
      } else if (buf.startsWith('<?', i)) {
        end = buf.indexOf('?>', i + 2);
        if (end === -1) break;
        end += 2;
      } else if (buf.startsWith('<!', i)) {
        // <!DOCTYPE …> (with an optional [internal subset])
        const bracket = buf.indexOf('[', i);
        const gt = buf.indexOf('>', i);
        if (gt === -1) break;
        if (bracket !== -1 && bracket < gt) {
          const close = buf.indexOf(']>', bracket);
          if (close === -1) break;
          end = close + 2;
        } else end = gt + 1;
      } else {
        const gt = tagEnd(buf, i);
        if (gt === -1) break;
        const inner = buf.slice(i + 1, gt);
        end = gt + 1;
        if (inner.startsWith('/')) close(inner.slice(1).trim(), at);
        else {
          const selfClosing = inner.endsWith('/');
          const body = selfClosing ? inner.slice(0, -1) : inner;
          const m = /^([^\s/>]+)/.exec(body);
          if (!m) throw invalid(at);
          open(m[1], parseAttrs(body.slice(m[1].length)), selfClosing, at);
        }
      }
      line += countLines(buf.slice(i, end));
      i = end;
    }
    buf = buf.slice(i);
    // Nothing in XMLTV is megabytes long: an unterminated comment, tag or CDATA would otherwise grow the buffer
    // (and the rescans) until memory runs out.
    if (!final && buf.length > MAX_TOKEN) throw invalid(line);
  };

  for await (const chunk of asChunks(input)) {
    buf += chunk;
    consume(false);
  }
  consume(true);
  if (!sawRoot) throw new Error(NOT_XMLTV);
  if (stack.length || buf.trim()) throw invalid(line);
  return { channels, programmes };
}

/**
 * Passes a plain guide through, unpacks gzip (by magic bytes, whatever the name), refuses xz and zip in words.
 * The unpacked size is capped (a small .gz can unpack to gigabytes).
 */
export async function* decodeGuide(stream, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  let total = 0;
  for await (const chunk of unpackGuide(stream)) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`The guide is larger than ${Math.round(maxBytes / 1048576)} MB unpacked`);
    yield chunk;
  }
}

async function* unpackGuide(stream) {
  const it = stream[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let done = false;
  while (head.length < 6 && !done) {
    const r = await it.next();
    if (r.done) done = true;
    else head = Buffer.concat([head, Buffer.from(r.value)]);
  }
  const rest = async function* () {
    if (head.length) yield head;
    if (done) return;
    for (let r = await it.next(); !r.done; r = await it.next()) yield Buffer.from(r.value);
  };
  if (head[0] === 0xfd && head[1] === 0x37 && head[2] === 0x7a && head[3] === 0x58 && head[4] === 0x5a) throw new Error('This guide is compressed as .xz/.zip — Atomix can read plain or .gz XMLTV');
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) throw new Error('This guide is compressed as .xz/.zip — Atomix can read plain or .gz XMLTV');
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const gunzip = zlib.createGunzip();
    const src = Readable.from(rest());
    src.on('error', (e) => gunzip.destroy(e));
    src.pipe(gunzip);
    for await (const c of gunzip) yield c;
    return;
  }
  yield* rest();
}
