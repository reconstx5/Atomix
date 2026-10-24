// A connected server's file, passed through: its bytes with Range (so seeking works), fetched with that server's
// sign-in. The browser, TV or music app only ever talks to Atomix.
import { Readable } from 'node:stream';
import { HttpError } from '../http/router.js';
import { resolveSource } from '../remote/index.js';
import { fetchFollowing } from '../remote/provider.js';

/** The bytes of a connected server's title, passed through with Range so seeking works; the TV never sees the server. */
export async function proxyRemoteFile(core, ctx, row) {
  const { db } = core;
  const src = await resolveSource({ db, providers: core.remote.providers }, row);
  if (!src.file) throw new HttpError(404, src.server ? `${src.server.name} has no playable file for this title.` : 'The server this title came from is no longer connected.');
  const ac = new AbortController();
  ctx.req.on('close', () => ac.abort());
  // Bytes as they are on the server (no gzip: the Range offsets must mean the file's own bytes).
  const headers = { ...src.headers, 'accept-encoding': 'identity' };
  for (const h of ['range', 'if-range']) if (ctx.req.headers[h]) headers[h] = ctx.req.headers[h];
  let up;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, core.remote.proxyHeaderTimeoutMs ?? 15000);
  try {
    up = await fetchFollowing(src.file, { method: ctx.req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ac.signal, sameOriginOnly: true });
  } catch (err) {
    if (timedOut) throw new HttpError(504, `${src.server.name} didn't answer in time`);
    if (ac.signal.aborted) return;
    if (err.code === 'ECROSSORIGIN') throw new HttpError(502, `${src.server.name} sent this title to another address; Atomix only plays from the server itself.`);
    throw new HttpError(502, `Can't reach ${src.server.name}: ${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (up.status === 416) {
    await up.body?.cancel().catch(() => {});
    ctx.res.writeHead(416, { 'content-range': up.headers.get('content-range') || '', 'Cache-Control': 'private, no-cache' });
    return void ctx.res.end();
  }
  if (up.status === 401) {
    db.run("UPDATE servers SET status = 'unauthorized', status_detail = 'The sign-in was refused while playing' WHERE id = ?", src.server.id);
    throw new HttpError(502, `Can't reach ${src.server.name}: sign in again in Settings.`);
  }
  if (up.status === 403) throw new HttpError(502, `${src.server.name} refused to play this title (403).`);
  if (!up.ok && up.status !== 206) throw new HttpError(502, `Can't reach ${src.server.name}: it answered ${up.status}.`);
  const out = { 'Cache-Control': 'private, no-cache' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers.get(h)) out[h] = up.headers.get(h);
  ctx.res.writeHead(up.status, out);
  if (ctx.req.method === 'HEAD' || !up.body) return void ctx.res.end();
  const body = Readable.fromWeb(up.body);
  body.on('error', () => ctx.res.destroy());
  body.pipe(ctx.res);
  await new Promise((resolve) => { ctx.res.on('close', resolve); ctx.res.on('finish', resolve); });
}
