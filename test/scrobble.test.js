// Scrobbling: ListenBrainz (a pasted token) and Last.fm (sign-in through Last.fm), "now playing" and listens,
// the queue that retries with backoff for 14 days, a refused sign-in that stops the service, songs only, and no
// route ever handing out a token, session key or the Last.fm secret.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { tempDir, fakeServer, startAtomix, client, hasFfmpeg } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { Scrobblers, lastfmSignature } from '../src/scrobble/index.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const LB_TOKEN = 'lb-token-123';
const LF_KEY = 'lfkey';
const LF_SECRET = 'lfsecret';
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

/** A fake ListenBrainz; `answers` (status codes) are used up first, then 200. */
async function fakeListenBrainz({ answers = [] } = {}) {
  const got = [];
  const s = await fakeServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      if (req.url === '/1/validate-token') {
        const ok = auth === `Token ${LB_TOKEN}`;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { valid: true, user_name: 'dallas_lb' } : { valid: false }));
        return;
      }
      const status = answers.length ? answers.shift() : 200;
      if (status === 200) got.push({ auth, body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });
  servers.push(s);
  return { ...s, got };
}

/** A fake Last.fm API: checks every signature; `errors` (Last.fm error codes) are used up first. */
async function fakeLastfm({ errors = [] } = {}) {
  const got = [];
  const s = await fakeServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(body || req.url.split('?')[1] || ''));
      const send = (d) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d));
      const { api_sig: sig, format, ...rest } = p;
      const expect = md5(Object.keys(rest).sort().map((k) => k + rest[k]).join('') + LF_SECRET);
      if (sig !== expect) return send({ error: 13, message: 'Invalid method signature supplied' });
      if (p.method === 'auth.getSession') return send(p.token === 'tok-1' ? { session: { name: 'dallas_fm', key: 'sk-1', subscriber: 0 } } : { error: 4, message: 'Invalid token' });
      if (errors.length) return send({ error: errors.shift(), message: 'nope' });
      got.push(p);
      send({});
    });
  });
  servers.push(s);
  return { ...s, got };
}

function setup({ lb, lf } = {}) {
  const db = openDatabase(path.join(tempDir(), 'scrobble.db'));
  db.run("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a', 'a', 'x', 'user', 1)");
  db.run("INSERT INTO profiles (id, user_id, name, avatar, is_primary, created_at) VALUES (1, 1, 'A', 'blue', 1, 1)");
  db.run("INSERT INTO libraries (id, name, type, paths, options, created_at) VALUES (1, 'M', 'music', '[]', '{}', 1), (2, 'V', 'movies', '[]', '{}', 1)");
  db.run("INSERT INTO items (id, library_id, kind, title, added_at, updated_at) VALUES (10, 1, 'artist', 'The Band', 1, 1)");
  db.run("INSERT INTO items (id, library_id, kind, parent_id, show_id, title, added_at, updated_at) VALUES (20, 1, 'album', 10, 10, 'First Record', 1, 1)");
  db.run("INSERT INTO items (id, library_id, kind, parent_id, show_id, title, artist, episode, duration, added_at, updated_at) VALUES (30, 1, 'track', 20, 10, 'Opening', 'The Band', 1, 200, 1, 1), (31, 1, 'track', 20, 10, 'Closer', 'The Band', 2, 180, 1, 1), (32, 1, 'track', 20, 10, 'Encore', 'The Band', 3, 240, 1, 1)");
  db.run("INSERT INTO items (id, library_id, kind, title, duration, added_at, updated_at) VALUES (40, 2, 'movie', 'Alien', 7000, 1, 1)");
  const clock = { t: 1_800_000_000_000 };
  const settings = { values: { lastfmApiKey: LF_KEY, lastfmSecret: LF_SECRET }, get(k) { return this.values[k]; } };
  const s = new Scrobblers({ db, settings, config: { listenbrainzBase: lb?.url || 'http://127.0.0.1:1', lastfmBase: `${lf?.url || 'http://127.0.0.1:1'}/2.0/`, lastfmAuthBase: 'https://www.last.fm/api/auth/', version: '0.20.0' }, now: () => clock.t, timers: false });
  const item = (id) => db.get('SELECT * FROM items WHERE id = ?', id);
  const play = (id, startedAt = clock.t) => {
    const playId = Number(db.run("INSERT INTO plays (profile_id, item_id, started_at, updated_at, seconds, counted, client) VALUES (1, ?, ?, ?, 0, 1, 'browser')", id, startedAt, startedAt).lastInsertRowid);
    return { profileId: 1, item: item(id), playId, client: 'browser' };
  };
  return { db, s, clock, settings, item, play };
}

