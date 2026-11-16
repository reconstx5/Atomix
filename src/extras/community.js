// TheIntroDB (v0.28): shared intro, recap and credits timestamps that people submit, the way Infuse skips recaps.
// Asked only when an admin leaves "Use shared skip timestamps" on, for episodes of shows with a TMDB id; what is
// sent is the TMDB id, the season and episode numbers and the file's length (to pick the right release). Free API,
// no key; 30 requests per 10 seconds, so the background job spaces them out.
export const INTRODB_BASE = process.env.ATOMIX_INTRODB_BASE || 'https://api.theintrodb.org/v4';

/** The address for one episode (or a film, without season and episode). */
export function introDbUrl(base, { tmdbId, season = null, episode = null, duration = null }) {
  const q = new URLSearchParams({ tmdb_id: String(tmdbId) });
  if (season != null && episode != null) {
    q.set('season', String(season));
    q.set('episode', String(episode));
  }
  if (duration > 0) q.set('duration_ms', String(Math.round(duration * 1000)));
  return `${base}/media?${q}`;
}

/**
 * TheIntroDB's answer → { intro, recap, credits } in seconds (null when there is none). Intro and recap may start
 * "from the beginning" (start null) and end at 0 for "none"; credits may run "to the end" (end null).
 */
export function segmentsFromIntroDb(json, duration) {
  const out = { intro: null, recap: null, credits: null };
  if (!json || typeof json !== 'object') return out;
  for (const kind of ['intro', 'recap', 'credits']) {
    const seg = Array.isArray(json[kind]) ? json[kind][0] : null;
    if (!seg) continue;
    const start = seg.start_ms == null ? 0 : Number(seg.start_ms) / 1000;
    let end = seg.end_ms == null ? (kind === 'credits' ? duration : null) : Number(seg.end_ms) / 1000;
    if (kind !== 'credits' && !(end > 0)) continue; // end 0: there isn't one
    if (kind === 'credits' && !(start > 0)) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue;
    if (duration > 0) end = Math.min(end, duration);
    out[kind] = { start, end };
  }
  return out;
}

/** Ask TheIntroDB for one episode. Resolves to { intro, recap, credits } or null when it doesn't answer. */
export async function fetchSegments({ base = INTRODB_BASE, tmdbId, season, episode, duration, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(introDbUrl(base, { tmdbId, season, episode, duration }), { headers: { accept: 'application/json', 'user-agent': 'Atomix (self-hosted media server)' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return { intro: null, recap: null, credits: null };
    if (!res.ok) return null;
    return segmentsFromIntroDb(await res.json(), duration);
  } catch {
    return null;
  }
}
