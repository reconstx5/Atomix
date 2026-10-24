// Reading podcast feeds (v0.22): RSS 2.0 with the iTunes tags, and Atom. Parsed with the DOM-free XML reader the
// DASH code uses (no DOCTYPE or entity declarations, hard limits), fetched with the validators so an unchanged feed
// costs a 304, capped at 5 MB, and only from addresses Atomix may be pointed at.
import { parseXml, localName } from '../../public/js/dash/xml.js';
import { HttpError } from '../http/router.js';
import { checkResolved } from '../http/net.js';
import { fetchFollowing } from '../remote/provider.js';

export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_EPISODES = 500;
const NOT_A_FEED = "That isn't a podcast feed.";

// HTML's named characters that turn up unescaped in feeds; the XML reader knows only XML's five.
const HTML_ENTITIES = { nbsp: 160, copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, laquo: 171, raquo: 187, eacute: 233, egrave: 232, uuml: 252, ouml: 246, auml: 228, ccedil: 231, deg: 176, middot: 183, bull: 8226 };
const withHtmlEntities = (s) => s.replace(/&([a-zA-Z]+);/g, (m, n) => (HTML_ENTITIES[n] ? `&#${HTML_ENTITIES[n]};` : m));

const kids = (el, name) => el.children.filter((c) => localName(c.name) === name);
const kid = (el, name) => kids(el, name)[0] || null;
const text = (el, name) => {
  const c = kid(el, name);
  const t = c ? c.text.trim() : '';
  return t || null;
};
const yes = (v) => /^(yes|true|explicit)$/i.test(String(v || '').trim());
const int = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(v) : null);

/** "HH:MM:SS", "MM:SS" or plain seconds → seconds; null when it's none of those. */
export function parseDuration(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':');
  if (parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  return Math.round(parts.reduce((sum, p) => sum * 60 + Number(p), 0));
}

const date = (v) => {
  const t = Date.parse(String(v || '').trim());
  return Number.isFinite(t) ? t : null;
};

function rssEpisode(item) {
  const enc = kid(item, 'enclosure');
  const img = kids(item, 'image').find((c) => c.attrs.href);
  return {
    guid: text(item, 'guid'),
    title: text(item, 'title') || 'Untitled episode',
    description: text(item, 'description') || text(item, 'summary') || null,
    publishedAt: date(text(item, 'pubDate')),
    enclosure: enc?.attrs.url ? { url: enc.attrs.url, type: enc.attrs.type || null, length: int(enc.attrs.length) } : null,
    duration: parseDuration(text(item, 'duration')),
    image: img?.attrs.href || null,
    explicit: yes(text(item, 'explicit')),
    season: int(text(item, 'season')),
    episode: int(text(item, 'episode')),
  };
}

function atomEpisode(entry) {
  const enc = kids(entry, 'link').find((l) => l.attrs.rel === 'enclosure');
  return {
    guid: text(entry, 'id'),
    title: text(entry, 'title') || 'Untitled episode',
    description: text(entry, 'summary') || text(entry, 'content') || null,
    publishedAt: date(text(entry, 'published') || text(entry, 'updated')),
    enclosure: enc?.attrs.href ? { url: enc.attrs.href, type: enc.attrs.type || null, length: int(enc.attrs.length) } : null,
    duration: null,
    image: null,
    explicit: false,
    season: null,
    episode: null,
  };
}

/** Every category's text, nested ones too (iTunes nests subcategories), in order, once each. */
function categories(channel) {
  const out = [];
  const walk = (el) => {
    for (const c of kids(el, 'category')) {
      const t = (c.attrs.text || c.text || '').trim();
      if (t && !out.includes(t)) out.push(t);
      walk(c);
    }
  };
  walk(channel);
  return out;
}

/**
 * @param {string} xml
 * @returns {{ title, author, description, image, explicit: boolean, categories: string[], link, episodes: object[] }}
 */
