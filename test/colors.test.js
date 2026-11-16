// Card motion v2 Task 2: dominant colours of artwork (src/library/colors.js), stored in items.colors and sent on
// cards as tint (poster) and tintWide (backdrop).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeImage, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { dominantColor, colorOfImage, noteColor } from '../src/library/colors.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const dir = tempDir();
const solid = (r, g, b, n = 64) => Buffer.from(Array.from({ length: n }, () => [r, g, b]).flat());
const near = (hex, [r, g, b], tol = 8) => [1, 3, 5].every((i, k) => Math.abs(parseInt(hex.slice(i, i + 2), 16) - [r, g, b][k]) <= tol);

test('dominantColor of solid red is red; of a grey stays grey', () => {
  assert.ok(near(dominantColor(solid(255, 0, 0)), [255, 0, 0]));
  assert.ok(near(dominantColor(solid(120, 120, 120)), [120, 120, 120], 1));
  assert.match(dominantColor(solid(10, 20, 30)), /^#[0-9a-f]{6}$/);
});

test('dominantColor boosts a muted colour a little, never past the hue', () => {
  const out = dominantColor(solid(150, 110, 110));
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(out.slice(i, i + 2), 16));
  assert.ok(r - g > 40, `more saturated than the input (${out})`);
  assert.ok(r >= g && g >= b - 1);
  assert.equal(dominantColor(Buffer.alloc(0)), null);
});

test('colorOfImage reads a generated red poster as red', { skip }, async () => {
  const f = path.join(dir, 'red.jpg');
  makeImage(f, 'red', '200x300');
  assert.ok(near(await colorOfImage('ffmpeg', f), [255, 0, 0], 40));
  assert.equal(await colorOfImage('ffmpeg', path.join(dir, 'missing.jpg')), null);
});

let nf, admin, ids;
before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const d = path.join(media, 'Films', 'Red Film (2020)');
  makeVideo(path.join(d, 'Red Film (2020).mp4'), { seconds: 1 });
  makeImage(path.join(d, 'poster.jpg'), 'red', '600x900');
  makeImage(path.join(d, 'fanart.jpg'), 'blue', '1280x720');
  const bare = path.join(media, 'Films', 'Bare Film (2021)');
  makeVideo(path.join(bare, 'Bare Film (2021).mp4'), { seconds: 1 });
  nf = await startAtomix({}, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const lib = (await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [path.join(media, 'Films')] })).data;
  await waitForScan(admin);
  const db = nf.app.core.db;
  ids = { lib: lib.id, red: db.get("SELECT id FROM items WHERE title = 'Red Film'").id, bare: db.get("SELECT id FROM items WHERE title = 'Bare Film'").id };
});
after(async () => {
  await nf?.app.stop();
});

const colorsOf = (id) => JSON.parse(nf.app.core.db.get('SELECT colors FROM items WHERE id = ?', id).colors || 'null');
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};

test('migration 33 adds items.colors', { skip }, () => {
  assert.ok(nf.app.core.db.all('PRAGMA table_info(items)').some((c) => c.name === 'colors'));
});

test('a card has tint null until its artwork was asked for; the request is never held up for it', { skip }, async () => {
  const before = (await admin.get(`/api/libraries/${ids.lib}/items`)).data;
  const list = before.items || before;
  const card = list.find((c) => c.id === ids.red);
  assert.equal(card.tint, null);
  assert.equal(card.tintWide, null);
  const res = await admin.raw(`/api/items/${ids.red}/image/poster?w=300`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  await admin.raw(`/api/items/${ids.red}/image/backdrop?w=480`).then((r) => r.arrayBuffer());
  const c = await until(() => colorsOf(ids.red)?.poster && colorsOf(ids.red)?.backdrop && colorsOf(ids.red));
  assert.ok(near(c.poster, [255, 0, 0], 40), c.poster);
  assert.ok(near(c.backdrop, [0, 0, 255], 40), c.backdrop);
});

test('/api/libraries/:id/items and /api/home cards carry tint (poster) and tintWide (backdrop)', { skip }, async () => {
  const a = (await admin.get(`/api/libraries/${ids.lib}/items`)).data;
  const card = (a.items || a).find((c) => c.id === ids.red);
  assert.ok(near(card.tint, [255, 0, 0], 40));
  assert.ok(near(card.tintWide, [0, 0, 255], 40));
  const home = (await admin.get('/api/home')).data;
  const cards = (home.rows || []).flatMap((r) => r.items || []).filter((c) => c.id === ids.red);
  assert.ok(cards.length, 'the film is on Home');
  assert.ok(cards.every((c) => near(c.tint, [255, 0, 0], 40)));
});

test('an item without artwork has tint null, and asking for its image does not invent one', { skip }, async () => {
  const res = await admin.raw(`/api/items/${ids.bare}/image/poster?w=300`);
  assert.equal(res.status, 404);
  await res.arrayBuffer();
  const a = (await admin.get(`/api/libraries/${ids.lib}/items`)).data;
  const card = (a.items || a).find((c) => c.id === ids.bare);
  assert.equal(card.tint, null);
  assert.equal(card.tintWide, null);
  assert.equal(colorsOf(ids.bare), null);
});

test('uploading new artwork through the edit route forgets the colours and the card tint goes null', { skip }, async () => {
  assert.ok(colorsOf(ids.red)?.poster, 'colours are stored first');
  const green = path.join(dir, 'green.png');
  makeImage(green, 'green', '300x450');
  const up = await admin.raw(`/api/items/${ids.red}/artwork/poster`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: fs.readFileSync(green) });
  assert.equal(up.status, 200);
  await up.arrayBuffer();
  assert.equal(colorsOf(ids.red), null);
  const a = (await admin.get(`/api/libraries/${ids.lib}/items`)).data;
  const card = (a.items || a).find((c) => c.id === ids.red);
  assert.equal(card.tint, null);
  assert.equal(card.tintWide, null);
});

