// Runtime settings an admin can change from the web UI. Stored in the DB.
import { parseJson } from './db.js';

export const SETTING_DEFAULTS = {
  serverName: 'NodeFlix',
  defaultTheme: 'arctic',
  tmdbApiKey: '',
  metadataLanguage: 'en-US',
  ratingCountry: 'NZ', // whose age ratings Kids profiles use (falls back to US)
  scanIntervalMinutes: 60,
  transcodingEnabled: true,
  hwAccel: 'none', // none | nvenc | qsv | vaapi | videotoolbox | amf
  vaapiDevice: '/dev/dri/renderD128',
  x264Preset: 'veryfast',
  maxTranscodes: 3,
  defaultQuality: 'original', // original | 1080 | 720 | 480
  previewsEnabled: true, // background job: seek-bar preview pictures
  introDetection: true, // background job: find TV intros (and credits chapters)
  loginMessage: '',
};

export class Settings {
  constructor(db) {
    this.db = db;
    this.listeners = new Set();
  }

  all() {
    const rows = this.db.all('SELECT key, value FROM settings');
    const out = { ...SETTING_DEFAULTS };
    for (const row of rows) out[row.key] = parseJson(row.value, SETTING_DEFAULTS[row.key]);
    return out;
  }

  get(key) {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? parseJson(row.value, SETTING_DEFAULTS[key]) : SETTING_DEFAULTS[key];
  }

  set(values) {
    const changed = {};
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in SETTING_DEFAULTS)) continue;
        const def = SETTING_DEFAULTS[key];
        let v = value;
        if (typeof def === 'number') v = Number(value);
        if (typeof def === 'boolean') v = Boolean(value);
        if (typeof def === 'string') v = String(value ?? '');
        if (typeof def === 'number' && !Number.isFinite(v)) continue;
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(v),
        );
        changed[key] = v;
      }
    });
    for (const fn of this.listeners) fn(changed);
    return this.all();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  /** Settings safe to expose to any signed-in user. */
  publicView() {
    const s = this.all();
    return { serverName: s.serverName, defaultTheme: s.defaultTheme, defaultQuality: s.defaultQuality };
  }
}
