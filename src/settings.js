import os from 'node:os';
// Runtime settings an admin can change from the web UI. Stored in the DB.
import { parseJson } from './db.js';

export const SETTING_DEFAULTS = {
  serverName: 'Atomix',
  jellyfinServerId: '', // the Jellyfin API's server id (made on first use)
  defaultTheme: 'orbit',
  tmdbApiKey: '',
  metadataLanguage: 'en-US',
  ratingCountry: 'NZ', // whose age ratings Kids profiles use (falls back to US)
  scanIntervalMinutes: 60,
  transcodingEnabled: true,
  hwAccel: 'none', // none | nvenc | qsv | vaapi | videotoolbox | amf
  vaapiDevice: '/dev/dri/renderD128',
  x264Preset: 'veryfast',
  // Software conversion is capped here (a PC can't keep up with 4K at veryfast); hardware encoders ignore it.
  maxSoftwareHeight: os.cpus().length < 6 ? 720 : 1080,
  maxTranscodes: 3,
  defaultQuality: 'original', // original | 1080 | 720 | 480
  previewsEnabled: true, // background job: seek-bar preview pictures
  cardClips: true, // v0.28 card motion: a 5 s silent preview clip per title for cards (needs previews on)
  introDetection: true, // background job: find TV intros (and credits chapters)
  communityTimestamps: true, // v0.28: TheIntroDB's shared intro/recap/credits times fill what the files can't tell
  loginMessage: '',
  thumbCacheMB: 2048, // v0.24: the smaller copies of artwork (least used go first when full)
  remoteSyncHours: 6, // connected servers are re-read this often (0 = only on demand)
  castEnabled: true, // cast to Chromecasts and DLNA TVs on the home network
  castBaseUrl: null, // the address TVs use to reach Atomix (null: the home-network address, found on its own)
  plexClientId: null, // made the first time Plex is used; this Atomix's stable device id at plex.tv
  onlineTrailers: true, // the film's YouTube trailer when there is no local one
  onlineLyrics: true, // ask LRCLIB for lyrics the files don't have
  pickerIdleMinutes: 30, // "Who's watching?" comes back after this long untouched (0 = never)
  recordingsDir: '', // Live TV recordings ('' = <data>/recordings)
  lastfmApiKey: '', // Scrobbling to Last.fm: the API account's key and shared secret (the secret is never sent back)
  lastfmSecret: '',
  quickConnect: true, // TVs can sign in by showing a code that someone signed in approves
  recordPre: 1, // minutes a recording starts early (0–30)
  recordPost: 3, // minutes a recording ends late (0–60)
  // v0.21 downloads: the server prepares phone-sized copies that the installed app keeps on the device.
  downloadsEnabled: true,
  downloadsDir: '', // '' = <data>/downloads
  downloadsCacheGb: 50, // the prepared copies are kept under this (oldest used first)
  downloadQuality: '720', // 480 | 720 | 1080
  archiveToolPath: '', // v0.22: 7-Zip or unrar for .cbr/.cb7 comics (empty: look for 7z, 7za, 7zz, unrar)
  downloadOfflineDays: 30, // a device keeps a download this long without reaching Atomix
  downloadDeviceGb: 20, // space a device may use for downloads
  podcastCheckHours: 6, // v0.22: how often the podcast feeds are checked (0 = only by hand)
  metadataProvidersSeen: null, // v0.23: plugin metadata providers already offered the existing titles (ids)
  httpsMode: 'off', // v0.27: the secure address — off | tailscale | own (Atomix's own home certificate)
  httpsPort: 8443,
  arrKey: null, // v0.28: the key in the download apps' webhook address (made once; a new one only from its own route)
  requestUrl: '', // v0.28: where "Request it" sends people (Seerr, Overseerr, Jellyseerr, Ombi…); '' = no button
};

/** Whole numbers kept inside their range. */
const RANGES = { thumbCacheMB: [100, 100000], podcastCheckHours: [0, 168], recordPre: [0, 30], recordPost: [0, 60], downloadsCacheGb: [1, 2000], downloadOfflineDays: [7, 90], downloadDeviceGb: [1, 500], httpsPort: [1, 65535] };
/** Settings that are one of a few words; anything else becomes the default. */
const CHOICES = { downloadQuality: ['480', '720', '1080'], httpsMode: ['off', 'tailscale', 'own'] };

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
        if (RANGES[key]) v = Math.min(RANGES[key][1], Math.max(RANGES[key][0], Math.round(v)));
        if (CHOICES[key] && !CHOICES[key].includes(v)) v = def;
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
    return { serverName: s.serverName, defaultTheme: s.defaultTheme, defaultQuality: s.defaultQuality, pickerIdleMinutes: s.pickerIdleMinutes };
  }
}
