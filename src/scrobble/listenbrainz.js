// ListenBrainz (listenbrainz.org): a user token pasted from their settings page. "playing_now" at a song's start,
// a "single" listen once it's counted.

/** @returns {Promise<{ valid: boolean, user?: string }>} */
export async function validateToken(base, token, fetchFn = fetch) {
  const res = await fetchFn(`${base.replace(/\/$/, '')}/1/validate-token`, { headers: { Authorization: `Token ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { valid: false };
  const j = await res.json().catch(() => ({}));
  return { valid: Boolean(j.valid), user: j.user_name };
}

/** The listen as ListenBrainz wants it. `listenedAt` (ms) only for a listen, not for "now playing". */
export function listenBody(kind, t, version) {
  const meta = {
    artist_name: t.artist,
    track_name: t.track,
    ...(t.album ? { release_name: t.album } : {}),
    additional_info: { duration_ms: t.duration ? Math.round(t.duration * 1000) : undefined, tracknumber: t.trackNumber ?? undefined, submission_client: 'Atomix', submission_client_version: version },
  };
  const entry = kind === 'now' ? { track_metadata: meta } : { listened_at: Math.floor(t.listenedAt / 1000), track_metadata: meta };
  return { listen_type: kind === 'now' ? 'playing_now' : 'single', payload: [entry] };
}

/** Send; returns 'ok' | 'retry' | 'stop' | 'drop' and a message. */
export async function submit(base, token, body, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`${base.replace(/\/$/, '')}/1/submit-listens`, { method: 'POST', headers: { Authorization: `Token ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    return { result: 'retry', message: `Couldn't reach ListenBrainz (${err.cause?.code || err.name})` };
  }
  await res.arrayBuffer().catch(() => {});
  if (res.ok) return { result: 'ok' };
  if (res.status === 401 || res.status === 403) return { result: 'stop', message: 'Connect again' };
  if (res.status === 429 || res.status >= 500) return { result: 'retry', message: `ListenBrainz answered ${res.status}` };
  return { result: 'drop', message: `ListenBrainz refused a listen (${res.status})` };
}
