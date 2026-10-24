// The tuner (src/live/tuner.js): one provider connection per channel, shared by its holders, writing a 30-minute
// buffer of fMP4 pieces; a run per connection; closed when nobody holds it. Real ffmpeg against an endless provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, hasFfmpeg } from './helpers.js';
import { endlessProvider } from './helpers-live.js';
import { TunerPool, refusedText } from '../src/live/tuner.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const MEDIA = { video: { codec: 'h264' }, audio: [{ codec: 'aac' }] };
let provider;
const pools = [];
const poolOf = (opts = {}) => {
  const p = new TunerPool({ config: { ffmpegPath: 'ffmpeg', timeshiftDir: tempDir() }, log: { warn() {}, info() {}, debug() {} }, ...opts });
  pools.push(p);
  return p;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await wait(200);
  }
};
const chan = (n) => ({ key: `src\u0000c${n}`, url: `${provider.url}/live/${n}.ts`, headers: {}, media: MEDIA, label: `Channel ${n}` });

before(async () => {
  if (hasFfmpeg) provider = await endlessProvider();
});
after(async () => {
  for (const p of pools) p.close();
  await provider?.close();
});

test('two holders share one tuner and one provider connection', { skip }, async () => {
  const pool = poolOf();
  const before = provider.requests.length;
  const a = await pool.acquire(chan(1), { id: 'v1', kind: 'viewer' });
  const b = await pool.acquire(chan(1), { id: 'v2', kind: 'viewer' });
  assert.equal(a, b);
  assert.equal(a.holders.size, 2);
  assert.equal(provider.requests.length - before, 1);
  pool.release('v1');
  pool.release('v2');
});

test('the tuner closes after its last holder leaves, and is reused if someone returns in time', { skip }, async () => {
  const pool = poolOf({ idleMs: 400 });
  const before = provider.requests.length;
  const t = await pool.acquire(chan(2), { id: 'a', kind: 'viewer' });
  pool.release('a');
  await wait(150);
  const again = await pool.acquire(chan(2), { id: 'b', kind: 'viewer' });
  assert.equal(again.id, t.id, 'reused within the idle time');
  assert.equal(provider.requests.length - before, 1);
  pool.release('b');
  await wait(900);
  assert.equal(pool.get(chan(2).key), undefined);
  assert.ok(!fs.existsSync(t.dir), 'its folder is gone');
});

test('pieces appear and the manifest is dynamic with them', { skip }, async () => {
  const pool = poolOf();
  const t = await pool.acquire(chan(3), { id: 'm', kind: 'viewer' });
  const ok = await until(() => t.runs[0]?.pieces.length >= 2);
  assert.ok(ok, 'two pieces written');
  const mpd = t.manifest({ now: Date.now(), piecePath: 'p/', timeUrl: '/t' });
  assert.match(mpd, /type="dynamic"/);
  assert.ok((mpd.match(/<S /g) || []).length >= 2);
  assert.match(t.runs[0].codecs, /^avc1\.[0-9a-f]+,mp4a\.40\.2$/);
  const first = /media="p\/(seg-1-)\$Number%06d\$\.m4s" startNumber="(\d+)"/.exec(mpd);
  assert.ok(t.piecePath(`${first[1]}${String(first[2]).padStart(6, '0')}.m4s`), 'a named piece is on disk');
  assert.ok(t.piecePath('init-1.mp4'));
  assert.equal(t.piecePath('../../etc/passwd'), null);
  assert.equal(t.piecePath('seg-1-000001.m4s.tmp'), null);
  assert.ok(t.localPlaylist().endsWith('index-all.m3u8')); // v0.21: across the runs
  pool.release('m');
});

test('a provider drop starts run 2; the manifest gains a second period; the old pieces stay', { skip }, async () => {
  const pool = poolOf();
  const t = await pool.acquire(chan(4), { id: 'd', kind: 'viewer' });
  await until(() => t.runs[0]?.pieces.length >= 1);
  await fetch(`${provider.url}/__drop`);
  const two = await until(() => t.runs.length >= 2 && t.runs[1].pieces.length >= 1, 30000);
  assert.ok(two, 'run 2 started and wrote');
  const mpd = t.manifest({ now: Date.now(), piecePath: 'p/', timeUrl: '/t' });
  assert.equal((mpd.match(/<Period /g) || []).length, 2);
  assert.ok(fs.readdirSync(path.join(t.dir, 'run-1')).some((f) => f.endsWith('.m4s')), 'run 1 kept its pieces');
  pool.release('d');
});

test('three drops in two minutes end the tuner for every holder', { skip }, async () => {
  const pool = poolOf();
  const t = await pool.acquire(chan(5), { id: 'e', kind: 'viewer' });
  let ended = null;
  t.on('ended', (why) => (ended = why));
  for (let i = 0; i < 4 && !ended; i++) {
    await until(() => t.runs.at(-1)?.pieces.length >= 1, 20000);
    await fetch(`${provider.url}/__drop`);
    await until(() => ended || t.runs.length > i + 1, 20000);
  }
  assert.equal(ended, 'This channel stopped sending video.');
  assert.equal(pool.get(chan(5).key), undefined);
});

test('a codec without an fMP4 tag is unbuffered at once', { skip }, async () => {
  const pool = poolOf();
  await assert.rejects(pool.acquire({ ...chan(6), media: { video: { codec: 'mpeg2video' }, audio: [{ codec: 'mp2' }] } }, { id: 'u', kind: 'viewer' }), (e) => e.unbuffered === true);
  assert.equal(pool.get(chan(6).key), undefined);
});

