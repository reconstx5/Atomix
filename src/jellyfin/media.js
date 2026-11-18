// Pictures (and, in later tasks, streams and playback) for Jellyfin apps. Pictures go through Atomix's own artwork
// code (resizing, the connected-server cache) after the viewer check: a hidden title's picture is 404.
import { HttpError } from './index.js';
import { ensureVisible } from './browse.js';
import { sendArtwork } from '../library/artwork.js';

// Jellyfin's picture types -> Atomix's. Anything else (Banner, Disc, Art ...) is 404.
const IMAGE_TYPES = { primary: 'poster', backdrop: 'backdrop', thumb: 'backdrop', logo: 'logo' };

async function image(ctx) {
  const type = IMAGE_TYPES[String(ctx.params.type).toLowerCase()];
  if (!type) throw new HttpError(404);
  const row = ensureVisible(ctx, ctx.params.itemId);
  const q = ctx.query;
  // The largest width asked for (maxWidth, fillWidth or width) is the width; a tag makes the address a versioned one.
  const w = Math.max(0, ...['maxwidth', 'fillwidth', 'width'].map((k) => parseInt(q[k], 10) || 0));
  // sendArtwork reads `w` and `v` from the query, as the web's router gives them.
  const asWeb = { ...ctx, query: { ...(w ? { w: String(w) } : {}), ...(q.tag ? { v: q.tag } : {}) } };
  await sendArtwork(ctx.core, asWeb, row, type, { redirect: false });
}

export function registerMedia(j) {
  j.route('GET', '/Items/{itemId}/Images/{type}', image);
  j.route('GET', '/Items/{itemId}/Images/{type}/{index}', image);
}
