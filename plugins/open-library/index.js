// Open Library (v0.23): descriptions, covers, first-published years and subjects for books and audiobooks — only
// where the book itself has none (core keeps books fill-only). By ISBN when the EPUB has one, else title + author.
// About one request a second, with a User-Agent naming Atomix, as Open Library asks.
// API: https://openlibrary.org/dev/docs/api/search
import { createService } from '../_lib/service.js';

const NOISE = /^(accessible book|protected daisy|in library|large type books|lending library)$/i;

/** Open Library's description (a string or { value }) without its "----------" appendix or link references. */
export function cleanDescription(d) {
  let text = typeof d === 'string' ? d : typeof d?.value === 'string' ? d.value : '';
  text = text.split(/\n\s*-{5,}\s*\n?/)[0];
  text = text.replace(/\s*\(\[[^\]]*\]\[\d+\]\)/g, '').replace(/^\s*\[\d+\]:\s*\S+.*$/gm, '');
  text = text.trim();
  return text || null;
}

/** Up to 3 subjects that read as genres. */
export function pickSubjects(subjects) {
  const list = (Array.isArray(subjects) ? subjects : []).map((s) => String(s).trim()).filter((s) => s && !s.includes(':') && !NOISE.test(s));
  const unique = [...new Map(list.map((s) => [s.toLowerCase(), s])).values()];
  const others = unique.filter((s) => s.toLowerCase() !== 'fiction');
  return (others.length ? others : unique).slice(0, 3).map((s) => s[0].toUpperCase() + s.slice(1));
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');

/** The search result that is this book: the same title (a ": subtitle" may follow) by the same author. */
function matching(docs, title, author) {
  const want = norm(title);
  const last = norm(author).split(' ').pop();
  return (docs || []).find((d) => {
    const t = norm(d.title);
    const sameTitle = t === want || norm(String(d.title || '').split(':')[0]) === want;
    const sameAuthor = !last || (d.author_name || []).some((a) => norm(a).split(' ').includes(last));
    return sameTitle && sameAuthor;
  });
}

const filled = (v) => v != null && v !== '' && v !== '[]';

export function setup(api) {
  const svc = createService(api, {
    name: 'Open Library',
    base: () => process.env.ATOMIX_OPENLIBRARY_BASE || 'https://openlibrary.org',
    gapMs: 1000,
    headers: () => ({ 'User-Agent': `Atomix/${api.version || '0'}` }),
  });
  svc.start();
  const covers = () => (process.env.ATOMIX_OPENLIBRARY_COVERS_BASE || 'https://covers.openlibrary.org').replace(/\/$/, '');

  async function lookup({ isbn, title, author }, force) {
    return svc.cached(isbn ? `isbn:${isbn}` : `ta:${norm(title)}|${norm(author)}`, { force }, async () => {
      const query = { fields: 'key,title,author_name,first_publish_year,cover_i,subject', limit: 5, ...(isbn ? { isbn } : { title, author: author || undefined }) };
      const found = await svc.json('/search.json', { query });
      svc.ok();
      const doc = isbn ? found?.docs?.[0] : matching(found?.docs, title, author);
      if (!doc) return null;
      let description = null;
      if (/^\/works\/OL\d+W$/.test(doc.key || '')) {
        const work = await svc.json(`${doc.key}.json`);
        description = cleanDescription(work?.description);
      }
      return { description, cover: Number.isInteger(doc.cover_i) && doc.cover_i > 0 ? doc.cover_i : null, year: Number(doc.first_publish_year) || null, subjects: pickSubjects(doc.subject) };
    });
  }

  api.registerMetadataProvider({
    id: 'open-library',
    name: 'Open Library',
    priority: 60,
    kinds: ['book', 'audiobook'],
    async fetch(item, ctx) {
      if (!ctx.force && [item.overview, item.poster, item.year, item.genres].every(filled)) return null; // nothing to fill
      let isbn = null;
      try {
        isbn = JSON.parse(item.media || 'null')?.isbn || null;
      } catch {
        isbn = null;
      }
      if (!isbn && !item.title) return null;
      try {
        const found = await lookup({ isbn, title: item.title, author: item.author }, Boolean(ctx.force));
        if (!found) return null;
        return {
          overview: found.description,
          poster: found.cover ? `${covers()}/b/id/${found.cover}-L.jpg` : null,
          year: found.year,
          genres: found.subjects,
        };
      } catch (err) {
        svc.failed(item, err);
        return null;
      }
    },
  });

  return () => svc.flush();
}
