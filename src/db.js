// SQLite storage using Node's built-in `node:sqlite` module (no native npm
// dependencies, so `npm install` is never needed).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Schema migrations. Append new entries; never edit old ones.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    prefs TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE libraries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('movies', 'tv')),
    paths TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    last_scan INTEGER
  );

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'show', 'season', 'episode')),
    parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    show_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort_title TEXT,
    original_title TEXT,
    year INTEGER,
    season INTEGER,
    episode INTEGER,
    overview TEXT,
    tagline TEXT,
    genres TEXT NOT NULL DEFAULT '[]',
    rating REAL,
    runtime INTEGER,
    air_date TEXT,
    poster TEXT,
    backdrop TEXT,
    tmdb_id INTEGER,
    imdb_id TEXT,
    path TEXT,
    size INTEGER,
    mtime INTEGER,
    duration REAL,
    media TEXT,
    metadata_at INTEGER,
    metadata_locked INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seen_scan INTEGER
  );
  CREATE UNIQUE INDEX items_path ON items(library_id, kind, path);
  CREATE INDEX items_parent ON items(parent_id);
  CREATE INDEX items_show ON items(show_id);
  CREATE INDEX items_lib_kind ON items(library_id, kind);
  CREATE INDEX items_added ON items(added_at);

  CREATE TABLE progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    duration REAL,
    watched INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE INDEX progress_recent ON progress(user_id, updated_at);

  CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // 2 — profiles ("who's watching?"), kids mode, library access, age ratings
  `
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    pin_hash TEXT,
    kids INTEGER NOT NULL DEFAULT 0,
    max_age INTEGER,
    allow_unrated INTEGER NOT NULL DEFAULT 0,
    libraries TEXT,
    prefs TEXT NOT NULL DEFAULT '{}',
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX profiles_user ON profiles(user_id);
  INSERT INTO profiles (user_id, name, prefs, is_primary, created_at)
    SELECT id, COALESCE(display_name, username), prefs, 1, created_at FROM users;

  ALTER TABLE users ADD COLUMN library_access TEXT;
  ALTER TABLE sessions ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN certification TEXT;
  ALTER TABLE items ADD COLUMN min_age INTEGER;

  CREATE TABLE progress_v2 (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    duration REAL,
    watched INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  );
  INSERT INTO progress_v2 (profile_id, item_id, position, duration, watched, updated_at)
    SELECT p.id, pr.item_id, pr.position, pr.duration, pr.watched, pr.updated_at
    FROM progress pr JOIN profiles p ON p.user_id = pr.user_id AND p.is_primary = 1;
  DROP TABLE progress;
  ALTER TABLE progress_v2 RENAME TO progress;
  CREATE INDEX progress_recent ON progress(profile_id, updated_at);
  `,
  // 3 — music: allow new library types and item kinds (the old CHECK constraints
  // are dropped by rebuilding the tables, as SQLite recommends) + track artists.
  `
  CREATE TABLE libraries_v3 (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    paths TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    last_scan INTEGER
  );
  INSERT INTO libraries_v3 (id, name, type, paths, created_at, last_scan) SELECT id, name, type, paths, created_at, last_scan FROM libraries;
  DROP TABLE libraries;
  ALTER TABLE libraries_v3 RENAME TO libraries;

  CREATE TABLE items_v3 (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    show_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort_title TEXT,
    original_title TEXT,
    artist TEXT,
    year INTEGER,
    season INTEGER,
    episode INTEGER,
    overview TEXT,
    tagline TEXT,
    genres TEXT NOT NULL DEFAULT '[]',
    rating REAL,
    runtime INTEGER,
    air_date TEXT,
    poster TEXT,
    backdrop TEXT,
    tmdb_id INTEGER,
    imdb_id TEXT,
    path TEXT,
    size INTEGER,
    mtime INTEGER,
    duration REAL,
    media TEXT,
    metadata_at INTEGER,
    metadata_locked INTEGER NOT NULL DEFAULT 0,
    certification TEXT,
    min_age INTEGER,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seen_scan INTEGER
  );
  INSERT INTO items_v3 (id, library_id, kind, parent_id, show_id, title, sort_title, original_title, year, season, episode,
      overview, tagline, genres, rating, runtime, air_date, poster, backdrop, tmdb_id, imdb_id, path, size, mtime, duration,
      media, metadata_at, metadata_locked, certification, min_age, added_at, updated_at, seen_scan)
    SELECT id, library_id, kind, parent_id, show_id, title, sort_title, original_title, year, season, episode,
      overview, tagline, genres, rating, runtime, air_date, poster, backdrop, tmdb_id, imdb_id, path, size, mtime, duration,
      media, metadata_at, metadata_locked, certification, min_age, added_at, updated_at, seen_scan FROM items;
  DROP TABLE items;
  ALTER TABLE items_v3 RENAME TO items;
  CREATE UNIQUE INDEX items_path ON items(library_id, kind, path);
  CREATE INDEX items_parent ON items(parent_id);
  CREATE INDEX items_show ON items(show_id);
  CREATE INDEX items_lib_kind ON items(library_id, kind);
  CREATE INDEX items_added ON items(added_at);
  `,

  // 4: the Arctic look replaces Midnight as the server default. Saving Settings → Server
  //    stored whatever default was showing, so "midnight" there moves over. A theme a
  //    person picked for their own profile is left alone.
  `
  UPDATE settings SET value = '"arctic"' WHERE key = 'defaultTheme' AND value = '"midnight"';
  `,

  // 5: clear logos (transparent title artwork) for movies, shows and artists.
  `
  ALTER TABLE items ADD COLUMN logo TEXT;
  `,

  // 6: seek-bar previews and intro/credits markers, made by the background job runner.
  //    media_jobs remembers what each job did for which file (size/mtime), so a
  //    replaced file is done again. markers: start/end both NULL = "there isn't one".
  `
  ALTER TABLE libraries ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE media_jobs (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    job TEXT NOT NULL CHECK (job IN ('previews', 'intros')),
    status TEXT NOT NULL CHECK (status IN ('done', 'none', 'failed')),
    data TEXT,
    error TEXT,
    source_size INTEGER,
    source_mtime INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, job)
  );
  CREATE TABLE markers (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('intro', 'credits')),
    start_time REAL,
    end_time REAL,
    source TEXT NOT NULL CHECK (source IN ('chapter', 'audio', 'manual')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, kind)
  );
  `,
];

/**
 * @param {string} file
 * @param {{upTo?: number}} [opts] upTo: stop after this migration (used by tests)
 */
export function openDatabase(file, { upTo = MIGRATIONS.length } = {}) {
  // node:sqlite still prints an ExperimentalWarning on Node 22/24. Hide just that one.
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (text && /SQLite/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = original;

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  // Migrations run with foreign keys off (so tables can be rebuilt without
  // cascading deletes), then the result is checked before switching them on.
  db.exec('PRAGMA foreign_keys = OFF');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < Math.min(upTo, MIGRATIONS.length); i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Migration ${i + 1} left ${broken.length} broken references (first: ${JSON.stringify(broken[0])})`);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  return {
    raw: db,
    get: (sql, ...params) => stmt(sql).get(...params),
    all: (sql, ...params) => stmt(sql).all(...params),
    run: (sql, ...params) => stmt(sql).run(...params),
    exec: (sql) => db.exec(sql),
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close(),
  };
}

export function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
