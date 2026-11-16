// A tiny IPTV source for the browser checks (v0.28): an M3U playlist and an empty XMLTV guide served on :9921, set as
// IPTV Simple's playlist through the admin API, and put back as it was afterwards. Nothing here plays: the stream
// addresses go nowhere, which is fine for checks that never start a stream.
//   node devtools/mock-iptv.mjs serve [--plain]   serves and sets the source until Ctrl+C (then restores it)
// `--plain` leaves out the Widevine-only channel (for compare.mjs runs in headless Chromium, which has no Widevine).
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const PORT = 9921;
const BASE = process.env.BASE || 'http://localhost:8787';
const WV = '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha\n#KODIPROP:inputstream.adaptive.license_key=https://lic.example/wv';
const BOTH = '#KODIPROP:inputstream.adaptive.drm={"com.widevine.alpha":{"license":{"server_url":"https://lic.example/wv"}},"org.w3.clearkey":{"license":{"server_url":"https://lic.example/ck"}}}';

export function playlist({ plain = false } = {}) {
  return [
    `#EXTM3U url-tvg="http://127.0.0.1:${PORT}/guide.xml"`,
    ...(plain ? [] : ['#EXTINF:-1 tvg-id="tvnz2" tvg-chno="2" group-title="Mock",TVNZ 2', WV, 'http://127.0.0.1:9/tvnz2.mpd']),
    '#EXTINF:-1 tvg-id="both" tvg-chno="3" group-title="Mock",Both Ways',
    BOTH,
    'http://127.0.0.1:9/both.mpd',
    '#EXTINF:-1 tvg-id="plain" tvg-chno="4" group-title="Mock",Plain One',
    'http://127.0.0.1:9/plain.m3u8',
    '',
  ].join('\n');
}

/** Serve the playlist and guide; resolves to the server. */
export function serveMock(opts = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/list.m3u')) return res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(playlist(opts));
    if (req.url.startsWith('/guide.xml')) return res.writeHead(200, { 'content-type': 'application/xml' }).end('<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>\n');
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** An admin's request context (Playwright's APIRequestContext, signed in as dallas). */
async function adminRequest() {
  const { request } = createRequire(import.meta.url)('playwright');
  const rq = await request.newContext({ baseURL: BASE });
  const r = await rq.post('/api/auth/login', { data: { username: 'dallas', password: 'atomix-dev-1' } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  return rq;
}

async function waitForChannels(rq, n) {
  for (let i = 0; i < 40; i++) {
    const r = await rq.get('/api/live/channels');
    const list = r.ok() ? await r.json() : [];
    if (list.filter((c) => ['TVNZ 2', 'Both Ways', 'Plain One'].includes(c.name)).length === n) return list;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the mock channels never arrived');
}

const DATA = process.env.ATOMIX_DATA_DIR || '/home/claude/dev/data';
const SOURCE = 'iptv-simple/playlist';
const openDb = async () => new (await import('node:sqlite')).DatabaseSync(`${DATA}/atomix.db`);

/**
 * Point IPTV Simple at the mock playlist. Returns `restore()`, which puts back the plugin's settings (and on/off) as
 * they were and removes the mock channels (a playlist refresh can't empty a source, so straight from the dev
 * database: only this source's rows, and its status row as it was), so the dev data ends as it started.
 */
export async function useMockSource(opts = {}) {
  const server = await serveMock(opts);
  const rq = await adminRequest();
  const plugin = (await (await rq.get('/api/admin/plugins')).json()).find((p) => p.id === 'iptv-simple');
  if (!plugin) throw new Error('IPTV Simple is not installed');
  const before = { enabled: plugin.enabled, config: plugin.config };
  const db = await openDb();
  before.channels = db.prepare('SELECT COUNT(*) AS n FROM live_channels WHERE source = ?').get(SOURCE).n;
  before.status = db.prepare('SELECT * FROM live_sources WHERE id = ?').get(SOURCE) || null;
  db.close();
  if (before.channels) throw new Error(`IPTV Simple already has ${before.channels} channels in ${DATA}: not touching a real source`);
  if (!plugin.enabled) await rq.post('/api/admin/plugins/iptv-simple/enabled', { data: { enabled: true } });
  await rq.put('/api/admin/plugins/iptv-simple/config', { data: { ...plugin.config, playlist: `http://127.0.0.1:${PORT}/list.m3u`, guide: `http://127.0.0.1:${PORT}/guide.xml` } });
  const channels = await waitForChannels(rq, opts.plain ? 2 : 3);
  return {
    channels,
    rq,
    async restore() {
      await rq.put('/api/admin/plugins/iptv-simple/config', { data: before.config });
      if (!before.enabled) await rq.post('/api/admin/plugins/iptv-simple/enabled', { data: { enabled: false } });
      await new Promise((r) => setTimeout(r, 500)); // the refresh the settings change starts (it fails: no playlist)
      const db2 = await openDb();
      db2.exec('PRAGMA foreign_keys = ON');
      db2.prepare('DELETE FROM live_channels WHERE source = ?').run(SOURCE);
      db2.prepare('DELETE FROM live_sources WHERE id = ?').run(SOURCE);
      if (before.status) {
        const cols = Object.keys(before.status);
        db2.prepare(`INSERT INTO live_sources (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => before.status[k]));
      }
      db2.close();
      await rq.dispose();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'serve') {
  const src = await useMockSource({ plain: process.argv.includes('--plain') });
  console.log(`mock IPTV on :${PORT}: ${src.channels.map((c) => `${c.number} ${c.name} ${JSON.stringify(c.drm)}`).join(', ')}`);
  const stop = async () => {
    await src.restore();
    console.log('restored');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
