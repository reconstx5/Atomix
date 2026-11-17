// Atomix's Jellyfin API (/jellyfin) for Infuse: the open system routes, sign-in with an app password (the web's
// lockout shared, a bad token not counted), tokens in headers and api_key, routes in any capitals and under /emby,
// logout and revoking, and no token in any log line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, startAtomix, client } from './helpers.js';
import { jf, signIn, authHeader } from './helpers-jellyfin-api.js';
import { setLogLevel } from '../src/log.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let kid;
let secret;
let kidSecret;

before(async () => {
  if (!hasFfmpeg) return;
  nf = await startAtomix({ ATOMIX_JELLYFIN_TRACE: '1' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  const mia = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${mia.id}/select`, {});
  secret = (await admin.post('/api/me/app-passwords', { name: 'Infuse' })).data.secret;
  kidSecret = (await kid.post('/api/me/app-passwords', { name: 'Infuse on the iPad' })).data.secret;
});

after(async () => {
  await nf?.app.stop();
});

const clearLockout = () => nf.app.core.auth.attempts.clear();

test('the public info answers without a sign-in', { skip }, async () => {
  const r = await jf(nf.base).get('/System/Info/Public');
  assert.equal(r.status, 200);
  assert.match(r.body.Id, /^[0-9a-f]{32}$/);
  assert.equal(r.body.ProductName, 'Jellyfin Server');
  assert.equal(r.body.Version, '10.10.7');
  assert.equal(r.body.StartupWizardCompleted, true);
  assert.equal(typeof r.body.ServerName, 'string');
  assert.match(r.body.LocalAddress, /^http:\/\/127\.0\.0\.1:\d+\/jellyfin$/);
  const ping = await jf(nf.base).get('/System/Ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.body, 'Jellyfin Server');
  assert.equal((await jf(nf.base).post('/System/Ping')).body, 'Jellyfin Server');
  assert.equal((await jf(nf.base).get('/System/Info')).status, 401, 'the full info needs a sign-in');
});

test('Users/Public names nobody', { skip }, async () => {
  const r = await jf(nf.base).get('/Users/Public');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('the right app password signs in to the right profile', { skip }, async () => {
  const id = (await jf(nf.base).get('/System/Info/Public')).body.Id;
  const s = await signIn(nf.base, 'dallas', kidSecret);
  assert.equal(s.status, 200);
  assert.equal(s.user.Name, 'Mia');
  assert.equal(s.user.Policy.EnableContentDownloading, false);
  assert.match(s.token, /^[0-9a-f]{64}$/);
  assert.equal(s.body.ServerId, id);
  assert.equal(s.body.SessionInfo.UserId, s.user.Id);
  assert.equal(s.body.SessionInfo.DeviceId, 'test-dev-1');
  assert.equal(s.body.SessionInfo.DeviceName, 'iPhone');
  assert.equal(s.body.SessionInfo.Client, 'Infuse-Direct');
  const grown = await signIn(nf.base, 'dallas', secret);
  assert.equal(grown.status, 200);
  assert.equal(grown.user.Name, 'dallas');
  assert.equal(grown.user.Policy.EnableContentDownloading, true);
  assert.notEqual(grown.token, s.token);
  const me = await jf(nf.base, { token: grown.token }).get('/Users/Me');
  assert.equal(me.status, 200);
  assert.equal(me.body.Id, grown.user.Id);
  const info = await jf(nf.base, { token: grown.token }).get('/System/Info');
  assert.equal(info.status, 200);
  assert.equal(info.body.Id, id);
  assert.equal(typeof info.body.OperatingSystem, 'string');
  const listed = (await admin.get('/api/me/app-passwords')).data.find((p) => p.name === 'Infuse');
  assert.ok(listed.lastUsedAt > Date.now() - 60_000, 'a sign-in marks the app password used');
  for (const header of ['X-Emby-Token', 'X-MediaBrowser-Token']) {
    const r = await jf(nf.base).raw('/Users/Me', { headers: { [header]: grown.token } });
    assert.equal(r.status, 200, header);
  }
  const r = await jf(nf.base).raw('/Users/Me', { headers: { 'X-Emby-Authorization': authHeader({ token: grown.token }) } });
  assert.equal(r.status, 200, 'X-Emby-Authorization');
});

test('a wrong password is 401 and counts toward the lockout', { skip }, async () => {
  clearLockout();
  for (let i = 0; i < 10; i++) assert.equal((await signIn(nf.base, 'dallas', 'not-the-password')).status, 401);
  const locked = await signIn(nf.base, 'dallas', secret);
  assert.equal(locked.status, 429);
  assert.equal(locked.token, null);
  const web = await client(nf.base).post('/api/auth/login', { username: 'dallas', password: 'password123' });
  assert.equal(web.status, 429, 'the web is locked out from the same address too');
  clearLockout();
});

test('a bad token is 401 and does not count', { skip }, async () => {
  clearLockout();
  for (let i = 0; i < 20; i++) {
    const r = await jf(nf.base, { token: '0000' }).get('/Users/Me');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, {});
  }
  assert.equal((await jf(nf.base, { token: 'f'.repeat(64) }).get('/Users/Me')).status, 401);
  assert.equal((await jf(nf.base).get('/Users/Me')).status, 401, 'no token at all');
  assert.equal((await signIn(nf.base, 'dallas', secret)).status, 200);
});

test('the account password does not sign in', { skip }, async () => {
  clearLockout();
  assert.equal((await signIn(nf.base, 'dallas', 'password123')).status, 401);
  assert.equal((await signIn(nf.base, 'nobody', secret)).status, 401);
  assert.equal((await signIn(nf.base, 'dallas', '')).status, 401);
  clearLockout();
});

test('api_key in the query signs in and is never logged', { skip }, async () => {
  const { token } = await signIn(nf.base, 'dallas', secret);
  const lines = [];
  const kept = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(kept)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  setLogLevel('debug');
  try {
    const me = await fetch(`${nf.base}/jellyfin/Users/Me?api_key=${token}`);
    assert.equal(me.status, 200);
    const other = await fetch(`${nf.base}/jellyfin/Users/Me?ApiKey=${token}&Fields=x`);
    assert.equal(other.status, 200);
    const bad = await fetch(`${nf.base}/jellyfin/Videos/nothing-here/stream?api_key=${token}&static=true`);
    assert.equal(bad.status, 404);
    await new Promise((r) => setTimeout(r, 100)); // trace lines are written when the answer finishes
  } finally {
    setLogLevel('error');
    Object.assign(console, kept);
  }
  assert.ok(lines.some((l) => l.includes('[jellyfin]') && l.includes('/jellyfin/Users/Me') && l.includes('200')), `a trace line is written:\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => l.includes('api_key=***')), 'the key is shown as ***');
  for (const l of lines) assert.ok(!l.includes(token), `the token is in a log line: ${l}`);
  const file = path.join(nf.dataDir, 'logs', 'atomix.log');
  if (fs.existsSync(file)) assert.ok(!fs.readFileSync(file, 'utf8').includes(token), 'the token is in the log file');
});

