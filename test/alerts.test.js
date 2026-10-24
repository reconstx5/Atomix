// v0.23 Plan C Task 3: the alerts plugin, renamed Alerts — ntfy, Telegram and Pushover, server problems, and a Test
// button that reports each channel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { report } from '../plugins/notifications/index.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const media = tempDir();
let nf, admin, ntfy, telegram, pushover;
const got = { ntfy: [], telegram: [], pushover: [] };
let failAll = false;

const body = (req) => new Promise((r) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => r(b));
});

before(async () => {
  ntfy = await fakeServer(async (req, res) => {
    if (failAll) return res.writeHead(500), res.end();
    got.ntfy.push({ url: req.url, title: req.headers.title, auth: req.headers.authorization, text: await body(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"x"}');
  });
  telegram = await fakeServer(async (req, res) => {
    const text = await body(req);
    const send = (d, s = 200) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(d)));
    if (failAll || req.url.startsWith('/botBAD/')) return send({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    got.telegram.push({ url: req.url, json: JSON.parse(text) });
    send({ ok: true });
  });
  pushover = await fakeServer(async (req, res) => {
    if (failAll) return res.writeHead(500, { 'content-type': 'application/json' }), res.end('{"status":0}');
    got.pushover.push({ url: req.url, form: Object.fromEntries(new URLSearchParams(await body(req))) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":1}');
  });
  nf = await startAtomix({ ATOMIX_TELEGRAM_BASE: telegram.url, ATOMIX_PUSHOVER_BASE: pushover.url }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123', serverName: 'Atomix' });
  await admin.put('/api/admin/plugins/notifications/config', { ntfyServer: ntfy.url, ntfyTopic: 'atomix-alerts-7f3k', ntfyToken: 'tk_secret', telegramToken: '123:GOOD', telegramChat: '42', pushoverToken: 'apptok', pushoverUser: 'userkey' });
  const r = await admin.post('/api/admin/plugins/notifications/enabled', { enabled: true });
  assert.equal(r.data.loaded, true, r.data.error);
});

after(async () => {
  await nf?.app.stop();
  for (const s of [ntfy, telegram, pushover]) await s?.close();
});

const waitFor = async (fn) => {
  for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
};
const test1 = async () => (await admin.post('/api/admin/plugins/notifications/actions/test', {})).data.message;

test('report lists each channel', () => {
  assert.equal(report([{ name: 'ntfy' }, { name: 'Telegram', error: 'Unauthorized (check the bot token)' }]), 'ntfy: sent · Telegram: Unauthorized (check the bot token)');
  assert.match(report([]), /^Nothing is set up yet\./);
});

test('the plugin is called Alerts and keeps its old settings', async () => {
  const card = (await admin.get('/api/admin/plugins')).data.find((p) => p.id === 'notifications');
  assert.equal(card.name, 'Alerts');
  const keys = card.settings.map((f) => f.key);
  for (const k of ['discordWebhook', 'webhookUrl', 'emailTo', 'smtpHost', 'notifyMovies', 'notifyEpisodes', 'skipFirstScan', 'ntfyTopic', 'telegramToken', 'pushoverUser', 'alertNew', 'alertProblems', 'alertRecovered']) assert.ok(keys.includes(k), k);
  for (const k of ['ntfyToken', 'telegramToken', 'pushoverToken', 'pushoverUser']) assert.equal(card.config[k], '••••••••', `${k} is never sent to the browser`);
});

test('Test sends to every channel filled in', async () => {
  assert.equal(await test1(), 'ntfy: sent · Telegram: sent · Pushover: sent');
  const n = got.ntfy.at(-1);
  assert.equal(n.url, '/atomix-alerts-7f3k');
  assert.ok(n.title, 'a Title header');
  assert.equal(n.auth, 'Bearer tk_secret');
  assert.equal(got.telegram.at(-1).json.chat_id, '42');
  assert.equal(got.telegram.at(-1).url, '/bot123:GOOD/sendMessage');
  assert.deepEqual([got.pushover.at(-1).form.token, got.pushover.at(-1).form.user], ['apptok', 'userkey']);
});

test("Test reports each channel, and a broken one doesn't stop the rest", async () => {
  await admin.put('/api/admin/plugins/notifications/config', { telegramToken: 'BAD' });
  const before = got.pushover.length;
  const msg = await test1();
  assert.equal(msg, 'ntfy: sent · Telegram: Unauthorized (check the bot token) · Pushover: sent');
  assert.ok(!msg.includes('BAD') && !msg.includes('/bot'));
  assert.equal(got.pushover.length, before + 1);
  await admin.put('/api/admin/plugins/notifications/config', { telegramToken: '123:GOOD' });
});

test('new films and episodes reach the new channels, once per scan', { skip }, async () => {
  makeVideo(path.join(media, 'Films', 'Old One (2000)', 'Old One (2000).mp4'));
  await admin.post('/api/libraries', { name: 'Films', type: 'movies', paths: [path.join(media, 'Films')] });
  await waitForScan(admin); // a first scan stays quiet
  const before = got.ntfy.length;
  makeVideo(path.join(media, 'Films', 'New One (2024)', 'New One (2024).mp4'));
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  await waitFor(() => got.ntfy.length > before);
  assert.equal(got.ntfy.length, before + 1);
  assert.match(got.ntfy.at(-1).text, /New One/);
  await admin.put('/api/admin/plugins/notifications/config', { alertNew: false });
  makeVideo(path.join(media, 'Films', 'Newer (2025)', 'Newer (2025).mp4'));
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(got.ntfy.length, before + 1, 'off: nothing');
  await admin.put('/api/admin/plugins/notifications/config', { alertNew: true });
});

const disk = "Only 4 GB free for Atomix's data (/x).";
test('a server problem is sent to every channel', async () => {
  const before = got.ntfy.length;
  nf.app.core.problems.report('disk', 'data', disk);
  await waitFor(() => got.ntfy.length > before && got.pushover.length && got.telegram.length);
  assert.equal(got.ntfy.at(-1).text, `⚠ Atomix: ${disk}`);
  assert.match(got.telegram.at(-1).json.text, /Only 4 GB free/);
  assert.match(got.pushover.at(-1).form.message, /Only 4 GB free/);
});

test('a problem is sent once a day at most, and its clearing only when asked', async () => {
  const before = got.ntfy.length;
  nf.app.core.problems.clear('disk', 'data');
  nf.app.core.problems.report('disk', 'data', disk);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(got.ntfy.length, before, 'the same problem again within a day: not sent');
  await admin.put('/api/admin/plugins/notifications/config', { alertRecovered: true });
  nf.app.core.problems.clear('disk', 'data');
  await waitFor(() => got.ntfy.length > before);
  assert.equal(got.ntfy.at(-1).text, `✓ Atomix: back to normal — ${disk}`);
  nf.app.core.problems.report('disk', 'data', disk);
  nf.app.core.problems.clear('disk', 'data');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(got.ntfy.length, before + 1, 'one clear message per sent problem');
});

test('a problem that comes back within the day is still sent once the day is up (review fix F3)', async () => {
  process.env.ATOMIX_ALERTS_REPEAT_MS = '1500'; // test-only: "a day" is 1.5 s here
  const before = got.ntfy.length;
  const text = 'Only 3 GB free for recordings (/r).';
  nf.app.core.problems.report('disk', 'rec', text);
  await waitFor(() => got.ntfy.length > before);
  nf.app.core.problems.clear('disk', 'rec'); // "Say when a problem clears" is on: one ✓
  await waitFor(() => got.ntfy.length > before + 1);
  nf.app.core.problems.report('disk', 'rec', text); // back within the window: held…
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got.ntfy.length, before + 2, 'not sent again at once');
  await waitFor(() => got.ntfy.length > before + 2); // …and sent when the window is up, as it's still open
  assert.equal(got.ntfy.at(-1).text, `⚠ Atomix: ${text}`);
  nf.app.core.problems.clear('disk', 'rec');
  delete process.env.ATOMIX_ALERTS_REPEAT_MS;
});

test('a problem no channel could send is not counted as sent (review fix F3)', async () => {
  failAll = true;
  const text = 'The Movies folder /gone is missing.';
  nf.app.core.problems.report('library-folder', '9:/gone', text);
  await new Promise((r) => setTimeout(r, 600));
  failAll = false;
  const before = got.ntfy.length;
  nf.app.core.problems.clear('library-folder', '9:/gone');
  nf.app.core.problems.report('library-folder', '9:/gone', text);
  await waitFor(() => got.ntfy.length > before);
  assert.equal(got.ntfy.at(-1)?.text, `⚠ Atomix: ${text}`, 'sent when it comes back, not held for a day');
});

test('Server problems off sends none', async () => {
  await admin.put('/api/admin/plugins/notifications/config', { alertProblems: false });
  const before = got.ntfy.length;
  nf.app.core.problems.report('library-folder', '1:/m', 'The Movies folder /m is missing.');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(got.ntfy.length, before);
});
