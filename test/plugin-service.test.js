// v0.23 Plan B Task 1: the helper the info plugins share (plugins/_lib/service.js), and the core hooks they use —
// a card status, the metadata language, and offerAgain.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeServer, startAtomix, client } from './helpers.js';
import { createService } from '../plugins/_lib/service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const closers = [];
after(async () => {
  for (const c of closers) await c();
});

function fakeApi() {
  const data = {};
  const api = {
    version: '0.23.0',
    logs: [],
    statuses: [],
    offered: [],
    handlers: {},
    storage: { get: (k, f = null) => (k in data ? data[k] : f), set: (k, v) => (data[k] = v), delete: (k) => delete data[k], all: () => ({ ...data }) },
    log: { debug() {}, info: (...a) => api.logs.push(a.join(' ')), warn: (...a) => api.logs.push(a.join(' ')), error: (...a) => api.logs.push(a.join(' ')) },
    fetch: (...a) => fetch(...a),
    setStatus: (t) => api.statuses.push(t),
    metadata: { offerAgain: (ids) => (api.offered.push(ids), ids?.length || 0) },
    on: (event, fn) => (api.handlers[event] = fn),
  };
  return { api, data };
}

async function serve(handler) {
  const s = await fakeServer(handler);
  closers.push(s.close);
  return s;
}

