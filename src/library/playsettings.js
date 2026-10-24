// The player's audio and subtitle delay for one profile and title: −5…+5 s and −10…+10 s, in tenths. Remembered so
// a title that's out of sync is fixed once; both back to 0 forgets the row.
const RANGE = { audioDelay: 5, subtitleDelay: 10 };
const round = (v, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(-max, Math.min(max, n)) * 10) / 10 || 0;
};

export class PlaySettings {
  constructor({ db, now = Date.now }) {
    this.db = db;
    this.now = now;
  }
  get(profileId, itemId) {
    const r = profileId ? this.db.get('SELECT audio_delay, subtitle_delay FROM play_settings WHERE profile_id = ? AND item_id = ?', profileId, itemId) : null;
    return { audioDelay: r?.audio_delay || 0, subtitleDelay: r?.subtitle_delay || 0 };
  }
  /** Fields left out keep their value. */
  set(profileId, itemId, { audioDelay, subtitleDelay } = {}) {
    const now = this.get(profileId, itemId);
    const next = {
      audioDelay: audioDelay === undefined ? now.audioDelay : round(audioDelay, RANGE.audioDelay),
      subtitleDelay: subtitleDelay === undefined ? now.subtitleDelay : round(subtitleDelay, RANGE.subtitleDelay),
    };
    if (!next.audioDelay && !next.subtitleDelay) this.db.run('DELETE FROM play_settings WHERE profile_id = ? AND item_id = ?', profileId, itemId);
    else
      this.db.run(
        `INSERT INTO play_settings (profile_id, item_id, audio_delay, subtitle_delay, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, item_id) DO UPDATE SET audio_delay = excluded.audio_delay, subtitle_delay = excluded.subtitle_delay, updated_at = excluded.updated_at`,
        profileId, itemId, next.audioDelay, next.subtitleDelay, this.now(),
      );
    return next;
  }
}
