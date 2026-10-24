// Music apps: app passwords (shown once, listed, revoked), every Subsonic sign-in (u+p, enc:, u+t+s, apiKey), the
// envelope in XML/JSON/JSONP, GET and form POST, and the sign-in lockout shared with the web.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeAudio, startAtomix, client, waitForScan } from './helpers.js';
import { rest, tokenAuth } from './helpers-subsonic.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf;
let admin;
let kid;
let secret;
let kidSecret;
let musicId;

before(async () => {
  if (!hasFfmpeg) return;
  makeAudio(path.join(media, 'Music', 'The Band', 'First Record', '01 Opening.mp3'), { tags: { title: 'Opening', artist: 'The Band', album: 'First Record', track: '1/1' } });
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  musicId = (await admin.post('/api/libraries', { name: 'Music', type: 'music', paths: [path.join(media, 'Music')] })).data.id;
  await waitForScan(admin);
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
});

after(async () => {
  await nf?.app.stop();
});

const ok = (r) => assert.equal(r.body?.status, 'ok', JSON.stringify(r.body || r.text));
const failed = (r, code) => {
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.error.code, code, JSON.stringify(r.body.error));
  return r.body.error.message;
};

test('an app password is shown once and listed', { skip }, async () => {
  const made = await admin.post('/api/me/app-passwords', { name: 'Phone' });
  assert.equal(made.status, 200);
  assert.match(made.data.secret, /^[A-Za-z0-9]{24}$/);
  assert.equal(made.data.username, 'dallas');
  assert.equal(made.data.name, 'Phone');
  assert.match(made.data.server, /^http:\/\/127\.0\.0\.1:\d+$/);
  secret = made.data.secret;
  const list = (await admin.get('/api/me/app-passwords')).data;
  assert.deepEqual(list.map((p) => p.name), ['Phone']);
  assert.ok(!JSON.stringify(list).includes(secret), 'the secret is never listed');
  assert.equal(list[0].lastUsedAt, null);
  assert.deepEqual((await kid.get('/api/me/app-passwords')).data, [], "another profile's list is its own");
  assert.equal((await admin.post('/api/me/app-passwords', { name: '  ' })).data.error, "Give it a name, like the app's.");
  for (let i = 0; i < 19; i++) await admin.post('/api/me/app-passwords', { name: `App ${i}` });
  const over = await admin.post('/api/me/app-passwords', { name: 'One too many' });
  assert.equal(over.status, 400);
  assert.equal(over.data.error, 'A profile can have 20 app passwords. Revoke one first.');
  for (const p of (await admin.get('/api/me/app-passwords')).data) if (p.name.startsWith('App ')) await admin.del(`/api/me/app-passwords/${p.id}`);
  kidSecret = (await kid.post('/api/me/app-passwords', { name: 'Tablet' })).data.secret;
});

test('every way of signing in', { skip }, async () => {
  ok(await rest(nf.base, 'ping', { u: 'dallas', p: secret }));
  ok(await rest(nf.base, 'ping', { u: 'dallas', p: `enc:${Buffer.from(secret).toString('hex')}` }));
  ok(await rest(nf.base, 'ping', tokenAuth('dallas', secret)));
  ok(await rest(nf.base, 'ping', { apiKey: secret }));
  ok(await rest(nf.base, 'ping', tokenAuth('dallas', kidSecret)), "the kid's password signs in as the kid");
  assert.equal(failed(await rest(nf.base, 'ping', { ...tokenAuth('dallas', secret), t: '0'.repeat(32) }), 40), 'Wrong username or password.');
  failed(await rest(nf.base, 'ping', tokenAuth('nobody', secret)), 40);
  assert.equal(failed(await rest(nf.base, 'ping', {}), 10), 'Required parameter is missing: u');
  assert.equal(failed(await rest(nf.base, 'ping', { apiKey: secret, u: 'dallas' }), 43), 'Use either an API key or a username, not both.');
  assert.equal(failed(await rest(nf.base, 'ping', { apiKey: 'x'.repeat(24) }), 44), "That API key isn't valid.");
  failed(await rest(nf.base, 'ping', { u: 'dallas', p: 'password123' }), 40); // only app passwords sign in
  nf.app.core.auth.attempts.clear();
});

test('revoked passwords stop at once', { skip }, async () => {
  const made = (await admin.post('/api/me/app-passwords', { name: 'Old phone' })).data;
  ok(await rest(nf.base, 'ping', tokenAuth('dallas', made.secret)));
  const listed = (await admin.get('/api/me/app-passwords')).data.find((p) => p.id === made.id);
  assert.ok(listed.lastUsedAt > Date.now() - 60_000, 'a successful call marks it used');
  assert.equal((await admin.del(`/api/me/app-passwords/${made.id}`)).status, 204);
  failed(await rest(nf.base, 'ping', tokenAuth('dallas', made.secret)), 40);
  failed(await rest(nf.base, 'ping', { apiKey: made.secret }), 44);
  assert.equal((await kid.del(`/api/me/app-passwords/${(await admin.get('/api/me/app-passwords')).data[0].id}`)).status, 404, "a profile can't revoke another's");
  nf.app.core.auth.attempts.clear();
});

