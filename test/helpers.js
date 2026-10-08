// Shared helpers for the end-to-end tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

export const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export function tempDir(prefix = 'atomix-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A few seconds of test pattern + tone. */
export function makeVideo(file, { vcodec = 'libx264', acodec = 'aac', seconds = 3 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=12:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', vcodec, '-pix_fmt', 'yuv420p', '-c:a', acodec, '-shortest', file]);
}

/** The same made-up 20-second theme tune in every episode that asks for it. */
export const THEME = "aevalsrc='0.3*sin(2*PI*(220+110*mod(floor(t*2),5))*t)+0.2*sin(2*PI*(330+55*mod(floor(t*3),7))*t)+0.1*sin(2*PI*660*t)*gt(mod(t,1),0.5)':s=44100:d=20";

/**
 * A TV episode for intro tests: noise, the shared THEME at `themeAt` seconds (if
 * given), then more noise. `chapters` = [[start, end, title], …]. Video is a 2 fps
 * test pattern so it's quick to make.
 */
export function makeEpisode(file, { seconds = 100, themeAt = null, seed = 1, audioCodec = 'aac', videoCodec = 'libx264', gain = 1, lowpass = 0, chapters = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=2:duration=${seconds}`];
  let chain;
  if (themeAt != null) {
    args.push('-f', 'lavfi', '-i', `anoisesrc=d=${themeAt}:c=pink:r=44100:a=0.3:seed=${seed}`, '-f', 'lavfi', '-i', THEME, '-f', 'lavfi', '-i', `anoisesrc=d=${seconds - themeAt - 20}:c=brown:r=44100:a=0.4:seed=${seed + 1}`);
    chain = '[1:a][2:a][3:a]concat=n=3:v=0:a=1';
  } else {
    args.push('-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:r=44100:a=0.3:seed=${seed}`);
    chain = '[1:a]anull';
  }
  if (gain !== 1) chain += `,volume=${gain}`;
  if (lowpass) chain += `,lowpass=f=${lowpass}`;
  args.push('-filter_complex', `${chain}[a]`);
  const meta = `${file}.chapters.txt`;
  const metaIndex = themeAt != null ? 4 : 2;
  if (chapters) {
    fs.writeFileSync(meta, ';FFMETADATA1\n' + chapters.map(([start, end, title]) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(start * 1000)}\nEND=${Math.round(end * 1000)}\ntitle=${title}\n`).join(''));
    args.push('-i', meta);
  }
  args.push('-map', '0:v', '-map', '[a]');
  if (chapters) args.push('-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex));
  const audio = { aac: ['aac'], mp3: ['libmp3lame'], opus: ['libopus', '-ar', '48000'] }[audioCodec];
  args.push('-c:v', videoCodec, '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', ...audio, '-shortest', file);
  execFileSync('ffmpeg', args);
  if (chapters) fs.rmSync(meta);
}

/** A short tone with ID3/Vorbis tags and optional embedded cover art. */
export function makeAudio(file, { tags = {}, seconds = 2, cover = null, codec } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`];
  if (cover) args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic');
  if (codec) args.push('-c:a', codec);
  for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
  if (file.endsWith('.mp3')) args.push('-id3v2_version', '3');
  args.push(file);
  execFileSync('ffmpeg', args);
}

export function makeImage(file, color = 'red', size = '300x300') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file]);
}

/** Start a throwaway HTTP server with a request handler; returns its base URL. */
export async function fakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Boot Atomix with an isolated data folder. */
export async function startAtomix(env = {}, overrides = {}) {
  const dataDir = path.join(tempDir(), 'data');
  // Each test file runs in its own process, so it's fine to leave these set
  // (plugins enabled later in a test read them too).
  for (const [k, v] of Object.entries({ ATOMIX_DATA_DIR: dataDir, ...env })) process.env[k] = v;
  const { createApp } = await import('../src/app.js');
  const app = await createApp({ port: 0, host: '127.0.0.1', skipStartupScan: true, logLevel: 'error', ...overrides });
  const addr = await app.start();
  return { app, base: `http://127.0.0.1:${addr.port}`, dataDir };
}

/** A tiny API client with its own cookie jar (one per "device"). */
export function client(base) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b, h),
    put: (u, b, h) => call('PUT', u, b, h),
    patch: (u, b, h) => call('PATCH', u, b, h),
    del: (u, b, h) => call('DELETE', u, b, h),
    raw: (u, init = {}) => fetch(base + u, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers || {}) } }),
    get cookie() {
      return cookie;
    },
  };
}

export async function waitForScan(c) {
  for (let i = 0; i < 200; i++) {
    const s = (await c.get('/api/scan/status')).data;
    if (!s.running && !s.queued) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('scan did not finish');
}
