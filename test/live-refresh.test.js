// The live refresher (src/live/refresh.js) and the registerLiveSource() plugin hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { LiveStore } from '../src/live/store.js';
import { LiveRefresher } from '../src/live/refresh.js';
import { PluginManager } from '../src/plugins.js';

const H = 3600_000;
const T0 = Date.UTC(2026, 9, 10, 6, 0, 0);
const KEY = 'iptv-simple/playlist';
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

function setup(source, { now = () => T0 } = {}) {
  const db = openDatabase(path.join(tempDir(), 'r.db'));
  const store = new LiveStore(db);
  const listeners = [];
  const plugins = {
    listLiveSources: () => [{ key: KEY, name: 'IPTV Simple', pluginId: 'iptv-simple', source }],
    getLiveSource: (k) => (k === KEY ? source : null),
    onLiveSourcesChanged: (fn) => listeners.push(fn),
  };
  const refresher = new LiveRefresher({ store, plugins, log: quiet, now, tickMs: 1e9 });
  return { db, store, refresher, plugins, listeners };
}
const channels = (n) => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, name: `C${i}`, group: ['G'], radio: false, guideId: `c${i}` }));
const programmes = (guideId, fromH, count) => Array.from({ length: count }, (_, i) => ({ guideId, start: T0 + (fromH + i) * H, end: T0 + (fromH + i + 1) * H, title: `P${i}` }));

test('a first refresh stores channels and programmes and records counts', async () => {
  const { store, refresher } = setup({ id: 'playlist', refresh: async () => ({ channels: channels(3), programmes: programmes('c0', 0, 5) }), stream() {} });
  const res = await refresher.refresh(KEY, { reason: 'test' });
  assert.equal(res.ok, true);
  assert.equal(store.channels({ sources: [KEY] }).length, 3);
  const st = store.sourceStatus(KEY);
  assert.deepEqual([st.channels, st.programmes, st.unmatched], [3, 5, 2]);
});

test('a refresh returning no channels keeps the old ones and records "The playlist has no channels"', async () => {
  let n = 3;
  const { store, refresher } = setup({ id: 'playlist', refresh: async () => ({ channels: channels(n), programmes: [] }), stream() {} });
  await refresher.refresh(KEY);
  n = 0;
  const res = await refresher.refresh(KEY);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'The playlist has no channels');
  assert.equal(store.channels({ sources: [KEY] }).length, 3);
  assert.equal(store.sourceStatus(KEY).error, 'The playlist has no channels');
});

test('a thrown refresh keeps the old data, records the error, and retries after 15 minutes, not every tick', async () => {
  let fail = false;
  let calls = 0;
  let now = T0;
  const { store, refresher } = setup(
    {
      id: 'playlist',
      refresh: async () => {
        calls++;
        if (fail) throw new Error('The playlist took too long to answer');
        return { channels: channels(2), programmes: programmes('c0', 0, 48) };
      },
      stream() {},
    },
    { now: () => now },
  );
  await refresher.refresh(KEY);
  fail = true;
  now += 7 * H; // due by the 6-hour default
  assert.equal(refresher.due(KEY, now), true);
  const res = await refresher.refresh(KEY);
  assert.equal(res.ok, false);
  assert.equal(store.channels({ sources: [KEY] }).length, 2);
  assert.equal(store.sourceStatus(KEY).error, 'The playlist took too long to answer');
  assert.equal(refresher.due(KEY, now + 60_000), false, 'not again a minute later');
  assert.equal(refresher.due(KEY, now + 16 * 60_000), true, 'again after 15 minutes');
  assert.equal(calls, 2);
});

test('programmes outside the window are dropped', async () => {
  const { db, refresher } = setup({
    id: 'playlist',
    refresh: async () => ({ channels: channels(1), programmes: [...programmes('c0', -24 * 9, 1), ...programmes('c0', 0, 1), ...programmes('c0', 24 * 9, 1)] }),
    stream() {},
  });
  await refresher.refresh(KEY);
  assert.deepEqual(db.all('SELECT start FROM live_programmes').map((r) => r.start), [T0]);
});

test('due(): 6 hours by default, sooner when the guide runs out within 24 h', async () => {
  let hours = 72;
  const { refresher } = setup({ id: 'playlist', refresh: async () => ({ channels: channels(1), programmes: programmes('c0', 0, hours) }), stream() {} });
  assert.equal(refresher.due(KEY, T0), true, 'never refreshed');
  await refresher.refresh(KEY);
  assert.equal(refresher.due(KEY, T0 + 5 * H), false);
  assert.equal(refresher.due(KEY, T0 + 6 * H + 1), true);
  hours = 10;
  await refresher.refresh(KEY);
  assert.equal(refresher.due(KEY, T0 + H), true, 'guide ends within 24 h');
});

