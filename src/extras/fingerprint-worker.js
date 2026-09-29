// Worker thread for the fingerprint maths (see matcher.js): each call is up to a
// second of pure CPU, which would otherwise hold up every request to the server.
import { parentPort } from 'node:worker_threads';
import { fingerprint, findSharedSegment } from './fingerprint.js';

parentPort.on('message', ({ id, op, args }) => {
  try {
    if (op === 'fingerprint') {
      const fp = fingerprint(args[0]);
      parentPort.postMessage({ id, result: fp }, [fp.buffer]);
    } else {
      parentPort.postMessage({ id, result: findSharedSegment(args[0], args[1]) });
    }
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
