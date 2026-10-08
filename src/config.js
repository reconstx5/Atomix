// Static server configuration: read once at start-up from (in order of priority)
// environment variables, atomix.config.json, then defaults.
// Things an admin changes at runtime (TMDB key, transcoding, etc.) live in the
// database instead — see settings.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settleDatabase } from './db.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  dataDir: './data',
  pluginsDir: './plugins',
  themesDir: './themes',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  trustProxy: false,
  sessionDays: 30,
  logLevel: 'info',
};

// Environment variables: ATOMIX_<name>, then (for PORT and the ffmpeg paths) the plain
// name other tools use. Atomix used to be called NodeFlix, so NODEFLIX_<name> still works.
const ENV_MAP = {
  host: ['HOST'],
  port: ['PORT', 'PORT'],
  dataDir: ['DATA_DIR'],
  pluginsDir: ['PLUGINS_DIR'],
  themesDir: ['THEMES_DIR'],
  ffmpegPath: ['FFMPEG', 'FFMPEG_PATH'],
  ffprobePath: ['FFPROBE', 'FFPROBE_PATH'],
  trustProxy: ['TRUST_PROXY'],
  sessionDays: ['SESSION_DAYS'],
  logLevel: ['LOG_LEVEL'],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[config] Could not read ${file}: ${err.message}`);
    return {};
  }
}

function coerce(key, value) {
  if (typeof DEFAULTS[key] === 'number') return Number(value);
  if (typeof DEFAULTS[key] === 'boolean') return value === true || /^(1|true|yes|on)$/i.test(String(value));
  return value;
}

const isSet = (value) => value !== undefined && value !== '';

/**
 * ATOMIX_<name> or, from before the rename, NODEFLIX_<name> (noted in `renamed`),
 * then the plain name if there is one.
 */
function fromEnv(env, name, plain, renamed) {
  if (isSet(env[`ATOMIX_${name}`])) return env[`ATOMIX_${name}`];
  if (isSet(env[`NODEFLIX_${name}`])) {
    renamed.push(`NODEFLIX_${name} → ATOMIX_${name}`);
    return env[`NODEFLIX_${name}`];
  }
  return plain && isSet(env[plain]) ? env[plain] : undefined;
}

function configFileIn(root, env, renamed, notices) {
  const named = fromEnv(env, 'CONFIG', null, renamed);
  if (named) return path.resolve(root, named);
  const file = path.join(root, 'atomix.config.json');
  const old = path.join(root, 'nodeflix.config.json');
  if (!fs.existsSync(file) && fs.existsSync(old)) {
    notices.push('Reading settings from nodeflix.config.json. Rename it to atomix.config.json when you can.');
    return old;
  }
  return file;
}

/**
 * The database is atomix.db. One from before the rename (nodeflix.db) is renamed the
 * first time Atomix starts. Opening and closing it first folds its write-ahead log
 * (the -wal file) into the main file, so only one file has to move. If the log is
 * still there afterwards, another program has the database open: leave it alone.
 */
function databaseIn(dataDir, notices) {
  const file = path.join(dataDir, 'atomix.db');
  const old = path.join(dataDir, 'nodeflix.db');
  if (fs.existsSync(file) || !fs.existsSync(old)) return file;
  try {
    settleDatabase(old);
    if (fs.existsSync(`${old}-wal`)) throw new Error('another program has it open');
    fs.rmSync(`${old}-shm`, { force: true });
    fs.renameSync(old, file);
    notices.push('Renamed the database nodeflix.db to atomix.db.');
    return file;
  } catch (err) {
    notices.push(`Kept the database name nodeflix.db for now (${err.message}). It is renamed to atomix.db the next time Atomix starts.`);
    return old;
  }
}

/**
 * @param {{env?: object, root?: string}} [opts] env: the environment variables to read;
 *   root: the folder the config file and relative paths are in (both for tests).
 */
export function loadConfig({ env = process.env, root = ROOT } = {}) {
  const renamed = [];
  const notices = [];
  const fromFile = readJson(configFileIn(root, env, renamed, notices));
  const cfg = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    if (fromFile[key] !== undefined) cfg[key] = coerce(key, fromFile[key]);
    const [name, plain] = ENV_MAP[key];
    const value = fromEnv(env, name, plain, renamed);
    if (value !== undefined) cfg[key] = coerce(key, value);
  }

  for (const key of ['dataDir', 'pluginsDir', 'themesDir']) {
    cfg[key] = path.resolve(root, cfg[key]);
  }
  cfg.imagesDir = path.join(cfg.dataDir, 'images');
  cfg.cacheDir = path.join(cfg.dataDir, 'cache');
  cfg.transcodeDir = path.join(cfg.dataDir, 'transcode');
  cfg.previewsDir = path.join(cfg.dataDir, 'previews');
  cfg.pluginDataDir = path.join(cfg.dataDir, 'plugin-data');
  cfg.publicDir = path.join(ROOT, 'public');
  cfg.tmdbBase = fromEnv(env, 'TMDB_BASE', null, renamed) || 'https://api.themoviedb.org/3';
  cfg.tmdbImageBase = fromEnv(env, 'TMDB_IMAGE_BASE', null, renamed) || 'https://image.tmdb.org/t/p';
  cfg.lrclibBase = env.ATOMIX_LRCLIB_BASE || 'https://lrclib.net/api';
  cfg.plexTvBase = env.ATOMIX_PLEXTV_BASE || 'https://plex.tv';
  // Casting: an address override for TVs, and (dev/test only) devices to list as if found: "chromecast:host:port,dlna:<url>".
  cfg.castBaseUrl = env.ATOMIX_CAST_BASE_URL || null;
  cfg.castDiscovery = env.ATOMIX_CAST_DISCOVERY !== 'off'; // off: only devices added by address (tests, locked-down networks)
  cfg.castDevices = String(env.ATOMIX_CAST_DEVICES || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf(':');
    return { kind: x.slice(0, i), address: x.slice(i + 1) };
  }).filter((d) => ['chromecast', 'dlna'].includes(d.kind) && d.address);
  cfg.initialTmdbKey = env.TMDB_API_KEY || fromFile.tmdbApiKey || '';

  for (const dir of [cfg.dataDir, cfg.imagesDir, cfg.cacheDir, cfg.transcodeDir, cfg.pluginDataDir, cfg.previewsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  cfg.dbFile = databaseIn(cfg.dataDir, notices);
  // Said once at start-up (see app.js).
  if (renamed.length) notices.unshift(`Atomix used to be called NodeFlix. Please rename these settings: ${renamed.join(', ')}.`);
  cfg.notices = notices;
  return cfg;
}
