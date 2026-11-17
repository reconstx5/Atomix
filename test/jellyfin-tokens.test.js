// Jellyfin API: ids (GUIDs), the token store on top of app passwords, token/client header reading, migration 34.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { AppPasswords } from '../src/subsonic/apppasswords.js';
import { toGuid, fromGuid } from '../src/jellyfin/ids.js';
import { JellyfinTokens, readToken, readClient } from '../src/jellyfin/tokens.js';
import { SETTING_DEFAULTS } from '../src/settings.js';

let db, appPasswords, tokens, pw;

before(() => {
  db = openDatabase(path.join(tempDir(), 'jf.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('d', 'Dallas', 'x', 'admin', 0)");
  db.run("INSERT INTO profiles (user_id, name, avatar, is_primary, created_at) VALUES (1, 'dallas', 'blue', 1, 0)");
  appPasswords = new AppPasswords({ db });
  tokens = new JellyfinTokens({ db });
  pw = appPasswords.create(1, 'Infuse');
});

const meta = (extra = {}) => ({ appPasswordId: pw.id, deviceId: 'dev1', deviceName: 'Apple TV', client: 'Infuse', version: '8', ...extra });

test('guids round trip', () => {
  assert.deepEqual(fromGuid(toGuid('item', 42)), { kind: 'item', id: 42 });
  assert.match(toGuid('item', 42), /^[0-9a-f]{32}$/);
  const dashed = toGuid('item', 42).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toUpperCase();
  assert.deepEqual(fromGuid(dashed), { kind: 'item', id: 42 });
  assert.equal(fromGuid('nope'), null);
  assert.equal(fromGuid('0'.repeat(32)), null);
  assert.equal(fromGuid(toGuid('item', 42).slice(1)), null);
  for (const [k, n] of [['library', 2], ['user', 3], ['server', 5]]) assert.deepEqual(fromGuid(toGuid(k, 7)), { kind: k, id: 7 }, `${k}${n}`);
  const p = toGuid('person', 'a2b3c4d5e6f70811');
  assert.deepEqual(fromGuid(p), { kind: 'person', id: 'a2b3c4d5e6f70811' });
});

test('a token is issued, checked and stored hashed', () => {
  const t = tokens.issue(meta());
  assert.match(t, /^[0-9a-f]{64}$/);
  const got = tokens.check(t);
  assert.equal(got.profile.id, 1);
  assert.equal(got.user.id, 1);
  assert.equal(got.appPassword.id, pw.id);
  assert.ok(got.tokenRow.id);
  assert.notEqual(db.get('SELECT token_hash FROM jellyfin_tokens WHERE id = ?', got.tokenRow.id).token_hash, t);
  assert.equal(tokens.check('0'.repeat(64)), null);
  assert.equal(tokens.check(''), null);
});

test('logout ends one token only', () => {
  const a = tokens.issue(meta({ deviceId: 'a' }));
  const b = tokens.issue(meta({ deviceId: 'b' }));
  tokens.logout(a);
  assert.equal(tokens.check(a), null);
  assert.ok(tokens.check(b));
});

test('revoking the app password ends its tokens', () => {
  const p2 = appPasswords.create(1, 'Other');
  const t = tokens.issue(meta({ appPasswordId: p2.id }));
  assert.ok(tokens.check(t));
  appPasswords.revoke(1, p2.id);
  assert.equal(tokens.check(t), null);
});

test('readToken reads every form', () => {
  const hdr = (h) => ({ headers: h });
  const url = (s) => new URL(s, 'http://x');
  assert.equal(readToken(hdr({ 'x-emby-token': 'abc' }), url('/')), 'abc');
  assert.equal(readToken(hdr({ 'x-mediabrowser-token': 'abc' }), url('/')), 'abc');
  assert.equal(readToken(hdr({ authorization: 'MediaBrowser Client="Infuse", Token="abc"' }), url('/')), 'abc');
  assert.equal(readToken(hdr({ 'x-emby-authorization': 'MediaBrowser Client="Infuse", Device="TV", Token="abc"' }), url('/')), 'abc');
  assert.equal(readToken(hdr({}), url('/x?api_key=abc')), 'abc');
  assert.equal(readToken(hdr({}), url('/x?ApiKey=abc')), 'abc');
  assert.equal(readToken(hdr({}), url('/x')), null);
});

test('readClient reads the MediaBrowser header', () => {
  const c = readClient({ headers: { 'x-emby-authorization': 'MediaBrowser Client="Infuse", Device="Apple TV", DeviceId="d1", Version="8.1"' } });
  assert.deepEqual(c, { client: 'Infuse', device: 'Apple TV', deviceId: 'd1', version: '8.1' });
});

test('migration 34 runs on an existing database and the setting default exists', () => {
  const file = path.join(tempDir(), 'm.db');
  openDatabase(file, { upTo: 33 }).close?.();
  const d = openDatabase(file);
  assert.ok(d.get("SELECT name FROM sqlite_master WHERE name = 'jellyfin_tokens'"));
  assert.equal(SETTING_DEFAULTS.jellyfinServerId, '');
});
