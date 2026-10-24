// Encrypted channels as Kodi's inputstream.adaptive describes them in a playlist (#KODIPROP lines). Written from the
// documented conventions: license_type + license_key ("url|headers|post data|response"), drm_legacy, and ClearKey keys
// given inline. Pure, so it's tested on its own. Nothing here decrypts anything: the browser's own key system does.

// v0.27: FairPlay (com.apple.fps) is an Atomix extension of the same properties, with an HLS manifest; Safari plays it.
const SYSTEMS = { 'com.widevine.alpha': 'widevine', widevine: 'widevine', 'org.w3.clearkey': 'clearkey', clearkey: 'clearkey', 'com.apple.fps': 'fairplay', fairplay: 'fairplay' };
const HEX32 = /^[0-9a-f]{32}$/;

/** 'com.widevine.alpha' → 'widevine'; ClearKey → 'clearkey'; 'com.apple.fps' → 'fairplay'; anything else (PlayReady, …) → null. */
export function systemName(value) {
  return SYSTEMS[String(value || '').trim().toLowerCase()] || null;
}

function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, '%20'));
  } catch {
    return text;
  }
}

/** "Name=Value&Name=Value" with URL-encoded values → { Name: 'Value' }. */
export function parseHeaderList(text) {
  const out = {};
  for (const part of String(text || '').split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[decode(part.slice(0, eq).trim())] = decode(part.slice(eq + 1));
  }
  return out;
}

function bodyOf(text) {
  const t = String(text || '');
  if (!t || t === 'R{SSM}') return { kind: 'raw' };
  return { kind: 'template', text: t };
}

function responseOf(text) {
  const t = String(text || '').trim().replace(/;.*$/, ''); // ";hdcp…" (an output-protection hint) isn't Atomix's to act on
  if (!t) return { kind: 'raw' };
  if (t === 'B') return { kind: 'base64' };
  if (t === 'HB') return { kind: 'http-base64' }; // the answer is an HTTP message; its body is base64
  if (t.startsWith('BJ')) return { kind: 'json', path: t.slice(2), base64: false, wrapped: true }; // base64 of a JSON answer
  if (t.startsWith('JB')) return { kind: 'json', path: t.slice(2), base64: true };
  if (t.startsWith('J')) return { kind: 'json', path: t.slice(1), base64: false };
  return { kind: 'raw' };
}

function inlineKeys(text) {
  const t = String(text || '').trim();
  let pairs = [];
  const hexOf = (b64u) => Buffer.from(String(b64u || ''), 'base64url').toString('hex');
  if (t.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(t);
    } catch {
      return null;
    }
    // A JWK set ({"keys":[{"kty":"oct","kid":…,"k":…}]}, base64url) or a plain {"<kid hex>":"<key hex>"} object.
    pairs = Array.isArray(json.keys) ? json.keys.map((k) => [hexOf(k.kid), hexOf(k.k)]) : Object.entries(json);
  } else pairs = t.split(',').map((p) => p.split(':'));
  const keys = [];
  for (const [kid, key] of pairs) {
    const k = String(kid || '').trim().toLowerCase().replace(/-/g, '');
    const v = String(key || '').trim().toLowerCase().replace(/-/g, '');
    if (!HEX32.test(k) || !HEX32.test(v)) return null;
    keys.push({ kid: k, key: v });
  }
  return keys.length ? { keys } : null;
}

/**
 * A license_key value → { url, headers, body, response } for a licence server, or { keys } for ClearKey keys
 * written in the playlist; null when it can't be used (only http(s) licence servers).
 */
export function parseLicenceKey(system, text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (system === 'clearkey' && !/^https?:\/\//i.test(t)) return inlineKeys(t);
  const [url, headers = '', body = '', response = ''] = t.split('|');
  if (!/^https?:\/\/[^/]/i.test(url.trim())) return null;
  return { url: url.trim(), headers: parseHeaderList(headers), body: bodyOf(body), response: responseOf(response) };
}

/**
 * drm_legacy=<system>|<licence url>|<headers> → { system, licence } (null when the system isn't one Atomix plays).
 */
export function parseDrmLegacy(text) {
  const [sys, ...rest] = String(text || '').split('|');
  const system = systemName(sys);
  if (!system) return null;
  const licence = parseLicenceKey(system, rest.join('|'));
  return licence ? { system, licence } : null;
}
