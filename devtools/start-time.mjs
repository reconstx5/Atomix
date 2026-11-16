// How long until a player has something to show: direct, converted (fMP4 stream) and converted for Safari (HLS).
const B = 'http://localhost:8787';
const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'dallas', password: 'atomix-dev-1' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const H = { cookie, 'content-type': 'application/json' };
const items = (await (await fetch(`${B}/api/libraries/1/items`, { headers: H })).json()).items;
const id = Number(process.argv[2]) || items[0].id;
const run = async (label, caps, extra = {}) => {
  const t0 = performance.now();
  const r = await (await fetch(`${B}/api/items/${id}/playback`, { method: 'POST', headers: H, body: JSON.stringify({ caps, ...extra }) })).json();
  const t1 = performance.now();
  let firstMedia = null;
  if (r.url.includes('index.m3u8')) {
    const pl = await (await fetch(B + r.url, { headers: H })).text();
    const seg = pl.split('\n').find((l) => l && !l.startsWith('#'));
    const init = (pl.match(/URI="([^"]+)"/) || [])[1];
    const base = r.url.replace(/[^/]+$/, '');
    if (init) await (await fetch(B + base + init, { headers: H })).arrayBuffer();
    await (await fetch(B + base + seg, { headers: H })).arrayBuffer();
    firstMedia = performance.now();
  } else {
    const res = await fetch(B + r.url, { headers: H });
    const reader = res.body.getReader();
    let got = Buffer.alloc(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      got = Buffer.concat([got, Buffer.from(value)]);
      if (got.includes('mdat') && got.length > got.indexOf('mdat') + 4096) { firstMedia = performance.now(); break; }
    }
    reader.cancel().catch(() => {});
  }
  console.log(`${label}: mode=${r.mode} POST ${(t1 - t0).toFixed(0)} ms, first media ${(firstMedia - t1).toFixed(0)} ms after`);
  await fetch(`${B}/api/playback/${r.sessionId}/stop`, { method: 'POST', headers: H, body: '{}' });
};
const chrome = { video: ['h264'], audio: ['aac'], containers: ['mp4'], hls: false, mse: true };
const safari = { video: ['h264'], audio: ['aac'], containers: ['mp4'], hls: true, mse: false };
await run('direct', chrome);
await run('converted (Chrome)', chrome, { forceTranscode: true });
await run('converted (Safari HLS)', safari, { forceTranscode: true });
await run('converted 2nd', chrome, { forceTranscode: true });
await run('converted HLS 2nd', safari, { forceTranscode: true });
