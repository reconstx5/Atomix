// Quick Connect: a TV shows a code, someone signed in approves it, the TV signs in as that account. Codes last 5
// minutes, sign in once, are compared in constant time; 5 wrong codes in a row cancel every waiting code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAtomix, client } from './helpers.js';
import { QuickConnect, deviceName } from '../src/quickconnect.js';

function setup() {
  const clock = { t: 1_000_000 };
  return { clock, qc: new QuickConnect({ now: () => clock.t }) };
}

test('a code waits, gets approved and signs in', () => {
  const { qc } = setup();
  const s = qc.start('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
  assert.match(s.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(s.poll.length >= 30);
  assert.equal(s.device, 'Chrome on Android');
  assert.deepEqual(qc.poll(s.poll), { status: 'waiting' });
  assert.deepEqual(qc.approve(s.code.toLowerCase(), 1), { device: 'Chrome on Android', ip: null }); // v0.21: the TV's address too (for the log)
  assert.deepEqual(qc.poll(s.poll), { status: 'approved', userId: 1 });
});

test('device names', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'), 'Firefox on Windows');
  assert.equal(deviceName('Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/4.0 TV Safari/537.36'), 'a smart TV');
  assert.equal(deviceName('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79 Safari/537.36'), 'a smart TV');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 11; BRAVIA 4K) AppleWebKit/537.36 Chrome/120 Safari/537.36 Android TV'), 'a smart TV');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120.0'), 'Edge on a Mac');
  assert.equal(deviceName(''), 'a web browser');
});

test('codes expire after 5 minutes', () => {
  const { qc, clock } = setup();
  const s = qc.start('');
  clock.t += 5 * 60_000 + 1;
  assert.deepEqual(qc.poll(s.poll), { status: 'expired' });
  assert.equal(qc.approve(s.code, 1), null);
});

test('a code signs in once', () => {
  const { qc } = setup();
  const s = qc.start('');
  qc.approve(s.code, 1);
  assert.equal(qc.poll(s.poll).status, 'approved');
  assert.deepEqual(qc.poll(s.poll), { status: 'expired' });
  assert.equal(qc.approve(s.code, 1), null);
  assert.deepEqual(qc.poll('not-a-token'), { status: 'expired' });
});

test('guessing codes cancels them', () => {
  const { qc } = setup();
  const a = qc.start('');
  const b = qc.start('');
  for (let i = 0; i < 4; i++) assert.equal(qc.approve('ZZZZZ2', 7), null);
  assert.equal(qc.poll(a.poll).status, 'waiting');
  assert.equal(qc.approve('ZZZZZ2', 7), null); // the 5th
  assert.equal(qc.poll(a.poll).status, 'expired');
  assert.equal(qc.poll(b.poll).status, 'expired');
  // A right code resets an account's count.
  const c = qc.start('');
  const d = qc.start('');
  for (let i = 0; i < 3; i++) qc.approve('ZZZZZ2', 8);
  assert.ok(qc.approve(c.code, 8));
  for (let i = 0; i < 4; i++) qc.approve('ZZZZZ2', 8);
  assert.equal(qc.poll(d.poll).status, 'waiting');
});

let nf;
before(async () => {
  nf = await startAtomix();
  const admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  nf.admin = admin;
});
after(async () => {
  await nf?.app.stop();
});

