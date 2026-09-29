// Subtitle-provider plugin for OpenSubtitles.com (REST API v1).
// Docs: https://opensubtitles.stoplight.io/docs/opensubtitles-api
import fs from 'node:fs';

const DEFAULT_BASE = 'https://api.opensubtitles.com/api/v1';
const CHUNK = 65536;
const LANG3 = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', jpn: 'ja', por: 'pt', rus: 'ru', chi: 'zh', zho: 'zh', kor: 'ko', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi', mao: 'mi', mri: 'mi' };
const lang2 = (l) => (l ? LANG3[String(l).toLowerCase()] || String(l).toLowerCase() : null);

/**
 * OpenSubtitles "moviehash": file size + the 64-bit little-endian sums of the
 * first and last 64 KB, wrapped to 64 bits. Lets it match the exact release.
 */
export async function movieHash(file) {
  const { size } = await fs.promises.stat(file);
  if (size < CHUNK * 2) return null;
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await fh.read(head, 0, CHUNK, 0);
    await fh.read(tail, 0, CHUNK, size - CHUNK);
    let hash = BigInt(size);
    for (const buf of [head, tail]) {
      for (let i = 0; i < CHUNK; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
  } finally {
    await fh.close();
  }
}

export function setup(api) {
  const override = process.env.NODEFLIX_OPENSUBTITLES_BASE; // used by tests
  let base = override || DEFAULT_BASE;
  let token = null;
  let tokenFor = null;
  let tokenExpires = 0;
  const userAgent = `NodeFlix v${api.version || '0'}`;
  const found = new Map(); // file_id → { language, label, hearingImpaired } from recent searches

  api.onConfigChange(() => {
    token = null;
  });

  async function request(method, pathname, { params, body, auth = true } = {}) {
    const cfg = api.config;
    if (!cfg.apiKey) throw new api.HttpError(400, 'Add your OpenSubtitles API key in Settings → Plugins → OpenSubtitles.');
    if (auth && cfg.username && cfg.password) await login();
    const url = new URL(base + pathname);
    // OpenSubtitles asks for alphabetically ordered, lowercase GET parameters.
    for (const key of Object.keys(params || {}).sort()) {
      const value = params[key];
      if (value != null && value !== '') url.searchParams.set(key, String(value).toLowerCase());
    }
    const headers = { 'Api-Key': cfg.apiKey, 'User-Agent': userAgent, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    const res = await api.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 406 || res.status === 429) {
      throw new api.HttpError(429, data?.message || 'The OpenSubtitles download limit has been reached. Try again later.');
    }
    if (res.status === 401 && auth && token) {
      token = null; // expired — log in again next time
      throw new api.HttpError(502, 'OpenSubtitles sign-in expired. Please try again.');
    }
    if (res.status === 401 || res.status === 403) throw new api.HttpError(502, data?.message || 'OpenSubtitles rejected the API key or login. Check the plugin settings.');
    if (!res.ok) throw new api.HttpError(502, data?.message || data?.errors?.[0] || `OpenSubtitles answered ${res.status}.`);
    return data;
  }

  async function login() {
    const cfg = api.config;
    if (token && tokenFor === cfg.username && Date.now() < tokenExpires) return;
    const data = await request('POST', '/login', { body: { username: cfg.username, password: cfg.password }, auth: false });
    token = data?.token || null;
    tokenFor = cfg.username;
    tokenExpires = Date.now() + 12 * 3600 * 1000;
    // Logged-in users may be sent to a different API host.
    if (data?.base_url && !override) base = `https://${String(data.base_url).replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v1`;
  }

  function defaultLanguages() {
    return String(api.config.languages || 'en').split(',').map((l) => lang2(l.trim())).filter(Boolean);
  }

  async function search(item, ctx = {}) {
    const languages = (ctx.languages?.length ? ctx.languages.map(lang2) : defaultLanguages()).join(',');
    const params = { languages };
    if (item.kind === 'episode') {
      const show = ctx.show || (item.show_id ? api.library.get(item.show_id) : null);
      if (show?.tmdb_id) params.parent_tmdb_id = show.tmdb_id;
      else if (show?.imdb_id) params.parent_imdb_id = String(show.imdb_id).replace(/^tt/, '');
      else params.query = show?.title || item.title;
      params.season_number = item.season;
      params.episode_number = item.episode;
    } else if (item.tmdb_id) params.tmdb_id = item.tmdb_id;
    else if (item.imdb_id) params.imdb_id = String(item.imdb_id).replace(/^tt/, '');
    else {
      params.query = item.title;
      if (item.year) params.year = item.year;
    }
    if (item.path) {
      const hash = await movieHash(item.path).catch(() => null);
      if (hash) params.moviehash = hash;
    }
    const data = await request('GET', '/subtitles', { params, auth: false });
    const out = [];
    for (const entry of data?.data || []) {
      const a = entry.attributes || {};
      const file = a.files?.[0];
      if (!file) continue;
      const result = {
        id: String(file.file_id),
        language: lang2(a.language),
        label: a.release || file.file_name || null,
        downloads: Number(a.download_count) || 0,
        hearingImpaired: Boolean(a.hearing_impaired),
        hashMatch: Boolean(a.moviehash_match),
      };
      found.set(result.id, result);
      if (found.size > 500) found.delete(found.keys().next().value);
      out.push(result);
    }
    return out;
  }

  async function download(item, fileId) {
    if (!/^\d+$/.test(fileId)) throw new api.HttpError(400, 'Bad subtitle id');
    const data = await request('POST', '/download', { body: { file_id: Number(fileId) } });
    if (!data?.link) throw new api.HttpError(502, data?.message || 'OpenSubtitles did not return a download link.');
    api.storage.set('quota', { remaining: data.remaining ?? null, resetTime: data.reset_time || null, checkedAt: Date.now() });
    const res = await api.fetch(data.link, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new api.HttpError(502, `Downloading the subtitle failed (${res.status}).`);
    const content = Buffer.from(await res.arrayBuffer());
    const meta = found.get(fileId) || {};
    return {
      content,
      format: /\.(srt|vtt|ass|ssa)$/i.exec(data.file_name || '')?.[1]?.toLowerCase() || 'srt',
      language: meta.language || defaultLanguages()[0] || null,
      label: meta.label || data.file_name || null,
      hearingImpaired: Boolean(meta.hearingImpaired),
    };
  }

  api.registerSubtitleProvider({ id: 'opensubtitles', name: 'OpenSubtitles', search, download });

  // ---- Automatic downloads for new titles ----
  const queue = [];
  let busy = false;
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const item = api.library.get(queue.shift());
        if (!item || !api.config.autoDownload || !api.config.apiKey) continue;
        const have = new Set(api.subtitles.list(item).map((s) => lang2(s.language)));
        for (const language of defaultLanguages().filter((l) => !have.has(l))) {
          const results = await search(item, { languages: [language] });
          const preferHi = Boolean(api.config.preferHearingImpaired);
          results.sort((a, b) => Number(b.hashMatch) - Number(a.hashMatch) || Number(a.hearingImpaired === preferHi ? 0 : 1) - Number(b.hearingImpaired === preferHi ? 0 : 1) || b.downloads - a.downloads);
          const best = results[0];
          if (!best) continue;
          const got = await download(item, best.id);
          api.subtitles.save(item, { ...got, provider: 'opensubtitles/opensubtitles' });
          api.log.info(`Downloaded ${language} subtitles for "${item.title}"`);
        }
      }
    } catch (err) {
      // A used-up quota stops the queue until the next new title arrives.
      api.log.warn(`Automatic subtitle download stopped: ${err.message}`);
      queue.length = 0;
    } finally {
      busy = false;
    }
  }

  api.on('item:added', ({ item }) => {
    if (!api.config.autoDownload || !['movie', 'episode'].includes(item.kind)) return;
    queue.push(item.id);
    pump();
  });
}
