// Test helpers for the secure address (v0.27): a fake Tailscale command line.
import fs from 'node:fs';
import path from 'node:path';

/** A fake `tailscale` whose answers come from FAKE_TS_MODE; it logs its arguments to FAKE_TS_LOG. */
export function fakeTailscale(dir) {
  const file = path.join(dir, 'tailscale');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs');
const mode = process.env.FAKE_TS_MODE || 'ok';
const args = process.argv.slice(2);
if (process.env.FAKE_TS_LOG) fs.appendFileSync(process.env.FAKE_TS_LOG, JSON.stringify(args) + '\\n');
const name = process.env.FAKE_TS_NAME || 'den-pc.tail1234.ts.net';
if (mode === 'hang') setTimeout(() => {}, 30000);
else if (args[0] === 'status') {
  if (mode === 'login') console.log(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }));
  else console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: name + '.' }, CertDomains: mode === 'nocerts' ? null : [name] }));
} else if (args[0] === 'cert') {
  if (mode === 'denied') { console.error('Access is denied.'); process.exit(1); }
  if (mode === 'denied2') { console.error('cert: 403 Forbidden: Access denied: cert access denied'); process.exit(1); }
  if (mode === 'broken') { console.error('500 Internal Server Error: acme failed\\nmore detail'); process.exit(1); }
  const certFile = args[args.indexOf('--cert-file') + 1];
  const keyFile = args[args.indexOf('--key-file') + 1];
  fs.writeFileSync(certFile, process.env.FAKE_TS_CERT ? fs.readFileSync(process.env.FAKE_TS_CERT) : 'cert');
  fs.writeFileSync(keyFile, process.env.FAKE_TS_KEY ? fs.readFileSync(process.env.FAKE_TS_KEY) : 'key');
}
`,
    { mode: 0o755 },
  );
  return file;
}

