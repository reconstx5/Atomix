// Updates the two libraries Atomix keeps in its repo (v0.26): Preact and htm.
//   node scripts/vendor-update.mjs <preactVersion> <htmVersion>
// Downloads the published packages from the npm registry (the CDNs aren't reachable from the cloud), copies their
// ES module builds into public/js/vendor/, rewrites their imports to relative paths (so no import map is needed),
// and writes LICENSES.md and checksums.json. Needs the system `tar`; run it from the repo. Not used at runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const [preactV, htmV] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(preactV || '') || !/^\d+\.\d+\.\d+$/.test(htmV || '')) {
  console.error('usage: node scripts/vendor-update.mjs <preactVersion> <htmVersion>   e.g. 11.0.1 3.1.1');
  process.exit(1);
}
const OUT = process.env.ATOMIX_VENDOR_DIR || new URL('../public/js/vendor', import.meta.url).pathname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atomix-vendor-'));

async function unpack(name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
  if (!res.ok) throw new Error(`${name}@${version}: ${res.status}`);
  const tgz = path.join(work, `${name}.tgz`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  const dest = path.join(work, name);
  fs.mkdirSync(dest);
  execFileSync('tar', ['xzf', tgz, '-C', dest, '--strip-components=1']);
  return dest;
}

const relink = (src) =>
  src
    .replace(/from\s*(["'])preact\1/g, 'from"./preact.module.js"')
    .replace(/from\s*(["'])htm\1/g, 'from"./htm.module.js"')
    .replace(/\n?\/\/# sourceMappingURL=.*$/m, ''); // the maps aren't kept

const preact = await unpack('preact', preactV);
const htm = await unpack('htm', htmV);
const files = {
  'preact.module.js': path.join(preact, 'dist/preact.mjs'),
  'hooks.module.js': path.join(preact, 'hooks/dist/hooks.mjs'),
  'htm.module.js': path.join(htm, 'dist/htm.module.js'),
  'htm-preact.module.js': path.join(htm, 'preact/index.module.js'),
};
fs.mkdirSync(OUT, { recursive: true });
const sums = { versions: { preact: preactV, htm: htmV }, files: {} };
let all = '';
for (const [name, from] of Object.entries(files)) {
  const text = relink(fs.readFileSync(from, 'utf8')).trimEnd() + '\n';
  fs.writeFileSync(path.join(OUT, name), text);
  sums.files[name] = crypto.createHash('sha256').update(text).digest('hex');
  all += text;
  console.log(`${name}: ${text.length} bytes`);
}
const licence = (dir) => {
  const f = fs.readdirSync(dir).find((n) => /^licen[cs]e/i.test(n));
  return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : '(no licence file in the package)';
};
const meta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(OUT, 'LICENSES.md'),
  `# Libraries kept in this folder\n\nAtomix keeps these two libraries in its repo (no npm install, no build step). They are updated with\n\`scripts/vendor-update.mjs\`, which rewrites their imports to relative paths. \`checksums.json\` records each file.\n\n## Preact ${preactV} (${meta(preact).license})\n\n${licence(preact)}\n\n## htm ${htmV} (${meta(htm).license})\n\n${licence(htm)}\n`,
);
fs.writeFileSync(path.join(OUT, 'checksums.json'), JSON.stringify(sums, null, 2) + '\n');
console.log(`gzipped total: ${zlib.gzipSync(all).length} bytes`);
fs.rmSync(work, { recursive: true, force: true });
