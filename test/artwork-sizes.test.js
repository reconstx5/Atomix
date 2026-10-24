// v0.24 Plan A: smaller copies of artwork, made once with ffmpeg and kept (src/library/thumbs.js), and the picture
// routes that send them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeImage, makeAudio, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { tokenAuth } from './helpers-subsonic.js';
import http from 'node:http';
import { LADDERS, snapWidth, Thumbs, sendPicture, referencedPictures } from '../src/library/thumbs.js';
import { imageSize } from '../src/books/image-size.js';
import { run as realRun } from '../src/library/probe.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const dir = tempDir();
const widthOf = (file) => imageSize(fs.readFileSync(file))?.width;
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const thumbs = (o = {}) => new Thumbs({ config: { cacheDir: path.join(dir, `cache-${Math.random()}`), ffmpegPath: 'ffmpeg' }, tools: { ffmpeg: { available: true }, webp: true }, ...o });

test('snapWidth follows the ladders', () => {
  assert.deepEqual(LADDERS.poster, [200, 300, 450, 600]);
  assert.equal(snapWidth('poster', 196), 200);
  assert.equal(snapWidth('poster', 301), 450);
  assert.equal(snapWidth('poster', 5000), 600);
  assert.equal(snapWidth('backdrop', 400), 480);
  assert.equal(snapWidth('logo', 500), 800);
  assert.equal(snapWidth('poster', 'x'), null);
  assert.equal(snapWidth('poster', 0), null);
  assert.equal(snapWidth('poster', undefined), null);
  // A width that is a step on any ladder is kept (a landscape card asks a poster-type still for 480).
  assert.equal(snapWidth('poster', 480), 480);
  assert.equal(snapWidth('backdrop', 600), 600);
});

test('a poster asked at 300 comes back 300 wide, as WebP when accepted and JPEG when not', { skip }, async () => {
  const src = path.join(dir, 'poster.jpg');
  makeImage(src, 'navy', '600x900');
  const t = thumbs();
  const a = await t.picture(src, { type: 'poster', width: 300, webp: true });
  assert.equal(a.contentType, 'image/webp');
  assert.notEqual(a.file, src);
  assert.equal(widthOf(a.file), 300);
  const b = await t.picture(src, { type: 'poster', width: 300, webp: false });
  assert.equal(b.contentType, 'image/jpeg');
  assert.equal(widthOf(b.file), 300);
  const c = await t.picture(src, { type: 'poster', width: null, webp: true });
  assert.equal(c.file, src, 'no width: the original');
});

test('a copy is never bigger than its original', { skip }, async () => {
  const src = path.join(dir, 'small.jpg');
  makeImage(src, 'green', '300x450');
  const r = await thumbs().picture(src, { type: 'poster', width: 600, webp: true });
  assert.equal(r.file, src);
  assert.equal(r.contentType, 'image/jpeg');
});

test('a logo keeps its transparency', { skip }, async () => {
  const src = path.join(dir, 'logo.png');
  ff('-f', 'lavfi', '-i', 'color=c=white@0.0:s=1000x300,format=rgba', '-frames:v', '1', src);
  const t = thumbs();
  const png = await t.picture(src, { type: 'logo', width: 400, webp: false });
  assert.equal(png.contentType, 'image/png');
  const fmt = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', png.file]).toString().trim();
  assert.match(fmt, /a/, `an alpha channel (${fmt})`);
  const webp = await t.picture(src, { type: 'logo', width: 400, webp: true });
  assert.equal(webp.contentType, 'image/webp');
  assert.equal(widthOf(png.file), 400);
});

test('a changed original gets a new copy', { skip }, async () => {
  const src = path.join(dir, 'change.jpg');
  makeImage(src, 'red', '600x900');
  const t = thumbs();
  const first = await t.picture(src, { type: 'poster', width: 300, webp: false });
  await new Promise((r) => setTimeout(r, 1100));
  makeImage(src, 'blue', '600x900');
  const second = await t.picture(src, { type: 'poster', width: 300, webp: false });
  assert.notEqual(second.file, first.file);
  const px = (f) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(px(second.file)[2] > px(second.file)[0], 'the new copy is blue');
});

