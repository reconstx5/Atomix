// Example "source" plugin: browse and play public-domain video from archive.org.
// APIs: https://archive.org/help/json.php  (please cache — it's a non-profit!)
const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata/';
const cache = new Map();

async function getJson(api, url, ttlMs = 30 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;
  const res = await api.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Atomix (self-hosted media hub)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new api.HttpError(502, `archive.org answered ${res.status}. Try again in a minute.`);
  const data = await res.json();
  cache.set(url, { data, expires: Date.now() + ttlMs });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

const text = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
const clean = (html) =>
  text(html)
    ? String(text(html)).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
    : null;
const thumb = (id) => `https://archive.org/services/img/${encodeURIComponent(id)}`;

function parseCollections(value) {
  return String(value || '')
    .split(/\r?\n|,(?=[^=]*=)/)
    .map((line) => line.split('='))
    .filter((p) => p.length === 2 && p[1].trim())
    .map(([label, id]) => ({ label: label.trim(), id: id.trim() }))
    .filter((c) => /^[\w.-]+$/.test(c.id));
}

async function search(api, query, page) {
  const cfg = api.config;
  const rows = Math.max(12, Math.min(100, Number(cfg.pageSize) || 48));
  const url = new URL(SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('fl[]', 'identifier,title,year,description'); // comma form, as in archive.org's docs
  url.searchParams.append('sort[]', cfg.sort || 'downloads desc');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('page', String(page));
  url.searchParams.set('output', 'json');
  const data = await getJson(api, url.toString());
  const docs = data?.response?.docs || [];
  const total = data?.response?.numFound || 0;
  return {
    items: docs.map((d) => ({
      id: d.identifier,
      kind: 'video',
      title: clean(d.title) || d.identifier,
      year: Number(text(d.year)) || null,
      overview: clean(d.description)?.slice(0, 400) || null,
      poster: thumb(d.identifier),
    })),
    more: page * rows < total,
  };
}

// Prefer a browser-friendly H.264 MP4 derivative, then any MP4, then WebM/Ogg.
function pickFile(files) {
  const videos = files.filter((f) => /\.(mp4|m4v|webm|ogv)$/i.test(f.name || ''));
  const score = (f) => {
    const fmt = String(f.format || '').toLowerCase();
    let s = 0;
    if (/\.(mp4|m4v)$/i.test(f.name)) s += 100;
    if (fmt === 'h.264' || fmt === 'h.264 ia') s += 50;
    else if (fmt === 'mpeg4') s += 40;
    else if (fmt.includes('512kb')) s += 20;
    if (/\.webm$/i.test(f.name)) s += 30;
    s += Math.min(Number(f.height) || 0, 1080) / 100;
    return s;
  };
  return videos.sort((a, b) => score(b) - score(a))[0] || null;
}

export function setup(api) {
  api.registerSource({
    id: 'films',
    name: 'Internet Archive',
    description: 'Public-domain films, cartoons and TV',
    icon: 'archive',
    searchable: true,
    async browse(path, ctx) {
      const q = String(ctx.query?.q || '').trim();
      if (q) {
        const page = Number(/:page:(\d+)$/.exec(path)?.[1]) || 1;
        const safe = q.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim();
        const result = await search(api, `(${safe}) AND mediatype:(movies)`, page);
        return { title: `Search: ${q}`, items: result.items, next: result.more ? `search:page:${page + 1}` : null };
      }
      if (!path) {
        return {
          title: 'Internet Archive',
          items: parseCollections(api.config.collections).map((c) => ({
            id: `collection:${c.id}`,
            path: `collection:${c.id}`,
            kind: 'folder',
            title: c.label,
            poster: thumb(c.id),
          })),
        };
      }
      const m = /^collection:([\w.-]+)(?::page:(\d+))?$/.exec(path);
      if (!m) throw new api.HttpError(404, 'Unknown folder');
      const page = Number(m[2]) || 1;
      const label = parseCollections(api.config.collections).find((c) => c.id === m[1])?.label || m[1];
      const result = await search(api, `collection:(${m[1]}) AND mediatype:(movies)`, page);
      return { title: label, items: result.items, next: result.more ? `collection:${m[1]}:page:${page + 1}` : null };
    },
    async resolve(id) {
      if (!/^[\w.-]+$/.test(id)) throw new api.HttpError(400, 'Bad identifier');
      const data = await getJson(api, META + encodeURIComponent(id), 6 * 3600 * 1000);
      const file = pickFile(data?.files || []);
      if (!file) throw new api.HttpError(404, 'This item has no browser-playable video file.');
      const encodedName = file.name.split('/').map(encodeURIComponent).join('/');
      return {
        url: `https://archive.org/download/${encodeURIComponent(id)}/${encodedName}`,
        title: clean(data?.metadata?.title) || id,
        poster: thumb(id),
        duration: Number(file.length) || null,
      };
    },
  });
}