test('routes match without regard to capitals and with /emby', { skip }, async () => {
  const { token } = await signIn(nf.base, 'dallas', secret);
  const ids = new Set();
  for (const p of ['/Users/Me', '/jellyfin/users/me', '/jellyfin/emby/Users/Me', '/JELLYFIN/Users/Me', '/jellyfin/Users/Me/']) {
    const r = await jf(nf.base, { token }).get(p);
    assert.equal(r.status, 200, p);
    ids.add(r.body.Id);
  }
  assert.equal(ids.size, 1);
  assert.equal((await jf(nf.base).get('/jellyfin/system/info/public')).status, 200);
  assert.equal((await jf(nf.base, { token }).get('/No/Such/Route')).status, 404);
});

test('logout ends the token', { skip }, async () => {
  const { token } = await signIn(nf.base, 'dallas', secret);
  const me = jf(nf.base, { token });
  assert.equal((await me.get('/Users/Me')).status, 200);
  const out = await me.post('/Sessions/Logout');
  assert.equal(out.status, 204);
  assert.equal((await me.get('/Users/Me')).status, 401);
});

test('revoking the app password signs Infuse out', { skip }, async () => {
  const made = (await admin.post('/api/me/app-passwords', { name: 'Old Apple TV' })).data;
  const { token } = await signIn(nf.base, 'dallas', made.secret);
  assert.equal((await jf(nf.base, { token }).get('/Users/Me')).status, 200);
  assert.equal((await admin.del(`/api/me/app-passwords/${made.id}`)).status, 204);
  assert.equal((await jf(nf.base, { token }).get('/Users/Me')).status, 401);
  assert.equal((await signIn(nf.base, 'dallas', made.secret)).status, 401);
  clearLockout();
});

test("another profile's user id is 404", { skip }, async () => {
  const mia = await signIn(nf.base, 'dallas', kidSecret);
  const grown = await signIn(nf.base, 'dallas', secret);
  const me = jf(nf.base, { token: grown.token });
  assert.equal((await me.get(`/Users/${mia.user.Id}`)).status, 404);
  assert.equal((await me.get('/Users/not-a-guid')).status, 404);
  const own = await me.get(`/Users/${grown.user.Id}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.Name, 'dallas');
  assert.equal((await jf(nf.base, { token: mia.token }).get(`/Users/${mia.user.Id}`)).body.Name, 'Mia');
});

test('the web is untouched', { skip }, async () => {
  assert.equal((await client(nf.base).get('/api/me')).status, 401);
  const ping = await fetch(`${nf.base}/rest/ping.view?f=json`);
  assert.equal(ping.status, 200);
  assert.ok((await ping.json())['subsonic-response']);
  assert.equal((await admin.get('/api/me')).status, 200);
});

test('the server Id stays the same after a restart', { skip }, async () => {
  const before = (await jf(nf.base).get('/System/Info/Public')).body?.Id;
  assert.match(String(before), /^[0-9a-f]{32}$/);
  const { token } = await signIn(nf.base, 'dallas', secret);
  assert.match(String(token), /^[0-9a-f]{64}$/);
  await nf.app.stop();
  nf = await startAtomix({ ATOMIX_DATA_DIR: nf.dataDir, ATOMIX_JELLYFIN_TRACE: '1' });
  assert.equal((await jf(nf.base).get('/System/Info/Public')).body.Id, before);
  assert.equal((await jf(nf.base, { token }).get('/Users/Me')).status, 200, 'a token outlives a restart');
});