test('ListenBrainz: connect, now playing, listen', async () => {
  const lb = await fakeListenBrainz();
  const { s, play, item } = setup({ lb });
  await assert.rejects(s.connectListenBrainz(1, 'wrong'), { message: "ListenBrainz didn't accept that token." });
  const st = await s.connectListenBrainz(1, LB_TOKEN);
  assert.equal(st.username, 'dallas_lb');
  await s.nowPlaying({ profileId: 1, item: item(30), client: 'browser' });
  const at = Date.now() - 5000;
  const ev = play(31, 1_800_000_000_000 - 200_000);
  await s.listen(ev);
  await s.drain();
  assert.equal(lb.got.length, 2);
  assert.equal(lb.got[0].auth, `Token ${LB_TOKEN}`);
  assert.equal(lb.got[0].body.listen_type, 'playing_now');
  assert.equal(lb.got[0].body.payload[0].track_metadata.track_name, 'Opening');
  assert.equal(lb.got[0].body.payload[0].listened_at, undefined);
  const single = lb.got[1].body;
  assert.equal(single.listen_type, 'single');
  assert.deepEqual(single.payload[0].track_metadata.artist_name, 'The Band');
  assert.deepEqual(single.payload[0].track_metadata.release_name, 'First Record');
  assert.equal(single.payload[0].track_metadata.additional_info.duration_ms, 180000);
  assert.equal(single.payload[0].track_metadata.additional_info.tracknumber, 2);
  assert.equal(single.payload[0].track_metadata.additional_info.submission_client, 'Atomix');
  assert.equal(single.payload[0].listened_at, Math.floor((1_800_000_000_000 - 200_000) / 1000));
  assert.ok(at);
  const status = s.status(1).find((x) => x.service === 'listenbrainz');
  assert.equal(status.connected, true);
  assert.equal(status.lastOk, 1_800_000_000_000);
});

test('Last.fm: connect through the callback and scrobble', async () => {
  const lf = await fakeLastfm();
  const { s, play } = setup({ lf });
  const { url } = s.lastfmStart(1, 'http://atomix.local/api/scrobble/lastfm/callback');
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.last.fm/api/auth/');
  assert.equal(u.searchParams.get('api_key'), LF_KEY);
  const cb = new URL(u.searchParams.get('cb'));
  const state = cb.searchParams.get('state');
  assert.ok(state && state.length >= 16);
  await assert.rejects(s.lastfmFinish(1, { token: 'tok-1', state: 'not-the-state' }), { message: "Last.fm didn't connect. Try again." });
  await assert.rejects(s.lastfmFinish(2, { token: 'tok-1', state }), { message: "Last.fm didn't connect. Try again." }, 'bound to its profile');
  const st = await s.lastfmFinish(1, { token: 'tok-1', state });
  assert.equal(st.username, 'dallas_fm');
  await assert.rejects(s.lastfmFinish(1, { token: 'tok-1', state }), { message: "Last.fm didn't connect. Try again." }, 'a state works once');
  await s.listen(play(30, 1_800_000_000_000 - 300_000));
  await s.drain();
  assert.equal(lf.got.length, 1);
  assert.equal(lf.got[0].method, 'track.scrobble');
  assert.equal(lf.got[0].sk, 'sk-1');
  assert.equal(lf.got[0].artist, 'The Band');
  assert.equal(lf.got[0].track, 'Opening');
  assert.equal(lf.got[0].album, 'First Record');
  assert.equal(lf.got[0].timestamp, String(Math.floor((1_800_000_000_000 - 300_000) / 1000)));
  assert.equal(lastfmSignature({ b: '2', a: '1', format: 'json' }, 'S'), md5('a1b2S'));
});

