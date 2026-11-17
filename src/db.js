// SQLite storage using Node's built-in `node:sqlite` module (no native npm
// dependencies, so `npm install` is never needed).
import { registerSearchKey } from './library/searchkey.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Schema migrations. Append new entries; never edit old ones.
export const MIGRATIONS = [
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

  // 7: NodeFlix is now Atomix. The setup screen filled in "NodeFlix" as the server's
  //    name, so that moves over too; a name someone typed themselves stays.
  `
  UPDATE settings SET value = '"Atomix"' WHERE key = 'serverName' AND value = '"NodeFlix"';
  `,

  // 8: the Orbit look replaces Arctic as the server default, as migration 4 did for Midnight.
  //    A theme a person picked for their own profile is left alone.
  `
  UPDATE settings SET value = '"orbit"' WHERE key = 'defaultTheme' AND value = '"arctic"';
  `,

  // 9: collections (TMDB film series and hand-made), playlists and the Watchlist (lists), and the
  //    keywords/people TMDB gives us, which the picks are scored on. collections.parts keeps TMDB's
  //    list of a series' films in release order, so a page can grey out the ones you don't own.
  `
  ALTER TABLE items ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE items ADD COLUMN people TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    tmdb_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    overview TEXT,
    poster TEXT,
    backdrop TEXT,
    manual INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    parts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (collection_id, item_id)
  );
  CREATE INDEX collection_items_item ON collection_items(item_id);
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('watchlist', 'video', 'music')),
    name TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX lists_watchlist ON lists(profile_id) WHERE kind = 'watchlist';
  CREATE TABLE list_items (
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, item_id)
  );
  CREATE INDEX list_items_item ON list_items(item_id);
  `,
  // 10: extras (trailers, featurettes… under a film or show), the TMDB/YouTube trailer, and lyrics. media_jobs is
  //     rebuilt so it can also record the 'thumb' job (a still frame for each extra).
  `
  CREATE TABLE media_jobs_new (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    job TEXT NOT NULL CHECK (job IN ('previews', 'intros', 'thumb')),
    status TEXT NOT NULL CHECK (status IN ('done', 'none', 'failed')),
    data TEXT,
    error TEXT,
    source_size INTEGER,
    source_mtime INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, job)
  );
  INSERT INTO media_jobs_new SELECT item_id, job, status, data, error, source_size, source_mtime, updated_at FROM media_jobs;
  DROP TABLE media_jobs;
  ALTER TABLE media_jobs_new RENAME TO media_jobs;
  ALTER TABLE items ADD COLUMN extra_kind TEXT;
  ALTER TABLE items ADD COLUMN trailer TEXT;
  CREATE INDEX items_extras ON items(parent_id, extra_kind) WHERE extra_kind IS NOT NULL;
  CREATE TABLE lyrics (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('file', 'tags', 'lrclib', 'none')),
    synced INTEGER NOT NULL DEFAULT 0,
    text TEXT,
    file_mtime INTEGER,
    fetched_at INTEGER NOT NULL
  );
  `,
  // 11: connected servers (Jellyfin, Emby, another Atomix): their libraries are synced in as ordinary libraries whose
  //     items carry the server's id and a `remote:` path.
  `
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('jellyfin', 'emby', 'atomix')),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    username TEXT,
    secret TEXT,
    remote_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'ok',
    status_detail TEXT,
    last_sync INTEGER,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE libraries ADD COLUMN server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
  ALTER TABLE libraries ADD COLUMN remote_id TEXT;
  ALTER TABLE items ADD COLUMN remote_id TEXT;
  CREATE INDEX items_remote ON items(library_id, remote_id);
  `,
  // 12: Plex as a connected server (servers is rebuilt so its kind CHECK allows 'plex'), servers.extra for
  //     provider state no route returns, and items.remote_updated (the server's own "last changed" time).
  `
  CREATE TABLE servers_new (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('jellyfin', 'emby', 'atomix', 'plex')),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    username TEXT,
    secret TEXT,
    remote_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'ok',
    status_detail TEXT,
    last_sync INTEGER,
    created_at INTEGER NOT NULL,
    extra TEXT
  );
  INSERT INTO servers_new (id, kind, name, url, username, secret, remote_user_id, status, status_detail, last_sync, created_at)
    SELECT id, kind, name, url, username, secret, remote_user_id, status, status_detail, last_sync, created_at FROM servers;
  DROP TABLE servers;
  ALTER TABLE servers_new RENAME TO servers;
  ALTER TABLE items ADD COLUMN remote_updated INTEGER;
  `,
  // 13: casting — the devices an admin added by address (found ones live in memory).
  `
  CREATE TABLE cast_devices (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('chromecast', 'dlna')),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 14: the lookups that run per deleted item / per deleted profile (progress cascades, session clears) get indexes.
  `
  CREATE INDEX IF NOT EXISTS progress_item ON progress(item_id);
  CREATE INDEX IF NOT EXISTS sessions_profile ON sessions(profile_id);
  `,
  // 15: Live TV — channels and programmes from live sources (plugins such as IPTV Simple), favourite channels per
  // profile, the channel groups a Kids profile may see, and each source's last refresh.
  `
  CREATE TABLE live_channels (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    number INTEGER,
    name TEXT NOT NULL,
    groups TEXT NOT NULL DEFAULT '[]',
    logo TEXT,
    radio INTEGER NOT NULL DEFAULT 0,
    guide_id TEXT,
    catchup TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, key)
  );
  CREATE INDEX live_channels_guide ON live_channels(source, guide_id);
  CREATE TABLE live_programmes (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES live_channels(id) ON DELETE CASCADE,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    description TEXT,
    categories TEXT,
    episode TEXT,
    image TEXT
  );
  CREATE INDEX live_programmes_channel_start ON live_programmes(channel_id, start);
  CREATE INDEX live_programmes_start ON live_programmes(start);
  CREATE TABLE live_favourites (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES live_channels(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, channel_id)
  );
  CREATE TABLE live_kids_groups (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    grp TEXT NOT NULL,
    PRIMARY KEY (profile_id, source, grp)
  );
  CREATE TABLE live_sources (
    id TEXT PRIMARY KEY,
    last_refresh INTEGER,
    last_ok INTEGER,
    channels INTEGER NOT NULL DEFAULT 0,
    programmes INTEGER NOT NULL DEFAULT 0,
    unmatched INTEGER NOT NULL DEFAULT 0,
    warning TEXT,
    error TEXT
  );
  `,
  // 16: Live TV — encrypted channels (Widevine/ClearKey DASH, played in the browser): the system name, NULL = plain.
  `
  ALTER TABLE live_channels ADD COLUMN drm TEXT;
  `,
  // 17: Live TV — a channel missing from a refresh is hidden (since when) and deleted after 7 days; the names of
  // channels without guide (TV and radio apart) survive a restart.
  `
  ALTER TABLE live_channels ADD COLUMN missing_since INTEGER;
  ALTER TABLE live_sources ADD COLUMN unmatched_names TEXT;
  `,
  // 18: Live TV recordings (DVR): scheduled, running and finished recordings, series rules, and the guide's repeat
  // flag ("new episodes only" skips repeats). Recordings keep their own copy of the programme's fields: programme ids
  // change on every guide refresh. part: 2 when Atomix restarted in the middle of one.
  `
  CREATE TABLE live_series_rules (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    channel_key TEXT,
    title TEXT NOT NULL,
    new_only INTEGER NOT NULL DEFAULT 1,
    keep INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE live_recordings (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    channel_key TEXT NOT NULL,
    channel_id INTEGER,
    channel_name TEXT,
    programme_id INTEGER,
    title TEXT NOT NULL,
    episode_title TEXT,
    season INTEGER,
    episode INTEGER,
    plot TEXT,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    pre INTEGER NOT NULL DEFAULT 1,
    post INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'recording', 'done', 'failed', 'cancelled')),
    error TEXT,
    gap_seconds INTEGER NOT NULL DEFAULT 0,
    path TEXT,
    item_id INTEGER,
    rule_id INTEGER REFERENCES live_series_rules(id) ON DELETE SET NULL,
    part INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX live_recordings_status ON live_recordings(status, start);
  CREATE INDEX live_recordings_rule ON live_recordings(rule_id);
  CREATE INDEX live_recordings_item ON live_recordings(item_id);
  ALTER TABLE live_programmes ADD COLUMN repeat INTEGER NOT NULL DEFAULT 0;
  `,
  // 19: play history (one row per playing; counted once a song is half heard or 4 minutes in, a film when watched),
  // each profile's stars and hearts, and smart playlists (lists is rebuilt so kind may be 'smart'; rules is the
  // stored rule set, media 'music' or 'video'). A smart list's contents are worked out when it's opened.
  `
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seconds REAL NOT NULL DEFAULT 0,
    counted INTEGER NOT NULL DEFAULT 0,
    client TEXT NOT NULL DEFAULT 'browser'
  );
  CREATE INDEX plays_open ON plays(profile_id, item_id, updated_at);
  CREATE INDEX plays_started ON plays(profile_id, started_at);
  CREATE INDEX plays_item ON plays(item_id);
  CREATE TABLE user_ratings (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    stars INTEGER CHECK (stars BETWEEN 1 AND 5),
    favourite INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  );
  CREATE INDEX user_ratings_item ON user_ratings(item_id);
  CREATE TABLE lists_new (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('watchlist', 'video', 'music', 'smart')),
    name TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    media TEXT CHECK (media IN ('music', 'video') OR media IS NULL),
    rules TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO lists_new (id, profile_id, kind, name, shared, created_at, updated_at)
    SELECT id, profile_id, kind, name, shared, created_at, updated_at FROM lists;
  DROP TABLE lists;
  ALTER TABLE lists_new RENAME TO lists;
  CREATE UNIQUE INDEX lists_watchlist ON lists(profile_id) WHERE kind = 'watchlist';
  `,
  // 20: music apps (the Subsonic API at /rest/) sign in with app passwords, one per app and profile — kept, since
  // token sign-in needs the password itself. Scrobbling: each profile's ListenBrainz/Last.fm sign-in (token or
  // session key, never sent to a browser) and the queue of listens waiting to go out.
  `
  CREATE TABLE app_passwords (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    secret TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX app_passwords_profile ON app_passwords(profile_id);
  CREATE TABLE profile_scrobblers (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    service TEXT NOT NULL CHECK (service IN ('listenbrainz', 'lastfm')),
    token TEXT,
    username TEXT,
    last_ok INTEGER,
    last_error TEXT,
    stopped INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, service)
  );
  CREATE TABLE scrobble_queue (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('now', 'listen')),
    payload TEXT NOT NULL,
    at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL
  );
  CREATE INDEX scrobble_queue_due ON scrobble_queue(next_at);
  `,
  // 21: the activity log admins read in Settings → Activity (kept 30 days). Plain sentences, never a password,
  // token or provider address; settings changes name the settings only.
  `
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    user_id INTEGER,
    profile_id INTEGER,
    text TEXT NOT NULL,
    ip TEXT
  );
  CREATE INDEX activity_at ON activity(at);
  CREATE INDEX activity_type ON activity(type, at);
  `,
  // 22: the player's audio and subtitle delay per profile and title, and hand-edited details: which fields an admin
  // edited (refresh and Fix match leave those alone), plus a studio.
  `
  CREATE TABLE play_settings (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    audio_delay REAL NOT NULL DEFAULT 0,
    subtitle_delay REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_id)
  );
  ALTER TABLE items ADD COLUMN locked_fields TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE items ADD COLUMN studio TEXT;
  `,
  // 23 — downloads (v0.21): which accounts may download (admins always), and the copies the server prepares.
  `
  ALTER TABLE users ADD COLUMN can_download INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET can_download = 1 WHERE role = 'admin';
  ALTER TABLE live_recordings ADD COLUMN work_dir TEXT;
  CREATE TABLE download_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    quality TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    file TEXT,
    size INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    fetched_at INTEGER
  );
  CREATE UNIQUE INDEX download_jobs_key ON download_jobs(item_id, quality, format);
  `,
  // 24 — Home you can arrange (v0.22): the household's arrangement (profile_id NULL, only one) and each profile's own
  // copy; the household's web apps (shortcut tiles to sites with no API).
  `
  CREATE TABLE home_layouts (
    profile_id INTEGER UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    layout TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX home_layouts_household ON home_layouts((profile_id IS NULL)) WHERE profile_id IS NULL;
  CREATE TABLE web_apps (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    image TEXT,
    kids INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  `,
  // 25 — podcasts and audiobooks (v0.22): who wrote and who reads a title, when an episode came out; each podcast's
  // feed (its address stays here, never sent to a browser) and each episode's enclosure and download state.
  `
  ALTER TABLE items ADD COLUMN author TEXT;
  ALTER TABLE items ADD COLUMN narrator TEXT;
  ALTER TABLE items ADD COLUMN published_at INTEGER;
  CREATE TABLE podcast_feeds (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    feed_url TEXT NOT NULL UNIQUE,
    etag TEXT,
    last_modified TEXT,
    checked_at INTEGER,
    error TEXT,
    error_since INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    keep_count INTEGER DEFAULT 10,
    delete_played INTEGER NOT NULL DEFAULT 1,
    explicit INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE podcast_episodes (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    enclosure_url TEXT,
    enclosure_type TEXT,
    enclosure_size INTEGER,
    kept INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new',
    error TEXT,
    explicit INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX podcast_episodes_guid ON podcast_episodes(guid);
  `,
  // 26 — books and comics (v0.22): an issue's number (as written, and to sort by), a comic's pages, a series' reading
  // direction; the place in a book (chapter and text offset) and the kind of device it was read on; pages read.
  `
  ALTER TABLE items ADD COLUMN issue TEXT;
  ALTER TABLE items ADD COLUMN issue_sort REAL;
  ALTER TABLE items ADD COLUMN page_count INTEGER;
  ALTER TABLE items ADD COLUMN reading_dir TEXT;
  ALTER TABLE progress ADD COLUMN locator TEXT;
  ALTER TABLE progress ADD COLUMN device TEXT;
  ALTER TABLE plays ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX items_series ON items(show_id, issue_sort) WHERE kind IN ('book', 'comic');
  `,
  // 27 — reading lists (v0.22): a list of books and comics. The kind's CHECK changes, so the table is rebuilt.
  `
  CREATE TABLE lists_new (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('watchlist', 'video', 'music', 'smart', 'reading')),
    name TEXT NOT NULL,
    shared INTEGER NOT NULL DEFAULT 0,
    media TEXT CHECK (media IN ('music', 'video') OR media IS NULL),
    rules TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO lists_new (id, profile_id, kind, name, shared, media, rules, created_at, updated_at)
    SELECT id, profile_id, kind, name, shared, media, rules, created_at, updated_at FROM lists;
  DROP TABLE lists;
  ALTER TABLE lists_new RENAME TO lists;
  CREATE UNIQUE INDEX lists_watchlist ON lists(profile_id) WHERE kind = 'watchlist';
  `,
  // 28 — outside scores (v0.23): a metadata plugin's IMDb, Rotten Tomatoes and Metacritic scores, as JSON
  // [{ source, value }].
  `
  ALTER TABLE items ADD COLUMN scores TEXT;
  `,
  // 29 — search (v0.24): each title's search key (src/library/searchkey.js; filled here for existing titles, NULL for
  // new or renamed ones until the next search fills it) and each profile's recent searches.
  `
  ALTER TABLE items ADD COLUMN search_key TEXT;
  UPDATE items SET search_key = atomix_key(title) || '|' || COALESCE(atomix_key(original_title), '');
  CREATE INDEX items_search_key_missing ON items(id) WHERE search_key IS NULL;
  CREATE TRIGGER items_search_key_reset AFTER UPDATE OF title, original_title ON items
    WHEN OLD.title IS NOT NEW.title OR OLD.original_title IS NOT NEW.original_title
    BEGIN UPDATE items SET search_key = NULL WHERE id = NEW.id; END;
  CREATE TABLE search_history (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX search_history_profile ON search_history(profile_id, created_at DESC);
  `,
  // 30 — skipping more (v0.28): markers can be recaps too, and come from TheIntroDB's shared timestamps.
  `
  CREATE TABLE markers_new (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('intro', 'credits', 'recap')),
    start_time REAL,
    end_time REAL,
    source TEXT NOT NULL CHECK (source IN ('chapter', 'audio', 'manual', 'community')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, kind)
  );
  INSERT INTO markers_new SELECT item_id, kind, start_time, end_time, source, updated_at FROM markers;
  DROP TABLE markers;
  ALTER TABLE markers_new RENAME TO markers;
  `,
  // 31 — several key systems and provider-app links (v0.28): live_channels.drm now holds a comma list; app_url/app_name
  // are the playlist's link (rewritten by every refresh); admin_app_url/admin_app_name are an admin's (set only by the PUT).
  `
  ALTER TABLE live_channels ADD COLUMN app_url TEXT;
  ALTER TABLE live_channels ADD COLUMN app_name TEXT;
  ALTER TABLE live_channels ADD COLUMN admin_app_url TEXT;
  ALTER TABLE live_channels ADD COLUMN admin_app_name TEXT;
  `,
  // 32 — card motion v2 (v0.28): media_jobs is rebuilt so it can also record the 'clip' job (a 5 s preview clip per title).
  `
  CREATE TABLE media_jobs_new (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    job TEXT NOT NULL CHECK (job IN ('previews', 'intros', 'thumb', 'clip')),
    status TEXT NOT NULL CHECK (status IN ('done', 'none', 'failed')),
    data TEXT,
    error TEXT,
    source_size INTEGER,
    source_mtime INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, job)
  );
  INSERT INTO media_jobs_new SELECT item_id, job, status, data, error, source_size, source_mtime, updated_at FROM media_jobs;
  DROP TABLE media_jobs;
  ALTER TABLE media_jobs_new RENAME TO media_jobs;
  `,
  // 33 — card motion v2 (v0.28): the dominant colours of a title's artwork, JSON { poster, backdrop } (src/library/colors.js).
  `
  ALTER TABLE items ADD COLUMN colors TEXT;
  `,
  // 34 — the Jellyfin-compatible API (src/jellyfin/): one sign-in token per device, kept as a sha256 and tied to an
  // app password, so revoking the password ends its tokens.
  `
  CREATE TABLE jellyfin_tokens (
    id INTEGER PRIMARY KEY,
    app_password_id INTEGER NOT NULL REFERENCES app_passwords(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    device_id TEXT,
    device_name TEXT,
    client TEXT,
    version TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX jellyfin_tokens_app_password ON jellyfin_tokens(app_password_id);
  `,
];

/**
 * @param {string} file
 * @param {{upTo?: number}} [opts] upTo: stop after this migration (used by tests)
 */
export function openDatabase(file, { upTo = MIGRATIONS.length } = {}) {
  const DatabaseSync = sqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  registerSearchKey(db); // atomix_key() for searches (v0.24)

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

/** node:sqlite's DatabaseSync. It still prints an ExperimentalWarning on Node 22/24; this hides just that one. */
function sqlite() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (text && /SQLite/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
}

/**
 * Opens and closes a database file without changing it. When nothing else has it open,
 * closing folds its write-ahead log into the main file and removes the -wal file.
 */
export function settleDatabase(file) {
  const DatabaseSync = sqlite();
  const db = new DatabaseSync(file);
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } finally {
    db.close();
  }
}

export function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
