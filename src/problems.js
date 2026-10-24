// Server problems (v0.23): parts of Atomix say "this broke" (report) and "it's fine again" (clear); plugins hear
// one `server:problem` per kind and key until it clears, then one `server:recovered`. Repeats say nothing, so a
// folder missing at every scan or a feed failing every check is one problem, not one per scan.
import fs from 'node:fs';
import path from 'node:path';

const DISK_FLOOR = 5 * 1024 ** 3;

export class Problems {
  constructor({ hooks = null, now = Date.now } = {}) {
    this.hooks = hooks;
    this.now = now;
    this.open = new Map(); // "kind\0key" → { kind, key, text, since }
  }

  /** @returns {boolean} true when this is a new problem (and the event was sent) */
  report(kind, key, text) {
    const id = `${kind}\0${key}`;
    if (this.open.has(id)) return false;
    const p = { kind, key: String(key), text: String(text), since: this.now() };
    this.open.set(id, p);
    this.#emit('server:problem', { kind: p.kind, key: p.key, text: p.text });
    return true;
  }

  /** @returns {boolean} true when a raised problem cleared (and the event was sent) */
  clear(kind, key) {
    const id = `${kind}\0${key}`;
    if (!this.open.delete(id)) return false;
    this.#emit('server:recovered', { kind, key: String(key) });
    return true;
  }

  list() {
    return [...this.open.values()];
  }

  #emit(event, payload) {
    // Not awaited: whoever reports a problem (a scan, a feed check) never waits on a plugin sending a message.
    this.hooks?.emit(event, payload)?.catch?.(() => {});
  }
}

const defaultFreeBytes = (dir) => {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/** The folder itself, or its nearest parent that exists (a recordings folder not made yet is on that disk). */
function existing(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return d;
}

/**
 * Check the free space where Atomix keeps things, now and every `everyMs`: under 5 GB is a `disk` problem
 * ("Only 4 GB free for recordings (D:\Recordings)."), more clears it. `problems.checkDisks()` checks at once.
 * @param {{ problems: Problems, dirs: () => { key: string, label: string, dir: string }[], freeBytes?: (dir: string) => number, everyMs?: number }} o
 * @returns {() => void} stop
 */
export function startDiskWatch({ problems, dirs, freeBytes = defaultFreeBytes, everyMs = 3_600_000 }) {
  const check = async () => {
    for (const { key, label, dir } of dirs() || []) {
      if (!dir) continue;
      const at = existing(dir);
      if (!at) continue;
      let free;
      try {
        free = freeBytes(at);
      } catch {
        continue;
      }
      if (free < DISK_FLOOR) problems.report('disk', key, `Only ${Math.floor(free / 1024 ** 3)} GB free for ${label} (${dir}).`);
      else problems.clear('disk', key);
    }
  };
  problems.checkDisks = check;
  check();
  const timer = setInterval(check, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
