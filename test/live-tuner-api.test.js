// Watching through a tuner (v0.19): the play reply, Atomix's own manifest and pieces, the owner checks, stop and the
// Dashboard. Real ffmpeg against an endless provider.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg, startAtomix, client } from './helpers.js';
import { endlessProvider } from './helpers-live.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-plugins');
const KEY = 'live-test/canned';
const CAPS = { video: ['h264'], audio: ['aac', 'mp3', 'opus'], containers: ['mp4', 'webm'] };
let nf, admin, guest, kid, provider, ids;
const raw = (c, p) => fetch(`${nf.base}${p}`, { headers: { cookie: c.cookie } });

before(async () => {
  if (!hasFfmpeg) return;
  provider = await endlessProvider();
  process.env.LIVE_TEST_BASE = provider.url;
  nf = await startAtomix({ ATOMIX_PLUGINS_DIR: PLUGINS }, { skipLiveRefresh: true });
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  await admin.post('/api/users', { username: 'guest', password: 'guestpass1' });
  guest = client(nf.base);
  await guest.post('/api/auth/login', { username: 'guest', password: 'guestpass1' });
  const me = (await admin.get('/api/profiles')).data[0].id;
  await admin.post(`/api/profiles/${me}/select`, {});
  const kidId = (await admin.post('/api/profiles', { name: 'Mia', kids: true, maxAge: 10, avatar: 'teal' })).data.id;
  kid = client(nf.base);
  await kid.post('/api/auth/login', { username: 'dallas', password: 'password123' });
  await kid.post(`/api/profiles/${kidId}/select`, {});
  await admin.post(`/api/live/sources/${encodeURIComponent(KEY)}/refresh`, {});
  ids = Object.fromEntries((await admin.get('/api/live/channels')).data.map((c) => [c.name, c.id]));
});
after(async () => {
  await nf?.app.stop();
  await provider?.close();
});

let reply;
test('a plain channel plays from the tuner: a dash reply, a manifest with no provider address, pieces served', { skip }, async () => {
  const r = await admin.post(`/api/live/channels/${ids.One}/play`, { caps: CAPS });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  reply = r.data;
  assert.equal(reply.delivery, 'dash');
  assert.equal(reply.rewind, true);
  assert.equal(reply.manifest, `/api/live/tuner/${reply.sessionId}/manifest.mpd`);
  assert.equal(reply.timeUrl, `/api/live/tuner/${reply.sessionId}/time`);
  assert.ok(!JSON.stringify(reply).includes(new URL(provider.url).host) && !JSON.stringify(reply).includes('secretpw'));
  const m = await raw(admin, reply.manifest);
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-type'), /application\/dash\+xml/);
  const text = await m.text();
  assert.match(text, /type="dynamic"/);
  assert.ok(!text.includes(new URL(provider.url).host) && !text.includes('secretpw'));
  const [, prefix, n] = /media="p\/(seg-\d+-)\$Number%06d\$\.m4s" startNumber="(\d+)"/.exec(text);
  const piece = await raw(admin, `/api/live/tuner/${reply.sessionId}/p/${prefix}${String(n).padStart(6, '0')}.m4s`);
  assert.equal(piece.status, 200);
  assert.match(piece.headers.get('content-type'), /video\/mp4/);
  assert.ok((await piece.arrayBuffer()).byteLength > 100);
  const t = await raw(admin, reply.timeUrl);
  assert.ok(Math.abs(Date.parse(await t.text()) - Date.now()) < 5000);
});

test('another account or another profile gets 404 for the manifest and pieces', { skip }, async () => {
  for (const c of [guest, kid]) {
    assert.equal((await raw(c, reply.manifest)).status, 404);
    assert.equal((await raw(c, `/api/live/tuner/${reply.sessionId}/p/init-1.mp4`)).status, 404);
    assert.equal((await c.post(`/api/live/tuner/${reply.sessionId}/ping`, {})).data.ok, false);
  }
});

test('piece names outside the pattern are refused', { skip }, async () => {
  for (const name of ['..%2F..%2Fconfig.json', 'seg-1-000001.m4s.tmp', 'index.m3u8', 'master.m3u8']) {
    assert.equal((await raw(admin, `/api/live/tuner/${reply.sessionId}/p/${name}`)).status, 404, name);
  }
});

test('a second viewer joins the same tuner: one provider connection', { skip }, async () => {
  const before = provider.requests.filter((u) => u.includes('/1.ts')).length;
  const r = await guest.post(`/api/live/channels/${ids.One}/play`, { caps: CAPS });
  assert.equal(r.data.delivery, 'dash');
  assert.equal(provider.requests.filter((u) => u.includes('/1.ts')).length, before);
  const dash = (await admin.get('/api/admin/dashboard')).data;
  const t = dash.tuners.find((x) => x.channel === 'One');
  assert.deepEqual(t.viewers.sort(), ['dallas', 'guest'].sort());
  await guest.post(`/api/live/tuner/${r.data.sessionId}/stop`, {});
});

test('stop releases the hold; the dashboard lists the tuner while held', { skip }, async () => {
  assert.equal((await admin.post(`/api/live/tuner/${reply.sessionId}/ping`, {})).data.ok, true);
  assert.equal((await admin.post(`/api/live/tuner/${reply.sessionId}/stop`, {})).status, 200);
  assert.equal((await admin.post(`/api/live/tuner/${reply.sessionId}/ping`, {})).data.ok, false);
  const t = nf.app.core.live.tuners.list().find((x) => x.label === 'One');
  assert.equal(t?.holders.length ?? 0, 0, 'no-one holds it (it closes after its idle time)');
});

