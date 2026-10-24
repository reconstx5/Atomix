// Server problems (v0.23): "it broke" and "it's fine again" become one server:problem and one server:recovered per
// key; the disk watch reports a folder with under 5 GB free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { Hooks } from '../src/hooks.js';
import { Problems, startDiskWatch } from '../src/problems.js';

const GB = 1024 ** 3;
function spy() {
  const hooks = new Hooks();
  const seen = [];
  hooks.on('server:problem', (p) => seen.push(['problem', p]));
  hooks.on('server:recovered', (p) => seen.push(['recovered', p]));
  return { hooks, seen };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a problem is announced once and its recovery once', async () => {
  const { hooks, seen } = spy();
  const p = new Problems({ hooks });
  assert.equal(p.report('podcast-feed', 7, 'The feed for Dev Talk has failed 3 checks in a row.'), true);
  assert.equal(p.report('podcast-feed', 7, 'The feed for Dev Talk has failed 3 checks in a row.'), false);
  p.report('podcast-feed', 7, 'again');
  assert.equal(p.list().length, 1);
  assert.equal(p.clear('podcast-feed', 7), true);
  assert.equal(p.clear('podcast-feed', 7), false);
  p.report('podcast-feed', 7, 'back');
  await tick();
  assert.deepEqual(seen, [
    ['problem', { kind: 'podcast-feed', key: '7', text: 'The feed for Dev Talk has failed 3 checks in a row.' }],
    ['recovered', { kind: 'podcast-feed', key: '7' }],
    ['problem', { kind: 'podcast-feed', key: '7', text: 'back' }],
  ]);
});

test('the disk watch reports under 5 GB and clears above', async () => {
  const { hooks, seen } = spy();
  const problems = new Problems({ hooks });
  const dir = path.join(tempDir(), 'not', 'made', 'yet');
  let free = 4 * GB;
  const asked = [];
  const stop = startDiskWatch({ problems, dirs: () => [{ key: 'recordings', label: 'recordings', dir }], freeBytes: (d) => (asked.push(d), free), everyMs: 60_000 });
  await tick();
  free = 6 * GB;
  await problems.checkDisks();
  stop();
  await tick();
  assert.ok(!asked.includes(dir) && asked.length >= 1, 'a missing folder is checked at its nearest existing parent');
  assert.deepEqual(seen.map(([k]) => k), ['problem', 'recovered']);
  assert.equal(seen[0][1].kind, 'disk');
  assert.equal(seen[0][1].text, `Only 4 GB free for recordings (${dir}).`);
});
