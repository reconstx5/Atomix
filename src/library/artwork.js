// Sending a title's artwork (poster, backdrop, logo): a cached or local file, or — for a connected server's picture —
// fetched once with that server's sign-in and cached. `redirect: false` (music apps) downloads an address once into
// the cache instead of sending the client to it.
import { HttpError } from '../http/router.js';
import { sendPicture } from './thumbs.js';
import { isRemotePath, resolveSource } from '../remote/index.js';

// Album art, artists, podcasts and songs are square; everything else uses the poster, backdrop or logo sizes.
const SQUARE = new Set(['album', 'artist', 'track', 'podcast', 'podcast_episode']);

export async function sendArtwork(core, ctx, row, type, { redirect = true } = {}) {
  const { db, library, images } = core;
  const sizes = type === 'poster' && SQUARE.has(row.kind) ? 'square' : type;
  // stable: a downloaded copy is named by its source, so a versioned address can be kept for a year.
  const send = (file, stable = true) => sendPicture(core, ctx, file, { type: sizes, stable });
  let ref = row[type];
  // Tracks use their album's cover.
  if (!ref && row.kind === 'track' && row.parent_id) ref = library.get(row.parent_id)?.[type];
  // A connected server's artwork is fetched with that server's sign-in and cached here, never redirected to.
  if (isRemotePath(row.path) && /^https?:\/\//i.test(ref || '')) {
    // Kept already: sent without asking the server (or signing in to it) — it may be down, or slow.
    const kept = images.cachedPicture(ref);
    if (kept) {
      const ok = await send(images.resolve(kept).file);
      if (ok) return;
    }
    const src = await resolveSource({ db, providers: core.remote.providers }, row);
    // The sign-in only goes to the server's own host: an image a Plex agent left on a CDN gets no token.
    const cached = src.provider ? await images.download(ref, src.provider.imageHeaders(src.server, ref)).catch(() => null) : null;
    if (!cached) throw new HttpError(404, 'No image');
    const ok = await send(images.resolve(cached).file);
    if (!ok) throw new HttpError(404, 'Image missing');
    return;
  }
  let resolved = images.resolve(ref);
  if (!resolved) throw new HttpError(404, 'No image');
  if (resolved.url) {
    if (redirect) return ctx.redirect(resolved.url);
    const cached = await images.download(resolved.url).catch(() => null);
    resolved = cached ? images.resolve(cached) : null;
    if (!resolved?.file) throw new HttpError(404, 'No image');
  }
  // A folder's own picture (file:) can be replaced in place under the same address: not kept for a year.
  const ok = await send(resolved.file, !String(ref).startsWith('file:'));
  if (!ok) throw new HttpError(404, 'Image missing');
}
