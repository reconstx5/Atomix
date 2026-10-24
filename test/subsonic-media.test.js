// Music apps playing: stream (the original with ranges when it fits, else MP3/Opus at the asked bitrate, from
// timeOffset, within the transcode cap), download, cover art and lyrics — and only what the profile may see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeAudio, makeImage, startAtomix, client, waitForScan } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
const scratch = tempDir();
let nf;
let admin;
let auth;
let kidAuth;
const ids = {};
const files = {};

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=codec_name', '-of', 'json', file]).toString());

before(async () => {
  if (!hasFfmpeg) return;
  const dir = path.join(media, 'Music', 'The Band', 'First Record');
  fs.mkdirSync(dir, { recursive: true });
  files.mp3 = path.join(dir, '01 Opening.mp3');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '96k', '-metadata', 'title=Opening', '-metadata', 'artist=The Band', '-metadata', 'album=First Record', '-metadata', 'track=1', files.mp3]);
  files.long = path.join(dir, '02 Long One.flac');
  // Noise, so the FLAC is well over 128 kbps (a sine wave compresses to almost nothing).
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=90:a=0.3', '-ac', '2', '-metadata', 'title=Long One', '-metadata', 'artist=The Band', '-metadata', 'album=First Record', '-metadata', 'track=2', files.long]);
  fs.writeFileSync(path.join(dir, '01 Opening.lrc'), '[00:00.50]First line\n[00:01.25]Second line\n[00:01.75]Third line\n');
  makeImage(path.join(dir, 'cover.jpg'), 'blue');
  makeAudio(path.join(media, 'Grown', 'Other Folk', 'Quiet Songs', '01 Hush.mp3'), { tags: { title: 'Hush', artist: 'Other Folk', album: 'Quiet Songs', track: '1' } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.music = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  ids.grown = (await admin.post('/api/libraries', { name: 'Grown-up music', type: 'music', paths: [path.join(media, 'Grown')] })).data.id;
  await waitForScan(admin);
  const one = (sql, ...p) => nf.app.core.db.get(sql, ...p)?.id;
  ids.opening = one("SELECT id FROM items WHERE kind = 'track' AND title = 'Opening'");
  ids.long = one("SELECT id FROM items WHERE kind = 'track' AND title = 'Long One'");
  ids.hush = one("SELECT id FROM items WHERE kind = 'track' AND title = 'Hush'");
  ids.album = one("SELECT id FROM items WHERE kind = 'album' AND title = 'First Record'");
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data.secret;
  auth = () => tokenAuth('dallas', secret);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', libraries: [ids.music] })).data;
  const kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  const ks = (await kid.post('/api/me/app-passwords', { name: 'Tablet' })).data.secret;
  kidAuth = () => tokenAuth('dallas', ks);
});

after(async () => {
  await nf?.app.stop();
});

const url = (method, params, who = auth) => `${nf.base}/rest/${method}.view?${new URLSearchParams({ ...who(), ...params })}`;
const errCode = async (method, params, who = auth) => (await rest(nf.base, method, { ...who(), ...params })).body?.error?.code;