test('queued listens go out once, in order', async () => {
  const lb = await fakeListenBrainz({ answers: [503, 503, 503] });
  const { s, play, clock, db } = setup({ lb });
  await s.connectListenBrainz(1, LB_TOKEN);
  await s.listen(play(30, clock.t - 900_000)); // fails (1st 503)
  await s.listen(play(31, clock.t - 600_000)); // held back behind the first
  await s.listen(play(32, clock.t - 300_000));
  await s.drain();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scrobble_queue').n, 3);
  for (let i = 0; i < 6; i++) {
    clock.t += 6 * 3600_000; // past any backoff
    await s.drain();
  }
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scrobble_queue').n, 0);
  const names = lb.got.map((g) => g.body.payload[0].track_metadata.track_name);
  assert.deepEqual(names, ['Opening', 'Closer', 'Encore'], 'once each, oldest first');
  const st = s.status(1)[0];
  assert.ok(st.lastOk);
  assert.equal(st.lastError, null, 'a success clears the last error');
});

test('backoff doubles and waits', async () => {
  const lb = await fakeListenBrainz({ answers: [500, 500, 500] });
  const { s, play, clock, db } = setup({ lb });
  await s.connectListenBrainz(1, LB_TOKEN);
  await s.listen(play(30));
  await s.drain();
  let row = db.get('SELECT * FROM scrobble_queue');
  assert.equal(row.tries, 1);
  assert.equal(row.next_at, clock.t + 2 * 60_000);
  await s.drain(); // not due yet: nothing sent, no try spent
  assert.equal(db.get('SELECT tries FROM scrobble_queue').tries, 1);
  clock.t += 2 * 60_000;
  await s.drain();
  row = db.get('SELECT * FROM scrobble_queue');
  assert.equal(row.tries, 2);
  assert.equal(row.next_at, clock.t + 4 * 60_000);
  assert.match(s.status(1)[0].lastError, /500/);
});

test('a refused token stops the service', async () => {
  const lb = await fakeListenBrainz({ answers: [401] });
  const { s, play, db } = setup({ lb });
  await s.connectListenBrainz(1, LB_TOKEN);
  await s.listen(play(30));
  await s.listen(play(31));
  await s.drain();
  const st = s.status(1)[0];
  assert.equal(st.stopped, true);
  assert.equal(st.lastError, 'Connect again');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scrobble_queue').n, 0, "that service's queue is dropped");
  await s.listen(play(32));
  await s.drain();
  assert.equal(lb.got.length, 0, 'nothing more is sent');
  await s.connectListenBrainz(1, LB_TOKEN);
  assert.equal(s.status(1)[0].stopped, false, 'reconnecting starts it again');
  await s.listen(play(32));
  await s.drain();
  assert.equal(lb.got.length, 1);
});

test('Last.fm: an invalid session stops it; a busy service retries', async () => {
  const lf = await fakeLastfm({ errors: [11, 9] });
  const { s, play, db } = setup({ lf });
  const { url } = s.lastfmStart(1, 'http://atomix.local/cb');
  await s.lastfmFinish(1, { token: 'tok-1', state: new URL(new URL(url).searchParams.get('cb')).searchParams.get('state') });
  await s.listen(play(30));
  await s.drain();
  assert.equal(db.get('SELECT tries FROM scrobble_queue').tries, 1, 'error 11 (service offline) is retried');
  await s.drain(); // not due
  s.now = () => 1_800_000_000_000 + 3600_000;
  await s.drain();
  assert.equal(s.status(1).find((x) => x.service === 'lastfm').stopped, true, 'error 9 (invalid session) stops it');
});

test('old listens give up after 14 days', async () => {
  const lb = await fakeListenBrainz();
  const { s, db, clock } = setup({ lb });
  await s.connectListenBrainz(1, LB_TOKEN);
  db.run("INSERT INTO scrobble_queue (profile_id, service, kind, payload, at, tries, next_at) VALUES (1, 'listenbrainz', 'listen', '{}', ?, 9, 0)", clock.t - 15 * 86400_000);
  await s.drain();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scrobble_queue').n, 0);
  assert.equal(lb.got.length, 0);
});

