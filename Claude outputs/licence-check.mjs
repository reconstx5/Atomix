// Atomix licence check (Claude, 10 Oct): sends TVNZ 2's licence server the browser's 2-byte opening request three
// ways and prints each hop's status. Prints no tokens. Run:  node "Claude outputs/licence-check.mjs"
const START = 'https://c.mjh.nz/tvnz-2-wv';
const UA = 'otg/1.5.1 (AppleTv Apple TV 4; tvOS16.0; appletv.client) libcurl/7.58.0 OpenSSL/1.0.2o zlib/1.2.11 clib/1.8.56';
const body = Buffer.from([8, 4]);
async function run(label, { keepHeaders, keepPost, ua }) {
  let url = START;
  let method = 'POST';
  let headers = { 'content-type': 'application/octet-stream', ...(ua ? { 'user-agent': UA } : {}) };
  const origin = new URL(START).origin;
  const steps = [];
  for (let hop = 0; hop < 5; hop++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body: method === 'POST' ? body : undefined, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    } catch (e) {
      steps.push(`${new URL(url).host} ${method} → network error: ${e.cause?.code || e.message}`);
      break;
    }
    const loc = res.headers.get('location');
    const buf = Buffer.from(await res.arrayBuffer());
    steps.push(`${new URL(url).host} ${method} → ${res.status}${loc ? ` (redirect to ${new URL(loc, url).host})` : ''} ${buf.length} bytes${buf.length ? ` starting ${buf.subarray(0, 4).toString('hex')}` : ''}`);
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break;
    const next = new URL(loc, url);
    if (next.origin !== origin && !keepHeaders) headers = {};
    if (![307, 308].includes(res.status) && !keepPost) method = 'GET';
    url = next.href;
  }
  console.log(`\n${label}\n  ${steps.join('\n  ')}`);
}
await run('A. As Atomix 0.17.0 does it (headers dropped on a cross-server redirect, POST becomes GET on 301/302/303):', { keepHeaders: false, keepPost: false, ua: false });
await run('B. Headers and POST kept across redirects:', { keepHeaders: true, keepPost: true, ua: false });
await run('C. As B, plus the playlist\'s User-Agent:', { keepHeaders: true, keepPost: true, ua: true });