test('stream sends the original when it already fits', { skip }, async () => {
  const original = fs.readFileSync(files.mp3);
  for (const params of [{}, { maxBitRate: 128 }, { format: 'raw' }, { maxBitRate: 0 }, { format: 'mp3', maxBitRate: 320 }]) {
    const res = await fetch(url('stream', { id: `tr-${ids.opening}`, ...params }));
    assert.equal(res.status, 200, JSON.stringify(params));
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(original), `${JSON.stringify(params)}: the file's own bytes`);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
  }
  const part = await fetch(url('stream', { id: `tr-${ids.opening}` }), { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
});

test('stream converts when asked', { skip }, async () => {
  const mp3 = await fetch(url('stream', { id: `tr-${ids.long}`, format: 'mp3', maxBitRate: 64 }));
  assert.equal(mp3.status, 200);
  assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
  const body = Buffer.from(await mp3.arrayBuffer());
  const f = path.join(scratch, 'out.mp3');
  fs.writeFileSync(f, body);
  const p = probe(f);
  assert.equal(p.streams[0].codec_name, 'mp3');
  assert.ok(Math.abs(Number(p.format.bit_rate) / 1000 - 64) < 8, p.format.bit_rate);
  // Only a bitrate: the FLAC (well over 128 kbps) becomes a 128 kbps MP3.
  const capped = await fetch(url('stream', { id: `tr-${ids.long}`, maxBitRate: 128 }));
  assert.equal(capped.headers.get('content-type'), 'audio/mpeg');
  await capped.arrayBuffer();
  const opus = await fetch(url('stream', { id: `tr-${ids.long}`, format: 'opus', maxBitRate: 96 }));
  assert.equal(opus.headers.get('content-type'), 'audio/ogg');
  assert.equal(Buffer.from(await opus.arrayBuffer()).subarray(0, 4).toString(), 'OggS');
  const off = await fetch(url('stream', { id: `tr-${ids.long}`, format: 'mp3', timeOffset: 80 }));
  const g = path.join(scratch, 'off.mp3');
  fs.writeFileSync(g, Buffer.from(await off.arrayBuffer()));
  const d = Number(probe(g).format.duration);
  assert.ok(d > 8 && d < 12, `from 80 s of 90: about 10 s (${d})`);
});

test('conversions count toward the cap', { skip }, async () => {
  await admin.put('/api/admin/settings', { maxTranscodes: 1 });
  const ac = new AbortController();
  const held = await fetch(url('stream', { id: `tr-${ids.long}`, format: 'mp3', maxBitRate: 64 }), { signal: ac.signal });
  assert.equal(held.status, 200);
  const second = await rest(nf.base, 'stream', { ...auth(), id: `tr-${ids.long}`, format: 'mp3', maxBitRate: 64 });
  assert.equal(second.body.error.code, 0);
  assert.equal(second.body.error.message, 'Busy converting other songs or videos; try again in a moment.');
  ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  const third = await fetch(url('stream', { id: `tr-${ids.long}`, format: 'mp3', maxBitRate: 64, timeOffset: 85 }));
  assert.equal(third.headers.get('content-type'), 'audio/mpeg', 'the slot came back when the client went');
  await third.arrayBuffer();
  await admin.put('/api/admin/settings', { maxTranscodes: 3 });
});

test("stream refuses what the profile can't see", { skip }, async () => {
  assert.equal(await errCode('stream', { id: `tr-${ids.hush}` }, kidAuth), 70);
  assert.equal(await errCode('download', { id: `tr-${ids.opening}` }, kidAuth), 50);
  assert.equal(await errCode('stream', { id: `al-${ids.album}` }), 70);
  assert.equal(await errCode('stream', {}), 10);
  const dl = await fetch(url('download', { id: `tr-${ids.opening}` }));
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(files.mp3)));
});

test('review fixes: streaming alone writes no play and sends no now playing (apps prefetch and cache)', { skip }, async () => {
  const core = nf.app.core;
  core.db.run('DELETE FROM plays');
  const started = [];
  core.plays.onStarted((e) => started.push(e.item.id));
  const res = await fetch(url('stream', { id: `tr-${ids.opening}` }));
  await res.arrayBuffer();
  assert.equal(core.db.get('SELECT COUNT(*) AS n FROM plays').n, 0);
  assert.deepEqual(started, []);
  // The app's own "now playing" call is what starts it — every time, even for a play that's already open.
  await rest(nf.base, 'scrobble', { ...auth(), id: `tr-${ids.opening}`, submission: 'false' });
  await rest(nf.base, 'scrobble', { ...auth(), id: `tr-${ids.opening}`, submission: 'false' });
  assert.deepEqual(started, [ids.opening, ids.opening]);
  const row = core.db.get('SELECT * FROM plays WHERE item_id = ?', ids.opening);
  assert.equal(row.client, 'Phone');
  assert.equal(row.counted, 0);
});

test('review fixes: XML stays well-formed with control characters in tags', { skip }, async () => {
  const { toXml } = await import('../src/subsonic/envelope.js');
  const x = toXml({ status: 'ok', song: { title: 'Bad\u0001Tag\u0000', value: 'a\u000bb' } });
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x), JSON.stringify(x));
  assert.match(x, /title="BadTag"/);
  nf.app.core.db.run("UPDATE items SET title = ? WHERE id = ?", 'Open\u0001ing', ids.opening);
  const r = await rest(nf.base, 'getSong', { ...auth(), id: `tr-${ids.opening}` }, { f: 'xml' });
  assert.match(r.text, /title="Opening"/);
  nf.app.core.db.run("UPDATE items SET title = 'Opening' WHERE id = ?", ids.opening);
});

