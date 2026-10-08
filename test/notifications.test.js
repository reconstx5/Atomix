// New-episode alerts (Discord, webhook, email) — written before the plugin existed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan, fakeServer } from './helpers.js';
import { buildMessage } from '../plugins/notifications/index.js';
import { sendMail } from '../plugins/notifications/smtp.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';

// ---- A tiny fake SMTP server that records what it receives ----
function fakeSmtp({ requireAuth = true, starttls = null } = {}) {
  const mails = [];
  const server = net.createServer((raw) => {
    let socket = raw;
    let buffer = '';
    let inData = false;
    let data = '';
    let authed = !requireAuth;
    let loginStep = 0;
    const mail = { from: null, to: [], auth: null };
    const say = (line) => socket.write(line + '\r\n');
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mails.push({ ...mail, data });
            say('250 2.0.0 queued');
          } else data += line + '\r\n';
          continue;
        }
        if (loginStep === 1) {
          mail.auth = { user: Buffer.from(line, 'base64').toString() };
          loginStep = 2;
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (loginStep === 2) {
          mail.auth.pass = Buffer.from(line, 'base64').toString();
          loginStep = 0;
          authed = true;
          say('235 2.7.0 ok');
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) {
          say('250-fake.smtp greets you');
          if (starttls && !socket.encrypted) say('250-STARTTLS');
          say('250-AUTH LOGIN PLAIN');
          say('250 8BITMIME');
        } else if (cmd === 'STARTTLS') {
          say('220 go ahead');
          raw.removeListener('data', onData);
          socket = new tls.TLSSocket(raw, { isServer: true, ...starttls });
          socket.on('data', onData);
        } else if (cmd.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0');
          mail.auth = { user, pass, method: 'PLAIN' };
          authed = true;
          say('235 2.7.0 ok');
        } else if (cmd === 'AUTH LOGIN') {
          loginStep = 1;
          say('334 VXNlcm5hbWU6');
        } else if (cmd.startsWith('MAIL FROM:')) {
          if (!authed) say('530 auth required');
          else {
            mail.from = line.slice(10);
            say('250 ok');
          }
        } else if (cmd.startsWith('RCPT TO:')) {
          mail.to.push(line.slice(8));
          say('250 ok');
        } else if (cmd === 'DATA') {
          inData = true;
          say('354 end with .');
        } else if (cmd === 'QUIT') {
          say('221 bye');
          socket.end();
        } else say('502 unknown');
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    say('220 fake.smtp ESMTP ready');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, mails, close: () => new Promise((r) => server.close(r)) })));
}

const decodeBody = (data) => {
  const [head, ...rest] = data.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  return { head, text: /base64/i.test(head) ? Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') : body };
};

test('messages group episodes by show and link to the server', () => {
  const msg = buildMessage({
    serverName: 'Atomix',
    publicUrl: 'https://media.example.com/',
    items: [
      { id: 1, kind: 'movie', title: 'Heat', year: 1995 },
      { id: 2, kind: 'episode', title: 'Pilot', season: 2, episode: 1, show: { id: 9, title: 'Demo Show' } },
      { id: 3, kind: 'episode', title: 'Second', season: 2, episode: 2, show: { id: 9, title: 'Demo Show' } },
    ],
  });
  assert.equal(msg.subject, 'New on Atomix: Heat, Demo Show');
  assert.match(msg.text, /Heat \(1995\)/);
  assert.match(msg.text, /Demo Show — S2 E1 “Pilot”, S2 E2 “Second”/);
  assert.match(msg.text, /https:\/\/media\.example\.com\/#\/item\/9/);
  const many = buildMessage({ serverName: 'Atomix', items: Array.from({ length: 400 }, (_, i) => ({ id: i, kind: 'movie', title: `Movie number ${i}` })) });
  assert.ok(many.discord.length <= 2000, 'fits in one Discord message');
  assert.match(many.discord, /and \d+ more/);
});

test('SMTP: AUTH PLAIN, headers and a UTF-8 body', async () => {
  const smtp = await fakeSmtp();
  await sendMail({ host: '127.0.0.1', port: smtp.port, security: 'none', user: 'me@example.com', pass: 's3cret', from: 'Atomix <me@example.com>', to: ['you@example.com'], subject: 'New on Atomix: Māori Movie', text: 'Kia ora — new stuff\n.dot line' });
  await smtp.close();
  const [mail] = smtp.mails;
  assert.deepEqual(mail.auth, { user: 'me@example.com', pass: 's3cret', method: 'PLAIN' });
  assert.equal(mail.from, '<me@example.com>');
  assert.deepEqual(mail.to, ['<you@example.com>']);
  const { head, text } = decodeBody(mail.data);
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m, 'non-ASCII subject is encoded');
  assert.match(head, /^From: Atomix <me@example\.com>/m);
  assert.match(head, /^Content-Type: text\/plain; charset=utf-8/m);
  assert.equal(text, 'Kia ora — new stuff\r\n.dot line');
});

test('SMTP: refuses header injection and reports server errors', async () => {
  const smtp = await fakeSmtp();
  await assert.rejects(() => sendMail({ host: '127.0.0.1', port: smtp.port, security: 'none', from: 'a@b.c', to: ['x@y.z\r\nBcc: evil@example.com'], subject: 'hi', text: 'x' }), /Invalid email address/);
  await assert.rejects(() => sendMail({ host: '127.0.0.1', port: smtp.port, security: 'none', from: 'a@b.c', to: ['x@y.z'], subject: 'hi', text: 'x' }), /530/, 'no login → the server says no');
  await smtp.close();
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('SMTP: STARTTLS then AUTH LOGIN', { skip: !hasOpenssl && 'openssl not installed' }, async () => {
  const dir = tempDir();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const smtp = await fakeSmtp({ starttls: { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) } });
  // Force AUTH LOGIN by pretending PLAIN isn't wanted.
  await sendMail({ host: '127.0.0.1', port: smtp.port, security: 'starttls', user: 'u', pass: 'p', authMethod: 'LOGIN', from: 'a@b.c', to: ['x@y.z'], subject: 'tls', text: 'secure', tls: { rejectUnauthorized: false } });
  await smtp.close();
  assert.deepEqual(smtp.mails[0].auth, { user: 'u', pass: 'p' });
  assert.equal(decodeBody(smtp.mails[0].data).text, 'secure');
});

// ---- The plugin inside a running server ----
let nf;
let admin;
let hooks;
let smtp;
const received = { discord: [], webhook: [] };
const media = tempDir();

before(async () => {
  if (!hasFfmpeg) return;
  hooks = await fakeServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url.startsWith('/discord')) received.discord.push(JSON.parse(body));
    else received.webhook.push(JSON.parse(body));
    res.writeHead(204);
    res.end();
  });
  smtp = await fakeSmtp();
  makeVideo(path.join(media, 'Movies', 'First (2000)', 'First (2000).mp4'));
  makeVideo(path.join(media, 'TV', 'Demo Show', 'Season 01', 'Demo.Show.S01E01.mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'admin', password: 'password123', serverName: 'Hub' });
  await admin.put('/api/admin/plugins/notifications/config', {
    discordWebhook: `${hooks.url}/discord/123/abc`,
    webhookUrl: `${hooks.url}/hook`,
    smtpHost: '127.0.0.1',
    smtpPort: smtp.port,
    smtpSecurity: 'none',
    smtpUser: 'bot',
    smtpPass: 'pw',
    emailFrom: 'bot@example.com',
    emailTo: 'dallas@example.com, friend@example.com',
    publicUrl: 'https://media.example.com',
  });
  const r = await admin.post('/api/admin/plugins/notifications/enabled', { enabled: true });
  assert.equal(r.data.loaded, true, r.data.error);
});

after(async () => {
  await nf?.app.stop();
  await hooks?.close();
  await smtp?.close();
});

const waitFor = async (fn) => {
  for (let i = 0; i < 60; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('the first scan of a library stays quiet', { skip }, async () => {
  const m = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [path.join(media, 'Movies')] })).data;
  const t = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [path.join(media, 'TV')] })).data;
  nf.ids = { m: m.id, t: t.id };
  await waitForScan(admin);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.discord.length, 0);
  assert.equal(received.webhook.length, 0);
  assert.equal(smtp.mails.length, 0);
});