test('only songs scrobble', async () => {
  const lb = await fakeListenBrainz();
  const { s, play, item } = setup({ lb });
  await s.connectListenBrainz(1, LB_TOKEN);
  await s.listen(play(40));
  await s.nowPlaying({ profileId: 1, item: item(40), client: 'browser' });
  await s.drain();
  assert.equal(lb.got.length, 0);
});

test('a profile without scrobblers sends nothing; disconnecting forgets the sign-in', async () => {
  const lb = await fakeListenBrainz();
  const { s, play, db } = setup({ lb });
  await s.listen(play(30));
  await s.drain();
  assert.equal(lb.got.length, 0);
  await s.connectListenBrainz(1, LB_TOKEN);
  s.disconnect(1, 'listenbrainz');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM profile_scrobblers').n, 0);
  assert.equal(s.status(1).find((x) => x.service === 'listenbrainz').connected, false);
});

test('routes never return secrets', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const lb = await fakeListenBrainz();
  const nf = await startAtomix({ ATOMIX_LISTENBRAINZ_BASE: lb.url });
  try {
    const admin = client(nf.base);
    await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
    let st = (await admin.get('/api/me/scrobblers')).data;
    assert.equal(st.lastfmReady, false);
    assert.deepEqual(st.services.map((x) => x.service).sort(), ['lastfm', 'listenbrainz']);
    assert.equal((await admin.put('/api/me/scrobblers/listenbrainz', { token: 'bad' })).data.error, "ListenBrainz didn't accept that token.");
    assert.equal((await admin.put('/api/me/scrobblers/listenbrainz', { token: LB_TOKEN })).status, 200);
    await admin.put('/api/admin/settings', { lastfmApiKey: LF_KEY, lastfmSecret: LF_SECRET });
    st = (await admin.get('/api/me/scrobblers')).data;
    assert.equal(st.lastfmReady, true);
    const settings = (await admin.get('/api/admin/settings')).data;
    const start = (await admin.post('/api/me/scrobblers/lastfm/start', {})).data;
    assert.match(start.url, /^https:\/\/www\.last\.fm\/api\/auth\/\?api_key=lfkey&cb=/);
    assert.match(decodeURIComponent(start.url), new RegExp(`cb=${nf.base}/api/scrobble/lastfm/callback\\?state=`));
    const everything = JSON.stringify([st, settings, start]);
    for (const secret of [LB_TOKEN, LF_SECRET]) assert.ok(!everything.includes(secret), secret);
    assert.equal(settings.settings?.lastfmApiKey ?? settings.lastfmApiKey, LF_KEY, 'the API key itself is not a secret');
    const bad = await fetch(`${nf.base}/api/scrobble/lastfm/callback?state=nope&token=x`, { headers: { cookie: admin.cookie }, redirect: 'manual' });
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.get('location'), '/#/settings/profile?lastfm=failed');
    assert.equal((await admin.del('/api/me/scrobblers/listenbrainz')).status, 204);
    assert.equal((await admin.get('/api/me/scrobblers')).data.services.find((x) => x.service === 'listenbrainz').connected, false);
  } finally {
    await nf.app.stop();
  }
});

// ---- v0.21 tidy-up ----
test('a listen queued while a send is on its way goes out in that pass', async () => {
  const got = [];
  let release;
  let first = true;
  const slow = await fakeServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url === '/1/validate-token') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ valid: true, user_name: 'x' }));
      if (first) {
        first = false;
        await new Promise((r) => (release = r)); // the first listen's answer takes a while
      }
      got.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  servers.push(slow);
  const { s, play } = setup({ lb: slow });
  await s.connectListenBrainz(1, LB_TOKEN);
  const a = s.listen(play(30, 1_800_000_000_000 - 400_000));
  await new Promise((r) => setTimeout(r, 100));
  const b = s.listen(play(31, 1_800_000_000_000 - 200_000)); // while the first is still being sent
  await new Promise((r) => setTimeout(r, 100));
  release();
  await Promise.all([a, b]);
  assert.deepEqual(got.map((g) => g.payload[0].track_metadata.track_name), ['Opening', 'Closer']);
});
