// An endless live provider for the tuner tests: /live/<n>.ts streams a real-time H.264/AAC MPEG-TS from ffmpeg until
// the request closes. /__drop makes the streams open now end after 3 s; /__silent makes the next requests send nothing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { fakeServer } from './helpers.js';

export async function endlessProvider() {
  const requests = [];
  const procs = new Set();
  let silent = false;
  let refuse = false; // /__refuse: every channel answers 403 (a provider that won't serve this account)
  let hls = null; // /__hlsradio: radio becomes live HLS in 4-s segments behind a redirect (as i.mjh.nz/.r/… → iHeart)
  const p = await fakeServer((req, res) => {
    if (req.url === '/__drop') {
      for (const pr of procs) setTimeout(() => pr.kill('SIGKILL'), 3000);
      return res.end('ok');
    }
    if (req.url === '/__hlsradio') {
      if (!hls) {
        const dir = tempDir();
        const pr = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=f=550:sample_rate=44100', '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6', '-hls_flags', 'delete_segments', '-hls_segment_filename', path.join(dir, 's%05d.aac'), path.join(dir, 'live.m3u8')], { stdio: 'ignore' });
        procs.add(pr);
        hls = { dir, pr };
      }
      return res.end('ok');
    }
    if (hls && req.url.startsWith('/radio/')) {
      res.writeHead(302, { location: '/hls/live.m3u8' });
      return res.end();
    }
    if (hls && req.url.startsWith('/hls/')) {
      const f = path.join(hls.dir, path.basename(req.url.split('?')[0]));
      if (!fs.existsSync(f)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/aac' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.url === '/__refuse') {
      refuse = true;
      return res.end('ok');
    }
    if (req.url === '/__silent') {
      silent = true;
      return res.end('ok');
    }
    requests.push(req.url);
    if (refuse) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }
    if (/^\/radio\/.*\.aac$/.test(req.url)) {
      // A radio station: endless ADTS AAC, as many internet radio streams are.
      res.writeHead(200, { 'content-type': 'audio/aac' });
      const pr = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=f=330:sample_rate=44100', '-c:a', 'aac', '-b:a', '64k', '-f', 'adts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      procs.add(pr);
      pr.stdout.pipe(res);
      pr.on('close', () => (procs.delete(pr), res.end()));
      req.on('close', () => pr.kill('SIGKILL'));
      return;
    }
    if (!/^\/live\/.*\.ts$/.test(req.url)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    if (silent) return req.on('close', () => res.end()); // never sends a byte
    const pr = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=12', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=44100', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    procs.add(pr);
    pr.stdout.pipe(res);
    pr.on('close', () => {
      procs.delete(pr);
      res.end();
    });
    req.on('close', () => pr.kill('SIGKILL'));
  });
  return {
    url: p.url,
    requests,
    close: async () => {
      for (const pr of procs) pr.kill('SIGKILL');
      await p.close();
    },
  };
}

/** A tuner pool without ffmpeg: tuners are plain objects holding their holders (the live-stream and scheduler tests). */
export function fakePool({ unbuffered = false, refused = false, slowAcquire = 0 } = {}) {
  const tuners = new Map();
  const byHolder = new Map();
  let made = 0;
  const pool = {
    tuners,
    acquires: 0,
    specs: [],
    async acquire(spec, holder) {
      pool.acquires++;
      pool.specs.push(spec);
      if (slowAcquire) await new Promise((r) => setTimeout(r, slowAcquire));
      if (unbuffered) throw Object.assign(new Error('unbuffered'), { unbuffered: true });
      if (refused) throw Object.assign(new Error('refused'), { code: 'REFUSED' });
      let t = tuners.get(spec.key);
      if (!t) {
        t = { id: `t${++made}`, key: spec.key, label: spec.label, media: spec.media, url: spec.url, headers: spec.headers, holders: new Map(), handlers: {}, localPlaylist: () => `/data/timeshift/t${made}/run-1/index.m3u8`, closed: false, on(ev, fn) { (this.handlers[ev] ||= []).push(fn); }, off(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((x) => x !== fn); }, emit(ev, ...a) { for (const fn of this.handlers[ev] || []) fn(...a); }, listenerCount(ev) { return (this.handlers[ev] || []).length; } };
        tuners.set(spec.key, t);
      }
      t.holders.set(holder.id, holder);
      byHolder.set(holder.id, t);
      return t;
    },
    release(id) {
      const t = byHolder.get(id);
      byHolder.delete(id);
      t?.holders.delete(id);
    },
    rename(oldId, newId) {
      const t = byHolder.get(oldId);
      if (!t) return;
      const h = t.holders.get(oldId);
      t.holders.delete(oldId);
      t.holders.set(newId, { ...h, id: newId });
      byHolder.delete(oldId);
      byHolder.set(newId, t);
    },
    get: (key) => tuners.get(key),
    /** End a tuner as the real one does when its provider keeps dropping: holders forgotten, 'ended' heard. */
    end(key, why) {
      const t = tuners.get(key);
      if (!t) return;
      tuners.delete(key);
      t.closed = true;
      for (const id of t.holders.keys()) byHolder.delete(id);
      t.emit('ended', why);
    },
    endIdle(prefix, except = null) {
      for (const [k, t] of tuners) if (k.startsWith(prefix) && k !== except && !t.holders.size) tuners.delete(k);
    },
    list: () => [...tuners.values()].map((t) => ({ key: t.key, label: t.label, holders: [...t.holders.values()] })),
  };
  return pool;
}

// A DASH manifest naming every DASH key system at once (mp4protection, Widevine's pssh, PlayReady's mspr:pro,
// ClearKey), for the multi-system channels of test/live-multi-drm.test.js.
// A PlayReady Object (and its pssh box) naming the provider's licence server, as a provider's manifest does.
const PR_LICENCE = 'https://lic.example/pr?prsecret=1';
const prObject = (() => {
  const xml = Buffer.from(`<WRMHEADER xmlns="http://schemas.microsoft.com/DRM/2007/03/PlayReadyHeader" version="4.0.0.0"><DATA><KID>AAAA</KID><LA_URL>${PR_LICENCE}</LA_URL><LUI_URL>${PR_LICENCE}/ui</LUI_URL></DATA></WRMHEADER>`, 'utf16le');
  const head = Buffer.alloc(10);
  head.writeUInt32LE(10 + xml.length, 0);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 6);
  head.writeUInt16LE(xml.length, 8);
  return Buffer.concat([head, xml]);
})();
const prPssh = (() => {
  const head = Buffer.alloc(32);
  head.writeUInt32BE(32 + prObject.length, 0);
  head.write('pssh', 4);
  Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex').copy(head, 12);
  head.writeUInt32BE(prObject.length, 28);
  return Buffer.concat([head, prObject]);
})();
export const MULTI_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" xmlns:mspr="urn:microsoft:playready" type="dynamic" profiles="urn:mpeg:dash:profile:isoff-live:2011"
     availabilityStartTime="2026-10-10T00:00:00Z" publishTime="2026-10-10T06:00:00Z" minimumUpdatePeriod="PT2S" maxSegmentDuration="PT2S" minBufferTime="PT4S">
  <Period id="p0" start="PT0S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="a7e61c37-3e21-9033-c210-91fa607bf3b8"/>
      <ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"><cenc:pssh>AAAAQnBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7QAAACISEKfmHDc+IZAzwhCR+mB787hI49yVmwY=</cenc:pssh></ContentProtection>
      <ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95" value="MSPR 2.0"><cenc:pssh>${prPssh.toString('base64')}</cenc:pssh><mspr:pro>${prObject.toString('base64')}</mspr:pro></ContentProtection>
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey1.0"/>
      <SegmentTemplate timescale="1" duration="2" startNumber="100" media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4"/>
      <Representation id="v720" bandwidth="3000000" codecs="avc1.4d401f" width="1280" height="720" frameRate="25"/>
    </AdaptationSet>
  </Period>
