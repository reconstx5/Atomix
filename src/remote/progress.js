// Tells the server a title came from what is happening to it: started, where it is (at most every 10 s per
// title), watched, and stopped. One queue per server keeps them in order; the listeners return at once, so a slow
// or hung server never holds up the player's own requests.
import { logger } from '../log.js';
import { resolveSource, isRemotePath } from './index.js';

const log = logger('remote');

export function attachReporter(core, { everyMs = 10000 } = {}) {
  const last = new Map(); // session (else item) → when its position was last pushed
  const warned = new Map(); // server id → when a failure was last logged
  const chains = new Map(); // server id → the promise of its last report
  const started = new Set(); // session ids a start was reported for (so exactly one stop follows)
  const reporter = { everyMs };

  const waiting = new Map(); // "server:slot" → the progress report still in the queue (a newer one replaces its details)
  // One viewer's reports are theirs: keyed by the playback session, else by the title (callers without a session).
  const slotKey = (item, sessionId) => (sessionId ? `s:${sessionId}` : `item${item.id}`);

  const enqueue = (item, what, run, { coalesce = false, watched = false, sessionId = null } = {}) => {
    if (!item || !isRemotePath(item.path)) return;
    const key = core.db.get('SELECT server_id FROM libraries WHERE id = ?', item.library_id)?.server_id ?? `lib${item.library_id}`;
    // Only the latest position matters: a progress report that hasn't gone yet is updated instead of queueing another.
    // A pending "watched" is never replaced by a plain position (a rewind after the credits still counts as watched).
    const slot = `${key}:${slotKey(item, sessionId)}`;
    if (coalesce && waiting.has(slot)) {
      const pending = waiting.get(slot);
      if (!pending.watched || watched) Object.assign(pending, { run, watched });
      return;
    }
    const job = { run, watched };
    if (coalesce) waiting.set(slot, job);
    const prev = chains.get(key) || Promise.resolve();
    const next = prev
      .then(async () => {
        if (waiting.get(slot) === job) waiting.delete(slot);
        run = job.run;
        const src = await resolveSource({ db: core.db, providers: core.remote.providers }, item).catch(() => null);
        if (!src?.remote || !src.provider) return;
        try {
          await run(src.provider, src.server, { remoteId: item.remote_id, kind: item.kind });
        } catch (err) {
          const now = Date.now();
          if (now - (warned.get(src.server.id) || 0) > 3600 * 1000) {
            warned.set(src.server.id, now);
            log.warn(`Couldn't tell ${src.server.name} about ${what}: ${err.message}`);
          }
        }
      })
      .catch(() => {});
    chains.set(key, next);
  };
  const itemOf = (id) => core.db.get('SELECT * FROM items WHERE id = ?', id);

  core.hooks.on('playback:start', ({ session, item }) => {
    if (!item || !isRemotePath(item.path)) return;
    started.add(session.id);
    enqueue(item, 'the start', (p, server, it) => p.reportStart(server, it, { position: session.position || 0, duration: item.duration, sessionId: session.id }));
  });

  core.hooks.on('playback:progress', ({ item, position, watched, sessionId }) => {
    if (!item || !isRemotePath(item.path)) return;
    const now = Date.now();
    const slot = slotKey(item, sessionId);
    if (!watched && now - (last.get(slot) || 0) < reporter.everyMs) return;
    last.set(slot, now);
    const live = (sessionId && core.playback.sessions.get(sessionId)) || [...core.playback.sessions.values()].find((s) => s.itemId === item.id);
    enqueue(item, 'progress', (p, server, it) => p.reportProgress(server, it, { position, duration: item.duration, watched: Boolean(watched), paused: Boolean(live?.paused), sessionId: sessionId || live?.id }), { coalesce: true, watched: Boolean(watched), sessionId });
  });

  core.hooks.on('playback:stop', ({ session }) => {
    if (!started.delete(session.id)) return; // never started remotely, or already reported
    const item = itemOf(session.itemId);
    if (!item) return;
    last.delete(slotKey(item, session.id));
    enqueue(item, 'the stop', (p, server, it) => p.reportStop(server, it, { position: session.position || 0, duration: item.duration, sessionId: session.id }));
  });

  /** Resolves when every queued report has been sent (tests and shutdown). */
  reporter.idle = () => Promise.all([...chains.values()]);
  return reporter;
}

/** v0.11's name. */
export const attachProgressPush = attachReporter;
