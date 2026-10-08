// Fetch wrapper for the Atomix JSON API.
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let onUnauthorized = () => {};
let onProfileRequired = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}
export function setProfileRequiredHandler(fn) {
  onProfileRequired = fn;
}

async function request(method, url, body, { keepalive = false, signal } = {}) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    keepalive,
    signal,
  });
  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized();
    if (res.status === 428 && data?.details?.code === 'PROFILE_REQUIRED') onProfileRequired();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body, opts) => request('POST', url, body, opts),
  put: (url, body, opts) => request('PUT', url, body, opts),
  patch: (url, body, opts) => request('PATCH', url, body, opts),
  del: (url, body, opts) => request('DELETE', url, body, opts),
};

export function qs(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '' && v !== false) search.set(k, v === true ? '1' : v);
  const s = search.toString();
  return s ? `?${s}` : '';
}
