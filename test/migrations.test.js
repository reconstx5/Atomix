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
