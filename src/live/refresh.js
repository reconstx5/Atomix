// Keeps each live source's channels and guide current: runs its refresh(), checks what comes back, stores it, and
// records the outcome. On its own timer — not the task runner, which pauses while video is converting.
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const RETRY_MS = 15 * 60_000;
const REFRESH_TIMEOUT_MS = 120_000;

export class LiveRefresher {
  constructor({ store, plugins, log, now = Date.now, tickMs = 60_000 }) {
    Object.assign(this, { store, plugins, log, now, tickMs });
    this.inflight = new Map(); // source key -> Promise
    this.again = new Set(); // sources whose settings changed during a refresh
    this.lastAttempt = new Map(); // source key -> { at, ok }
    this.refreshedListeners = []; // (sourceKey) => void, after each successful refresh (recording rules)
    this.timer = null;
    plugins.onLiveSourcesChanged?.((e) => {
      if (!this.timer) return;
      if (e.type === 'config' && Array.isArray(e.changed)) {
        // Only settings that change the channels or the guide refresh (a source may say which those are).
        const keys = this.plugins.getLiveSource?.(e.key)?.refreshKeys;
        if (Array.isArray(keys) && !e.changed.some((k) => keys.includes(k))) return;
      }
      if (e.type === 'registered' || e.type === 'config') this.refresh(e.key, { reason: e.type }).catch(() => {});
    });
  }

  onRefreshed(fn) {
    this.refreshedListeners.push(fn);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = this.now();
    for (const { key } of this.plugins.listLiveSources()) if (this.due(key, now)) this.refresh(key, { reason: 'timer' }).catch(() => {});
  }

  /** Resolves when no refresh is running (tests and shutdown). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  hoursFor(source) {
    const h = Number(typeof source?.refreshHours === 'function' ? source.refreshHours() : NaN);
    return Number.isFinite(h) && h > 0 ? h : 6;
  }

  /** Never refreshed; the interval passed; the guide runs out within a day; a failure retries after 15 minutes. */
  due(key, now = this.now()) {
    if (this.inflight.has(key)) return false;
    const last = this.lastAttempt.get(key) || (() => {
      const st = this.store.sourceStatus(key);
      return st?.lastRefresh ? { at: st.lastRefresh, ok: !st.error } : null;
    })();
    if (!last) return true;
    if (!last.ok) return now - last.at >= RETRY_MS;
    if (now - last.at >= this.hoursFor(this.plugins.getLiveSource(key)) * HOUR) return true;
    const end = this.store.guideEnd(key);
    return end != null && end - now < DAY && now - last.at >= RETRY_MS;
  }

  refresh(key, { reason = 'manual' } = {}) {
    if (this.inflight.has(key)) {
      // The running refresh read the old settings: once it's done, run once more with the new ones.
      if (reason === 'config') this.again.add(key);
      return this.inflight.get(key);
    }
    const job = this.run(key, reason).finally(() => {
      this.inflight.delete(key);
      if (this.again.delete(key)) this.refresh(key, { reason: 'config' }).catch(() => {});
    });
    this.inflight.set(key, job);
    return job;
  }

  async run(key, reason) {
    const source = this.plugins.getLiveSource(key);
    if (!source) return { ok: false, error: 'This live source is no longer installed' };
    const started = this.now();
    try {
      const result = await source.refresh({ signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS), log: this.log });
      const channels = Array.isArray(result?.channels) ? result.channels : null;
      if (!channels) throw new Error('The source returned no channel list');
      for (const c of channels) if (!c?.key || !c?.name) throw new Error('The source returned a channel without a key or name');
      if (!channels.length) throw new Error('The playlist has no channels');
      const maxDays = Math.max(1, ...channels.map((c) => Number(c.catchup?.days) || 0));
      const from = started - maxDays * DAY;
      const to = started + 7 * DAY;
      const programmes = Array.isArray(result.programmes) ? result.programmes.filter((p) => p && p.end > from && p.start < to) : null;
      const warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
      this.store.replaceChannels(key, channels);
      // A guide that couldn't be read (null) or came back with nothing keeps the last good one: a provider hiccup
      // never empties Live TV's guide. It is tried again in 15 minutes rather than at the next full refresh.
      const had = this.store.guideEnd(key) != null;
      const guideFailed = programmes === null || (!programmes.length && had);
      if (programmes && !programmes.length && had) warnings.push('The guide had no programmes — keeping the last one');
      const previous = this.store.sourceStatus(key);
      let stored = previous?.programmes || 0;
      let unmatched = null;
      if (!guideFailed) ({ stored, unmatched } = await this.store.replaceProgrammes(key, programmes || [], { from, to }));
      this.store.prune(from, to);
      const warning = warnings.length ? warnings.join(' · ') : null;
      // TV channels without guide are the count that matters; radio is listed apart (most guides don't cover radio).
      const unmatchedCount = unmatched ? unmatched.tv.length : previous?.unmatched || 0;
      const unmatchedNames = unmatched ? { tv: unmatched.tv.slice(0, 50), radio: unmatched.radio.slice(0, 50), radioCount: unmatched.radio.length } : null;
      this.store.recordRefresh(key, { ok: true, channels: channels.length, programmes: stored, unmatched: unmatchedCount, unmatchedNames, warning });
      this.problems?.clear('live-source', key);
      this.lastAttempt.set(key, { at: started, ok: !guideFailed });
      this.log?.info?.(`Live TV: ${source.name || key} refreshed (${reason}): ${channels.length} channels, ${stored} programmes`);
      for (const fn of this.refreshedListeners) {
        try {
          fn(key);
        } catch (err) {
          this.log?.warn?.(`Live TV: after refreshing ${key}: ${err.message}`);
        }
      }
      return { ok: true, channels: channels.length, programmes: stored, unmatched: unmatchedCount, warning, guideKept: guideFailed && had };
    } catch (err) {
      const error = err?.name === 'TimeoutError' ? 'The refresh took too long' : err?.message || 'The refresh failed';
      const before = this.store.sourceStatus(key);
      const repeat = before?.error === error;
      this.store.recordRefresh(key, { ok: false, error });
      // A source that has worked before and now fails is a server problem; one never set up yet isn't.
      if (before?.lastOk) this.problems?.report('live-source', key, `The Live TV source ${source?.name || key} couldn't refresh (${error}).`);
      this.lastAttempt.set(key, { at: started, ok: false });
      // The same failure every 15 minutes (no playlist set yet, a provider down for hours) is logged once.
      (repeat ? this.log?.debug : this.log?.warn)?.call(this.log, `Live TV: ${source.name || key} refresh failed: ${error}`);
      return { ok: false, error };
    }
  }

  /** The first 20 channel names without guide data from the last good refresh (admin page). */
  /** The names of channels without guide, TV and radio apart (kept in the database, so they survive a restart). */
  unmatchedNames(key) {
    const st = this.store.sourceStatus(key);
    return st ? st.unmatchedNames : { tv: [], radio: [] };
  }
}