test("a picture ffmpeg can't read falls back to the original, and isn't tried again for an hour", { skip }, async () => {
  const src = path.join(dir, 'junk.jpg');
  fs.writeFileSync(src, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 0x84, 2, 0x58]), Buffer.alloc(400, 7)])); // claims 600×900
  let calls = 0;
  let clock = 1_000_000;
  const t = thumbs({ run: (...a) => (calls++, realRun(...a)), now: () => clock });
  const a = await t.picture(src, { type: 'poster', width: 300, webp: false });
  assert.equal(a.file, src);
  await t.picture(src, { type: 'poster', width: 300, webp: false });
  assert.equal(calls, 1, 'not tried again within the hour');
  clock += 61 * 60_000;
  await t.picture(src, { type: 'poster', width: 300, webp: false });
  assert.equal(calls, 2, 'tried again after the hour');
});

test('ten requests at once: two resizes at a time, the rest get the original after the wait', { skip }, async () => {
  const srcs = Array.from({ length: 10 }, (_, i) => {
    const f = path.join(dir, `many-${i}.jpg`);
    makeImage(f, 'purple', '600x900');
    return f;
  });
  let active = 0;
  let most = 0;
  const slowRun = async (...a) => {
    active++;
    most = Math.max(most, active);
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await realRun(...a);
    } finally {
      active--;
    }
  };
  const t = thumbs({ run: slowRun, waitMs: 300 });
  const started = Date.now();
  const answers = await Promise.all(srcs.map((f) => t.picture(f, { type: 'poster', width: 300, webp: false })));
  assert.ok(Date.now() - started < 1200, `answered within the wait (${Date.now() - started} ms)`);
  assert.ok(answers.some((a) => srcs.includes(a.file)), 'some got the original');
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(most, 2);
  const again = await Promise.all(srcs.map((f) => t.picture(f, { type: 'poster', width: 300, webp: false })));
  assert.ok(again.every((a) => !srcs.includes(a.file)), 'the copies were all made');
});

test('the same copy asked twice at once is made once', { skip }, async () => {
  const src = path.join(dir, 'twice.jpg');
  makeImage(src, 'olive', '600x900');
  let calls = 0;
  const t = thumbs({ run: (...a) => (calls++, realRun(...a)) });
  const [a, b] = await Promise.all([1, 2].map(() => t.picture(src, { type: 'poster', width: 300, webp: false })));
  assert.equal(a.file, b.file);
  assert.equal(calls, 1);
});

// ---- through the API ----
let nf, admin, kid, ids;
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const film = (name, nfo) => {
    const d = path.join(media, 'Films', name);
    makeVideo(path.join(d, `${name}.mp4`), { seconds: 1 });
    makeImage(path.join(d, 'poster.jpg'), 'teal', '600x900');
    makeImage(path.join(d, 'fanart.jpg'), 'maroon', '1280x720');
    if (nfo) fs.writeFileSync(path.join(d, 'movie.nfo'), nfo);
  };
  film('Calm Film (2020)');
  film('Grim Film (2021)', '<movie><title>Grim Film</title><year>2021</year><mpaa>NZ:R16</mpaa></movie>');
  const album = path.join(media, 'Music', 'Band', 'Record');
  makeAudio(path.join(album, '01 One.mp3'), { tags: { title: 'One', artist: 'Band', album: 'Record', track: '1' } });
  makeImage(path.join(album, 'cover.jpg'), 'gray', '1400x1400');
  nf = await startAtomix({}, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [path.join(media, 'Films')] });
  await waitForScan(admin);
  await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] });
  await waitForScan(admin);
  const db = nf.app.core.db;
  ids = { calm: db.get("SELECT id FROM items WHERE title = 'Calm Film'").id, grim: db.get("SELECT id FROM items WHERE title = 'Grim Film'").id, album: db.get("SELECT id FROM items WHERE kind = 'album'").id };
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal', allowUnrated: true })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});
after(async () => {
  await nf?.app.stop();
});