test('new titles are announced once per scan on every channel', { skip }, async () => {
  makeVideo(path.join(media, 'Movies', 'Second (2001)', 'Second (2001).mp4'));
  makeVideo(path.join(media, 'TV', 'Demo Show', 'Season 01', 'Demo.Show.S01E02.The.Next.One.mp4'));
  makeVideo(path.join(media, 'TV', 'Demo Show', 'Season 01', 'Demo.Show.S01E03.mp4'));
  await admin.post('/api/scan', {});
  await waitForScan(admin);
  await waitFor(() => received.discord.length >= 2 && received.webhook.length >= 2 && smtp.mails.length >= 2);

  // One message for the movie library's scan and one for the TV library's.
  assert.equal(received.discord.length, 2);
  const all = received.discord.map((d) => d.content).join('\n');
  assert.match(all, /Second \(2001\)/);
  assert.match(all, /Demo Show — S1 E2 “The Next One”, S1 E3/);
  assert.match(all, /https:\/\/media\.example\.com\/#\/item\/\d+/);
  assert.ok(!/First \(2000\)/.test(all), 'old titles are not repeated');
  assert.equal(received.discord[0].username, 'Hub');

  const hook = received.webhook.find((w) => w.items.some((i) => i.kind === 'episode'));
  assert.equal(hook.event, 'items.added');
  assert.equal(hook.items.length, 2);
  assert.equal(hook.items[0].show, 'Demo Show');

  assert.equal(smtp.mails.length, 2);
  assert.deepEqual(smtp.mails[0].to, ['<dallas@example.com>', '<friend@example.com>']);
});

test('"Send a test message" button', { skip }, async () => {
  const plugins = (await admin.get('/api/admin/plugins')).data;
  const n = plugins.find((p) => p.id === 'notifications');
  assert.deepEqual(n.actions.map((a) => a.id), ['test']);
  const before = received.discord.length;
  const r = await admin.post('/api/admin/plugins/notifications/actions/test', {});
  assert.equal(r.status, 200);
  assert.match(r.data.message, /Sent to Discord, webhook and email/);
  assert.equal(received.discord.length, before + 1);
  assert.match(received.discord.at(-1).content, /test message/i);
});

test('a broken channel is reported but the others still send', { skip }, async () => {
  await admin.put('/api/admin/plugins/notifications/config', { webhookUrl: 'http://127.0.0.1:9/nothing-here' });
  const r = await admin.post('/api/admin/plugins/notifications/actions/test', {});
  assert.equal(r.status, 200);
  assert.match(r.data.message, /Sent to Discord and email/);
  assert.match(r.data.message, /webhook failed/i);
});
