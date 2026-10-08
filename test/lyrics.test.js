// Lyrics: a .lrc beside the song, then the tags, then LRCLIB; misses remembered; nothing sent with the switch off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, fakeServer } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Lyrics } from '../src/lyrics.js';

let db, lrclib, lyrics;
let calls = 0;
let answer = null;
const now = Date.now();
const dir = tempDir();
const track = (id, file, extra = {}) => {
  db.run("INSERT INTO items (id, library_id, kind, title, artist, path, size, mtime, duration, media, genres, added_at, updated_at) VALUES (?, 1, 'track', ?, 'Band', ?, 1, 1, 180, ?, '[]', ?, ?)", id, `Song ${id}`, file, JSON.stringify(extra.media || {}), now, now);
  return db.get('SELECT * FROM items WHERE id = ?', id);
};
const SYNC = '[00:01.00]one\n[00:02.00]two\n[00:03.00]three';

before(async () => {
  db = openDatabase(path.join(dir, 'l.db'));
  db.run("INSERT INTO libraries (name, type, paths, options, created_at) VALUES ('Music', 'music', '[]', '{}', ?)", now);
  lrclib = await fakeServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    assert.equal(u.pathname, '/api/get');
    assert.ok(req.headers['user-agent'].startsWith('Atomix/'));
    if (!answer) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  const settings = { get: (k) => ({ onlineLyrics: true })[k] };
  lyrics = new Lyrics({ db, settings, version: '0.10.0', base: `${lrclib.url}/api` });
});
after(() => lrclib?.close());

test('a .lrc beside the song wins and is re-read when it changes', async () => {
  const file = path.join(dir, 'a.mp3');
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(dir, 'a.lrc'), SYNC);
  const t = track(1, file);
  const r = await lyrics.get(t);
  assert.equal(r.source, 'file');
  assert.equal(r.synced, true);
  assert.equal(r.lines.length, 3);
  fs.writeFileSync(path.join(dir, 'a.lrc'), 'just words');
  fs.utimesSync(path.join(dir, 'a.lrc'), new Date(now + 5000), new Date(now + 5000));
  const r2 = await lyrics.get(t);
  assert.equal(r2.synced, false);
  assert.equal(calls, 0, 'never asked LRCLIB');
});

test('tags are used when there is no file; a plain tag is plain', async () => {
  const t = track(2, path.join(dir, 'b.mp3'), { media: { tags: { lyrics: 'row one\nrow two' } } });
  const r = await lyrics.get(t);
  assert.deepEqual([r.source, r.synced, r.lines.map((l) => l.text)], ['tags', false, ['row one', 'row two']]);
});

test('LRCLIB: synced when offered, plain otherwise; 404 is remembered; one request in flight', async () => {
  answer = { syncedLyrics: SYNC, plainLyrics: 'one\ntwo\nthree' };
  const t = track(3, path.join(dir, 'c.mp3'));
  const [a, b] = await Promise.all([lyrics.get(t), lyrics.get(t)]);
  assert.equal(a.source, 'lrclib');
  assert.equal(a.synced, true);
  assert.equal(calls, 1, 'two callers, one request');
  assert.equal(b.lines.length, 3);
  answer = { plainLyrics: 'only words' };
  const p = track(4, path.join(dir, 'd.mp3'));
  assert.equal((await lyrics.get(p)).synced, false);
  answer = null;
  const n = track(5, path.join(dir, 'e.mp3'));
  assert.equal(await lyrics.get(n), null);
  const before = calls;
  assert.equal(await lyrics.get(n), null);
  assert.equal(calls, before, 'a miss is remembered');
  db.run('UPDATE lyrics SET fetched_at = ? WHERE item_id = 5', now - 31 * 24 * 3600 * 1000);
  await lyrics.get(n);
  assert.equal(calls, before + 1, 'retried after 30 days');
});

test('an unreachable LRCLIB is a miss, not an error; the switch off means no request', async () => {
  const off = new Lyrics({ db, settings: { get: () => false }, version: '0.10.0', base: `${lrclib.url}/api` });
  const t = track(6, path.join(dir, 'f.mp3'));
  const before = calls;
  assert.equal(await off.get(t), null);
  assert.equal(calls, before);
  const dead = new Lyrics({ db, settings: { get: () => true }, version: '0.10.0', base: 'http://127.0.0.1:1/api', timeoutMs: 500 });
  assert.equal(await dead.get(track(7, path.join(dir, 'g.mp3'))), null);
  assert.equal(db.get('SELECT source FROM lyrics WHERE item_id = 7').source, 'none');
});
