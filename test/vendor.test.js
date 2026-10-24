// The two libraries kept in the repo (v0.26): Preact and htm, pinned, unchanged since recorded, importing each
// other by path (no bare names, so no import map is needed), and in the offline helper's file list.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { startAtomix, client } from './helpers.js';

const dir = new URL('../public/js/vendor', import.meta.url).pathname;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
let nf;
after(async () => {
  await nf?.app.stop();
});

test('the vendor files match their recorded checksums', () => {
  const sums = JSON.parse(fs.readFileSync(dir + '/checksums.json', 'utf8'));
  for (const f of ['preact.module.js', 'hooks.module.js', 'htm.module.js', 'htm-preact.module.js']) assert.equal(sha256(fs.readFileSync(`${dir}/${f}`)), sums.files[f], f);
  assert.deepEqual(sums.versions, { preact: '11.0.1', htm: '3.1.1' });
});
test('no vendor file imports by bare name', () => {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(`${dir}/${f}`, 'utf8'), /from\s*["'](?!\.\/)/, f);
});
test('htm is bound to Preact', async () => {
  const { html } = await import('../public/js/vendor/htm-preact.module.js');
  const v = html`<b class="x">hi</b>`;
  assert.equal(v.type, 'b');
  assert.equal(v.props.class, 'x');
});
test('the offline file list carries the vendor files', async () => {
  nf = await startAtomix();
  const { files } = (await client(nf.base).get('/api/shell')).data;
  assert.ok(files.includes('/js/vendor/htm-preact.module.js') && files.includes('/js/vendor/preact.module.js'), JSON.stringify(files.filter((f) => f.includes('vendor'))));
});
test('the update script is in the repo and explains itself', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL('../scripts/vendor-update.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: node scripts\/vendor-update\.mjs <preactVersion> <htmVersion>/);
});
