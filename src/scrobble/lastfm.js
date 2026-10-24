// Last.fm: the profile signs in on last.fm (a web sign-in with a callback to Atomix), Atomix keeps the session key.
// Every call is signed with the API secret an admin entered once (Settings → Server).
import crypto from 'node:crypto';

/** api_sig: md5 of the parameters (sorted, name + value, `format` and `callback` left out) and the secret. */
export function signature(params, secret) {
  const text = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return crypto.createHash('md5').update(text + secret, 'utf8').digest('hex');
}

/** One signed POST; returns the parsed JSON (with `error` on a Last.fm error). */
export async function call(base, params, secret, fetchFn = fetch) {
  const all = { ...params };
  all.api_sig = signature(all, secret);
  all.format = 'json';
  const res = await fetchFn(base, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(all).toString(), signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => null);
  if (!j) return { error: res.status >= 500 ? 16 : 8, message: `Last.fm answered ${res.status}`, status: res.status };
  return j;
}

const STOP = new Set([4, 9, 10, 14, 26]); // auth failed, invalid session, bad key, unauthorised token, suspended key
const RETRY = new Set([8, 11, 16, 29]); // operation failed, offline, temporary error, rate limited

/** Classify a scrobble/now-playing answer: 'ok' | 'retry' | 'stop' | 'drop'. */
export function outcome(j) {
  if (!j?.error) return { result: 'ok' };
  if (STOP.has(j.error)) return { result: 'stop', message: 'Connect again' };
  if (RETRY.has(j.error)) return { result: 'retry', message: `Last.fm: ${j.message || `error ${j.error}`}` };
  return { result: 'drop', message: `Last.fm refused a scrobble: ${j.message || `error ${j.error}`}` };
}

export function trackParams(kind, t) {
  const p = { method: kind === 'now' ? 'track.updateNowPlaying' : 'track.scrobble', artist: t.artist, track: t.track };
  if (t.album) p.album = t.album;
  if (t.duration) p.duration = String(Math.round(t.duration));
  if (t.trackNumber) p.trackNumber = String(t.trackNumber);
  if (kind !== 'now') p.timestamp = String(Math.floor(t.listenedAt / 1000));
  return p;
}
