// Scrobbling: each profile can send what it listens to to ListenBrainz and Last.fm. Songs only: "now playing" when a
// play starts, a listen when it's counted (Plays). Listens go through a queue: written before they're sent, retried
// with growing waits (2, 4, 8 … minutes, at most 6 hours) for 14 days when a service is down, dropped for good when a
// service refuses one, and stopped for the profile when a service refuses its sign-in ("Connect again"). Tokens,
// session keys and the Last.fm secret stay in the database: no route returns them.
import crypto from 'node:crypto';
import { HttpError } from '../http/router.js';
import { logger } from '../log.js';
import * as lb from './listenbrainz.js';
import * as lf from './lastfm.js';

export { signature as lastfmSignature } from './lastfm.js';

const DAY = 86400_000;
const KEEP = 14 * DAY;
const MAX_WAIT = 6 * 3600_000;
const SERVICES = ['listenbrainz', 'lastfm'];

export class Scrobblers {
  constructor({ db, settings, config, now = Date.now, fetchFn = fetch, log = logger('scrobble'), timers = true }) {
    Object.assign(this, { db, settings, config, now, fetchFn, log });
    this.states = new Map(); // Last.fm sign-in: state -> { profileId, expires }
    this.draining = null;
    if (timers) setInterval(() => this.drain().catch(() => {}), 60_000).unref();
  }

  row(profileId, service) {
    return this.db.get('SELECT * FROM profile_scrobblers WHERE profile_id = ? AND service = ?', profileId, service) || null;
  }
  lastfmReady() {
    return Boolean(this.settings.get('lastfmApiKey') && this.settings.get('lastfmSecret'));
  }
  status(profileId) {
    return SERVICES.map((service) => {
      const r = this.row(profileId, service);
      return { service, connected: Boolean(r?.token), username: r?.username || null, lastOk: r?.last_ok ?? null, lastError: r?.last_error ?? null, stopped: Boolean(r?.stopped) };
    });
  }
  save(profileId, service, token, username) {
    this.db.run(
      `INSERT INTO profile_scrobblers (profile_id, service, token, username, stopped, last_error) VALUES (?, ?, ?, ?, 0, NULL)
       ON CONFLICT(profile_id, service) DO UPDATE SET token = excluded.token, username = excluded.username, stopped = 0, last_error = NULL`,
      profileId, service, token, username,
    );
    return this.status(profileId).find((s) => s.service === service);
  }
  disconnect(profileId, service) {
    this.db.run('DELETE FROM profile_scrobblers WHERE profile_id = ? AND service = ?', profileId, service);
    this.db.run('DELETE FROM scrobble_queue WHERE profile_id = ? AND service = ?', profileId, service);
  }

  async connectListenBrainz(profileId, token) {
    const t = String(token || '').trim();
    let check = { valid: false };
    if (t && t.length <= 200) check = await lb.validateToken(this.config.listenbrainzBase, t, this.fetchFn).catch(() => ({ valid: false, unreachable: true }));
    if (check.unreachable) throw new HttpError(502, "Couldn't reach ListenBrainz. Try again in a moment.");
    if (!check.valid) throw new HttpError(400, "ListenBrainz didn't accept that token.");
    return this.save(profileId, 'listenbrainz', t, check.user || null);
  }

  lastfmStart(profileId, callbackUrl) {
    if (!this.lastfmReady()) throw new HttpError(400, 'An admin needs to add a Last.fm API key first (Settings → Server).');
    const state = crypto.randomBytes(18).toString('base64url');
    const now = this.now();
    for (const [k, v] of this.states) if (v.expires < now) this.states.delete(k);
    this.states.set(state, { profileId, expires: now + 10 * 60_000 });
    const cb = `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}state=${state}`;
    return { url: `${this.config.lastfmAuthBase}?api_key=${encodeURIComponent(this.settings.get('lastfmApiKey'))}&cb=${encodeURIComponent(cb)}` };
  }
  async lastfmFinish(profileId, { token, state }) {
    const fail = () => new HttpError(400, "Last.fm didn't connect. Try again.");
    const s = this.states.get(String(state || ''));
    if (!s || s.profileId !== profileId || s.expires < this.now() || !token) throw fail();
    this.states.delete(String(state));
    const j = await lf.call(this.config.lastfmBase, { method: 'auth.getSession', api_key: this.settings.get('lastfmApiKey'), token: String(token) }, this.settings.get('lastfmSecret'), this.fetchFn).catch(() => null);
    if (!j?.session?.key) throw fail();
    return this.save(profileId, 'lastfm', j.session.key, j.session.name || null);
  }

