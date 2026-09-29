// The Arctic look replaced Midnight as the default. A server default of Midnight moves
// over (saving Settings → Server always stored it); themes people picked themselves stay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';

test('upgrading moves the old default theme to the new one', () => {
  const file = path.join(tempDir(), 'v3.db');
  const old = openDatabase(file, { upTo: 3 });
  old.run(`INSERT INTO settings (key, value) VALUES ('defaultTheme', '"midnight"'), ('serverName', '"Home"')`);
  old.run(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (1, 'u', 'x', 'admin', 1)`);
  old.run(`INSERT INTO profiles (id, user_id, name, is_primary, created_at, prefs) VALUES
    (1, 1, 'A', 1, 1, '{"theme":"midnight","accent":"#ff0000"}'),
    (2, 1, 'B', 0, 1, '{"theme":"harbour"}'),
    (3, 1, 'C', 0, 1, '{}'),
    (4, 1, 'D', 0, 1, 'not json')`);
  old.close();

  const db = openDatabase(file);
  assert.equal(JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'defaultTheme'`).value), 'arctic');
  assert.equal(JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'serverName'`).value), 'Home');
  const prefs = Object.fromEntries(db.all('SELECT id, prefs FROM profiles WHERE id < 4').map((r) => [r.id, JSON.parse(r.prefs)]));
  assert.deepEqual(prefs[1], { theme: 'midnight', accent: '#ff0000' }, 'someone who chose Midnight keeps it');
  assert.deepEqual(prefs[2], { theme: 'harbour' }, 'other choices are left alone');
  assert.deepEqual(prefs[3], {});
  assert.equal(db.get('SELECT prefs FROM profiles WHERE id = 4').prefs, 'not json', 'broken prefs are left as they were');
  db.close();
});

test('a server that picked another default theme keeps it', () => {
  const file = path.join(tempDir(), 'v3b.db');
  const old = openDatabase(file, { upTo: 3 });
  old.run(`INSERT INTO settings (key, value) VALUES ('defaultTheme', '"daylight"')`);
  old.close();
  const db = openDatabase(file);
  assert.equal(JSON.parse(db.get(`SELECT value FROM settings WHERE key = 'defaultTheme'`).value), 'daylight');
  db.close();
});
