// Calling Atomix's Subsonic API (/rest/) the way music apps do.
import crypto from 'node:crypto';

export const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Token sign-in params for an app password (a fresh salt each call). */
export function tokenAuth(username, secret) {
  const s = crypto.randomBytes(6).toString('hex');
  return { u: username, t: md5(secret + s), s, v: '1.16.1', c: 'atomix-test' };
}

/**
 * GET (or POST as a form) /rest/<method>.view. Returns { status, type, text, body } — body is the parsed
 * "subsonic-response" for f=json, else null.
 */
export async function rest(base, method, params = {}, { f = 'json', post = false, view = true, headers = {} } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...(f ? { f } : {}), ...params })) for (const x of [].concat(v)) if (x !== undefined) qs.append(k, String(x));
  const url = `${base}/rest/${method}${view ? '.view' : ''}`;
  const res = post
    ? await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: qs.toString() })
    : await fetch(`${url}?${qs}`, { headers });
  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const text = /json|xml|javascript|text/.test(type) ? buf.toString('utf8') : null;
  let body = null;
  if (f === 'json' && /json/.test(type)) body = JSON.parse(text)['subsonic-response'];
  return { status: res.status, type, text, body, buf, headers: res.headers };
}