test('the envelope in xml, json and jsonp', { skip }, async () => {
  const x = await rest(nf.base, 'ping', { u: 'dallas', p: secret }, { f: null });
  assert.match(x.type, /^text\/xml/);
  assert.equal(x.text, `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="atomix" serverVersion="${nf.app.core.version}" openSubsonic="true"/>`);
  const j = await rest(nf.base, 'ping', { u: 'dallas', p: secret });
  assert.match(j.type, /^application\/json/);
  assert.deepEqual(j.body, { status: 'ok', version: '1.16.1', type: 'atomix', serverVersion: nf.app.core.version, openSubsonic: true });
  const p = await rest(nf.base, 'ping', { u: 'dallas', p: secret, callback: 'cb' }, { f: 'jsonp' });
  assert.match(p.type, /^application\/javascript/);
  assert.match(p.text, /^cb\(\{"subsonic-response":\{"status":"ok"/);
  assert.ok(p.text.endsWith(');'));
  const bad = await rest(nf.base, 'ping', { u: 'dallas', p: secret, callback: 'a(b)' }, { f: 'jsonp' });
  assert.match(bad.type, /^application\/json/);
  const e = await rest(nf.base, 'ping', { u: 'dallas', p: 'wrong' }, { f: 'xml' });
  assert.equal(e.status, 200);
  assert.match(e.text, /<subsonic-response [^>]*status="failed"[^>]*><error code="40" message="Wrong username or password."\/><\/subsonic-response>$/);
  nf.app.core.auth.attempts.clear();
});

test('methods as GET and form POST, with or without .view', { skip }, async () => {
  ok(await rest(nf.base, 'ping', { u: 'dallas', p: secret }, { view: false }));
  ok(await rest(nf.base, 'ping', { u: 'dallas', p: secret }, { post: true }));
  const json = await fetch(`${nf.base}/rest/ping.view?f=json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u: 'dallas', p: secret }) });
  assert.equal((await json.json())['subsonic-response'].error.code, 10, 'a JSON body is not read for params');
});

test('unknown methods say so', { skip }, async () => {
  // v0.22: podcasts are read-only to music apps — subscribing stays in Atomix.
  assert.equal(failed(await rest(nf.base, 'createPodcastChannel', { u: 'dallas', p: secret, url: 'https://example.com/feed' }), 0), 'Not supported in Atomix');
  const ext = await rest(nf.base, 'getOpenSubsonicExtensions', {});
  ok(ext);
  assert.deepEqual(ext.body.openSubsonicExtensions.map((x) => x.name).sort(), ['apiKeyAuthentication', 'formPost', 'songLyrics', 'transcodeOffset']);
  assert.deepEqual(ext.body.openSubsonicExtensions[0].versions, [1]);
});

test('getUser and getLicense', { skip }, async () => {
  const u = await rest(nf.base, 'getUser', { u: 'dallas', p: secret, username: 'dallas' });
  ok(u);
  assert.equal(u.body.user.username, 'dallas');
  assert.equal(u.body.user.adminRole, true);
  assert.equal(u.body.user.downloadRole, true);
  assert.deepEqual(u.body.user.folder, [musicId]);
  const k = await rest(nf.base, 'getUser', { ...tokenAuth('dallas', kidSecret), username: 'dallas' });
  assert.equal(k.body.user.adminRole, false);
  assert.equal(k.body.user.downloadRole, false);
  failed(await rest(nf.base, 'getUser', { u: 'dallas', p: secret, username: 'someone' }), 50);
  const l = await rest(nf.base, 'getLicense', { u: 'dallas', p: secret });
  assert.equal(l.body.license.valid, true);
  ok(await rest(nf.base, 'getScanStatus', { u: 'dallas', p: secret }));
});

test('music apps share the sign-in lockout', { skip }, async () => {
  nf.app.core.auth.attempts.clear();
  for (let i = 0; i < 10; i++) failed(await rest(nf.base, 'ping', { u: 'dallas', p: 'wrong' }), 40);
  const locked = failed(await rest(nf.base, 'ping', { u: 'dallas', p: secret }), 40);
  assert.match(locked, /^Too many sign-in attempts/);
  assert.equal((await client(nf.base).post('/api/auth/login', { username: 'dallas', password: 'password123' })).status, 429, 'the web shares it');
  nf.app.core.auth.attempts.clear();
});

test('review fixes: a music app signing in fine does not reset the lockout', { skip }, async () => {
  nf.app.core.auth.attempts.clear();
  for (let i = 0; i < 9; i++) failed(await rest(nf.base, 'ping', { u: 'dallas', p: 'wrong' }), 40);
  ok(await rest(nf.base, 'ping', { u: 'dallas', p: secret }));
  failed(await rest(nf.base, 'ping', { u: 'dallas', p: 'wrong' }), 40);
  assert.match(failed(await rest(nf.base, 'ping', { u: 'dallas', p: 'wrong' }), 40), /^Too many sign-in attempts/, 'the 10th failure still counts');
  nf.app.core.auth.attempts.clear();
});


// ---- v0.21 tidy-up ----
test('an API key is compared against every key in constant time (no lookup by the key itself)', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { AppPasswords } = await import('../src/subsonic/apppasswords.js');
  const db = openDatabase(path.join(tempDir(), 'ap.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', 1)");
  db.run("INSERT INTO profiles (id, user_id, name, avatar, is_primary, created_at) VALUES (1, 1, 'A', 'blue', 1, 1)");
  const ap = new AppPasswords({ db });
  const keys = [ap.create(1, 'One'), ap.create(1, 'Two'), ap.create(1, 'Three')];
  const asked = [];
  const get = db.get.bind(db);
  db.get = (sql, ...p) => (asked.push(sql), get(sql, ...p));
  const r = ap.check({ apiKey: keys[1].secret });
  assert.equal(r.appPassword?.id, keys[1].id);
  assert.ok(!asked.some((sql) => /secret\s*=\s*\?/.test(sql)), asked.join(' | '));
  assert.equal(ap.check({ apiKey: 'x'.repeat(keys[0].secret.length) }).error, 44);
  db.close();
});
