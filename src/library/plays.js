// Play history. Every progress report for a film, an episode or a song comes here (the browser player, the music
// player, casts, and the music apps). One row per playing: a report within 6 hours of the last one for the same
// title carries on its row. A song is counted after half its length or 4 minutes of listening, whichever comes
// first; a film or episode when it's watched. Only listened time counts: a jump ahead adds no more than the time
// that really passed (plus a little slack for report timing).

const PLAYABLE = new Set(['movie', 'episode', 'track', 'podcast_episode', 'audiobook', 'book', 'comic']); // v0.22: a book's play is counted on the book
const OPEN_MS = 6 * 3600_000;
const READ_GAP = 120; // seconds: a longer gap between a reader's reports was time away
const SONG_ENOUGH = 240; // seconds
const SLACK = 5; // seconds a report may run ahead of the clock
const REPLAY_START = 15; // a finished title reported back within its first seconds is playing again
const NOTHING = Object.freeze({ playId: null, counted: false, justCounted: false });

export class Plays {
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
    this.last = new Map(); // "<profile>:<item>" -> { position, at, playId }
    this.started = [];
    this.counted = [];
  }
  onStarted(fn) {
    this.started.push(fn);
  }
  onCounted(fn) {
    this.counted.push(fn);
  }
  emit(list, event) {
    for (const fn of list) {
      try {
        fn(event);
      } catch {
        /* a listener's failure never stops playback */
      }
    }
  }

  /** The newest report of each play, kept newest-last (a key moves to the end when it's set again), so plays left
   *  more than 6 hours ago are dropped from the front: each report touches only what it drops. */
  remember(key, value) {
    this.last.delete(key);
    this.last.set(key, value);
    const old = this.now() - OPEN_MS;
    for (const [k, v] of this.last) {
      if (v.at >= old) break;
      this.last.delete(k);
    }
  }

  /**
   * A play an app says happened (Subsonic's scrobble): the open, uncounted play is counted; otherwise a new, counted
   * play is written at `at`. `onCounted` fires once either way.
   * @returns {{ playId: number|null, justCounted: boolean }}
   */
  submitted({ profileId, item, at, client = 'music app' }) {
    if (!profileId || !item || !PLAYABLE.has(item.kind)) return { playId: null, justCounted: false };
    const given = Number.isFinite(Number(at)) && Number(at) > 0;
    const when = given ? Math.min(Number(at), this.now()) : this.now();
    const open = this.db.get('SELECT * FROM plays WHERE profile_id = ? AND item_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1', profileId, item.id, this.now() - OPEN_MS);
    let id;
    if (open && !open.counted) {
      id = open.id;
      this.db.run('UPDATE plays SET counted = 1, seconds = MAX(seconds, ?), updated_at = MAX(updated_at, ?) WHERE id = ?', item.duration || 0, when, id);
      if (given) this.db.run('UPDATE plays SET started_at = ? WHERE id = ?', when, id); // the app's own time is when it was heard
    } else {
      id = Number(this.db.run('INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (?, ?, ?, ?, ?, 1, ?)', profileId, item.id, when, when, item.duration || 0, String(client).slice(0, 60)).lastInsertRowid);
    }
    this.remember(`${profileId}:${item.id}`, { position: item.duration || 0, at: this.now(), playId: id, paused: false });
    const row = this.db.get('SELECT client FROM plays WHERE id = ?', id);
    this.emit(this.counted, { profileId, item, playId: id, client: row.client });
    return { playId: id, justCounted: true };
  }

  /**
   * @param {{ profileId: number, item: object, position: number, duration?: number, watched?: boolean, paused?: boolean, client?: string }} r
   *   paused: this report is a pause — the time until the next report isn't listening.
   * @returns {{ playId: number|null, counted: boolean, justCounted: boolean }}
   */
  report({ profileId, item, position, duration, watched = false, paused = false, client = 'browser', pages = 0 }) {
    if (!profileId || !item || !PLAYABLE.has(item.kind) || !Number.isInteger(item.id)) return { ...NOTHING };
    const now = this.now();
    const pos = Math.max(0, Number(position) || 0);
    const key = `${profileId}:${item.id}`;
    let row = this.db.get('SELECT * FROM plays WHERE profile_id = ? AND item_id = ? AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1', profileId, item.id, now - OPEN_MS);
    const prev = this.last.get(key);
    const length = Number(duration) || item.duration || 0;
    // Played again from the top after finishing (repeat, the album again tonight): a new play, counted again.
    if (row?.counted && prev?.playId === row.id && length && prev.position >= length * 0.9 && pos <= REPLAY_START) row = null;
    let isNew = false;
    if (!row) {
      const id = Number(this.db.run('INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (?, ?, ?, ?, 0, 0, ?)', profileId, item.id, now, now, String(client).slice(0, 60)).lastInsertRowid);
      row = this.db.get('SELECT * FROM plays WHERE id = ?', id);
      isNew = true;
    }
    let added = 0;
    const reading = item.kind === 'book' || item.kind === 'comic';
    if (!isNew && prev && prev.playId === row.id && !prev.paused) {
      const wall = Math.max(0, (now - prev.at) / 1000);
      // Reading (v0.22): the time since the last report (the reader reports every 30 s while it is on screen).
      added = reading ? Math.min(wall, READ_GAP) : Math.min(Math.max(0, pos - prev.position), wall + SLACK);
    }
    const turned = reading ? Math.max(0, Math.min(1000, Math.floor(Number(pages) || 0))) : 0;
    this.remember(key, { position: pos, at: now, playId: row.id, paused: Boolean(paused) });
    const seconds = row.seconds + added;
    const enough = item.kind === 'track' ? length > 0 && seconds >= Math.min(length / 2, SONG_ENOUGH) : Boolean(watched);
    const justCounted = !row.counted && enough;
    this.db.run('UPDATE plays SET seconds = ?, updated_at = ?, counted = ?, pages = pages + ? WHERE id = ?', seconds, now, row.counted || justCounted ? 1 : 0, turned, row.id);
    const event = { profileId, item, playId: row.id, client: row.client };
    if (isNew) this.emit(this.started, event);
    if (justCounted) this.emit(this.counted, event);
    return { playId: row.id, counted: Boolean(row.counted || justCounted), justCounted, started: isNew };
  }

  /** An app saying this song is playing now: the play opens or carries on, and onStarted fires either way. */
  nowPlaying({ profileId, item, client }) {
    const r = this.report({ profileId, item, position: 0, duration: item?.duration, client });
    if (r.playId && !r.started) this.emit(this.started, { profileId, item, playId: r.playId, client: this.db.get('SELECT client FROM plays WHERE id = ?', r.playId).client });
    return r;
  }
}
