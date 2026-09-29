// The music "up next" list: order, shuffle and repeat. Plain logic with no
// DOM, so it runs in the browser and in the Node tests alike.

const REPEAT = ['off', 'all', 'one'];

export class Queue {
  /**
   * @param {{ random?: () => number, max?: number }} [opts]
   */
  constructor({ random = Math.random, max = 1000 } = {}) {
    this.random = random;
    this.max = max;
    this.items = []; // play order
    this.index = -1;
    this.repeat = 'off';
    this.shuffle = false;
    this.original = null; // the order before shuffling (same objects)
  }

  get current() {
    return this.items[this.index] || null;
  }

  get length() {
    return this.items.length;
  }

  /** Replace the queue. `start` is the index to begin at (-1 = pick one when shuffling). */
  set(tracks, start = 0, { shuffle = this.shuffle } = {}) {
    let list = copy(tracks);
    let index = start >= 0 && start < list.length ? start : 0;
    if (shuffle && start < 0 && list.length) index = Math.floor(this.random() * list.length);
    if (list.length > this.max) {
      const from = Math.max(0, Math.min(index, list.length - this.max));
      list = list.slice(from, from + this.max);
      index -= from;
    }
    this.items = list;
    this.index = list.length ? index : -1;
    this.shuffle = false;
    this.original = null;
    if (shuffle) this.setShuffle(true);
    return this.current;
  }

  /** Move on. `auto` means the song finished by itself (repeat-one replays it). */
  next({ auto = false } = {}) {
    if (!this.items.length) return null;
    if (auto && this.repeat === 'one') return this.current;
    if (this.index < this.items.length - 1) {
      this.index++;
      return this.current;
    }
    if (this.repeat !== 'off') {
      this.index = 0;
      return this.current;
    }
    return null;
  }

  /** Go back — or restart the song if it has played for more than 3 seconds. */
  prev(position = 0) {
    if (!this.items.length) return { track: null, restart: false };
    if (position > 3 || this.index === 0) {
      if (this.index === 0 && position <= 3 && this.repeat === 'all' && this.items.length > 1) {
        this.index = this.items.length - 1;
        return { track: this.current, restart: false };
      }
      return { track: this.current, restart: true };
    }
    this.index--;
    return { track: this.current, restart: false };
  }

  jump(i) {
    if (i < 0 || i >= this.items.length) return null;
    this.index = i;
    return this.current;
  }

  cycleRepeat() {
    this.repeat = REPEAT[(REPEAT.indexOf(this.repeat) + 1) % REPEAT.length];
    return this.repeat;
  }

  setShuffle(on) {
    on = Boolean(on);
    if (on === this.shuffle) return;
    const cur = this.current;
    if (on) {
      this.original = [...this.items];
      const rest = this.items.filter((t) => t !== cur);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.items = cur ? [cur, ...rest] : rest;
      this.index = cur ? 0 : -1;
    } else {
      this.items = this.original || this.items;
      this.index = cur ? this.items.indexOf(cur) : -1;
      this.original = null;
    }
    this.shuffle = on;
  }

  /** Put songs straight after the one playing. */
  playNext(tracks) {
    const list = copy(tracks);
    if (!list.length) return;
    if (!this.items.length) return this.add(list);
    const cur = this.current;
    this.items.splice(this.index + 1, 0, ...list);
    if (this.original) this.original.splice(this.original.indexOf(cur) + 1, 0, ...list);
    this.trim();
  }

  /** Add songs to the end. */
  add(tracks) {
    const list = copy(tracks);
    if (!list.length) return;
    this.items.push(...list);
    if (this.original) this.original.push(...list);
    if (this.index < 0) this.index = 0;
    this.trim();
  }

  /** @returns {boolean} true when the removed song was the one playing */
  remove(i) {
    if (i < 0 || i >= this.items.length) return false;
    const [gone] = this.items.splice(i, 1);
    if (this.original) this.original.splice(this.original.indexOf(gone), 1);
    const wasCurrent = i === this.index;
    if (i < this.index) this.index--;
    if (this.index >= this.items.length) this.index = this.items.length - 1;
    if (!this.items.length) this.index = -1;
    return wasCurrent;
  }

  move(from, to) {
    if (from < 0 || from >= this.items.length || to < 0 || to >= this.items.length || from === to) return;
    const cur = this.current;
    const [t] = this.items.splice(from, 1);
    this.items.splice(to, 0, t);
    this.index = this.items.indexOf(cur);
  }

  clear() {
    this.items = [];
    this.original = null;
    this.index = -1;
  }

  // Drop the oldest played songs once the queue grows past `max`.
  trim() {
    while (this.items.length > this.max) {
      const drop = this.index > 0 ? 0 : this.items.length - 1;
      this.remove(drop);
    }
  }

  toJSON() {
    return {
      items: this.items,
      index: this.index,
      repeat: this.repeat,
      shuffle: this.shuffle,
      original: this.original ? this.original.map((t) => this.items.indexOf(t)) : null,
    };
  }

  static fromJSON(data, opts) {
    const q = new Queue(opts);
    if (!data || !Array.isArray(data.items)) return q;
    q.items = data.items.filter((t) => t && typeof t === 'object' && t.id != null).slice(0, q.max);
    q.index = q.items.length ? Math.min(Math.max(0, Number(data.index) || 0), q.items.length - 1) : -1;
    q.repeat = REPEAT.includes(data.repeat) ? data.repeat : 'off';
    const order = data.original;
    const valid = Array.isArray(order) && order.length === q.items.length && new Set(order).size === order.length && order.every((n) => Number.isInteger(n) && n >= 0 && n < q.items.length);
    if (data.shuffle && valid) {
      q.shuffle = true;
      q.original = order.map((n) => q.items[n]);
    }
    return q;
  }
}

// Each queue entry is its own object, so the same song can be queued twice.
const copy = (tracks) => (Array.isArray(tracks) ? tracks : [tracks]).filter(Boolean).map((t) => ({ ...t }));