test('routes', async () => {
  const tv = client(nf.base);
  assert.equal((await tv.get('/api/status')).data.quickConnect, true);
  const s = await tv.post('/api/quickconnect', {}, { 'user-agent': 'Mozilla/5.0 (SMART-TV; Tizen 6.0) TV' });
  assert.equal(s.status, 200);
  assert.ok(s.data.code && s.data.poll && s.data.expiresAt);
  assert.equal((await tv.post('/api/quickconnect/poll', { poll: s.data.poll })).data.status, 'waiting');
  assert.equal((await tv.get(`/api/quickconnect/${s.data.poll}`)).status, 404, 'no GET poll: the token never sits in a URL');
  assert.equal(s.data.ttlMs, 5 * 60_000);
  const wrong = await nf.admin.post('/api/quickconnect/approve', { code: 'ZZZZZ2' });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.data.error, "That code isn't waiting. Check the TV and try again.");
  const ok = await nf.admin.post('/api/quickconnect/approve', { code: s.data.code });
  assert.deepEqual(ok.data, { device: 'a smart TV' });
  const done = await tv.post('/api/quickconnect/poll', { poll: s.data.poll });
  assert.equal(done.data.status, 'approved');
  assert.equal(done.data.user.username, 'dallas');
  assert.ok(tv.cookie, 'the TV got a session cookie');
  assert.equal((await tv.get('/api/profiles')).status, 200, 'the TV is signed in');
  assert.equal((await tv.get('/api/status')).data.user.username, 'dallas', '…as the approving account (its profile is picked as for any sign-in)');
  assert.equal((await client(nf.base).post('/api/quickconnect/approve', { code: s.data.code })).status, 401, 'approving needs a sign-in');
  // Wrong approvals count toward the sign-in lockout.
  nf.app.core.auth.attempts.clear();
  for (let i = 0; i < 10; i++) await nf.admin.post('/api/quickconnect/approve', { code: 'ZZZZZ3' });
  assert.equal((await client(nf.base).post('/api/auth/login', { username: 'dallas', password: 'password123' })).status, 429);
  nf.app.core.auth.attempts.clear();
  // Off in Settings → Server.
  await nf.admin.put('/api/admin/settings', { quickConnect: false });
  assert.equal((await tv.get('/api/status')).data.quickConnect, false);
  const off = await client(nf.base).post('/api/quickconnect', {});
  assert.equal(off.status, 403);
  assert.equal(off.data.error, 'Quick Connect is turned off.');
  await nf.admin.put('/api/admin/settings', { quickConnect: true });
});

test('review fixes: an approved code must be collected within a minute', () => {
  const { qc, clock } = setup();
  const s = qc.start('', '10.0.0.1');
  qc.approve(s.code, 1);
  clock.t += 61_000;
  assert.deepEqual(qc.poll(s.poll), { status: 'expired' });
});

test('review fixes: starting codes is limited per address', () => {
  const { qc, clock } = setup();
  for (let i = 0; i < 5; i++) qc.start('', '10.0.0.2');
  assert.throws(() => qc.start('', '10.0.0.2'), { status: 429, message: 'Too many codes from this address. Try again in a minute.' });
  assert.ok(qc.start('', '10.0.0.3'), 'another address is fine');
  clock.t += 5 * 60_000 + 1; // the five expire
  for (let i = 0; i < 5; i++) qc.start('', '10.0.0.2');
  assert.throws(() => qc.start('', '10.0.0.2'), { status: 429 }, 'and at most 10 starts a minute');
  clock.t += 61_000;
  assert.equal(qc.start('', '10.9.9.9').ttlMs, 5 * 60_000);
  let refused = 0;
  for (let i = 0; i < 1100; i++) {
    try {
      qc.start('', `10.1.${i >> 8}.${i & 255}`);
    } catch {
      refused++;
    }
  }
  assert.ok(qc.waiting.size <= 1000, 'never more than 1000 waiting');
  assert.ok(refused > 0, 'past 1000 new codes wait; existing ones are never pushed out');
});

// ---- v0.21 tidy-up ----
test('a Quick Connect sign-in is logged with the TV\'s own address', async () => {
  const tv = client(nf.base);
  const s = await tv.post('/api/quickconnect', {});
  for (const e of nf.app.core.quickConnect.waiting.values()) if (e.code === s.data.code) e.ip = '10.0.0.9'; // the TV is elsewhere on the network
  const ok = await nf.admin.post('/api/quickconnect/approve', { code: s.data.code });
  assert.equal(ok.status, 200);
  assert.ok(!('ip' in ok.data), "the TV's address isn't handed back");
  const row = nf.app.core.db.get("SELECT ip FROM activity WHERE type = 'quick-connect' ORDER BY id DESC LIMIT 1");
  assert.equal(row.ip, '10.0.0.9');
  await tv.post('/api/quickconnect/poll', { poll: s.data.poll });
});

test('turning Quick Connect off cancels codes approved but not collected', async () => {
  const tv = client(nf.base);
  const s = await tv.post('/api/quickconnect', {});
  assert.equal((await nf.admin.post('/api/quickconnect/approve', { code: s.data.code })).status, 200);
  await nf.admin.put('/api/admin/settings', { quickConnect: false });
  const p = await tv.post('/api/quickconnect/poll', { poll: s.data.poll });
  assert.equal(p.data.status, 'expired');
  assert.ok(!tv.cookie, 'no session for the TV');
  await nf.admin.put('/api/admin/settings', { quickConnect: true });
});
