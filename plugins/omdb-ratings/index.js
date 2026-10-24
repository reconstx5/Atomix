// OMDb ratings (v0.23): IMDb, Rotten Tomatoes and Metacritic scores for films and shows. Runs after TMDB (priority
// 70) so the IMDb id TMDB found is there. Every lookup counts against a daily limit (the server's local day); with it
// used up, titles wait for a later scan. "Fetch missing scores" works through titles with none in the background.
// API: https://www.omdbapi.com — the key has to go in the address, so no address is ever logged.
import { createService, ServiceError } from '../_lib/service.js';

const NO_KEY = 'Paste your free OMDb key to start.';
const SOURCES = { 'Internet Movie Database': 'imdb', 'Rotten Tomatoes': 'rt', Metacritic: 'metacritic' };

/** OMDb's ratings as Atomix scores; "N/A" is left out. */
export function toScores(omdb) {
  const out = [];
  for (const r of omdb?.Ratings || []) {
    const source = SOURCES[r?.Source];
    if (source && r.Value && r.Value !== 'N/A' && !out.some((s) => s.source === source)) out.push({ source, value: String(r.Value) });
  }
  if (!out.some((s) => s.source === 'imdb') && /^\d+(\.\d+)?$/.test(String(omdb?.imdbRating || ''))) out.unshift({ source: 'imdb', value: `${omdb.imdbRating}/10` });
  return out;
}

/** Whether another lookup fits today's limit; a new day starts again at 0. */
export function usageAllows(usage, today, limit) {
  const u = usage && usage.day === today ? { day: today, count: Number(usage.count) || 0 } : { day: today, count: 0 };
  return { ok: u.count < limit, usage: u };
}

const today = () => new Date().toLocaleDateString('en-CA');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function setup(api) {
  const svc = createService(api, { name: 'OMDb', base: () => process.env.ATOMIX_OMDB_BASE || 'https://www.omdbapi.com' });
  svc.start();
  const limit = () => Math.max(0, Number(api.config.dailyLimit) || 0);
  const limitText = () => `Today's limit of ${limit()} lookups is used up; scores carry on tomorrow.`;
  let run = null; // { done, total } while Fetch missing scores runs
  let lastRun = null; // the sentence the last run left

  const allows = () => usageAllows(api.storage.get('usage'), today(), limit());
  // Titles that met a used-up limit wait here (kept in storage), and are offered again at the first scan once lookups
  // are allowed — not at every scan while the limit is still used up, which would refresh them all day.
  const wait = (ids) => {
    const have = new Set(api.storage.get('waiting', []));
    for (const id of ids) have.add(id);
    api.storage.set('waiting', [...have].slice(-20000));
  };
  api.on('scan:complete', () => {
    const waiting = api.storage.get('waiting', []);
    if (!waiting.length || !api.config.apiKey || !allows().ok) return;
    api.storage.set('waiting', []);
    api.metadata.offerAgain(waiting);
  });
  function showStatus() {
    if (!api.config.apiKey) return api.setStatus(NO_KEY);
    if (!allows().ok) return api.setStatus(limitText());
    api.setStatus(lastRun);
  }
  showStatus();
  let key = api.config.apiKey || '';
  api.onConfigChange((cfg) => {
    showStatus();
    const next = cfg.apiKey || '';
    if (next && next !== key) api.metadata.offerAgain();
    key = next;
  });

  /** One counted request. Throws ServiceError 'limit' (without asking) when today's lookups are used up. */
  async function ask(query) {
    const { ok, usage } = allows();
    if (!ok) {
      showStatus();
      throw new ServiceError('limit', null, 'the daily limit is used up');
    }
    api.storage.set('usage', { day: usage.day, count: usage.count + 1 });
    let data;
    try {
      data = await svc.json('/', { query: { apikey: api.config.apiKey, ...query } });
    } catch (err) {
      if (err?.kind === 'auth' && /limit reached/i.test(err.body?.Error || '')) data = err.body; // OMDb sends it as a 401
      else throw err;
    }
    svc.ok();
    if (data?.Response === 'False') {
      if (/invalid api key|no api key/i.test(data.Error || '')) throw new ServiceError('auth', 401, 'refused the key');
      if (/limit reached/i.test(data.Error || '')) {
        api.storage.set('usage', { day: usage.day, count: limit() });
        showStatus();
        throw new ServiceError('limit', null, 'the daily limit is used up');
      }
      return null; // not found
    }
    if (allows().ok) showStatus(); // a day that started again clears yesterday's limit sentence
    return data;
  }

  api.registerMetadataProvider({
    id: 'omdb-ratings',
    name: 'OMDb',
    priority: 70,
    kinds: ['movie', 'show'],
    async fetch(item, ctx) {
      if (!api.config.apiKey) return null;
      const imdb = ctx.merged?.imdbId || item.imdb_id;
      const title = ctx.merged?.title || item.title;
      const year = Number(ctx.merged?.year || item.year) || null;
      const type = item.kind === 'show' ? 'series' : 'movie';
      try {
        const scores = await svc.cached(imdb ? `i:${imdb}` : `t:${type}|${title}|${year || ''}`, { force: Boolean(ctx.force) }, async () => {
          const data = await ask(imdb ? { i: imdb } : { t: title, y: year || undefined, type });
          if (!data) return null;
          const found = Number.parseInt(String(data.Year || ''), 10);
          if (!imdb && year && found && Math.abs(found - year) > 1) return null; // another title of that name
          const s = toScores(data);
          return s.length ? s : null;
        });
        return scores ? { scores } : null;
      } catch (err) {
        if (err?.kind === 'limit') wait([item.id]);
        else svc.failed(item, err);
        return null;
      }
    },
  });

  api.registerAction('fetch-missing', async () => {
    if (!api.config.apiKey) return { message: 'Add your OMDb key first.' };
    if (run) return { message: `Already fetching scores (${run.done} of ${run.total}).` };
    const ids = api.library.list({ kind: ['movie', 'show'], missingScores: true }).map((r) => r.id);
    if (!ids.length) return { message: 'No titles are missing scores.' };
    run = { done: 0, total: ids.length };
    const queue = [...ids];
    let got = 0;
    let stopped = false;
    const worker = async () => {
      while (queue.length && !stopped) {
        if (!allows().ok) {
          stopped = true;
          break;
        }
        const id = queue.shift();
        try {
          const row = await api.metadata.refresh(id);
          if (row?.scores && row.scores !== 'null') got++;
        } catch (err) {
          api.log.warn(`Couldn't refresh a title: ${err.message}`);
        }
        run.done++;
      }
    };
    (async () => {
      await Promise.all([worker(), worker(), worker()]);
      if (stopped && queue.length) wait(queue);
      lastRun = `Last fetch: scores for ${got} of ${plural(ids.length, 'title', 'titles')}${stopped && queue.length ? '; the daily limit stopped it, the rest follow tomorrow' : ''}.`;
      run = null;
      api.setStatus(lastRun);
    })().catch((err) => {
      run = null;
      api.log.warn(`Fetch missing scores stopped: ${err.message}`);
    });
    return { message: `Fetching scores for ${plural(ids.length, 'title', 'titles')} in the background.` };
  });

  return () => svc.flush();
}
