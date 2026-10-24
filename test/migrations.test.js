// Migration 9: the tables and columns for collections, playlists and the Watchlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase, MIGRATIONS } from '../src/db.js';

test('migration 9 adds lists, collections and the keyword/people columns', () => {
  const db = openDatabase(path.join(tempDir(), 'm.db'));
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  for (const t of ['collections', 'collection_items', 'lists', 'list_items']) assert.ok(tables.includes(t), t);
  const cols = db.all('PRAGMA table_info(items)').map((c) => c.name);
  assert.ok(cols.includes('keywords') && cols.includes('people'));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'lists_watchlist'").n, 1);
  assert.ok(MIGRATIONS.length >= 9);
});

test('a profile has at most one Watchlist', () => {
  const db = openDatabase(path.join(tempDir(), 'w.db'));
  const now = Date.now();
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', ?)", now);
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, ?)", now);
  db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'watchlist', 'Watchlist', ?, ?)", now, now);
  assert.throws(() => db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'watchlist', 'Watchlist', ?, ?)", now, now), /UNIQUE/);
  db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'video', 'Friday', ?, ?)", now, now);
});

test('migration 10 adds extra_kind, trailer and the lyrics table', () => {
  const db = openDatabase(path.join(tempDir(), 'm10.db'));
  const cols = db.all('PRAGMA table_info(items)').map((c) => c.name);
  assert.ok(cols.includes('extra_kind') && cols.includes('trailer'));
  const lyr = db.all('PRAGMA table_info(lyrics)').map((c) => c.name);
  assert.deepEqual(lyr, ['item_id', 'source', 'synced', 'text', 'file_mtime', 'fetched_at']);
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  assert.ok(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_extras'").length === 1);
  // A database that was at 9 (with the old media_jobs) gets the rebuilt table that records 'thumb' jobs.
  const file = path.join(tempDir(), 'm9to10.db');
  openDatabase(file, { upTo: 9 }).close();
  const up = openDatabase(file);
  assert.match(up.get("SELECT sql FROM sqlite_master WHERE name = 'media_jobs'").sql, /'thumb'/);
  up.close();
});

test('migration 11 adds servers, libraries.server_id/remote_id, items.remote_id', () => {
  const db = openDatabase(path.join(tempDir(), 'm11.db'), { upTo: 11 });
  assert.deepEqual(db.all('PRAGMA table_info(servers)').map((c) => c.name), ['id', 'kind', 'name', 'url', 'username', 'secret', 'remote_user_id', 'status', 'status_detail', 'last_sync', 'created_at']);
  const libs = db.all('PRAGMA table_info(libraries)').map((c) => c.name);
  assert.ok(libs.includes('server_id') && libs.includes('remote_id'));
  assert.ok(db.all('PRAGMA table_info(items)').map((c) => c.name).includes('remote_id'));
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_remote'").length, 1);
  assert.equal(db.get('PRAGMA user_version').user_version, 11);
});

test('migration 12 lets servers be plex, adds servers.extra and items.remote_updated, and keeps existing rows', () => {
  const file = path.join(tempDir(), 'm12.db');
  const old = openDatabase(file, { upTo: 11 });
  old.run("INSERT INTO servers (id, kind, name, url, username, secret, remote_user_id, created_at) VALUES (5, 'jellyfin', 'JF', 'http://jf', 'd', 'tok', 'u1', 1)");
  old.run("INSERT INTO libraries (id, name, type, paths, options, created_at, server_id, remote_id) VALUES (9, 'Movies', 'movies', '[]', '{}', 1, 5, 'lib-m')");
  old.close();
  const db = openDatabase(file);
  const row = { ...db.get('SELECT * FROM servers WHERE id = 5') };
  assert.deepEqual([row.kind, row.name, row.url, row.secret, row.remote_user_id, row.status], ['jellyfin', 'JF', 'http://jf', 'tok', 'u1', 'ok']);
  assert.ok('extra' in row);
  assert.equal(row.extra, null);
  db.run("INSERT INTO servers (kind, name, url, created_at) VALUES ('plex', 'Dev Plex', 'http://p', 1)");
  assert.ok(db.all('PRAGMA table_info(items)').map((c) => c.name).includes('remote_updated'));
  assert.equal(db.get('SELECT server_id FROM libraries WHERE id = 9').server_id, 5);
  db.run('DELETE FROM servers WHERE id = 5');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM libraries WHERE id = 9').n, 0, 'the cascade still works after the rebuild');
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
});

test('migration 13 adds cast_devices', () => {
  const db = openDatabase(path.join(tempDir(), 'm13.db'));
  assert.deepEqual(db.all('PRAGMA table_info(cast_devices)').map((c) => c.name), ['id', 'kind', 'name', 'address', 'created_at']);
  db.run("INSERT INTO cast_devices (kind, name, address, created_at) VALUES ('chromecast', 'TV', '192.168.1.5:8009', 1)");
  assert.throws(() => db.run("INSERT INTO cast_devices (kind, name, address, created_at) VALUES ('roku', 'x', 'y', 1)"));
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
});

test('migration 16 adds live_channels.drm to an existing Live TV database', () => {
  const file = path.join(tempDir(), 'm16.db');
  const old = openDatabase(file, { upTo: 15 });
  old.run("INSERT INTO live_channels (source, key, number, name, groups, radio, sort, updated_at) VALUES ('s/p', 'k', 1, 'One', '[]', 0, 0, 1)");
  old.close?.();
  const db = openDatabase(file);
  assert.ok(db.all('PRAGMA table_info(live_channels)').some((c) => c.name === 'drm'));
  assert.equal(db.get("SELECT drm FROM live_channels WHERE key = 'k'").drm, null, 'existing channels stay plain');
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
});

test('migration 17 adds live_channels.missing_since and live_sources.unmatched_names', () => {
  const file = path.join(tempDir(), 'm17.db');
  const old = openDatabase(file, { upTo: 16 });
  old.close?.();
  const db = openDatabase(file);
  assert.ok(db.all('PRAGMA table_info(live_channels)').some((c) => c.name === 'missing_since'));
  assert.ok(db.all('PRAGMA table_info(live_sources)').some((c) => c.name === 'unmatched_names'));
});

test('migration 18 adds live_recordings, live_series_rules and live_programmes.repeat', () => {
  const file = path.join(tempDir(), 'm18.db');
  const old = openDatabase(file, { upTo: 17 });
  old.close?.();
  const db = openDatabase(file);
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
  for (const c of ['id', 'profile_id', 'source', 'channel_key', 'channel_id', 'programme_id', 'title', 'episode_title', 'season', 'episode', 'plot', 'start', 'end', 'pre', 'post', 'status', 'error', 'gap_seconds', 'path', 'item_id', 'rule_id', 'created_at']) {
    assert.ok(cols('live_recordings').includes(c), c);
  }
  for (const c of ['id', 'profile_id', 'source', 'channel_key', 'title', 'new_only', 'keep', 'created_at']) assert.ok(cols('live_series_rules').includes(c), c);
  assert.ok(cols('live_programmes').includes('repeat'));
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
});

test('migration 19 adds plays and user_ratings, and lets lists be smart (keeping existing lists)', () => {
  const file = path.join(tempDir(), 'm19.db');
  const old = openDatabase(file, { upTo: 18 });
  const now = Date.now();
  old.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', ?)", now);
  old.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, ?)", now);
  old.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'Movies', 'movies', '[]', '{}', 1)");
  for (const id of [1, 2]) old.run("INSERT INTO items (id, library_id, kind, title, added_at, updated_at) VALUES (?, 1, 'movie', ?, 1, 1)", id, `M${id}`);
  old.run("INSERT INTO lists (id, profile_id, kind, name, shared, created_at, updated_at) VALUES (1, 1, 'watchlist', 'Watchlist', 0, ?, ?)", now, now);
  old.run("INSERT INTO lists (id, profile_id, kind, name, shared, created_at, updated_at) VALUES (2, 1, 'video', 'Friday', 1, ?, ?)", now, now);
  old.run('INSERT INTO list_items (list_id, item_id, position, added_at) VALUES (2, 1, 0, 1), (2, 2, 1, 1), (1, 2, 0, 1)');
  old.close();
  const db = openDatabase(file);
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  assert.deepEqual(db.all('SELECT id, kind, name, shared FROM lists ORDER BY id').map((r) => ({ ...r })), [
    { id: 1, kind: 'watchlist', name: 'Watchlist', shared: 0 },
    { id: 2, kind: 'video', name: 'Friday', shared: 1 },
  ]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM list_items').n, 3);
  db.run("INSERT INTO lists (profile_id, kind, name, media, rules, created_at, updated_at) VALUES (1, 'smart', 'Top', 'music', '{}', ?, ?)", now, now);
  assert.throws(() => db.run("INSERT INTO lists (profile_id, kind, name, media, created_at, updated_at) VALUES (1, 'smart', 'Bad', 'x', ?, ?)", now, now), /CHECK/);
  assert.throws(() => db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'watchlist', 'Watchlist', ?, ?)", now, now), /UNIQUE/);
  assert.deepEqual(db.all('PRAGMA table_info(plays)').map((c) => c.name).slice(0, 8), ['id', 'profile_id', 'item_id', 'started_at', 'updated_at', 'seconds', 'counted', 'client']); // (later migrations add more)
  assert.deepEqual(db.all('PRAGMA table_info(user_ratings)').map((c) => c.name), ['profile_id', 'item_id', 'stars', 'favourite', 'updated_at']);
  assert.throws(() => db.run('INSERT INTO user_ratings (profile_id, item_id, stars, favourite, updated_at) VALUES (1, 1, 6, 0, 1)'), /CHECK/);
  // Deleting the item takes its plays and ratings with it.
  db.run("INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (1, 1, 1, 1, 0, 0, 'browser')");
  db.run('INSERT INTO user_ratings (profile_id, item_id, stars, favourite, updated_at) VALUES (1, 1, 4, 1, 1)');
  db.run('DELETE FROM items WHERE id = 1');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM plays').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM user_ratings').n, 0);
  db.close();
});

