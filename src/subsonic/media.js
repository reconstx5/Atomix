// Music apps playing: stream (the original, with ranges, whenever it already fits what the app asked for; else MP3
// or Opus at the asked bitrate from timeOffset, in a slot of the ffmpeg pool), download, cover art and lyrics.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { sendFile } from '../http/static.js';
import { isRemotePath } from '../remote/index.js';
import { proxyRemoteFile } from '../stream/remotefile.js';
import { sendArtwork } from '../library/artwork.js';
import { parseJson } from '../db.js';
import { logger } from '../log.js';
import { SubsonicError } from './envelope.js';
import { needId } from './shapes.js';
import { queries } from './browse.js';

const log = logger('subsonic');
const CONTENT = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' };

/** A song the viewer may play, or 70. */
function songFor(ctx) {
  const { kind, id } = needId(ctx.params, 'id', ['tr', 'pe'], 'Song');
  if (kind === 'pe') {
    // A downloaded podcast episode (v0.22) the viewer may hear.
    const ep = ctx.core.library.get(id);
    if (!ep || ep.kind !== 'podcast_episode' || !ep.path || !ctx.core.library.canSee(ctx.viewer, ep)) throw new SubsonicError(70, 'Song not found');
    return ep;
  }
  const row = queries(ctx.core, ctx.viewer).songs({ where: 'i.id = ?', params: [id] })[0];
  if (!row) throw new SubsonicError(70, 'Song not found');
  return row;
}

/** Whether the file itself answers the request: no other format asked, and no bitrate cap below the file's. */
export function sendsOriginal(row, { format, maxBitRate }) {
  const ext = path.extname(row.path || '').slice(1).toLowerCase();
  const media = parseJson(row.media, {});
  let kbps = Math.round((media.bitrate || 0) / 1000);
  // Never probed for its bitrate: worked out from the file's size and length; still unknown under a cap → converted.
  if (!kbps && maxBitRate) {
    const seconds = Number(media.duration || row.duration) || 0;
    try {
      if (seconds > 0) kbps = Math.round((fs.statSync(row.path).size * 8) / seconds / 1000);
    } catch {
      kbps = 0;
    }
    if (!kbps) return format === 'raw';
  }
  const sameFormat = !format || format === 'raw' || format === ext;
  if (format === 'raw') return true;
  return sameFormat && (!maxBitRate || !kbps || kbps <= maxBitRate);
}

/** What a conversion becomes: Opus for the formats an app asking for them plays (Ogg/WebM families), else MP3. */
const OPUS_FORMATS = new Set(['opus', 'ogg', 'oga', 'webm']);
export const convertTo = (format) => (OPUS_FORMATS.has(format) ? 'opus' : 'mp3');

/** ffmpeg's arguments for a conversion. */
export function convertArgs(file, { format, kbps, offset }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (offset > 0) args.push('-ss', String(offset));
  args.push('-i', file, '-vn', '-map', '0:a:0', '-map_metadata', '-1');
  if (format === 'opus') args.push('-c:a', 'libopus', '-b:a', `${kbps}k`, '-f', 'ogg', 'pipe:1');
  else args.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-f', 'mp3', 'pipe:1');
  return args;
}