const fetchImg = async (c, url, accept = 'image/avif,image/webp,*/*') => {
  const res = await c.raw(url, { headers: { accept } });
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), vary: res.headers.get('vary'), buf: Buffer.from(await res.arrayBuffer()) };
};

test('GET /api/items/:id/image/poster?w=300 sends a 300-px copy; without w the original', { skip }, async () => {
  const sized = await fetchImg(admin, `/api/items/${ids.calm}/image/poster?w=300`);
  assert.equal(sized.status, 200);
  assert.equal(sized.type, 'image/webp');
  assert.equal(imageSize(sized.buf).width, 300);
  const jpeg = await fetchImg(admin, `/api/items/${ids.calm}/image/poster?w=300`, 'image/*');
  assert.equal(jpeg.type, 'image/jpeg');
  const full = await fetchImg(admin, `/api/items/${ids.calm}/image/poster`);
  assert.equal(imageSize(full.buf).width, 600);
  const back = await fetchImg(admin, `/api/items/${ids.calm}/image/backdrop?w=900`);
  assert.equal(imageSize(back.buf).width, 960);
});

test('a versioned picture address may be kept for a year — when its picture can\'t change under it (review fix F5)', { skip }, async () => {
  // A downloaded picture (cache:) is named by its source: it never changes under the same address.
  const core = nf.app.core;
  const name = 'review-f5.jpg';
  makeImage(path.join(core.config.imagesDir, name), 'teal', '600x900');
  core.db.run('UPDATE items SET poster = ? WHERE id = ?', `cache:${name}`, ids.calm);
  const r = await fetchImg(admin, `/api/items/${ids.calm}/image/poster?v=5&w=300`);
  assert.match(r.cache, /max-age=31536000/);
  assert.match(r.cache, /immutable/);
  assert.match(r.vary || '', /Accept/);
  const plain = await fetchImg(admin, `/api/items/${ids.calm}/image/poster`);
  assert.doesNotMatch(plain.cache, /immutable/);
  // A poster.jpg in the folder can be replaced without the address changing: kept a week and revalidated, as before.
  const local = await fetchImg(admin, `/api/items/${ids.grim}/image/poster?v=5&w=300`);
  assert.equal(local.status, 200);
  assert.doesNotMatch(local.cache, /immutable/);
  assert.match(local.cache, /max-age=604800/);
});

test("a sized picture follows the viewer's rules", { skip }, async () => {
  assert.equal((await fetchImg(kid, `/api/items/${ids.grim}/image/poster?w=300`)).status, 404);
  assert.equal((await fetchImg(kid, `/api/items/${ids.calm}/image/poster?w=300`)).status, 200);
});

test("the music apps' cover size uses the copies", { skip }, async () => {
  const secret = (await admin.post('/api/me/app-passwords', { name: 'Phone' })).data.secret;
  const qs = new URLSearchParams({ ...tokenAuth('dallas', secret), id: `al-${ids.album}`, size: 150 });
  const res = await fetch(`${nf.base}/rest/getCoverArt.view?${qs}`);
  assert.equal(res.status, 200);
  assert.equal(imageSize(Buffer.from(await res.arrayBuffer())).width, 200);
  // Bigger than the ladder's top: the original (review fix F6).
  const big = new URLSearchParams({ ...tokenAuth('dallas', secret), id: `al-${ids.album}`, size: 1200 });
  const r2 = await fetch(`${nf.base}/rest/getCoverArt.view?${big}`);
  assert.equal(imageSize(Buffer.from(await r2.arrayBuffer())).width, 1400);
});

