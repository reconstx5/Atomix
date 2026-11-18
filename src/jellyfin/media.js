// Pictures, PlaybackInfo and the stream for Jellyfin apps. Everything goes through the viewer check first: a hidden
// title's picture, PlaybackInfo or stream is 404.
//
// Playing is direct play only: the original file with ranges (seeking in place), as /api/items/:id/file serves it. A
// connected server's title is fetched and passed through by Atomix (proxyRemoteFile), so the far server's address
// and token stay on the server. A stream takes the device's one slot of the account's stream cap (sessions.js)
// before any byte is sent, so a refused device gets nothing; a HEAD takes no slot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpError } from './index.js';
import { ensureVisible } from './browse.js';
import { mediaSources } from './shapes.js';
import { sendArtwork } from '../library/artwork.js';
import { sendFile, mimeFor } from '../http/static.js';
import { isRemotePath } from '../remote/index.js';
import { proxyRemoteFile } from '../stream/remotefile.js';

// Jellyfin's picture types -> Atomix's. Anything else (Banner, Disc, Art ...) is 404.
const IMAGE_TYPES = { primary: 'poster', backdrop: 'backdrop', thumb: 'backdrop', logo: 'logo' };
const PLAYABLE = new Set(['movie', 'episode']);

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

/** A film or an episode with a file the viewer may see; anything else is 404. */
function playableRow(ctx) {
  const row = ensureVisible(ctx, ctx.params.itemId);
  if (!PLAYABLE.has(row.kind) || !row.path) throw new HttpError(404);
  return row;
}

function playbackInfo(ctx) {
  const row = playableRow(ctx);
  return { MediaSources: mediaSources(row), PlaySessionId: crypto.randomBytes(16).toString('hex') };
}

async function stream(ctx) {
  const row = playableRow(ctx);
  const { core, req, res } = ctx;
  const remote = isRemotePath(row.path);
  if (!remote) {
    const stat = await fs.promises.stat(row.path).catch(() => null);
    if (!stat?.isFile()) throw new HttpError(404, 'The file is missing on the server.');
  }
  // The device's slot first, so a refusal (429) sends nothing. A HEAD only asks about the file.
  if (req.method !== 'HEAD') {
    const j = core.jellyfin;
    j.sessions.open({ tokenRow: ctx.tokenRow, user: ctx.user, profile: ctx.profile, item: row, clientIp: core.auth.clientIp(req), client: ctx.client });
    res.once('close', () => j.sessions.touch(ctx.tokenRow.id)); // a long read keeps the slot alive to its end
  }
  if (remote) return proxyRemoteFile(core, ctx, row);
  const ok = await sendFile(req, res, row.path, { cacheControl: 'private, no-cache', contentType: mimeFor(row.path) });
  if (!ok) throw new HttpError(404, 'The file is missing on the server.');
}

export function registerMedia(j) {
  j.route('GET', '/Items/{itemId}/Images/{type}', image);
  j.route('GET', '/Items/{itemId}/Images/{type}/{index}', image);
  j.route(['GET', 'POST'], '/Items/{itemId}/PlaybackInfo', playbackInfo);
  j.route('GET', '/Videos/{itemId}/stream', stream);
  j.route('GET', '/Videos/{itemId}/stream.{ext}', stream);
}