test('no piece within the limit is unbuffered', { skip }, async () => {
  const silent = await endlessProvider();
  await fetch(`${silent.url}/__silent`);
  const pool = poolOf({ firstPieceMs: 1500 });
  await assert.rejects(pool.acquire({ ...chan(7), url: `${silent.url}/live/7.ts` }, { id: 's', kind: 'viewer' }), (e) => e.unbuffered === true);
  assert.equal(pool.get(chan(7).key), undefined);
  await silent.close();
});

test('a new pool wipes leftover timeshift folders', { skip }, () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'old-tuner', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'old-tuner', 'run-1', 'seg-1-000001.m4s'), 'x');
  const p = new TunerPool({ config: { ffmpegPath: 'ffmpeg', timeshiftDir: dir }, log: { warn() {} } });
  pools.push(p);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('rename moves a hold to a new id; endIdle closes idle tuners of a source at once', { skip }, async () => {
  const pool = poolOf({ idleMs: 60_000 });
  const t = await pool.acquire(chan(8), { id: 'tmp', kind: 'viewer' });
  pool.rename('tmp', 'session-1');
  assert.ok(t.holders.has('session-1') && !t.holders.has('tmp'));
  assert.equal(t.holders.get('session-1').id, 'session-1');
  pool.release('session-1');
  assert.ok(pool.get(chan(8).key), 'still there (idle, waiting)');
  pool.endIdle('src\u0000');
  assert.equal(pool.get(chan(8).key), undefined);
});

test("a tuner that gives up logs ffmpeg's last line with the provider's address redacted", { skip }, async () => {
  const { Tuner } = await import('../src/live/tuner.js');
  const warned = [];
  const pool = poolOf({ log: { warn: (m) => warned.push(m), info() {}, debug() {} } });
  const t = new Tuner(pool, { ...chan(9), url: 'http://provider.example/live/user/s3cretpass/9.ts' });
  t.drops = [Date.now(), Date.now(), Date.now()];
  t.dropped('http://provider.example/live/user/s3cretpass/9.ts: Server returned 403 Forbidden');
  assert.equal(warned.length, 1);
  assert.ok(!warned[0].includes('s3cretpass'), warned[0]);
});

// ---- v0.21 tidy-up ----
test('a refused channel says so at once (not 10 s later as "unbuffered")', { skip }, async () => {
  const no = await endlessProvider();
  await fetch(`${no.url}/__refuse`);
  const pool = poolOf();
  const t0 = Date.now();
  await assert.rejects(pool.acquire({ ...chan(21), url: `${no.url}/live/21.ts` }, { id: 'r', kind: 'viewer' }), (e) => e.code === 'REFUSED' && !e.unbuffered);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  await no.close();
});

test('a restart asks the source for a fresh address', { skip }, async () => {
  const pool = poolOf();
  let asked = 0;
  const spec = { ...chan(22), resolve: async () => ({ url: `${provider.url}/live/22-t${++asked}.ts`, headers: {} }) };
  const t = await pool.acquire(spec, { id: 'f', kind: 'viewer' });
  await until(() => t.runs[0]?.pieces.length >= 1);
  await fetch(`${provider.url}/__drop`);
  const two = await until(() => t.runs.length >= 2 && t.runs[1].pieces.length >= 1, 30000);
  assert.ok(two);
  assert.ok(provider.requests.includes('/live/22-t1.ts'), JSON.stringify(provider.requests.filter((u) => u.includes('22'))));
  pool.release('f');
});

test('a conversion can rewind into an earlier run (a playlist across the kept runs)', { skip }, async () => {
  const pool = poolOf();
  const t = await pool.acquire(chan(23), { id: 'g', kind: 'viewer' });
  await until(() => t.runs[0]?.pieces.length >= 3);
  await fetch(`${provider.url}/__drop`);
  await until(() => t.runs.length >= 2 && t.runs[1].pieces.length >= 2, 30000);
  const all = t.runs.reduce((n, r) => n + r.pieces.length, 0);
  assert.equal(t.piecesBack(3600), all, 'every kept piece, both runs');
  const text = fs.readFileSync(t.localPlaylist(), 'utf8');
  assert.match(text, /#EXT-X-DISCONTINUITY/);
  assert.match(text, /run-1\/seg-1-\d{6}\.m4s/);
  assert.match(text, /run-2\/seg-2-\d{6}\.m4s/);
  assert.match(text, /#EXT-X-MAP:URI="run-1\/init-1\.mp4"/);
  // ffmpeg reads it from the oldest kept piece of run 1.
  const { execFileSync: run } = await import('node:child_process');
  const out = path.join(tempDir(), 'probe.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,crypto', '-live_start_index', String(-all), '-i', t.localPlaylist(), '-t', '2', '-c', 'copy', '-y', out]);
  assert.ok(fs.statSync(out).size > 1000);
  pool.release('g');
});

test('a refusal is the provider\'s 401/403 answer, not a channel numbered 401', () => {
  assert.equal(refusedText('[http @ 0x1] HTTP error 403 Forbidden\nServer returned 403 Forbidden (access denied)'), true);
  assert.equal(refusedText('Server returned 401 Unauthorized (authorization failed)'), true);
  assert.equal(refusedText('Error opening input file http://p.example/live/user/pass/401.ts.\nConnection timed out'), false);
  assert.equal(refusedText('Server returned 404 Not Found'), false);
});

test('a closed pool starts no tuner (Atomix is stopping) (v0.22)', { skip }, async () => {
  const pool = poolOf();
  pool.close();
  await assert.rejects(pool.acquire(chan(31), { id: 'late', kind: 'recording' }), (e) => e.code === 'CLOSING');
  assert.equal(pool.get(chan(31).key), undefined, 'no tuner (no ffmpeg) after close');
});
