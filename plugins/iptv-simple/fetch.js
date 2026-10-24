// Opening a playlist or guide: an http(s) address (with the user agent, a time limit and a size cap) or a file on
// this server. Errors are sentences that never repeat the address (providers put logins in it).
import fs from 'node:fs';
import path from 'node:path';

const WHAT = { playlist: 'The playlist', guide: 'The guide' };
const isWindowsAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);

/**
 * @param {string} location  URL or absolute file path
 * @param {{ userAgent: string, signal?: AbortSignal, maxBytes?: number, what: 'playlist'|'guide', timeoutMs?: number,
 *   timeouts?: { headers?: number, idle?: number } }} opts  30 s to reach the server, then 30 s without data at most
 *   (a big guide may take minutes to download; it only fails when it stops arriving)
 * @param {object} api  the plugin api (fetchFollowing, isPrivateTarget)
 * @returns {Promise<AsyncIterable<Buffer>>}
 */
export async function openInput(location, { userAgent, signal, maxBytes = 200 * 1024 * 1024, what, timeoutMs = 30_000, timeouts = {} }, api) {
  const label = WHAT[what] || 'The file';
  const loc = String(location || '').trim();
  if (/^https?:\/\//i.test(loc)) {
    const refused = Object.assign(new Error("That address isn't allowed"), { code: 'EPRIVATE' });
    const check = async (u) => {
      if (api.isPrivateTarget?.(u)) throw refused;
      if (api.checkResolved) await api.checkResolved(u).catch(() => Promise.reject(refused)); // names, too
    };
    await check(loc);
    const limits = { headers: timeouts.headers ?? timeoutMs, idle: timeouts.idle ?? timeoutMs };
    const ac = new AbortController();
    let timer = null;
    let timedOut = false;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, ms);
      timer.unref?.();
    };
    const timeout = { get aborted() { return timedOut; } };
    arm(limits.headers);
    const sig = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
    let res;
    try {
      // Every redirect hop is checked too (a provider address can't lead to a link-local one).
      res = await api.fetchFollowing(loc, { headers: { 'User-Agent': userAgent, Accept: '*/*' }, signal: sig, check });
    } catch (err) {
      if (err?.code === 'EPRIVATE') throw refused;
      if (timeout.aborted || err?.name === 'TimeoutError') throw new Error(`${label} took too long to answer`);
      throw new Error(`${label} didn't answer — check the address`);
    }
    arm(limits.idle);
    if (!res.ok) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => {});
      throw new Error(what === 'playlist' ? `The playlist didn't answer (HTTP ${res.status}) — check the address and that your subscription is active` : `${label} didn't answer (HTTP ${res.status})`);
    }
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => {});
      throw new Error(`${label} is larger than ${Math.round(maxBytes / 1048576)} MB`);
    }
    return capped(res.body, maxBytes, label, () => timedOut, { onChunk: () => arm(limits.idle), onEnd: () => clearTimeout(timer) });
  }
  if (!path.isAbsolute(loc) && !isWindowsAbsolute(loc)) throw new Error('Use a full file path (for example D:\\TV\\playlist.m3u)');
  let stat;
  try {
    stat = await fs.promises.stat(loc);
  } catch {
    throw new Error("There's no file at that path");
  }
  if (!stat.isFile()) throw new Error("There's no file at that path");
  if (stat.size > maxBytes) throw new Error(`${label} is larger than ${Math.round(maxBytes / 1048576)} MB`);
  return fs.createReadStream(loc);
}

async function* capped(body, maxBytes, label, timedOut, { onChunk = () => {}, onEnd = () => {} } = {}) {
  let total = 0;
  try {
    for await (const chunk of body) {
      onChunk();
      total += chunk.length;
      if (total > maxBytes) throw new Error(`${label} is larger than ${Math.round(maxBytes / 1048576)} MB`);
      yield Buffer.from(chunk);
    }
  } catch (err) {
    if (timedOut()) throw new Error(`${label} took too long to answer`);
    throw err;
  } finally {
    onEnd();
  }
}

/** The whole input as text (playlists are small next to guides). */
export async function readText(stream) {
  const parts = [];
  for await (const c of stream) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
}