test('cover art and lyrics', { skip }, async () => {
  for (const id of [`al-${ids.album}`, `tr-${ids.opening}`]) {
    const art = await fetch(url('getCoverArt', { id, size: 300 }));
    assert.equal(art.status, 200, id);
    assert.match(art.headers.get('content-type'), /^image\//);
    assert.ok((await art.arrayBuffer()).byteLength > 100);
  }
  assert.equal(await errCode('getCoverArt', { id: 'al-999999' }), 70);
  const byId = (await rest(nf.base, 'getLyricsBySongId', { ...auth(), id: `tr-${ids.opening}` })).body;
  const sl = byId.lyricsList.structuredLyrics[0];
  assert.equal(sl.synced, true);
  assert.equal(sl.displayTitle, 'Opening');
  assert.deepEqual(sl.line, [{ start: 500, value: 'First line' }, { start: 1250, value: 'Second line' }, { start: 1750, value: 'Third line' }]);
  const none = (await rest(nf.base, 'getLyricsBySongId', { ...auth(), id: `tr-${ids.long}` })).body;
  assert.deepEqual(none.lyricsList.structuredLyrics || [], []);
  const plain = (await rest(nf.base, 'getLyrics', { ...auth(), artist: 'The Band', title: 'Opening' })).body;
  assert.equal(plain.lyrics.title, 'Opening');
  assert.equal(plain.lyrics.value, 'First line\nSecond line\nThird line');
  const x = await rest(nf.base, 'getLyrics', { ...auth(), artist: 'The Band', title: 'Opening' }, { f: 'xml' });
  assert.match(x.text, /<lyrics artist="The Band" title="Opening">First line\nSecond line\nThird line<\/lyrics>/);
  const missing = (await rest(nf.base, 'getLyrics', { ...auth(), artist: 'Nobody', title: 'Nothing' })).body;
  assert.equal(missing.status, 'ok');
  assert.equal(missing.lyrics.value, undefined);
  assert.equal(await errCode('getLyricsBySongId', { id: `tr-${ids.hush}` }, kidAuth), 70);
});

// ---- v0.21 tidy-up ----
test('other formats asked for become Opus (when the app can play it) or MP3', { skip }, async () => {
  for (const [format, type] of [['ogg', 'audio/ogg'], ['oga', 'audio/ogg'], ['opus', 'audio/ogg'], ['webm', 'audio/ogg'], ['aac', 'audio/mpeg'], ['m4a', 'audio/mpeg'], ['wav', 'audio/mpeg'], ['nonsense', 'audio/mpeg']]) {
    const res = await fetch(url('stream', { id: `tr-${ids.long}`, format, timeOffset: 88 }));
    assert.equal(res.headers.get('content-type'), type, format);
    await res.arrayBuffer();
  }
});

test('a song whose bitrate was never probed is converted under a cap', { skip }, async () => {
  const db = nf.app.core.db;
  const row = db.get('SELECT media FROM items WHERE id = ?', ids.long);
  const media = JSON.parse(row.media);
  db.run('UPDATE items SET media = ? WHERE id = ?', JSON.stringify({ ...media, bitrate: null }), ids.long);
  try {
    const res = await fetch(url('stream', { id: `tr-${ids.long}`, maxBitRate: 128, format: 'flac' }));
    assert.equal(res.headers.get('content-type'), 'audio/mpeg', 'not the original');
    await res.arrayBuffer();
  } finally {
    db.run('UPDATE items SET media = ? WHERE id = ?', row.media, ids.long);
  }
});

test('a conversion stops when its app has already gone before ffmpeg starts', { skip }, async () => {
  const { registerMedia } = await import('../src/subsonic/media.js');
  const h = {};
  registerMedia({ method: (n, fn) => (h[n] = fn) });
  const marker = path.join(scratch, 'ffmpeg-ran');
  const fake = path.join(scratch, 'fake-ffmpeg.sh');
  fs.writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nsleep 5\n`, { mode: 0o755 });
  const core = nf.app.core;
  const was = core.config.ffmpegPath;
  const { EventEmitter } = await import('node:events');
  const res = Object.assign(new EventEmitter(), { destroyed: true, writeHead() {}, end() {}, write() {} });
  const req = Object.assign(new EventEmitter(), { method: 'GET', destroyed: true, headers: {} });
  const params = { get: (k) => ({ id: `tr-${ids.long}`, format: 'mp3' })[k] ?? null, int: (k, d) => d, need: (k) => ({ id: `tr-${ids.long}` })[k], has: () => false, all: () => [], bool: (k, d) => d };
  const viewer = { profileId: null, kids: false, maxAge: null, libraryIds: null };
  core.config.ffmpegPath = fake;
  try {
    await h.stream({ core, viewer, params, req, res, profile: { id: 1 } });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!fs.existsSync(marker), 'ffmpeg never started');
    assert.equal(core.playback.extractions || 0, 0, 'the slot was given back');
  } finally {
    core.config.ffmpegPath = was;
  }
});
