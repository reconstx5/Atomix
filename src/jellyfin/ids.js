// Jellyfin ids are GUIDs: 32 lowercase hex, no dashes. Ours are 'a70a1f00' + an 8-hex kind code + a 16-hex id, so an
// id can be told apart from a stranger's and turned back into the row it names. People have no numeric id: theirs is
// the first 16 hex of sha1(name) (see persons below).
const PREFIX = 'a70a1f00';
const KINDS = { item: 1, library: 2, user: 3, person: 4, server: 5 };
const BY_CODE = Object.fromEntries(Object.entries(KINDS).map(([k, c]) => [c, k]));

export function toGuid(kind, id) {
  const code = KINDS[kind];
  if (!code) throw new Error(`Unknown id kind: ${kind}`);
  const tail = kind === 'person' ? String(id).toLowerCase() : Number(id).toString(16);
  if (!/^[0-9a-f]{1,16}$/.test(tail)) throw new Error('That id cannot be turned into a GUID.');
  return PREFIX + code.toString(16).padStart(8, '0') + tail.padStart(16, '0');
}

export function fromGuid(s) {
  if (typeof s !== 'string') return null;
  const hex = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) || !hex.startsWith(PREFIX)) return null;
  const kind = BY_CODE[parseInt(hex.slice(8, 16), 16)];
  if (!kind) return null;
  const tail = hex.slice(16);
  return { kind, id: kind === 'person' ? tail : parseInt(tail, 16) };
}
