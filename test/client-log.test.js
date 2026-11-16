// v0.28: Atomix keeps its console lines in data/logs/atomix.log, and a player that fails tells the server what the
// browser said, so a problem on a phone can be read from the PC afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startAtomix, client, tempDir } from './helpers.js';
import { logger, setLogFile, closeLogFile } from '../src/log.js';

let nf, admin;
before(async () => {
  nf = await startAtomix({}, { logLevel: 'info' });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
});
after(async () => nf?.app.stop());

const logText = () => fs.readFileSync(path.join(nf.dataDir, 'logs', 'atomix.log'), 'utf8');

test('the server writes its lines to data/logs/atomix.log', async () => {
  logger('test').info('hello from the test');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(logText(), /INFO  \[test\] hello from the test/);
});

test("a player's error report is written to the log, without any link's private part", async () => {
  const r = await admin.post('/api/client-log', {
    message: "Can't play this right now",
    details: ['direct (direct): error 4 — MEDIA_ERR_SRC_NOT_SUPPORTED', 'src /api/items/4/file?cast=SECRETTOKEN123&x=1'],
    itemId: 4,
  }, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_0 like Mac OS X) CriOS/157' });
  assert.equal(r.status, 204);
  await new Promise((res) => setTimeout(res, 50));
  const text = logText();
  assert.match(text, /\[player\] item 4: Can't play this right now — direct \(direct\): error 4/);
  assert.match(text, /iPhone OS 27_2_0/);
  assert.doesNotMatch(text, /SECRETTOKEN123/);
});

test('reports need a sign-in and are limited', async () => {
  const stranger = client(nf.base);
  assert.equal((await stranger.post('/api/client-log', { message: 'x' })).status, 401);
  let last;
  for (let i = 0; i < 25; i++) last = await admin.post('/api/client-log', { message: `n${i}` });
  assert.equal(last.status, 429);
});

test('a big log is moved to atomix.log.1 when the next one opens', () => {
  const dir = tempDir();
  const file = path.join(dir, 'atomix.log');
  fs.writeFileSync(file, 'x'.repeat(6 * 1024 * 1024));
  setLogFile(file, { maxBytes: 5 * 1024 * 1024 });
  closeLogFile();
  assert.equal(fs.statSync(path.join(dir, 'atomix.log.1')).size, 6 * 1024 * 1024);
  assert.ok(!fs.existsSync(file) || fs.statSync(file).size < 1000);
});
