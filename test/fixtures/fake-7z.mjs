#!/usr/bin/env node
// A stand-in for 7-Zip in the tests (v0.22 comics): an "archive" is any file with a JSON sidecar `<file>.json`
// holding { "entries": { "<name>": "<base64>" }, "hang": false }. It answers the two commands Atomix uses:
//   l -slt -ba -- <file>        the entries, as "Path = …" blocks
//   e -so -- <file> <entry>     one entry's bytes on standard output
//   x -o<dir> -y -- <file>      every entry into a folder
// Each command is logged to `<file>.calls` (one line each).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.length) {
  process.stdout.write('\n7-Zip (a) 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov : 2023-06-20\n\nUsage: 7z <command> [<switches>...] <archive_name>\n');
  process.exit(0);
}
const file = args[args.indexOf('--') + 1];
let spec;
try {
  spec = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
} catch {
  process.stderr.write(`ERROR: ${file}\nCannot open the file as archive\n`);
  process.exit(2);
}
fs.appendFileSync(`${file}.calls`, `${args[0]}\n`);
if (spec.hang) setInterval(() => {}, 1000);
else if (args[0] === 'l') {
  for (const [name, b64] of Object.entries(spec.entries)) process.stdout.write(`Path = ${name}\nSize = ${Buffer.from(b64, 'base64').length}\nAttributes = A\n\n`);
} else if (args[0] === 'e') {
  const name = args[args.indexOf('--') + 2];
  if (!(name in spec.entries)) {
    process.stderr.write('No files to process\n');
    process.exit(1);
  }
  process.stdout.write(Buffer.from(spec.entries[name], 'base64'));
} else if (args[0] === 'x') {
  const out = args.find((a) => a.startsWith('-o')).slice(2);
  for (const [name, b64] of Object.entries(spec.entries)) {
    fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
    fs.writeFileSync(path.join(out, name), Buffer.from(b64, 'base64'));
  }
} else process.exit(7);
