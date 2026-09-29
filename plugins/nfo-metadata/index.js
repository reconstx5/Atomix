// Example metadata-provider plugin: Kodi .nfo files.
// https://kodi.wiki/view/NFO_files
import fs from 'node:fs';
import path from 'node:path';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(\w+);/g, (m, name) => ENTITIES[name] ?? m)
    .trim();
}

/** All values of <tag ...>value</tag> (non-greedy, attributes allowed). */
function tags(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', value: decode(m[2]) });
  return out;
}
const first = (xml, tag) => tags(xml, tag)[0]?.value || null;
const attr = (attrs, name) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1] ?? null;

function readNfo(file) {
  try {
    const buf = fs.readFileSync(file);
    return buf.toString('utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

export function parseNfo(xml, { useArtworkUrls = true } = {}) {
  if (!xml) return null;
  const out = {};
  // "URL-only" NFOs just contain a link to TMDB or IMDb.
  const tmdbLink = /themoviedb\.org\/(?:movie|tv)\/(\d+)/i.exec(xml);
  const imdbLink = /imdb\.com\/title\/(tt\d+)/i.exec(xml);
  if (!/<(movie|tvshow|episodedetails)[\s>]/i.test(xml)) {
    if (tmdbLink) out.tmdbId = Number(tmdbLink[1]);
    if (imdbLink) out.imdbId = imdbLink[1];
    return Object.keys(out).length ? out : null;
  }

  // Strip nested <actor>/<set>/<fileinfo> blocks so their <name>/<thumb> tags don't confuse us.
  const body = xml.replace(/<(actor|set|fileinfo|streamdetails)[\s>][\s\S]*?<\/\1>/gi, '');
  out.title = first(body, 'title');
  out.originalTitle = first(body, 'originaltitle');
  out.overview = first(body, 'plot') || first(body, 'outline');
  out.tagline = first(body, 'tagline');
  const year = first(body, 'year') || (first(body, 'premiered') || first(body, 'aired') || '').slice(0, 4);
  if (/^\d{4}$/.test(year || '')) out.year = Number(year);
  out.airDate = first(body, 'premiered') || first(body, 'aired');
  const runtime = Number(first(body, 'runtime'));
  if (runtime > 0) out.runtime = runtime;
  out.genres = tags(body, 'genre').flatMap((g) => g.value.split(/\s*[/|]\s*/)).filter(Boolean);

  const ratingBlocks = tags(body, 'rating');
  const defaultRating = ratingBlocks.find((r) => attr(r.attrs, 'default') === 'true') || ratingBlocks[0];
  if (defaultRating) {
    const value = Number(first(`<x>${defaultRating.value}</x>`, 'value') ?? defaultRating.value);
    if (value > 0) out.rating = Math.round(value * 10) / 10;
  }

  for (const u of tags(body, 'uniqueid')) {
    const type = (attr(u.attrs, 'type') || '').toLowerCase();
    if (type === 'tmdb' && /^\d+$/.test(u.value)) out.tmdbId = Number(u.value);
    if (type === 'imdb' && /^tt\d+$/.test(u.value)) out.imdbId = u.value;
  }
  if (!out.tmdbId && /^\d+$/.test(first(body, 'tmdbid') || '')) out.tmdbId = Number(first(body, 'tmdbid'));
  const imdb = first(body, 'imdbid') || first(body, 'id');
  if (!out.imdbId && /^tt\d+$/.test(imdb || '')) out.imdbId = imdb;
  if (!out.tmdbId && tmdbLink) out.tmdbId = Number(tmdbLink[1]);

  // Age rating: <mpaa>Rated PG-13</mpaa>, <mpaa>NZ:M</mpaa>, <certification>US:PG-13 / GB:12A</certification>
  const cert = first(body, 'mpaa') || first(body, 'certification');
  if (cert) out.certification = cert.replace(/^rated\s+/i, '').split(/\s*\/\s*/)[0].trim();

  if (useArtworkUrls) {
    const thumbs = tags(body.replace(/<fanart[\s>][\s\S]*?<\/fanart>/gi, ''), 'thumb');
    const poster = thumbs.find((t) => (attr(t.attrs, 'aspect') || 'poster') === 'poster' && !attr(t.attrs, 'season'));
    if (poster && /^https?:\/\//.test(poster.value)) out.poster = poster.value;
    const fanartBlock = /<fanart[\s>]([\s\S]*?)<\/fanart>/i.exec(body)?.[1];
    const fanart = fanartBlock ? tags(fanartBlock, 'thumb')[0]?.value : null;
    if (fanart && /^https?:\/\//.test(fanart)) out.backdrop = fanart;
  }
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
  return out;
}

function nfoFor(item) {
  if (!item.path || item.path.includes('::')) return null;
  if (item.kind === 'show') return path.join(item.path, 'tvshow.nfo');
  const dir = path.dirname(item.path);
  const own = path.join(dir, path.parse(item.path).name + '.nfo');
  if (fs.existsSync(own)) return own;
  if (item.kind === 'movie') {
    const generic = path.join(dir, 'movie.nfo');
    if (fs.existsSync(generic)) return generic;
  }
  return null;
}

export function setup(api) {
  const config = api.config;
  api.registerMetadataProvider({
    id: 'nfo',
    name: 'Kodi NFO files',
    priority: Number(config.priority) || 10,
    kinds: ['movie', 'show', 'episode'],
    async fetch(item) {
      const file = nfoFor(item);
      if (!file) return null;
      const result = parseNfo(readNfo(file), { useArtworkUrls: api.config.useArtworkUrls !== false });
      if (result) api.log.debug(`Read ${file}`);
      return result;
    },
  });
}