test('admins can stop a tuner viewer from the Dashboard', { skip }, async () => {
  const r = await guest.post(`/api/live/channels/${ids.One}/play`, { caps: CAPS });
  assert.equal(r.data.delivery, 'dash');
  const row = (await admin.get('/api/admin/dashboard')).data.sessions.find((x) => x.id === r.data.sessionId);
  assert.equal(row?.kind, 'live', 'listed with the sessions');
  assert.equal(row.user, 'guest');
  assert.equal((await admin.post(`/api/admin/sessions/${r.data.sessionId}/stop`, {})).status, 200);
  const ping = (await guest.post(`/api/live/tuner/${r.data.sessionId}/ping`, {})).data;
  assert.equal(ping.ok, false);
  assert.equal(ping.error, 'An admin stopped this stream.');
});

test('a converted (HLS) viewer survives a provider drop: its conversion moves to the new run and carries on', { skip }, async () => {
  const caps = { video: ['vp9'], audio: ['aac'], containers: ['mp4'], hls: true };
  const r = await admin.post(`/api/live/channels/${ids.Two}/play`, { caps });
  assert.equal(r.data.delivery, 'hls', JSON.stringify(r.data));
  assert.equal((await raw(admin, r.data.url)).status, 200);
  const core = nf.app.core;
  const session = core.playback.sessions.get(r.data.sessionId);
  const tuner = core.live.tuners.get(session.live.tunerKey);
  // v0.22: the restarted conversion starts inside the new run (never reaching back into the old one: no replay).
  let atRun = null;
  tuner.on('run', () => (atRun = { back: session.behindPieces, inRun: tuner.runs.at(-1).pieces.length }));
  await fetch(`${provider.url}/__drop`);
  const end = Date.now() + 40000;
  while (Date.now() < end && !(tuner.runs.length >= 2 && tuner.runs[1].pieces.length >= 1 && session.proc)) await new Promise((x) => setTimeout(x, 300));
  assert.ok(session.file.endsWith('index-all.m3u8') && tuner.runs.length >= 2, session.file); // v0.21: one playlist across the runs
  assert.ok(session.proc, 'the conversion runs again');
  assert.ok(core.playback.sessions.has(r.data.sessionId));
  assert.equal(core.playback.ended.get(r.data.sessionId), undefined, 'not ended');
  assert.ok(atRun && atRun.back >= 1 && atRun.back <= atRun.inRun, JSON.stringify(atRun));
  await admin.post(`/api/playback/${r.data.sessionId}/stop`, {});
});

test('a radio station plays through its tuner: the stream keeps sending audio, not just its header', { skip }, async () => {
  const radio = (await admin.get('/api/live/channels')).data.find((c) => c.radio);
  const r = await admin.post(`/api/live/channels/${radio.id}/play`, { caps: CAPS, audioOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.delivery, 'progressive');
  const res = await raw(admin, r.data.url);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const chunks = [];
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      chunks.push(Buffer.from(value));
    }
  })();
  await new Promise((x) => setTimeout(x, 8000));
  await reader.cancel().catch(() => {});
  await reading;
  const got = Buffer.concat(chunks);
  const fragments = got.toString('latin1').split('moof').length - 1;
  assert.ok(fragments >= 3, `audio fragments in 8 s: ${fragments} (${got.length} bytes)`);
  await admin.post(`/api/playback/${r.data.sessionId}/stop`, {});
});

test('a radio station sent as HLS in 10-s bursts (behind a redirect) keeps playing between bursts', { skip, timeout: 60_000 }, async () => {
  await fetch(`${provider.url}/__hlsradio`);
  await new Promise((x) => setTimeout(x, 9000)); // a few segments to start from
  nf.app.core.live.tuners.endIdle('live-test/canned\u0000'); // the earlier radio tuner (ADTS) goes
  const radio = (await admin.get('/api/live/channels')).data.find((c) => c.radio);
  const r = await admin.post(`/api/live/channels/${radio.id}/play`, { caps: CAPS, audioOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const res = await raw(admin, r.data.url);
  const reader = res.body.getReader();
  let bytes = 0;
  let ended = false;
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return (ended = true);
      bytes += value.length;
    }
  })();
  await new Promise((x) => setTimeout(x, 15000));
  const ping = await admin.post(`/api/playback/${r.data.sessionId}/ping`, {});
  const endedBefore = ended;
  await reader.cancel().catch(() => {});
  await reading;
  ended = endedBefore;
  const tl = nf.app.core.live.tuners.list().map((t) => [t.label, t.holders.length]);
  assert.equal(ended, false, `the stream didn't end between bursts (${bytes} bytes, ${JSON.stringify(ping.data)}, tuners ${JSON.stringify(tl)}, ${JSON.stringify(provider.requests.slice(-6))})`);
  assert.ok(!ping.data.notice, `no "Lost the channel" (${JSON.stringify(ping.data)})`);
  assert.ok(bytes > 40000, `${bytes} bytes in 15 s`);
  await admin.post(`/api/playback/${r.data.sessionId}/stop`, {});
});

test('v0.28: an iPhone asking for a media link gets one on its channel\'s playlist (no cookie needed)', { skip }, async () => {
  const caps = { video: ['vp9'], audio: ['aac'], containers: ['mp4'], hls: true, mse: false };
  const r = await admin.post(`/api/live/channels/${ids.Two}/play`, { caps, mediaLink: true });
  assert.equal(r.data.delivery, 'hls', JSON.stringify(r.data));
  const u = new URL(r.data.url, nf.base);
  assert.ok(u.searchParams.get('cast'), r.data.url);
  const list = await fetch(`${nf.base}${u.pathname}${u.search}`);
  assert.equal(list.status, 200, 'no cookie, still plays');
  await list.text();
  await admin.post(`/api/playback/${r.data.sessionId}/stop`, {});
});
