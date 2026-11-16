// Download apps (v0.28): Sonarr, Radarr, Lidarr and Readarr call this when a download lands (or a file is renamed or
// deleted), and Atomix scans the library holding it at once instead of waiting for the next scheduled scan.
// The address carries a key an admin copies from Settings → Server → Download apps; a wrong key is a 401.
import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../http/router.js';
import { parseJson } from '../db.js';
import { logger } from '../log.js';

const log = logger('downloads');

const dir = (p) => path.posix.dirname(String(p).replace(/\\/g, '/'));
const clean = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

/** The folders a download app's message names (deepest last), without duplicates. */
export function arrPaths(body = {}) {
  const out = [];
  const add = (p) => p && !out.includes(clean(p)) && out.push(clean(p));
  add(body.series?.path);
  add(body.movie?.folderPath || body.movie?.path);
  add(body.artist?.path);
  add(body.author?.path);
  for (const f of [body.episodeFile, ...(body.episodeFiles || []), body.movieFile, body.trackFile, ...(body.trackFiles || []), body.bookFile]) if (f?.path) add(dir(f.path));
  // A file inside the series or film folder adds nothing new.
  return out.filter((p, i) => !out.some((q, j) => j < i && q === p));
}

const KIND_TYPES = { series: ['tv'], movie: ['movies'], artist: ['music'], author: ['books', 'audiobooks'] };

/** What the message is about: 'series' | 'movie' | 'artist' | 'author' | 'other'. */
export function arrKind(body = {}) {
  return body.series ? 'series' : body.movie ? 'movie' : body.artist ? 'artist' : body.author ? 'author' : 'other';
}

/**
 * The libraries to scan: those with a folder holding one of `paths` (slashes and, for drive-letter paths, case
 * ignored); when none does (the app sees the drive by another path, as from inside Docker), every library of the
 * message's kind.
 */
export function librariesFor(paths, libraries, kind) {
  const norm = (p) => {
    const c = clean(p);
    return /^[a-z]:\//i.test(c) ? c.toLowerCase() : c;
  };
  const hit = libraries.filter((lib) => lib.paths.some((root) => paths.some((p) => (norm(p) + '/').startsWith(norm(root) + '/')))).map((l) => l.id);
  if (hit.length) return hit;
  const types = KIND_TYPES[kind] || [];
  return libraries.filter((l) => types.includes(l.type)).map((l) => l.id);
}

const sameKey = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export function registerHookRoutes(r, core) {
  const { db, settings, scanner } = core;
  const keyOf = () => {
    let key = settings.get('arrKey');
    if (!key) {
      key = crypto.randomBytes(24).toString('base64url');
      settings.set({ arrKey: key });
    }
    return key;
  };

  r.get('/api/admin/arr', () => ({ key: keyOf() }), { auth: 'admin' });
  r.post('/api/admin/arr/key', () => {
    settings.set({ arrKey: crypto.randomBytes(24).toString('base64url') });
    return { key: settings.get('arrKey') };
  }, { auth: 'admin' });

  r.post(
    '/api/hooks/arr',
    async (ctx) => {
      const stored = settings.get('arrKey');
      if (!stored || !sameKey(ctx.query.key, stored)) throw new HttpError(401, 'This webhook key is wrong. Copy the address again from Settings → Server → Download apps.');
      const body = await ctx.body();
      if (body?.eventType === 'Test') return { ok: true, libraries: [] };
      const libs = db.all("SELECT id, name, type, paths FROM libraries WHERE server_id IS NULL AND type != 'podcasts'").map((l) => ({ ...l, paths: parseJson(l.paths, []) }));
      const ids = librariesFor(arrPaths(body), libs, arrKind(body));
      for (const id of ids) scanner.enqueue(id).catch((e) => log.error(e.message));
      const names = libs.filter((l) => ids.includes(l.id)).map((l) => l.name);
      log.info(`${body?.eventType || 'A message'} from ${body?.instanceName || 'a download app'}: scanning ${names.join(', ') || 'nothing (no library matches)'}`);
      return { ok: true, libraries: names };
    },
    { auth: 'none', profile: false },
  );
}
