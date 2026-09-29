// The music queue is plain logic shared with the browser (public/js/queue.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../public/js/queue.js';

const tracks = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Song ${i + 1}` }));
const ids = (q) => q.items.map((t) => t.id);
// A predictable "random" so shuffles can be checked.
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('plays a list from the chosen track', () => {
  const q = new Queue();
  q.set(tracks(4), 2);
  assert.equal(q.current.id, 3);
  assert.equal(q.next().id, 4);
  assert.equal(q.next(), null, 'stops at the end when repeat is off');
  assert.equal(q.current.id, 4, 'stays on the last track');
});

test('previous restarts the song if it has been playing a while', () => {
  const q = new Queue();
  q.set(tracks(3), 1);
  assert.deepEqual(q.prev(10), { track: q.current, restart: true });
  assert.equal(q.current.id, 2);
  const r = q.prev(1);
  assert.equal(r.restart, false);
  assert.equal(r.track.id, 1);
  assert.deepEqual(q.prev(0), { track: q.current, restart: true }, 'first song: just restart it');
});

test('repeat all wraps around, repeat one replays the same song', () => {
  const q = new Queue();
  q.set(tracks(2), 1);
  q.repeat = 'all';
  assert.equal(q.next().id, 1);
  q.repeat = 'one';
  assert.equal(q.next({ auto: true }).id, 1, 'auto-advance replays the song');
  assert.equal(q.next().id, 2, 'pressing Next still moves on');
  q.repeat = 'all';
  q.jump(0);
  assert.deepEqual(q.prev(0), { track: q.items[1], restart: false }, 'Previous on the first song wraps to the last');
  q.repeat = 'one';
  assert.equal(q.cycleRepeat(), 'off');
  assert.equal(q.cycleRepeat(), 'all');
  assert.equal(q.cycleRepeat(), 'one');
});

test('shuffle keeps the current song first and can be undone', () => {
  const q = new Queue({ random: seq(0.1, 0.9, 0.5, 0.3) });
  q.set(tracks(5), 2);
  q.setShuffle(true);
  assert.equal(q.current.id, 3);
  assert.equal(q.index, 0, 'current song moves to the front');
  assert.deepEqual([...ids(q)].sort(), [1, 2, 3, 4, 5]);
  assert.notDeepEqual(ids(q), [3, 1, 2, 4, 5], 'the rest is mixed up');
  q.next();
  const playing = q.current.id;
  q.setShuffle(false);
  assert.deepEqual(ids(q), [1, 2, 3, 4, 5], 'original order is back');
  assert.equal(q.current.id, playing, 'and the same song is still playing');
});

test('starting with shuffle on picks a random first song', () => {
  const q = new Queue({ random: seq(0.99, 0.2, 0.4, 0.6) });
  q.set(tracks(4), -1, { shuffle: true });
  assert.equal(q.shuffle, true);
  assert.equal(q.items.length, 4);
  assert.equal(q.index, 0);
});

test('play next and add to queue', () => {
  const q = new Queue();
  q.set(tracks(3), 0);
  q.playNext([{ id: 10 }, { id: 11 }]);
  q.add([{ id: 20 }]);
  assert.deepEqual(ids(q), [1, 10, 11, 2, 3, 20]);
  assert.equal(q.current.id, 1);
  const empty = new Queue();
  empty.add([{ id: 5 }]);
  assert.equal(empty.current.id, 5, 'adding to an empty queue makes it current');
});

test('removing and moving songs keeps the right song playing', () => {
  const q = new Queue();
  q.set(tracks(5), 2); // playing 3
  q.remove(0);
  assert.equal(q.current.id, 3);
  assert.equal(q.index, 1);
  q.move(3, 0); // 5 to the front
  assert.deepEqual(ids(q), [5, 2, 3, 4]);
  assert.equal(q.current.id, 3);
  q.move(2, 3); // the playing song itself
  assert.deepEqual(ids(q), [5, 2, 4, 3]);
  assert.equal(q.current.id, 3);
  assert.equal(q.remove(3), true, 'removing the playing song reports it');
  assert.equal(q.current.id, 4, 'it was last, so the song before takes over');
  assert.equal(q.items.length, 3);
  assert.equal(q.remove(0), false, 'removing another song does not');
  q.clear();
  assert.equal(q.current, null);
});

test('jumping to a song in the queue', () => {
  const q = new Queue();
  q.set(tracks(4), 0);
  assert.equal(q.jump(3).id, 4);
  assert.equal(q.jump(9), null);
  assert.equal(q.current.id, 4);
});

test('saves and restores itself (for page reloads)', () => {
  const q = new Queue({ random: seq(0.3, 0.7) });
  q.set(tracks(3), 1);
  q.repeat = 'all';
  q.setShuffle(true);
  const copy = Queue.fromJSON(JSON.parse(JSON.stringify(q)));
  assert.deepEqual(ids(copy), ids(q));
  assert.equal(copy.index, q.index);
  assert.equal(copy.repeat, 'all');
  assert.equal(copy.shuffle, true);
  copy.setShuffle(false);
  assert.deepEqual(ids(copy), [1, 2, 3]);
  assert.equal(Queue.fromJSON(null).items.length, 0);
  assert.equal(Queue.fromJSON({ items: 'junk' }).items.length, 0);
});

test('a long queue is capped', () => {
  const q = new Queue({ max: 10 });
  q.set(tracks(25), 20);
  assert.equal(q.items.length, 10);
  assert.equal(q.current.id, 21, 'keeps the chosen song');
});