  /** The song's names for a listen; null for anything that isn't a song. */
  describe(item, listenedAt) {
    if (item?.kind !== 'track') return null;
    const album = item.parent_id ? this.db.get('SELECT title, parent_id FROM items WHERE id = ?', item.parent_id) : null;
    const albumArtist = item.show_id ? this.db.get('SELECT title FROM items WHERE id = ?', item.show_id)?.title : null;
    const artist = item.artist || albumArtist;
    if (!artist || !item.title) return null;
    return { artist, track: item.title, album: album?.title || null, duration: item.duration || null, trackNumber: item.episode ?? null, listenedAt };
  }
  live(profileId) {
    return this.db.all('SELECT * FROM profile_scrobblers WHERE profile_id = ? AND stopped = 0 AND token IS NOT NULL', profileId).filter((r) => r.service !== 'lastfm' || this.lastfmReady());
  }

  async send(row, kind, t) {
    if (row.service === 'listenbrainz') return lb.submit(this.config.listenbrainzBase, row.token, lb.listenBody(kind, t, this.config.version || '0'), this.fetchFn);
    try {
      const j = await lf.call(this.config.lastfmBase, { ...lf.trackParams(kind, t), api_key: this.settings.get('lastfmApiKey'), sk: row.token }, this.settings.get('lastfmSecret'), this.fetchFn);
      return lf.outcome(j);
    } catch (err) {
      return { result: 'retry', message: `Couldn't reach Last.fm (${err.cause?.code || err.name})` };
    }
  }
  stop(profileId, service) {
    this.db.run("UPDATE profile_scrobblers SET stopped = 1, last_error = 'Connect again' WHERE profile_id = ? AND service = ?", profileId, service);
    this.db.run('DELETE FROM scrobble_queue WHERE profile_id = ? AND service = ?', profileId, service);
  }

  /** "Now playing": sent at once, never queued. */
  async nowPlaying({ profileId, item }) {
    const t = this.describe(item, this.now());
    if (!t) return;
    for (const row of this.live(profileId)) {
      const r = await this.send(row, 'now', t);
      if (r.result === 'stop') this.stop(profileId, row.service);
    }
  }

  /** A counted song: queued for each connected service, then sent. */
  async listen({ profileId, item, playId }) {
    const started = playId ? this.db.get('SELECT started_at FROM plays WHERE id = ?', playId)?.started_at : null;
    const t = this.describe(item, started || this.now());
    if (!t) return;
    const rows = this.live(profileId);
    if (!rows.length) return;
    for (const row of rows) {
      this.db.run("INSERT INTO scrobble_queue (profile_id, service, kind, payload, at, tries, next_at) VALUES (?, ?, 'listen', ?, ?, 0, ?)", profileId, row.service, JSON.stringify(t), t.listenedAt, this.now());
    }
    await this.drain();
  }

  /** Send what's due, oldest first; a service that fails holds back that profile's later listens to it (order). */
  drain() {
    // Asked while a pass is sending: one more pass after it, so a listen queued meanwhile goes out now, not in a minute.
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.drainAgain = false;
        await this.drainOnce();
      } while (this.drainAgain);
    })().finally(() => (this.draining = null));
    return this.draining;
  }
  async drainOnce() {
    const now = this.now();
    this.db.run('DELETE FROM scrobble_queue WHERE at < ?', now - KEEP);
    const due = this.db.all('SELECT * FROM scrobble_queue ORDER BY at, id');
    const held = new Set();
    for (const q of due) {
      const key = `${q.profile_id}:${q.service}`;
      if (held.has(key)) continue;
      if (q.next_at > now) {
        held.add(key); // an older listen still waiting: later ones wait behind it
        continue;
      }
      const row = this.row(q.profile_id, q.service);
      if (!row?.token || row.stopped) {
        this.db.run('DELETE FROM scrobble_queue WHERE id = ?', q.id);
        continue;
      }
      let t;
      try {
        t = JSON.parse(q.payload);
      } catch {
        t = null;
      }
      if (!t?.artist) {
        this.db.run('DELETE FROM scrobble_queue WHERE id = ?', q.id);
        continue;
      }
      const r = await this.send(row, 'listen', t);
      if (r.result === 'ok') {
        this.db.run('DELETE FROM scrobble_queue WHERE id = ?', q.id);
        this.db.run('UPDATE profile_scrobblers SET last_ok = ?, last_error = NULL WHERE profile_id = ? AND service = ?', this.now(), q.profile_id, q.service);
      } else if (r.result === 'stop') {
        this.stop(q.profile_id, q.service);
        held.add(key);
      } else if (r.result === 'retry') {
        const tries = q.tries + 1;
        this.db.run('UPDATE scrobble_queue SET tries = ?, next_at = ? WHERE id = ?', tries, this.now() + Math.min(2 ** tries * 60_000, MAX_WAIT), q.id);
        this.db.run('UPDATE profile_scrobblers SET last_error = ? WHERE profile_id = ? AND service = ?', r.message, q.profile_id, q.service);
        held.add(key);
      } else {
        this.db.run('DELETE FROM scrobble_queue WHERE id = ?', q.id);
        this.db.run('UPDATE profile_scrobblers SET last_error = ? WHERE profile_id = ? AND service = ?', r.message, q.profile_id, q.service);
      }
    }
  }
}
