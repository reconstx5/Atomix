// What Infuse calls around the main routes: harmless stubs of the right shape, and a recorded session (the calls from
// adding a server to signing out) replayed against a real server. An unknown path is 404, never 500.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo, startAtomix, client, waitForScan } from './helpers.js';
import { jf, signIn, authHeader } from './helpers-jellyfin-api.js';
import { toGuid } from '../src/jellyfin/ids.js';

const skip = !hasFfmpeg && 'ffmpeg not installed';
let nf;
let admin;
let secret;
let me;
let token;
const ids = {};

before(async () => {
  if (!hasFfmpeg) return;
  const media = tempDir();
  const m = path.join(media, 'Movies');
  const t = path.join(media, 'TV');
  makeVideo(path.join(m, 'Alpha (2001)', 'Alpha (2001).mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show - S01E01.mp4'));
  makeVideo(path.join(t, 'Show', 'Season 01', 'Show - S01E02.mp4'));
  nf = await startAtomix();
  admin = client(nf.base);
  await admin.post('/api/setup', { username: 'dallas', password: 'password123' });
  ids.films = (await admin.post('/api/libraries', { name: 'Movies', type: 'movies', paths: [m] })).data.id;
  ids.tv = (await admin.post('/api/libraries', { name: 'TV', type: 'tv', paths: [t] })).data.id;
  await waitForScan(admin);
  const db = nf.app.core.db;
  const one = (sql) => db.get(sql).id;
  ids.film = one("SELECT id FROM items WHERE kind = 'movie'");
  ids.show = one("SELECT id FROM items WHERE kind = 'show'");
  ids.season = one("SELECT id FROM items WHERE kind = 'season' AND season = 1");
  ids.episode = one("SELECT id FROM items WHERE kind = 'episode' AND season = 1 AND episode = 1");
  ids.profile = one('SELECT id FROM profiles WHERE kids = 0 ORDER BY id');
  db.run('UPDATE items SET genres = ? WHERE id = ?', JSON.stringify(['Drama', 'Comedy']), ids.film);
  db.run("UPDATE items SET min_age = 0 WHERE kind IN ('movie', 'show', 'season', 'episode')");
  secret = (await admin.post('/api/me/app-passwords', { name: 'Infuse' })).data.secret;
  token = (await signIn(nf.base, 'dallas', secret)).token;
  me = jf(nf.base, { token });
});

after(async () => {
  await nf?.app.stop();
});

const fill = (s) =>
  String(s)
    .replaceAll('{library:films}', toGuid('library', ids.films))
    .replaceAll('{library:tv}', toGuid('library', ids.tv))
    .replaceAll('{user}', toGuid('user', ids.profile))
    .replaceAll('{film}', toGuid('item', ids.film))
    .replaceAll('{show}', toGuid('item', ids.show))
    .replaceAll('{season}', toGuid('item', ids.season))
    .replaceAll('{episode}', toGuid('item', ids.episode));

test('every call in the recorded Infuse session answers', { skip }, async () => {
  const session = JSON.parse(fs.readFileSync(new URL('./fixtures/infuse-session.json', import.meta.url), 'utf8'));
  assert.match(session.source, /^(jellyfin-docs|infuse-.+)$/);
  assert.ok(session.calls.length >= 20);
  let tok = null;
  for (const c of session.calls) {
    const query = Object.fromEntries(Object.entries(c.query || {}).map(([k, v]) => [k, fill(v)]));
    const url = `${nf.base}/jellyfin${fill(c.path)}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`;
    const headers = { Authorization: authHeader({ token: tok, deviceId: 'infuse-replay' }), ...(c.headers || {}) };
    let body;
    if (c.signIn) {
      body = JSON.stringify({ Username: 'dallas', Pw: secret });
      headers['Content-Type'] = 'application/json';
    } else if (c.body !== undefined) {
      body = fill(JSON.stringify(c.body));
      headers['Content-Type'] = 'application/json';
    } else if (c.method === 'POST') {
      body = '{}';
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { method: c.method, headers, body });
    const what = `${c.method} ${c.path} -> ${res.status}`;
    if (c.expect) assert.equal(res.status, c.expect, what);
    else assert.ok(res.status >= 200 && res.status < 300, what);
    const text = c.binary ? null : await res.text();
    if (c.binary) await res.arrayBuffer();
    else if (res.status !== 204 && text) assert.doesNotThrow(() => JSON.parse(text), `${what} is JSON`);
    if (c.signIn) tok = JSON.parse(text).AccessToken;
  }
});

test('the stubs answer with the right shape', { skip }, async () => {
  const user = toGuid('user', ids.profile);
  const prefs = await me.get('/DisplayPreferences/home');
  assert.deepEqual(prefs.body, { Id: 'home', SortBy: 'SortName', SortOrder: 'Ascending', CustomPrefs: {} });
  assert.equal((await me.post('/DisplayPreferences/home', {})).status, 204);
  assert.equal((await me.get(`/Users/${user}/Configuration`)).body.PlayDefaultAudioTrack, true);
  assert.equal((await me.get(`/Users/${toGuid('user', 99999)}/Configuration`)).status, 404);
  assert.equal((await me.post('/Sessions/Capabilities', {})).status, 204);
  assert.equal((await me.post('/Sessions/Capabilities/Full', {})).status, 204);
  assert.deepEqual((await jf(nf.base).get('/Branding/Configuration')).body, { LoginDisclaimer: '', CustomCss: '' });
  for (const n of ['Cultures', 'Countries', 'ParentalRatings']) assert.deepEqual((await me.get(`/Localization/${n}`)).body, []);
  assert.deepEqual((await me.get(`/Users/${user}/Items/${toGuid('item', ids.film)}/Intros`)).body, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  assert.equal((await me.get(`/Items/${toGuid('item', ids.film)}/Similar`)).body.TotalRecordCount, 0);
  assert.deepEqual((await me.get(`/Items/${toGuid('item', ids.film)}/SpecialFeatures`)).body, []);
  assert.equal((await me.get(`/Items/${toGuid('item', 99999)}/Similar`)).status, 404);
  const qc = await jf(nf.base).get('/QuickConnect/Enabled');
  assert.equal(qc.status, 200);
  assert.equal(qc.body, false);
  const genres = await me.get('/Genres');
  assert.deepEqual(genres.body.Items.map((x) => x.Name), ['Comedy', 'Drama']);
  assert.match(genres.body.Items[0].Id, /^[0-9a-f]{32}$/);
  assert.equal((await me.get('/Genres', { ParentId: toGuid('library', ids.tv) })).body.Items.length, 0);
  assert.equal((await me.get('/Genres', { ParentId: toGuid('library', ids.films) })).body.Items.length, 2);
  assert.equal((await jf(nf.base).get('/Genres')).status, 401);
});

test('an unknown route is 404, not 500', { skip }, async () => {
  for (const [method, p] of [['GET', '/Nothing/Here'], ['GET', '/Packages'], ['POST', '/ScheduledTasks/Running/abc']]) {
    const r = await me.raw(p, { method, headers: { Authorization: authHeader({ token }) } });
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.equal(await r.text(), '{}');
  }
  assert.equal((await me.raw('/emby/Nothing/Here', { headers: { Authorization: authHeader({ token }) } })).status, 404);
});
