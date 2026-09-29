// Static server configuration: read once at start-up from (in order of priority)
// environment variables, nodeflix.config.json, then defaults.
// Things an admin changes at runtime (TMDB key, transcoding, etc.) live in the
// database instead — see settings.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ENV_MAP = {
  host: 'NODEFLIX_HOST',
  port: ['NODEFLIX_PORT', 'PORT'],
  dataDir: 'NODEFLIX_DATA_DIR',
  pluginsDir: 'NODEFLIX_PLUGINS_DIR',
  themesDir: 'NODEFLIX_THEMES_DIR',
  ffmpegPath: ['NODEFLIX_FFMPEG', 'FFMPEG_PATH'],
  ffprobePath: ['NODEFLIX_FFPROBE', 'FFPROBE_PATH'],
  trustProxy: 'NODEFLIX_TRUST_PROXY',
  sessionDays: 'NODEFLIX_SESSION_DAYS',
  logLevel: 'NODEFLIX_LOG_LEVEL',
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

export function loadConfig() {
  const configFile = process.env.NODEFLIX_CONFIG || path.join(ROOT, 'nodeflix.config.json');
  const fromFile = readJson(configFile);
  const cfg = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    if (fromFile[key] !== undefined) cfg[key] = coerce(key, fromFile[key]);
    const envNames = [].concat(ENV_MAP[key] || []);
    for (const name of envNames) {
      if (process.env[name] !== undefined && process.env[name] !== '') {
        cfg[key] = coerce(key, process.env[name]);
        break;
      }
    }
  }

  for (const key of ['dataDir', 'pluginsDir', 'themesDir']) {
    cfg[key] = path.resolve(ROOT, cfg[key]);
  }
  cfg.imagesDir = path.join(cfg.dataDir, 'images');
  cfg.cacheDir = path.join(cfg.dataDir, 'cache');
  cfg.transcodeDir = path.join(cfg.dataDir, 'transcode');
  cfg.previewsDir = path.join(cfg.dataDir, 'previews');
  cfg.pluginDataDir = path.join(cfg.dataDir, 'plugin-data');
  cfg.dbFile = path.join(cfg.dataDir, 'nodeflix.db');
  cfg.publicDir = path.join(ROOT, 'public');
  cfg.tmdbBase = process.env.NODEFLIX_TMDB_BASE || 'https://api.themoviedb.org/3';
  cfg.tmdbImageBase = process.env.NODEFLIX_TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p';
  cfg.initialTmdbKey = process.env.TMDB_API_KEY || fromFile.tmdbApiKey || '';

  for (const dir of [cfg.dataDir, cfg.imagesDir, cfg.cacheDir, cfg.transcodeDir, cfg.pluginDataDir, cfg.previewsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return cfg;
}