test('migration 20 adds app passwords, scrobblers and the scrobble queue (going with their profile)', () => {
  const db = openDatabase(path.join(tempDir(), 'm20.db'));
  assert.deepEqual(db.all('PRAGMA table_info(app_passwords)').map((c) => c.name), ['id', 'profile_id', 'name', 'secret', 'created_at', 'last_used_at', 'revoked']);
  assert.deepEqual(db.all('PRAGMA table_info(profile_scrobblers)').map((c) => c.name), ['profile_id', 'service', 'token', 'username', 'last_ok', 'last_error', 'stopped']);
  assert.deepEqual(db.all('PRAGMA table_info(scrobble_queue)').map((c) => c.name), ['id', 'profile_id', 'service', 'kind', 'payload', 'at', 'tries', 'next_at']);
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', 1)");
  db.run("INSERT INTO profiles (id, user_id, name, avatar, is_primary, created_at) VALUES (7, 1, 'A', 'blue', 1, 1)");
  db.run("INSERT INTO app_passwords (profile_id, name, secret, created_at) VALUES (7, 'Phone', 'abc', 1)");
  assert.throws(() => db.run("INSERT INTO app_passwords (profile_id, name, secret, created_at) VALUES (7, 'Again', 'abc', 1)"), /UNIQUE/);
  db.run("INSERT INTO profile_scrobblers (profile_id, service, token) VALUES (7, 'listenbrainz', 't')");
  assert.throws(() => db.run("INSERT INTO profile_scrobblers (profile_id, service, token) VALUES (7, 'myspace', 't')"), /CHECK/);
  db.run("INSERT INTO scrobble_queue (profile_id, service, kind, payload, at, tries, next_at) VALUES (7, 'listenbrainz', 'listen', '{}', 1, 0, 1)");
  db.run('DELETE FROM profiles WHERE id = 7');
  for (const t of ['app_passwords', 'profile_scrobblers', 'scrobble_queue']) assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${t}`).n, 0, t);
  db.close();
});

test('migration 21 adds the activity log', () => {
  const db = openDatabase(path.join(tempDir(), 'm21.db'));
  assert.deepEqual(db.all('PRAGMA table_info(activity)').map((c) => c.name), ['id', 'at', 'type', 'user_id', 'profile_id', 'text', 'ip']);
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'activity'").length, 2);
  db.close();
});

test('migration 22 adds play settings, locked fields and studio', () => {
  const db = openDatabase(path.join(tempDir(), 'm22.db'));
  assert.deepEqual(db.all('PRAGMA table_info(play_settings)').map((c) => c.name), ['profile_id', 'item_id', 'audio_delay', 'subtitle_delay', 'updated_at']);
  const cols = db.all('PRAGMA table_info(items)').map((c) => c.name);
  assert.ok(cols.includes('locked_fields') && cols.includes('studio'));
  db.close();
});

test('migration 23 adds downloads: an account switch (on for admins) and the jobs table', () => {
  const file = path.join(tempDir(), 'm23.db');
  const old = openDatabase(file, { upTo: 22 });
  old.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('boss', 'boss', 'x', 'admin', 1), ('kid', 'kid', 'x', 'user', 1)");
  old.close();
  const db = openDatabase(file);
  assert.equal(db.get("SELECT can_download FROM users WHERE username = 'boss'").can_download, 1);
  assert.equal(db.get("SELECT can_download FROM users WHERE username = 'kid'").can_download, 0);
  assert.deepEqual(db.all('PRAGMA table_info(download_jobs)').map((c) => c.name), ['id', 'item_id', 'quality', 'format', 'status', 'progress', 'file', 'size', 'error', 'created_at', 'used_at', 'fetched_at']);
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'M', 'movies', '[]', '{}', 1)");
  db.run("INSERT INTO items (id, library_id, kind, title, added_at, updated_at) VALUES (1, 1, 'movie', 'F', 1, 1)");
  db.run("INSERT INTO download_jobs (item_id, quality, format, status, created_at, used_at) VALUES (1, '720', 'mp4', 'queued', 1, 1)");
  assert.throws(() => db.run("INSERT INTO download_jobs (item_id, quality, format, status, created_at, used_at) VALUES (1, '720', 'mp4', 'queued', 1, 1)"), /UNIQUE/);
  db.run('DELETE FROM items WHERE id = 1');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM download_jobs').n, 0);
  assert.ok(db.all('PRAGMA table_info(live_recordings)').some((c) => c.name === 'work_dir'), 'v0.21: a recording keeps its work folder');
  db.close();
});

test('migration 24 adds the Home arrangements (one household row) and web apps', () => {
  const file = path.join(tempDir(), 'm24.db');
  openDatabase(file, { upTo: 23 }).close();
  const db = openDatabase(file);
  assert.deepEqual(db.all('PRAGMA table_info(home_layouts)').map((c) => c.name), ['profile_id', 'layout', 'updated_at']);
  assert.deepEqual(db.all('PRAGMA table_info(web_apps)').map((c) => c.name), ['id', 'name', 'url', 'image', 'kids', 'position', 'created_at']);
  db.run("INSERT INTO home_layouts (profile_id, layout, updated_at) VALUES (NULL, '{}', 1)");
  assert.throws(() => db.run("INSERT INTO home_layouts (profile_id, layout, updated_at) VALUES (NULL, '{}', 2)"), /UNIQUE/, 'one household arrangement');
  db.close();
});

test('migration 25 adds podcasts (feeds, episodes) and the spoken-word fields', () => {
  const file = path.join(tempDir(), 'm25.db');
  openDatabase(file, { upTo: 24 }).close();
  const db = openDatabase(file);
  const cols = db.all('PRAGMA table_info(items)').map((c) => c.name);
  for (const c of ['author', 'narrator', 'published_at']) assert.ok(cols.includes(c), c);
  assert.ok(db.all('PRAGMA table_info(podcast_feeds)').some((c) => c.name === 'keep_count'));
  assert.ok(db.all('PRAGMA table_info(podcast_episodes)').some((c) => c.name === 'enclosure_url'));
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'P', 'podcasts', '[]', '{}', 1)");
  db.run("INSERT INTO items (id, library_id, kind, title, added_at, updated_at) VALUES (1, 1, 'podcast', 'Show', 1, 1)");
  db.run("INSERT INTO podcast_feeds (item_id, feed_url) VALUES (1, 'https://example.com/feed')");
  db.run('DELETE FROM items WHERE id = 1');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM podcast_feeds').n, 0, 'cascades');
  db.close();
});

test('migration 26 adds the reading fields (issue, pages, direction, the place in a book, pages read)', () => {
  const file = path.join(tempDir(), 'm26.db');
  openDatabase(file, { upTo: 25 }).close();
  const db = openDatabase(file);
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
  for (const c of ['issue', 'issue_sort', 'page_count', 'reading_dir']) assert.ok(cols('items').includes(c), c);
  for (const c of ['locator', 'device']) assert.ok(cols('progress').includes(c), c);
  assert.ok(cols('plays').includes('pages'));
  db.close();
});

test('migration 27 lets a list be a reading list, keeping existing lists and their titles', () => {
  const file = path.join(tempDir(), 'm27.db');
  const old = openDatabase(file, { upTo: 26 });
  const now = Date.now();
  old.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', ?)", now);
  old.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'A', 'blue', 1, ?)", now);
  old.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'Movies', 'movies', '[]', '{}', 1)");
  old.run("INSERT INTO items (id, library_id, kind, title, added_at, updated_at) VALUES (1, 1, 'movie', 'M', 1, 1)");
  old.run("INSERT INTO lists (id, profile_id, kind, name, media, rules, shared, created_at, updated_at) VALUES (5, 1, 'smart', 'Top', 'music', '{\"a\":1}', 1, ?, ?)", now, now);
  old.run("INSERT INTO lists (id, profile_id, kind, name, shared, created_at, updated_at) VALUES (6, 1, 'video', 'Friday', 0, ?, ?)", now, now);
  old.run('INSERT INTO list_items (list_id, item_id, position, added_at) VALUES (6, 1, 0, 1)');
  assert.throws(() => old.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'reading', 'R', 1, 1)"), /CHECK/);
  old.close();
  const db = openDatabase(file);
  assert.deepEqual(db.all('SELECT id, kind, media, rules, shared FROM lists ORDER BY id').map((r) => ({ ...r })), [
    { id: 5, kind: 'smart', media: 'music', rules: '{"a":1}', shared: 1 },
    { id: 6, kind: 'video', media: null, rules: null, shared: 0 },
  ]);
  db.run("INSERT INTO lists (profile_id, kind, name, created_at, updated_at) VALUES (1, 'reading', 'To read', 1, 1)");
  db.run('DELETE FROM lists WHERE id = 6');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM list_items').n, 0, 'its titles go with it');
  db.close();
});

test('migration 28 adds items.scores', () => {
  const file = path.join(tempDir(), 'm28.db');
  openDatabase(file, { upTo: 27 }).close();
  const db = openDatabase(file);
  assert.ok(db.all('PRAGMA table_info(items)').map((c) => c.name).includes('scores'));
  db.close();
});
