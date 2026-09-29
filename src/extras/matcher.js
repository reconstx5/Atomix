// Runs fingerprinting and matching in a worker thread (node:worker_threads is built
// in, so still no dependencies). One intro job uses one matcher and closes it when
// done; closing mid-call rejects what's pending, which is how a job is stopped.
import { Worker } from 'node:worker_threads';

export function createMatcher() {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  const failAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const start = () => {
    const w = new Worker(new URL('./fingerprint-worker.js', import.meta.url));
    w.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    });
    w.on('error', (err) => {
      if (worker === w) worker = null;
      failAll(err);
    });
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (pending.size) failAll(new Error(`The fingerprint worker stopped (exit code ${code}).`));
    });
    return w;
  };
  const call = (op, args, transfer = []) =>
    new Promise((resolve, reject) => {
      worker ||= start();
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, args }, transfer);
    });

  return {
    /** Int16 PCM → Uint32Array. The samples' buffer is handed over to the worker (not copied). */
    fingerprint: (samples) => call('fingerprint', [samples], [samples.buffer]),
    /** Same result as findSharedSegment(a, b). */
    compare: (a, b) => call('compare', [a, b]),
    async close() {
      const w = worker;
      worker = null;
      failAll(new Error('Stopped'));
      if (w) await w.terminate();
    },
  };
}
