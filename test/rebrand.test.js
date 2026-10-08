// NodeFlix is now Atomix. The rename mustn't break an install from before it: the old
// environment variables, config file, database file, stored server name, sign-ins and
// browser settings all carry on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { tempDir, startAtomix, client } from './helpers.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

test('ATOMIX_ variables are read, and the old NODEFLIX_ names still work', () => {
  const root = tempDir();
  const cfg = loadConfig({
    root,
    env: { ATOMIX_PORT: '9001', NODEFLIX_PORT: '9002', PORT: '9003', NODEFLIX_LOG_LEVEL: 'debug', NODEFLIX_TMDB_BASE: 'http://tmdb.test/3' },
  });
  assert.equal(cfg.port, 9001, 'the new name wins');
  assert.equal(cfg.logLevel, 'debug', 'an old name on its own still works');
  assert.equal(cfg.tmdbBase, 'http://tmdb.test/3');
  assert.equal(cfg.dataDir, path.join(root, 'data'));
  assert.equal(cfg.notices.length, 1);
  assert.match(cfg.notices[0], /NODEFLIX_LOG_LEVEL → ATOMIX_LOG_LEVEL/);
  assert.match(cfg.notices[0], /NODEFLIX_TMDB_BASE → ATOMIX_TMDB_BASE/);
  assert.doesNotMatch(cfg.notices[0], /NODEFLIX_PORT/, 'an old name that was not used is not mentioned');

  assert.deepEqual(loadConfig({ root: tempDir(), env: { PORT: '9003' } }).notices, []);
});

test('an old nodeflix.config.json is read until there is an atomix.config.json', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'nodeflix.config.json'), JSON.stringify({ port: 9100 }));
  let cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.port, 9100);
  assert.match(cfg.notices.join('\n'), /nodeflix\.config\.json.*atomix\.config\.json/);
  fs.writeFileSync(path.join(root, 'atomix.config.json'), JSON.stringify({ port: 9200 }));
  cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.port, 9200);
  assert.deepEqual(cfg.notices, []);
});

/** A nodeflix.db left as if the server had stopped suddenly: its latest changes are still in the -wal file. */
function crashedDatabase(file) {
  const live = new DatabaseSync(file);
  live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v); INSERT INTO t VALUES (42);');
  fs.copyFileSync(file, `${file}.copy`);
  fs.copyFileSync(`${file}-wal`, `${file}-wal.copy`);
  live.close();
  fs.renameSync(`${file}.copy`, file);
  fs.renameSync(`${file}-wal.copy`, `${file}-wal`);
  fs.rmSync(`${file}-shm`, { force: true });
}

test('the database file is renamed to atomix.db, with everything in it', () => {
  const root = tempDir();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  crashedDatabase(path.join(data, 'nodeflix.db'));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.dbFile, path.join(data, 'atomix.db'));
  assert.deepEqual(fs.readdirSync(data).filter((f) => f.startsWith('nodeflix')), [], 'nothing left under the old name');
  const db = new DatabaseSync(cfg.dbFile);
  assert.equal(db.prepare('SELECT v FROM t').get().v, 42, 'the changes that were only in the -wal file are kept');
  db.close();
  assert.match(cfg.notices.join('\n'), /nodeflix\.db.*atomix\.db/);

  // Once there's an atomix.db, a stray nodeflix.db is left alone.
  fs.writeFileSync(path.join(data, 'nodeflix.db'), 'stray');
  assert.equal(loadConfig({ root, env: {} }).dbFile, path.join(data, 'atomix.db'));
  assert.equal(fs.readFileSync(path.join(data, 'nodeflix.db'), 'utf8'), 'stray');
});

test('a database another program has open keeps its old name', () => {
  const root = tempDir();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const old = path.join(data, 'nodeflix.db');
  const live = new DatabaseSync(old);
  live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v); INSERT INTO t VALUES (7);');
  try {
    const cfg = loadConfig({ root, env: {} });
    assert.equal(cfg.dbFile, old);
    assert.ok(!fs.existsSync(path.join(data, 'atomix.db')));
    assert.match(cfg.notices.join('\n'), /Kept the database name nodeflix\.db/);
  } finally {
    live.close();
  }
});

test('a server still called NodeFlix is now called Atomix; a name someone chose stays', () => {
  const dir = tempDir();
  const names = {};
  for (const [file, name] of [['a.db', 'NodeFlix'], ['b.db', 'Hansen Home']]) {
    let db = openDatabase(path.join(dir, file), { upTo: 6 });
    db.run('INSERT INTO settings (key, value) VALUES (?, ?)', 'serverName', JSON.stringify(name));
    db.close();
    db = openDatabase(path.join(dir, file));
    names[name] = JSON.parse(db.get("SELECT value FROM settings WHERE key = 'serverName'").value);
    db.close();
  }
  assert.deepEqual(names, { NodeFlix: 'Atomix', 'Hansen Home': 'Hansen Home' });
});

test('sign-ins from before the rename still work, and signing out clears both cookies', async () => {
  const nf = await startAtomix({}, { backgroundTasks: false });
  try {
    const admin = client(nf.base);
    const status = (await admin.get('/api/status')).data;
    assert.equal(status.name, 'Atomix');
    assert.equal(status.serverName, 'Atomix');
    const r = await admin.post('/api/setup', { username: 'admin', password: 'password123' });
    assert.equal(r.status, 200);
    const [name, token] = admin.cookie.split('=');
    assert.equal(name, 'atomix_session');

    const old = client(nf.base);
    let me = await old.get('/api/me', { cookie: `nf_session=${token}` });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'admin');

    const out = await old.post('/api/auth/logout', {}, { cookie: `nf_session=${token}` });
    const cleared = out.headers.getSetCookie().map((c) => c.split(';')[0]);
    assert.deepEqual(cleared.sort(), ['atomix_session=', 'nf_session=']);
    me = await old.get('/api/me', { cookie: `atomix_session=${token}` });
    assert.equal(me.status, 401, 'the session itself is gone');
  } finally {
    await nf.app.stop();
  }
});

test('volume and music queue saved in the browser under the old names move across', async () => {
  const items = new Map([
    ['nf-volume', '0.4'],
    ['nf-music:3', '{"queue":"old"}'],
    ['nf-music:5', '{"queue":"stale"}'],
    ['atomix-music:5', '{"queue":"new"}'],
    ['something-else', 'x'],
  ]);
  globalThis.localStorage = {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
    removeItem: (k) => items.delete(k),
  };
  const storage = await import('../public/js/storage.js');
  assert.deepEqual(Object.fromEntries(items), {
    'atomix-volume': '0.4',
    'atomix-music:3': '{"queue":"old"}',
    'atomix-music:5': '{"queue":"new"}',
    'something-else': 'x',
  });
  assert.equal(storage.VOLUME_KEY, 'atomix-volume');
  assert.equal(storage.musicKey(3), 'atomix-music:3');
  delete globalThis.localStorage;
});