test('metadata refresh SQL path: the update that rewrites artwork also clears colours', { skip }, () => {
  const src = fs.readFileSync(new URL('../src/library/metadata.js', import.meta.url), 'utf8');
  assert.match(src, /logo = \?, colors = NULL/);
});

test('noteColor runs at most two readers at once, never makes the caller wait, and remembers undecodable files', async () => {
  const stored = new Map();
  let active = 0;
  let most = 0;
  let calls = 0;
  const core = {
    thumbs: { tools: { ffmpeg: { available: true } } },
    config: { ffmpegPath: 'ffmpeg' },
    db: {
      get: (_sql, id) => ({ colors: stored.get(id) || null, poster: `ref-${id}`, backdrop: null }),
      run: (_sql, json, id) => stored.set(id, json),
    },
    colorOf: async (_bin, file) => {
      calls++;
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return file.includes('bad') ? null : '#112233';
    },
  };
  const t0 = Date.now();
  for (let id = 1; id <= 12; id++) noteColor(core, { id, kind: 'movie', poster: `ref-${id}`, colors: null }, 'poster', `/img/${id}.jpg`);
  assert.ok(Date.now() - t0 < 20, 'noteColor returns at once');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(most, 2);
  assert.equal(stored.size, 12);
  noteColor(core, { id: 99, kind: 'movie', poster: 'x', colors: null }, 'poster', '/img/bad.jpg');
  await new Promise((r) => setTimeout(r, 100));
  const before = calls;
  noteColor(core, { id: 100, kind: 'movie', poster: 'x', colors: null }, 'poster', '/img/bad.jpg');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, before, 'an undecodable file is not retried');
});

test('a colour is not written when the artwork changed while it was being read', async () => {
  const stored = new Map();
  const core = {
    thumbs: { tools: { ffmpeg: { available: true } } },
    config: { ffmpegPath: 'ffmpeg' },
    db: { get: () => ({ colors: null, poster: 'new-ref', backdrop: null }), run: (_s, json, id) => stored.set(id, json) },
    colorOf: async () => '#445566',
  };
  noteColor(core, { id: 7, kind: 'movie', poster: 'old-ref', colors: null }, 'poster', '/img/stale.jpg');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stored.size, 0);
});

// Final review: only films, shows, episodes and seasons carry a tint, so only their artwork gets a colour job.
test('an album, a track or an artist gets no colour job; films, shows, episodes and seasons do', async () => {
  const asked = [];
  const core = {
    thumbs: { tools: { ffmpeg: { available: true } } },
    config: { ffmpegPath: 'ffmpeg' },
    db: { get: (_s, id) => ({ colors: null, poster: `ref-${id}`, backdrop: null }), run: () => {} },
    colorOf: async (_bin, file) => (asked.push(file), '#123456'),
  };
  let id = 500;
  for (const kind of ['album', 'track', 'artist', 'podcast', 'person', 'extra']) noteColor(core, { id: ++id, kind, poster: `ref-${id}`, colors: null }, 'poster', `/img/${kind}.jpg`);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(asked, []);
  for (const kind of ['movie', 'show', 'episode', 'season']) noteColor(core, { id: ++id, kind, poster: `ref-${id}`, colors: null }, 'poster', `/img/${kind}.jpg`);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(asked.sort(), ['/img/episode.jpg', '/img/movie.jpg', '/img/season.jpg', '/img/show.jpg']);
});

test('the colour reader runs ffmpeg at low priority, like the background jobs', { skip: process.platform === 'win32' && 'nice values are Unix' }, async () => {
  let opts = null;
  const core = {
    thumbs: { tools: { ffmpeg: { available: true } } },
    config: { ffmpegPath: 'ffmpeg' },
    db: { get: () => ({ colors: null, poster: 'p', backdrop: null }), run: () => {} },
    colorOf: async (_bin, _file, o) => ((opts = o), null),
  };
  noteColor(core, { id: 900, kind: 'movie', poster: 'p', colors: null }, 'poster', '/img/nice.jpg');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(typeof opts?.onSpawn, 'function', 'the reader is given an onSpawn');
  const child = spawn('sleep', ['2']);
  try {
    opts.onSpawn(child);
    assert.equal(os.getPriority(child.pid), 10);
  } finally {
    child.kill();
  }
  // colorOfImage hands the ffmpeg child to onSpawn.
  let got = null;
  await colorOfImage(process.execPath, '/nope.jpg', { onSpawn: (p) => (got = p) });
  assert.ok(got && got.pid > 0);
});
