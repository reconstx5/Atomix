// Shared by the info plugins (v0.23): one request at a time with a gap between them, a timeout, JSON, results
// kept in the plugin's storage, a failure logged once per outage, and titles that failed offered again at the next
// scan. Not a plugin itself: Atomix skips folders whose names start with "_".

const MISS_KEEP_MS = 30 * 86400000;

export class ServiceError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.kind = kind; // 'auth' | 'limit' | 'down'
    this.status = status;
  }
}

/**
 * @param {object} api the plugin api
 * @param {{ name: string, base: () => string, gapMs?: number, timeoutMs?: number, headers?: () => object }} opts
 */
export function createService(api, { name, base, gapMs = 0, timeoutMs = 15000, headers = () => ({}), coolMs = 5 * 60000 }) {
  let chain = Promise.resolve();
  let lastEnd = 0;
  let outage = false;
  // Once the service stops answering (no answer, a timeout, a 5xx), lookups fail at once — no request, no wait —
  // until coolMs passes or the next scan ends; then one request tries it again. A hung service can't make a scan
  // wait 15 s per title.
  let downUntil = 0;
  const noted = new Set();

  /**
   * One request at a time: each starts no sooner than gapMs after the previous one was answered (counting from the
   * answer, a slow reply can never bring the next request closer than the gap). Returns a function that ends the turn.
   */
  function turn() {
    let done;
    const finished = new Promise((r) => (done = r));
    const mine = chain.then(async () => {
      const wait = lastEnd + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    });
    chain = mine.then(() => finished).then(() => {
      lastEnd = Date.now();
    });
    return mine.then(() => done);
  }

  async function json(pathOrUrl, { query } = {}) {
    const url = new URL(/^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : base().replace(/\/$/, '') + pathOrUrl);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    if (Date.now() < downUntil) throw new ServiceError('down', null, 'not answering');
    const end = await turn();
    try {
      if (Date.now() < downUntil) throw new ServiceError('down', null, 'not answering'); // went down while we waited
      return await request(url);
    } catch (err) {
      if (err?.kind === 'down' && Date.now() >= downUntil) downUntil = Date.now() + coolMs;
      throw err;
    } finally {
      end();
    }
  }

  async function request(url) {
    let res;
    try {
      res = await api.fetch(url, { headers: { Accept: 'application/json', ...headers() }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // The message is ours: an address (and a key in it) never reaches a log.
      throw new ServiceError('down', null, err?.name === 'TimeoutError' ? 'timed out' : 'no answer');
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      // Some services say why in the body (OMDb's "Request limit reached!" comes as a 401): the caller can read it.
      const err = new ServiceError('auth', res.status, `refused (${res.status})`);
      err.body = await res.json().catch(() => null);
      throw err;
    }
    if (res.status === 429) throw new ServiceError('limit', 429, 'too many requests');
    if (!res.ok) throw new ServiceError('down', res.status, `answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new ServiceError('down', res.status, 'sent something that isn’t JSON');
    }
  }

  async function cached(key, { force } = {}, fn) {
    const k = `cache:${key}`;
    const have = api.storage.get(k);
    if (!force && have && (have.value != null || Date.now() - have.at < MISS_KEEP_MS)) return have.value;
    const value = await fn();
    api.storage.set(k, { at: Date.now(), value: value ?? null });
    return value ?? null;
  }

  function failed(item, err) {
    try {
      if (err?.kind === 'auth') {
        api.setStatus?.(`${name} refused the key. Check it in the settings below.`);
        return;
      }
      if (item?.id != null) noted.add(item.id);
      if (err?.kind === 'limit') return; // the plugin says so on its card
      if (!outage) {
        outage = true;
        api.log.warn(`${name} can't be reached (${err?.message || 'no answer'}); titles are tried again at the next scan.`);
      }
    } catch {
      /* never throws */
    }
  }

  function ok() {
    outage = false;
    downUntil = 0;
  }

  function flush() {
    if (!noted.size) return 0;
    const ids = [...noted];
    noted.clear();
    return api.metadata.offerAgain(ids);
  }

  function start() {
    api.on('scan:complete', () => {
      downUntil = 0; // the next scan tries it again
      flush();
    });
  }

  return { json, cached, failed, ok, start, flush };
}

/** The base language code of a metadata language: 'en-US' → 'en'. */
export const baseLanguage = (lang) => String(lang || 'en').split(/[-_]/)[0].toLowerCase();