export function registerMedia(s) {
  s.method('stream', async (ctx) => {
    const row = songFor(ctx);
    const p = ctx.params;
    const format = (p.get('format') || '').toLowerCase() || null;
    const maxBitRate = p.int('maxBitRate', 0, { min: 0, max: 10000 });
    const offset = Math.max(0, Number(p.get('timeOffset') || 0) || 0);
    // No play history here: apps fetch the next song early and cache whole albums. They say what's playing with
    // scrobble (submission=false), and what was heard with scrobble (submission=true).
    const { req, res } = ctx;
    // A connected server's song is passed through as it is (Atomix doesn't convert songs it doesn't hold).
    if (isRemotePath(row.path)) return void (await proxyRemoteFile(ctx.core, ctx, row));
    if (sendsOriginal(row, { format, maxBitRate }) && !offset) {
      const ext = path.extname(row.path).slice(1).toLowerCase();
      const ok = await sendFile(req, res, row.path, { cacheControl: 'private, no-cache', contentType: CONTENT[ext] || 'application/octet-stream' });
      if (!ok) throw new SubsonicError(70, 'The song file is missing on the server.');
      return;
    }
    const to = convertTo(format);
    const kbps = Math.max(32, Math.min(320, maxBitRate || 192));
    let slot;
    try {
      slot = ctx.core.playback.extractionSlot();
    } catch (err) {
      throw new SubsonicError(0, err.message);
    }
    // The app may have gone already (its close was before anyone listened for it): no ffmpeg for nobody.
    if (req.destroyed || res.destroyed || res.writableEnded) return void slot.release();
    const proc = spawn(ctx.core.config.ffmpegPath, convertArgs(row.path, { format: to, kbps, offset }), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.release();
    };
    const errors = [];
    proc.stderr.on('data', (c) => errors.length < 20 && errors.push(c));
    proc.on('error', (err) => log.warn(`ffmpeg didn't start: ${err.message}`));
    proc.on('close', (code, signal) => {
      release();
      if (code && !signal) log.warn(`converting a song for a music app failed (${code}): ${Buffer.concat(errors).toString().trim().slice(-300)}`);
      res.end();
    });
    res.on('close', () => {
      if (proc.exitCode == null) proc.kill('SIGKILL');
      release();
    });
    res.writeHead(200, { 'Content-Type': to === 'opus' ? 'audio/ogg' : 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
    if (req.method === 'HEAD') return void proc.kill('SIGKILL');
    proc.stdout.pipe(res);
  });

  s.method('download', async (ctx) => {
    if (ctx.profile.kids) throw new SubsonicError(50, "Downloads aren't allowed on this profile.");
    const row = songFor(ctx);
    if (isRemotePath(row.path)) return void (await proxyRemoteFile(ctx.core, ctx, row));
    ctx.res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(row.path))}`);
    const ok = await sendFile(ctx.req, ctx.res, row.path, { cacheControl: 'private, no-cache', contentType: 'application/octet-stream' });
    if (!ok) throw new SubsonicError(70, 'The song file is missing on the server.');
  });

  s.method('getCoverArt', async (ctx) => {
    const id = needId(ctx.params, 'id', ['al', 'ar', 'tr', 'pl', 'sp', 'pc'], 'Cover art');
    const { core, viewer } = ctx;
    const q = queries(core, viewer);
    let row = null;
    if (id.kind === 'tr') row = q.songs({ where: 'i.id = ?', params: [id.id] })[0];
    else if (id.kind === 'pc') row = [core.library.get(id.id)].find((r) => r?.kind === 'podcast' && core.library.canSee(viewer, r)) || null;
    else if (id.kind === 'al') row = q.albums({ where: 'al.id = ?', params: [id.id] })[0];
    else if (id.kind === 'ar') row = q.artists({ where: 'ar.id = ?', params: [id.id] })[0];
    else {
      const list = core.lists.get(id.id);
      const first = list && core.lists.visibleTo(list, viewer) ? core.lists.rows(list.id, viewer).find((r) => r.kind === 'track' && core.library.canSee(viewer, r)) : null;
      row = first || null;
    }
    if (!row) throw new SubsonicError(70, 'Cover art not found');
    const item = core.library.get(row.id);
    // v0.24: a size asked for is sent from the smaller copies (the square ladder).
    const ctxLike = { req: ctx.req, res: ctx.res, redirect: () => {}, query: Number(ctx.params.get('size')) > 0 ? { w: Number(ctx.params.get('size')) } : {} };
    try {
      await sendArtwork(core, ctxLike, item, 'poster', { redirect: false });
    } catch {
      throw new SubsonicError(70, 'Cover art not found');
    }
  });

  s.method('getLyricsBySongId', async (ctx) => {
    const row = songFor(ctx);
    const l = await ctx.core.lyrics.get(ctx.core.library.get(row.id)).catch(() => null);
    if (!l?.lines?.length) return { lyricsList: { structuredLyrics: [] } };
    const line = l.lines.map((x) => (l.synced && x.at != null ? { start: Math.round(x.at * 1000), value: x.text } : { value: x.text }));
    return { lyricsList: { structuredLyrics: [{ displayArtist: row.artist || row.album_artist || '', displayTitle: row.title, lang: 'xxx', synced: Boolean(l.synced), offset: 0, line }] } };
  });

  s.method('getLyrics', async (ctx) => {
    const artist = ctx.params.get('artist') || '';
    const title = ctx.params.get('title') || '';
    const q = queries(ctx.core, ctx.viewer);
    const where = [];
    const params = [];
    if (title) where.push('lower(i.title) = lower(?)') && params.push(title);
    if (artist) where.push('(lower(i.artist) = lower(?) OR lower(ar.title) = lower(?))') && params.push(artist, artist);
    const row = where.length ? q.songs({ where: where.join(' AND '), params, limit: 1 })[0] : null;
    const l = row ? await ctx.core.lyrics.get(ctx.core.library.get(row.id)).catch(() => null) : null;
    return { lyrics: { artist: artist || undefined, title: title || undefined, value: l?.lines?.length ? l.lines.map((x) => x.text).join('\n') : undefined } };
  });
}