export function parseFeed(xml) {
  let root;
  try {
    root = parseXml(withHtmlEntities(String(xml ?? '')), { maxBytes: FEED_MAX_BYTES, maxNodes: 200_000 });
  } catch {
    throw new HttpError(400, NOT_A_FEED);
  }
  const top = localName(root?.name || '');
  let out;
  if (top === 'rss') {
    const ch = kid(root, 'channel');
    if (!ch) throw new HttpError(400, NOT_A_FEED);
    const img = kids(ch, 'image').find((c) => c.attrs.href)?.attrs.href || text(kid(ch, 'image') || { children: [] }, 'url');
    out = {
      title: text(ch, 'title') || 'Untitled podcast',
      author: text(ch, 'author') || text(ch, 'managingEditor') || null,
      description: text(ch, 'description') || text(ch, 'summary') || null,
      image: img || null,
      explicit: yes(text(ch, 'explicit')),
      categories: categories(ch),
      link: text(ch, 'link'),
      episodes: kids(ch, 'item').map(rssEpisode),
    };
  } else if (top === 'feed') {
    const author = kid(root, 'author');
    out = {
      title: text(root, 'title') || 'Untitled podcast',
      author: author ? text(author, 'name') : null,
      description: text(root, 'subtitle'),
      image: text(root, 'logo') || text(root, 'icon'),
      explicit: false,
      categories: kids(root, 'category').map((c) => c.attrs.term).filter(Boolean),
      link: kids(root, 'link').find((l) => !l.attrs.rel || l.attrs.rel === 'alternate')?.attrs.href || null,
      episodes: kids(root, 'entry').map(atomEpisode),
    };
  } else throw new HttpError(400, NOT_A_FEED);
  // Newest first (undated ones after the dated), the newest 500.
  out.episodes.sort((a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity));
  out.episodes = out.episodes.slice(0, MAX_EPISODES);
  return out;
}

/** How an episode is recognised from one check to the next: its GUID, else its enclosure address, else title|date. */
export function episodeKey(e) {
  return e.guid || e.enclosure?.url || `${e.title}|${e.publishedAt}`;
}

const KEEP = new Set(['if-none-match', 'if-modified-since', 'range', 'if-range', 'user-agent', 'accept']);

/** The address rule as an HttpError a person reads. */
export async function checkAddress(url, lookup) {
  try {
    await checkResolved(url, lookup ? { lookup } : {});
  } catch (err) {
    if (err.code === 'EPRIVATE') throw new HttpError(400, "That address can't be used.");
    throw err;
  }
}

/** fetchFollowing with the address rule on every hop, and the request's own headers kept across hosts. */
export function fetchChecked(url, { headers = {}, signal, lookup } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new HttpError(400, "That address can't be used.");
  return fetchFollowing(url, { headers: { 'user-agent': 'Atomix', ...headers }, signal, max: 5, check: (u) => checkAddress(u, lookup), keepHeader: (k) => KEEP.has(k) });
}

/**
 * @returns {Promise<{status: 304} | {status: 200, xml: string, etag: string|null, lastModified: string|null}>}
 */
export async function fetchFeed(url, { etag, lastModified, lookup } = {}) {
  const headers = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;
  const res = await fetchChecked(url, { headers, signal: AbortSignal.timeout(20000), lookup });
  if (res.status === 304) {
    await res.body?.cancel().catch(() => {});
    return { status: 304 };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(502, `The feed answered ${res.status}.`);
  }
  if (Number(res.headers.get('content-length')) > FEED_MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(400, 'That feed is too big (over 5 MB).');
  }
  const parts = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > FEED_MAX_BYTES) {
      await res.body.cancel?.().catch(() => {});
      throw new HttpError(400, 'That feed is too big (over 5 MB).');
    }
    parts.push(Buffer.from(chunk));
  }
  return { status: 200, xml: Buffer.concat(parts).toString('utf8'), etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}