test('a picture sent before its copy is ready is not kept by the browser (review fix F1)', { skip }, async () => {
  const src = path.join(dir, 'f1.jpg');
  makeImage(src, 'navy', '600x900');
  const slowRun = async (...a) => (await new Promise((r) => setTimeout(r, 1500)), realRun(...a));
  const core = { thumbs: thumbs({ run: slowRun, waitMs: 200 }) };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    sendPicture(core, { req, res, query: Object.fromEntries(u.searchParams) }, src, { type: 'poster', stable: true });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/?v=1&w=300`;
  try {
    const first = await fetch(url, { headers: { accept: 'image/webp' } });
    await first.arrayBuffer();
    assert.equal(first.headers.get('cache-control'), 'private, no-cache', 'the original, sent while the copy is made');
    await new Promise((r) => setTimeout(r, 2500));
    const second = await fetch(url, { headers: { accept: 'image/webp' } });
    assert.equal(imageSize(Buffer.from(await second.arrayBuffer())).width, 300);
    assert.match(second.headers.get('cache-control'), /immutable/, 'the copy may be kept');
  } finally {
    server.close();
  }
});

test('connected servers\' cached pictures count as used (review fix F2)', () => {
  const rows = { items: [{ poster: 'https://plex.example/p.jpg', backdrop: 'file:/m/fanart.jpg', logo: null }], collections: [{ poster: 'cache:c.jpg', backdrop: null }] };
  const db = { all: (sql) => (/FROM items/.test(sql) ? rows.items : rows.collections) };
  const images = {
    resolve: (ref) => (ref.startsWith('cache:') ? { file: `/img/${ref.slice(6)}` } : ref.startsWith('file:') ? { file: ref.slice(5) } : /^https?:/.test(ref) ? { url: ref } : null),
    cachedPicture: (url) => (url === 'https://plex.example/p.jpg' ? 'cache:plex-p.jpg' : null),
  };
  assert.deepEqual([...referencedPictures(db, images)].sort(), ['/img/c.jpg', '/img/plex-p.jpg', '/m/fanart.jpg']);
});

// ---- Task 2: keeping the copies tidy ----
async function three() {
  const t = thumbs();
  const srcs = ['one', 'two', 'three'].map((n) => {
    const f = path.join(tempDir(), `${n}.jpg`);
    makeImage(f, 'navy', '600x900');
    return f;
  });
  const copies = [];
  for (const f of srcs) copies.push((await t.picture(f, { type: 'poster', width: 300, webp: false })).file);
  return { t, srcs, copies };
}

test('the sweep removes copies of pictures that are gone or no longer used', { skip }, async () => {
  const { t, srcs, copies } = await three();
  fs.rmSync(srcs[0]);
  const r = await t.sweep({ referenced: new Set([srcs[0], srcs[2]]), limitBytes: 1e12 });
  assert.equal(r.removed, 2);
  assert.ok(!fs.existsSync(path.dirname(copies[0])), 'its picture is gone');
  assert.ok(!fs.existsSync(path.dirname(copies[1])), 'no title uses it now');
  assert.ok(fs.existsSync(copies[2]), 'still used: kept');
});

test('the sweep removes stale copies of a changed original', { skip }, async () => {
  const { t, srcs, copies } = await three();
  await new Promise((r) => setTimeout(r, 1100));
  makeImage(srcs[1], 'red', '600x900');
  const fresh = (await t.picture(srcs[1], { type: 'poster', width: 300, webp: false })).file;
  await t.sweep({ referenced: new Set(srcs), limitBytes: 1e12 });
  assert.ok(!fs.existsSync(copies[1]), 'the old copy goes');
  assert.ok(fs.existsSync(fresh), 'the current one stays');
});

test('over the limit, the least used copies go first', { skip }, async () => {
  const { t, srcs, copies } = await three();
  const old = new Date(Date.now() - 10 * 86_400_000);
  fs.utimesSync(copies[1], old, old);
  const total = copies.reduce((s, f) => s + fs.statSync(f).size, 0);
  const r = await t.sweep({ referenced: new Set(srcs), limitBytes: total - 1 });
  assert.ok(!fs.existsSync(copies[1]), 'the least recently used goes');
  assert.ok(fs.existsSync(copies[0]) && fs.existsSync(copies[2]));
  assert.ok(r.bytes <= total - 1);
});

test('the picture cache size is a Server setting', { skip }, async () => {
  await admin.put('/api/admin/settings', { thumbCacheMB: 50 });
  assert.equal((await admin.get('/api/admin/settings')).data.thumbCacheMB, 100, 'clamped');
  await admin.put('/api/admin/settings', { thumbCacheMB: 4096 });
  assert.equal((await admin.get('/api/admin/settings')).data.thumbCacheMB, 4096);
});
