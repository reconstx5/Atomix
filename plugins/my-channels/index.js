// Your own channels (v0.28): 24/7 Live TV channels made from your own films and shows. Each channel's schedule
// repeats through the titles it picks (schedule.js), so the guide knows what is on at any time. Atomix makes the
// channel's stream itself: one ffmpeg per watched channel turns the titles into a steady MPEG-TS stream, which Live TV
// then plays like any other channel (only while someone watches; it stops when they do).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseChannels, buildCycle, programmesFor, nowPlaying, concatList } from './schedule.js';

const GUIDE_HOURS = 48;
const PLAYOUT_SECONDS = 6 * 3600; // one ffmpeg run's list; Live TV reconnects when it ends, joining what is on then

export function setup(api) {
  const token = crypto.randomBytes(24).toString('base64url'); // the stream address's key, new each time Atomix starts
  const cycles = new Map(); // channel key → cycle (rows with path and duration)

  function read() {
    const { channels, problems } = parseChannels(api.config.channels);
    const start = Number(api.config.startNumber) || 900;
    const out = [];
    channels.forEach((c, i) => {
      const rows = api.library.titlesFor(c.rule);
      const shows = new Map();
      const showOf = (r) => {
        if (r.kind !== 'episode' || !r.show_id) return null;
        if (!shows.has(r.show_id)) shows.set(r.show_id, api.library.get(r.show_id)?.title || null);
        return shows.get(r.show_id);
      };
      const cycle = buildCycle(
        rows.map((r) => ({ id: r.id, title: r.title, duration: r.duration, path: r.path, overview: r.overview, season: r.season, episode: r.episode, kind: r.kind, show: showOf(r), year: r.year })),
        c.order,
        c.key,
      );
      if (!cycle.length) problems.push(`“${c.name}” has nothing to show: no ${c.rule.type} called “${c.rule.value}” with films or episodes on this computer.`);
      else out.push({ ...c, number: start + i, cycle });
    });
    return { channels: out, problems };
  }

  api.registerLiveSource({
    id: 'channels',
    name: 'Your own channels',
    async refresh() {
      const { channels, problems } = read();
      cycles.clear();
      const now = Date.now();
      const programmes = [];
      for (const c of channels) {
        cycles.set(c.key, c.cycle);
        for (const p of programmesFor(c.cycle, now - 3600 * 1000, now + GUIDE_HOURS * 3600 * 1000)) {
          const it = p.item;
          programmes.push({
            guideId: c.key,
            start: p.start,
            end: p.end,
            title: it.kind === 'episode' && it.show ? it.show : it.title,
            subtitle: it.kind === 'episode' ? it.title : it.year ? String(it.year) : null,
            description: it.overview || null,
            categories: [],
            episode: it.kind === 'episode' && it.season != null ? `S${it.season} E${it.episode}` : null,
            image: null,
          });
        }
      }
      api.setStatus(problems.length ? problems.join(' ') : null);
      return {
        channels: channels.map((c) => ({ key: c.key, number: c.number, name: c.name, group: ['Your own channels'], logo: null, radio: false, guideId: c.key })),
        programmes,
        warnings: problems,
      };
    },
    async stream(key) {
      return { url: `${api.selfUrl()}/api/plugins/my-channels/live/${encodeURIComponent(key)}?key=${token}` };
    },
    settingsSummary: () => {
      const n = parseChannels(api.config.channels).channels.length;
      return `${n} ${n === 1 ? 'channel' : 'channels'}`;
    },
    maxStreams: () => Infinity,
    refreshHours: () => 6,
  });

  const same = (a, b) => {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const loopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));

  // The channel's stream, for Live TV on this machine only (it carries the key; anyone else gets 401).
  api.route(
    'GET',
    '/live/:key',
    (ctx) => {
      if (!same(ctx.query.key, token) || !loopback(ctx.req.socket.remoteAddress)) throw new api.HttpError(401, 'Not allowed');
      let cycle = cycles.get(ctx.params.key);
      if (!cycle) {
        const c = read().channels.find((x) => x.key === ctx.params.key);
        if (!c) throw new api.HttpError(404, 'This channel no longer exists');
        cycle = c.cycle;
        cycles.set(c.key, cycle);
      }
      const now = nowPlaying(cycle, Date.now());
      const entries = [{ path: now.item.path, inpoint: now.offset }];
      let secs = now.item.duration - now.offset;
      for (let i = (now.index + 1) % cycle.length; secs < PLAYOUT_SECONDS && entries.length < 500; i = (i + 1) % cycle.length) {
        entries.push({ path: cycle[i].path });
        secs += cycle[i].duration;
      }
      fs.mkdirSync(api.dataDir, { recursive: true });
      const list = path.join(api.dataDir, `playout-${ctx.params.key}-${crypto.randomBytes(4).toString('hex')}.txt`);
      fs.writeFileSync(list, concatList(entries));
      const h = Number(api.config.quality) || 720;
      const w = Math.round((h * 16) / 9 / 2) * 2;
      const vf = `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p`;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '160k', '-f', 'mpegts', 'pipe:1'];
      const proc = spawn(api.ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      ctx.res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
      proc.stdout.pipe(ctx.res);
      const done = () => {
        if (proc.exitCode == null) proc.kill('SIGKILL');
        fs.rm(list, { force: true }, () => {});
      };
      ctx.res.on('close', done);
      proc.on('close', (code) => {
        if (code && !ctx.res.writableEnded && err) api.log.warn(`Channel stream stopped: ${err.trim().split('\n').pop()}`);
        ctx.res.end();
        fs.rm(list, { force: true }, () => {});
      });
    },
    { auth: 'none' },
  );
}
