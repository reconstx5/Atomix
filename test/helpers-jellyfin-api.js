// A tiny client for Atomix's own Jellyfin API (/jellyfin), speaking as Infuse does. Not test/helpers-jellyfin.js,
// which is a made-up far Jellyfin server for the connected-server tests.
//
// Paths are written after `/jellyfin` ('/Users/Me'); a path that already starts with /jellyfin (any capitals) is sent
// as it is, so tests can try other spellings.

export const authHeader = ({ token, deviceId = 'test-dev-1' } = {}) =>
  `MediaBrowser Client="Infuse-Direct", Device="iPhone", DeviceId="${deviceId}", Version="8.0"${token ? `, Token="${token}"` : ''}`;

const full = (path) => (/^\/jellyfin(\/|$|\?)/i.test(path) ? path : `/jellyfin${path}`);

async function answer(res) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

export function jf(base, { token, deviceId } = {}) {
  const call = async (method, path, { body, query } = {}) => {
    const qs = query ? `${path.includes('?') ? '&' : '?'}${new URLSearchParams(query)}` : '';
    const headers = { Authorization: authHeader({ token, deviceId }) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + full(path) + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return answer(res);
  };
  return {
    get: (path, query) => call('GET', path, { query }),
    post: (path, body, query) => call('POST', path, { body: body ?? {}, query }),
    del: (path) => call('DELETE', path),
    /** fetch() as it is: no Authorization header unless `init.headers` has one. */
    raw: (path, init = {}) => fetch(base + full(path), init),
  };
}

export async function signIn(base, username, password, { deviceId } = {}) {
  const r = await jf(base, { deviceId }).post('/Users/AuthenticateByName', { Username: username, Pw: password });
  return { status: r.status, token: r.body?.AccessToken ?? null, user: r.body?.User ?? null, body: r.body };
}