test('requests wait the gap between them', async () => {
  const at = [];
  const s = await serve((req, res) => (at.push(Date.now()), res.writeHead(200, { 'content-type': 'application/json' }), res.end('{"ok":1}')));
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Test', base: () => s.url, gapMs: 300 });
  const out = await Promise.all([svc.json('/a'), svc.json('/b'), svc.json('/c')]);
  assert.deepEqual(out, [{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
  assert.ok(at[1] - at[0] >= 280 && at[2] - at[1] >= 280, String([at[1] - at[0], at[2] - at[1]]));
});

test('the gap counts from the answer, so a slow one never brings the next one closer', async () => {
  const at = [];
  const s = await serve((req, res) => {
    at.push(Date.now());
    setTimeout(() => (res.writeHead(200, { 'content-type': 'application/json' }), res.end('{}')), at.length === 1 ? 400 : 0);
  });
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Test', base: () => s.url, gapMs: 300 });
  await Promise.all([svc.json('/a'), svc.json('/b')]);
  assert.ok(at[1] - at[0] >= 680, String(at[1] - at[0]));
});

test('404 is null, 401 is auth, 429 is limit, 500 and a refused connection are down', async () => {
  const s = await serve((req, res) => {
    const code = Number(req.url.slice(1).split('?')[0]);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Test', base: () => s.url });
  assert.equal(await svc.json('/404'), null);
  await assert.rejects(svc.json('/401'), (e) => e.kind === 'auth' && e.status === 401);
  await assert.rejects(svc.json('/403'), (e) => e.kind === 'auth');
  await assert.rejects(svc.json('/429'), (e) => e.kind === 'limit');
  await assert.rejects(svc.json('/500'), (e) => e.kind === 'down' && e.status === 500);
  const dead = createService(api, { name: 'Test', base: () => 'http://127.0.0.1:9' });
  await assert.rejects(dead.json('/x'), (e) => e.kind === 'down');
});

test("an error never carries the request's address or key", async () => {
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Test', base: () => 'http://127.0.0.1:9', timeoutMs: 2000 });
  let err;
  try {
    await svc.json('/x', { query: { apikey: 'SECRET123' } });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  svc.failed({ id: 1, title: 'A film' }, err);
  for (const text of [err.message, ...api.logs]) {
    assert.ok(!text.includes('SECRET123'), text);
    assert.ok(!text.includes('127.0.0.1'), text);
  }
  assert.equal(api.logs.length, 1);
});

test('found results are kept; a miss is kept 30 days; force asks again', async () => {
  const { api, data } = fakeApi();
  const svc = createService(api, { name: 'Test', base: () => 'http://x' });
  let calls = 0;
  const fn = async () => (calls++, { v: 1 });
  assert.deepEqual(await svc.cached('k', {}, fn), { v: 1 });
  assert.deepEqual(await svc.cached('k', {}, fn), { v: 1 });
  assert.equal(calls, 1);
  await svc.cached('k', { force: true }, fn);
  assert.equal(calls, 2);
  let misses = 0;
  const miss = async () => (misses++, null);
  assert.equal(await svc.cached('m', {}, miss), null);
  assert.equal(await svc.cached('m', {}, miss), null);
  assert.equal(misses, 1);
  data['cache:m'] = { at: Date.now() - 31 * 86400000, value: null };
  await svc.cached('m', {}, miss);
  assert.equal(misses, 2);
  // An error is not kept.
  await assert.rejects(svc.cached('e', {}, async () => {
    throw new Error('boom');
  }));
  assert.equal('cache:e' in data, false);
});

test('a failure is logged once and the title is offered again at the next scan', async () => {
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Fanart.tv', base: () => 'http://x' });
  svc.start();
  const down = Object.assign(new Error('timed out'), { kind: 'down' });
  svc.failed({ id: 1 }, down);
  svc.failed({ id: 2 }, down);
  assert.equal(api.logs.length, 1);
  assert.match(api.logs[0], /^Fanart\.tv can't be reached \(timed out\); titles are tried again at the next scan\.$/);
  await api.handlers['scan:complete']({});
  assert.deepEqual(api.offered, [[1, 2]]);
  await api.handlers['scan:complete']({});
  assert.equal(api.offered.length, 1, 'nothing noted: nothing offered');
  svc.ok();
  svc.failed({ id: 3 }, down);
  assert.equal(api.logs.length, 2, 'a new outage is logged again');
});

test('once a service stops answering, lookups fail fast until the next scan (review fix F3)', async () => {
  let hits = 0;
  const s = await serve(() => {
    hits++; // never answers
  });
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Test', base: () => s.url, timeoutMs: 300 });
  svc.start();
  await assert.rejects(svc.json('/a'), (e) => e.kind === 'down');
  const t = Date.now();
  await assert.rejects(svc.json('/b'), (e) => e.kind === 'down');
  assert.ok(Date.now() - t < 150, `waited ${Date.now() - t} ms`);
  assert.equal(hits, 1, 'the second lookup never reached the service');
  await api.handlers['scan:complete']({});
  await assert.rejects(svc.json('/c'), (e) => e.kind === 'down');
  assert.equal(hits, 2, 'the next scan tries it again');
  s.server.closeAllConnections?.();
});

test("auth failure sets the card's status", () => {
  const { api } = fakeApi();
  const svc = createService(api, { name: 'Fanart.tv', base: () => 'http://x' });
  svc.start();
  svc.failed({ id: 9 }, Object.assign(new Error('401'), { kind: 'auth', status: 401 }));
  assert.deepEqual(api.statuses, ['Fanart.tv refused the key. Check it in the settings below.']);
  api.handlers['scan:complete']({});
  assert.deepEqual(api.offered, []);
});

test('a plugin status shows on its card and offerAgain resets only its kinds', async () => {
  const nf = await startAtomix({ ATOMIX_PLUGINS_DIR: path.join(here, 'fixtures', 'status-plugins') }, { skipLiveRefresh: true });
  closers.push(() => nf.app.stop());
  const admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const plugin = (await admin.get('/api/admin/plugins')).data.find((p) => p.id === 'statusy');
  assert.equal(plugin.status, 'Paste a key to start.');
  const db = nf.app.core.db;
  const lib = Number(db.run("INSERT INTO libraries (name, type, paths, created_at) VALUES ('M', 'movies', '[]', 1)").lastInsertRowid);
  const add = (kind, locked) => Number(db.run('INSERT INTO items (library_id, kind, title, sort_title, metadata_at, metadata_locked, added_at, updated_at) VALUES (?, ?, ?, ?, 5, ?, 1, 1)', lib, kind, kind, kind, locked).lastInsertRowid);
  const film = add('movie', 0);
  const locked = add('movie', 1);
  const album = add('album', 0);
  const r = await admin.post('/api/plugins/statusy/again', {});
  assert.deepEqual(r.data, { count: 1, language: 'en-US' });
  const at = (id) => db.get('SELECT metadata_at FROM items WHERE id = ?', id).metadata_at;
  assert.equal(at(film), null);
  assert.equal(at(locked), 5);
  assert.equal(at(album), 5);
  db.run('UPDATE items SET metadata_at = 5 WHERE id = ?', film);
  assert.deepEqual((await admin.post('/api/plugins/statusy/again', { ids: [album, film] })).data.count, 1);
  assert.equal(at(film), null);
  assert.equal(at(album), 5);
});