test('refreshHours() from the source changes the interval', async () => {
  const { refresher } = setup({ id: 'playlist', refreshHours: () => 1, refresh: async () => ({ channels: channels(1), programmes: programmes('c0', 0, 72) }), stream() {} });
  await refresher.refresh(KEY);
  assert.equal(refresher.due(KEY, T0 + 0.5 * H), false);
  assert.equal(refresher.due(KEY, T0 + 1.1 * H), true);
});

test('two refresh() calls share one run', async () => {
  let calls = 0;
  const { refresher } = setup({
    id: 'playlist',
    refresh: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { channels: channels(1), programmes: [] };
    },
    stream() {},
  });
  const [a, b] = await Promise.all([refresher.refresh(KEY), refresher.refresh(KEY)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('a channel without a key or name fails the refresh, keeping old data', async () => {
  let bad = false;
  const { store, refresher } = setup({ id: 'playlist', refresh: async () => ({ channels: bad ? [{ name: 'x' }] : channels(2), programmes: [] }), stream() {} });
  await refresher.refresh(KEY);
  bad = true;
  const res = await refresher.refresh(KEY);
  assert.equal(res.ok, false);
  assert.equal(store.channels({ sources: [KEY] }).length, 2);
});

test('a registered source or a config change triggers a refresh', async () => {
  let calls = 0;
  const { refresher, listeners } = setup({
    id: 'playlist',
    refresh: async () => {
      calls++;
      return { channels: channels(1), programmes: [] };
    },
    stream() {},
  });
  refresher.start();
  listeners.forEach((fn) => fn({ type: 'config', key: KEY }));
  await refresher.idle();
  refresher.stop();
  assert.ok(calls >= 1);
});

function managerWithStubCore() {
  const owners = [];
  const core = {
    config: { pluginsDir: tempDir(), pluginDataDir: tempDir() },
    router: { add() {}, removeByOwner() {} },
    hooks: { on() {}, removeByOwner() {} },
    metadata: { register() {}, removeByOwner() {} },
  };
  const m = new PluginManager(core);
  return { m, owners };
}

test('registerLiveSource rejects a source without stream(); unloading the plugin removes its live source', () => {
  const { m } = managerWithStubCore();
  const rec = { manifest: { id: 'demo', name: 'Demo' }, configListeners: [] };
  m.plugins.set('demo', rec);
  const api = m.createApi(rec);
  assert.throws(() => api.registerLiveSource({ id: 'x', refresh() {} }), /A live source needs an id, refresh\(\) and stream\(\)/);
  const events = [];
  m.onLiveSourcesChanged((e) => events.push(e));
  api.registerLiveSource({ id: 'x', name: 'X', refresh() {}, stream() {} });
  assert.deepEqual(m.listLiveSources().map((s) => s.key), ['demo/x']);
  assert.equal(m.getLiveSource('demo/x').name, 'X');
  m.unregister('demo');
  assert.deepEqual(m.listLiveSources(), []);
  assert.deepEqual(events.map((e) => e.type), ['registered', 'removed']);
});

test('a guide that failed (programmes: null) or came back empty keeps the old programmes and retries early', async () => {
  let progs = programmes('c0', 0, 48);
  let warnings;
  let now = T0;
  const { db, store, refresher } = setup({ id: 'playlist', refresh: async () => ({ channels: channels(2), programmes: progs, warnings }), stream() {} }, { now: () => now });
  await refresher.refresh(KEY);
  const before = db.get('SELECT COUNT(*) AS n FROM live_programmes').n;
  assert.equal(before, 48);
  progs = null;
  warnings = ["The guide didn't answer (HTTP 404)"];
  now += 60_000;
  const r = await refresher.refresh(KEY);
  assert.equal(r.ok, true, 'the channels still refreshed');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM live_programmes').n, before, 'the guide is kept');
  assert.equal(store.sourceStatus(KEY).warning, "The guide didn't answer (HTTP 404)");
  assert.equal(refresher.due(KEY, now + 16 * 60_000), true, 'the guide is tried again after 15 minutes, not 6 hours');
  progs = [];
  warnings = undefined;
  await refresher.refresh(KEY);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM live_programmes').n, before, 'an empty guide keeps the old one too');
  assert.match(store.sourceStatus(KEY).warning, /no programmes/);
});

test('a settings change while a refresh is running runs one more refresh with the new settings', async () => {
  let setting = 'old';
  const seen = [];
  const { refresher, listeners } = setup({
    id: 'playlist',
    refresh: async () => {
      const at = setting;
      await new Promise((r) => setTimeout(r, 40));
      seen.push(at);
      return { channels: channels(1), programmes: [] };
    },
    stream() {},
  });
  refresher.start();
  await new Promise((r) => setTimeout(r, 5)); // the start-up refresh is running with "old"
  setting = 'new';
  listeners.forEach((fn) => fn({ type: 'config', key: KEY }));
  listeners.forEach((fn) => fn({ type: 'config', key: KEY })); // two quick edits: still one more run
  await new Promise((r) => setTimeout(r, 200));
  await refresher.idle();
  refresher.stop();
  assert.deepEqual(seen, ['old', 'new']);
});

test('unmatched names are counted apart for TV and radio and survive a restart', async () => {
  const chans = [...channels(3), { key: 'r1', name: 'Radio One', group: ['G'], radio: true, guideId: null }];
  const { db, store, refresher, plugins } = setup({ id: 'playlist', refresh: async () => ({ channels: chans, programmes: programmes('c0', 0, 5) }), stream() {} });
  await refresher.refresh(KEY, { reason: 'test' });
  assert.equal(store.sourceStatus(KEY).unmatched, 2, 'the TV ones');
  const again = new LiveRefresher({ store: new LiveStore(db), plugins, log: quiet, now: () => T0, tickMs: 1e9 });
  assert.deepEqual(again.unmatchedNames(KEY), { tv: ['C1', 'C2'], radio: ['Radio One'] });
});

test('changing a setting that doesn\'t touch channels or the guide doesn\'t refresh; changing the guide does', async () => {
  let calls = 0;
  const { refresher, listeners } = setup({
    id: 'playlist',
    refreshKeys: ['playlist', 'guide'],
    refresh: async () => {
      calls++;
      return { channels: channels(1), programmes: [] };
    },
    stream() {},
  });
  refresher.start();
  await refresher.idle();
  const before = calls;
  listeners.forEach((fn) => fn({ type: 'config', key: KEY, changed: ['maxStreams'] }));
  await refresher.idle();
  assert.equal(calls, before, 'Streams at once changed: no refresh');
  listeners.forEach((fn) => fn({ type: 'config', key: KEY, changed: ['guide'] }));
  await refresher.idle();
  refresher.stop();
  assert.equal(calls, before + 1);
});

test('onRefreshed hears each successful refresh (recording rules run after it)', async () => {
  const source = { name: 'S', refresh: async () => ({ channels: channels(1), programmes: programmes('c0', 0, 2) }) };
  const { refresher } = setup(source);
  const heard = [];
  refresher.onRefreshed((key) => heard.push(key));
  await refresher.refresh(KEY);
  assert.deepEqual(heard, [KEY]);
  source.refresh = async () => {
    throw new Error('down');
  };
  await refresher.refresh(KEY);
  assert.deepEqual(heard, [KEY], 'not after a failed one');
});

test('a source whose refresh fails raises a problem; the next good refresh clears it (v0.23)', async () => {
  const { Hooks } = await import('../src/hooks.js');
  const { Problems } = await import('../src/problems.js');
  let bad = true;
  const { refresher } = setup({ id: 'playlist', refresh: async () => { if (bad) throw new Error('Playlist answered 500'); return { channels: channels(1), programmes: [] }; }, stream() {} });
  const hooks = new Hooks();
  const seen = [];
  hooks.on('server:problem', (p) => seen.push(['problem', p]));
  hooks.on('server:recovered', (p) => seen.push(['recovered', p]));
  refresher.problems = new Problems({ hooks });
  await refresher.refresh(KEY); // never worked yet (a plugin not set up): not a server problem
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 0, 'a source that never refreshed fine raises nothing');
  bad = false;
  await refresher.refresh(KEY);
  bad = true;
  await refresher.refresh(KEY);
  await refresher.refresh(KEY);
  bad = false;
  await refresher.refresh(KEY);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.map(([k, p]) => [k, p.kind]), [['problem', 'live-source'], ['recovered', 'live-source']]);
  assert.match(seen[0][1].text, /^The Live TV source .+ couldn't refresh \(Playlist answered 500\)\.$/);
});