</MPD>`;

/**
 * The provider of multi-system channels: /dash/<name>.mpd answers MULTI_MPD (each fetch counted in `manifests`),
 * /lic/pr is a PlayReady licence server that records what it received (`licences`) and answers 'PR-LICENCE'; any
 * other path is answered by `files(path, host)` when it gives a Buffer.
 */
export async function multiDrmProvider({ files = null } = {}) {
  const manifests = {};
  const licences = [];
  const p = await fakeServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const at = req.url.split('?')[0];
      if (/^\/dash\/[\w-]+\.mpd$/.test(at)) {
        manifests[at] = (manifests[at] || 0) + 1;
        res.writeHead(200, { 'content-type': 'application/dash+xml' });
        return res.end(MULTI_MPD);
      }
      if (at === '/lic/pr' || at === '/lic/wv') {
        licences.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(at === '/lic/pr' ? 'PR-LICENCE' : 'WV-LICENCE');
      }
      // files(path, host): segments a test serves (a Buffer), or null
      const file = files?.(at, req.headers.host);
      if (file) {
        // { chunked: bytes }: sent without a length, in 64 KB writes
        if (file.chunked) {
          res.writeHead(200, { 'content-type': 'video/mp4' });
          for (let at = 0; at < file.chunked.length; at += 65536) res.write(file.chunked.subarray(at, at + 65536));
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': file.length });
        return res.end(file);
      }
      res.writeHead(404);
      res.end();
    });
  });
  return { url: p.url, manifests, licences, close: p.close };
}
